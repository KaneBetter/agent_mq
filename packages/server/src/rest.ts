// Agent rest/pause computation: "resting for a topic" and "resting globally".
// A consumer is resting for a topic if: agents.paused, OR a global rest window
// is active now, OR the topic's subscription is paused, OR a topic-scoped rest
// window is active now. Reuses the Intl tz-offset trick from scheduling.ts.
import { query } from "./db.js";

interface RestWindowRow {
  id: string;
  project_id: string | null;
  days_of_week: number[];
  start_time: string;
  end_time: string;
  timezone: string;
}

function parseHhMmToMinutes(value: string): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const hh = Number(match[1]);
  const mm = Number(match[2]);
  if (!Number.isFinite(hh) || !Number.isFinite(mm)) return null;
  if (hh < 0 || hh > 23 || mm < 0 || mm > 59) return null;
  return hh * 60 + mm;
}

/** Current weekday (0=Sun..6=Sat) + minute-of-day, as observed in `tz`, at `now`. */
function localWeekdayAndMinute(now: Date, tz: string): { weekday: number; minuteOfDay: number } {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  const parts = formatter.formatToParts(now);
  const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? "";
  const weekdayIndex: Record<string, number> = {
    Sun: 0,
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6,
  };
  const weekday = weekdayIndex[get("weekday")] ?? 0;
  const hour = get("hour") === "24" ? 0 : Number(get("hour"));
  const minute = Number(get("minute"));
  return { weekday, minuteOfDay: hour * 60 + minute };
}

/** True when `now` falls within the window's [start_time, end_time) on a matching weekday. */
export function isWindowActiveNow(window: RestWindowRow, now: Date = new Date()): boolean {
  const { weekday, minuteOfDay } = localWeekdayAndMinute(now, window.timezone || "UTC");
  if (!window.days_of_week.includes(weekday)) return false;

  const start = parseHhMmToMinutes(window.start_time);
  const end = parseHhMmToMinutes(window.end_time);
  if (start === null || end === null) return false;

  if (start === end) return false; // zero-length window never active
  if (start < end) {
    return minuteOfDay >= start && minuteOfDay < end;
  }
  // Overnight window (e.g. 22:00 -> 06:00): active if after start OR before end.
  return minuteOfDay >= start || minuteOfDay < end;
}

async function fetchRestWindows(agentId: string): Promise<RestWindowRow[]> {
  const result = await query<RestWindowRow>(
    `SELECT id, project_id, days_of_week, start_time, end_time, timezone
     FROM agent_rest_windows WHERE agent_id = $1`,
    [agentId]
  );
  return result.rows;
}

/** True if any GLOBAL (project_id NULL) rest window is active right now. */
export async function hasActiveGlobalRestWindow(
  agentId: string,
  now: Date = new Date()
): Promise<boolean> {
  const windows = await fetchRestWindows(agentId);
  return windows.some((w) => w.project_id === null && isWindowActiveNow(w, now));
}

/**
 * AgentSummary.resting = agents.paused OR any active global rest window.
 * Independent of per-topic subscription pause / topic-scoped windows.
 */
export async function computeAgentResting(
  agentId: string,
  paused: boolean,
  now: Date = new Date()
): Promise<boolean> {
  if (paused) return true;
  return hasActiveGlobalRestWindow(agentId, now);
}

/**
 * Returns the set of project_ids this agent should be EXCLUDED from claiming,
 * among `candidateProjectIds` (its subscribed projects), because the topic's
 * subscription is paused or a topic-scoped rest window is active now.
 * Callers should also check `computeAgentResting` for the global case first.
 */
export async function restingProjectIds(
  agentId: string,
  candidateProjectIds: string[],
  now: Date = new Date()
): Promise<Set<string>> {
  const resting = new Set<string>();
  if (candidateProjectIds.length === 0) return resting;

  const pausedResult = await query<{ project_id: string }>(
    `SELECT project_id FROM subscriptions
     WHERE agent_id = $1 AND paused = true AND project_id = ANY($2::uuid[])`,
    [agentId, candidateProjectIds]
  );
  for (const row of pausedResult.rows) resting.add(row.project_id);

  const windows = await fetchRestWindows(agentId);
  for (const w of windows) {
    if (w.project_id && candidateProjectIds.includes(w.project_id) && isWindowActiveNow(w, now)) {
      resting.add(w.project_id);
    }
  }

  return resting;
}
