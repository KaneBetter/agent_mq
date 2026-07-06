// Local-account auth: scrypt password hashing, opaque session tokens, manual
// httpOnly cookie handling (no cookie-parser dep), and getUser() middleware
// that also accepts the ADMIN_TOKEN bearer as a superuser bypass.
import crypto from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { User } from "@agentmq/shared";
import { query } from "./db.js";
import { env } from "./env.js";

export const SESSION_COOKIE_NAME = "mq_session";
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const SCRYPT_KEYLEN = 64;

/** A resolved caller: either a real user (cookie/session) or the admin bypass. */
export interface AuthedUser {
  id: string;
  username: string;
  email: string | null;
  display_name: string;
  created_at: string;
  /** True when resolved via the ADMIN_TOKEN bearer rather than a real session. */
  isAdmin: boolean;
}

export function toUserDTO(user: AuthedUser): User {
  return {
    id: user.id,
    username: user.username,
    email: user.email,
    display_name: user.display_name,
    created_at: user.created_at,
  };
}

// ── Password hashing: scrypt with a random salt, stored as "salt:hex" ──────
export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16).toString("hex");
  const derived = crypto.scryptSync(password, salt, SCRYPT_KEYLEN);
  return `${salt}:${derived.toString("hex")}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [salt, hashHex] = stored.split(":");
  if (!salt || !hashHex) return false;
  const derived = crypto.scryptSync(password, salt, SCRYPT_KEYLEN);
  const expected = Buffer.from(hashHex, "hex");
  if (derived.length !== expected.length) return false;
  return crypto.timingSafeEqual(derived, expected);
}

// ── Session tokens ──────────────────────────────────────────────────────────
export function generateSessionToken(): string {
  return crypto.randomBytes(32).toString("hex");
}

export async function createSession(userId: string): Promise<{ token: string; expiresAt: Date }> {
  const token = generateSessionToken();
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  await query(`INSERT INTO sessions (token, user_id, expires_at) VALUES ($1, $2, $3)`, [
    token,
    userId,
    expiresAt.toISOString(),
  ]);
  return { token, expiresAt };
}

export async function deleteSession(token: string): Promise<void> {
  await query(`DELETE FROM sessions WHERE token = $1`, [token]);
}

// ── Cookie handling (manual — no @fastify/cookie dependency) ──────────────
function parseCookies(header: string | undefined): Record<string, string> {
  const cookies: Record<string, string> = {};
  if (!header) return cookies;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    const key = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (key) cookies[key] = decodeURIComponent(value);
  }
  return cookies;
}

export function readSessionCookie(request: FastifyRequest): string | null {
  const cookies = parseCookies(request.headers.cookie);
  return cookies[SESSION_COOKIE_NAME] ?? null;
}

export function setSessionCookie(reply: FastifyReply, token: string, expiresAt: Date): void {
  const maxAgeSeconds = Math.max(0, Math.floor((expiresAt.getTime() - Date.now()) / 1000));
  reply.header(
    "Set-Cookie",
    `${SESSION_COOKIE_NAME}=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAgeSeconds}`
  );
}

export function clearSessionCookie(reply: FastifyReply): void {
  reply.header(
    "Set-Cookie",
    `${SESSION_COOKIE_NAME}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`
  );
}

// ── getUser(request): resolve from cookie session OR ADMIN_TOKEN bearer ───
interface SessionRow {
  user_id: string;
  expires_at: string;
  username: string;
  email: string | null;
  display_name: string;
  created_at: string;
}

function extractBearerToken(request: FastifyRequest): string | null {
  const header = request.headers.authorization;
  if (!header || !header.startsWith("Bearer ")) return null;
  const token = header.slice("Bearer ".length).trim();
  return token.length > 0 ? token : null;
}

/**
 * Resolves the calling user from the `mq_session` cookie, or from the
 * ADMIN_TOKEN bearer as a superuser bypass (for scripts/demo/feeder). Returns
 * null when neither is present/valid — callers decide whether that's fatal.
 */
export async function getUser(request: FastifyRequest): Promise<AuthedUser | null> {
  const bearer = extractBearerToken(request);
  if (bearer && env.ADMIN_TOKEN && bearer === env.ADMIN_TOKEN) {
    return {
      id: "admin",
      username: "admin",
      email: null,
      display_name: "Admin",
      created_at: new Date(0).toISOString(),
      isAdmin: true,
    };
  }

  const token = readSessionCookie(request);
  if (!token) return null;

  const result = await query<SessionRow>(
    `SELECT s.user_id, s.expires_at, u.username, u.email, u.display_name, u.created_at
     FROM sessions s
     JOIN users u ON u.id = s.user_id
     WHERE s.token = $1`,
    [token]
  );
  const row = result.rows[0];
  if (!row) return null;
  if (new Date(row.expires_at).getTime() < Date.now()) {
    await deleteSession(token);
    return null;
  }

  return {
    id: row.user_id,
    username: row.username,
    email: row.email,
    display_name: row.display_name,
    created_at: row.created_at,
    isAdmin: false,
  };
}

/**
 * Resolves the user or sends 401 and returns null. Callers must check for
 * null and return immediately without sending another response.
 */
export async function requireUser(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<AuthedUser | null> {
  const user = await getUser(request);
  if (!user) {
    reply.code(401).send({ error: "Authentication required" });
    return null;
  }
  return user;
}
