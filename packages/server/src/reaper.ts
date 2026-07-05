// Background reliability loop: reclaims expired leases and flips stale agents offline.
// Guarded by a Postgres advisory lock so only one server instance runs it at a time.
import type { PoolClient } from "pg";
import { pool, withTx } from "./db.js";
import { env } from "./env.js";
import { emitEvent } from "./events.js";

// Arbitrary fixed key for the reaper's advisory lock (two int32s).
const ADVISORY_LOCK_KEY = 42_424_242;

interface ReclaimedRow {
  id: string;
  type: string;
  project_id: string;
  retry_count: number;
  max_retries: number;
  status: "PENDING" | "DEAD";
}

function backoffSeconds(retryCount: number): number {
  const raw = env.BACKOFF_BASE_SEC * 2 ** Math.max(0, retryCount - 1);
  return Math.min(raw, env.BACKOFF_CAP_SEC);
}

async function reclaimExpiredLeases(client: PoolClient): Promise<ReclaimedRow[]> {
  // retry_count++ first; tasks that now exceed max_retries go DEAD, others go back
  // to PENDING with a backoff-guarded visible_after.
  const result = await client.query<ReclaimedRow>(
    `UPDATE tasks t SET
        retry_count       = t.retry_count + 1,
        status            = CASE WHEN t.retry_count + 1 > t.max_retries THEN 'DEAD' ELSE 'PENDING' END::task_status,
        assigned_agent_id = NULL,
        group_id          = NULL,
        claimed_at        = NULL,
        lease_expires_at  = NULL,
        visible_after     = CASE
                               WHEN t.retry_count + 1 > t.max_retries THEN t.visible_after
                               ELSE now() + (LEAST($1 * power(2, GREATEST(t.retry_count, 0)), $2) || ' seconds')::interval
                             END,
        last_error        = CASE WHEN t.retry_count + 1 > t.max_retries
                                  THEN 'Lease expired (reaper): retry limit exceeded'
                                  ELSE 'Lease expired (reaper): reclaimed for retry'
                             END
     WHERE t.status IN ('CLAIMED','RUNNING')
       AND t.lease_expires_at IS NOT NULL
       AND t.lease_expires_at < now()
     RETURNING t.id, t.type, t.project_id, t.retry_count, t.max_retries, t.status`,
    [env.BACKOFF_BASE_SEC, env.BACKOFF_CAP_SEC]
  );
  return result.rows;
}

async function reclaimLeases(): Promise<void> {
  const client = await pool.connect();
  try {
    const lockResult = await client.query<{ locked: boolean }>(
      "SELECT pg_try_advisory_lock($1) AS locked",
      [ADVISORY_LOCK_KEY]
    );
    if (!lockResult.rows[0]?.locked) {
      // Another instance holds the lock this tick.
      return;
    }

    try {
      const rows = await withReclaimTx(client);
      for (const row of rows) {
        if (row.status === "DEAD") {
          emitEvent({
            type: "task.dead",
            task_id: row.id,
            task_type: row.type,
            project_id: row.project_id,
            status: "DEAD",
            message: `Task exceeded max_retries (${row.max_retries}) after lease expiry`,
          });
        } else {
          emitEvent({
            type: "reaper.reclaimed",
            task_id: row.id,
            task_type: row.type,
            project_id: row.project_id,
            status: "PENDING",
            message: `Lease expired; requeued (retry ${row.retry_count}/${row.max_retries})`,
          });
        }
      }
    } finally {
      await client.query("SELECT pg_advisory_unlock($1)", [ADVISORY_LOCK_KEY]);
    }
  } catch (err) {
    console.error("[reaper] error reclaiming leases", err);
  } finally {
    client.release();
  }
}

async function withReclaimTx(client: PoolClient): Promise<ReclaimedRow[]> {
  await client.query("BEGIN");
  try {
    const rows = await reclaimExpiredLeases(client);
    await client.query("COMMIT");
    return rows;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  }
}

interface StaleAgentRow {
  id: string;
  name: string;
}

async function markStaleAgentsOffline(): Promise<void> {
  try {
    const result = await pool.query<StaleAgentRow>(
      `UPDATE agents SET status = 'offline'
       WHERE status = 'online'
         AND (last_heartbeat_at IS NULL OR last_heartbeat_at < now() - ($1 || ' milliseconds')::interval)
       RETURNING id, name`,
      [env.AGENT_STALE_MS]
    );
    for (const row of result.rows) {
      emitEvent({
        type: "agent.offline",
        agent_id: row.id,
        agent_name: row.name,
        message: "Heartbeat stale; marked offline",
      });
    }
  } catch (err) {
    console.error("[reaper] error marking stale agents offline", err);
  }
}

let intervalHandle: NodeJS.Timeout | null = null;

export function startReaper(): void {
  if (intervalHandle) return;
  const tick = (): void => {
    void reclaimLeases();
    void markStaleAgentsOffline();
  };
  intervalHandle = setInterval(tick, env.REAPER_INTERVAL_MS);
  // Also run once immediately so leases don't linger until the first interval.
  tick();
}

export function stopReaper(): void {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
  }
}
