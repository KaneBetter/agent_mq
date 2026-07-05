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
  machine_info: Record<string, unknown>;
  capabilities: string[];
  max_concurrency: number;
  status: AgentStatus;
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
}

export interface Project {
  id: string;
  name: string;
  description: string;
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
  payload?: Record<string, unknown>;
  priority?: number;
  required_capabilities?: string[];
  target_group_id?: string | null;
  max_retries?: number;
  dedup_key?: string;
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
  | "reaper.reclaimed";

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

// ── Shared constants ───────────────────────────────────────────────────────
export const API_ROUTES = {
  register: "/api/agents/register",
  agentHeartbeat: "/api/agents/heartbeat",
  subscriptions: "/api/subscriptions",
  claim: "/api/claim",
  taskHeartbeat: (id: string) => `/api/tasks/${id}/heartbeat`,
  complete: (id: string) => `/api/tasks/${id}/complete`,
  projects: "/api/projects",
  groups: "/api/groups",
  taskTypes: "/api/task-types",
  tasks: "/api/tasks",
  task: (id: string) => `/api/tasks/${id}`,
  requeue: (id: string) => `/api/tasks/${id}/requeue`,
  cancel: (id: string) => `/api/tasks/${id}/cancel`,
  agents: "/api/agents",
  agent: (id: string) => `/api/agents/${id}`,
  overview: "/api/dashboard/overview",
  costs: "/api/dashboard/costs",
  events: "/api/events",
  health: "/api/health",
} as const;
