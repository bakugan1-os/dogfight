// Entry point: one node:http server for the static client + JSON API, the WebSocket server on
// the same port (/ws), rooms and match logs. `createGameServer` builds everything without
// listening, so the tests can start a real server on a random port.

import { createServer } from "node:http";
import { join } from "node:path";
import { RoomManager } from "./rooms.js";
import { createRequestHandler } from "./http.js";
import { attachWebSockets } from "./ws.js";
import { createMatchLogger } from "./log/matchlog.js";
import { loadConfig, ConfigError } from "./config.js";

export async function createGameServer(config, { log = console.log } = {}) {
  const say = config.quiet ? () => {} : (msg) => log(`${new Date().toISOString()} ${msg}`);
  const rooms = new RoomManager({
    maxRooms: config.maxRooms,
    maxPlayersPerRoom: config.maxPlayersPerRoom,
  });
  rooms.on("deleted", (room) => say(`room ${room.id} deleted`));
  const matchLogs = await createMatchLogger(rooms, { dir: config.logDir, log: say });

  const startedAt = Date.now();
  let sockets = null;
  const stats = () => ({
    uptimeS: Math.round((Date.now() - startedAt) / 1000),
    rooms: rooms.size,
    connections: sockets?.connections ?? 0,
    openLogs: matchLogs.open,
    rssMB: Math.round((process.memoryUsage().rss / 2 ** 20) * 10) / 10,
  });

  const handle = createRequestHandler({ config, rooms, stats, log: say });
  const server = createServer((req, res) => {
    handle(req, res);
  });
  server.on("clientError", (error, socket) => socket.destroy(error)); // malformed HTTP
  sockets = attachWebSockets(server, { config, rooms, log: say });

  let stopping = null;
  return {
    server,
    rooms,
    sockets,
    matchLogs,
    stats,
    listen() {
      return new Promise((resolve, reject) => {
        server.once("error", reject); // EADDRINUSE etc. -> a clear startup failure
        server.listen(config.port, config.host, () => {
          server.off("error", reject);
          resolve(server.address());
        });
      });
    },
    /** Graceful shutdown: stop accepting, close sockets (1001), end match logs, close server. */
    stop() {
      stopping ??= (async () => {
        const closing = new Promise((resolve) => server.close(resolve)); // stop accepting
        await sockets.shutdown();
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
function loadDotEnv() {
  try {
    process.loadEnvFile(join(import.meta.dirname, "..", ".env"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

async function main() {
  loadDotEnv();
  let config;
  try {
    config = loadConfig(process.env);
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    console.error(error.message);
    process.exit(2);
  }
  const game = await createGameServer(config);
  let address;
  try {
    address = await game.listen();
  } catch (error) {
    if (error.code !== "EADDRINUSE") throw error;
    console.error(`port ${config.port} is already in use (another server running?). Set PORT=…`);
    process.exit(1);
  }
  console.log(
    `dogfight server on http://${address.address}:${address.port}  (static: ${config.staticDir}, logs: ${config.logDir})`,
  );

  let signals = 0;
  const shutdown = async (signal) => {
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
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

// Run only when started directly (`node src/index.js`), not when imported by the tests.
if (import.meta.filename === process.argv[1]) main();
