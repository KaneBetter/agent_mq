import type { FastifyInstance } from "fastify";
import type { CreateGroupRequest, Group } from "@agentmq/shared";
import { query } from "../db.js";

export function registerGroupRoutes(app: FastifyInstance): void {
  app.post<{ Body: CreateGroupRequest }>("/api/groups", async (request, reply) => {
    const body = request.body ?? ({} as CreateGroupRequest);
    const name = typeof body.name === "string" ? body.name.trim() : "";
    const projectId = typeof body.project_id === "string" ? body.project_id : "";

    if (!name || !projectId) {
      return reply.code(400).send({ error: "name and project_id are required" });
    }

    try {
      const projectResult = await query<{ id: string }>(
        `SELECT id FROM projects WHERE id = $1`,
        [projectId]
      );
      if (!projectResult.rows[0]) {
        return reply.code(404).send({ error: "Project not found" });
      }

      const result = await query<Group>(
        `INSERT INTO groups (name, project_id) VALUES ($1, $2)
         ON CONFLICT (project_id, name) DO UPDATE SET name = EXCLUDED.name
         RETURNING id, name, project_id, created_at`,
        [name, projectId]
      );

      const group = result.rows[0];
      if (!group) {
        return reply.code(500).send({ error: "Failed to create group" });
      }
      return reply.code(201).send(group);
    } catch (err) {
      request.log.error(err, "create group failed");
      return reply.code(500).send({ error: "Failed to create group" });
    }
  });
}
