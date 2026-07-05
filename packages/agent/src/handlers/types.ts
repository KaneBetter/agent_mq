// Handler plugin architecture: task.type -> async (task, ctx) => { result, metrics }.
import type { ClaimedTask } from "@agentmq/shared";

export interface HandlerMetrics {
  model?: string;
  tokens?: { input?: number; output?: number; total?: number };
  cost_usd?: number;
}

export interface HandlerOutcome {
  result: Record<string, unknown>;
  metrics: HandlerMetrics;
}

export interface HandlerContext {
  /** Renew the task lease. Throws (via ApiError w/ status 409) if the lease was lost. */
  heartbeat(): Promise<void>;
  server: string;
  agentId: string;
  /** Whether --allow-shell was passed to `run`/`claim`. Only shell.command consults this. */
  allowShell: boolean;
}

export type Handler = (
  task: ClaimedTask,
  ctx: HandlerContext,
) => Promise<HandlerOutcome>;
