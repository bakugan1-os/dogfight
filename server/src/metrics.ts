// Lab 8: /metrics in the Prometheus text format (prom-client). Counters only go up — a dashboard
// (Grafana, or `rate()` in Prometheus) turns them into "per second"; gauges are read at scrape
// time through `collect()`, so the hot paths (ws.ts, match.ts) only bump plain numbers.
//
//   dogfight_players / _bots / _rooms / _connections     gauges
//   dogfight_ws_messages_total{direction="in"|"out"}     counter  -> msg/s
//   dogfight_ws_bytes_total{direction}                   counter  -> bytes/s
//   dogfight_ws_rejected_total{reason}                   counter  (origin, per_ip, full, rate_limit…)
//   dogfight_tick_duration_seconds{room}                 histogram -> tick p99 per room
//   dogfight_tick_p99_ms{room} / dogfight_tick_jitter_p95_ms{room}   gauges (last 60 s / 10 s)
//   dogfight_event_loop_utilization                      gauge (0..1, last second)
//   process_resident_memory_bytes, nodejs_*              prom-client's default metrics (RSS, GC…)
//
// A separate Registry per server (not the global one) so tests can run several servers.

import { Registry, Counter, Gauge, Histogram, collectDefaultMetrics } from "prom-client";
import type { MatchStats } from "./match.ts";
import type { SocketCounters } from "./ws.ts";

export type MetricsSources = {
  version: string;
  sha: string;
  counters: () => SocketCounters | undefined;
  connections: () => number;
  rooms: () => number;
  matches: () => MatchStats[];
  elu: () => number;
};

export type Metrics = {
  readonly registry: Registry;
  /** Called by every Match tick (ws.ts wires it): one histogram sample. */
  observeTick(roomId: string, ms: number): void;
  /** Forget a room's series when its match ends (no stale "tick p99" for a dead room). */
  forgetRoom(roomId: string): void;
  text(): Promise<string>;
  readonly contentType: string;
};

export function createMetrics(src: MetricsSources): Metrics {
  const registry = new Registry();
  collectDefaultMetrics({ register: registry });

  new Gauge({
    name: "dogfight_build_info",
    help: "1, labelled with the running version and git SHA",
    labelNames: ["version", "sha"],
    registers: [registry],
  })
    .labels(src.version, src.sha)
    .set(1);

  const gauge = (name: string, help: string, read: () => number) =>
    new Gauge({
      name,
      help,
      registers: [registry],
      collect() {
        this.set(read());
      },
    });
  const sum = (pick: (m: MatchStats) => number) => src.matches().reduce((n, m) => n + pick(m), 0);
  gauge("dogfight_players", "human players in matches", () => sum((m) => m.players - m.bots));
  gauge("dogfight_bots", "bots in matches", () => sum((m) => m.bots));
  gauge("dogfight_rooms", "rooms that exist", src.rooms);
  gauge("dogfight_matches", "running matches (rooms with players)", () => src.matches().length);
  gauge("dogfight_connections", "open WebSocket connections", src.connections);
  gauge("dogfight_event_loop_utilization", "share of the last second the loop was busy", src.elu);

  // Counters mirror the plain numbers in SocketCounters: inc() by the difference since last scrape.
  const mirrored = (
    name: string,
    help: string,
    labelNames: string[],
    read: (c: SocketCounters) => Record<string, number>,
  ) => {
    const last: Record<string, number> = {};
    return new Counter({
      name,
      help,
      labelNames,
      registers: [registry],
      collect() {
        const c = src.counters();
        if (!c) return;
        for (const [label, value] of Object.entries(read(c))) {
          const delta = value - (last[label] ?? 0);
          if (delta > 0) this.labels(label).inc(delta);
          last[label] = value;
        }
      },
    });
  };
  mirrored("dogfight_ws_messages_total", "WebSocket messages", ["direction"], (c) => ({
    in: c.messagesIn,
    out: c.messagesOut,
  }));
  mirrored("dogfight_ws_bytes_total", "WebSocket payload bytes", ["direction"], (c) => ({
    in: c.bytesIn,
    out: c.bytesOut,
  }));
  mirrored(
    "dogfight_ws_rejected_total",
    "connections refused or closed by the server, by reason",
    ["reason"],
    (c) => c.rejections,
  );

  const perRoom = (name: string, help: string, read: (m: MatchStats) => number) =>
    new Gauge({
      name,
      help,
      labelNames: ["room"],
      registers: [registry],
      collect() {
        this.reset(); // rooms come and go: only the live ones
        for (const m of src.matches()) this.labels(m.room).set(read(m));
      },
    });
  perRoom("dogfight_tick_p99_ms", "tick duration p99 over the last 60 s", (m) => m.tickMs.p99);
  perRoom(
    "dogfight_tick_jitter_p95_ms",
    "tick start lateness p95 (last 10 s)",
    (m) => m.jitter.p95Ms,
  );

  const ticks = new Histogram({
    name: "dogfight_tick_duration_seconds",
    help: "time one simulation tick took",
    labelNames: ["room"],
    buckets: [0.0005, 0.001, 0.002, 0.004, 0.008, 0.016, 0.033, 0.066],
    registers: [registry],
  });

  return {
    registry,
    observeTick: (roomId, ms) => ticks.labels(roomId).observe(ms / 1000),
    forgetRoom: (roomId) => ticks.remove(roomId),
    text: () => registry.metrics(),
    contentType: registry.contentType,
  };
}
