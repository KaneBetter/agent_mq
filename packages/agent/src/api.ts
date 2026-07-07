// Thin typed client over fetch for the agent-mq server API.
// Uses API_ROUTES from @agentmq/shared so paths never drift from the contract.
import {
  API_ROUTES,
  type AuthResponse,
  type ClaimResponse,
  type CompleteTaskRequest,
  type CompleteTaskResponse,
  type HeartbeatResponse,
  type LoginRequest,
  type ProjectSummary,
  type RegisterAgentRequest,
  type RegisterAgentResponse,
  type SiteUpdate,
  type SpaceSummary,
  type SubscribeRequest,
  type Subscription,
  type TaskHeartbeatResponse,
} from "@agentmq/shared";

/** Thrown for any non-2xx response. Carries the HTTP status for callers that need to branch (e.g. 409 lease-lost). */
export class ApiError extends Error {
  readonly status: number;
  readonly body: unknown;

  constructor(status: number, message: string, body: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.body = body;
  }
}

export interface ApiClientOptions {
  server: string;
  apiToken?: string;
  /** The `mq_session` cookie value for a logged-in user (management calls: register/subscribe/spaces). */
  sessionToken?: string;
}

/** The `mq_session=<token>` cookie name used by the server (see BUILD-CONTRACT.md v5 auth). */
const SESSION_COOKIE_NAME = "mq_session";

async function parseBody(res: Response): Promise<unknown> {
  const text = await res.text();
  if (text.length === 0) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function errorMessageFrom(body: unknown, status: number, statusText: string): string {
  if (body && typeof body === "object" && "error" in body) {
    const err = (body as { error?: unknown }).error;
    if (typeof err === "string" && err.trim() !== "") return err;
  }
  return `HTTP ${status} ${statusText}`;
}

/**
 * Minimal typed wrapper over fetch. Attaches the Bearer agent token for
 * agent-facing calls (claim/heartbeat/complete) and the `mq_session` cookie
 * for user/management calls (register/subscribe/spaces). Throws ApiError on
 * non-2xx.
 */
export class ApiClient {
  readonly server: string;
  private apiToken: string | undefined;
  private sessionToken: string | undefined;

  constructor(options: ApiClientOptions) {
    this.server = options.server.replace(/\/+$/, "");
    this.apiToken = options.apiToken;
    this.sessionToken = options.sessionToken;
  }

  setToken(token: string | undefined): void {
    this.apiToken = token;
  }

  setSessionToken(token: string | undefined): void {
    this.sessionToken = token;
  }

  private async request<T>(
    method: "GET" | "POST" | "PATCH" | "DELETE",
    path: string,
    options: { body?: unknown; auth?: boolean; session?: boolean } = {},
  ): Promise<T> {
    const { body, auth = false, session = false } = options;
    const headers: Record<string, string> = {};
    if (body !== undefined) headers["content-type"] = "application/json";
    if (auth) {
      if (!this.apiToken) {
        throw new Error(
          "No api_token available for authenticated request; run `agent-mq register` first.",
        );
      }
      headers.authorization = `Bearer ${this.apiToken}`;
    }
    if (session) {
      if (!this.sessionToken) {
        throw new Error("Not logged in; run `agent-mq login` first.");
      }
      headers.cookie = `${SESSION_COOKIE_NAME}=${this.sessionToken}`;
    }

    let res: Response;
    try {
      res = await fetch(`${this.server}${path}`, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`Network error calling ${method} ${path}: ${message}`);
    }

    if (res.status === 204) {
      return null as T;
    }

    const parsed = await parseBody(res);
    if (!res.ok) {
      throw new ApiError(
        res.status,
        errorMessageFrom(parsed, res.status, res.statusText),
        parsed,
      );
    }
    return parsed as T;
  }

  /**
   * Raw login call: unlike `request`, we need the response headers (Set-Cookie)
   * rather than just the parsed body, so this bypasses the shared `request` helper.
   */
  async login(req: LoginRequest): Promise<{ auth: AuthResponse; sessionToken: string }> {
    let res: Response;
    try {
      res = await fetch(`${this.server}${API_ROUTES.authLogin}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(req),
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`Network error calling POST ${API_ROUTES.authLogin}: ${message}`);
    }

    const parsed = await parseBody(res);
    if (!res.ok) {
      throw new ApiError(res.status, errorMessageFrom(parsed, res.status, res.statusText), parsed);
    }

    const sessionToken = extractSessionCookie(res);
    if (!sessionToken) {
      throw new Error(
        `Login succeeded but no ${SESSION_COOKIE_NAME} cookie was found in the response`,
      );
    }
    return { auth: parsed as AuthResponse, sessionToken };
  }

  // ── Agent-facing (Bearer token: claim/heartbeat/complete) ────────────────

  agentHeartbeat(): Promise<HeartbeatResponse> {
    return this.request<HeartbeatResponse>("POST", API_ROUTES.agentHeartbeat, {
      auth: true,
      body: {},
    });
  }

  claim(): Promise<ClaimResponse> {
    return this.request<ClaimResponse>("POST", API_ROUTES.claim, {
      auth: true,
      body: {},
    }).then((res) => res ?? { task: null });
  }

  taskHeartbeat(taskId: string): Promise<TaskHeartbeatResponse> {
    return this.request<TaskHeartbeatResponse>(
      "POST",
      API_ROUTES.taskHeartbeat(taskId),
      { auth: true, body: {} },
    );
  }

  complete(
    taskId: string,
    req: CompleteTaskRequest,
  ): Promise<CompleteTaskResponse> {
    return this.request<CompleteTaskResponse>(
      "POST",
      API_ROUTES.complete(taskId),
      { auth: true, body: req },
    );
  }

  /**
   * POST /api/subscriptions is still Bearer-agent-authenticated server-side
   * (unchanged by the v5/v6 auth work), so this stays on the agent token
   * rather than the user session, unlike register/spaces below.
   */
  subscribe(req: SubscribeRequest): Promise<Subscription> {
    return this.request<Subscription>("POST", API_ROUTES.subscriptions, {
      auth: true,
      body: req,
    });
  }

  // ── User/management-facing (mq_session cookie) ───────────────────────────

  register(req: RegisterAgentRequest): Promise<RegisterAgentResponse> {
    return this.request<RegisterAgentResponse>("POST", API_ROUTES.register, {
      session: true,
      body: req,
    });
  }

  spaces(): Promise<SpaceSummary[]> {
    return this.request<SpaceSummary[]>("GET", API_ROUTES.spaces, {
      session: true,
    });
  }

  authMe(): Promise<AuthResponse> {
    return this.request<AuthResponse>("GET", API_ROUTES.authMe, {
      session: true,
    });
  }

  async authLogout(): Promise<void> {
    await this.request<unknown>("POST", API_ROUTES.authLogout, {
      session: true,
      body: {},
    });
  }

  // ── Management/UI-facing (mq_session cookie; server scopes to visible spaces) ──

  listProjects(): Promise<ProjectSummary[]> {
    return this.request<ProjectSummary[]>("GET", API_ROUTES.projects, {
      session: true,
    });
  }

  /**
   * Read the site's news timeline (the connect-step 24h poll). The endpoint
   * accepts either the agent's api_token or a user session; send whichever we
   * hold (both when available) so a rotated api_token still works via the login
   * cookie. The server tries the session first, then the Bearer token.
   */
  listUpdates(limit?: number): Promise<SiteUpdate[]> {
    const query = limit && Number.isFinite(limit) ? `?limit=${Math.trunc(limit)}` : "";
    return this.request<SiteUpdate[]>("GET", `${API_ROUTES.updates}${query}`, {
      auth: Boolean(this.apiToken),
      session: Boolean(this.sessionToken),
    });
  }
}

/**
 * Extract the `mq_session` cookie value from a Set-Cookie response header.
 * Prefers the modern multi-value `getSetCookie()` API (Node 22 `fetch`/undici);
 * falls back to parsing the single combined `set-cookie` header string.
 */
function extractSessionCookie(res: Response): string | undefined {
  const headers = res.headers as Headers & { getSetCookie?: () => string[] };
  const cookieStrings =
    typeof headers.getSetCookie === "function"
      ? headers.getSetCookie()
      : splitSetCookieHeader(res.headers.get("set-cookie"));

  for (const cookieString of cookieStrings) {
    const match = /(?:^|;\s*)mq_session=([^;]+)/.exec(cookieString);
    if (match?.[1]) return decodeURIComponent(match[1]);
  }
  return undefined;
}

/**
 * Best-effort split of a combined `set-cookie` header into individual cookie
 * strings. Only used as a fallback when `getSetCookie()` is unavailable; a
 * single cookie (our case) round-trips fine even without splitting correctly.
 */
function splitSetCookieHeader(combined: string | null): string[] {
  if (!combined) return [];
  return combined.split(/,(?=\s*[^;=\s]+=)/);
}
