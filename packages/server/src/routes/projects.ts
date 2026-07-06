import type { FastifyInstance } from "fastify";
import type {
  AgentSummary,
  CreateProjectRequest,
  Group,
  Project,
  ProjectDetail,
  ProjectSummary,
  Schedule,
  ScheduleOccurrence,
  TaskDetail,
} from "@agentmq/shared";
import { pool, query } from "../db.js";
import {
  AGENT_SCHEDULE_SELECT,
  mapAgentScheduleRow,
  mapScheduleRow,
  mapTaskDetailRow,
  TASK_DETAIL_SELECT,
  type AgentScheduleRow,
  type ScheduleRow,
  type TaskDetailRow,
} from "../rowMappers.js";
import { nextRun } from "../scheduling.js";
import { requireUser } from "../userAuth.js";
import { canProduce, canView, fetchSpace, visibleSpacesClause } from "../spaces.js";
import { computeAgentResting } from "../rest.js";

interface ProjectRow {
  id: string;
  name: string;
  description: string;
  tags: string[] | null;
  space_id: string | null;
  space_name?: string | null;
  task_schema: Record<string, unknown> | null;
  created_at: string;
}

function mapProjectRow(row: ProjectRow): Project {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    tags: row.tags ?? [],
    space_id: row.space_id ?? null,
    space_name: row.space_name ?? null,
    task_schema: row.task_schema,
    created_at: row.created_at,
  };
}

/** Shared aggregate-building for a single project row -> ProjectSummary. */
async function buildProjectSummary(row: ProjectRow): Promise<ProjectSummary> {
  const countsResult = await query<{
    pending: string;
    running: string;
    completed: string;
    dead: string;
  }>(
    `SELECT
        count(*) FILTER (WHERE status = 'PENDING') AS pending,
        count(*) FILTER (WHERE status IN ('CLAIMED','RUNNING')) AS running,
        count(*) FILTER (WHERE status = 'COMPLETED') AS completed,
        count(*) FILTER (WHERE status = 'DEAD') AS dead
     FROM tasks WHERE project_id = $1`,
    [row.id]
  );
  const counts = countsResult.rows[0];

  const eligibleResult = await query<{ count: string }>(
    `SELECT count(DISTINCT s.agent_id) AS count
     FROM subscriptions s
     JOIN agents a ON a.id = s.agent_id
     WHERE s.project_id = $1
       AND EXISTS (
         SELECT 1 FROM tasks t
         WHERE t.project_id = s.project_id
           AND t.status = 'PENDING'
           AND t.required_capabilities <@ a.capabilities
       )`,
    [row.id]
  );

  const groupsResult = await query<Group>(
    `SELECT id, name, project_id, created_at FROM groups WHERE project_id = $1 ORDER BY created_at ASC`,
    [row.id]
  );

  return {
    ...mapProjectRow(row),
    pending: Number(counts?.pending ?? 0),
    running: Number(counts?.running ?? 0),
    completed: Number(counts?.completed ?? 0),
    dead: Number(counts?.dead ?? 0),
    eligible_agents: Number(eligibleResult.rows[0]?.count ?? 0),
    groups: groupsResult.rows,
  };
}

/** CreateProjectRequest + the v5 required space_id (shared type is frozen). */
type CreateProjectRequestWithSpace = CreateProjectRequest & { space_id?: string };

const PROJECT_SELECT_COLUMNS = `p.id, p.name, p.description, p.task_schema, p.tags, p.space_id, sp.name AS space_name, p.created_at`;

export function registerProjectRoutes(app: FastifyInstance): void {
  app.post<{ Body: CreateProjectRequestWithSpace }>("/api/projects", async (request, reply) => {
    const user = await requireUser(request, reply);
    if (!user) return;

    const body = request.body ?? ({} as CreateProjectRequestWithSpace);
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (!name) {
      return reply.code(400).send({ error: "name is required" });
    }
    const spaceId = typeof body.space_id === "string" ? body.space_id : "";
    if (!spaceId) {
      return reply.code(400).send({ error: "space_id is required" });
    }
    const description = typeof body.description === "string" ? body.description : "";
    const taskSchema = body.task_schema ?? null;
    const tags = Array.isArray(body.tags) ? body.tags.filter((t) => typeof t === "string") : [];
    const defaultGroup =
      typeof body.default_group === "string" && body.default_group.trim().length > 0
        ? body.default_group.trim()
        : "default";

    const space = await fetchSpace(spaceId);
    if (!space) {
      return reply.code(404).send({ error: "Space not found" });
    }
    if (!(await canProduce(space, user))) {
      return reply.code(403).send({ error: "Not authorized to create topics in this space" });
    }

    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      const projectResult = await client.query<ProjectRow>(
        `INSERT INTO projects (name, description, task_schema, tags, space_id)
         VALUES ($1, $2, $3::jsonb, $4, $5)
         RETURNING id, name, description, task_schema, tags, space_id, created_at`,
        [name, description, taskSchema ? JSON.stringify(taskSchema) : null, tags, spaceId]
      );

      const row = projectResult.rows[0];
      if (!row) {
        await client.query("ROLLBACK");
        return reply.code(500).send({ error: "Failed to create project" });
      }

      await client.query(
        `INSERT INTO groups (name, project_id) VALUES ($1, $2)
         ON CONFLICT (project_id, name) DO NOTHING`,
        [defaultGroup, row.id]
      );

      await client.query("COMMIT");
      return reply.code(201).send(mapProjectRow({ ...row, space_name: space.name }));
    } catch (err) {
      await client.query("ROLLBACK");
      if (err instanceof Error && "code" in err && (err as { code?: string }).code === "23505") {
        return reply.code(409).send({ error: "Project name already exists" });
      }
      request.log.error(err, "create project failed");
      return reply.code(500).send({ error: "Failed to create project" });
    } finally {
      client.release();
    }
  });

  app.get<{ Querystring: { tag?: string } }>("/api/projects", async (request, reply) => {
    const user = await requireUser(request, reply);
    if (!user) return;

    const { tag } = request.query;
    try {
      const { clause, params: visibilityParams } = visibleSpacesClause(user, 0);
      const params: unknown[] = [...visibilityParams];
      const conditions: string[] = [clause];

      if (tag) {
        params.push(tag);
        conditions.push(`$${params.length} = ANY(p.tags)`);
      }

      const projectsResult = await query<ProjectRow>(
        `SELECT ${PROJECT_SELECT_COLUMNS}
         FROM projects p
         LEFT JOIN spaces sp ON sp.id = p.space_id
         WHERE ${conditions.join(" AND ")}
         ORDER BY p.created_at ASC`,
        params
      );

      const summaries: ProjectSummary[] = [];
      for (const row of projectsResult.rows) {
        summaries.push(await buildProjectSummary(row));
      }

      return reply.send(summaries);
    } catch (err) {
      request.log.error(err, "list projects failed");
      return reply.code(500).send({ error: "Failed to list projects" });
    }
  });

  app.get<{ Params: { id: string } }>("/api/projects/:id", async (request, reply) => {
    const user = await requireUser(request, reply);
    if (!user) return;

    const { id } = request.params;
    try {
      const projectResult = await query<ProjectRow>(
        `SELECT ${PROJECT_SELECT_COLUMNS} FROM projects p LEFT JOIN spaces sp ON sp.id = p.space_id WHERE p.id = $1`,
        [id]
      );
      const row = projectResult.rows[0];
      if (!row) {
        return reply.code(404).send({ error: "Project not found" });
      }

      if (row.space_id) {
        const space = await fetchSpace(row.space_id);
        if (space && !(await canView(space, user))) {
          return reply.code(403).send({ error: "Not authorized to view this project" });
        }
      } else if (!user.isAdmin) {
        // Orphaned (no space) topics are only visible to the admin bypass.
        return reply.code(403).send({ error: "Not authorized to view this project" });
      }

      const summary = await buildProjectSummary(row);

      const agentsResult = await query<Record<string, unknown>>(
        `SELECT DISTINCT
            a.id, a.name, a.owner, a.owner_user_id, a.machine_info, a.capabilities, a.max_concurrency,
            a.status, a.paused, a.last_heartbeat_at, a.created_at,
            COALESCE(inflight.count, 0)::int AS inflight,
            COALESCE(agg.completed_count, 0)::int AS completed_count,
            COALESCE(agg.failed_count, 0)::int AS failed_count,
            COALESCE(agg.total_tokens, 0)::int AS total_tokens,
            COALESCE(agg.total_wall_time_ms, 0)::int AS total_wall_time_ms,
            COALESCE(agg.total_cost_usd, 0)::float AS total_cost_usd
         FROM agents a
         JOIN subscriptions s ON s.agent_id = a.id AND s.project_id = $1
         LEFT JOIN LATERAL (
           SELECT count(*) AS count FROM tasks
           WHERE assigned_agent_id = a.id AND status IN ('CLAIMED','RUNNING')
         ) inflight ON true
         LEFT JOIN LATERAL (
           SELECT
             count(*) FILTER (WHERE t.status = 'COMPLETED') AS completed_count,
             count(*) FILTER (WHERE t.status IN ('FAILED','DEAD')) AS failed_count,
             COALESCE(sum(m.total_tokens), 0) AS total_tokens,
             COALESCE(sum(m.wall_time_ms), 0) AS total_wall_time_ms,
             COALESCE(sum(m.cost_usd), 0) AS total_cost_usd
           FROM tasks t
           LEFT JOIN metrics m ON m.task_id = t.id
           WHERE t.assigned_agent_id = a.id
         ) agg ON true
         ORDER BY a.created_at DESC`,
        [id]
      );
      const agents: AgentSummary[] = [];
      for (const r of agentsResult.rows) {
        const completed = Number(r.completed_count ?? 0);
        const failed = Number(r.failed_count ?? 0);
        const finished = completed + failed;
        const paused = Boolean(r.paused);
        const resting = await computeAgentResting(r.id as string, paused);
        agents.push({
          id: r.id as string,
          name: r.name as string,
          owner: r.owner as string,
          owner_user_id: (r.owner_user_id as string | null) ?? null,
          machine_info: r.machine_info as Record<string, unknown>,
          capabilities: r.capabilities as string[],
          max_concurrency: r.max_concurrency as number,
          status: r.status as AgentSummary["status"],
          paused,
          last_heartbeat_at: r.last_heartbeat_at as string | null,
          created_at: r.created_at as string,
          inflight: Number(r.inflight ?? 0),
          completed_count: completed,
          failed_count: failed,
          total_tokens: Number(r.total_tokens ?? 0),
          total_wall_time_ms: Number(r.total_wall_time_ms ?? 0),
          total_cost_usd: Number(r.total_cost_usd ?? 0),
          success_rate: finished > 0 ? completed / finished : null,
          resting,
        });
      }

      const schedulesResult = await query<ScheduleRow>(
        `SELECT * FROM schedules WHERE project_id = $1 ORDER BY created_at ASC`,
        [id]
      );
      const schedules: Schedule[] = schedulesResult.rows.map(mapScheduleRow);

      const agentSchedulesResult = await query<AgentScheduleRow>(
        `${AGENT_SCHEDULE_SELECT} WHERE ags.project_id = $1 ORDER BY ags.created_at ASC`,
        [id]
      );
      const agentSchedules = agentSchedulesResult.rows.map(mapAgentScheduleRow);

      const recentTasksResult = await query<TaskDetailRow>(
        `${TASK_DETAIL_SELECT} WHERE t.project_id = $1 ORDER BY t.created_at DESC LIMIT 50`,
        [id]
      );
      const recentTasks: TaskDetail[] = recentTasksResult.rows.map(mapTaskDetailRow);

      // Upcoming occurrences: next ~20 across the project's enabled schedules,
      // computed via nextRun (repeatedly walking each schedule forward),
      // merged and sorted by `at`.
      const upcoming: ScheduleOccurrence[] = [];
      const perScheduleCap = 20;
      for (const schedule of schedules) {
        if (!schedule.enabled) continue;
        let cursor = new Date(schedule.next_run_at);
        for (let i = 0; i < perScheduleCap; i += 1) {
          const at = i === 0 ? cursor : nextRun(schedule.recurrence, cursor);
          cursor = at;
          const shiftEnd =
            schedule.shift_hours !== null
              ? new Date(at.getTime() + schedule.shift_hours * 3600_000).toISOString()
              : null;
          upcoming.push({
            schedule_id: schedule.id,
            schedule_name: schedule.name,
            type: schedule.type,
            at: at.toISOString(),
            shift_end: shiftEnd,
          });
        }
      }
      upcoming.sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime());
      const upcomingTrimmed = upcoming.slice(0, 20);

      const detail: ProjectDetail = {
        ...summary,
        agents,
        schedules,
        agent_schedules: agentSchedules,
        recent_tasks: recentTasks,
        upcoming: upcomingTrimmed,
      };

      return reply.send(detail);
    } catch (err) {
      request.log.error(err, "get project detail failed");
      return reply.code(500).send({ error: "Failed to fetch project" });
    }
  });
}
