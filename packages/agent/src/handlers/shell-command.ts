// shell.command: DISABLED by default. payload.cmd is UNTRUSTED input published
// by whoever hit the publish API — it is never eval'd or trusted implicitly.
// Only runs when the operator explicitly passed --allow-shell to `agentctl run`,
// which is an explicit, local, opt-in trust decision by the machine's owner.
import { execFile } from "node:child_process";
import type { Handler } from "./types.js";

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 5 * 60_000;
const MAX_OUTPUT_BYTES = 1_000_000;

function coerceTimeoutMs(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return DEFAULT_TIMEOUT_MS;
  }
  return Math.min(value, MAX_TIMEOUT_MS);
}

export const shellCommand: Handler = async (task, ctx) => {
  if (!ctx.allowShell) {
    throw new Error(
      "shell.command is disabled: refused to run untrusted payload.cmd. " +
        "Pass --allow-shell to `agentctl run`/`claim` to explicitly opt in on this machine.",
    );
  }

  const payload = task.payload as Record<string, unknown>;
  const cmd = payload.cmd;
  if (typeof cmd !== "string" || cmd.trim() === "") {
    throw new Error("shell.command requires a non-empty string payload.cmd");
  }

  const hasArgsArray = Array.isArray(payload.args);
  const args = hasArgsArray
    ? (payload.args as unknown[]).filter((a): a is string => typeof a === "string")
    : [];
  const timeoutMs = coerceTimeoutMs(payload.timeout_ms);

  // Security note: when payload.args is a discrete array we run WITHOUT
  // shell:true — execFile then execs the binary directly via argv, so the
  // untrusted strings can never be reinterpreted by a shell (no injection,
  // no quoting pitfalls; this is what Node's own docs recommend to avoid the
  // "unescaped args + shell:true" foot-gun). Only when the caller supplies a
  // single opaque command string with no args array do we fall back to
  // shell:true (needed for pipes/redirects) — still just as untrusted, but
  // that's an explicit trade the --allow-shell operator is already making.
  const { stdout, stderr, exitCode, signal } = await new Promise<{
    stdout: string;
    stderr: string;
    exitCode: number | null;
    signal: NodeJS.Signals | null;
  }>((resolve) => {
    execFile(
      cmd,
      args,
      {
        shell: hasArgsArray ? false : true,
        timeout: timeoutMs,
        maxBuffer: MAX_OUTPUT_BYTES,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        const execError = error as (NodeJS.ErrnoException & { code?: number; signal?: NodeJS.Signals }) | null;
        resolve({
          stdout,
          stderr,
          exitCode: execError && typeof execError.code === "number" ? execError.code : execError ? null : 0,
          signal: execError?.signal ?? null,
        });
      },
    );
  });

  if (signal === "SIGTERM") {
    throw new Error(`shell.command timed out after ${timeoutMs}ms`);
  }

  return {
    result: {
      stdout: stdout.slice(0, MAX_OUTPUT_BYTES),
      stderr: stderr.slice(0, MAX_OUTPUT_BYTES),
      exit_code: exitCode,
    },
    metrics: { tokens: { input: 0, output: 0, total: 0 } },
  };
};
