// Lab 7: performance.mark/measure instrumentation of the four hot phases. Off by default
// (?perf=1 turns it on): a measure is an object, and objects are what we are hunting.
// When on, every phase shows up in the DevTools Performance panel ("Timings" track) and its
// durations are kept in a fixed ring buffer for summary() — no allocation per sample.

export type Phase = "simulate" | "render" | "decode" | "reconcile";
const PHASES: readonly Phase[] = ["simulate", "render", "decode", "reconcile"];
const SAMPLES = 4096;

const enabled =
  typeof location !== "undefined" && new URLSearchParams(location.search).get("perf") === "1";
const rings = new Map(PHASES.map((p) => [p, { values: new Float64Array(SAMPLES), count: 0 }]));

/** Start of a phase: a timestamp (0 when instrumentation is off). */
export function begin(): number {
  return enabled ? performance.now() : 0;
}

/** End of a phase: one performance.measure + one ring-buffer sample. */
export function end(phase: Phase, start: number): void {
  if (!enabled) return;
  const now = performance.now();
  performance.measure(phase, { start, end: now });
  const ring = rings.get(phase);
  if (ring) ring.values[ring.count++ % SAMPLES] = now - start;
}

/** p50/p95/p99 per phase, in ms, over the last 4096 samples (for the profiling script). */
export function summary(): Record<string, { n: number; p50: number; p95: number; p99: number }> {
  const out: Record<string, { n: number; p50: number; p95: number; p99: number }> = {};
  for (const [phase, ring] of rings) {
    const n = Math.min(ring.count, SAMPLES);
    const sorted = Array.from(ring.values.subarray(0, n)).sort((a, b) => a - b);
    const q = (p: number) => sorted[Math.min(n - 1, Math.floor(n * p))] ?? 0;
    out[phase] = { n, p50: q(0.5), p95: q(0.95), p99: q(0.99) };
  }
  performance.clearMeasures();
  return out;
}

export const perfEnabled = enabled;
