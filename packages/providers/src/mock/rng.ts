/**
 * Deterministic pseudo-random numbers.
 *
 * The MockProvider must be reproducible: the same mission prompt and the same
 * agent produce the same output every time. That makes the simulated pipeline
 * testable with plain equality assertions instead of snapshot fuzziness.
 */

/** FNV-1a, 32-bit. Fast, dependency-free, good enough to seed a PRNG. */
export function hashString(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** mulberry32 — small, fast, well-distributed for simulation purposes. */
export function createRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function randomInt(rng: () => number, min: number, max: number): number {
  return Math.floor(rng() * (max - min + 1)) + min;
}

export function pick<T>(rng: () => number, items: readonly T[]): T {
  if (items.length === 0) throw new Error('pick() called with an empty list.');
  const item = items[Math.floor(rng() * items.length)];
  // `noUncheckedIndexedAccess` cannot see that the index is in range.
  return item as T;
}
