// User auth: register/login/logout/me. Sessions are httpOnly cookies.
import type { FastifyInstance } from "fastify";
import type { AuthResponse, LoginRequest, RegisterUserRequest, User } from "@agentmq/shared";
import { pool, query } from "../db.js";
import { ensurePrivateSpace } from "../spaces.js";
import {
  createSession,
  clearSessionCookie,
  deleteSession,
  getUser,
  hashPassword,
  readSessionCookie,
  setSessionCookie,
  toUserDTO,
  verifyPassword,
} from "../userAuth.js";

interface UserRow {
  id: string;
  username: string;
  email: string | null;
  password_hash: string;
  display_name: string;
  created_at: string;
}

function mapUserRow(row: UserRow): User {
  return {
    id: row.id,
    username: row.username,
    email: row.email,
    display_name: row.display_name,
    created_at: row.created_at,
  };
}

export function registerAuthRoutes(app: FastifyInstance): void {
  app.post<{ Body: RegisterUserRequest }>("/api/auth/register", async (request, reply) => {
    const body = request.body ?? ({} as RegisterUserRequest);
    const username = typeof body.username === "string" ? body.username.trim() : "";
    const password = typeof body.password === "string" ? body.password : "";
    const email = typeof body.email === "string" && body.email.trim() ? body.email.trim() : null;
    const displayName =
      typeof body.display_name === "string" && body.display_name.trim().length > 0
        ? body.display_name.trim()
        : username;

    if (!username || username.length < 3) {
      return reply.code(400).send({ error: "username must be at least 3 characters" });
    }
    if (!password || password.length < 4) {
      return reply.code(400).send({ error: "password must be at least 4 characters" });
    }

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const passwordHash = hashPassword(password);
      const result = await client.query<UserRow>(
        `INSERT INTO users (username, email, password_hash, display_name)
         VALUES ($1, $2, $3, $4)
         RETURNING id, username, email, password_hash, display_name, created_at`,
        [username, email, passwordHash, displayName]
      );
      const row = result.rows[0];
      if (!row) {
        await client.query("ROLLBACK");
        return reply.code(500).send({ error: "Failed to create user" });
      }
      const user = mapUserRow(row);

      // Auto-create the user's one private space (idempotent: no-op if they
      // somehow already own one — can't happen on fresh signup, but safe).
      await ensurePrivateSpace(client, user.id, user.display_name || user.username);

      await client.query("COMMIT");

      const { token, expiresAt } = await createSession(user.id);
      setSessionCookie(reply, token, expiresAt);

      const response: AuthResponse = { user };
      return reply.code(201).send(response);
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      if (err instanceof Error && "code" in err && (err as { code?: string }).code === "23505") {
        return reply.code(409).send({ error: "Username already taken" });
      }
      request.log.error(err, "register failed");
      return reply.code(500).send({ error: "Failed to register" });
    } finally {
      client.release();
    }
  });

  app.post<{ Body: LoginRequest }>("/api/auth/login", async (request, reply) => {
    const body = request.body ?? ({} as LoginRequest);
    const username = typeof body.username === "string" ? body.username.trim() : "";
    const password = typeof body.password === "string" ? body.password : "";

    if (!username || !password) {
      return reply.code(400).send({ error: "username and password are required" });
    }

    try {
      const result = await query<UserRow>(
        `SELECT id, username, email, password_hash, display_name, created_at
         FROM users WHERE username = $1`,
        [username]
      );
      const row = result.rows[0];
      if (!row || !verifyPassword(password, row.password_hash)) {
        return reply.code(401).send({ error: "Invalid username or password" });
      }

      const user = mapUserRow(row);
      const { token, expiresAt } = await createSession(user.id);
      setSessionCookie(reply, token, expiresAt);

      const response: AuthResponse = { user };
      return reply.send(response);
    } catch (err) {
      request.log.error(err, "login failed");
      return reply.code(500).send({ error: "Failed to log in" });
    }
  });

  app.post("/api/auth/logout", async (request, reply) => {
    const token = readSessionCookie(request);
    if (token) {
      await deleteSession(token);
    }
    clearSessionCookie(reply);
    return reply.send({ ok: true });
  });

  app.get("/api/auth/me", async (request, reply) => {
    const user = await getUser(request);
    if (!user || user.isAdmin) {
      // Admin bearer bypass has no real "me" user record to show.
      return reply.code(401).send({ error: "Not authenticated" });
    }
    const response: AuthResponse = { user: toUserDTO(user) };
    return reply.send(response);
  });
}
