// The `run` worker loop: heartbeat -> claim -> dispatch handler -> heartbeat
// on an interval while running -> complete with metrics.
import type { ClaimedTask, CompleteTaskRequest } from "@agentmq/shared";
import { ApiClient, ApiError } from "./api.js";
import { Backoff, sleepMs } from "./backoff.js";
import { color, fail, info, ok, warn } from "./colors.js";
import { resolveHandler } from "./handlers/index.js";
import type { HandlerContext } from "./handlers/types.js";

export interface RunOptions {
  once: boolean;
  intervalSec: number;
  concurrency: number;
  allowShell: boolean;
}

/** Thrown internally to signal the task lease was lost mid-run; the caller must not complete(). */
class LeaseLostError extends Error {}

async function runSingleTask(
  api: ApiClient,
  agentId: string,
  task: ClaimedTask,
  allowShell: boolean,
): Promise<void> {
  const label = `${color.bold(task.type)} ${color.dim(task.id.slice(0, 8))}`;
  info(`claimed ${label} (project=${task.project_name}, lease=${task.lease_seconds}s)`);

  let leaseLost = false;
  const heartbeatIntervalMs = Math.max(1000, Math.floor((task.lease_seconds * 1000) / 3));
  let heartbeatTimer: NodeJS.Timeout | undefined;

  const ctx: HandlerContext = {
    server: api.server,
    agentId,
    allowShell,
    heartbeat: async () => {
      try {
        await api.taskHeartbeat(task.id);
      } catch (err: unknown) {
        if (err instanceof ApiError && err.status === 409) {
          leaseLost = true;
        }
        throw err;
      }
    },
  };

  heartbeatTimer = setInterval(() => {
    ctx.heartbeat().catch(() => {
      // Errors surface via `leaseLost`/task failure; nothing else to do from
      // a timer callback. The next await on ctx.heartbeat() (or the handler
      // throwing) will propagate the real failure.
    });
  }, heartbeatIntervalMs);

  const startedAt = Date.now();
  try {
    const handler = resolveHandler(task.type);
    const outcome = await handler(task, ctx);

    if (leaseLost) {
      throw new LeaseLostError(`lease lost for task ${task.id} during execution`);
    }

    const wallTimeMs = Date.now() - startedAt;
    const completeReq: CompleteTaskRequest = {
      status: "success",
      result: outcome.result,
      metrics: {
        model: outcome.metrics.model,
        tokens: outcome.metrics.tokens,
        wall_time_ms: wallTimeMs,
        cost_usd: outcome.metrics.cost_usd,
      },
    };
    const res = await api.complete(task.id, completeReq);
    ok(`completed ${label} -> ${res.task_status} (${wallTimeMs}ms)`);
  } catch (err: unknown) {
    if (leaseLost || err instanceof LeaseLostError) {
      warn(`abort ${label}: lease lost, NOT completing (another agent may own it now)`);
      return;
    }

    const message = err instanceof Error ? err.message : String(err);
    fail(`handler error for ${label}: ${message}`);

    const wallTimeMs = Date.now() - startedAt;
    try {
      const res = await api.complete(task.id, {
        status: "failure",
        error: message,
        metrics: { wall_time_ms: wallTimeMs },
      });
      warn(`reported failure ${label} -> ${res.task_status}${res.requeued ? " (requeued)" : ""}`);
    } catch (completeErr: unknown) {
      if (completeErr instanceof ApiError && completeErr.status === 409) {
        warn(`abort ${label}: lease lost before failure could be reported`);
        return;
      }
      const completeMessage =
        completeErr instanceof Error ? completeErr.message : String(completeErr);
      fail(`failed to report failure for ${label}: ${completeMessage}`);
    }
  } finally {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
  }
}

/** Claim + heartbeat + dispatch one task if available. Returns true if a task was claimed. */
async function claimAndRunOne(
  api: ApiClient,
  agentId: string,
  allowShell: boolean,
): Promise<boolean> {
  const { task } = await api.claim();
  if (!task) return false;
  await runSingleTask(api, agentId, task, allowShell);
  return true;
}

/** Run up to `concurrency` claim+run cycles concurrently, returning how many actually claimed a task. */
async function claimBatch(
  api: ApiClient,
  agentId: string,
  concurrency: number,
  allowShell: boolean,
): Promise<number> {
  const results = await Promise.all(
    Array.from({ length: concurrency }, () => claimAndRunOne(api, agentId, allowShell)),
  );
  return results.filter(Boolean).length;
}

export async function runWorker(
  api: ApiClient,
  agentId: string,
  options: RunOptions,
): Promise<void> {
  const backoff = new Backoff(Math.max(1, options.intervalSec) * 1000);

  if (options.once) {
    try {
      await api.agentHeartbeat();
    } catch (err: unknown) {
      warn(`agent heartbeat failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    const claimed = await claimBatch(api, agentId, options.concurrency, options.allowShell);
    if (!claimed) info("no task available (--once): exiting");
    return;
  }

  info(
    `starting worker loop (concurrency=${options.concurrency}, interval=${options.intervalSec}s)`,
  );

  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      await api.agentHeartbeat();
    } catch (err: unknown) {
      warn(`agent heartbeat failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    let claimed = 0;
    try {
      claimed = await claimBatch(api, agentId, options.concurrency, options.allowShell);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      fail(`claim cycle failed: ${message}`);
    }

    if (claimed > 0) {
      // Tasks were available: reset backoff and loop again promptly to keep
      // the concurrency slots full rather than waiting out a full interval.
      backoff.reset();
      await sleepMs(100);
    } else {
      const delay = backoff.next();
      info(`idle, backing off ${Math.round(delay / 1000)}s`);
      await sleepMs(delay);
    }
  }
}
