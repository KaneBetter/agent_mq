// Deterministic pseudo-randomness derived from a seed string (e.g. task.id).
// Used by mock handlers so repeated runs against the same task are reproducible
// and so we deliberately avoid Math.random() per the build contract.

/** Simple string hash (djb2) turned into a 32-bit unsigned seed. */
function seedFrom(seed: string): number {
  let hash = 5381;
  for (let i = 0; i < seed.length; i++) {
    hash = ((hash << 5) + hash + seed.charCodeAt(i)) >>> 0;
  }
  return hash >>> 0;
}

/** A small mulberry32-style PRNG, seeded deterministically from a string. */
export function createPrng(seed: string): () => number {
  let state = seedFrom(seed);
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Integer in [min, max] inclusive, derived from the given seeded rng. */
export function randInt(rng: () => number, min: number, max: number): number {
  return Math.floor(rng() * (max - min + 1)) + min;
}

/** Pick an element from a non-empty array using the seeded rng. */
export function pick<T>(rng: () => number, items: readonly T[]): T {
  const idx = Math.floor(rng() * items.length) % items.length;
  return items[idx] as T;
}
