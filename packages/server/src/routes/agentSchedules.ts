// GET /api/agent-schedules?project_id=&agent_id= — agent polling cadences.
import type { FastifyInstance } from "fastify";
import { query } from "../db.js";
import { AGENT_SCHEDULE_SELECT, mapAgentScheduleRow, type AgentScheduleRow } from "../rowMappers.js";

export function registerAgentScheduleRoutes(app: FastifyInstance): void {
  app.get<{ Querystring: { project_id?: string; agent_id?: string } }>(
    "/api/agent-schedules",
    async (request, reply) => {
      const { project_id: projectId, agent_id: agentId } = request.query;

      const conditions: string[] = [];
      const params: unknown[] = [];

      if (projectId) {
        params.push(projectId);
        conditions.push(`ags.project_id = $${params.length}`);
      }
      if (agentId) {
        params.push(agentId);
        conditions.push(`ags.agent_id = $${params.length}`);
      }

      const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

      try {
        const result = await query<AgentScheduleRow>(
          `${AGENT_SCHEDULE_SELECT} ${whereClause} ORDER BY ags.created_at ASC`,
          params
        );
        return reply.send(result.rows.map(mapAgentScheduleRow));
      } catch (err) {
        request.log.error(err, "list agent schedules failed");
        return reply.code(500).send({ error: "Failed to list agent schedules" });
      }
    }
  );
}
