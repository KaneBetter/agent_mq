// sleep: sleeps payload.ms (default 1500), simulating a small token burn.
// payload is untrusted — validate/clamp the numeric field before using it.
import { createPrng, randInt } from "../prng.js";
import type { Handler } from "./types.js";

const DEFAULT_MS = 1500;
const MAX_MS = 5 * 60_000; // clamp untrusted payload.ms to a sane ceiling

function coerceMs(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return DEFAULT_MS;
  }
  return Math.min(value, MAX_MS);
}

export const sleep: Handler = async (task, ctx) => {
  const payload = task.payload as Record<string, unknown>;
  const ms = coerceMs(payload.ms);

  // Heartbeat partway through long sleeps so the lease stays fresh even
  // for a bare `sleep` handler run outside the run-loop's own interval.
  const halfway = Math.floor(ms / 2);
  if (halfway > 0) {
    await new Promise((resolve) => setTimeout(resolve, halfway));
    await ctx.heartbeat();
    await new Promise((resolve) => setTimeout(resolve, ms - halfway));
  } else {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }

  const rng = createPrng(task.id);
  const burnedTokens = randInt(rng, 5, 40);

  return {
    result: { slept_ms: ms },
    metrics: {
      model: "claude-mock",
      tokens: { input: 0, output: burnedTokens, total: burnedTokens },
    },
  };
};
