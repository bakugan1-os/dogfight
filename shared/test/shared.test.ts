// Lab 5: the shared package — pure, deterministic, and its codecs round-trip.
// Lab 6: typed; the determinism hash is pinned to the value the JavaScript version produced.

import { test } from "vitest";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";

import { World } from "../sim/world.ts";
import { integrate, NO_CONTROLS, type Ship } from "../sim/ship.ts";
import { Vector2 } from "../sim/vector.ts";
import { ARENAS } from "../sim/arenas.ts";
import { bodyFromSnapshot, predictStep } from "../sim/predict.ts";
import { createArena } from "../sim/arena.ts";
import { buildSnapshot, collectEvents } from "../protocol/snapshot.ts";
import { TICK_DT, EVENT, type Input, type Snapshot } from "../protocol/messages.ts";
import { entityId, playerId, seq, tick, type PlayerId } from "../protocol/ids.ts";
import * as binary from "../codec/binary.ts";
import * as json from "../codec/json.ts";

const P1 = playerId(1);
const P2 = playerId(2);

/** Test helper: "this ship must exist" — fails the test (instead of a TypeError) if not. */
function shipOf(world: World, id: PlayerId): Ship {
  const ship = world.shipOf(id);
  assert.ok(ship, `player ${id} has a ship`);
  return ship;
}

const dirs = ["sim", "protocol", "codec"];
// Source with comments stripped: the comments themselves explain WHY Math.random() is banned.
const code = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

test("shared/ imports no DOM and no Node built-ins (only relative imports and zod)", () => {
  for (const dir of dirs) {
    const base = new URL(`../${dir}/`, import.meta.url);
    for (const file of readdirSync(base)) {
      const src = code(readFileSync(new URL(file, base), "utf8"));
      for (const [, path = ""] of src.matchAll(/from\s+["']([^"']+)["']/g)) {
        assert.ok(
          path.startsWith("./") || path.startsWith("../") || path === "zod",
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
export function runAndHash(seed: number, steps: number): string {
  const world = new World({ seed });
  world.addPlayer({ id: P1, name: "A" });
  world.addPlayer({ id: P2, name: "B" });
  const h = createHash("sha256");
  for (let i = 0; i < steps; i++) {
    const t = i % 90;
    world.step(
      TICK_DT,
      new Map([
        [P1, { ...NO_CONTROLS, thrust: t < 50, left: t > 60, fire: i % 7 === 0, seq: seq(i + 1) }],
        [P2, { ...NO_CONTROLS, thrust: true, right: t < 30, fire: i % 5 === 0, seq: seq(i + 1) }],
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

test("Lab 6: the TypeScript migration did not change the runtime (hash = the Lab 5 JS value)", () => {
  // Computed with the Lab 5 JavaScript code (tag lab-05) on Node 22. Types are erased: if this
  // changes, the migration changed behavior, not just annotations.
  assert.equal(runAndHash(7, 600), "ab7e6ec996068894");
  assert.equal(runAndHash(2026, 3000), "466cc4337ce65864");
});

test("prediction = server: predictStep follows Ship.update exactly in open space", () => {
  const arena = createArena();
  const world = new World({ seed: 3, asteroids: 0, pickupEvery: 1e9 });
  world.addPlayer({ id: P1 });
  const ship = shipOf(world, P1);
  const body = bodyFromSnapshot({
    kind: "ship",
    id: entityId(1),
    playerId: P1,
    hp: 100,
    flags: 0,
    x: ship.pos.x,
    y: ship.pos.y,
    vx: 0,
    vy: 0,
    a: ship.angle,
    cooldown: 0,
  });
  for (let i = 0; i < 200; i++) {
    const c = { ...NO_CONTROLS, thrust: i % 40 < 25, left: i % 60 > 40 };
    world.step(TICK_DT, new Map([[P1, c]]));
    predictStep(body, c, TICK_DT, arena);
  }
  assert.ok(Math.abs(body.pos.x - ship.pos.x) < 1e-9 && Math.abs(body.pos.y - ship.pos.y) < 1e-9);
  assert.equal(body.angle, ship.angle);
});

test("integrate is a pure function of (state, controls, dt)", () => {
  const run = () => {
    const b = { pos: new Vector2(1, 2), vel: new Vector2(), angle: 0.3, thrust: false };
    for (let i = 0; i < 1000; i++)
      integrate(b, { ...NO_CONTROLS, thrust: i % 3 > 0, left: i % 10 < 2 }, TICK_DT);
    return [b.pos.x, b.pos.y, b.vel.x, b.angle];
  };
  assert.deepEqual(run(), run());
});

function sampleSnapshot(): Snapshot {
  const world = new World({ seed: 11 });
  for (let id = 1; id <= 4; id++) world.addPlayer({ id: playerId(id), name: `P${id}` });
  const events = collectEvents(world);
  for (let i = 0; i < 40; i++) {
    world.step(
      TICK_DT,
      new Map([
        [P1, { ...NO_CONTROLS, fire: true, seq: seq(i + 1) }],
        [playerId(3), { ...NO_CONTROLS, thrust: true, fire: true, seq: seq(i + 1) }],
      ]),
    );
  }
  return { ...buildSnapshot(world, tick(world.tick), events.drain()), ack: seq(1234) };
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
    assert.ok(d);
    assert.equal(d.id, e.id);
    assert.equal(d.kind, e.kind);
    assert.ok(Math.abs(d.x - e.x) < 1e-3 && Math.abs(d.y - e.y) < 1e-3, "f32 position");
    assert.ok(Math.abs(d.a - e.a) <= 0.0005 + 1e-9, "angle quantized to 1/1000 rad");
    // Narrowing BOTH sides: checking e.kind says nothing about d's type.
    if (e.kind === "ship" && d.kind === "ship")
      assert.deepEqual([d.playerId, d.hp, d.flags], [e.playerId, e.hp, e.flags]);
    if (e.kind === "bullet" && d.kind === "bullet") assert.equal(d.seq, e.seq & 0xffff);
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
  const input: Input = {
    seq: seq(70000),
    tick: tick(5),
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
  bytes[10] = 0b100000;
  assert.throws(() => binary.decodeInput(bytes), /reserved/);
  assert.throws(() => binary.decodeInput(new Uint8Array(5)), /11 bytes/);
});

test("JSON codec gives the same decoded shapes as binary", () => {
  const snap = sampleSnapshot();
  const viaJson = json.decodeSnapshot(json.encodeSnapshot(snap));
  const viaBinary = binary.decodeSnapshot(binary.encodeSnapshot(snap));
  assert.equal(viaJson.entities.length, viaBinary.entities.length);
  viaJson.entities.forEach((e, i) => {
    const b = viaBinary.entities[i];
    assert.equal(e.id, b?.id);
    assert.ok(b && Math.abs(e.x - b.x) < 0.01);
  });
  assert.throws(() => json.decodeSnapshot('{"type":"snapshot","tick":-1}'), /snapshot/);
  const input: Input = {
    seq: seq(3),
    tick: tick(9),
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
  world.addPlayer({ id: P1 });
  const events = collectEvents(world);
  world.onShipDestroyed(shipOf(world, P1), P2);
  const batch = events.drain();
  assert.ok(batch.some((e) => e.type === EVENT.kill && e.a === 1 && e.b === 2));
  assert.equal(events.drain().length, 0);
});

test("netIds are u16, unique among live entities, and reused after removal", () => {
  const world = new World({ seed: 1, asteroids: 3, pickupEvery: 1e9 });
  const ids = [...world].map((e) => e.netId);
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(ids.every((id) => id != null && id >= 1 && id <= 0xffff));
  world.addPlayer({ id: playerId(5) });
  assert.ok(world.removePlayer(playerId(5)));
  world.step(TICK_DT, new Map());
  assert.equal(world.players.size, 0);
});

test("server arenas = client's arenas.json (two copies, kept equal)", () => {
  const file: unknown = JSON.parse(
    readFileSync(new URL("../../client/public/assets/arenas.json", import.meta.url), "utf8"),
  );
  assert.deepEqual(file, JSON.parse(JSON.stringify(ARENAS)));
});
