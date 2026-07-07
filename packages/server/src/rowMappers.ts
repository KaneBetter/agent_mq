// Small pure mappers from raw pg rows to @agentmq/shared entity shapes.
// pg is configured (see db.ts) to already hand back ISO-string timestamps and
// numeric columns as JS numbers, so these mappers are mostly structural.
import type {
  AgentSchedule,
  Metrics,
  Recurrence,
  Schedule,
  Task,
  TaskDetail,
  TaskResult,
} from "@agentmq/shared";

export interface TaskRow {
  id: string;
  project_id: string;
  type: string;
  tags: string[] | null;
  payload: Record<string, unknown>;
  priority: number;
  required_capabilities: string[];
  target_group_id: string | null;
  status: Task["status"];
  retry_count: number;
  max_retries: number;
  assigned_agent_id: string | null;
  group_id: string | null;
  claimed_at: string | null;
  lease_expires_at: string | null;
  visible_after: string | null;
  scheduled_for: string | null;
  schedule_id: string | null;
  state: Record<string, unknown> | null;
  assign_to_agent_id: string | null;
  progress: number | null;
  dedup_key: string | null;
  last_error: string | null;
  created_at: string;
  completed_at: string | null;
}

export function mapTaskRow(row: TaskRow): Task {
  return {
    id: row.id,
    project_id: row.project_id,
    type: row.type,
    tags: row.tags ?? [],
    payload: row.payload,
    priority: row.priority,
    required_capabilities: row.required_capabilities,
    target_group_id: row.target_group_id,
    status: row.status,
    retry_count: row.retry_count,
    max_retries: row.max_retries,
    assigned_agent_id: row.assigned_agent_id,
    group_id: row.group_id,
    claimed_at: row.claimed_at,
    lease_expires_at: row.lease_expires_at,
    visible_after: row.visible_after,
    scheduled_for: row.scheduled_for,
    schedule_id: row.schedule_id,
    state: row.state ?? null,
    assign_to_agent_id: row.assign_to_agent_id ?? null,
    progress: row.progress ?? null,
    dedup_key: row.dedup_key,
    last_error: row.last_error,
    created_at: row.created_at,
    completed_at: row.completed_at,
  };
}

export interface TaskDetailRow extends TaskRow {
  project_name: string;
  assigned_agent_name: string | null;
  result_id: string | null;
  result_agent_id: string | null;
  result_status: TaskResult["status"] | null;
  result_output: Record<string, unknown> | null;
  result_created_at: string | null;
  metrics_id: string | null;
  metrics_agent_id: string | null;
  metrics_project_id: string | null;
  metrics_model: string | null;
  metrics_input_tokens: number | null;
  metrics_output_tokens: number | null;
  metrics_total_tokens: number | null;
  metrics_wall_time_ms: number | null;
  metrics_cost_usd: number | null;
  metrics_retries: number | null;
  metrics_created_at: string | null;
}

export function mapTaskDetailRow(row: TaskDetailRow): TaskDetail {
  const result: TaskResult | null = row.result_id
    ? {
        id: row.result_id,
        task_id: row.id,
        agent_id: row.result_agent_id,
        status: row.result_status as TaskResult["status"],
        output: row.result_output,
        created_at: row.result_created_at as string,
      }
    : null;

  const metrics: Metrics | null = row.metrics_id
    ? {
        id: row.metrics_id,
        task_id: row.id,
        agent_id: row.metrics_agent_id,
        project_id: row.metrics_project_id,
        model: row.metrics_model,
        input_tokens: row.metrics_input_tokens ?? 0,
        output_tokens: row.metrics_output_tokens ?? 0,
        total_tokens: row.metrics_total_tokens ?? 0,
        wall_time_ms: row.metrics_wall_time_ms ?? 0,
        cost_usd: row.metrics_cost_usd ?? 0,
        retries: row.metrics_retries ?? 0,
        created_at: row.metrics_created_at as string,
      }
    : null;

  return {
    ...mapTaskRow(row),
    project_name: row.project_name,
    assigned_agent_name: row.assigned_agent_name,
    result,
    metrics,
  };
}

/** SQL fragment selecting a task joined to project/agent/latest result/latest metrics. */
export const TASK_DETAIL_SELECT = `
  SELECT
    t.*,
    p.name AS project_name,
    a.name AS assigned_agent_name,
    r.id AS result_id,
    r.agent_id AS result_agent_id,
    r.status AS result_status,
    r.output AS result_output,
    r.created_at AS result_created_at,
    m.id AS metrics_id,
    m.agent_id AS metrics_agent_id,
    m.project_id AS metrics_project_id,
    m.model AS metrics_model,
    m.input_tokens AS metrics_input_tokens,
    m.output_tokens AS metrics_output_tokens,
    m.total_tokens AS metrics_total_tokens,
    m.wall_time_ms AS metrics_wall_time_ms,
    m.cost_usd AS metrics_cost_usd,
    m.retries AS metrics_retries,
    m.created_at AS metrics_created_at
  FROM tasks t
  JOIN projects p ON p.id = t.project_id
  LEFT JOIN agents a ON a.id = t.assigned_agent_id
  LEFT JOIN LATERAL (
    SELECT * FROM results WHERE task_id = t.id ORDER BY created_at DESC LIMIT 1
  ) r ON true
  LEFT JOIN LATERAL (
    SELECT * FROM metrics WHERE task_id = t.id ORDER BY created_at DESC LIMIT 1
  ) m ON true
`;

// ── v4: Schedule + AgentSchedule row mappers ────────────────────────────────
export interface ScheduleRow {
  id: string;
  project_id: string;
  name: string;
  type: string;
  payload_template: Record<string, unknown>;
  tags: string[] | null;
  required_capabilities: string[];
  target_group_id: string | null;
  recurrence: Recurrence;
  shift_hours: number | null;
  enabled: boolean;
  next_run_at: string;
  last_run_at: string | null;
  runs_count: number;
  created_at: string;
}

export function mapScheduleRow(row: ScheduleRow): Schedule {
  return {
    id: row.id,
    project_id: row.project_id,
    name: row.name,
    type: row.type,
    payload_template: row.payload_template,
    tags: row.tags ?? [],
    required_capabilities: row.required_capabilities,
    target_group_id: row.target_group_id,
    recurrence: row.recurrence,
    shift_hours: row.shift_hours,
    enabled: row.enabled,
    next_run_at: row.next_run_at,
    last_run_at: row.last_run_at,
    runs_count: row.runs_count,
    created_at: row.created_at,
  };
}

export interface AgentScheduleRow {
  id: string;
  agent_id: string;
  agent_name: string | null;
  project_id: string | null;
  project_name: string | null;
  space_id: string | null;
  space_name: string | null;
  kind: AgentSchedule["kind"];
  interval_seconds: number;
  last_polled_at: string | null;
  next_poll_at: string | null;
  created_at: string;
}

export function mapAgentScheduleRow(row: AgentScheduleRow): AgentSchedule {
  return {
    id: row.id,
    agent_id: row.agent_id,
    agent_name: row.agent_name,
    project_id: row.project_id,
    project_name: row.project_name,
    space_id: row.space_id,
    space_name: row.space_name,
    kind: row.kind,
    interval_seconds: row.interval_seconds,
    last_polled_at: row.last_polled_at,
    next_poll_at: row.next_poll_at,
    created_at: row.created_at,
  };
}

/** SQL fragment selecting an agent_schedules row joined to agent/project/space names. */
export const AGENT_SCHEDULE_SELECT = `
  SELECT
    ags.id, ags.agent_id, a.name AS agent_name,
    ags.project_id, p.name AS project_name,
    ags.space_id, sp.name AS space_name,
    ags.kind, ags.interval_seconds, ags.last_polled_at, ags.next_poll_at, ags.created_at
  FROM agent_schedules ags
  JOIN agents a ON a.id = ags.agent_id
  LEFT JOIN projects p ON p.id = ags.project_id
  LEFT JOIN spaces sp ON sp.id = ags.space_id
`;
