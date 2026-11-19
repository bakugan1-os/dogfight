// Latency injector (Lab 5). Localhost has ~0 ms latency, and on 0 ms every netcode looks fine.
// Each socket can get an artificial one-way delay of lag/2 ± jitter/2 in BOTH directions
// (so `lag` ≈ the added round-trip time), plus a drop rate for the real-time frames (inputs and
// snapshots). TCP never reorders, so delivery times are kept monotonic per direction.
//
//   ws://host/ws?lag=100&jitter=30&drop=0.02      or live: {"type":"netsim","lag":…}

import type { NetsimSettings } from "@dogfight/shared/protocol/control.ts";

export const NO_NETSIM: NetsimSettings = Object.freeze({ lag: 0, jitter: 0, drop: 0 });

/** From URL query parameters; anything missing or not a number is 0, values are clamped. */
export function parseNetsim(params: URLSearchParams): NetsimSettings {
  const num = (name: string, max: number) => {
    const v = Number(params.get(name));
    return Number.isFinite(v) ? Math.min(Math.max(v, 0), max) : 0;
  };
  return { lag: num("lag", 2000), jitter: num("jitter", 1000), drop: num("drop", 0.5) };
}

type Deliver = () => void;

export type Link = {
  readonly settings: NetsimSettings;
  readonly stats: { dropped: number };
  set(next: Partial<NetsimSettings>): void;
  /** Incoming frame (client -> server). */
  in(fn: Deliver, droppable?: boolean): void;
  /** Outgoing frame (server -> client). */
  out(fn: Deliver, droppable?: boolean): void;
};

export function createLink(
  config: NetsimSettings = NO_NETSIM,
  random: () => number = Math.random,
): Link {
  let settings = { ...config };
  const stats = { dropped: 0 };

  function delay() {
    return Math.max(0, settings.lag / 2 + (random() * 2 - 1) * (settings.jitter / 2));
  }

  /**
   * One FIFO per direction drained by one timer. (A setTimeout per frame is NOT enough: Node
   * groups timers by duration, so two frames due at the same moment can fire out of order —
   * found by the test below. TCP never reorders, so neither may we.)
   */
  function createPipe() {
    const queue: Array<{ at: number; fn: Deliver }> = []; // `at` non-decreasing
    let timer: ReturnType<typeof setTimeout> | null = null;
    const drain = () => {
      timer = null;
      const now = performance.now();
      for (let head = queue[0]; head && head.at <= now + 0.5; head = queue[0]) {
        queue.shift();
        head.fn();
      }
      const next = queue[0];
      if (next) timer = setTimeout(drain, next.at - now);
    };
    return (fn: Deliver, droppable: boolean) => {
      if (droppable && settings.drop > 0 && random() < settings.drop) {
        stats.dropped++;
        return;
      }
      if (!settings.lag && !settings.jitter && !queue.length) return fn();
      const now = performance.now();
      const at = Math.max(queue.at(-1)?.at ?? 0, now + delay());
      queue.push({ at, fn });
      timer ??= setTimeout(drain, at - now);
    };
  }

  const incoming = createPipe();
  const outgoing = createPipe();
  return {
    get settings() {
      return settings;
    },
    stats,
    set(next) {
      settings = { ...settings, ...next };
    },
    in: (fn, droppable = false) => incoming(fn, droppable),
    out: (fn, droppable = false) => outgoing(fn, droppable),
  };
}
