// Thin typed client over fetch for the agent-mq server API.
// Uses API_ROUTES from @agentmq/shared so paths never drift from the contract.
import {
  API_ROUTES,
  type ClaimResponse,
  type CompleteTaskRequest,
  type CompleteTaskResponse,
  type HeartbeatResponse,
  type ProjectSummary,
  type RegisterAgentRequest,
  type RegisterAgentResponse,
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
}

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

/** Minimal typed wrapper over fetch. Attaches Bearer token when present, throws ApiError on non-2xx. */
export class ApiClient {
  readonly server: string;
  private apiToken: string | undefined;

  constructor(options: ApiClientOptions) {
    this.server = options.server.replace(/\/+$/, "");
    this.apiToken = options.apiToken;
  }

  setToken(token: string | undefined): void {
    this.apiToken = token;
  }

  private async request<T>(
    method: "GET" | "POST",
    path: string,
    options: { body?: unknown; auth?: boolean } = {},
  ): Promise<T> {
    const { body, auth = false } = options;
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

  // ── Agent-facing (Bearer auth, except register) ──────────────────────────

  register(req: RegisterAgentRequest): Promise<RegisterAgentResponse> {
    return this.request<RegisterAgentResponse>("POST", API_ROUTES.register, {
      body: req,
    });
  }

  agentHeartbeat(): Promise<HeartbeatResponse> {
    return this.request<HeartbeatResponse>("POST", API_ROUTES.agentHeartbeat, {
      auth: true,
      body: {},
    });
  }

  subscribe(req: SubscribeRequest): Promise<Subscription> {
    return this.request<Subscription>("POST", API_ROUTES.subscriptions, {
      auth: true,
      body: req,
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

  // ── Management/UI-facing (open, no auth) ─────────────────────────────────

  listProjects(): Promise<ProjectSummary[]> {
    return this.request<ProjectSummary[]>("GET", API_ROUTES.projects);
  }
}
