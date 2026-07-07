// Helpers for auto-creating and maintaining agent_schedules rows (server-visible
// cadence mirrors; the real recurring job is installed client-side by
// `agent-mq schedule install`). Three kinds, one per lifecycle step:
//   site_update  (global, 24h)  — read the site's news timeline
//   space_poll   (per space,24h)— poll for work across a space
//   project_poll (per topic, 1h)— poll for work on one topic
import type { PoolClient } from "pg";
import { pool } from "./db.js";

const SITE_UPDATE_INTERVAL_SECONDS = 86_400; // 24h
const SPACE_POLL_INTERVAL_SECONDS = 86_400; // 24h
const PROJECT_POLL_INTERVAL_SECONDS = 3_600; // 1h

/**
 * Upserts the agent's global site_update poll row (project_id + space_id NULL).
 * Uses the partial unique index `agent_schedules_site_uidx`.
 * ON CONFLICT DO NOTHING: an existing row's cadence is left untouched.
 */
export async function ensureSiteUpdateSchedule(
  client: PoolClient | typeof pool,
  agentId: string
): Promise<void> {
  await client.query(
    `INSERT INTO agent_schedules (agent_id, project_id, space_id, kind, interval_seconds, next_poll_at)
     VALUES ($1, NULL, NULL, 'site_update', $2::int, now() + ($2::text || ' seconds')::interval)
     ON CONFLICT (agent_id) WHERE kind = 'site_update' DO NOTHING`,
    [agentId, SITE_UPDATE_INTERVAL_SECONDS]
  );
}

/**
 * Upserts a space_poll row for (agent_id, space_id). Uses the partial unique
 * index `agent_schedules_space_uidx`. ON CONFLICT DO NOTHING.
 */
export async function ensureSpacePollSchedule(
  client: PoolClient | typeof pool,
  agentId: string,
  spaceId: string
): Promise<void> {
  await client.query(
    `INSERT INTO agent_schedules (agent_id, project_id, space_id, kind, interval_seconds, next_poll_at)
     VALUES ($1, NULL, $2, 'space_poll', $3::int, now() + ($3::text || ' seconds')::interval)
     ON CONFLICT (agent_id, space_id) WHERE kind = 'space_poll' DO NOTHING`,
    [agentId, spaceId, SPACE_POLL_INTERVAL_SECONDS]
  );
}

/**
 * Upserts a project_poll row for (agent_id, project_id). Uses the table's
 * UNIQUE (agent_id, project_id, kind) constraint. ON CONFLICT DO NOTHING.
 */
export async function ensureProjectPollSchedule(
  client: PoolClient | typeof pool,
  agentId: string,
  projectId: string
): Promise<void> {
  await client.query(
    `INSERT INTO agent_schedules (agent_id, project_id, space_id, kind, interval_seconds, next_poll_at)
     VALUES ($1, $2, NULL, 'project_poll', $3::int, now() + ($3::text || ' seconds')::interval)
     ON CONFLICT (agent_id, project_id, kind) DO NOTHING`,
    [agentId, projectId, PROJECT_POLL_INTERVAL_SECONDS]
  );
}

/** Bumps the agent's site_update + space_poll rows on heartbeat. */
export async function touchSiteUpdateSchedule(agentId: string): Promise<void> {
  await pool.query(
    `UPDATE agent_schedules SET
        last_polled_at = now(),
        next_poll_at   = now() + (interval_seconds || ' seconds')::interval
     WHERE agent_id = $1 AND kind IN ('site_update', 'space_poll')`,
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
