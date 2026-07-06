import type {
  ActivityRecord,
  AgentSchedule,
  AgentSummary,
  CalendarResponse,
  CostBreakdown,
  CreateProjectRequest,
  CreateScheduleRequest,
  CreateTaskTypeRequest,
  EventType,
  Group,
  OnboardingInfo,
  OverviewKPIs,
  Project,
  ProjectDetail,
  ProjectSummary,
  PublishTaskRequest,
  RegisterAgentRequest,
  RegisterAgentResponse,
  Schedule,
  Task,
  TaskDetail,
  TaskStatus,
  TaskType,
  UpdateScheduleRequest,
} from "@agentmq/shared";
import { API_ROUTES } from "@agentmq/shared";

export const API_BASE =
  import.meta.env.VITE_API_BASE?.replace(/\/$/, "") ?? "http://localhost:4000";

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: { "Content-Type": "application/json" },
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

  calendar: (params: { project_id?: string; from?: string; to?: string } = {}) => {
    const q = new URLSearchParams();
    if (params.project_id) q.set("project_id", params.project_id);
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
};
