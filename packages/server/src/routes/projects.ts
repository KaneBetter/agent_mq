import type { FastifyInstance } from "fastify";
import type { CreateProjectRequest, Group, Project, ProjectSummary } from "@agentmq/shared";
import { pool, query } from "../db.js";

interface ProjectRow {
  id: string;
  name: string;
  description: string;
  task_schema: Record<string, unknown> | null;
  created_at: string;
}

function mapProjectRow(row: ProjectRow): Project {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    task_schema: row.task_schema,
    created_at: row.created_at,
  };
}

export function registerProjectRoutes(app: FastifyInstance): void {
  app.post<{ Body: CreateProjectRequest }>("/api/projects", async (request, reply) => {
    const body = request.body ?? ({} as CreateProjectRequest);
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (!name) {
      return reply.code(400).send({ error: "name is required" });
    }
    const description = typeof body.description === "string" ? body.description : "";
    const taskSchema = body.task_schema ?? null;
    const defaultGroup =
      typeof body.default_group === "string" && body.default_group.trim().length > 0
        ? body.default_group.trim()
        : "default";

    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      const projectResult = await client.query<ProjectRow>(
        `INSERT INTO projects (name, description, task_schema)
         VALUES ($1, $2, $3::jsonb)
         RETURNING id, name, description, task_schema, created_at`,
        [name, description, taskSchema ? JSON.stringify(taskSchema) : null]
      );

      const row = projectResult.rows[0];
      if (!row) {
        await client.query("ROLLBACK");
        return reply.code(500).send({ error: "Failed to create project" });
      }

      await client.query(
        `INSERT INTO groups (name, project_id) VALUES ($1, $2)
         ON CONFLICT (project_id, name) DO NOTHING`,
        [defaultGroup, row.id]
      );

      await client.query("COMMIT");
      return reply.code(201).send(mapProjectRow(row));
    } catch (err) {
      await client.query("ROLLBACK");
      if (err instanceof Error && "code" in err && (err as { code?: string }).code === "23505") {
        return reply.code(409).send({ error: "Project name already exists" });
      }
      request.log.error(err, "create project failed");
      return reply.code(500).send({ error: "Failed to create project" });
    } finally {
      client.release();
    }
  });

  app.get("/api/projects", async (request, reply) => {
    try {
      const projectsResult = await query<ProjectRow>(
        `SELECT id, name, description, task_schema, created_at FROM projects ORDER BY created_at ASC`
      );

      const summaries: ProjectSummary[] = [];
      for (const row of projectsResult.rows) {
        const countsResult = await query<{
          pending: string;
          running: string;
          completed: string;
          dead: string;
        }>(
          `SELECT
              count(*) FILTER (WHERE status = 'PENDING') AS pending,
              count(*) FILTER (WHERE status IN ('CLAIMED','RUNNING')) AS running,
              count(*) FILTER (WHERE status = 'COMPLETED') AS completed,
              count(*) FILTER (WHERE status = 'DEAD') AS dead
           FROM tasks WHERE project_id = $1`,
          [row.id]
        );
        const counts = countsResult.rows[0];

        const eligibleResult = await query<{ count: string }>(
          `SELECT count(DISTINCT s.agent_id) AS count
           FROM subscriptions s
           JOIN agents a ON a.id = s.agent_id
           WHERE s.project_id = $1
             AND EXISTS (
               SELECT 1 FROM tasks t
               WHERE t.project_id = s.project_id
                 AND t.status = 'PENDING'
                 AND t.required_capabilities <@ a.capabilities
             )`,
          [row.id]
        );

        const groupsResult = await query<Group>(
          `SELECT id, name, project_id, created_at FROM groups WHERE project_id = $1 ORDER BY created_at ASC`,
          [row.id]
        );

        summaries.push({
          ...mapProjectRow(row),
          pending: Number(counts?.pending ?? 0),
          running: Number(counts?.running ?? 0),
          completed: Number(counts?.completed ?? 0),
          dead: Number(counts?.dead ?? 0),
          eligible_agents: Number(eligibleResult.rows[0]?.count ?? 0),
          groups: groupsResult.rows,
        });
      }

      return reply.send(summaries);
    } catch (err) {
      request.log.error(err, "list projects failed");
      return reply.code(500).send({ error: "Failed to list projects" });
    }
  });
}
