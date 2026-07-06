// GET /api/activity: durable read of the persisted `activity` table.
import type { FastifyInstance } from "fastify";
import type { ActivityRecord, EventType, TaskStatus } from "@agentmq/shared";
import { query } from "../db.js";

interface ActivityRow {
  id: string;
  type: EventType;
  ts: string;
  task_id: string | null;
  task_type: string | null;
  project_id: string | null;
  project_name: string | null;
  agent_id: string | null;
  agent_name: string | null;
  status: TaskStatus | null;
  message: string | null;
  task_tags: string[] | null;
  project_tags: string[] | null;
}

function mapActivityRow(row: ActivityRow): ActivityRecord {
  return {
    id: row.id,
    type: row.type,
    ts: row.ts,
    task_id: row.task_id ?? undefined,
    task_type: row.task_type ?? undefined,
    project_id: row.project_id ?? undefined,
    project_name: row.project_name ?? undefined,
    agent_id: row.agent_id ?? undefined,
    agent_name: row.agent_name ?? undefined,
    status: row.status ?? undefined,
    message: row.message ?? undefined,
    task_tags: row.task_tags ?? undefined,
    project_tags: row.project_tags ?? undefined,
  };
}

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;

export function registerActivityRoutes(app: FastifyInstance): void {
  app.get<{
    Querystring: { project_id?: string; type?: string; limit?: string };
  }>("/api/activity", async (request, reply) => {
    const { project_id: projectId, type } = request.query;
    const limit = Math.min(Math.max(Number(request.query.limit) || DEFAULT_LIMIT, 1), MAX_LIMIT);

    const conditions: string[] = [];
    const params: unknown[] = [];

    if (projectId) {
      params.push(projectId);
      conditions.push(`a.project_id = $${params.length}`);
    }
    if (type) {
      params.push(type);
      conditions.push(`a.type = $${params.length}`);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    params.push(limit);

    try {
      const result = await query<ActivityRow>(
        `SELECT
            a.id, a.type, a.ts, a.task_id, a.task_type, a.project_id,
            p.name AS project_name,
            a.agent_id,
            ag.name AS agent_name,
            a.status, a.message,
            t.tags AS task_tags,
            p.tags AS project_tags
         FROM activity a
         LEFT JOIN projects p ON p.id = a.project_id
         LEFT JOIN agents ag ON ag.id = a.agent_id
         LEFT JOIN tasks t ON t.id = a.task_id
         ${whereClause}
         ORDER BY a.ts DESC
         LIMIT $${params.length}`,
        params
      );
      return reply.send(result.rows.map(mapActivityRow));
    } catch (err) {
      request.log.error(err, "list activity failed");
      return reply.code(500).send({ error: "Failed to list activity" });
    }
  });
}
