import type { FastifyInstance } from "fastify";
import { handleSseRequest } from "../events.js";

export function registerEventRoutes(app: FastifyInstance): void {
  app.get("/api/events", (request, reply) => {
    handleSseRequest(request, reply);
  });
}
