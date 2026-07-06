// Management/UI-facing task routes: publish, list, get, requeue, cancel.
import type { FastifyInstance } from "fastify";
import type { PublishTaskRequest, Task, TaskStatus } from "@agentmq/shared";
import { TASK_STATUSES } from "@agentmq/shared";
import { pool, query } from "../db.js";
import { env } from "../env.js";
import { emitEvent } from "../events.js";
import {
  mapTaskDetailRow,
  mapTaskRow,
  TASK_DETAIL_SELECT,
  type TaskDetailRow,
  type TaskRow,
} from "../rowMappers.js";

interface TaskTypeRow {
  required_capabilities: string[];
}

export function registerTaskRoutes(app: FastifyInstance): void {
  app.post<{ Body: PublishTaskRequest }>("/api/tasks", async (request, reply) => {
    const body = request.body ?? ({} as PublishTaskRequest);
    const projectId = typeof body.project_id === "string" ? body.project_id : "";
    const type = typeof body.type === "string" ? body.type.trim() : "";

    if (!projectId || !type) {
      return reply.code(400).send({ error: "project_id and type are required" });
    }

    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      const projectResult = await client.query<{ id: string; name: string }>(
        `SELECT id, name FROM projects WHERE id = $1`,
        [projectId]
      );
      if (!projectResult.rows[0]) {
        await client.query("ROLLBACK");
        return reply.code(404).send({ error: "Project not found" });
      }
      const projectName = projectResult.rows[0].name;

      // Dedup: return the existing task if dedup_key already exists.
      if (body.dedup_key) {
        const existing = await client.query<TaskRow>(
          `SELECT * FROM tasks WHERE dedup_key = $1`,
          [body.dedup_key]
        );
        if (existing.rows[0]) {
          await client.query("COMMIT");
          return reply.code(200).send(mapTaskRow(existing.rows[0]));
        }
      }

      let requiredCapabilities = Array.isArray(body.required_capabilities)
        ? body.required_capabilities
        : null;

      if (!requiredCapabilities) {
        const taskTypeResult = await client.query<TaskTypeRow>(
          `SELECT required_capabilities FROM task_types WHERE type = $1`,
          [type]
        );
        requiredCapabilities = taskTypeResult.rows[0]?.required_capabilities ?? [];
      }

      const payload = body.payload ?? {};
      const priority = typeof body.priority === "number" ? body.priority : 0;
      const targetGroupId = body.target_group_id ?? null;
      const maxRetries =
        typeof body.max_retries === "number" ? body.max_retries : env.DEFAULT_MAX_RETRIES;
      const tags = Array.isArray(body.tags) ? body.tags.filter((t) => typeof t === "string") : [];

      // scheduled_for: only honored when it parses to a valid, FUTURE timestamp.
      // Past/absent/invalid => immediate publish (scheduled_for stays null).
      let scheduledFor: string | null = null;
      if (typeof body.scheduled_for === "string" && body.scheduled_for.trim().length > 0) {
        const parsed = new Date(body.scheduled_for);
        if (!Number.isNaN(parsed.getTime()) && parsed.getTime() > Date.now()) {
          scheduledFor = parsed.toISOString();
        }
      }
      const isScheduled = scheduledFor !== null;

      const result = await client.query<TaskRow>(
        `INSERT INTO tasks
           (project_id, type, tags, payload, priority, required_capabilities, target_group_id,
            max_retries, dedup_key, scheduled_for, visible_after)
         VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $8, $9, $10, $10)
         RETURNING *`,
        [
          projectId,
          type,
          tags,
          JSON.stringify(payload),
          priority,
          requiredCapabilities,
          targetGroupId,
          maxRetries,
          body.dedup_key ?? null,
          scheduledFor,
        ]
      );

      const row = result.rows[0];
      if (!row) {
        await client.query("ROLLBACK");
        return reply.code(500).send({ error: "Failed to publish task" });
      }

      await client.query("COMMIT");

      const task = mapTaskRow(row);
      emitEvent({
        type: isScheduled ? "task.scheduled" : "task.published",
        task_id: task.id,
        task_type: task.type,
        project_id: task.project_id,
        project_name: projectName,
        status: task.status,
        message: isScheduled ? `Scheduled for ${task.scheduled_for}` : undefined,
      });

      return reply.code(201).send(task);
    } catch (err) {
      await client.query("ROLLBACK");
      if (err instanceof Error && "code" in err && (err as { code?: string }).code === "23505") {
        return reply.code(409).send({ error: "dedup_key already exists" });
      }
      request.log.error(err, "publish task failed");
      return reply.code(500).send({ error: "Failed to publish task" });
    } finally {
      client.release();
    }
  });

  app.get<{
    Querystring: {
      status?: string;
      project_id?: string;
      type?: string;
      tag?: string;
      limit?: string;
    };
  }>("/api/tasks", async (request, reply) => {
    const { status, project_id: projectId, type, tag } = request.query;
    const limit = Math.min(Math.max(Number(request.query.limit) || 100, 1), 1000);

    if (status && !TASK_STATUSES.includes(status as TaskStatus)) {
      return reply.code(400).send({ error: `Invalid status: ${status}` });
    }

    const conditions: string[] = [];
    const params: unknown[] = [];

    if (status) {
      params.push(status);
      conditions.push(`t.status = $${params.length}`);
    }
    if (projectId) {
      params.push(projectId);
      conditions.push(`t.project_id = $${params.length}`);
    }
    if (type) {
      params.push(type);
      conditions.push(`t.type = $${params.length}`);
    }
    if (tag) {
      params.push(tag);
      conditions.push(`$${params.length} = ANY(t.tags)`);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    params.push(limit);

    try {
      const result = await query<TaskDetailRow>(
        `${TASK_DETAIL_SELECT} ${whereClause} ORDER BY t.created_at DESC LIMIT $${params.length}`,
        params
      );
      return reply.send(result.rows.map(mapTaskDetailRow));
    } catch (err) {
      request.log.error(err, "list tasks failed");
      return reply.code(500).send({ error: "Failed to list tasks" });
    }
  });

  app.get<{ Params: { id: string } }>("/api/tasks/:id", async (request, reply) => {
    try {
      const result = await query<TaskDetailRow>(
        `${TASK_DETAIL_SELECT} WHERE t.id = $1`,
        [request.params.id]
      );
      const row = result.rows[0];
      if (!row) {
        return reply.code(404).send({ error: "Task not found" });
      }
      return reply.send(mapTaskDetailRow(row));
    } catch (err) {
      request.log.error(err, "get task failed");
      return reply.code(500).send({ error: "Failed to fetch task" });
    }
  });

  app.post<{ Params: { id: string } }>("/api/tasks/:id/requeue", async (request, reply) => {
    try {
      const result = await query<TaskRow>(
        `UPDATE tasks SET
            status            = 'PENDING',
            assigned_agent_id = NULL,
            group_id          = NULL,
            claimed_at        = NULL,
            lease_expires_at  = NULL,
            visible_after     = NULL,
            retry_count       = 0,
            last_error        = NULL,
            completed_at      = NULL
         WHERE id = $1 AND status IN ('FAILED','DEAD','COMPLETED')
         RETURNING *`,
        [request.params.id]
      );

      const row = result.rows[0];
      if (!row) {
        const exists = await query<{ id: string }>(`SELECT id FROM tasks WHERE id = $1`, [
          request.params.id,
        ]);
        if (!exists.rows[0]) {
          return reply.code(404).send({ error: "Task not found" });
        }
        return reply.code(409).send({ error: "Task is not in a requeueable state" });
      }

      const task = mapTaskRow(row);
      emitEvent({
        type: "task.requeued",
        task_id: task.id,
        task_type: task.type,
        project_id: task.project_id,
        status: task.status,
        message: "Manually requeued",
      });
      return reply.send(task);
    } catch (err) {
      request.log.error(err, "requeue task failed");
      return reply.code(500).send({ error: "Failed to requeue task" });
    }
  });

  app.post<{ Params: { id: string } }>("/api/tasks/:id/cancel", async (request, reply) => {
    try {
      const result = await query<TaskRow>(
        `UPDATE tasks SET
            status            = 'DEAD',
            assigned_agent_id = NULL,
            group_id          = NULL,
            claimed_at        = NULL,
            lease_expires_at  = NULL,
            last_error        = 'Canceled by operator'
         WHERE id = $1 AND status NOT IN ('COMPLETED','DEAD')
         RETURNING *`,
        [request.params.id]
      );

      const row = result.rows[0];
      if (!row) {
        const exists = await query<{ id: string }>(`SELECT id FROM tasks WHERE id = $1`, [
          request.params.id,
        ]);
        if (!exists.rows[0]) {
          return reply.code(404).send({ error: "Task not found" });
        }
        return reply.code(409).send({ error: "Task is already terminal" });
      }

      const task = mapTaskRow(row);
      emitEvent({
        type: "task.canceled",
        task_id: task.id,
        task_type: task.type,
        project_id: task.project_id,
        status: task.status,
        message: "Canceled by operator",
      });
      return reply.send(task);
    } catch (err) {
      request.log.error(err, "cancel task failed");
      return reply.code(500).send({ error: "Failed to cancel task" });
    }
  });
}
