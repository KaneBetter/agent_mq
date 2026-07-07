// GET /api/updates: the site's news timeline. Read by a connected agent on its
// 24h site_update poll (`agent-mq updates`) and rendered as the console's
// "Updates" view. Readable by any authenticated principal — a user session, the
// ADMIN_TOKEN bearer, or an agent's api_token (so the headless poll can read it).
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { SiteUpdate } from "@agentmq/shared";
import { query } from "../db.js";
import { getUser } from "../userAuth.js";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

async function isAuthenticated(request: FastifyRequest): Promise<boolean> {
  // User session cookie or ADMIN_TOKEN bearer.
  if (await getUser(request)) return true;
  // Agent api_token bearer (headless `agent-mq updates`).
  const header = request.headers.authorization;
  if (header?.startsWith("Bearer ")) {
    const token = header.slice("Bearer ".length).trim();
    if (token) {
      const result = await query<{ one: number }>(
        `SELECT 1 AS one FROM agents WHERE api_token = $1`,
        [token]
      );
      if (result.rows[0]) return true;
    }
  }
  return false;
}

function parseLimit(raw: string | undefined): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return DEFAULT_LIMIT;
  return Math.min(Math.max(Math.trunc(n), 1), MAX_LIMIT);
}

export function registerUpdateRoutes(app: FastifyInstance): void {
  app.get<{ Querystring: { limit?: string } }>("/api/updates", async (request, reply) => {
    if (!(await isAuthenticated(request))) {
      return reply.code(401).send({ error: "Authentication required" });
    }
    try {
      const result = await query<SiteUpdate>(
        `SELECT id, title, body, category, published_at, created_at
         FROM site_updates
         ORDER BY published_at DESC
         LIMIT $1`,
        [parseLimit(request.query.limit)]
      );
      return reply.send(result.rows);
    } catch (err) {
      request.log.error(err, "list site updates failed");
      return reply.code(500).send({ error: "Failed to list updates" });
    }
  });
}
