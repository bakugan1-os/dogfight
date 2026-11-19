// Lab 5: the authoritative match, the precise tick loop, binary inputs over a real socket,
// and the latency injector.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { WebSocket } from "ws";

import { Match } from "../src/match.js";
import { TickLoop } from "../src/tickloop.js";
import { createLink } from "../src/netsim.js";
import { Room } from "../src/rooms.js";
import { loadConfig } from "../src/config.js";
import { createGameServer } from "../src/index.js";
import { PROTOCOL_VERSION, CLOSE } from "../src/protocol.js";
import * as binary from "@dogfight/shared/codec/binary.js";
import * as json from "@dogfight/shared/codec/json.js";

const input = (seq, extra = {}) => ({
  seq,
  tick: 0,
  thrust: false,
  left: false,
  right: false,
  fire: false,
  firePressed: false,
  ...extra,
});

function matchWithClient(codec = "binary") {
  const match = new Match(new Room({ id: "r", name: "R", arena: "calm", maxPlayers: 4 }), {
    seed: 5,
  });
  const frames = [];
  const slot = match.addClient("s1", "Ada", { codec, send: (f) => frames.push(f) });
  return { match, frames, slot };
}

test("Match: one input per tick, ack = last processed seq, old/duplicate seqs ignored", () => {
  const { match, frames, slot } = matchWithClient();
  assert.equal(slot, 1);
  for (const seq of [1, 2, 3]) match.pushInput("s1", input(seq, { thrust: true }));
  assert.equal(match.pushInput("s1", input(2)), false, "duplicate");
  match.step();
  match.step();
  const snap = binary.decodeSnapshot(frames.at(-1));
  assert.equal(snap.ack, 2, "two ticks consumed two inputs");
  match.step();
  match.step(); // queue empty: holds the last controls, ack stays
  assert.equal(binary.decodeSnapshot(frames.at(-1)).ack, 3);
  const own = binary.decodeSnapshot(frames.at(-1)).entities.find((e) => e.kind === "ship");
  assert.equal(own.playerId, 1);
  assert.ok(Math.hypot(own.vx, own.vy) > 0, "thrust was applied");
  match.stop();
});

test("Match: the queue is capped (a client running fast loses its OLDEST inputs)", () => {
  const { match, frames } = matchWithClient();
  for (let seq = 1; seq <= 20; seq++) match.pushInput("s1", input(seq));
  match.step();
  assert.equal(binary.decodeSnapshot(frames.at(-1)).ack, 13, "20 queued, 8 kept: 13..20");
  match.stop();
});

test("Match: JSON clients get the same snapshot as text, with their own ack", () => {
  const { match, frames } = matchWithClient("json");
  match.pushInput("s1", input(1));
  match.step();
  const snap = json.decodeSnapshot(frames[0]);
  assert.equal(snap.ack, 1);
  assert.ok(snap.entities.length > 0);
  match.stop();
});

test("TickLoop: ~30 ticks per second on an absolute schedule, with jitter stats", async () => {
  let n = 0;
  const loop = new TickLoop(30, () => n++);
  loop.start();
  await new Promise((r) => setTimeout(r, 1000));
  loop.stop();
  assert.ok(n >= 28 && n <= 32, `${n} ticks in 1 s`);
  const { meanMs, p95Ms } = loop.jitter();
  assert.ok(meanMs < 10 && p95Ms < 20, `jitter mean ${meanMs.toFixed(2)} p95 ${p95Ms.toFixed(2)}`);
});

test("netsim link: delays by ~lag/2, keeps order, drops only droppable frames", async () => {
  let r = 0;
  const seq = [0.1, 0.9, 0.5, 0.2];
  const link = createLink({ lag: 100, jitter: 40, drop: 0.5 }, () => seq[r++ % seq.length]);
  const got = [];
  const t0 = performance.now();
  for (let i = 0; i < 4; i++) link.out(() => got.push([i, performance.now() - t0]));
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.deepEqual(
    got.map(([i]) => i),
    [0, 1, 2, 3],
    "never reordered",
  );
  assert.ok(got[0][1] >= 25, "delayed");
  link.out(() => got.push(["dropped?"]), true); // random 0.1 < 0.5 -> dropped
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(link.stats.dropped, 1);
});

async function startServer(env = {}) {
  const dir = await mkdtemp(join(tmpdir(), "dogfight-m-"));
  const config = loadConfig({ PORT: "0", QUIET: "true", LOG_DIR: dir, STATIC_DIR: dir, ...env });
  const game = await createGameServer(config);
  const { port } = await game.listen();
  return {
    game,
    url: `ws://127.0.0.1:${port}/ws`,
    cleanup: async () => {
      await game.stop();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

function connect(url) {
  const ws = new WebSocket(url);
  const texts = [];
  const snapshots = [];
  ws.on("message", (data, isBinary) =>
    (isBinary ? snapshots : texts).push(isBinary ? data : JSON.parse(String(data))),
  );
  ws.on("error", () => {});
  const closed = new Promise((resolve) => ws.on("close", (code) => resolve(code)));
  return { ws, texts, snapshots, closed, opened: once(ws, "open") };
}

const until = async (cond, ms = 2000) => {
  const t0 = performance.now();
  while (!cond()) {
    if (performance.now() - t0 > ms) throw new Error("timeout");
    await new Promise((r) => setTimeout(r, 10));
  }
};

test("over a real socket: binary inputs in, binary snapshots out, ack advances", async (t) => {
  const { url, cleanup } = await startServer();
  t.after(cleanup);
  const c = connect(url);
  await c.opened;
  c.ws.send(JSON.stringify({ type: "join", v: PROTOCOL_VERSION, room: "r-104", name: "Ada" }));
  await until(() => c.texts.some((m) => m.type === "welcome"));
  const welcome = c.texts.find((m) => m.type === "welcome");
  assert.equal(welcome.slot, 1);
  assert.equal(welcome.tickRate, 30);
  for (let seq = 1; seq <= 10; seq++) c.ws.send(binary.encodeInput(input(seq, { thrust: true })));
  await until(() => c.snapshots.length > 15);
  const last = binary.decodeSnapshot(c.snapshots.at(-1));
  assert.equal(last.ack, 10);
  assert.ok(last.entities.some((e) => e.kind === "ship" && e.playerId === 1));
  c.ws.close();
});

test("over a real socket: a malformed binary input closes the socket with 4002", async (t) => {
  const { url, cleanup } = await startServer();
  t.after(cleanup);
  const c = connect(url);
  await c.opened;
  c.ws.send(JSON.stringify({ type: "join", v: PROTOCOL_VERSION, room: "r-104", name: "Eve" }));
  await until(() => c.texts.some((m) => m.type === "welcome"));
  const bad = binary.encodeInput(input(1));
  bad[10] = 0xff; // reserved bits set: not a valid button mask
  c.ws.send(bad);
  assert.equal(await c.closed, CLOSE.BAD_SHAPE);
});

test("latency injector via ?lag: ping/pong RTT grows by about the lag", async (t) => {
  const { url, cleanup } = await startServer({ NETSIM: "true" });
  t.after(cleanup);
  const c = connect(`${url}?lag=120`);
  await c.opened;
  const t0 = performance.now();
  c.ws.send(JSON.stringify({ type: "ping", t: 1 }));
  await until(() => c.texts.some((m) => m.type === "pong"));
  const rtt = performance.now() - t0;
  assert.ok(rtt >= 110 && rtt < 400, `rtt ${rtt.toFixed(0)} ms`);
  c.ws.close();
});
