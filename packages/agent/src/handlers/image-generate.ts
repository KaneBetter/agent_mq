// image.generate: mock handler that pretends to need GPU. Requires the "gpu"
// capability on the task type (enforced server-side by required_capabilities),
// but the handler itself just fabricates a plausible image artifact reference.
import { createPrng, randInt } from "../prng.js";
import type { Handler } from "./types.js";

function untrustedString(value: unknown, fallback: string, maxLen = 200): string {
  if (typeof value !== "string" || value.trim() === "") return fallback;
  return value.slice(0, maxLen);
}

export const imageGenerate: Handler = async (task, ctx) => {
  const payload = task.payload as Record<string, unknown>;
  const prompt = untrustedString(payload.prompt, `untitled-${task.id.slice(0, 8)}`);
  const rng = createPrng(task.id);

  // Simulate a GPU render pass; heartbeat partway to keep the lease fresh.
  const renderMs = randInt(rng, 2000, 6000);
  const halfway = Math.floor(renderMs / 2);
  await new Promise((resolve) => setTimeout(resolve, halfway));
  await ctx.heartbeat();
  await new Promise((resolve) => setTimeout(resolve, renderMs - halfway));

  const width = 1024;
  const height = 1024;
  const outputTokens = randInt(rng, 200, 400);

  return {
    result: {
      prompt,
      image_ref: `mock://images/${task.id}.png`,
      width,
      height,
    },
    metrics: {
      model: "claude-mock-image",
      tokens: { input: 0, output: outputTokens, total: outputTokens },
      cost_usd: Number((randInt(rng, 2, 8) / 100).toFixed(2)),
    },
  };
};
