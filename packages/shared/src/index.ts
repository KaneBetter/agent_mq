// Shared contract types for agent-mq. Imported by @agentmq/server, @agentmq/web, @agentmq/agent.
// No runtime dependencies — types + a few constants only.

// ── Enums ──────────────────────────────────────────────────────────────────
export type TaskStatus =
  | "PENDING"
  | "CLAIMED"
  | "RUNNING"
  | "COMPLETED"
  | "FAILED"
  | "DEAD";

export type AgentStatus = "online" | "offline";
export type ResultStatus = "success" | "failure";

export const TASK_STATUSES: TaskStatus[] = [
  "PENDING",
  "CLAIMED",
  "RUNNING",
  "COMPLETED",
  "FAILED",
  "DEAD",
];

// Statuses that count as "in flight" (holding a lease against an agent).
export const INFLIGHT_STATUSES: TaskStatus[] = ["CLAIMED", "RUNNING"];

// ── Core entities ──────────────────────────────────────────────────────────
export interface Agent {
  id: string;
  name: string;
  owner: string;
  owner_user_id: string | null;
  /** The space this consumer belongs to (one space per consumer). */
  space_id: string | null;
  space_name?: string | null;
  machine_info: Record<string, unknown>;
  capabilities: string[];
  max_concurrency: number;
  status: AgentStatus;
  /** Global manual pause — a paused consumer is never handed work. */
  paused: boolean;
  last_heartbeat_at: string | null;
  created_at: string;
}

/** Agent enriched with dashboard aggregates. */
export interface AgentSummary extends Agent {
  inflight: number;
  completed_count: number;
  failed_count: number;
  total_tokens: number;
  total_wall_time_ms: number;
  total_cost_usd: number;
  success_rate: number | null; // null when no finished tasks yet
  /** True right now due to a rest window (independent of the manual `paused` flag). */
  resting: boolean;
}

export interface Project {
  id: string;
  name: string;
  description: string;
  tags: string[];
  space_id: string | null;
  space_name?: string | null;
  task_schema: Record<string, unknown> | null;
  created_at: string;
}

export interface ProjectSummary extends Project {
  pending: number;
  running: number;
  completed: number;
  dead: number;
  eligible_agents: number; // subscribed agents that can run at least one queued type
  groups: Group[];
}

export interface Group {
  id: string;
  name: string;
  project_id: string;
  created_at: string;
}

export interface Subscription {
  id: string;
  agent_id: string;
  project_id: string;
  group_id: string;
  created_at: string;
}

export interface TaskType {
  type: string;
  description: string;
  input_schema: Record<string, unknown> | null;
  required_capabilities: string[];
  runtime_image: string | null;
  resource_limits: Record<string, unknown> | null;
  created_at: string;
}

export interface Task {
  id: string;
  project_id: string;
  type: string;
  tags: string[];
  payload: Record<string, unknown>;
  priority: number;
  required_capabilities: string[];
  target_group_id: string | null;
  status: TaskStatus;
  retry_count: number;
  max_retries: number;
  assigned_agent_id: string | null;
  group_id: string | null;
  claimed_at: string | null;
  lease_expires_at: string | null;
  visible_after: string | null;
  /** When set and in the future, the task is scheduled and not claimable until then. */
  scheduled_for: string | null;
  /** Provenance: the recurring schedule that generated this task, if any. */
  schedule_id: string | null;
  /** Resume checkpoint preserved across stop/reassign; a new consumer reads it. */
  state: Record<string, unknown> | null;
  /** When set, only this consumer may claim the message (targeted reassignment). */
  assign_to_agent_id: string | null;
  /** Optional 0..1 progress for display. */
  progress: number | null;
  dedup_key: string | null;
  last_error: string | null;
  created_at: string;
  completed_at: string | null;
}

export interface TaskResult {
  id: string;
  task_id: string;
  agent_id: string | null;
  status: ResultStatus;
  output: Record<string, unknown> | null;
  created_at: string;
}

export interface Metrics {
  id: string;
  task_id: string;
  agent_id: string | null;
  project_id: string | null;
  model: string | null;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  wall_time_ms: number;
  cost_usd: number;
  retries: number;
  created_at: string;
}

/** Detail returned by GET /api/tasks/:id and embedded in the queue drilldown. */
export interface TaskDetail extends Task {
  project_name: string;
  assigned_agent_name: string | null;
  result: TaskResult | null;
  metrics: Metrics | null;
}

// ── Request DTOs (agent-facing) ────────────────────────────────────────────
export interface RegisterAgentRequest {
  name: string;
  owner?: string;
  capabilities?: string[];
  machine_info?: Record<string, unknown>;
  max_concurrency?: number;
  /** The space to register this consumer into (required in v6; caller must be a member). */
  space_id?: string;
  /** When set, the server also subscribes the new agent to this project in one step. */
  project_id?: string;
  group_name?: string;
}
export interface RegisterAgentResponse {
  agent_id: string;
  api_token: string;
  agent: Agent;
}

export interface SubscribeRequest {
  project_id: string;
  /** Optional; when omitted the project's default group ("default") is used/created. */
  group_id?: string;
  group_name?: string;
}

export interface ClaimRequest {
  /** Reserved for future batch claim; MVP claims one task. */
  max_batch?: number;
}
/** Claim returns the task or HTTP 204 (no task) — agent then backs off. */
export interface ClaimResponse {
  task: ClaimedTask | null;
}
/** A claimed task carries everything the handler needs to run. */
export interface ClaimedTask extends Task {
  project_name: string;
  lease_seconds: number;
}

export interface HeartbeatResponse {
  ok: true;
  status: AgentStatus;
}

/** Renew a task lease mid-execution. 409 => lease lost, agent must stop. */
export interface TaskHeartbeatResponse {
  lease_expires_at: string;
}

export interface CompleteTaskRequest {
  status: ResultStatus;
  result?: Record<string, unknown>;
  error?: string;
  metrics?: {
    model?: string;
    tokens?: { input?: number; output?: number; total?: number };
    wall_time_ms?: number;
    cost_usd?: number;
    retries?: number;
  };
}
export interface CompleteTaskResponse {
  ok: true;
  task_status: TaskStatus;
  requeued: boolean;
}

// ── Request DTOs (management / UI-facing) ──────────────────────────────────
export interface CreateProjectRequest {
  name: string;
  description?: string;
  task_schema?: Record<string, unknown>;
  tags?: string[];
  /** The space this topic belongs to (required by the v5 server; caller must be admin|member). */
  space_id?: string;
  /** Optional default group name; defaults to "default". */
  default_group?: string;
}
export interface CreateGroupRequest {
  name: string;
  project_id: string;
}
export interface CreateTaskTypeRequest {
  type: string;
  description?: string;
  input_schema?: Record<string, unknown>;
  required_capabilities?: string[];
  runtime_image?: string;
  resource_limits?: Record<string, unknown>;
}
export interface PublishTaskRequest {
  project_id: string;
  type: string;
  tags?: string[];
  payload?: Record<string, unknown>;
  priority?: number;
  required_capabilities?: string[];
  target_group_id?: string | null;
  max_retries?: number;
  dedup_key?: string;
  /** ISO timestamp; when in the future the task is scheduled (claimable only after). */
  scheduled_for?: string | null;
}

// ── Dashboard DTOs ─────────────────────────────────────────────────────────
export interface OverviewKPIs {
  agents_online: number;
  agents_total: number;
  tasks_pending: number;
  tasks_running: number;
  tasks_completed: number;
  tasks_dead: number;
  total_tokens: number;
  total_cost_usd: number;
}

export interface CostBucket {
  key: string; // model / agent name / project name / date
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  cost_usd: number;
  tasks: number;
}
export interface CostBreakdown {
  by_model: CostBucket[];
  by_agent: CostBucket[];
  by_project: CostBucket[];
  by_day: CostBucket[];
  anomalies: string[]; // human-readable spend-spike alerts
}

// ── Live event stream (SSE at GET /api/events) ─────────────────────────────
export type EventType =
  | "task.published"
  | "task.scheduled"
  | "task.claimed"
  | "task.running"
  | "task.completed"
  | "task.failed"
  | "task.requeued"
  | "task.dead"
  | "task.canceled"
  | "agent.registered"
  | "agent.online"
  | "agent.offline"
  | "reaper.reclaimed"
  | "schedule.fired";

export interface LiveEvent {
  type: EventType;
  ts: string;
  task_id?: string;
  task_type?: string;
  project_id?: string;
  project_name?: string;
  agent_id?: string;
  agent_name?: string;
  status?: TaskStatus;
  message?: string;
}

// ── Recurring schedules (project-level task generators) ────────────────────
export type RecurrenceKind = "interval" | "weekly";
export interface Recurrence {
  kind: RecurrenceKind;
  /** kind=interval: fire every N seconds. */
  interval_seconds?: number;
  /** kind=weekly: 0=Sun .. 6=Sat. */
  days_of_week?: number[];
  /** kind=weekly: local "HH:MM" fire times each selected day. */
  times?: string[];
  /** IANA timezone the weekly times are interpreted in (default server tz). */
  timezone?: string;
}

export interface Schedule {
  id: string;
  project_id: string;
  name: string;
  type: string;
  payload_template: Record<string, unknown>;
  tags: string[];
  required_capabilities: string[];
  target_group_id: string | null;
  recurrence: Recurrence;
  /** Duty-roster length in hours; when set, generated tasks get shift_start/shift_end. */
  shift_hours: number | null;
  enabled: boolean;
  next_run_at: string;
  last_run_at: string | null;
  runs_count: number;
  created_at: string;
}

export interface CreateScheduleRequest {
  project_id: string;
  name: string;
  type: string;
  payload_template?: Record<string, unknown>;
  tags?: string[];
  required_capabilities?: string[];
  target_group_id?: string | null;
  recurrence: Recurrence;
  shift_hours?: number | null;
  enabled?: boolean;
}
export interface UpdateScheduleRequest {
  enabled?: boolean;
  recurrence?: Recurrence;
  payload_template?: Record<string, unknown>;
  tags?: string[];
}

/** A computed upcoming fire of a schedule (for the calendar / roster view). */
export interface ScheduleOccurrence {
  schedule_id: string;
  schedule_name: string;
  type: string;
  at: string; // ISO
  shift_end: string | null;
}

// ── Agent polling schedules (registered on server, run client-side) ────────
export type AgentScheduleKind = "site_update" | "project_poll";
export interface AgentSchedule {
  id: string;
  agent_id: string;
  agent_name: string | null;
  project_id: string | null;
  project_name: string | null;
  kind: AgentScheduleKind;
  interval_seconds: number;
  last_polled_at: string | null;
  next_poll_at: string | null;
  created_at: string;
}

/** Full project drill-in (GET /api/projects/:id). */
export interface ProjectDetail extends ProjectSummary {
  agents: AgentSummary[];
  schedules: Schedule[];
  agent_schedules: AgentSchedule[];
  recent_tasks: TaskDetail[];
  upcoming: ScheduleOccurrence[];
}

/** Agent onboarding payload for the homepage (GET /api/onboarding). */
export interface OnboardingInfo {
  server_url: string;
  install_cmd: string;
  prompt: string;
}

/** A persisted activity record (the durable form of a LiveEvent). */
export interface ActivityRecord extends LiveEvent {
  id: string;
  task_tags?: string[];
  project_tags?: string[];
}

// ── Calendar (GET /api/calendar) ───────────────────────────────────────────
/** A future task shown on the calendar's upcoming days. */
export interface ScheduledTaskLite {
  id: string;
  type: string;
  tags: string[];
  project_id: string;
  project_name: string;
  status: TaskStatus;
  scheduled_for: string;
}
/** Per-day rollup: past activity counts + future scheduled tasks. */
export interface CalendarDay {
  date: string; // YYYY-MM-DD (server local)
  activity_total: number;
  completed: number;
  failed: number;
  published: number;
  scheduled: ScheduledTaskLite[];
}
export interface CalendarResponse {
  from: string; // YYYY-MM-DD
  to: string; // YYYY-MM-DD
  days: CalendarDay[];
}

// ── v5: users, sessions, spaces + RBAC ─────────────────────────────────────
export interface User {
  id: string;
  username: string;
  email: string | null;
  display_name: string;
  created_at: string;
}

export interface RegisterUserRequest {
  username: string;
  password: string;
  email?: string;
  display_name?: string;
}
export interface LoginRequest {
  username: string;
  password: string;
}
/** Returned by register/login/me. Session is set as an httpOnly cookie. */
export interface AuthResponse {
  user: User;
}

export type SpaceVisibility = "private" | "team" | "public";
export type SpaceRole = "admin" | "member" | "viewer";

export interface Space {
  id: string;
  name: string;
  slug: string;
  visibility: SpaceVisibility;
  owner_id: string | null;
  created_at: string;
}
export interface SpaceMemberInfo {
  user_id: string;
  username: string;
  display_name: string;
  role: SpaceRole;
  created_at: string;
}
/** A space with the viewer's effective role + aggregate counts. */
export interface SpaceSummary extends Space {
  owner_username: string | null;
  my_role: SpaceRole | null; // null = not a member (public read-only)
  topic_count: number;
  member_count: number;
}
export interface SpaceDetail extends SpaceSummary {
  members: SpaceMemberInfo[];
}

export interface CreateSpaceRequest {
  name: string;
  visibility?: SpaceVisibility;
}
export interface UpdateSpaceRequest {
  name?: string;
  visibility?: SpaceVisibility;
}
export interface AddMemberRequest {
  username: string;
  role?: SpaceRole;
}

// ── v5: agent rest / pause ─────────────────────────────────────────────────
export interface RestWindow {
  id: string;
  agent_id: string;
  project_id: string | null; // null = global
  project_name?: string | null;
  days_of_week: number[]; // 0=Sun..6=Sat
  start_time: string; // 'HH:MM'
  end_time: string; // 'HH:MM'
  timezone: string;
  created_at: string;
}
export interface CreateRestWindowRequest {
  project_id?: string | null;
  days_of_week: number[];
  start_time: string;
  end_time: string;
  timezone?: string;
}
export interface SetAgentPauseRequest {
  paused: boolean;
}
export interface SetSubscriptionPauseRequest {
  project_id: string;
  paused: boolean;
}

// ── v5: stop / reassign / checkpoint ───────────────────────────────────────
/** Consumer posts partial progress so a stopped/reassigned message can resume. */
export interface CheckpointRequest {
  state?: Record<string, unknown>;
  progress?: number;
}
/** Stop an in-flight message: release the lease back to QUEUED, keep the checkpoint. */
export interface StopTaskRequest {
  /** Optionally reassign to a specific consumer at the same time. */
  assign_to_agent_id?: string | null;
}
export interface ReassignTaskRequest {
  agent_id: string; // the consumer to reassign to
}

// ── My dashboard (GET /api/me/overview) ────────────────────────────────────
export interface MyOverview {
  spaces: SpaceSummary[];
  topics: ProjectSummary[];
  agents: AgentSummary[];
  recent_tasks: TaskDetail[]; // what my consumers did
}

// ── Shared constants ───────────────────────────────────────────────────────
export const API_ROUTES = {
  register: "/api/agents/register",
  agentHeartbeat: "/api/agents/heartbeat",
  subscriptions: "/api/subscriptions",
  claim: "/api/claim",
  taskHeartbeat: (id: string) => `/api/tasks/${id}/heartbeat`,
  complete: (id: string) => `/api/tasks/${id}/complete`,
  projects: "/api/projects",
  project: (id: string) => `/api/projects/${id}`,
  groups: "/api/groups",
  taskTypes: "/api/task-types",
  schedules: "/api/schedules",
  schedule: (id: string) => `/api/schedules/${id}`,
  agentSchedules: "/api/agent-schedules",
  onboarding: "/api/onboarding",
  tasks: "/api/tasks",
  task: (id: string) => `/api/tasks/${id}`,
  requeue: (id: string) => `/api/tasks/${id}/requeue`,
  cancel: (id: string) => `/api/tasks/${id}/cancel`,
  agents: "/api/agents",
  agent: (id: string) => `/api/agents/${id}`,
  overview: "/api/dashboard/overview",
  costs: "/api/dashboard/costs",
  activity: "/api/activity",
  calendar: "/api/calendar",
  events: "/api/events",
  health: "/api/health",

  // v5 — auth
  authRegister: "/api/auth/register",
  authLogin: "/api/auth/login",
  authLogout: "/api/auth/logout",
  authMe: "/api/auth/me",
  myOverview: "/api/me/overview",

  // v5 — spaces + members
  spaces: "/api/spaces",
  space: (id: string) => `/api/spaces/${id}`,
  spaceMembers: (id: string) => `/api/spaces/${id}/members`,
  spaceMember: (id: string, userId: string) => `/api/spaces/${id}/members/${userId}`,

  // v5 — agent rest / pause
  agentPause: (id: string) => `/api/agents/${id}/pause`,
  agentRestWindows: (id: string) => `/api/agents/${id}/rest-windows`,
  agentRestWindow: (id: string, windowId: string) => `/api/agents/${id}/rest-windows/${windowId}`,
  subscriptionPause: (agentId: string) => `/api/agents/${agentId}/subscription-pause`,

  // v5 — stop / reassign / checkpoint
  taskStop: (id: string) => `/api/tasks/${id}/stop`,
  taskReassign: (id: string) => `/api/tasks/${id}/reassign`,
  taskCheckpoint: (id: string) => `/api/tasks/${id}/checkpoint`,
} as const;
