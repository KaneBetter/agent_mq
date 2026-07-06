// Space RBAC helpers: resolve a caller's effective role in a space and answer
// the view/produce/manage questions used across projects/tasks/activity/etc.
import type { PoolClient } from "pg";
import type { SpaceRole, SpaceVisibility } from "@agentmq/shared";
import { pool, query } from "./db.js";
import type { AuthedUser } from "./userAuth.js";

export interface SpaceRow {
  id: string;
  name: string;
  slug: string;
  visibility: SpaceVisibility;
  owner_id: string | null;
  created_at: string;
}

/** Fetches a space's visibility/owner, or null when it doesn't exist. */
export async function fetchSpace(spaceId: string): Promise<SpaceRow | null> {
  const result = await query<SpaceRow>(
    `SELECT id, name, slug, visibility, owner_id, created_at FROM spaces WHERE id = $1`,
    [spaceId]
  );
  return result.rows[0] ?? null;
}

/** The caller's membership role in a space, or null if not a member. */
export async function fetchMemberRole(
  spaceId: string,
  userId: string
): Promise<SpaceRole | null> {
  const result = await query<{ role: SpaceRole }>(
    `SELECT role FROM space_members WHERE space_id = $1 AND user_id = $2`,
    [spaceId, userId]
  );
  return result.rows[0]?.role ?? null;
}

/** Effective role: owner acts as admin even without an explicit member row. */
export async function effectiveRole(
  space: SpaceRow,
  user: AuthedUser
): Promise<SpaceRole | null> {
  if (space.owner_id === user.id) return "admin";
  return fetchMemberRole(space.id, user.id);
}

/** view = member (any role) OR space is public. Admin bearer always can. */
export async function canView(space: SpaceRow, user: AuthedUser): Promise<boolean> {
  if (user.isAdmin) return true;
  if (space.visibility === "public") return true;
  const role = await effectiveRole(space, user);
  return role !== null;
}

/** produce / create-topic / register-consumer = member with admin|member role. */
export async function canProduce(space: SpaceRow, user: AuthedUser): Promise<boolean> {
  if (user.isAdmin) return true;
  const role = await effectiveRole(space, user);
  return role === "admin" || role === "member";
}

/** manage space + members + visibility = owner or admin. */
export async function canManage(space: SpaceRow, user: AuthedUser): Promise<boolean> {
  if (user.isAdmin) return true;
  const role = await effectiveRole(space, user);
  return role === "admin";
}

/**
 * SQL fragment + params for "spaces this user can view": member-of OR public.
 * Admin bearer sees everything (returns a fragment that's always true).
 * Use as: `AND (${clause})` with the returned params appended to your query.
 */
export function visibleSpacesClause(
  user: AuthedUser,
  paramOffset: number
): { clause: string; params: unknown[] } {
  if (user.isAdmin) {
    return { clause: "TRUE", params: [] };
  }
  const userIdParam = paramOffset + 1;
  return {
    clause: `(sp.visibility = 'public' OR EXISTS (
      SELECT 1 FROM space_members sm WHERE sm.space_id = sp.id AND sm.user_id = $${userIdParam}
    ) OR sp.owner_id = $${userIdParam})`,
    params: [user.id],
  };
}

// ── v6: default private/public spaces ──────────────────────────────────────
const PUBLIC_SPACE_NAME = "Public";
const PUBLIC_SPACE_SLUG = "public";

function slugify(name: string): string {
  const base = name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return base.length > 0 ? base : "space";
}

async function uniqueSlug(
  client: PoolClient | typeof pool,
  name: string
): Promise<string> {
  const base = slugify(name);
  let candidate = base;
  let suffix = 1;
  for (;;) {
    const existing = await client.query<{ id: string }>(
      `SELECT id FROM spaces WHERE slug = $1`,
      [candidate]
    );
    if (!existing.rows[0]) return candidate;
    suffix += 1;
    candidate = `${base}-${suffix}`;
  }
}

/**
 * Ensures exactly ONE public space exists (name "Public", owner NULL). Safe to
 * call repeatedly (pre-check + the partial unique index `spaces_single_public_uidx`
 * guards against a race creating a second one). Returns its id.
 */
export async function ensurePublicSpace(
  client: PoolClient | typeof pool = pool
): Promise<string> {
  const existing = await client.query<{ id: string }>(
    `SELECT id FROM spaces WHERE visibility = 'public' LIMIT 1`
  );
  if (existing.rows[0]) {
    return existing.rows[0].id;
  }

  try {
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO spaces (name, slug, visibility, owner_id)
       VALUES ($1, $2, 'public', NULL)
       RETURNING id`,
      [PUBLIC_SPACE_NAME, PUBLIC_SPACE_SLUG]
    );
    const id = inserted.rows[0]?.id;
    if (id) return id;
  } catch (err) {
    // Another concurrent caller won the race against spaces_single_public_uidx.
    if (!(err instanceof Error && "code" in err && (err as { code?: string }).code === "23505")) {
      throw err;
    }
  }

  const recheck = await client.query<{ id: string }>(
    `SELECT id FROM spaces WHERE visibility = 'public' LIMIT 1`
  );
  const id = recheck.rows[0]?.id;
  if (!id) {
    throw new Error("Failed to ensure public space");
  }
  return id;
}

/**
 * Ensures the user has exactly one private space, creating
 * `"<display_name>'s space"` (owner=user, them as admin member) if absent.
 * Idempotent: if the user already owns a private space, returns its id as-is.
 */
export async function ensurePrivateSpace(
  client: PoolClient | typeof pool,
  userId: string,
  displayName: string
): Promise<string> {
  const existing = await client.query<{ id: string }>(
    `SELECT id FROM spaces WHERE owner_id = $1 AND visibility = 'private' LIMIT 1`,
    [userId]
  );
  if (existing.rows[0]) {
    return existing.rows[0].id;
  }

  const name = `${displayName}'s space`;
  const slug = await uniqueSlug(client, name);
  const inserted = await client.query<{ id: string }>(
    `INSERT INTO spaces (name, slug, visibility, owner_id)
     VALUES ($1, $2, 'private', $3)
     RETURNING id`,
    [name, slug, userId]
  );
  const spaceId = inserted.rows[0]?.id;
  if (!spaceId) {
    throw new Error("Failed to create private space");
  }

  await client.query(
    `INSERT INTO space_members (space_id, user_id, role) VALUES ($1, $2, 'admin')
     ON CONFLICT (space_id, user_id) DO NOTHING`,
    [spaceId, userId]
  );

  return spaceId;
}
