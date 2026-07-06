// Small pure mappers from raw pg rows to @agentmq/shared entity shapes.
// pg is configured (see db.ts) to already hand back ISO-string timestamps and
// numeric columns as JS numbers, so these mappers are mostly structural.
import type { Metrics, Task, TaskDetail, TaskResult } from "@agentmq/shared";

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
