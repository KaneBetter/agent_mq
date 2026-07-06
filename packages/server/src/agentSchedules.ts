// Helpers for auto-creating and maintaining agent_schedules rows (server-visible,
// client-executed polling cadences). See BUILD-CONTRACT v4 item 4.
import type { PoolClient } from "pg";
import { pool } from "./db.js";

const SITE_UPDATE_INTERVAL_SECONDS = 86_400;
const PROJECT_POLL_INTERVAL_SECONDS = 60;

/**
 * Upserts the agent's global site_update poll row (project_id NULL). Uses the
 * partial unique index `agent_schedules_site_uidx` (agent_id) WHERE kind = 'site_update'.
 * ON CONFLICT DO NOTHING: an existing row's cadence is left untouched.
 */
export async function ensureSiteUpdateSchedule(
  client: PoolClient | typeof pool,
  agentId: string
): Promise<void> {
  await client.query(
    `INSERT INTO agent_schedules (agent_id, project_id, kind, interval_seconds, next_poll_at)
     VALUES ($1, NULL, 'site_update', $2::int, now() + ($2::text || ' seconds')::interval)
     ON CONFLICT (agent_id) WHERE kind = 'site_update' DO NOTHING`,
    [agentId, SITE_UPDATE_INTERVAL_SECONDS]
  );
}

/**
 * Upserts a project_poll row for (agent_id, project_id). Uses the table's
 * UNIQUE (agent_id, project_id, kind) constraint. ON CONFLICT DO NOTHING: an
 * existing row's cadence is left untouched.
 */
export async function ensureProjectPollSchedule(
  client: PoolClient | typeof pool,
  agentId: string,
  projectId: string
): Promise<void> {
  await client.query(
    `INSERT INTO agent_schedules (agent_id, project_id, kind, interval_seconds, next_poll_at)
     VALUES ($1, $2, 'project_poll', $3::int, now() + ($3::text || ' seconds')::interval)
     ON CONFLICT (agent_id, project_id, kind) DO NOTHING`,
    [agentId, projectId, PROJECT_POLL_INTERVAL_SECONDS]
  );
}

/** Bumps the agent's site_update row on heartbeat. */
export async function touchSiteUpdateSchedule(agentId: string): Promise<void> {
  await pool.query(
    `UPDATE agent_schedules SET
        last_polled_at = now(),
        next_poll_at   = now() + (interval_seconds || ' seconds')::interval
     WHERE agent_id = $1 AND kind = 'site_update'`,
    [agentId]
  );
}

/** Bumps all of the agent's project_poll rows on claim. */
export async function touchProjectPollSchedules(agentId: string): Promise<void> {
  await pool.query(
    `UPDATE agent_schedules SET
        last_polled_at = now(),
        next_poll_at   = now() + (interval_seconds || ' seconds')::interval
     WHERE agent_id = $1 AND kind = 'project_poll'`,
    [agentId]
  );
}
