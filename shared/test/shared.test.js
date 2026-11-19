// Lab 5: the shared package — pure, deterministic, and its codecs round-trip.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";

import { World } from "../sim/world.js";
import { integrate, NO_CONTROLS } from "../sim/ship.js";
import { Vector2 } from "../sim/vector.js";
import { ARENAS } from "../sim/arenas.js";
import { bodyFromSnapshot, predictStep } from "../sim/predict.js";
import { createArena } from "../sim/arena.js";
import { buildSnapshot, collectEvents } from "../protocol/snapshot.js";
import { TICK_DT, inputProblem, EVENT } from "../protocol/messages.js";
import * as binary from "../codec/binary.js";
import * as json from "../codec/json.js";

const dirs = ["sim", "protocol", "codec"];
// Source with comments stripped: the comments themselves explain WHY Math.random() is banned.
const code = (src) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

test("shared/ imports no DOM and no Node built-ins (only relative imports)", () => {
  for (const dir of dirs) {
    const base = new URL(`../${dir}/`, import.meta.url);
    for (const file of readdirSync(base)) {
      const src = code(readFileSync(new URL(file, base), "utf8"));
      for (const [, path] of src.matchAll(/from\s+["']([^"']+)["']/g)) {
        assert.ok(
          path.startsWith("./") || path.startsWith("../"),
          `${dir}/${file} imports ${path}`,
        );
      }
      assert.doesNotMatch(
        src,
        /\b(document|window|process|require)\b\s*[.(]/,
        `${dir}/${file} touches a platform global`,
      );
      assert.doesNotMatch(
        src,
        /Date\.now\(\)/,
        `${dir}/${file}: Date.now() would break determinism`,
      );
    }
  }
});

test("shared/sim never calls Math.random()", () => {
  const base = new URL("../sim/", import.meta.url);
  for (const file of readdirSync(base)) {
    assert.doesNotMatch(code(readFileSync(new URL(file, base), "utf8")), /Math\.random\(\)/, file);
  }
});

/** Same seed + same inputs -> same world. Hash of every entity, in order. */
export function runAndHash(seed, steps) {
  const world = new World({ seed });
  world.addPlayer({ id: 1, name: "A" });
  world.addPlayer({ id: 2, name: "B" });
  const h = createHash("sha256");
  for (let i = 0; i < steps; i++) {
    const t = i % 90;
    world.step(
      TICK_DT,
      new Map([
        [1, { ...NO_CONTROLS, thrust: t < 50, left: t > 60, fire: i % 7 === 0, seq: i + 1 }],
        [2, { ...NO_CONTROLS, thrust: true, right: t < 30, fire: i % 5 === 0, seq: i + 1 }],
      ]),
    );
  }
  for (const e of world) h.update(`${e.netId}:${e.kind}:${e.pos.x}:${e.pos.y}:${e.angle}|`);
  return h.digest("hex").slice(0, 16);
}

test("determinism: same seed and inputs -> identical world hash; another seed -> different", () => {
  assert.equal(runAndHash(7, 600), runAndHash(7, 600));
  assert.notEqual(runAndHash(7, 600), runAndHash(8, 600));
});

test("prediction = server: predictStep follows Ship.update exactly in open space", () => {
  const arena = createArena();
  const world = new World({ seed: 3, asteroids: 0, pickupEvery: 1e9 });
  world.addPlayer({ id: 1 });
  const ship = world.shipOf(1);
  const body = bodyFromSnapshot({
    x: ship.pos.x,
    y: ship.pos.y,
    vx: 0,
    vy: 0,
    a: ship.angle,
    cooldown: 0,
  });
  for (let i = 0; i < 200; i++) {
    const c = { ...NO_CONTROLS, thrust: i % 40 < 25, left: i % 60 > 40 };
    world.step(TICK_DT, new Map([[1, c]]));
    predictStep(body, c, TICK_DT, arena);
  }
  assert.ok(Math.abs(body.pos.x - ship.pos.x) < 1e-9 && Math.abs(body.pos.y - ship.pos.y) < 1e-9);
  assert.equal(body.angle, ship.angle);
});

test("integrate is a pure function of (state, controls, dt)", () => {
  const run = () => {
    const b = { pos: new Vector2(1, 2), vel: new Vector2(), angle: 0.3, thrust: false };
    for (let i = 0; i < 1000; i++)
      integrate(b, { thrust: i % 3 > 0, left: i % 10 < 2, right: false }, TICK_DT);
    return [b.pos.x, b.pos.y, b.vel.x, b.angle];
  };
  assert.deepEqual(run(), run());
});

function sampleSnapshot() {
  const world = new World({ seed: 11 });
  for (let id = 1; id <= 4; id++) world.addPlayer({ id, name: `P${id}` });
  const events = collectEvents(world);
  for (let i = 0; i < 40; i++) {
    world.step(
      TICK_DT,
      new Map([
        [1, { ...NO_CONTROLS, fire: true, seq: i + 1 }],
        [3, { ...NO_CONTROLS, thrust: true, fire: true, seq: i + 1 }],
      ]),
    );
  }
  return { ...buildSnapshot(world, world.tick, events.drain()), ack: 1234 };
}

test("binary codec: snapshot round-trips within quantization (angle 1/1000 rad, f32 positions)", () => {
  const snap = sampleSnapshot();
  assert.ok(
    snap.entities.some((e) => e.kind === "bullet") &&
      snap.entities.some((e) => e.kind === "asteroid"),
  );
  const bytes = binary.encodeSnapshot(snap);
  assert.equal(bytes.byteLength, binary.snapshotSize(snap));
  const back = binary.decodeSnapshot(bytes);
  assert.equal(back.tick, snap.tick);
  assert.equal(back.ack, 1234);
  assert.deepEqual(
    back.players,
    snap.players.map((p) => ({ ...p, respawn: Math.round(p.respawn * 10) / 10 })),
  );
  assert.equal(back.entities.length, snap.entities.length);
  snap.entities.forEach((e, i) => {
    const d = back.entities[i];
    assert.equal(d.id, e.id);
    assert.equal(d.kind, e.kind);
    assert.ok(Math.abs(d.x - e.x) < 1e-3 && Math.abs(d.y - e.y) < 1e-3, "f32 position");
    assert.ok(Math.abs(d.a - e.a) <= 0.0005 + 1e-9, "angle quantized to 1/1000 rad");
    if (e.kind === "ship")
      assert.deepEqual([d.playerId, d.hp, d.flags], [e.playerId, e.hp, e.flags]);
    if (e.kind === "bullet") assert.equal(d.seq, e.seq & 0xffff);
  });
  assert.deepEqual(
    back.events.map((ev) => ev.type),
    snap.events.map((ev) => ev.type),
  );
});

test("binary codec: per-client ack is patched in a copy; bad frames are refused, not crashed", () => {
  const bytes = binary.encodeSnapshot(sampleSnapshot());
  const patched = binary.withAck(bytes, 99);
  assert.equal(binary.decodeSnapshot(patched).ack, 99);
  assert.equal(binary.decodeSnapshot(bytes).ack, 1234, "original untouched");
  assert.throws(() => binary.decodeSnapshot(bytes.subarray(0, 20)), binary.CodecError);
  const wrongVersion = bytes.slice();
  wrongVersion[1] = 9;
  assert.throws(() => binary.decodeSnapshot(wrongVersion), /version/);
  assert.throws(() => binary.decodeSnapshot(new Uint8Array([...bytes, 0])), /trailing/);
});

test("binary codec: input is 11 bytes little-endian; reserved bits are refused", () => {
  const input = {
    seq: 70000,
    tick: 5,
    thrust: true,
    left: false,
    right: true,
    fire: true,
    firePressed: false,
  };
  const bytes = binary.encodeInput(input);
  assert.equal(bytes.byteLength, 11);
  assert.deepEqual([...bytes.subarray(2, 6)], [0x70, 0x11, 0x01, 0x00], "70000 = 0x00011170, LE");
  assert.deepEqual(binary.decodeInput(bytes), input);
  assert.equal(inputProblem(binary.decodeInput(bytes)), null);
  bytes[10] |= 0b100000;
  assert.throws(() => binary.decodeInput(bytes), /reserved/);
  assert.throws(() => binary.decodeInput(new Uint8Array(5)), /11 bytes/);
});

test("JSON codec gives the same decoded shapes as binary", () => {
  const snap = sampleSnapshot();
  const viaJson = json.decodeSnapshot(json.encodeSnapshot(snap));
  const viaBinary = binary.decodeSnapshot(binary.encodeSnapshot(snap));
  assert.equal(viaJson.entities.length, viaBinary.entities.length);
  viaJson.entities.forEach((e, i) => {
    assert.equal(e.id, viaBinary.entities[i].id);
    assert.ok(Math.abs(e.x - viaBinary.entities[i].x) < 0.01);
  });
  const input = {
    seq: 3,
    tick: 9,
    thrust: false,
    left: true,
    right: false,
    fire: false,
    firePressed: true,
  };
  assert.deepEqual(json.decodeInput(json.encodeInput(input)), input);
});

test("events: kills carry victim and killer; batches are drained per tick", () => {
  const world = new World({ seed: 1, asteroids: 0, pickupEvery: 1e9 });
  world.addPlayer({ id: 1 });
  const events = collectEvents(world);
  world.onShipDestroyed(world.shipOf(1), 2);
  const batch = events.drain();
  assert.ok(batch.some((e) => e.type === EVENT.kill && e.a === 1 && e.b === 2));
  assert.equal(events.drain().length, 0);
});

test("netIds are u16, unique among live entities, and reused after removal", () => {
  const world = new World({ seed: 1, asteroids: 3, pickupEvery: 1e9 });
  const ids = [...world].map((e) => e.netId);
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(ids.every((id) => id >= 1 && id <= 0xffff));
  world.addPlayer({ id: 5 });
  assert.ok(world.removePlayer(5));
  world.step(TICK_DT, new Map());
  assert.equal(world.players.size, 0);
});

test("server arenas = client's arenas.json (two copies, kept equal)", () => {
  const file = JSON.parse(
    readFileSync(new URL("../../client/public/assets/arenas.json", import.meta.url), "utf8"),
  );
  assert.deepEqual(file, JSON.parse(JSON.stringify(ARENAS)));
});
