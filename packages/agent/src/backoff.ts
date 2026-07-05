// Exponential backoff with jitter for the idle poll loop: minMs -> 60s ceiling
// (default minMs 2000, i.e. 2s -> 60s per the build contract).
const DEFAULT_MIN_MS = 2000;
const MAX_MS = 60_000;

export class Backoff {
  private attempt = 0;
  private readonly minMs: number;

  constructor(minMs: number = DEFAULT_MIN_MS) {
    this.minMs = Math.max(1, minMs);
  }

  /** Reset to the minimum delay (call after a successful claim). */
  reset(): void {
    this.attempt = 0;
  }

  /** Compute the next delay (ms) and advance the attempt counter. */
  next(): number {
    const base = Math.min(this.minMs * 2 ** this.attempt, MAX_MS);
    this.attempt += 1;
    const jitter = base * (0.5 + Math.random() * 0.5); // 50%-100% of base
    return Math.min(Math.round(jitter), MAX_MS);
  }
}

export function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
