// Agent-facing task lifecycle: renew lease (heartbeat) and report completion.
import type { FastifyInstance } from "fastify";
import type {
  CompleteTaskRequest,
  CompleteTaskResponse,
  TaskHeartbeatResponse,
  TaskStatus,
} from "@agentmq/shared";
import { pool } from "../db.js";
import { env } from "../env.js";
import { requireAgent } from "../auth.js";
import { emitEvent } from "../events.js";

interface LeaseRow {
  id: string;
  type: string;
  project_id: string;
  status: TaskStatus;
  assigned_agent_id: string | null;
  lease_expires_at: string | null;
  claimed_at: string | null;
  retry_count: number;
  max_retries: number;
}

function backoffSeconds(retryCount: number): number {
  const raw = env.BACKOFF_BASE_SEC * 2 ** Math.max(0, retryCount - 1);
  return Math.min(raw, env.BACKOFF_CAP_SEC);
}

async function fetchLeaseRow(
  client: import("pg").PoolClient,
  taskId: string
): Promise<LeaseRow | null> {
  const result = await client.query<LeaseRow>(
    `SELECT id, type, project_id, status, assigned_agent_id, lease_expires_at, claimed_at, retry_count, max_retries
     FROM tasks WHERE id = $1 FOR UPDATE`,
    [taskId]
  );
  return result.rows[0] ?? null;
}

function leaseIsValid(row: LeaseRow, agentId: string): boolean {
  if (row.assigned_agent_id !== agentId) return false;
  if (!["CLAIMED", "RUNNING"].includes(row.status)) return false;
  if (!row.lease_expires_at) return false;
  return new Date(row.lease_expires_at).getTime() > Date.now();
}

export function registerTaskLifecycleRoutes(app: FastifyInstance): void {
  app.post<{ Params: { id: string } }>(
    "/api/tasks/:id/heartbeat",
    async (request, reply) => {
      const agent = await requireAgent(request, reply);
      if (!agent) return;

      const { id } = request.params;
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const row = await fetchLeaseRow(client, id);

        if (!row) {
          await client.query("ROLLBACK");
          return reply.code(404).send({ error: "Task not found" });
        }

        if (!leaseIsValid(row, agent.id)) {
          await client.query("ROLLBACK");
          return reply.code(409).send({ error: "Lease lost or expired" });
        }

        const wasClaimed = row.status === "CLAIMED";

        const updateResult = await client.query<{ lease_expires_at: string }>(
          `UPDATE tasks SET
              lease_expires_at = now() + ($1 || ' seconds')::interval,
              status = CASE WHEN status = 'CLAIMED' THEN 'RUNNING' ELSE status END
           WHERE id = $2
           RETURNING lease_expires_at`,
          [env.DEFAULT_VISIBILITY_TIMEOUT, id]
        );

        await client.query("COMMIT");

        if (wasClaimed) {
          emitEvent({
            type: "task.running",
            task_id: row.id,
            task_type: row.type,
            project_id: row.project_id,
            agent_id: agent.id,
            agent_name: agent.name,
            status: "RUNNING",
          });
        }

        const response: TaskHeartbeatResponse = {
          lease_expires_at: updateResult.rows[0]?.lease_expires_at as string,
        };
        return reply.send(response);
      } catch (err) {
        await client.query("ROLLBACK");
        request.log.error(err, "task heartbeat failed");
        return reply.code(500).send({ error: "Failed to renew lease" });
      } finally {
        client.release();
      }
    }
  );

  app.post<{ Params: { id: string }; Body: CompleteTaskRequest }>(
    "/api/tasks/:id/complete",
    async (request, reply) => {
      const agent = await requireAgent(request, reply);
      if (!agent) return;

      const { id } = request.params;
      const body = request.body ?? ({} as CompleteTaskRequest);

      if (body.status !== "success" && body.status !== "failure") {
        return reply.code(400).send({ error: "status must be 'success' or 'failure'" });
      }

      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const row = await fetchLeaseRow(client, id);

        if (!row) {
          await client.query("ROLLBACK");
          return reply.code(404).send({ error: "Task not found" });
        }

        if (!leaseIsValid(row, agent.id)) {
          await client.query("ROLLBACK");
          return reply.code(409).send({ error: "Lease lost or expired" });
        }

        const wallTimeMs =
          typeof body.metrics?.wall_time_ms === "number"
            ? body.metrics.wall_time_ms
            : row.claimed_at
              ? Date.now() - new Date(row.claimed_at).getTime()
              : 0;

        await client.query(
          `INSERT INTO results (task_id, agent_id, status, output)
           VALUES ($1, $2, $3, $4::jsonb)`,
          [id, agent.id, body.status, JSON.stringify(body.result ?? {})]
        );

        const inputTokens = body.metrics?.tokens?.input ?? 0;
        const outputTokens = body.metrics?.tokens?.output ?? 0;
        const totalTokens = body.metrics?.tokens?.total ?? inputTokens + outputTokens;

        await client.query(
          `INSERT INTO metrics
             (task_id, agent_id, project_id, model, input_tokens, output_tokens, total_tokens, wall_time_ms, cost_usd, retries)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
          [
            id,
            agent.id,
            row.project_id,
            body.metrics?.model ?? null,
            inputTokens,
            outputTokens,
            totalTokens,
            wallTimeMs,
            body.metrics?.cost_usd ?? 0,
            body.metrics?.retries ?? row.retry_count,
          ]
        );

        let taskStatus: TaskStatus;
        let requeued = false;

        if (body.status === "success") {
          taskStatus = "COMPLETED";
          await client.query(
            `UPDATE tasks SET status = 'COMPLETED', completed_at = now(), last_error = NULL
             WHERE id = $1`,
            [id]
          );
        } else {
          const nextRetryCount = row.retry_count + 1;
          // Contract: retry_count < max_retries => requeue; else DEAD.
          if (row.retry_count < row.max_retries) {
            taskStatus = "PENDING";
            requeued = true;
            const backoff = backoffSeconds(nextRetryCount);
            await client.query(
              `UPDATE tasks SET
                  status            = 'PENDING',
                  retry_count       = $2,
                  visible_after     = now() + ($3 || ' seconds')::interval,
                  assigned_agent_id = NULL,
                  group_id          = NULL,
                  claimed_at        = NULL,
                  lease_expires_at  = NULL,
                  last_error        = $4
               WHERE id = $1`,
              [id, nextRetryCount, backoff, body.error ?? "Task reported failure"]
            );
          } else {
            taskStatus = "DEAD";
            await client.query(
              `UPDATE tasks SET
                  status      = 'DEAD',
                  retry_count = $2,
                  last_error  = $3
               WHERE id = $1`,
              [id, nextRetryCount, body.error ?? "Task reported failure"]
            );
          }
        }

        await client.query("COMMIT");

        if (taskStatus === "COMPLETED") {
          emitEvent({
            type: "task.completed",
            task_id: row.id,
            task_type: row.type,
            project_id: row.project_id,
            agent_id: agent.id,
            agent_name: agent.name,
            status: "COMPLETED",
          });
        } else if (taskStatus === "PENDING") {
          emitEvent({
            type: "task.requeued",
            task_id: row.id,
            task_type: row.type,
            project_id: row.project_id,
            agent_id: agent.id,
            agent_name: agent.name,
            status: "PENDING",
            message: body.error,
          });
        } else {
          emitEvent({
            type: "task.dead",
            task_id: row.id,
            task_type: row.type,
            project_id: row.project_id,
            agent_id: agent.id,
            agent_name: agent.name,
            status: "DEAD",
            message: body.error,
          });
        }

        const response: CompleteTaskResponse = {
          ok: true,
          task_status: taskStatus,
          requeued,
        };
        return reply.send(response);
      } catch (err) {
        await client.query("ROLLBACK");
        request.log.error(err, "task complete failed");
        return reply.code(500).send({ error: "Failed to complete task" });
      } finally {
        client.release();
      }
    }
  );
}
