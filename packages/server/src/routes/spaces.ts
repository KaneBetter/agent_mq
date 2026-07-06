// Spaces + members CRUD with RBAC. Spaces own topics + consumers.
import type { FastifyInstance } from "fastify";
import type {
  AddMemberRequest,
  CreateSpaceRequest,
  Space,
  SpaceDetail,
  SpaceMemberInfo,
  SpaceRole,
  SpaceSummary,
  SpaceVisibility,
  UpdateSpaceRequest,
} from "@agentmq/shared";
import { pool, query } from "../db.js";
import { requireUser } from "../userAuth.js";
import { canManage, canView, effectiveRole, fetchSpace, visibleSpacesClause } from "../spaces.js";

const VALID_VISIBILITIES: SpaceVisibility[] = ["private", "team", "public"];
const VALID_ROLES: SpaceRole[] = ["admin", "member", "viewer"];

/** POST /api/spaces only ever creates TEAM spaces — private is auto-created on
 * signup and public is the platform singleton; clients cannot request either. */
const CLIENT_CREATABLE_VISIBILITY: SpaceVisibility = "team";

function mapSpaceRow(row: {
  id: string;
  name: string;
  slug: string;
  visibility: SpaceVisibility;
  owner_id: string | null;
  created_at: string;
}): Space {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    visibility: row.visibility,
    owner_id: row.owner_id,
    created_at: row.created_at,
  };
}

function slugify(name: string): string {
  const base = name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return base.length > 0 ? base : "space";
}

async function uniqueSlug(name: string): Promise<string> {
  const base = slugify(name);
  let candidate = base;
  let suffix = 1;
  for (;;) {
    const existing = await query<{ id: string }>(`SELECT id FROM spaces WHERE slug = $1`, [
      candidate,
    ]);
    if (!existing.rows[0]) return candidate;
    suffix += 1;
    candidate = `${base}-${suffix}`;
  }
}

export function registerSpaceRoutes(app: FastifyInstance): void {
  app.post<{ Body: CreateSpaceRequest }>("/api/spaces", async (request, reply) => {
    const user = await requireUser(request, reply);
    if (!user) return;
    if (user.isAdmin) {
      return reply
        .code(400)
        .send({ error: "Create spaces with a real user session, not the admin token" });
    }

    const body = request.body ?? ({} as CreateSpaceRequest);
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (!name) {
      return reply.code(400).send({ error: "name is required" });
    }
    // Force team visibility regardless of what the client requested: private
    // spaces are auto-created on signup and public is a platform singleton.
    const visibility: SpaceVisibility = CLIENT_CREATABLE_VISIBILITY;

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const slug = await uniqueSlug(name);

      const spaceResult = await client.query<{
        id: string;
        name: string;
        slug: string;
        visibility: SpaceVisibility;
        owner_id: string | null;
        created_at: string;
      }>(
        `INSERT INTO spaces (name, slug, visibility, owner_id)
         VALUES ($1, $2, $3, $4)
         RETURNING id, name, slug, visibility, owner_id, created_at`,
        [name, slug, visibility, user.id]
      );
      const row = spaceResult.rows[0];
      if (!row) {
        await client.query("ROLLBACK");
        return reply.code(500).send({ error: "Failed to create space" });
      }

      await client.query(
        `INSERT INTO space_members (space_id, user_id, role) VALUES ($1, $2, 'admin')
         ON CONFLICT (space_id, user_id) DO NOTHING`,
        [row.id, user.id]
      );

      await client.query("COMMIT");

      const summary: SpaceSummary = {
        ...mapSpaceRow(row),
        owner_username: user.username,
        my_role: "admin",
        topic_count: 0,
        member_count: 1,
      };
      return reply.code(201).send(summary);
    } catch (err) {
      await client.query("ROLLBACK");
      request.log.error(err, "create space failed");
      return reply.code(500).send({ error: "Failed to create space" });
    } finally {
      client.release();
    }
  });

  app.get("/api/spaces", async (request, reply) => {
    const user = await requireUser(request, reply);
    if (!user) return;

    try {
      const { clause, params } = visibleSpacesClause(user, 0);
      const result = await query<{
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
         LEFT JOIN LATERAL (
           SELECT count(*) AS count FROM projects p WHERE p.space_id = sp.id
         ) tc ON true
         LEFT JOIN LATERAL (
           SELECT count(*) AS count FROM space_members m WHERE m.space_id = sp.id
         ) mc ON true
         WHERE ${clause}
         ORDER BY sp.created_at ASC`,
        params
      );

      const summaries: SpaceSummary[] = result.rows.map((row) => ({
        ...mapSpaceRow(row),
        owner_username: row.owner_username,
        my_role: row.my_role,
        topic_count: Number(row.topic_count ?? 0),
        member_count: Number(row.member_count ?? 0),
      }));

      return reply.send(summaries);
    } catch (err) {
      request.log.error(err, "list spaces failed");
      return reply.code(500).send({ error: "Failed to list spaces" });
    }
  });

  app.get<{ Params: { id: string } }>("/api/spaces/:id", async (request, reply) => {
    const user = await requireUser(request, reply);
    if (!user) return;

    const space = await fetchSpace(request.params.id);
    if (!space) {
      return reply.code(404).send({ error: "Space not found" });
    }
    if (!(await canView(space, user))) {
      return reply.code(403).send({ error: "Not authorized to view this space" });
    }

    try {
      const ownerResult = await query<{ username: string }>(
        `SELECT username FROM users WHERE id = $1`,
        [space.owner_id]
      );
      const membersResult = await query<{
        user_id: string;
        username: string;
        display_name: string;
        role: SpaceRole;
        created_at: string;
      }>(
        `SELECT sm.user_id, u.username, u.display_name, sm.role, sm.created_at
         FROM space_members sm
         JOIN users u ON u.id = sm.user_id
         WHERE sm.space_id = $1
         ORDER BY sm.created_at ASC`,
        [space.id]
      );
      const topicCountResult = await query<{ count: string }>(
        `SELECT count(*) AS count FROM projects WHERE space_id = $1`,
        [space.id]
      );

      const members: SpaceMemberInfo[] = membersResult.rows.map((r) => ({
        user_id: r.user_id,
        username: r.username,
        display_name: r.display_name,
        role: r.role,
        created_at: r.created_at,
      }));

      const myRole = user.isAdmin ? null : await effectiveRole(space, user);

      const detail: SpaceDetail = {
        ...mapSpaceRow(space),
        owner_username: ownerResult.rows[0]?.username ?? null,
        my_role: myRole,
        topic_count: Number(topicCountResult.rows[0]?.count ?? 0),
        member_count: members.length,
        members,
      };
      return reply.send(detail);
    } catch (err) {
      request.log.error(err, "get space failed");
      return reply.code(500).send({ error: "Failed to fetch space" });
    }
  });

  app.patch<{ Params: { id: string }; Body: UpdateSpaceRequest }>(
    "/api/spaces/:id",
    async (request, reply) => {
      const user = await requireUser(request, reply);
      if (!user) return;

      const space = await fetchSpace(request.params.id);
      if (!space) {
        return reply.code(404).send({ error: "Space not found" });
      }
      if (!(await canManage(space, user))) {
        return reply.code(403).send({ error: "Only the owner or an admin can manage this space" });
      }

      const body = request.body ?? ({} as UpdateSpaceRequest);
      const updates: string[] = [];
      const params: unknown[] = [];

      if (typeof body.name === "string" && body.name.trim()) {
        params.push(body.name.trim());
        updates.push(`name = $${params.length}`);
      }
      if (body.visibility && VALID_VISIBILITIES.includes(body.visibility)) {
        params.push(body.visibility);
        updates.push(`visibility = $${params.length}`);
      }

      if (updates.length === 0) {
        return reply.code(400).send({ error: "No valid fields to update" });
      }

      params.push(space.id);
      try {
        const result = await query<{
          id: string;
          name: string;
          slug: string;
          visibility: SpaceVisibility;
          owner_id: string | null;
          created_at: string;
        }>(
          `UPDATE spaces SET ${updates.join(", ")} WHERE id = $${params.length}
           RETURNING id, name, slug, visibility, owner_id, created_at`,
          params
        );
        const row = result.rows[0];
        if (!row) {
          return reply.code(404).send({ error: "Space not found" });
        }
        return reply.send(mapSpaceRow(row));
      } catch (err) {
        request.log.error(err, "update space failed");
        return reply.code(500).send({ error: "Failed to update space" });
      }
    }
  );

  app.delete<{ Params: { id: string } }>("/api/spaces/:id", async (request, reply) => {
    const user = await requireUser(request, reply);
    if (!user) return;

    const space = await fetchSpace(request.params.id);
    if (!space) {
      return reply.code(404).send({ error: "Space not found" });
    }
    if (!user.isAdmin && space.owner_id !== user.id) {
      return reply.code(403).send({ error: "Only the owner can delete this space" });
    }

    try {
      await query(`DELETE FROM spaces WHERE id = $1`, [space.id]);
      return reply.send({ ok: true });
    } catch (err) {
      request.log.error(err, "delete space failed");
      return reply.code(500).send({ error: "Failed to delete space" });
    }
  });

  // ── Members ────────────────────────────────────────────────────────────
  app.get<{ Params: { id: string } }>("/api/spaces/:id/members", async (request, reply) => {
    const user = await requireUser(request, reply);
    if (!user) return;

    const space = await fetchSpace(request.params.id);
    if (!space) {
      return reply.code(404).send({ error: "Space not found" });
    }
    if (!(await canView(space, user))) {
      return reply.code(403).send({ error: "Not authorized to view this space" });
    }

    try {
      const result = await query<{
        user_id: string;
        username: string;
        display_name: string;
        role: SpaceRole;
        created_at: string;
      }>(
        `SELECT sm.user_id, u.username, u.display_name, sm.role, sm.created_at
         FROM space_members sm
         JOIN users u ON u.id = sm.user_id
         WHERE sm.space_id = $1
         ORDER BY sm.created_at ASC`,
        [space.id]
      );
      const members: SpaceMemberInfo[] = result.rows.map((r) => ({
        user_id: r.user_id,
        username: r.username,
        display_name: r.display_name,
        role: r.role,
        created_at: r.created_at,
      }));
      return reply.send(members);
    } catch (err) {
      request.log.error(err, "list members failed");
      return reply.code(500).send({ error: "Failed to list members" });
    }
  });

  app.post<{ Params: { id: string }; Body: AddMemberRequest }>(
    "/api/spaces/:id/members",
    async (request, reply) => {
      const user = await requireUser(request, reply);
      if (!user) return;

      const space = await fetchSpace(request.params.id);
      if (!space) {
        return reply.code(404).send({ error: "Space not found" });
      }
      if (!(await canManage(space, user))) {
        return reply.code(403).send({ error: "Only the owner or an admin can manage members" });
      }

      const body = request.body ?? ({} as AddMemberRequest);
      const username = typeof body.username === "string" ? body.username.trim() : "";
      if (!username) {
        return reply.code(400).send({ error: "username is required" });
      }
      const role: SpaceRole = body.role && VALID_ROLES.includes(body.role) ? body.role : "member";

      try {
        const userResult = await query<{ id: string }>(`SELECT id FROM users WHERE username = $1`, [
          username,
        ]);
        const targetUserId = userResult.rows[0]?.id;
        if (!targetUserId) {
          return reply.code(404).send({ error: "User not found" });
        }

        const result = await query<{
          user_id: string;
          role: SpaceRole;
          created_at: string;
        }>(
          `INSERT INTO space_members (space_id, user_id, role)
           VALUES ($1, $2, $3)
           ON CONFLICT (space_id, user_id) DO UPDATE SET role = EXCLUDED.role
           RETURNING user_id, role, created_at`,
          [space.id, targetUserId, role]
        );
        const row = result.rows[0];
        if (!row) {
          return reply.code(500).send({ error: "Failed to add member" });
        }

        const member: SpaceMemberInfo = {
          user_id: row.user_id,
          username,
          display_name: username,
          role: row.role,
          created_at: row.created_at,
        };
        return reply.code(201).send(member);
      } catch (err) {
        request.log.error(err, "add member failed");
        return reply.code(500).send({ error: "Failed to add member" });
      }
    }
  );

  app.patch<{ Params: { id: string; userId: string }; Body: { role?: SpaceRole } }>(
    "/api/spaces/:id/members/:userId",
    async (request, reply) => {
      const user = await requireUser(request, reply);
      if (!user) return;

      const space = await fetchSpace(request.params.id);
      if (!space) {
        return reply.code(404).send({ error: "Space not found" });
      }
      if (!(await canManage(space, user))) {
        return reply.code(403).send({ error: "Only the owner or an admin can manage members" });
      }

      const role = request.body?.role;
      if (!role || !VALID_ROLES.includes(role)) {
        return reply.code(400).send({ error: `role must be one of ${VALID_ROLES.join(", ")}` });
      }

      try {
        const result = await query<{
          user_id: string;
          role: SpaceRole;
          created_at: string;
        }>(
          `UPDATE space_members SET role = $1 WHERE space_id = $2 AND user_id = $3
           RETURNING user_id, role, created_at`,
          [role, space.id, request.params.userId]
        );
        const row = result.rows[0];
        if (!row) {
          return reply.code(404).send({ error: "Member not found" });
        }
        return reply.send(row);
      } catch (err) {
        request.log.error(err, "update member failed");
        return reply.code(500).send({ error: "Failed to update member" });
      }
    }
  );

  app.delete<{ Params: { id: string; userId: string } }>(
    "/api/spaces/:id/members/:userId",
    async (request, reply) => {
      const user = await requireUser(request, reply);
      if (!user) return;

      const space = await fetchSpace(request.params.id);
      if (!space) {
        return reply.code(404).send({ error: "Space not found" });
      }
      if (!(await canManage(space, user))) {
        return reply.code(403).send({ error: "Only the owner or an admin can manage members" });
      }

      try {
        await query(`DELETE FROM space_members WHERE space_id = $1 AND user_id = $2`, [
          space.id,
          request.params.userId,
        ]);
        return reply.send({ ok: true });
      } catch (err) {
        request.log.error(err, "remove member failed");
        return reply.code(500).send({ error: "Failed to remove member" });
      }
    }
  );
}
