// Persists every emitted LiveEvent into the durable `activity` table.
// Wired into events.ts via setActivitySink() from index.ts, after the pool
// exists, so this module can freely import db.ts without cycle risk.
import type { LiveEvent } from "@agentmq/shared";
import { pool } from "./db.js";

/**
 * Fire-and-forget insert: never throws, never blocks the caller. Errors are
 * logged so a DB hiccup can't crash request handling or SSE delivery.
 */
export function persistActivity(event: LiveEvent): void {
  void pool
    .query(
      `INSERT INTO activity (type, project_id, task_id, agent_id, task_type, status, message, ts, meta)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, '{}'::jsonb)`,
      [
        event.type,
        event.project_id ?? null,
        event.task_id ?? null,
        event.agent_id ?? null,
        event.task_type ?? null,
        event.status ?? null,
        event.message ?? null,
        event.ts,
      ]
    )
    .catch((err) => {
      console.error("[activity] failed to persist event", event.type, err);
    });
}
