// Space RBAC helpers: resolve a caller's effective role in a space and answer
// the view/produce/manage questions used across projects/tasks/activity/etc.
import type { SpaceRole, SpaceVisibility } from "@agentmq/shared";
import { query } from "./db.js";
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
