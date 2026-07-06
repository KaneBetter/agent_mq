// Pure recurrence math for the schedules ticker. No I/O, no deps beyond Intl.
import type { Recurrence } from "@agentmq/shared";

const MAX_INTERVAL_ITERS = 10_000;
const MAX_WEEKLY_DAYS_OUT = 14;

/**
 * Converts a wall-clock date/time expressed in `tz` to the equivalent UTC
 * instant, using the "Intl offset trick":
 *  1. Guess the instant by treating (y, monthIdx, day, hh, mm) as if it were UTC.
 *  2. Ask Intl what wall-clock time that UTC instant renders as in `tz`.
 *  3. The difference between our intended wall-clock time and what we got back
 *     is exactly the correction needed (handles any UTC offset, DST included).
 */
export function wallClockToUtc(
  y: number,
  monthIdx: number, // 0-based, matches Date's convention
  day: number,
  hh: number,
  mm: number,
  tz: string
): Date {
  const guessMs = Date.UTC(y, monthIdx, day, hh, mm, 0, 0);

  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });

  const parts = formatter.formatToParts(new Date(guessMs));
  const get = (type: string): number => {
    const part = parts.find((p) => p.type === type);
    return part ? Number(part.value) : 0;
  };

  // What the guessed UTC instant actually looks like when rendered in `tz`.
  const renderedMs = Date.UTC(
    get("year"),
    get("month") - 1,
    get("day"),
    get("hour") === 24 ? 0 : get("hour"),
    get("minute"),
    get("second"),
    0
  );

  // The offset error: how far off our guess was from the intended wall clock.
  const correction = guessMs - renderedMs;
  return new Date(guessMs + correction);
}

function parseHhMm(value: string): { hh: number; mm: number } | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const hh = Number(match[1]);
  const mm = Number(match[2]);
  if (!Number.isFinite(hh) || !Number.isFinite(mm)) return null;
  if (hh < 0 || hh > 23 || mm < 0 || mm > 59) return null;
  return { hh, mm };
}

function nextIntervalRun(recurrence: Recurrence, after: Date): Date {
  const intervalSeconds = recurrence.interval_seconds;
  if (!intervalSeconds || intervalSeconds <= 0) {
    throw new Error("interval recurrence requires a positive interval_seconds");
  }

  const now = Date.now();
  let next = after.getTime() + intervalSeconds * 1000;
  let iterations = 0;
  while (next <= now && iterations < MAX_INTERVAL_ITERS) {
    next += intervalSeconds * 1000;
    iterations += 1;
  }
  return new Date(next);
}

/**
 * Finds the earliest instant strictly after `after` that lands on one of
 * `days_of_week` (0=Sun..6=Sat) at one of `times` ("HH:MM"), interpreted in
 * `timezone`. Iterates day-by-day up to MAX_WEEKLY_DAYS_OUT out.
 */
function nextWeeklyRun(recurrence: Recurrence, after: Date): Date {
  const days = recurrence.days_of_week;
  const times = recurrence.times;
  if (!days || days.length === 0) {
    throw new Error("weekly recurrence requires days_of_week");
  }
  if (!times || times.length === 0) {
    throw new Error("weekly recurrence requires times");
  }

  const parsedTimes = times
    .map(parseHhMm)
    .filter((t): t is { hh: number; mm: number } => t !== null)
    .sort((a, b) => a.hh * 60 + a.mm - (b.hh * 60 + b.mm));
  if (parsedTimes.length === 0) {
    throw new Error("weekly recurrence has no valid times");
  }

  const tz = recurrence.timezone ?? process.env.TZ ?? "UTC";
  const dayFormatter = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
  });

  // Anchor the day-walk at `after`'s wall-clock date in `tz`, then step forward
  // day by day, checking each candidate day-of-week/time combination.
  const anchorParts = dayFormatter.formatToParts(after);
  const get = (type: string): string => anchorParts.find((p) => p.type === type)?.value ?? "";
  let cursorY = Number(get("year"));
  let cursorM = Number(get("month")); // 1-based
  let cursorD = Number(get("day"));

  const weekdayIndex: Record<string, number> = {
    Sun: 0,
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6,
  };

  for (let dayOffset = 0; dayOffset <= MAX_WEEKLY_DAYS_OUT; dayOffset += 1) {
    // Compute the candidate calendar day (in tz-local terms) by walking via a
    // UTC-noon anchor to avoid DST edge cases when adding days.
    const walkAnchor = new Date(Date.UTC(cursorY, cursorM - 1, cursorD, 12, 0, 0));
    walkAnchor.setUTCDate(walkAnchor.getUTCDate() + dayOffset);
    const candY = walkAnchor.getUTCFullYear();
    const candM = walkAnchor.getUTCMonth(); // 0-based
    const candD = walkAnchor.getUTCDate();

    const weekdayParts = dayFormatter.formatToParts(walkAnchor);
    const weekdayStr = weekdayParts.find((p) => p.type === "weekday")?.value ?? "";
    const weekday = weekdayIndex[weekdayStr];
    if (weekday === undefined || !days.includes(weekday)) {
      continue;
    }

    for (const t of parsedTimes) {
      const candidate = wallClockToUtc(candY, candM, candD, t.hh, t.mm, tz);
      if (candidate.getTime() > after.getTime()) {
        return candidate;
      }
    }
  }

  throw new Error(
    `nextWeeklyRun: no matching occurrence found within ${MAX_WEEKLY_DAYS_OUT} days`
  );
}

/**
 * Computes the next fire time strictly after `after` for the given recurrence.
 */
export function nextRun(recurrence: Recurrence, after: Date): Date {
  if (recurrence.kind === "interval") {
    return nextIntervalRun(recurrence, after);
  }
  if (recurrence.kind === "weekly") {
    return nextWeeklyRun(recurrence, after);
  }
  throw new Error(`Unknown recurrence kind: ${(recurrence as Recurrence).kind}`);
}
