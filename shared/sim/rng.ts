// Seeded pseudo-random generator (mulberry32). Math.random() is not reproducible; the
// simulation must be: same seed + same inputs -> same world. Lab 5 depends on that.

export type Rng = {
  next(): number;
  /** float in [min, max) */
  range(min: number, max: number): number;
  /** integer in [min, max] */
  int(min: number, max: number): number;
  /** a random element; the array must not be empty */
  pick<T>(array: readonly [T, ...T[]]): T;
};

export function createRng(seed = 1): Rng {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    range: (min, max) => min + (max - min) * next(),
    int: (min, max) => Math.floor(min + (max - min + 1) * next()),
    // noUncheckedIndexedAccess: array[i] is T | undefined even for a valid i; the non-empty
    // tuple type lets us fall back to array[0], which IS a T.
    pick: (array) => array[Math.floor(next() * array.length)] ?? array[0],
  };
}
