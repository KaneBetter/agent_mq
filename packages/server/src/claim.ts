// The claim algorithm: FIFO + capability hard-filter + per-agent concurrency limit.
// Implements the exact transaction from BUILD-CONTRACT.md — do not deviate,
// except for the v5 additions: resting/paused topics are excluded, and
// assign_to_agent_id (targeted reassignment) restricts who may claim a task.
import type { PoolClient } from "pg";
import type { ClaimedTask } from "@agentmq/shared";
import { INFLIGHT_STATUSES } from "@agentmq/shared";
import { withTx } from "./db.js";
import { env } from "./env.js";
import type { AuthedAgent } from "./auth.js";
import { mapTaskRow, type TaskRow } from "./rowMappers.js";
import { computeAgentResting, restingProjectIds } from "./rest.js";

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

/** Every project_id this agent is subscribed to (candidates for a claim). */
async function fetchSubscribedProjectIds(client: PoolClient, agentId: string): Promise<string[]> {
  const result = await client.query<{ project_id: string }>(
    `SELECT DISTINCT project_id FROM subscriptions WHERE agent_id = $1`,
    [agentId]
  );
  return result.rows.map((r) => r.project_id);
}

/**
 * Attempts to claim exactly one task for the given agent. Returns null when
 * the agent is already at its concurrency limit, globally paused/resting, or
 * no eligible task exists (after excluding resting/paused topics and honoring
 * per-task `assign_to_agent_id` targeting).
 */
export async function claimTask(agent: AuthedAgent): Promise<ClaimedTask | null> {
  // Global pause/rest check happens outside the claim transaction: cheap and
  // avoids opening a tx just to bail out for a fully-resting consumer.
  const globallyResting = await computeAgentResting(agent.id, agent.paused);
  if (globallyResting) {
    return null;
  }

  return withTx(async (client) => {
    const inflight = await countInflight(client, agent.id);
    if (inflight >= agent.max_concurrency) {
      return null;
    }

    const subscribedProjectIds = await fetchSubscribedProjectIds(client, agent.id);
    const excludedProjectIds = await restingProjectIds(agent.id, subscribedProjectIds);
    const allowedProjectIds = subscribedProjectIds.filter((id) => !excludedProjectIds.has(id));
    if (allowedProjectIds.length === 0) {
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
            AND t.project_id = ANY($4::uuid[])
            AND (t.target_group_id IS NULL OR t.target_group_id = s.group_id)
            AND (t.assign_to_agent_id IS NULL OR t.assign_to_agent_id = $1)
            AND t.required_capabilities <@ $3::text[]
            AND (t.visible_after IS NULL OR t.visible_after <= now())
          ORDER BY t.priority DESC, t.created_at ASC
          LIMIT 1
          FOR UPDATE OF t SKIP LOCKED
      ) sub
      WHERE t.id = sub.id
      RETURNING t.*`,
      [agent.id, env.DEFAULT_VISIBILITY_TIMEOUT, agent.capabilities, allowedProjectIds]
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
