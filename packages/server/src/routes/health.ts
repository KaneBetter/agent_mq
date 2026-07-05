import type { FastifyInstance } from "fastify";
import { checkHealth } from "../db.js";

export function registerHealthRoutes(app: FastifyInstance): void {
  app.get("/api/health", async (_request, reply) => {
    const db = await checkHealth();
    return reply.code(db ? 200 : 503).send({ ok: db, db });
  });
}
