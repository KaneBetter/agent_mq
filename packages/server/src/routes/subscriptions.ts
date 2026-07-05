import type { FastifyInstance } from "fastify";
import type { Subscription, SubscribeRequest } from "@agentmq/shared";
import { pool } from "../db.js";
import { requireAgent } from "../auth.js";

interface GroupRow {
  id: string;
}

export function registerSubscriptionRoutes(app: FastifyInstance): void {
  app.post<{ Body: SubscribeRequest }>("/api/subscriptions", async (request, reply) => {
    const agent = await requireAgent(request, reply);
    if (!agent) return;

    const body = request.body ?? ({} as SubscribeRequest);
    const projectId = typeof body.project_id === "string" ? body.project_id : "";
    if (!projectId) {
      return reply.code(400).send({ error: "project_id is required" });
    }

    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      const projectResult = await client.query<{ id: string }>(
        `SELECT id FROM projects WHERE id = $1`,
        [projectId]
      );
      if (!projectResult.rows[0]) {
        await client.query("ROLLBACK");
        return reply.code(404).send({ error: "Project not found" });
      }

      let groupId = typeof body.group_id === "string" ? body.group_id : null;

      if (groupId) {
        const groupResult = await client.query<GroupRow>(
          `SELECT id FROM groups WHERE id = $1 AND project_id = $2`,
          [groupId, projectId]
        );
        if (!groupResult.rows[0]) {
          await client.query("ROLLBACK");
          return reply.code(404).send({ error: "Group not found for this project" });
        }
      } else {
        const groupName =
          typeof body.group_name === "string" && body.group_name.trim().length > 0
            ? body.group_name.trim()
            : "default";

        const upsert = await client.query<GroupRow>(
          `INSERT INTO groups (name, project_id) VALUES ($1, $2)
           ON CONFLICT (project_id, name) DO UPDATE SET name = EXCLUDED.name
           RETURNING id`,
          [groupName, projectId]
        );
        groupId = upsert.rows[0]?.id ?? null;
      }

      if (!groupId) {
        await client.query("ROLLBACK");
        return reply.code(500).send({ error: "Failed to resolve group" });
      }

      const subResult = await client.query<Subscription>(
        `INSERT INTO subscriptions (agent_id, project_id, group_id)
         VALUES ($1, $2, $3)
         ON CONFLICT (agent_id, project_id, group_id) DO UPDATE SET agent_id = EXCLUDED.agent_id
         RETURNING id, agent_id, project_id, group_id, created_at`,
        [agent.id, projectId, groupId]
      );

      await client.query("COMMIT");

      const subscription = subResult.rows[0];
      if (!subscription) {
        return reply.code(500).send({ error: "Failed to create subscription" });
      }
      return reply.code(201).send(subscription);
    } catch (err) {
      await client.query("ROLLBACK");
      request.log.error(err, "subscribe failed");
      return reply.code(500).send({ error: "Failed to create subscription" });
    } finally {
      client.release();
    }
  });
}
