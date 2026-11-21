// Entry point: one node:http server for the static client + JSON API, the WebSocket server on
// the same port (/ws), rooms and match logs. `createGameServer` builds everything without
// listening, so the tests can start a real server on a random port.
//
// Lab 8 — a good citizen under a supervisor (Docker, Fly, Render):
//   SIGTERM  -> /ready says 503 -> stop accepting -> "shutdown" + close 1001 to every client
//            -> match logs flushed -> exit 0, all well inside the platform's 10 s grace
//   a crash  -> uncaughtException / unhandledRejection: log the stack, exit 1, let the supervisor
//              start a clean process (never "stay up" with state we don't understand)
//   logs     -> pino JSON lines on stdout;  /metrics -> prom-client (metrics.ts)

import { createServer, type Server } from "node:http";
import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { RoomManager } from "./rooms.ts";
import { createRequestHandler } from "./http.ts";
import { attachWebSockets, type Sockets } from "./ws.ts";
import { createMatchLogger, type MatchLogger } from "./log/matchlog.ts";
import { loadConfig, ConfigError, type ServerConfig } from "./config.ts";
import { errorCode } from "./errors.ts";
import { createLogger, type Logger } from "./logger.ts";
import { createMetrics, type Metrics } from "./metrics.ts";

/** The product version: the root package.json (bumped per release, `v1.0.0` tag). */
export const VERSION: string = (() => {
  const raw: unknown = JSON.parse(
    readFileSync(join(import.meta.dirname, "..", "..", "package.json"), "utf8"),
  );
  return typeof raw === "object" && raw && "version" in raw && typeof raw.version === "string"
    ? raw.version
    : "0.0.0";
})();

export type ServerStats = {
  uptimeS: number;
  rooms: number;
  connections: number;
  openLogs: number;
  rssMB: number;
  elu: number;
};

export type GameServer = {
  server: Server;
  log: Logger;
  metrics: Metrics;
  /** false once stop() has begun (readiness) */
  readonly ready: boolean;
  rooms: RoomManager;
  sockets: Sockets;
  matchLogs: MatchLogger;
  stats(): ServerStats;
  listen(): Promise<AddressInfo>;
  stop(): Promise<void>;
};

export async function createGameServer(
  config: ServerConfig,
  { log = createLogger(config) }: { log?: Logger } = {},
): Promise<GameServer> {
  const rooms = new RoomManager({
    maxRooms: config.maxRooms,
    maxPlayersPerRoom: config.maxPlayersPerRoom,
  });
  rooms.on("deleted", (room) => log.info({ event: "room.deleted", roomId: room.id }));
  const matchLogs = await createMatchLogger(rooms, { dir: config.logDir, log });

  const startedAt = Date.now();
  let sockets: Sockets | null = null;
  // Lab 7: event-loop utilization over the last second (0 = idle, 1 = never idle).
  let eluPrev = performance.eventLoopUtilization();
  let elu = 0;
  const eluTimer = setInterval(() => {
    const now = performance.eventLoopUtilization();
    elu = performance.eventLoopUtilization(now, eluPrev).utilization;
    eluPrev = now;
  }, 1000);
  eluTimer.unref();
  const stats = (): ServerStats => ({
    uptimeS: Math.round((Date.now() - startedAt) / 1000),
    rooms: rooms.size,
    connections: sockets?.connections ?? 0,
    openLogs: matchLogs.open,
    rssMB: Math.round((process.memoryUsage().rss / 2 ** 20) * 10) / 10,
    elu: Math.round(elu * 1000) / 1000,
  });

  let stopping: Promise<void> | null = null;
  const metrics = createMetrics({
    version: VERSION,
    sha: config.gitSha,
    counters: () => sockets?.counters,
    connections: () => sockets?.connections ?? 0,
    rooms: () => rooms.size,
    matches: () => sockets?.matchStats() ?? [],
    elu: () => elu,
  });

  const handle = createRequestHandler({
    config,
    rooms,
    stats,
    matchStats: () => sockets?.matchStats() ?? [],
    addBots: (roomId, count) => sockets?.addBots(roomId, count) ?? 0,
    log,
    ready: () => stopping === null,
    version: { version: VERSION, sha: config.gitSha },
    metrics,
  });
  const server = createServer((req, res) => {
    // Lab 7 (no-floating-promises): handle() catches its own errors, but if its catch block
    // itself threw, this promise would reject with nobody listening -> the process would die.
    handle(req, res).catch((err: unknown) => {
      log.error({ event: "http.handler_crashed", err });
      res.destroy();
    });
  });
  server.on("clientError", (error, socket) => socket.destroy(error)); // malformed HTTP
  const ws = attachWebSockets(server, {
    config,
    rooms,
    log,
    onTick: metrics.observeTick,
    onMatchEnd: metrics.forgetRoom,
  });
  sockets = ws;

  return {
    server,
    log,
    metrics,
    get ready() {
      return stopping === null;
    },
    rooms,
    sockets: ws,
    matchLogs,
    stats,
    listen() {
      return new Promise((resolve, reject) => {
        server.once("error", reject); // EADDRINUSE etc. -> a clear startup failure
        server.listen(config.port, config.host, () => {
          server.off("error", reject);
          const address = server.address();
          // address() is a string only for a pipe/socket path; we listen on a TCP port.
          if (address === null || typeof address === "string")
            reject(new Error("not a TCP address"));
          else resolve(address);
        });
      });
    },
    /** Graceful shutdown: stop accepting, close sockets (1001), end match logs, close server. */
    stop() {
      stopping ??= (async () => {
        const closing = new Promise<void>((resolve) => server.close(() => resolve())); // stop accepting
        await ws.shutdown();
        rooms.closeAll(); // every room emits "close" -> its match log pipeline finishes
        await matchLogs.flush();
        server.closeAllConnections(); // idle keep-alive HTTP connections
        await closing;
        clearInterval(eluTimer);
        log.info({ event: "server.stopped" });
      })();
      return stopping;
    },
  };
}

/**
 * Reads server/.env if it exists (Node 22 built-in, like `node --env-file`). Done in code rather
 * than with `--env-file-if-exists` because `node --watch` crashes when that file is missing.
 */
function loadDotEnv(): void {
  try {
    process.loadEnvFile(join(import.meta.dirname, "..", ".env"));
  } catch (error: unknown) {
    if (errorCode(error) !== "ENOENT") throw error;
  }
}

async function main(): Promise<void> {
  loadDotEnv();
  let config: ServerConfig;
  try {
    config = loadConfig(process.env);
  } catch (error: unknown) {
    if (!(error instanceof ConfigError)) throw error;
    console.error(error.message); // no logger yet: its level is part of the config
    process.exit(2);
  }
  const log = createLogger(config);

  // Crash on unknowns: log WHAT happened (with the stack), then exit non-zero. The supervisor
  // restarts a clean process; staying up would keep serving from a state nobody understands.
  // pino writes synchronously to stdout by default, so the line is out before exit().
  process.on("uncaughtException", (err, origin) => {
    log.fatal({ event: "process.crash", origin, err });
    process.exit(1);
  });
  process.on("unhandledRejection", (reason) => {
    log.fatal({ event: "process.crash", origin: "unhandledRejection", err: reason });
    process.exit(1);
  });

  const game = await createGameServer(config, { log });
  let address: AddressInfo;
  try {
    address = await game.listen();
  } catch (error: unknown) {
    if (errorCode(error) !== "EADDRINUSE") throw error;
    log.fatal({ event: "server.port_in_use", port: config.port });
    process.exit(1);
  }
  log.info({
    event: "server.listening",
    url: `http://${address.address}:${address.port}`,
    staticDir: config.staticDir,
    logDir: config.logDir,
    node: process.version,
  });

  let signals = 0;
  const shutdown = async (signal: NodeJS.Signals) => {
    if (++signals > 1) {
      log.warn({ event: "server.second_signal", signal });
      process.exit(1);
    }
    const t0 = performance.now();
    log.info({ event: "server.shutdown", signal, connections: game.sockets.connections });
    // Docker waits 10 s after SIGTERM, then SIGKILLs: leave ourselves a margin.
    const force = setTimeout(() => {
      log.error({ event: "server.shutdown_timeout" });
      process.exit(1);
    }, 9000);
    force.unref();
    await game.stop();
    log.info({ event: "server.exit", code: 0, ms: Math.round(performance.now() - t0) });
    log.flush();
    process.exitCode = 0; // let the event loop drain and exit by itself
  };
  // An async function passed where Node expects a plain callback: its promise is dropped, so a
  // failing game.stop() would become an unhandled rejection (no-misused-promises). Catch it here.
  const onSignal = (signal: NodeJS.Signals) => {
    shutdown(signal).catch((err: unknown) => {
      log.fatal({ event: "server.shutdown_failed", err });
      process.exit(1);
    });
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
}

// Run only when started directly (`node src/index.ts`), not when imported by the tests.
if (import.meta.filename === process.argv[1]) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
}
