// Management/UI-facing task routes: publish, list, get, requeue, cancel,
// and (v5) stop/reassign (user auth) — scoped to spaces the caller can see.
import type { FastifyInstance } from "fastify";
import type {
  PublishTaskRequest,
  ReassignTaskRequest,
  StopTaskRequest,
  Task,
  TaskStatus,
} from "@agentmq/shared";
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
import { requireUser } from "../userAuth.js";
import { canProduce, canView, fetchSpace, visibleSpacesClause } from "../spaces.js";

interface TaskTypeRow {
  required_capabilities: string[];
}

export function registerTaskRoutes(app: FastifyInstance): void {
  app.post<{ Body: PublishTaskRequest }>("/api/tasks", async (request, reply) => {
    const user = await requireUser(request, reply);
    if (!user) return;

    const body = request.body ?? ({} as PublishTaskRequest);
    const projectId = typeof body.project_id === "string" ? body.project_id : "";
    const type = typeof body.type === "string" ? body.type.trim() : "";

    if (!projectId || !type) {
      return reply.code(400).send({ error: "project_id and type are required" });
    }

    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      const projectResult = await client.query<{ id: string; name: string; space_id: string | null }>(
        `SELECT id, name, space_id FROM projects WHERE id = $1`,
        [projectId]
      );
      if (!projectResult.rows[0]) {
        await client.query("ROLLBACK");
        return reply.code(404).send({ error: "Project not found" });
      }
      const projectName = projectResult.rows[0].name;
      const projectSpaceId = projectResult.rows[0].space_id;

      if (projectSpaceId) {
        const space = await fetchSpace(projectSpaceId);
        if (!space || !(await canProduce(space, user))) {
          await client.query("ROLLBACK");
          return reply.code(403).send({ error: "Not authorized to produce in this topic's space" });
        }
      } else if (!user.isAdmin) {
        await client.query("ROLLBACK");
        return reply.code(403).send({ error: "Not authorized to produce in this topic's space" });
      }

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
    const user = await requireUser(request, reply);
    if (!user) return;

    const { status, project_id: projectId, type, tag } = request.query;
    const limit = Math.min(Math.max(Number(request.query.limit) || 100, 1), 1000);

    if (status && !TASK_STATUSES.includes(status as TaskStatus)) {
      return reply.code(400).send({ error: `Invalid status: ${status}` });
    }

    // Space visibility: join to the topic's space and require it be
    // public/member-visible (the visibleSpacesClause helper uses alias `sp`).
    const { clause: spaceClause, params: spaceParams } = visibleSpacesClause(user, 0);
    const conditions: string[] = [
      `(t.project_id IN (SELECT p.id FROM projects p LEFT JOIN spaces sp ON sp.id = p.space_id WHERE ${spaceClause}))`,
    ];
    const params: unknown[] = [...spaceParams];

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

    const whereClause = `WHERE ${conditions.join(" AND ")}`;
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
    const user = await requireUser(request, reply);
    if (!user) return;

    try {
      const result = await query<TaskDetailRow>(
        `${TASK_DETAIL_SELECT} WHERE t.id = $1`,
        [request.params.id]
      );
      const row = result.rows[0];
      if (!row) {
        return reply.code(404).send({ error: "Task not found" });
      }

      if (!user.isAdmin) {
        const projectResult = await query<{ space_id: string | null }>(
          `SELECT space_id FROM projects WHERE id = $1`,
          [row.project_id]
        );
        const spaceId = projectResult.rows[0]?.space_id ?? null;
        if (!spaceId) {
          return reply.code(403).send({ error: "Not authorized to view this task" });
        }
        const space = await fetchSpace(spaceId);
        if (!space || !(await canView(space, user))) {
          return reply.code(403).send({ error: "Not authorized to view this task" });
        }
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

  // ── v5: stop — user auth. Release the lease back to PENDING, KEEP `state`.
  app.post<{ Params: { id: string }; Body: StopTaskRequest }>(
    "/api/tasks/:id/stop",
    async (request, reply) => {
      const user = await requireUser(request, reply);
      if (!user) return;

      const body = request.body ?? ({} as StopTaskRequest);
      const assignToAgentId =
        typeof body.assign_to_agent_id === "string" ? body.assign_to_agent_id : null;

      try {
        const result = await query<TaskRow>(
          `UPDATE tasks SET
              status             = 'PENDING',
              assigned_agent_id  = NULL,
              group_id           = NULL,
              claimed_at         = NULL,
              lease_expires_at   = NULL,
              visible_after      = NULL,
              assign_to_agent_id = COALESCE($2, assign_to_agent_id)
           WHERE id = $1 AND status IN ('CLAIMED','RUNNING')
           RETURNING *`,
          [request.params.id, assignToAgentId]
        );

        const row = result.rows[0];
        if (!row) {
          const exists = await query<{ id: string }>(`SELECT id FROM tasks WHERE id = $1`, [
            request.params.id,
          ]);
          if (!exists.rows[0]) {
            return reply.code(404).send({ error: "Task not found" });
          }
          return reply.code(409).send({ error: "Task is not in-flight" });
        }

        const task = mapTaskRow(row);
        emitEvent({
          type: "task.requeued",
          task_id: task.id,
          task_type: task.type,
          project_id: task.project_id,
          status: task.status,
          message: "Stopped by operator; checkpoint preserved",
        });
        return reply.send(task);
      } catch (err) {
        request.log.error(err, "stop task failed");
        return reply.code(500).send({ error: "Failed to stop task" });
      }
    }
  );

  // ── v5: reassign — user auth. Target a specific consumer; release any lease.
  app.post<{ Params: { id: string }; Body: ReassignTaskRequest }>(
    "/api/tasks/:id/reassign",
    async (request, reply) => {
      const user = await requireUser(request, reply);
      if (!user) return;

      const body = request.body ?? ({} as ReassignTaskRequest);
      const agentId = typeof body.agent_id === "string" ? body.agent_id : "";
      if (!agentId) {
        return reply.code(400).send({ error: "agent_id is required" });
      }

      try {
        const agentExists = await query<{ id: string }>(`SELECT id FROM agents WHERE id = $1`, [
          agentId,
        ]);
        if (!agentExists.rows[0]) {
          return reply.code(404).send({ error: "Agent not found" });
        }

        const result = await query<TaskRow>(
          `UPDATE tasks SET
              assign_to_agent_id = $2,
              status              = CASE WHEN status IN ('CLAIMED','RUNNING') THEN 'PENDING' ELSE status END,
              assigned_agent_id   = CASE WHEN status IN ('CLAIMED','RUNNING') THEN NULL ELSE assigned_agent_id END,
              group_id            = CASE WHEN status IN ('CLAIMED','RUNNING') THEN NULL ELSE group_id END,
              claimed_at          = CASE WHEN status IN ('CLAIMED','RUNNING') THEN NULL ELSE claimed_at END,
              lease_expires_at    = CASE WHEN status IN ('CLAIMED','RUNNING') THEN NULL ELSE lease_expires_at END,
              visible_after       = CASE WHEN status IN ('CLAIMED','RUNNING') THEN NULL ELSE visible_after END
           WHERE id = $1
           RETURNING *`,
          [request.params.id, agentId]
        );

        const row = result.rows[0];
        if (!row) {
          return reply.code(404).send({ error: "Task not found" });
        }

        const task = mapTaskRow(row);
        emitEvent({
          type: "task.requeued",
          task_id: task.id,
          task_type: task.type,
          project_id: task.project_id,
          agent_id: agentId,
          status: task.status,
          message: `Reassigned to agent ${agentId}`,
        });
        return reply.send(task);
      } catch (err) {
        request.log.error(err, "reassign task failed");
        return reply.code(500).send({ error: "Failed to reassign task" });
      }
    }
  );
}
