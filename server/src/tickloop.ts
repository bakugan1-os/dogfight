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

  readonly hz: number;
  readonly period: number;
  readonly onTick: () => void;
  readonly now: () => number;
  readonly stats: TickStats = { ticks: 0, avgTickMs: 0, maxTickMs: 0, overruns: 0 };

  constructor(hz: number, onTick: () => void, { now = () => performance.now() } = {}) {
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

  /** Mean and p95 of |interval − period| over the last 300 ticks, in ms. */
  jitter(): { meanMs: number; p95Ms: number } {
    const n = Math.min(this.#jitterCount, this.#jitters.length);
    if (!n) return { meanMs: 0, p95Ms: 0 };
    const sorted = Array.from(this.#jitters.subarray(0, n)).sort((a, b) => a - b);
    const mean = sorted.reduce((a, b) => a + b, 0) / n;
    return { meanMs: mean, p95Ms: sorted[Math.min(n - 1, Math.floor(n * 0.95))] ?? 0 };
  }
}
