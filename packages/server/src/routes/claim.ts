import type { FastifyInstance } from "fastify";
import type { ClaimRequest, ClaimResponse } from "@agentmq/shared";
import { claimTask } from "../claim.js";
import { requireAgent } from "../auth.js";
import { emitEvent } from "../events.js";

export function registerClaimRoutes(app: FastifyInstance): void {
  app.post<{ Body: ClaimRequest }>("/api/claim", async (request, reply) => {
    const agent = await requireAgent(request, reply);
    if (!agent) return;

    try {
      const task = await claimTask(agent);
      if (task) {
        emitEvent({
          type: "task.claimed",
          task_id: task.id,
          task_type: task.type,
          project_id: task.project_id,
          project_name: task.project_name,
          agent_id: agent.id,
          agent_name: agent.name,
          status: task.status,
        });
      }
      const response: ClaimResponse = { task };
      return reply.code(200).send(response);
    } catch (err) {
      request.log.error(err, "claim failed");
      return reply.code(500).send({ error: "Failed to claim task" });
    }
  });
}
