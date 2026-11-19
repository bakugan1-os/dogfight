// Test helpers shared by the server tests (Lab 6: typed). A real server on a random port, and a
// test client that PARSES what the server sends with the same schema the browser uses.

import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { WebSocket, type ClientOptions, type RawData } from "ws";
import { loadConfig, type ServerConfig } from "../src/config.ts";
import { createGameServer, type GameServer } from "../src/index.ts";
import {
  PROTOCOL_VERSION,
  parseServerMessage,
  type ServerMessage,
  type ServerMessageOf,
  type ServerMessageType,
} from "@dogfight/shared/protocol/control.ts";

const tmpDirs: string[] = [];
export const cleanupTmp = () =>
  Promise.all(tmpDirs.map((d) => rm(d, { recursive: true, force: true })));

export async function tmpDir(prefix = "dogfight-"): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

export type TestServer = {
  game: GameServer;
  config: ServerConfig;
  port: number;
  base: string;
  ws: string;
  dir: string;
};

export async function startServer(env: Record<string, string> = {}): Promise<TestServer> {
  const dir = await tmpDir();
  const staticDir = join(dir, "static");
  await mkdir(staticDir);
  await writeFile(join(staticDir, "index.html"), "<!doctype html><title>t</title>");
  const config = loadConfig({
    PORT: "0",
    QUIET: "true",
    LOG_DIR: join(dir, "logs"),
    STATIC_DIR: staticDir,
    ...env,
  });
  const game = await createGameServer(config);
  const { port } = await game.listen();
  return {
    game,
    config,
    port,
    base: `http://127.0.0.1:${port}`,
    ws: `ws://127.0.0.1:${port}/ws`,
    dir,
  };
}

const isType = <T extends ServerMessageType>(m: ServerMessage, type: T): m is ServerMessageOf<T> =>
  m.type === type;

export type TestClient = {
  ws: WebSocket;
  /** binary frames (Lab 5: snapshots, 30 per second) */
  snapshots: Buffer[];
  opened: Promise<unknown>;
  closed: Promise<{ code: number; reason: string }>;
  send(msg: string | Uint8Array | object): void;
  /** Waits for the next message of that type — typed: next("roster") gives a roster message. */
  next<T extends ServerMessageType>(type: T): Promise<ServerMessageOf<T>>;
};

const toBuffer = (data: RawData): Buffer =>
  Array.isArray(data) ? Buffer.concat(data) : Buffer.isBuffer(data) ? data : Buffer.from(data);

export function client(url: string, options?: ClientOptions): TestClient {
  const ws = new WebSocket(url, options);
  const inbox: ServerMessage[] = [];
  const waiters: Array<{ type: ServerMessageType; deliver: (m: ServerMessage) => void }> = [];
  const snapshots: Buffer[] = [];
  ws.on("message", (data, isBinary) => {
    if (isBinary) return void snapshots.push(toBuffer(data));
    const parsed = parseServerMessage(data);
    if (!parsed.ok) throw new Error(`server sent an invalid message: ${parsed.reason}`);
    const msg = parsed.msg;
    const i = waiters.findIndex((w) => w.type === msg.type);
    if (i >= 0) waiters.splice(i, 1)[0]?.deliver(msg);
    else inbox.push(msg);
  });
  ws.on("error", () => {});
  return {
    ws,
    snapshots,
    opened: once(ws, "open"),
    closed: new Promise((resolve) =>
      ws.on("close", (code, reason) => resolve({ code, reason: String(reason) })),
    ),
    send: (msg) =>
      ws.send(typeof msg === "string" || msg instanceof Uint8Array ? msg : JSON.stringify(msg)),
    next(type) {
      const i = inbox.findIndex((m) => m.type === type);
      const found = inbox[i];
      if (found && isType(found, type)) {
        inbox.splice(i, 1);
        return Promise.resolve(found);
      }
      return new Promise((resolve) =>
        waiters.push({ type, deliver: (m) => (isType(m, type) ? resolve(m) : undefined) }),
      );
    },
  };
}

export async function joined(
  url: string,
  room: string,
  name: string,
): Promise<TestClient & { id: string }> {
  const c = client(url);
  await c.opened;
  c.send({ type: "join", v: PROTOCOL_VERSION, room, name });
  const welcome = await c.next("welcome");
  return { ...c, id: welcome.playerId };
}

export async function until(cond: () => boolean, ms = 2000): Promise<void> {
  const t0 = performance.now();
  while (!cond()) {
    if (performance.now() - t0 > ms) throw new Error("timeout");
    await new Promise((r) => setTimeout(r, 10));
  }
}
