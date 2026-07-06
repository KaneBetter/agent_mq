// Agent auth: resolve the calling agent from `Authorization: Bearer <api_token>`.
// Management/UI routes are open in dev per the contract; this module is only
// consulted by agent-facing routes.
import type { FastifyReply, FastifyRequest } from "fastify";
import type { Agent } from "@agentmq/shared";
import { query } from "./db.js";

export interface AuthedAgent {
  id: string;
  name: string;
  owner: string;
  machine_info: Record<string, unknown>;
  capabilities: string[];
  max_concurrency: number;
  status: Agent["status"];
  paused: boolean;
  last_heartbeat_at: string | null;
  created_at: string;
  api_token: string;
}

function extractBearerToken(request: FastifyRequest): string | null {
  const header = request.headers.authorization;
  if (!header || !header.startsWith("Bearer ")) return null;
  const token = header.slice("Bearer ".length).trim();
  return token.length > 0 ? token : null;
}

/**
 * Resolves the agent for the request's Bearer token. On failure, sends the
 * appropriate 401 JSON response and returns null — callers must check for null
 * and return immediately without sending another response.
 */
export async function requireAgent(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<AuthedAgent | null> {
  const token = extractBearerToken(request);
  if (!token) {
    reply.code(401).send({ error: "Missing Authorization: Bearer <api_token>" });
    return null;
  }

  const result = await query<AuthedAgent>(
    `SELECT id, name, owner, machine_info, capabilities, max_concurrency,
            status, paused, last_heartbeat_at, created_at, api_token
     FROM agents WHERE api_token = $1`,
    [token]
  );

  const agent = result.rows[0];
  if (!agent) {
    reply.code(401).send({ error: "Invalid api_token" });
    return null;
  }

  return agent;
}
