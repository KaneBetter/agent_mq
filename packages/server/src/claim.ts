// The claim algorithm: FIFO + capability hard-filter + per-agent concurrency limit.
// Implements the exact transaction from BUILD-CONTRACT.md — do not deviate.
import type { PoolClient } from "pg";
import type { ClaimedTask, Task, TaskStatus } from "@agentmq/shared";
import { INFLIGHT_STATUSES } from "@agentmq/shared";
import { withTx } from "./db.js";
import { env } from "./env.js";
import type { AuthedAgent } from "./auth.js";

interface ClaimedTaskRow {
  id: string;
  project_id: string;
  type: string;
  payload: Record<string, unknown>;
  priority: number;
  required_capabilities: string[];
  target_group_id: string | null;
  status: TaskStatus;
  retry_count: number;
  max_retries: number;
  assigned_agent_id: string | null;
  group_id: string | null;
  claimed_at: string | null;
  lease_expires_at: string | null;
  visible_after: string | null;
  dedup_key: string | null;
  last_error: string | null;
  created_at: string;
  completed_at: string | null;
}

async function countInflight(client: PoolClient, agentId: string): Promise<number> {
  const result = await client.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM tasks
     WHERE assigned_agent_id = $1 AND status = ANY($2::task_status[])`,
    [agentId, INFLIGHT_STATUSES]
  );
  return Number(result.rows[0]?.count ?? "0");
}

async function fetchProjectName(client: PoolClient, projectId: string): Promise<string> {
  const result = await client.query<{ name: string }>(
    `SELECT name FROM projects WHERE id = $1`,
    [projectId]
  );
  return result.rows[0]?.name ?? "";
}

/**
 * Attempts to claim exactly one task for the given agent. Returns null when
 * the agent is already at its concurrency limit or no eligible task exists.
 */
export async function claimTask(agent: AuthedAgent): Promise<ClaimedTask | null> {
  return withTx(async (client) => {
    const inflight = await countInflight(client, agent.id);
    if (inflight >= agent.max_concurrency) {
      return null;
    }

    const result = await client.query<ClaimedTaskRow>(
      `UPDATE tasks t SET
          status            = 'CLAIMED',
          assigned_agent_id = $1,
          group_id          = sub.group_id,
          claimed_at        = now(),
          lease_expires_at  = now() + ($2 || ' seconds')::interval
      FROM (
          SELECT t.id, s.group_id
          FROM tasks t
          JOIN subscriptions s
            ON s.project_id = t.project_id AND s.agent_id = $1
          WHERE t.status = 'PENDING'
            AND (t.target_group_id IS NULL OR t.target_group_id = s.group_id)
            AND t.required_capabilities <@ $3::text[]
            AND (t.visible_after IS NULL OR t.visible_after <= now())
          ORDER BY t.priority DESC, t.created_at ASC
          LIMIT 1
          FOR UPDATE OF t SKIP LOCKED
      ) sub
      WHERE t.id = sub.id
      RETURNING t.*`,
      [agent.id, env.DEFAULT_VISIBILITY_TIMEOUT, agent.capabilities]
    );

    const row = result.rows[0];
    if (!row) return null;

    const projectName = await fetchProjectName(client, row.project_id);

    const task: Task = {
      id: row.id,
      project_id: row.project_id,
      type: row.type,
      payload: row.payload,
      priority: row.priority,
      required_capabilities: row.required_capabilities,
      target_group_id: row.target_group_id,
      status: row.status,
      retry_count: row.retry_count,
      max_retries: row.max_retries,
      assigned_agent_id: row.assigned_agent_id,
      group_id: row.group_id,
      claimed_at: row.claimed_at,
      lease_expires_at: row.lease_expires_at,
      visible_after: row.visible_after,
      dedup_key: row.dedup_key,
      last_error: row.last_error,
      created_at: row.created_at,
      completed_at: row.completed_at,
    };

    const claimed: ClaimedTask = {
      ...task,
      project_name: projectName,
      lease_seconds: env.DEFAULT_VISIBILITY_TIMEOUT,
    };

    return claimed;
  });
}
