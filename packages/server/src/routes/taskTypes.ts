import type { FastifyInstance } from "fastify";
import type { CreateTaskTypeRequest, TaskType } from "@agentmq/shared";
import { query } from "../db.js";

export function registerTaskTypeRoutes(app: FastifyInstance): void {
  app.post<{ Body: CreateTaskTypeRequest }>("/api/task-types", async (request, reply) => {
    const body = request.body ?? ({} as CreateTaskTypeRequest);
    const type = typeof body.type === "string" ? body.type.trim() : "";
    if (!type) {
      return reply.code(400).send({ error: "type is required" });
    }

    const description = typeof body.description === "string" ? body.description : "";
    const inputSchema = body.input_schema ?? null;
    const requiredCapabilities = Array.isArray(body.required_capabilities)
      ? body.required_capabilities
      : [];
    const runtimeImage = typeof body.runtime_image === "string" ? body.runtime_image : null;
    const resourceLimits = body.resource_limits ?? null;

    try {
      const result = await query<TaskType>(
        `INSERT INTO task_types (type, description, input_schema, required_capabilities, runtime_image, resource_limits)
         VALUES ($1, $2, $3::jsonb, $4, $5, $6::jsonb)
         ON CONFLICT (type) DO UPDATE SET
           description = EXCLUDED.description,
           input_schema = EXCLUDED.input_schema,
           required_capabilities = EXCLUDED.required_capabilities,
           runtime_image = EXCLUDED.runtime_image,
           resource_limits = EXCLUDED.resource_limits
         RETURNING type, description, input_schema, required_capabilities, runtime_image, resource_limits, created_at`,
        [
          type,
          description,
          inputSchema ? JSON.stringify(inputSchema) : null,
          requiredCapabilities,
          runtimeImage,
          resourceLimits ? JSON.stringify(resourceLimits) : null,
        ]
      );

      const row = result.rows[0];
      if (!row) {
        return reply.code(500).send({ error: "Failed to create task type" });
      }
      return reply.code(201).send(row);
    } catch (err) {
      request.log.error(err, "create task type failed");
      return reply.code(500).send({ error: "Failed to create task type" });
    }
  });

  app.get("/api/task-types", async (request, reply) => {
    try {
      const result = await query<TaskType>(
        `SELECT type, description, input_schema, required_capabilities, runtime_image, resource_limits, created_at
         FROM task_types ORDER BY type ASC`
      );
      return reply.send(result.rows);
    } catch (err) {
      request.log.error(err, "list task types failed");
      return reply.code(500).send({ error: "Failed to list task types" });
    }
  });
}
