// Bootstraps the Fastify server: registers CORS, mounts routes, starts the reaper.
import Fastify from "fastify";
import cors from "@fastify/cors";
import { env } from "./env.js";
import { startReaper, stopReaper } from "./reaper.js";
import { setActivitySink } from "./events.js";
import { persistActivity } from "./activity.js";
import { registerAgentRoutes } from "./routes/agents.js";
import { registerSubscriptionRoutes } from "./routes/subscriptions.js";
import { registerClaimRoutes } from "./routes/claim.js";
import { registerTaskLifecycleRoutes } from "./routes/taskLifecycle.js";
import { registerProjectRoutes } from "./routes/projects.js";
import { registerGroupRoutes } from "./routes/groups.js";
import { registerTaskTypeRoutes } from "./routes/taskTypes.js";
import { registerTaskRoutes } from "./routes/tasks.js";
import { registerDashboardRoutes } from "./routes/dashboard.js";
import { registerActivityRoutes } from "./routes/activity.js";
import { registerCalendarRoutes } from "./routes/calendar.js";
import { registerEventRoutes } from "./routes/events.js";
import { registerHealthRoutes } from "./routes/health.js";

async function main(): Promise<void> {
  const app = Fastify({ logger: true });

  await app.register(cors, { origin: true });

  // Wire the activity persistence sink now that the DB pool (imported by
  // activity.ts) is available. Fire-and-forget: never blocks a request.
  setActivitySink(persistActivity);

  registerAgentRoutes(app);
  registerSubscriptionRoutes(app);
  registerClaimRoutes(app);
  registerTaskLifecycleRoutes(app);
  registerProjectRoutes(app);
  registerGroupRoutes(app);
  registerTaskTypeRoutes(app);
  registerTaskRoutes(app);
  registerDashboardRoutes(app);
  registerActivityRoutes(app);
  registerCalendarRoutes(app);
  registerEventRoutes(app);
  registerHealthRoutes(app);

  app.setNotFoundHandler((request, reply) => {
    reply.code(404).send({ error: `Not found: ${request.method} ${request.url}` });
  });

  app.setErrorHandler((error, request, reply) => {
    request.log.error(error, "unhandled route error");
    reply.code(500).send({ error: "Internal server error" });
  });

  startReaper();

  const shutdown = async (): Promise<void> => {
    stopReaper();
    await app.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());

  await app.listen({ host: env.SERVER_HOST, port: env.SERVER_PORT });
}

main().catch((err) => {
  console.error("[server] fatal startup error", err);
  process.exit(1);
});
