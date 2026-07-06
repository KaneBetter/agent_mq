// GET /api/calendar: per-day activity rollup + upcoming scheduled tasks.
import type { FastifyInstance } from "fastify";
import type { CalendarDay, CalendarResponse, ScheduledTaskLite, TaskStatus } from "@agentmq/shared";
import { query } from "../db.js";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

function toDateKey(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** Default range = current month (server local time), 1st through last day. */
function defaultRange(): { from: string; to: string } {
  const now = new Date();
  const first = new Date(now.getFullYear(), now.getMonth(), 1);
  const last = new Date(now.getFullYear(), now.getMonth() + 1, 0);
  return { from: toDateKey(first), to: toDateKey(last) };
}

function parseDateKey(key: string): Date {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(y as number, (m as number) - 1, d as number);
}

/** Every YYYY-MM-DD key from `from` to `to` inclusive. */
function enumerateDays(from: string, to: string): string[] {
  const days: string[] = [];
  let cursor = parseDateKey(from);
  const end = parseDateKey(to);
  // Safety cap so a malformed/huge range can't allocate unbounded memory.
  let guard = 0;
  while (cursor.getTime() <= end.getTime() && guard < 3660) {
    days.push(toDateKey(cursor));
    cursor = new Date(cursor.getFullYear(), cursor.getMonth(), cursor.getDate() + 1);
    guard += 1;
  }
  return days;
}

interface ActivityBucketRow {
  day: string;
  activity_total: string;
  completed: string;
  failed: string;
  published: string;
}

interface ScheduledRow {
  id: string;
  type: string;
  tags: string[] | null;
  project_id: string;
  project_name: string;
  status: TaskStatus;
  scheduled_for: string;
  day: string;
}

export function registerCalendarRoutes(app: FastifyInstance): void {
  app.get<{
    Querystring: { project_id?: string; from?: string; to?: string };
  }>("/api/calendar", async (request, reply) => {
    const { project_id: projectId, from: fromRaw, to: toRaw } = request.query;

    if (fromRaw && !DATE_RE.test(fromRaw)) {
      return reply.code(400).send({ error: "from must be YYYY-MM-DD" });
    }
    if (toRaw && !DATE_RE.test(toRaw)) {
      return reply.code(400).send({ error: "to must be YYYY-MM-DD" });
    }

    const fallback = defaultRange();
    const from = fromRaw ?? fallback.from;
    const to = toRaw ?? fallback.to;

    if (parseDateKey(from).getTime() > parseDateKey(to).getTime()) {
      return reply.code(400).send({ error: "from must be <= to" });
    }

    try {
      const activityParams: unknown[] = [from, to];
      let activityProjectClause = "";
      if (projectId) {
        activityParams.push(projectId);
        activityProjectClause = `AND a.project_id = $${activityParams.length}`;
      }

      const activityResult = await query<ActivityBucketRow>(
        `SELECT
            to_char(a.ts, 'YYYY-MM-DD') AS day,
            count(*) AS activity_total,
            count(*) FILTER (WHERE a.type = 'task.completed') AS completed,
            count(*) FILTER (WHERE a.type IN ('task.failed', 'task.dead')) AS failed,
            count(*) FILTER (WHERE a.type IN ('task.published', 'task.scheduled')) AS published
         FROM activity a
         WHERE to_char(a.ts, 'YYYY-MM-DD') BETWEEN $1 AND $2
         ${activityProjectClause}
         GROUP BY to_char(a.ts, 'YYYY-MM-DD')`,
        activityParams
      );

      const scheduledParams: unknown[] = [from, to];
      let scheduledProjectClause = "";
      if (projectId) {
        scheduledParams.push(projectId);
        scheduledProjectClause = `AND t.project_id = $${scheduledParams.length}`;
      }

      const scheduledResult = await query<ScheduledRow>(
        `SELECT
            t.id, t.type, t.tags, t.project_id,
            p.name AS project_name,
            t.status, t.scheduled_for,
            to_char(t.scheduled_for, 'YYYY-MM-DD') AS day
         FROM tasks t
         JOIN projects p ON p.id = t.project_id
         WHERE t.status = 'PENDING'
           AND t.scheduled_for IS NOT NULL
           AND to_char(t.scheduled_for, 'YYYY-MM-DD') BETWEEN $1 AND $2
           ${scheduledProjectClause}
         ORDER BY t.scheduled_for ASC`,
        scheduledParams
      );

      const activityByDay = new Map<string, ActivityBucketRow>();
      for (const row of activityResult.rows) {
        activityByDay.set(row.day, row);
      }

      const scheduledByDay = new Map<string, ScheduledTaskLite[]>();
      for (const row of scheduledResult.rows) {
        const lite: ScheduledTaskLite = {
          id: row.id,
          type: row.type,
          tags: row.tags ?? [],
          project_id: row.project_id,
          project_name: row.project_name,
          status: row.status,
          scheduled_for: row.scheduled_for,
        };
        const list = scheduledByDay.get(row.day) ?? [];
        list.push(lite);
        scheduledByDay.set(row.day, list);
      }

      const days: CalendarDay[] = enumerateDays(from, to).map((date) => {
        const bucket = activityByDay.get(date);
        return {
          date,
          activity_total: Number(bucket?.activity_total ?? 0),
          completed: Number(bucket?.completed ?? 0),
          failed: Number(bucket?.failed ?? 0),
          published: Number(bucket?.published ?? 0),
          scheduled: scheduledByDay.get(date) ?? [],
        };
      });

      const response: CalendarResponse = { from, to, days };
      return reply.send(response);
    } catch (err) {
      request.log.error(err, "get calendar failed");
      return reply.code(500).send({ error: "Failed to fetch calendar" });
    }
  });
}
