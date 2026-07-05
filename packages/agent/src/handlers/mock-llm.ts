// Shared fabrication logic for mock LLM-style handlers: plausible text output,
// realistic-ish token counts, and a short sleep derived pseudo-randomly from
// task.id (never Math.random) so the live board looks lively but reproducible.
import type { ClaimedTask } from "@agentmq/shared";
import { createPrng, randInt, pick } from "../prng.js";
import type { HandlerOutcome } from "./types.js";

const MOCK_MODEL = "claude-mock";

const FILLER_SENTENCES = [
  "The subject shows consistent patterns across the available sources.",
  "Several independent references corroborate the central claim.",
  "There is moderate uncertainty around the more recent developments.",
  "Key stakeholders appear aligned on the overall direction.",
  "The data suggests a gradual but steady trend over the observed period.",
  "Further verification would help resolve the remaining ambiguities.",
  "The tone across sources is largely neutral with occasional caveats.",
  "A few outliers diverge from the mainstream interpretation.",
];

function fabricateParagraph(rng: () => number, sentenceCount: number): string {
  const sentences: string[] = [];
  for (let i = 0; i < sentenceCount; i++) {
    sentences.push(pick(rng, FILLER_SENTENCES));
  }
  return sentences.join(" ");
}

function untrustedString(value: unknown, fallback: string, maxLen = 200): string {
  if (typeof value !== "string" || value.trim() === "") return fallback;
  return value.slice(0, maxLen);
}

export interface MockLlmSpec {
  /** Label used in the fabricated output, e.g. "research findings". */
  label: string;
  /** Sentence count range for the fabricated body. */
  sentenceRange: [number, number];
  /** Approximate output-token multiplier per sentence (for plausible-looking counts). */
  tokensPerSentence: [number, number];
  /** Sleep range in ms, to make the demo board feel alive. */
  sleepRangeMs: [number, number];
}

/**
 * Runs a generic mock-LLM handler: sleeps a pseudo-random short duration,
 * fabricates text output, and reports plausible token metrics.
 * `task.payload` is treated as untrusted — only read defensively, never executed.
 */
export async function runMockLlm(
  task: ClaimedTask,
  spec: MockLlmSpec,
): Promise<HandlerOutcome> {
  const rng = createPrng(`${task.id}:${task.type}`);
  const payload = task.payload as Record<string, unknown>;

  const sentenceCount = randInt(rng, spec.sentenceRange[0], spec.sentenceRange[1]);
  const sleepMs = randInt(rng, spec.sleepRangeMs[0], spec.sleepRangeMs[1]);
  await new Promise((resolve) => setTimeout(resolve, sleepMs));

  const topic = untrustedString(
    payload.topic ?? payload.url ?? payload.text ?? payload.title,
    `task ${task.id.slice(0, 8)}`,
  );

  const body = fabricateParagraph(rng, sentenceCount);
  const output = `${spec.label} for "${topic}": ${body}`;

  const inputTokens = randInt(rng, 80, 600);
  const perSentence = randInt(rng, spec.tokensPerSentence[0], spec.tokensPerSentence[1]);
  const outputTokens = sentenceCount * perSentence + randInt(rng, 10, 60);
  const totalTokens = inputTokens + outputTokens;
  const costUsd = Number(((totalTokens / 1000) * 0.003).toFixed(6));

  return {
    result: {
      output,
      topic,
      sentence_count: sentenceCount,
    },
    metrics: {
      model: MOCK_MODEL,
      tokens: { input: inputTokens, output: outputTokens, total: totalTokens },
      cost_usd: costUsd,
    },
  };
}
