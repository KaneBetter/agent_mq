// GET /api/me/overview: my spaces, topics in my spaces, my consumers, recent tasks.
import type { FastifyInstance } from "fastify";
import type { MyOverview, SpaceRole, SpaceVisibility, TaskDetail } from "@agentmq/shared";
import { query } from "../db.js";
import { requireUser } from "../userAuth.js";
import { visibleSpacesClause } from "../spaces.js";
import { computeAgentResting } from "../rest.js";
import { mapTaskDetailRow, TASK_DETAIL_SELECT, type TaskDetailRow } from "../rowMappers.js";

export function registerMeRoutes(app: FastifyInstance): void {
  app.get("/api/me/overview", async (request, reply) => {
    const user = await requireUser(request, reply);
    if (!user) return;

    try {
      const { clause: spaceClause, params: spaceParams } = visibleSpacesClause(user, 0);

      const spacesResult = await query<{
        id: string;
        name: string;
        slug: string;
        visibility: SpaceVisibility;
        owner_id: string | null;
        created_at: string;
        owner_username: string | null;
        my_role: SpaceRole | null;
        topic_count: string;
        member_count: string;
      }>(
        `SELECT
            sp.id, sp.name, sp.slug, sp.visibility, sp.owner_id, sp.created_at,
            ou.username AS owner_username,
            ${user.isAdmin ? "NULL" : "sm.role"} AS my_role,
            COALESCE(tc.count, 0)::text AS topic_count,
            COALESCE(mc.count, 0)::text AS member_count
         FROM spaces sp
         LEFT JOIN users ou ON ou.id = sp.owner_id
         ${user.isAdmin ? "" : "LEFT JOIN space_members sm ON sm.space_id = sp.id AND sm.user_id = $1"}
         LEFT JOIN LATERAL (SELECT count(*) AS count FROM projects p WHERE p.space_id = sp.id) tc ON true
         LEFT JOIN LATERAL (SELECT count(*) AS count FROM space_members m WHERE m.space_id = sp.id) mc ON true
         WHERE ${spaceClause}
         ORDER BY sp.created_at ASC`,
        spaceParams
      );

      const spaces = spacesResult.rows.map((row) => ({
        id: row.id,
        name: row.name,
        slug: row.slug,
        visibility: row.visibility,
        owner_id: row.owner_id,
        created_at: row.created_at,
        owner_username: row.owner_username,
        my_role: row.my_role,
        topic_count: Number(row.topic_count ?? 0),
        member_count: Number(row.member_count ?? 0),
      }));

      const topicsResult = await query<{
        id: string;
        name: string;
        description: string;
        tags: string[] | null;
        space_id: string | null;
        space_name: string | null;
        task_schema: Record<string, unknown> | null;
        created_at: string;
      }>(
        `SELECT p.id, p.name, p.description, p.tags, p.space_id, sp.name AS space_name, p.task_schema, p.created_at
         FROM projects p
         LEFT JOIN spaces sp ON sp.id = p.space_id
         WHERE ${spaceClause}
         ORDER BY p.created_at ASC`,
        spaceParams
      );

      const topics = [];
      for (const row of topicsResult.rows) {
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
        const eligibleResult = await query<{ count: string }>(
          `SELECT count(DISTINCT s.agent_id) AS count
           FROM subscriptions s
           JOIN agents a ON a.id = s.agent_id
           WHERE s.project_id = $1
             AND EXISTS (
               SELECT 1 FROM tasks t
               WHERE t.project_id = s.project_id AND t.status = 'PENDING'
                 AND t.required_capabilities <@ a.capabilities
             )`,
          [row.id]
        );
        const groupsResult = await query<{
          id: string;
          name: string;
          project_id: string;
          created_at: string;
        }>(`SELECT id, name, project_id, created_at FROM groups WHERE project_id = $1 ORDER BY created_at ASC`, [
          row.id,
        ]);
        const counts = countsResult.rows[0];
        topics.push({
          id: row.id,
          name: row.name,
          description: row.description,
          tags: row.tags ?? [],
          space_id: row.space_id,
          space_name: row.space_name,
          task_schema: row.task_schema,
          created_at: row.created_at,
          pending: Number(counts?.pending ?? 0),
          running: Number(counts?.running ?? 0),
          completed: Number(counts?.completed ?? 0),
          dead: Number(counts?.dead ?? 0),
          eligible_agents: Number(eligibleResult.rows[0]?.count ?? 0),
          groups: groupsResult.rows,
        });
      }

      // My consumers: agents owned by me (skip for the admin bypass, which has no user id).
      const agents = [];
      if (!user.isAdmin) {
        const agentsResult = await query<Record<string, unknown>>(
          `SELECT
              a.id, a.name, a.owner, a.owner_user_id, a.space_id, msp.name AS space_name,
              a.machine_info, a.capabilities, a.max_concurrency,
              a.status, a.paused, a.last_heartbeat_at, a.created_at,
              COALESCE(inflight.count, 0)::int AS inflight,
              COALESCE(agg.completed_count, 0)::int AS completed_count,
              COALESCE(agg.failed_count, 0)::int AS failed_count,
              COALESCE(agg.total_tokens, 0)::int AS total_tokens,
              COALESCE(agg.total_wall_time_ms, 0)::int AS total_wall_time_ms,
              COALESCE(agg.total_cost_usd, 0)::float AS total_cost_usd
           FROM agents a
           LEFT JOIN spaces msp ON msp.id = a.space_id
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
           WHERE a.owner_user_id = $1
           ORDER BY a.created_at DESC`,
          [user.id]
        );
        for (const row of agentsResult.rows) {
          const completed = Number(row.completed_count ?? 0);
          const failed = Number(row.failed_count ?? 0);
          const finished = completed + failed;
          const paused = Boolean(row.paused);
          const resting = await computeAgentResting(row.id as string, paused);
          agents.push({
            id: row.id as string,
            name: row.name as string,
            owner: row.owner as string,
            owner_user_id: (row.owner_user_id as string | null) ?? null,
            space_id: (row.space_id as string | null) ?? null,
            space_name: (row.space_name as string | null) ?? null,
            machine_info: row.machine_info as Record<string, unknown>,
            capabilities: row.capabilities as string[],
            max_concurrency: row.max_concurrency as number,
            status: row.status as "online" | "offline",
            paused,
            last_heartbeat_at: row.last_heartbeat_at as string | null,
            created_at: row.created_at as string,
            inflight: Number(row.inflight ?? 0),
            completed_count: completed,
            failed_count: failed,
            total_tokens: Number(row.total_tokens ?? 0),
            total_wall_time_ms: Number(row.total_wall_time_ms ?? 0),
            total_cost_usd: Number(row.total_cost_usd ?? 0),
            success_rate: finished > 0 ? completed / finished : null,
            resting,
          });
        }
      }

      // Recent tasks my consumers ran.
      let recentTasks: TaskDetail[] = [];
      if (!user.isAdmin && agents.length > 0) {
        const agentIds = agents.map((a) => a.id);
        const tasksResult = await query<TaskDetailRow>(
          `${TASK_DETAIL_SELECT} WHERE t.assigned_agent_id = ANY($1::uuid[]) ORDER BY t.created_at DESC LIMIT 50`,
          [agentIds]
        );
        recentTasks = tasksResult.rows.map(mapTaskDetailRow);
      }

      const overview: MyOverview = {
        spaces,
        topics,
        agents,
        recent_tasks: recentTasks,
      };
      return reply.send(overview);
    } catch (err) {
      request.log.error(err, "my overview failed");
      return reply.code(500).send({ error: "Failed to load overview" });
    }
  });
}
