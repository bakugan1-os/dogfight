// Lab 4: config, protocol, rooms, HTTP API + static guard, WebSocket lifecycle, abuse limits,
// match logs, replay streaming, graceful shutdown. Real servers on random ports, real sockets.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request } from "node:http";
import { once } from "node:events";
import { WebSocket } from "ws";

import { loadConfig, ConfigError } from "../src/config.js";
import { parseClientMessage, CLOSE, PROTOCOL_VERSION } from "../src/protocol.js";
import { Room, RoomManager, RoomError } from "../src/rooms.js";
import { safeJoin } from "../src/http.js";
import { TokenBucket } from "../src/ratelimit.js";
import { NdjsonEncoder } from "../src/log/matchlog.js";
import { readReplay } from "../src/log/replay.js";
import { createGameServer } from "../src/index.js";
import { PROTOCOL_VERSION as CLIENT_VERSION } from "../../client/src/net/protocol.js";

const tmpDirs = [];
after(() => Promise.all(tmpDirs.map((d) => rm(d, { recursive: true, force: true }))));

async function startServer(env = {}) {
  const dir = await mkdtemp(join(tmpdir(), "dogfight-"));
  tmpDirs.push(dir);
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
  const base = `http://127.0.0.1:${port}`;
  return { game, config, port, base, ws: `ws://127.0.0.1:${port}/ws`, dir };
}

/** A test client: collects messages; `next(type)` waits for one of that type. */
function client(url, options) {
  const ws = new WebSocket(url, options);
  const inbox = [];
  const waiters = [];
  ws.on("message", (data) => {
    const msg = JSON.parse(String(data));
    const i = waiters.findIndex((w) => w.type === msg.type);
    if (i >= 0) waiters.splice(i, 1)[0].resolve(msg);
    else inbox.push(msg);
  });
  ws.on("error", () => {});
  return {
    ws,
    opened: once(ws, "open"),
    closed: new Promise((resolve) =>
      ws.on("close", (code, reason) => resolve({ code, reason: String(reason) })),
    ),
    send: (msg) => ws.send(typeof msg === "string" ? msg : JSON.stringify(msg)),
    next(type) {
      const i = inbox.findIndex((m) => m.type === type);
      if (i >= 0) return Promise.resolve(inbox.splice(i, 1)[0]);
      return new Promise((resolve) => waiters.push({ type, resolve }));
    },
  };
}

async function joined(url, room, name) {
  const c = client(url);
  await c.opened;
  c.send({ type: "join", v: PROTOCOL_VERSION, room, name });
  const welcome = await c.next("welcome");
  return { ...c, id: welcome.playerId };
}

function rawGet(port, path) {
  return new Promise((resolve, reject) => {
    const req = request({ port, path, host: "127.0.0.1" }, (res) => {
      res.resume();
      res.on("end", () => resolve(res.statusCode));
    });
    req.on("error", reject);
    req.end();
  });
}

// ---- config ---------------------------------------------------------------------------------

test("config: defaults, parsing, and every bad value reported at once", () => {
  const c = loadConfig({});
  assert.equal(c.port, 8787);
  assert.ok(Object.isFrozen(c));
  assert.equal(loadConfig({ PORT: "9000", DEBUG_ROUTES: "yes" }).debugRoutes, true);
  assert.throws(
    () => loadConfig({ PORT: "99999", MAX_ROOMS: "abc", QUIET: "maybe" }),
    (e) => e instanceof ConfigError && e.problems.length === 3,
  );
});

// ---- protocol -------------------------------------------------------------------------------

test("protocol: valid messages pass; every kind of bad one gets its own close code", () => {
  assert.equal(parseClientMessage(JSON.stringify({ type: "chat", text: " hi " })).msg.text, "hi");
  const code = (raw, binary) => parseClientMessage(raw, binary).code;
  assert.equal(code("{nope"), CLOSE.BAD_JSON);
  assert.equal(code("[1,2]"), CLOSE.BAD_SHAPE);
  assert.equal(code(JSON.stringify({ type: "teleport" })), CLOSE.UNKNOWN_TYPE);
  assert.equal(code(JSON.stringify({ type: "__proto__" })), CLOSE.UNKNOWN_TYPE);
  assert.equal(code(JSON.stringify({ type: "chat", text: "x".repeat(281) })), CLOSE.BAD_SHAPE);
  assert.equal(code(JSON.stringify({ type: "chat", text: "hi", admin: true })), CLOSE.BAD_SHAPE);
  assert.equal(code(JSON.stringify({ type: "join", v: 99, room: "r", name: "n" })), CLOSE.VERSION);
  assert.equal(code("{}", true), CLOSE.BAD_SHAPE);
  assert.equal(CLIENT_VERSION, PROTOCOL_VERSION, "client and server agree on the version");
});

// ---- rooms ----------------------------------------------------------------------------------

test("Room: events in order, 'empty' after the last leave, full rooms refuse", () => {
  const room = new Room({ id: "r", name: "R", maxPlayers: 2 });
  const seen = [];
  for (const type of ["open", "join", "leave", "chat", "empty"])
    room.on(type, () => seen.push(type));
  room.join({ id: "a", name: "A" });
  room.join({ id: "b", name: "B" });
  assert.throws(
    () => room.join({ id: "c", name: "C" }),
    (e) => e instanceof RoomError && e.code === "full",
  );
  room.chat("a", "hi");
  room.leave("a");
  room.leave("b");
  assert.deepEqual(seen, ["open", "join", "join", "chat", "leave", "leave", "empty"]);
});

test("RoomManager: validates input, caps rooms, deletes empty API rooms but keeps defaults", () => {
  const rooms = new RoomManager({ maxRooms: 3, defaults: [{ id: "d", name: "Default" }] });
  assert.throws(() => rooms.create({ name: "" }), RoomError);
  assert.throws(() => rooms.create({ name: "x", arena: "moon" }), RoomError);
  const temp = rooms.create({ name: "Temp" });
  rooms.create({ name: "Third" });
  assert.throws(
    () => rooms.create({ name: "Fourth" }),
    (e) => e.code === "too_many_rooms",
  );
  temp.join({ id: "p", name: "P" });
  temp.leave("p");
  assert.equal(rooms.get(temp.id), undefined, "temporary room deleted on empty");
  const d = rooms.get("d");
  d.join({ id: "p", name: "P" });
  d.leave("p");
  assert.ok(rooms.get("d"), "default room survives");
  rooms.closeAll();
});

test("TokenBucket: allows a burst, then refills at the set rate", () => {
  let now = 0;
  const bucket = new TokenBucket({ perSecond: 2, burst: 3, now: () => now });
  assert.deepEqual(
    [1, 2, 3, 4].map(() => bucket.take()),
    [true, true, true, false],
  );
  now = 500; // +1 token
  assert.equal(bucket.take(), true);
  assert.equal(bucket.take(), false);
});

// ---- HTTP -----------------------------------------------------------------------------------

test("HTTP: health, rooms API (GET/POST with validation and size cap), 404/405", async (t) => {
  const { game, base } = await startServer();
  t.after(() => game.stop());
  const health = await (await fetch(`${base}/health`)).json();
  assert.equal(health.status, "ok");
  assert.ok(health.rssMB > 0);

  const list = await (await fetch(`${base}/api/rooms`)).json();
  assert.ok(list.rooms.some((r) => r.id === "r-101"));

  const post = (body, headers = { "content-type": "application/json" }) =>
    fetch(`${base}/api/rooms`, { method: "POST", headers, body });
  const created = await post(JSON.stringify({ name: "Нова", arena: "belt", mode: "duel" }));
  assert.equal(created.status, 201);
  assert.equal((await created.json()).room.name, "Нова");
  assert.equal((await post(JSON.stringify({ name: "", arena: "x" }))).status, 400);
  assert.equal((await post("{broken")).status, 400);
  assert.equal((await post("x".repeat(5000))).status, 413);
  assert.equal((await post("{}", { "content-type": "text/plain" })).status, 415);
  assert.equal((await fetch(`${base}/api/nope`)).status, 404);
  assert.equal((await fetch(`${base}/api/rooms`, { method: "DELETE" })).status, 405);
});

test("static: serves the client, blocks path traversal (raw and %-encoded)", async (t) => {
  const { game, base, port } = await startServer();
  t.after(() => game.stop());
  const index = await fetch(`${base}/`);
  assert.equal(index.status, 200);
  assert.match(index.headers.get("content-type"), /text\/html/);
  assert.equal(await rawGet(port, "/../../package.json"), 404); // URL parsing normalises ".."
  assert.equal(await rawGet(port, "/..%2f..%2fpackage.json"), 403); // the guard catches this one
  assert.equal(await rawGet(port, "/%00"), 403);
  assert.equal(safeJoin("/srv/app", "/a/../../etc/passwd"), null);
  assert.equal(safeJoin("/srv/app", "/assets/x.png"), "/srv/app/assets/x.png");
});

// ---- WebSocket ------------------------------------------------------------------------------

test("ws: two players join one room, see the roster and each other's chat", async (t) => {
  const { game, ws } = await startServer();
  t.after(() => game.stop());
  const a = await joined(ws, "r-104", "Ada");
  await a.next("roster");
  const b = await joined(ws, "r-104", "Bob");
  const rosterA = await a.next("roster");
  assert.deepEqual(
    rosterA.players.map((p) => p.name),
    ["Ada", "Bob"],
  );
  b.send({ type: "chat", text: "hello" });
  const chat = await a.next("chat");
  assert.deepEqual([chat.from.name, chat.text], ["Bob", "hello"]);
  b.ws.close();
  const after = await a.next("roster");
  assert.deepEqual(
    after.players.map((p) => p.name),
    ["Ada"],
  );
  a.ws.close();
});

test("ws: no join within the timeout -> closed with 4003", async (t) => {
  const { game, ws } = await startServer({ JOIN_TIMEOUT_MS: "100" });
  t.after(() => game.stop());
  const c = client(ws);
  assert.equal((await c.closed).code, CLOSE.JOIN_TIMEOUT);
});

test("ws: unknown type, chat before join, full room -> specific close codes", async (t) => {
  const { game, ws } = await startServer();
  t.after(() => game.stop());
  const c1 = client(ws);
  await c1.opened;
  c1.send({ type: "teleport" });
  assert.equal((await c1.closed).code, CLOSE.UNKNOWN_TYPE);

  const c2 = client(ws);
  await c2.opened;
  c2.send({ type: "chat", text: "hi" });
  assert.equal((await c2.closed).code, CLOSE.NOT_JOINED);

  const solo = await joined(ws, "r-102", "Solo"); // maxPlayers 1
  const c3 = client(ws);
  await c3.opened;
  c3.send({ type: "join", v: 1, room: "r-102", name: "Late" });
  assert.equal((await c3.closed).code, CLOSE.ROOM_UNAVAILABLE);
  solo.ws.close();
});

test("ws: a frame over maxPayload -> 1009 (closed by ws itself)", async (t) => {
  const { game, ws } = await startServer({ MAX_PAYLOAD_BYTES: "1024" });
  t.after(() => game.stop());
  const c = client(ws);
  await c.opened;
  c.send("x".repeat(2048));
  assert.equal((await c.closed).code, CLOSE.TOO_BIG);
});

test("ws: flooding beyond the token bucket -> 4008", async (t) => {
  const { game, ws } = await startServer({ RATE_LIMIT_PER_SEC: "5", RATE_LIMIT_BURST: "5" });
  t.after(() => game.stop());
  const c = await joined(ws, "r-104", "Spammer");
  for (let i = 0; i < 20; i++) c.send({ type: "chat", text: `spam ${i}` });
  assert.equal((await c.closed).code, CLOSE.RATE_LIMIT);
});

test("ws: a client that never answers pings is terminated after two misses", async (t) => {
  const { game, ws } = await startServer({ HEARTBEAT_MS: "60" });
  t.after(() => game.stop());
  const c = client(ws, { autoPong: false }); // simulates a dead peer behind a NAT
  await c.opened;
  c.send({ type: "join", v: 1, room: "r-104", name: "Ghost" });
  const t0 = performance.now();
  const { code } = await c.closed;
  assert.equal(code, 1006, "terminated: no close frame at all");
  assert.ok(performance.now() - t0 >= 120, "only after two missed pongs");
  assert.equal(game.sockets.counters.terminated, 1);
});

test("ws: an answering client survives many heartbeats", async (t) => {
  const { game, ws } = await startServer({ HEARTBEAT_MS: "50" });
  t.after(() => game.stop());
  const c = await joined(ws, "r-104", "Alive");
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(c.ws.readyState, WebSocket.OPEN);
  c.ws.close();
});

test("ws: slow-client policy — chat is dropped over the soft limit, the socket cut over the hard one", async (t) => {
  const { game, ws } = await startServer({
    SLOW_CLIENT_BYTES: "10000",
    DROP_CLIENT_BYTES: "50000",
  });
  t.after(() => game.stop());
  const slow = await joined(ws, "r-104", "Slow");
  await slow.next("roster");
  const [serverSide] = game.sockets.wss.clients; // the server's end of Slow's connection
  let queued = 20_000; // pretend 20 KB are stuck in its send buffer: the client stopped reading
  Object.defineProperty(serverSide, "bufferedAmount", { get: () => queued });

  const fast = await joined(ws, "r-104", "Fast");
  const roster = await slow.next("roster"); // critical messages still go through
  assert.deepEqual(
    roster.players.map((p) => p.name),
    ["Slow", "Fast"],
  );
  fast.send({ type: "chat", text: "you will not see this" });
  await fast.next("chat");
  assert.equal(game.sockets.counters.slowDrops >= 1, true, "chat to Slow was dropped");

  queued = 100_000; // now beyond DROP_CLIENT_BYTES
  fast.send({ type: "chat", text: "and now you are gone" });
  assert.equal((await slow.closed).code, 1006, "terminated, no close handshake");
  fast.ws.close();
});

// ---- match logs & replays -------------------------------------------------------------------

test("NdjsonEncoder: objects in, one JSON line each out", async () => {
  const encoder = new NdjsonEncoder();
  const chunks = [];
  encoder.on("data", (c) => chunks.push(String(c)));
  encoder.write({ a: 1 });
  encoder.end({ b: "привіт" });
  await once(encoder, "end");
  assert.equal(chunks.join(""), '{"a":1}\n{"b":"привіт"}\n');
});

test("match log: a session becomes an NDJSON file; replay reads it back; endpoint streams it", async (t) => {
  const { game, ws, base, config } = await startServer();
  t.after(() => game.stop());
  const a = await joined(ws, "r-101", "Ada");
  const b = await joined(ws, "r-101", "Bob");
  a.send({ type: "chat", text: "gg" });
  await b.next("chat");
  a.ws.close();
  b.ws.close();
  await Promise.all([a.closed, b.closed]);
  await new Promise((r) => setTimeout(r, 50));
  await game.matchLogs.flush();

  const [name] = await readdir(config.logDir);
  const lines = (await readFile(join(config.logDir, name), "utf8")).trim().split("\n");
  const types = lines.map((l) => JSON.parse(l).type);
  assert.deepEqual(types, ["session", "join", "join", "chat", "leave", "leave"]);

  const replayed = [];
  for await (const event of readReplay(join(config.logDir, name))) replayed.push(event.type);
  assert.deepEqual(replayed, types);

  const id = name.replace(".ndjson", "");
  const res = await fetch(`${base}/api/replays/${id}`);
  assert.equal(res.headers.get("content-type"), "application/x-ndjson; charset=utf-8");
  assert.equal((await res.text()).trim().split("\n").length, lines.length);
  const summary = await (await fetch(`${base}/api/replays/${id}/summary`)).json();
  assert.equal(summary.counts.chat, 1);
  assert.equal((await fetch(`${base}/api/replays/..%2f..%2fetc`)).status, 404);
});

// ---- shutdown -------------------------------------------------------------------------------

test("graceful shutdown: sockets get 1001, open match logs are flushed to disk", async () => {
  const { game, ws, config } = await startServer();
  const a = await joined(ws, "r-104", "Ada");
  a.send({ type: "chat", text: "last words" });
  await a.next("chat");
  await game.stop();
  assert.equal((await a.closed).code, CLOSE.GOING_AWAY);
  const [name] = await readdir(config.logDir);
  const text = await readFile(join(config.logDir, name), "utf8");
  assert.match(text, /last words/);
  assert.match(text, /"type":"leave".*"reason":"server shutdown"/); // the file is complete
});

test("the server process exits with code 0 on SIGTERM", async () => {
  const { spawn } = await import("node:child_process");
  const dir = await mkdtemp(join(tmpdir(), "dogfight-proc-"));
  tmpDirs.push(dir);
  const child = spawn(process.execPath, ["src/index.js"], {
    cwd: join(import.meta.dirname, ".."),
    env: { ...process.env, PORT: "0", LOG_DIR: dir, QUIET: "true" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (d) => (output += d));
  while (!output.includes("dogfight server on")) await new Promise((r) => setTimeout(r, 20));
  child.kill("SIGTERM");
  const [code] = await once(child, "exit");
  assert.equal(code, 0);
  assert.match(output, /SIGTERM: shutting down/);
});
