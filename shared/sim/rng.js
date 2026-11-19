// Seeded pseudo-random generator (mulberry32). Math.random() is not reproducible; the
// simulation must be: same seed + same inputs -> same world. Lab 5 depends on that.

export function createRng(seed = 1) {
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
    /** float in [min, max) */
    range: (min, max) => min + (max - min) * next(),
    /** integer in [min, max] */
    int: (min, max) => Math.floor(min + (max - min + 1) * next()),
    pick: (array) => array[Math.floor(next() * array.length)],
  };
}
