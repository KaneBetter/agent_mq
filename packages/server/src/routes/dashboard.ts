import type { FastifyInstance } from "fastify";
import type { CostBreakdown, CostBucket, OverviewKPIs } from "@agentmq/shared";
import { query } from "../db.js";
import { requireUser } from "../userAuth.js";
import { visibleSpacesClause } from "../spaces.js";
import type { AuthedUser } from "../userAuth.js";

/** SQL subquery: project ids in spaces the caller can view. */
function visibleProjectsSubquery(user: AuthedUser): { sql: string; params: unknown[] } {
  const { clause, params } = visibleSpacesClause(user, 0);
  return {
    sql: `(SELECT p.id FROM projects p LEFT JOIN spaces sp ON sp.id = p.space_id WHERE ${clause})`,
    params,
  };
}

export function registerDashboardRoutes(app: FastifyInstance): void {
  app.get("/api/dashboard/overview", async (request, reply) => {
    const user = await requireUser(request, reply);
    if (!user) return;

    try {
      const { sql: projectsSql, params: projectsParams } = visibleProjectsSubquery(user);

      const agentsResult = await query<{ agents_online: string; agents_total: string }>(
        `SELECT
            count(*) FILTER (WHERE status = 'online') AS agents_online,
            count(*) AS agents_total
         FROM agents`
      );

      const tasksResult = await query<{
        tasks_pending: string;
        tasks_running: string;
        tasks_completed: string;
        tasks_dead: string;
      }>(
        `SELECT
            count(*) FILTER (WHERE status = 'PENDING') AS tasks_pending,
            count(*) FILTER (WHERE status IN ('CLAIMED','RUNNING')) AS tasks_running,
            count(*) FILTER (WHERE status = 'COMPLETED') AS tasks_completed,
            count(*) FILTER (WHERE status = 'DEAD') AS tasks_dead
         FROM tasks WHERE project_id IN ${projectsSql}`,
        projectsParams
      );

      const metricsResult = await query<{ total_tokens: string; total_cost_usd: number }>(
        `SELECT COALESCE(sum(total_tokens), 0) AS total_tokens, COALESCE(sum(cost_usd), 0) AS total_cost_usd
         FROM metrics WHERE project_id IN ${projectsSql}`,
        projectsParams
      );

      const agents = agentsResult.rows[0];
      const tasks = tasksResult.rows[0];
      const metrics = metricsResult.rows[0];

      const overview: OverviewKPIs = {
        agents_online: Number(agents?.agents_online ?? 0),
        agents_total: Number(agents?.agents_total ?? 0),
        tasks_pending: Number(tasks?.tasks_pending ?? 0),
        tasks_running: Number(tasks?.tasks_running ?? 0),
        tasks_completed: Number(tasks?.tasks_completed ?? 0),
        tasks_dead: Number(tasks?.tasks_dead ?? 0),
        total_tokens: Number(metrics?.total_tokens ?? 0),
        total_cost_usd: Number(metrics?.total_cost_usd ?? 0),
      };

      return reply.send(overview);
    } catch (err) {
      request.log.error(err, "dashboard overview failed");
      return reply.code(500).send({ error: "Failed to load overview" });
    }
  });

  app.get("/api/dashboard/costs", async (request, reply) => {
    const user = await requireUser(request, reply);
    if (!user) return;

    try {
      const { sql: projectsSql, params: projectsParams } = visibleProjectsSubquery(user);

      const byModel = await bucketQuery(
        `SELECT COALESCE(model, 'unknown') AS key,
                sum(input_tokens) AS input_tokens, sum(output_tokens) AS output_tokens,
                sum(total_tokens) AS total_tokens, sum(cost_usd) AS cost_usd, count(*) AS tasks
         FROM metrics WHERE project_id IN ${projectsSql}
         GROUP BY COALESCE(model, 'unknown') ORDER BY cost_usd DESC`,
        projectsParams
      );

      const byAgent = await bucketQuery(
        `SELECT COALESCE(a.name, 'unknown') AS key,
                sum(m.input_tokens) AS input_tokens, sum(m.output_tokens) AS output_tokens,
                sum(m.total_tokens) AS total_tokens, sum(m.cost_usd) AS cost_usd, count(*) AS tasks
         FROM metrics m LEFT JOIN agents a ON a.id = m.agent_id
         WHERE m.project_id IN ${projectsSql}
         GROUP BY COALESCE(a.name, 'unknown') ORDER BY cost_usd DESC`,
        projectsParams
      );

      const byProject = await bucketQuery(
        `SELECT COALESCE(p.name, 'unknown') AS key,
                sum(m.input_tokens) AS input_tokens, sum(m.output_tokens) AS output_tokens,
                sum(m.total_tokens) AS total_tokens, sum(m.cost_usd) AS cost_usd, count(*) AS tasks
         FROM metrics m LEFT JOIN projects p ON p.id = m.project_id
         WHERE m.project_id IN ${projectsSql}
         GROUP BY COALESCE(p.name, 'unknown') ORDER BY cost_usd DESC`,
        projectsParams
      );

      const byDay = await bucketQuery(
        `SELECT to_char(created_at, 'YYYY-MM-DD') AS key,
                sum(input_tokens) AS input_tokens, sum(output_tokens) AS output_tokens,
                sum(total_tokens) AS total_tokens, sum(cost_usd) AS cost_usd, count(*) AS tasks
         FROM metrics WHERE project_id IN ${projectsSql}
         GROUP BY to_char(created_at, 'YYYY-MM-DD') ORDER BY key DESC`,
        projectsParams
      );

      const anomalies = detectAnomalies(byAgent, "agent").concat(detectAnomalies(byDay, "day"));

      const breakdown: CostBreakdown = {
        by_model: byModel,
        by_agent: byAgent,
        by_project: byProject,
        by_day: byDay,
        anomalies,
      };

      return reply.send(breakdown);
    } catch (err) {
      request.log.error(err, "dashboard costs failed");
      return reply.code(500).send({ error: "Failed to load cost breakdown" });
    }
  });
}

interface BucketRow {
  key: string;
  input_tokens: string;
  output_tokens: string;
  total_tokens: string;
  cost_usd: number;
  tasks: string;
}

async function bucketQuery(sql: string, params: unknown[] = []): Promise<CostBucket[]> {
  const result = await query<BucketRow>(sql, params);
  return result.rows.map((row) => ({
    key: row.key,
    input_tokens: Number(row.input_tokens ?? 0),
    output_tokens: Number(row.output_tokens ?? 0),
    total_tokens: Number(row.total_tokens ?? 0),
    cost_usd: Number(row.cost_usd ?? 0),
    tasks: Number(row.tasks ?? 0),
  }));
}

/** Simple heuristic: flag any bucket whose cost is > 3x the median bucket cost. */
function detectAnomalies(buckets: CostBucket[], label: string): string[] {
  if (buckets.length < 2) return [];
  const costs = buckets.map((b) => b.cost_usd).sort((a, b) => a - b);
  const mid = Math.floor(costs.length / 2);
  const median = costs.length % 2 === 0 ? (costs[mid - 1] + costs[mid]) / 2 : costs[mid];
  if (!median || median <= 0) return [];

  const threshold = median * 3;
  return buckets
    .filter((b) => b.cost_usd > threshold)
    .map(
      (b) =>
        `${label} "${b.key}" spent $${b.cost_usd.toFixed(2)}, over 3x the median ($${median.toFixed(2)})`
    );
}
