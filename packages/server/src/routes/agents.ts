// Agent-facing register/heartbeat + management-facing agent listing + v5
// rest/pause endpoints (pause, rest-windows, subscription-pause).
import crypto from "node:crypto";
import type { FastifyInstance } from "fastify";
import type {
  Agent,
  AgentSummary,
  CreateRestWindowRequest,
  HeartbeatResponse,
  RegisterAgentRequest,
  RegisterAgentResponse,
  RestWindow,
  SetAgentPauseRequest,
  SetSubscriptionPauseRequest,
  TaskDetail,
} from "@agentmq/shared";
import { pool, query } from "../db.js";
import { requireAgent } from "../auth.js";
import { getUser } from "../userAuth.js";
import { canProduce, fetchSpace } from "../spaces.js";
import { emitEvent } from "../events.js";
import { computeAgentResting } from "../rest.js";
import { mapTaskDetailRow, TASK_DETAIL_SELECT, type TaskDetailRow } from "../rowMappers.js";
import {
  ensureProjectPollSchedule,
  ensureSiteUpdateSchedule,
  touchSiteUpdateSchedule,
} from "../agentSchedules.js";

interface AgentRow {
  id: string;
  name: string;
  owner: string;
  owner_user_id: string | null;
  space_id: string | null;
  space_name?: string | null;
  machine_info: Record<string, unknown>;
  capabilities: string[];
  max_concurrency: number;
  status: Agent["status"];
  paused: boolean;
  last_heartbeat_at: string | null;
  created_at: string;
}

function mapAgentRow(row: AgentRow): Agent {
  return {
    id: row.id,
    name: row.name,
    owner: row.owner,
    owner_user_id: row.owner_user_id ?? null,
    space_id: row.space_id ?? null,
    space_name: row.space_name ?? null,
    machine_info: row.machine_info,
    capabilities: row.capabilities,
    max_concurrency: row.max_concurrency,
    status: row.status,
    paused: row.paused ?? false,
    last_heartbeat_at: row.last_heartbeat_at,
    created_at: row.created_at,
  };
}

const AGENT_AGG_SELECT_COLUMNS = `
    a.id, a.name, a.owner, a.owner_user_id, a.space_id, sp.name AS space_name,
    a.machine_info, a.capabilities, a.max_concurrency,
    a.status, a.paused, a.last_heartbeat_at, a.created_at,
    COALESCE(inflight.count, 0)::int AS inflight,
    COALESCE(agg.completed_count, 0)::int AS completed_count,
    COALESCE(agg.failed_count, 0)::int AS failed_count,
    COALESCE(agg.total_tokens, 0)::int AS total_tokens,
    COALESCE(agg.total_wall_time_ms, 0)::int AS total_wall_time_ms,
    COALESCE(agg.total_cost_usd, 0)::float AS total_cost_usd`;

const AGENT_AGG_JOINS = `
   LEFT JOIN spaces sp ON sp.id = a.space_id
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
   ) agg ON true`;

async function buildAgentSummary(
  row: AgentRow & Record<string, unknown>
): Promise<AgentSummary> {
  const completed = Number(row.completed_count ?? 0);
  const failed = Number(row.failed_count ?? 0);
  const finished = completed + failed;
  const resting = await computeAgentResting(row.id, row.paused ?? false);
  return {
    ...mapAgentRow(row),
    inflight: Number(row.inflight ?? 0),
    completed_count: completed,
    failed_count: failed,
    total_tokens: Number(row.total_tokens ?? 0),
    total_wall_time_ms: Number(row.total_wall_time_ms ?? 0),
    total_cost_usd: Number(row.total_cost_usd ?? 0),
    success_rate: finished > 0 ? completed / finished : null,
    resting,
  };
}

export function registerAgentRoutes(app: FastifyInstance): void {
  app.post<{ Body: RegisterAgentRequest }>("/api/agents/register", async (request, reply) => {
    // v6: registering a consumer now requires an authenticated caller (session
    // cookie OR ADMIN_TOKEN bearer) and binds the consumer to exactly one space.
    const caller = await getUser(request);
    if (!caller) {
      return reply.code(401).send({ error: "Authentication required" });
    }

    const body = request.body ?? ({} as RegisterAgentRequest);
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (!name) {
      return reply.code(400).send({ error: "name is required" });
    }

    const spaceId = typeof body.space_id === "string" ? body.space_id.trim() : "";
    if (!spaceId) {
      return reply.code(400).send({ error: "space_id is required" });
    }

    const space = await fetchSpace(spaceId);
    if (!space) {
      return reply.code(400).send({ error: "space_id does not refer to an existing space" });
    }
    if (!(await canProduce(space, caller))) {
      return reply.code(403).send({ error: "Not authorized to register a consumer in this space" });
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
    const projectId = typeof body.project_id === "string" ? body.project_id : "";
    const groupName =
      typeof body.group_name === "string" && body.group_name.trim().length > 0
        ? body.group_name.trim()
        : "default";

    // ADMIN_TOKEN registers on behalf of no one (owner_user_id stays null);
    // a real session owns the new consumer.
    const ownerUserId = caller.isAdmin ? null : caller.id;

    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      // If a project_id was given, it must be a topic that belongs to this space.
      if (projectId) {
        const projectResult = await client.query<{ id: string; space_id: string | null }>(
          `SELECT id, space_id FROM projects WHERE id = $1`,
          [projectId]
        );
        const project = projectResult.rows[0];
        if (!project) {
          await client.query("ROLLBACK");
          return reply.code(400).send({ error: "Project not found" });
        }
        if (project.space_id !== spaceId) {
          await client.query("ROLLBACK");
          return reply.code(400).send({ error: "project_id is not a topic in this space" });
        }
      }

      const result = await client.query<AgentRow>(
        `INSERT INTO agents (name, owner, owner_user_id, space_id, machine_info, capabilities, api_token, max_concurrency, status, last_heartbeat_at)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, 'online', now())
         RETURNING id, name, owner, owner_user_id, space_id, machine_info, capabilities, max_concurrency, status, paused, last_heartbeat_at, created_at`,
        [
          name,
          owner,
          ownerUserId,
          spaceId,
          JSON.stringify(machineInfo),
          capabilities,
          apiToken,
          maxConcurrency,
        ]
      );

      const row = result.rows[0];
      if (!row) {
        await client.query("ROLLBACK");
        return reply.code(500).send({ error: "Failed to register agent" });
      }

      const agent = mapAgentRow({ ...row, space_name: space.name });

      // Always register the agent's global site-update poll schedule.
      await ensureSiteUpdateSchedule(client, agent.id);

      // Optional register-in-project: upsert the group for this project, then subscribe.
      if (projectId) {
        const groupResult = await client.query<{ id: string }>(
          `INSERT INTO groups (name, project_id) VALUES ($1, $2)
           ON CONFLICT (project_id, name) DO UPDATE SET name = EXCLUDED.name
           RETURNING id`,
          [groupName, projectId]
        );
        const groupId = groupResult.rows[0]?.id;
        if (!groupId) {
          await client.query("ROLLBACK");
          return reply.code(500).send({ error: "Failed to resolve group" });
        }

        await client.query(
          `INSERT INTO subscriptions (agent_id, project_id, group_id)
           VALUES ($1, $2, $3)
           ON CONFLICT (agent_id, project_id, group_id) DO NOTHING`,
          [agent.id, projectId, groupId]
        );

        await ensureProjectPollSchedule(client, agent.id, projectId);
      }

      await client.query("COMMIT");

      emitEvent({
        type: "agent.registered",
        agent_id: agent.id,
        agent_name: agent.name,
        project_id: projectId || undefined,
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
      await client.query("ROLLBACK");
      request.log.error(err, "agent registration failed");
      return reply.code(500).send({ error: "Failed to register agent" });
    } finally {
      client.release();
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
      await touchSiteUpdateSchedule(agent.id);

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
        `SELECT ${AGENT_AGG_SELECT_COLUMNS}
         FROM agents a
         ${AGENT_AGG_JOINS}
         ORDER BY a.created_at DESC`
      );

      const summaries: AgentSummary[] = [];
      for (const row of result.rows) {
        summaries.push(await buildAgentSummary(row));
      }

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
        `SELECT ${AGENT_AGG_SELECT_COLUMNS}
         FROM agents a
         ${AGENT_AGG_JOINS}
         WHERE a.id = $1`,
        [id]
      );

      const row = agentResult.rows[0];
      if (!row) {
        return reply.code(404).send({ error: "Agent not found" });
      }

      const agentSummary = await buildAgentSummary(row);

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

  // ── v5: rest / pause ─────────────────────────────────────────────────────
  app.post<{ Params: { id: string }; Body: SetAgentPauseRequest }>(
    "/api/agents/:id/pause",
    async (request, reply) => {
      const { id } = request.params;
      const paused = Boolean(request.body?.paused);
      try {
        const result = await query<{ id: string }>(
          `UPDATE agents SET paused = $1 WHERE id = $2 RETURNING id`,
          [paused, id]
        );
        if (!result.rows[0]) {
          return reply.code(404).send({ error: "Agent not found" });
        }
        return reply.send({ ok: true, paused });
      } catch (err) {
        request.log.error(err, "set agent pause failed");
        return reply.code(500).send({ error: "Failed to update pause state" });
      }
    }
  );

  app.get<{ Params: { id: string } }>("/api/agents/:id/rest-windows", async (request, reply) => {
    try {
      const result = await query<{
        id: string;
        agent_id: string;
        project_id: string | null;
        project_name: string | null;
        days_of_week: number[];
        start_time: string;
        end_time: string;
        timezone: string;
        created_at: string;
      }>(
        `SELECT w.id, w.agent_id, w.project_id, p.name AS project_name,
                w.days_of_week, w.start_time, w.end_time, w.timezone, w.created_at
         FROM agent_rest_windows w
         LEFT JOIN projects p ON p.id = w.project_id
         WHERE w.agent_id = $1
         ORDER BY w.created_at ASC`,
        [request.params.id]
      );
      const windows: RestWindow[] = result.rows.map((row) => ({
        id: row.id,
        agent_id: row.agent_id,
        project_id: row.project_id,
        project_name: row.project_name,
        days_of_week: row.days_of_week,
        start_time: row.start_time,
        end_time: row.end_time,
        timezone: row.timezone,
        created_at: row.created_at,
      }));
      return reply.send(windows);
    } catch (err) {
      request.log.error(err, "list rest windows failed");
      return reply.code(500).send({ error: "Failed to list rest windows" });
    }
  });

  app.post<{ Params: { id: string }; Body: CreateRestWindowRequest }>(
    "/api/agents/:id/rest-windows",
    async (request, reply) => {
      const { id } = request.params;
      const body = request.body ?? ({} as CreateRestWindowRequest);

      const daysOfWeek = Array.isArray(body.days_of_week)
        ? body.days_of_week.filter((d) => typeof d === "number" && d >= 0 && d <= 6)
        : [];
      if (daysOfWeek.length === 0) {
        return reply.code(400).send({ error: "days_of_week is required" });
      }
      const timeRe = /^\d{1,2}:\d{2}$/;
      if (typeof body.start_time !== "string" || !timeRe.test(body.start_time)) {
        return reply.code(400).send({ error: "start_time must be HH:MM" });
      }
      if (typeof body.end_time !== "string" || !timeRe.test(body.end_time)) {
        return reply.code(400).send({ error: "end_time must be HH:MM" });
      }
      const timezone = typeof body.timezone === "string" && body.timezone ? body.timezone : "UTC";
      const projectId = typeof body.project_id === "string" ? body.project_id : null;

      try {
        const agentExists = await query<{ id: string }>(`SELECT id FROM agents WHERE id = $1`, [
          id,
        ]);
        if (!agentExists.rows[0]) {
          return reply.code(404).send({ error: "Agent not found" });
        }

        const result = await query<{
          id: string;
          agent_id: string;
          project_id: string | null;
          days_of_week: number[];
          start_time: string;
          end_time: string;
          timezone: string;
          created_at: string;
        }>(
          `INSERT INTO agent_rest_windows (agent_id, project_id, days_of_week, start_time, end_time, timezone)
           VALUES ($1, $2, $3, $4, $5, $6)
           RETURNING id, agent_id, project_id, days_of_week, start_time, end_time, timezone, created_at`,
          [id, projectId, daysOfWeek, body.start_time, body.end_time, timezone]
        );
        const row = result.rows[0];
        if (!row) {
          return reply.code(500).send({ error: "Failed to create rest window" });
        }

        let projectName: string | null = null;
        if (row.project_id) {
          const projectResult = await query<{ name: string }>(
            `SELECT name FROM projects WHERE id = $1`,
            [row.project_id]
          );
          projectName = projectResult.rows[0]?.name ?? null;
        }

        const window: RestWindow = {
          id: row.id,
          agent_id: row.agent_id,
          project_id: row.project_id,
          project_name: projectName,
          days_of_week: row.days_of_week,
          start_time: row.start_time,
          end_time: row.end_time,
          timezone: row.timezone,
          created_at: row.created_at,
        };
        return reply.code(201).send(window);
      } catch (err) {
        request.log.error(err, "create rest window failed");
        return reply.code(500).send({ error: "Failed to create rest window" });
      }
    }
  );

  app.delete<{ Params: { id: string; windowId: string } }>(
    "/api/agents/:id/rest-windows/:windowId",
    async (request, reply) => {
      try {
        const result = await query<{ id: string }>(
          `DELETE FROM agent_rest_windows WHERE id = $1 AND agent_id = $2 RETURNING id`,
          [request.params.windowId, request.params.id]
        );
        if (!result.rows[0]) {
          return reply.code(404).send({ error: "Rest window not found" });
        }
        return reply.send({ ok: true });
      } catch (err) {
        request.log.error(err, "delete rest window failed");
        return reply.code(500).send({ error: "Failed to delete rest window" });
      }
    }
  );

  app.post<{ Params: { id: string }; Body: SetSubscriptionPauseRequest }>(
    "/api/agents/:id/subscription-pause",
    async (request, reply) => {
      const { id } = request.params;
      const body = request.body ?? ({} as SetSubscriptionPauseRequest);
      const projectId = typeof body.project_id === "string" ? body.project_id : "";
      if (!projectId) {
        return reply.code(400).send({ error: "project_id is required" });
      }
      const paused = Boolean(body.paused);

      try {
        const result = await query<{ id: string }>(
          `UPDATE subscriptions SET paused = $1
           WHERE agent_id = $2 AND project_id = $3
           RETURNING id`,
          [paused, id, projectId]
        );
        if (!result.rows[0]) {
          return reply.code(404).send({ error: "Subscription not found" });
        }
        return reply.send({ ok: true, paused });
      } catch (err) {
        request.log.error(err, "set subscription pause failed");
        return reply.code(500).send({ error: "Failed to update subscription pause state" });
      }
    }
  );
}
