// The claim algorithm: FIFO + capability hard-filter + per-agent concurrency limit.
// Implements the exact transaction from BUILD-CONTRACT.md — do not deviate.
import type { PoolClient } from "pg";
import type { ClaimedTask } from "@agentmq/shared";
import { INFLIGHT_STATUSES } from "@agentmq/shared";
import { withTx } from "./db.js";
import { env } from "./env.js";
import type { AuthedAgent } from "./auth.js";
import { mapTaskRow, type TaskRow } from "./rowMappers.js";

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

    const result = await client.query<TaskRow>(
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

    const task = mapTaskRow(row);

    const claimed: ClaimedTask = {
      ...task,
      project_name: projectName,
      lease_seconds: env.DEFAULT_VISIBILITY_TIMEOUT,
    };

    return claimed;
  });
}
