// Recurring project-task generators: GET/POST /api/schedules, PATCH/DELETE /api/schedules/:id.
import type { FastifyInstance } from "fastify";
import type { CreateScheduleRequest, Recurrence, UpdateScheduleRequest } from "@agentmq/shared";
import { pool, query } from "../db.js";
import { mapScheduleRow, type ScheduleRow } from "../rowMappers.js";
import { nextRun } from "../scheduling.js";

function isValidRecurrence(value: unknown): value is Recurrence {
  if (!value || typeof value !== "object") return false;
  const r = value as Record<string, unknown>;
  if (r.kind === "interval") {
    return typeof r.interval_seconds === "number" && r.interval_seconds > 0;
  }
  if (r.kind === "weekly") {
    const days = r.days_of_week;
    const times = r.times;
    return (
      Array.isArray(days) &&
      days.length > 0 &&
      days.every((d) => typeof d === "number" && d >= 0 && d <= 6) &&
      Array.isArray(times) &&
      times.length > 0 &&
      times.every((t) => typeof t === "string" && /^\d{1,2}:\d{2}$/.test(t))
    );
  }
  return false;
}

export function registerScheduleRoutes(app: FastifyInstance): void {
  app.get<{ Querystring: { project_id?: string } }>("/api/schedules", async (request, reply) => {
    const { project_id: projectId } = request.query;
    try {
      const result = await query<ScheduleRow>(
        projectId
          ? `SELECT * FROM schedules WHERE project_id = $1 ORDER BY created_at ASC`
          : `SELECT * FROM schedules ORDER BY created_at ASC`,
        projectId ? [projectId] : []
      );
      return reply.send(result.rows.map(mapScheduleRow));
    } catch (err) {
      request.log.error(err, "list schedules failed");
      return reply.code(500).send({ error: "Failed to list schedules" });
    }
  });

  app.post<{ Body: CreateScheduleRequest }>("/api/schedules", async (request, reply) => {
    const body = request.body ?? ({} as CreateScheduleRequest);
    const projectId = typeof body.project_id === "string" ? body.project_id : "";
    const name = typeof body.name === "string" ? body.name.trim() : "";
    const type = typeof body.type === "string" ? body.type.trim() : "";

    if (!projectId || !name || !type) {
      return reply.code(400).send({ error: "project_id, name, and type are required" });
    }
    if (!isValidRecurrence(body.recurrence)) {
      return reply.code(400).send({ error: "Invalid recurrence" });
    }

    const payloadTemplate = body.payload_template ?? {};
    const tags = Array.isArray(body.tags) ? body.tags.filter((t) => typeof t === "string") : [];
    const requiredCapabilities = Array.isArray(body.required_capabilities)
      ? body.required_capabilities
      : [];
    const targetGroupId = body.target_group_id ?? null;
    const shiftHours =
      typeof body.shift_hours === "number" && body.shift_hours > 0 ? body.shift_hours : null;
    const enabled = body.enabled !== false;

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

      const nextRunAt = nextRun(body.recurrence, new Date());

      const result = await client.query<ScheduleRow>(
        `INSERT INTO schedules
           (project_id, name, type, payload_template, tags, required_capabilities,
            target_group_id, recurrence, shift_hours, enabled, next_run_at)
         VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $8::jsonb, $9, $10, $11)
         RETURNING *`,
        [
          projectId,
          name,
          type,
          JSON.stringify(payloadTemplate),
          tags,
          requiredCapabilities,
          targetGroupId,
          JSON.stringify(body.recurrence),
          shiftHours,
          enabled,
          nextRunAt.toISOString(),
        ]
      );

      const row = result.rows[0];
      if (!row) {
        await client.query("ROLLBACK");
        return reply.code(500).send({ error: "Failed to create schedule" });
      }

      await client.query("COMMIT");
      return reply.code(201).send(mapScheduleRow(row));
    } catch (err) {
      await client.query("ROLLBACK");
      request.log.error(err, "create schedule failed");
      return reply.code(500).send({ error: "Failed to create schedule" });
    } finally {
      client.release();
    }
  });

  app.patch<{ Params: { id: string }; Body: UpdateScheduleRequest }>(
    "/api/schedules/:id",
    async (request, reply) => {
      const { id } = request.params;
      const body = request.body ?? ({} as UpdateScheduleRequest);

      if (body.recurrence !== undefined && !isValidRecurrence(body.recurrence)) {
        return reply.code(400).send({ error: "Invalid recurrence" });
      }

      const client = await pool.connect();
      try {
        await client.query("BEGIN");

        const existingResult = await client.query<ScheduleRow>(
          `SELECT * FROM schedules WHERE id = $1 FOR UPDATE`,
          [id]
        );
        const existing = existingResult.rows[0];
        if (!existing) {
          await client.query("ROLLBACK");
          return reply.code(404).send({ error: "Schedule not found" });
        }

        const enabled = body.enabled ?? existing.enabled;
        const recurrence = body.recurrence ?? existing.recurrence;
        const payloadTemplate = body.payload_template ?? existing.payload_template;
        const tags = Array.isArray(body.tags)
          ? body.tags.filter((t) => typeof t === "string")
          : (existing.tags ?? []);

        const recurrenceChanged = body.recurrence !== undefined;
        const nextRunAt = recurrenceChanged
          ? nextRun(recurrence, new Date())
          : new Date(existing.next_run_at);

        const result = await client.query<ScheduleRow>(
          `UPDATE schedules SET
              enabled          = $2,
              recurrence       = $3::jsonb,
              payload_template = $4::jsonb,
              tags             = $5,
              next_run_at      = $6
           WHERE id = $1
           RETURNING *`,
          [
            id,
            enabled,
            JSON.stringify(recurrence),
            JSON.stringify(payloadTemplate),
            tags,
            nextRunAt.toISOString(),
          ]
        );

        const row = result.rows[0];
        if (!row) {
          await client.query("ROLLBACK");
          return reply.code(500).send({ error: "Failed to update schedule" });
        }

        await client.query("COMMIT");
        return reply.send(mapScheduleRow(row));
      } catch (err) {
        await client.query("ROLLBACK");
        request.log.error(err, "update schedule failed");
        return reply.code(500).send({ error: "Failed to update schedule" });
      } finally {
        client.release();
      }
    }
  );

  app.delete<{ Params: { id: string } }>("/api/schedules/:id", async (request, reply) => {
    try {
      const result = await query<{ id: string }>(
        `DELETE FROM schedules WHERE id = $1 RETURNING id`,
        [request.params.id]
      );
      if (!result.rows[0]) {
        return reply.code(404).send({ error: "Schedule not found" });
      }
      return reply.code(204).send();
    } catch (err) {
      request.log.error(err, "delete schedule failed");
      return reply.code(500).send({ error: "Failed to delete schedule" });
    }
  });
}
