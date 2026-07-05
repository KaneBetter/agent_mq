// Agent-facing register/heartbeat + management-facing agent listing.
import crypto from "node:crypto";
import type { FastifyInstance } from "fastify";
import type {
  Agent,
  AgentSummary,
  HeartbeatResponse,
  RegisterAgentRequest,
  RegisterAgentResponse,
  TaskDetail,
} from "@agentmq/shared";
import { query } from "../db.js";
import { requireAgent } from "../auth.js";
import { emitEvent } from "../events.js";
import { mapTaskDetailRow, TASK_DETAIL_SELECT, type TaskDetailRow } from "../rowMappers.js";

interface AgentRow {
  id: string;
  name: string;
  owner: string;
  machine_info: Record<string, unknown>;
  capabilities: string[];
  max_concurrency: number;
  status: Agent["status"];
  last_heartbeat_at: string | null;
  created_at: string;
}

function mapAgentRow(row: AgentRow): Agent {
  return {
    id: row.id,
    name: row.name,
    owner: row.owner,
    machine_info: row.machine_info,
    capabilities: row.capabilities,
    max_concurrency: row.max_concurrency,
    status: row.status,
    last_heartbeat_at: row.last_heartbeat_at,
    created_at: row.created_at,
  };
}

export function registerAgentRoutes(app: FastifyInstance): void {
  app.post<{ Body: RegisterAgentRequest }>("/api/agents/register", async (request, reply) => {
    const body = request.body ?? ({} as RegisterAgentRequest);
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (!name) {
      return reply.code(400).send({ error: "name is required" });
    }

    const owner = typeof body.owner === "string" ? body.owner : "";
    const capabilities = Array.isArray(body.capabilities) ? body.capabilities : [];
    const machineInfo =
      body.machine_info && typeof body.machine_info === "object" ? body.machine_info : {};
    const maxConcurrency =
      typeof body.max_concurrency === "number" && body.max_concurrency >= 1
        ? Math.floor(body.max_concurrency)
        : 3;

    const apiToken = crypto.randomBytes(32).toString("hex");

    try {
      const result = await query<AgentRow>(
        `INSERT INTO agents (name, owner, machine_info, capabilities, api_token, max_concurrency, status, last_heartbeat_at)
         VALUES ($1, $2, $3::jsonb, $4, $5, $6, 'online', now())
         RETURNING id, name, owner, machine_info, capabilities, max_concurrency, status, last_heartbeat_at, created_at`,
        [name, owner, JSON.stringify(machineInfo), capabilities, apiToken, maxConcurrency]
      );

      const row = result.rows[0];
      if (!row) {
        return reply.code(500).send({ error: "Failed to register agent" });
      }

      const agent = mapAgentRow(row);

      emitEvent({
        type: "agent.registered",
        agent_id: agent.id,
        agent_name: agent.name,
        message: `Agent ${agent.name} registered`,
      });
      emitEvent({
        type: "agent.online",
        agent_id: agent.id,
        agent_name: agent.name,
      });

      const response: RegisterAgentResponse = {
        agent_id: agent.id,
        api_token: apiToken,
        agent,
      };
      return reply.code(201).send(response);
    } catch (err) {
      request.log.error(err, "agent registration failed");
      return reply.code(500).send({ error: "Failed to register agent" });
    }
  });

  app.post("/api/agents/heartbeat", async (request, reply) => {
    const agent = await requireAgent(request, reply);
    if (!agent) return;

    try {
      const wasOffline = agent.status === "offline";
      await query(
        `UPDATE agents SET status = 'online', last_heartbeat_at = now() WHERE id = $1`,
        [agent.id]
      );

      if (wasOffline) {
        emitEvent({ type: "agent.online", agent_id: agent.id, agent_name: agent.name });
      }

      const response: HeartbeatResponse = { ok: true, status: "online" };
      return reply.send(response);
    } catch (err) {
      request.log.error(err, "agent heartbeat failed");
      return reply.code(500).send({ error: "Failed to record heartbeat" });
    }
  });

  app.get("/api/agents", async (request, reply) => {
    try {
      const result = await query<AgentRow & Record<string, unknown>>(
        `SELECT
            a.id, a.name, a.owner, a.machine_info, a.capabilities, a.max_concurrency,
            a.status, a.last_heartbeat_at, a.created_at,
            COALESCE(inflight.count, 0)::int AS inflight,
            COALESCE(agg.completed_count, 0)::int AS completed_count,
            COALESCE(agg.failed_count, 0)::int AS failed_count,
            COALESCE(agg.total_tokens, 0)::int AS total_tokens,
            COALESCE(agg.total_wall_time_ms, 0)::int AS total_wall_time_ms,
            COALESCE(agg.total_cost_usd, 0)::float AS total_cost_usd
         FROM agents a
         LEFT JOIN LATERAL (
           SELECT count(*) AS count FROM tasks
           WHERE assigned_agent_id = a.id AND status IN ('CLAIMED','RUNNING')
         ) inflight ON true
         LEFT JOIN LATERAL (
           SELECT
             count(*) FILTER (WHERE t.status = 'COMPLETED') AS completed_count,
             count(*) FILTER (WHERE t.status IN ('FAILED','DEAD')) AS failed_count,
             COALESCE(sum(m.total_tokens), 0) AS total_tokens,
             COALESCE(sum(m.wall_time_ms), 0) AS total_wall_time_ms,
             COALESCE(sum(m.cost_usd), 0) AS total_cost_usd
           FROM tasks t
           LEFT JOIN metrics m ON m.task_id = t.id
           WHERE t.assigned_agent_id = a.id
         ) agg ON true
         ORDER BY a.created_at DESC`
      );

      const summaries: AgentSummary[] = result.rows.map((row) => {
        const completed = Number(row.completed_count ?? 0);
        const failed = Number(row.failed_count ?? 0);
        const finished = completed + failed;
        return {
          ...mapAgentRow(row),
          inflight: Number(row.inflight ?? 0),
          completed_count: completed,
          failed_count: failed,
          total_tokens: Number(row.total_tokens ?? 0),
          total_wall_time_ms: Number(row.total_wall_time_ms ?? 0),
          total_cost_usd: Number(row.total_cost_usd ?? 0),
          success_rate: finished > 0 ? completed / finished : null,
        };
      });

      return reply.send(summaries);
    } catch (err) {
      request.log.error(err, "list agents failed");
      return reply.code(500).send({ error: "Failed to list agents" });
    }
  });

  app.get<{ Params: { id: string } }>("/api/agents/:id", async (request, reply) => {
    const { id } = request.params;
    try {
      const agentResult = await query<AgentRow & Record<string, unknown>>(
        `SELECT
            a.id, a.name, a.owner, a.machine_info, a.capabilities, a.max_concurrency,
            a.status, a.last_heartbeat_at, a.created_at,
            COALESCE(inflight.count, 0)::int AS inflight,
            COALESCE(agg.completed_count, 0)::int AS completed_count,
            COALESCE(agg.failed_count, 0)::int AS failed_count,
            COALESCE(agg.total_tokens, 0)::int AS total_tokens,
            COALESCE(agg.total_wall_time_ms, 0)::int AS total_wall_time_ms,
            COALESCE(agg.total_cost_usd, 0)::float AS total_cost_usd
         FROM agents a
         LEFT JOIN LATERAL (
           SELECT count(*) AS count FROM tasks
           WHERE assigned_agent_id = a.id AND status IN ('CLAIMED','RUNNING')
         ) inflight ON true
         LEFT JOIN LATERAL (
           SELECT
             count(*) FILTER (WHERE t.status = 'COMPLETED') AS completed_count,
             count(*) FILTER (WHERE t.status IN ('FAILED','DEAD')) AS failed_count,
             COALESCE(sum(m.total_tokens), 0) AS total_tokens,
             COALESCE(sum(m.wall_time_ms), 0) AS total_wall_time_ms,
             COALESCE(sum(m.cost_usd), 0) AS total_cost_usd
           FROM tasks t
           LEFT JOIN metrics m ON m.task_id = t.id
           WHERE t.assigned_agent_id = a.id
         ) agg ON true
         WHERE a.id = $1`,
        [id]
      );

      const row = agentResult.rows[0];
      if (!row) {
        return reply.code(404).send({ error: "Agent not found" });
      }

      const completed = Number(row.completed_count ?? 0);
      const failed = Number(row.failed_count ?? 0);
      const finished = completed + failed;
      const agentSummary: AgentSummary = {
        ...mapAgentRow(row),
        inflight: Number(row.inflight ?? 0),
        completed_count: completed,
        failed_count: failed,
        total_tokens: Number(row.total_tokens ?? 0),
        total_wall_time_ms: Number(row.total_wall_time_ms ?? 0),
        total_cost_usd: Number(row.total_cost_usd ?? 0),
        success_rate: finished > 0 ? completed / finished : null,
      };

      const tasksResult = await query<TaskDetailRow>(
        `${TASK_DETAIL_SELECT} WHERE t.assigned_agent_id = $1 ORDER BY t.created_at DESC LIMIT 25`,
        [id]
      );
      const recentTasks: TaskDetail[] = tasksResult.rows.map(mapTaskDetailRow);

      return reply.send({ agent: agentSummary, recent_tasks: recentTasks });
    } catch (err) {
      request.log.error(err, "get agent failed");
      return reply.code(500).send({ error: "Failed to fetch agent" });
    }
  });
}
