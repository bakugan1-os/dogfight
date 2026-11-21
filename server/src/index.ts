// Entry point: one node:http server for the static client + JSON API, the WebSocket server on
// the same port (/ws), rooms and match logs. `createGameServer` builds everything without
// listening, so the tests can start a real server on a random port.

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { RoomManager } from "./rooms.ts";
import { createRequestHandler } from "./http.ts";
import { attachWebSockets, type Sockets } from "./ws.ts";
import { createMatchLogger, type MatchLogger } from "./log/matchlog.ts";
import { loadConfig, ConfigError, type ServerConfig } from "./config.ts";
import { errorCode, errorMessage } from "./errors.ts";

export type ServerStats = {
  uptimeS: number;
  rooms: number;
  connections: number;
  openLogs: number;
  rssMB: number;
};

export type GameServer = {
  server: Server;
  rooms: RoomManager;
  sockets: Sockets;
  matchLogs: MatchLogger;
  stats(): ServerStats;
  listen(): Promise<AddressInfo>;
  stop(): Promise<void>;
};

export async function createGameServer(
  config: ServerConfig,
  { log = console.log }: { log?: (line: string) => void } = {},
): Promise<GameServer> {
  const say = config.quiet ? () => {} : (msg: string) => log(`${new Date().toISOString()} ${msg}`);
  const rooms = new RoomManager({
    maxRooms: config.maxRooms,
    maxPlayersPerRoom: config.maxPlayersPerRoom,
  });
  rooms.on("deleted", (room) => say(`room ${room.id} deleted`));
  const matchLogs = await createMatchLogger(rooms, { dir: config.logDir, log: say });

  const startedAt = Date.now();
  let sockets: Sockets | null = null;
  const stats = (): ServerStats => ({
    uptimeS: Math.round((Date.now() - startedAt) / 1000),
    rooms: rooms.size,
    connections: sockets?.connections ?? 0,
    openLogs: matchLogs.open,
    rssMB: Math.round((process.memoryUsage().rss / 2 ** 20) * 10) / 10,
  });

  const handle = createRequestHandler({
    config,
    rooms,
    stats,
    matchStats: () => sockets?.matchStats() ?? [],
    log: say,
  });
  const server = createServer((req, res) => {
    // Lab 7 (no-floating-promises): handle() catches its own errors, but if its catch block
    // itself threw, this promise would reject with nobody listening -> the process would die.
    handle(req, res).catch((error: unknown) => {
      say(`request handler crashed: ${errorMessage(error)}`);
      res.destroy();
    });
  });
  server.on("clientError", (error, socket) => socket.destroy(error)); // malformed HTTP
  const ws = attachWebSockets(server, { config, rooms, log: say });
  sockets = ws;

  let stopping: Promise<void> | null = null;
  return {
    server,
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
        say("server stopped");
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
    console.error(error.message);
    process.exit(2);
  }
  const game = await createGameServer(config);
  let address: AddressInfo;
  try {
    address = await game.listen();
  } catch (error: unknown) {
    if (errorCode(error) !== "EADDRINUSE") throw error;
    console.error(`port ${config.port} is already in use (another server running?). Set PORT=…`);
    process.exit(1);
  }
  console.log(
    `dogfight server on http://${address.address}:${address.port}  (static: ${config.staticDir}, logs: ${config.logDir})`,
  );

  let signals = 0;
  const shutdown = async (signal: NodeJS.Signals) => {
    if (++signals > 1) {
      console.log("second signal: exiting now");
      process.exit(1);
    }
    console.log(`${signal}: shutting down…`);
    const force = setTimeout(() => {
      console.error("shutdown took > 5 s, forcing exit");
      process.exit(1);
    }, 5000);
    force.unref();
    await game.stop();
    process.exitCode = 0; // let the event loop drain and exit by itself
  };
  // An async function passed where Node expects a plain callback: its promise is dropped, so a
  // failing game.stop() would become an unhandled rejection (no-misused-promises). Catch it here.
  const onSignal = (signal: NodeJS.Signals) => {
    shutdown(signal).catch((error: unknown) => {
      console.error(`shutdown failed: ${errorMessage(error)}`);
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
