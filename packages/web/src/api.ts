import type {
  ActivityRecord,
  AddMemberRequest,
  AgentSchedule,
  AgentSummary,
  AuthResponse,
  CalendarResponse,
  CostBreakdown,
  CreateProjectRequest,
  CreateRestWindowRequest,
  CreateScheduleRequest,
  CreateJoinRequestRequest,
  CreateSpaceRequest,
  CreateTaskTypeRequest,
  DecideJoinRequestRequest,
  EventType,
  Group,
  LoginRequest,
  MyOverview,
  OnboardingInfo,
  OverviewKPIs,
  Project,
  ProjectDetail,
  ProjectSummary,
  PublishTaskRequest,
  RegisterAgentRequest,
  RegisterAgentResponse,
  RegisterUserRequest,
  RestWindow,
  Schedule,
  SiteUpdate,
  SpaceDetail,
  SpaceJoinRequest,
  SpaceSummary,
  Task,
  TaskDetail,
  TaskStatus,
  TaskType,
  UpdateScheduleRequest,
  UpdateSpaceRequest,
} from "@agentmq/shared";
import { API_ROUTES } from "@agentmq/shared";

// Resolve the API origin. An explicit VITE_API_BASE wins (proxied / custom
// deploys, e.g. a reverse proxy). Otherwise derive it from the browser's
// current location so the console works when opened from a remote machine —
// same host as the page, API on VITE_API_PORT (default 4000). Deriving from the
// live host (never hardcoding "localhost", which points a remote browser at its
// own machine) also keeps the page and API same-site, so the SameSite=Lax
// session cookie is stored and re-sent on refresh instead of being dropped.
function resolveApiBase(): string {
  const explicit = import.meta.env.VITE_API_BASE?.replace(/\/$/, "");
  if (explicit) return explicit;
  const port = import.meta.env.VITE_API_PORT ?? "4000";
  if (typeof window !== "undefined" && window.location?.hostname) {
    const { protocol, hostname } = window.location;
    return `${protocol}//${hostname}:${port}`;
  }
  return `http://localhost:${port}`;
}

export const API_BASE = resolveApiBase();

// NOTE: keep this false until the v5 server's CORS sends Access-Control-Allow-Credentials.
// Flipping it before then breaks every request (credentialed CORS needs that header).
// Integration step flips it to true.
const WITH_CREDENTIALS = true;

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: { "Content-Type": "application/json" },
    ...(WITH_CREDENTIALS ? { credentials: "include" as RequestCredentials } : {}),
    ...init,
  });
  if (!res.ok) {
    let msg = `${res.status} ${res.statusText}`;
    try {
      const body = await res.json();
      if (body?.error) msg = body.error;
    } catch {
      /* ignore */
    }
    throw new Error(msg);
  }
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

export const api = {
  health: () => req<{ ok: boolean; db: boolean }>(API_ROUTES.health),

  overview: () => req<OverviewKPIs>(API_ROUTES.overview),
  costs: () => req<CostBreakdown>(API_ROUTES.costs),

  agents: () => req<AgentSummary[]>(API_ROUTES.agents),
  agent: (id: string) =>
    req<{ agent: AgentSummary; recent_tasks: TaskDetail[] }>(API_ROUTES.agent(id)),

  projects: () => req<ProjectSummary[]>(API_ROUTES.projects),
  project: (id: string) => req<ProjectDetail>(API_ROUTES.project(id)),
  createProject: (body: CreateProjectRequest) =>
    req<Project>(API_ROUTES.projects, { method: "POST", body: JSON.stringify(body) }),

  schedules: (projectId?: string) => {
    const qs = projectId ? `?project_id=${encodeURIComponent(projectId)}` : "";
    return req<Schedule[]>(`${API_ROUTES.schedules}${qs}`);
  },
  createSchedule: (body: CreateScheduleRequest) =>
    req<Schedule>(API_ROUTES.schedules, { method: "POST", body: JSON.stringify(body) }),
  updateSchedule: (id: string, body: UpdateScheduleRequest) =>
    req<Schedule>(API_ROUTES.schedule(id), { method: "PATCH", body: JSON.stringify(body) }),
  deleteSchedule: (id: string) => req<void>(API_ROUTES.schedule(id), { method: "DELETE" }),

  agentSchedules: (params: { project_id?: string; agent_id?: string } = {}) => {
    const q = new URLSearchParams();
    if (params.project_id) q.set("project_id", params.project_id);
    if (params.agent_id) q.set("agent_id", params.agent_id);
    const qs = q.toString();
    return req<AgentSchedule[]>(`${API_ROUTES.agentSchedules}${qs ? `?${qs}` : ""}`);
  },

  onboarding: () => req<OnboardingInfo>(API_ROUTES.onboarding),
  createGroup: (body: { name: string; project_id: string }) =>
    req<Group>(API_ROUTES.groups, { method: "POST", body: JSON.stringify(body) }),

  taskTypes: () => req<TaskType[]>(API_ROUTES.taskTypes),
  createTaskType: (body: CreateTaskTypeRequest) =>
    req<TaskType>(API_ROUTES.taskTypes, { method: "POST", body: JSON.stringify(body) }),

  registerAgent: (body: RegisterAgentRequest) =>
    req<RegisterAgentResponse>(API_ROUTES.register, {
      method: "POST",
      body: JSON.stringify(body),
    }),

  tasks: (params: {
    status?: TaskStatus | "";
    project_id?: string;
    type?: string;
    tag?: string;
    limit?: number;
  } = {}) => {
    const q = new URLSearchParams();
    if (params.status) q.set("status", params.status);
    if (params.project_id) q.set("project_id", params.project_id);
    if (params.type) q.set("type", params.type);
    if (params.tag) q.set("tag", params.tag);
    if (params.limit) q.set("limit", String(params.limit));
    const qs = q.toString();
    return req<TaskDetail[]>(`${API_ROUTES.tasks}${qs ? `?${qs}` : ""}`);
  },

  activity: (params: { project_id?: string; type?: EventType | ""; limit?: number } = {}) => {
    const q = new URLSearchParams();
    if (params.project_id) q.set("project_id", params.project_id);
    if (params.type) q.set("type", params.type);
    if (params.limit) q.set("limit", String(params.limit));
    const qs = q.toString();
    return req<ActivityRecord[]>(`${API_ROUTES.activity}${qs ? `?${qs}` : ""}`);
  },

  calendar: (params: { project_id?: string; space_id?: string; from?: string; to?: string } = {}) => {
    const q = new URLSearchParams();
    if (params.project_id) q.set("project_id", params.project_id);
    if (params.space_id) q.set("space_id", params.space_id);
    if (params.from) q.set("from", params.from);
    if (params.to) q.set("to", params.to);
    const qs = q.toString();
    return req<CalendarResponse>(`${API_ROUTES.calendar}${qs ? `?${qs}` : ""}`);
  },
  task: (id: string) => req<TaskDetail>(API_ROUTES.task(id)),
  publish: (body: PublishTaskRequest) =>
    req<Task>(API_ROUTES.tasks, { method: "POST", body: JSON.stringify(body) }),
  requeue: (id: string) => req<Task>(API_ROUTES.requeue(id), { method: "POST" }),
  cancel: (id: string) => req<Task>(API_ROUTES.cancel(id), { method: "POST" }),

  // ── v5: auth ──────────────────────────────────────────────────────────────
  register: (body: RegisterUserRequest) =>
    req<AuthResponse>(API_ROUTES.authRegister, { method: "POST", body: JSON.stringify(body) }),
  login: (body: LoginRequest) =>
    req<AuthResponse>(API_ROUTES.authLogin, { method: "POST", body: JSON.stringify(body) }),
  logout: () => req<{ ok: boolean }>(API_ROUTES.authLogout, { method: "POST" }),
  me: () => req<AuthResponse>(API_ROUTES.authMe),
  myOverview: () => req<MyOverview>(API_ROUTES.myOverview),

  // ── v5: spaces + members ──────────────────────────────────────────────────
  spaces: () => req<SpaceSummary[]>(API_ROUTES.spaces),
  space: (id: string) => req<SpaceDetail>(API_ROUTES.space(id)),
  createSpace: (body: CreateSpaceRequest) =>
    req<SpaceDetail>(API_ROUTES.spaces, { method: "POST", body: JSON.stringify(body) }),
  updateSpace: (id: string, body: UpdateSpaceRequest) =>
    req<SpaceDetail>(API_ROUTES.space(id), { method: "PATCH", body: JSON.stringify(body) }),
  deleteSpace: (id: string) => req<void>(API_ROUTES.space(id), { method: "DELETE" }),
  addMember: (id: string, body: AddMemberRequest) =>
    req<SpaceDetail>(API_ROUTES.spaceMembers(id), { method: "POST", body: JSON.stringify(body) }),
  removeMember: (id: string, userId: string) =>
    req<void>(API_ROUTES.spaceMember(id, userId), { method: "DELETE" }),
  setMemberRole: (id: string, userId: string, role: string) =>
    req<SpaceDetail>(API_ROUTES.spaceMember(id, userId), { method: "PATCH", body: JSON.stringify({ role }) }),

  // ── site updates / news timeline ──────────────────────────────────────────
  updates: (limit?: number) =>
    req<SiteUpdate[]>(`${API_ROUTES.updates}${limit ? `?limit=${limit}` : ""}`),

  // ── space join requests ("apply to join") ─────────────────────────────────
  applyToSpace: (id: string, body: CreateJoinRequestRequest = {}) =>
    req<SpaceJoinRequest>(API_ROUTES.spaceJoinRequests(id), {
      method: "POST",
      body: JSON.stringify(body),
    }),
  spaceJoinRequests: (id: string, status?: string) =>
    req<SpaceJoinRequest[]>(
      `${API_ROUTES.spaceJoinRequests(id)}${status ? `?status=${status}` : ""}`
    ),
  decideJoinRequest: (id: string, requestId: string, body: DecideJoinRequestRequest) =>
    req<SpaceJoinRequest>(API_ROUTES.spaceJoinRequestDecide(id, requestId), {
      method: "POST",
      body: JSON.stringify(body),
    }),
  myJoinRequests: () => req<SpaceJoinRequest[]>(API_ROUTES.myJoinRequests),

  // ── v5: agent rest / pause ────────────────────────────────────────────────
  pauseAgent: (id: string, paused: boolean) =>
    req<AgentSummary>(API_ROUTES.agentPause(id), { method: "POST", body: JSON.stringify({ paused }) }),
  restWindows: (id: string) => req<RestWindow[]>(API_ROUTES.agentRestWindows(id)),
  addRestWindow: (id: string, body: CreateRestWindowRequest) =>
    req<RestWindow>(API_ROUTES.agentRestWindows(id), { method: "POST", body: JSON.stringify(body) }),
  removeRestWindow: (id: string, windowId: string) =>
    req<void>(API_ROUTES.agentRestWindow(id, windowId), { method: "DELETE" }),
  pauseSubscription: (agentId: string, projectId: string, paused: boolean) =>
    req<{ ok: boolean }>(API_ROUTES.subscriptionPause(agentId), {
      method: "POST",
      body: JSON.stringify({ project_id: projectId, paused }),
    }),

  // ── v5: stop / reassign ───────────────────────────────────────────────────
  stopTask: (id: string, assignTo?: string | null) =>
    req<Task>(API_ROUTES.taskStop(id), {
      method: "POST",
      body: JSON.stringify({ assign_to_agent_id: assignTo ?? null }),
    }),
  reassignTask: (id: string, agentId: string) =>
    req<Task>(API_ROUTES.taskReassign(id), { method: "POST", body: JSON.stringify({ agent_id: agentId }) }),
};
