// Lab 5: the authoritative match, the precise tick loop, binary inputs over a real socket,
// and the latency injector.

import { test, afterAll } from "vitest";
import assert from "node:assert/strict";
import { Match } from "../src/match.ts";
import { TickLoop } from "../src/tickloop.ts";
import { createLink } from "../src/netsim.ts";
import { Room } from "../src/rooms.ts";
import { PROTOCOL_VERSION, CLOSE } from "@dogfight/shared/protocol/control.ts";
import * as binary from "@dogfight/shared/codec/binary.ts";
import * as json from "@dogfight/shared/codec/json.ts";
import type { Input } from "@dogfight/shared/protocol/messages.ts";
import { seq as toSeq, tick } from "@dogfight/shared/protocol/ids.ts";
import { startServer, client, until, cleanupTmp } from "./helpers.ts";

afterAll(cleanupTmp);

const input = (seq: number, extra: Partial<Input> = {}): Input => ({
  seq: toSeq(seq),
  tick: tick(0),
  thrust: false,
  left: false,
  right: false,
  fire: false,
  firePressed: false,
  ...extra,
});

function matchWithClient(codec: "binary" | "json" = "binary") {
  const match = new Match(new Room({ id: "r", name: "R", arena: "calm", maxPlayers: 4 }), {
    seed: 5,
  });
  const frames: Array<Uint8Array | string> = [];
  const slot = match.addClient("s1", "Ada", { codec, send: (f) => frames.push(f) });
  /** The last frame, decoded with the client's codec. */
  const last = () => {
    const f = frames.at(-1);
    assert.ok(f !== undefined, "a snapshot was sent");
    return typeof f === "string" ? json.decodeSnapshot(f) : binary.decodeSnapshot(f);
  };
  return { match, frames, slot, last };
}

test("Match: one input per tick, ack = last processed seq, old/duplicate seqs ignored", () => {
  const { match, slot, last } = matchWithClient();
  assert.equal(slot, 1);
  for (const seq of [1, 2, 3]) match.pushInput("s1", input(seq, { thrust: true }));
  assert.equal(match.pushInput("s1", input(2)), false, "duplicate");
  match.step();
  match.step();
  assert.equal(last().ack, 2, "two ticks consumed two inputs");
  match.step();
  match.step(); // queue empty: holds the last controls, ack stays
  assert.equal(last().ack, 3);
  const own = last().entities.find((e) => e.kind === "ship");
  assert.ok(own?.kind === "ship");
  assert.equal(own.playerId, 1);
  assert.ok(Math.hypot(own.vx, own.vy) > 0, "thrust was applied");
  match.stop();
});

test("Match: the queue is capped (a client running fast loses its OLDEST inputs)", () => {
  const { match, last } = matchWithClient();
  for (let seq = 1; seq <= 20; seq++) match.pushInput("s1", input(seq));
  match.step();
  assert.equal(last().ack, 13, "20 queued, 8 kept: 13..20");
  match.stop();
});

test("Match: JSON clients get the same snapshot as text, with their own ack", () => {
  const { match, frames } = matchWithClient("json");
  match.pushInput("s1", input(1));
  match.step();
  const first = frames[0];
  assert.equal(typeof first, "string", "a JSON client gets text frames");
  const snap = json.decodeSnapshot(String(first));
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
  const randoms = [0.1, 0.9, 0.5, 0.2];
  const link = createLink(
    { lag: 100, jitter: 40, drop: 0.5 },
    () => randoms[r++ % randoms.length] ?? 0,
  );
  const got: Array<[number | string, number]> = [];
  const t0 = performance.now();
  for (let i = 0; i < 4; i++) link.out(() => got.push([i, performance.now() - t0]));
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.deepEqual(
    got.map(([i]) => i),
    [0, 1, 2, 3],
    "never reordered",
  );
  assert.ok((got[0]?.[1] ?? 0) >= 25, "delayed");
  link.out(() => got.push(["dropped?", 0]), true); // random 0.1 < 0.5 -> dropped
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(link.stats.dropped, 1);
});

test("over a real socket: binary inputs in, binary snapshots out, ack advances", async ({
  onTestFinished,
}) => {
  const { game, ws } = await startServer();
  onTestFinished(() => game.stop());
  const c = client(ws);
  await c.opened;
  c.send({ type: "join", v: PROTOCOL_VERSION, room: "r-104", name: "Ada" });
  const welcome = await c.next("welcome");
  assert.equal(welcome.slot, 1);
  assert.equal(welcome.tickRate, 30);
  for (let seq = 1; seq <= 10; seq++) c.send(binary.encodeInput(input(seq, { thrust: true })));
  await until(() => c.snapshots.length > 15);
  const lastFrame = c.snapshots.at(-1);
  assert.ok(lastFrame);
  const last = binary.decodeSnapshot(lastFrame);
  assert.equal(last.ack, 10);
  assert.ok(last.entities.some((e) => e.kind === "ship" && e.playerId === 1));
  c.ws.close();
});

test("over a real socket: a malformed binary input closes the socket with 4002", async ({
  onTestFinished,
}) => {
  const { game, ws } = await startServer();
  onTestFinished(() => game.stop());
  const c = client(ws);
  await c.opened;
  c.send({ type: "join", v: PROTOCOL_VERSION, room: "r-104", name: "Eve" });
  await c.next("welcome");
  const bad = binary.encodeInput(input(1));
  bad[10] = 0xff; // reserved bits set: not a valid button mask
  c.send(bad);
  assert.equal((await c.closed).code, CLOSE.BAD_SHAPE);
});

test("latency injector via ?lag: ping/pong RTT grows by about the lag", async ({
  onTestFinished,
}) => {
  const { game, ws } = await startServer({ NETSIM: "true" });
  onTestFinished(() => game.stop());
  const c = client(`${ws}?lag=120`);
  await c.opened;
  const t0 = performance.now();
  c.send({ type: "ping", t: 1 });
  await c.next("pong");
  const rtt = performance.now() - t0;
  assert.ok(rtt >= 110 && rtt < 400, `rtt ${rtt.toFixed(0)} ms`);
  c.ws.close();
});
