// The server's fixed-rate loop (Lab 5). NOT setInterval: setInterval(fn, 33) schedules relative
// to the previous callback, so every late callback shifts all later ones (drift), and timers can
// coalesce. Here each tick is scheduled against an ABSOLUTE target time:
//
//   next += 1000 / hz;  setTimeout(run, next - now)
//
// A late tick makes the next delay shorter, so the average rate stays exactly `hz`. If a tick
// overruns badly (CPU-bound: the Lab 7 problem) we resynchronise instead of firing a burst.

export type TickStats = { ticks: number; avgTickMs: number; maxTickMs: number; overruns: number };

export class TickLoop {
  #timer: ReturnType<typeof setTimeout> | null = null;
  #next = 0;
  #lastStart = 0;
  readonly #jitters = new Float64Array(300); // ring buffer of |actual interval − period|, ms
  #jitterCount = 0;
  readonly #durations = new Float64Array(1800); // Lab 7: last 60 s of tick durations, ms
  #durationCount = 0;

  readonly hz: number;
  readonly period: number;
  readonly onTick: () => void;
  readonly now: () => number;
  readonly stats: TickStats = { ticks: 0, avgTickMs: 0, maxTickMs: 0, overruns: 0 };

  /** Lab 8: called with every tick's duration (ms) — feeds the /metrics histogram. */
  readonly onDuration: ((ms: number) => void) | undefined;

  constructor(
    hz: number,
    onTick: () => void,
    {
      now = () => performance.now(),
      onDuration,
    }: { now?: () => number; onDuration?: (ms: number) => void } = {},
  ) {
    this.onDuration = onDuration;
    this.hz = hz;
    this.period = 1000 / hz;
    this.onTick = onTick;
    this.now = now;
  }

  start(): void {
    if (this.#timer) return;
    this.#next = this.now();
    this.#lastStart = 0;
    this.#schedule();
  }

  stop(): void {
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
  }

  get running(): boolean {
    return this.#timer !== null;
  }

  #schedule(): void {
    this.#timer = setTimeout(() => this.#run(), Math.max(0, this.#next - this.now()));
  }

  #run(): void {
    const start = this.now();
    if (this.#lastStart) {
      this.#jitters[this.#jitterCount++ % this.#jitters.length] = Math.abs(
        start - this.#lastStart - this.period,
      );
    }
    this.#lastStart = start;
    this.onTick();
    const took = this.now() - start;
    this.#durations[this.#durationCount++ % this.#durations.length] = took;
    this.onDuration?.(took);
    const s = this.stats;
    s.ticks++;
    s.avgTickMs += (took - s.avgTickMs) * 0.05;
    s.maxTickMs = Math.max(s.maxTickMs, took);
    this.#next += this.period;
    if (this.now() - this.#next > this.period * 5) {
      s.overruns++;
      this.#next = this.now(); // hopelessly behind: skip ahead rather than burst-fire
    }
    if (this.#timer) this.#schedule();
  }

  /** Lab 7: p50/p99/max of the tick duration over the last 1800 ticks (60 s), in ms. */
  durations(): { p50: number; p99: number; max: number; n: number } {
    const n = Math.min(this.#durationCount, this.#durations.length);
    if (!n) return { p50: 0, p99: 0, max: 0, n };
    const sorted = Array.from(this.#durations.subarray(0, n)).sort((a, b) => a - b);
    const q = (p: number) => sorted[Math.min(n - 1, Math.floor(n * p))] ?? 0;
    return { p50: q(0.5), p99: q(0.99), max: sorted[n - 1] ?? 0, n };
  }

  /** Mean and p95 of |interval − period| over the last 300 ticks, in ms. */
  jitter(): { meanMs: number; p95Ms: number } {
    const n = Math.min(this.#jitterCount, this.#jitters.length);
    if (!n) return { meanMs: 0, p95Ms: 0 };
    const sorted = Array.from(this.#jitters.subarray(0, n)).sort((a, b) => a - b);
    const mean = sorted.reduce((a, b) => a + b, 0) / n;
    return { meanMs: mean, p95Ms: sorted[Math.min(n - 1, Math.floor(n * 0.95))] ?? 0 };
  }
}
