// Self-service "apply to join a space" flow (lifecycle step 2).
//   POST   /api/spaces/:id/join-requests            — apply (any user)
//   GET    /api/spaces/:id/join-requests            — list (space admin)
//   POST   /api/spaces/:id/join-requests/:requestId — approve|deny (space admin)
//   GET    /api/me/join-requests                    — the caller's own requests
// Applying and approving grant membership only — they NEVER create a schedule
// task. (Agents get their poll schedules later, at register.)
import type { FastifyInstance } from "fastify";
import type {
  CreateJoinRequestRequest,
  DecideJoinRequestRequest,
  SpaceJoinRequest,
  SpaceRole,
} from "@agentmq/shared";
import { pool, query } from "../db.js";
import { requireUser } from "../userAuth.js";
import { canManage, canView, effectiveRole, fetchSpace } from "../spaces.js";

const VALID_ROLES: SpaceRole[] = ["admin", "member", "viewer"];

const REQUEST_SELECT = `
  SELECT
    r.id, r.space_id, sp.name AS space_name,
    r.user_id, u.username, u.display_name,
    r.status, r.message, r.created_at, r.decided_at,
    du.username AS decided_by_username
  FROM space_join_requests r
  JOIN spaces sp ON sp.id = r.space_id
  JOIN users u ON u.id = r.user_id
  LEFT JOIN users du ON du.id = r.decided_by
`;

type JoinRequestRow = SpaceJoinRequest;

export function registerJoinRequestRoutes(app: FastifyInstance): void {
  // Apply to join a space.
  app.post<{ Params: { id: string }; Body: CreateJoinRequestRequest }>(
    "/api/spaces/:id/join-requests",
    async (request, reply) => {
      const user = await requireUser(request, reply);
      if (!user) return;

      const space = await fetchSpace(request.params.id);
      // Only spaces the caller can already see are open to requests. For anything
      // else return the SAME 404 as a nonexistent space so neither the existence
      // nor the name of a team/private space leaks to a non-member.
      if (!space || (space.visibility !== "public" && !(await canView(space, user)))) {
        return reply.code(404).send({ error: "Space not found" });
      }
      if (await effectiveRole(space, user)) {
        return reply.code(409).send({ error: "You are already a member of this space" });
      }

      const message = typeof request.body?.message === "string" ? request.body.message.trim() : "";
      try {
        const inserted = await query<{ id: string }>(
          `INSERT INTO space_join_requests (space_id, user_id, message)
           VALUES ($1, $2, $3)
           ON CONFLICT (space_id, user_id) WHERE status = 'pending'
           DO UPDATE SET message = EXCLUDED.message
           RETURNING id`,
          [space.id, user.id, message]
        );
        const id = inserted.rows[0]?.id;
        const result = await query<JoinRequestRow>(`${REQUEST_SELECT} WHERE r.id = $1`, [id]);
        return reply.code(201).send(result.rows[0]);
      } catch (err) {
        request.log.error(err, "create join request failed");
        return reply.code(500).send({ error: "Failed to submit request" });
      }
    }
  );

  // List a space's join requests (admins only).
  app.get<{ Params: { id: string }; Querystring: { status?: string } }>(
    "/api/spaces/:id/join-requests",
    async (request, reply) => {
      const user = await requireUser(request, reply);
      if (!user) return;

      const space = await fetchSpace(request.params.id);
      if (!space) {
        return reply.code(404).send({ error: "Space not found" });
      }
      if (!(await canManage(space, user))) {
        return reply.code(403).send({ error: "Only the owner or an admin can view requests" });
      }

      const status = request.query.status;
      const params: unknown[] = [space.id];
      let clause = `WHERE r.space_id = $1`;
      if (status === "pending" || status === "approved" || status === "denied") {
        params.push(status);
        clause += ` AND r.status = $${params.length}`;
      }
      try {
        const result = await query<JoinRequestRow>(
          `${REQUEST_SELECT} ${clause} ORDER BY r.created_at DESC`,
          params
        );
        return reply.send(result.rows);
      } catch (err) {
        request.log.error(err, "list join requests failed");
        return reply.code(500).send({ error: "Failed to list requests" });
      }
    }
  );

  // Approve or deny a request (admins only).
  app.post<{ Params: { id: string; requestId: string }; Body: DecideJoinRequestRequest }>(
    "/api/spaces/:id/join-requests/:requestId",
    async (request, reply) => {
      const user = await requireUser(request, reply);
      if (!user) return;

      const space = await fetchSpace(request.params.id);
      if (!space) {
        return reply.code(404).send({ error: "Space not found" });
      }
      if (!(await canManage(space, user))) {
        return reply.code(403).send({ error: "Only the owner or an admin can decide requests" });
      }

      const decision = request.body?.decision;
      if (decision !== "approved" && decision !== "denied") {
        return reply.code(400).send({ error: "decision must be 'approved' or 'denied'" });
      }
      const role: SpaceRole =
        request.body?.role && VALID_ROLES.includes(request.body.role) ? request.body.role : "member";

      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const reqRow = await client.query<{ user_id: string; status: string }>(
          `SELECT user_id, status FROM space_join_requests
           WHERE id = $1 AND space_id = $2 FOR UPDATE`,
          [request.params.requestId, space.id]
        );
        const pending = reqRow.rows[0];
        if (!pending) {
          await client.query("ROLLBACK");
          return reply.code(404).send({ error: "Request not found" });
        }
        if (pending.status !== "pending") {
          await client.query("ROLLBACK");
          return reply.code(409).send({ error: `Request already ${pending.status}` });
        }

        await client.query(
          `UPDATE space_join_requests
           SET status = $1, decided_at = now(), decided_by = $2
           WHERE id = $3`,
          [decision, user.id, request.params.requestId]
        );
        if (decision === "approved") {
          await client.query(
            `INSERT INTO space_members (space_id, user_id, role)
             VALUES ($1, $2, $3)
             ON CONFLICT (space_id, user_id) DO UPDATE SET role = EXCLUDED.role`,
            [space.id, pending.user_id, role]
          );
        }
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK").catch(() => undefined);
        request.log.error(err, "decide join request failed");
        return reply.code(500).send({ error: "Failed to decide request" });
      } finally {
        client.release();
      }

      const result = await query<JoinRequestRow>(`${REQUEST_SELECT} WHERE r.id = $1`, [
        request.params.requestId,
      ]);
      return reply.send(result.rows[0]);
    }
  );

  // The caller's own requests, across spaces (for status in the lifecycle UI).
  app.get("/api/me/join-requests", async (request, reply) => {
    const user = await requireUser(request, reply);
    if (!user) return;
    try {
      const result = await query<JoinRequestRow>(
        `${REQUEST_SELECT} WHERE r.user_id = $1 ORDER BY r.created_at DESC`,
        [user.id]
      );
      return reply.send(result.rows);
    } catch (err) {
      request.log.error(err, "list my join requests failed");
      return reply.code(500).send({ error: "Failed to list requests" });
    }
  });
}
