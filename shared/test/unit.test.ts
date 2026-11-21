// Lab 7: unit tests for the shared core — small, fast, one idea each.

import { test, expect, describe } from "vitest";

import { Vector2 } from "../sim/vector.ts";
import {
  integrate,
  NO_CONTROLS,
  SHIP_PARAMS,
  Ship,
  type Controls,
  type ShipBody,
} from "../sim/ship.ts";
import { findCollisionsNaive } from "../sim/collision.ts";
import { World } from "../sim/world.ts";
import { Bullet } from "../sim/bullet.ts";
import { Bus } from "../sim/bus.ts";
import { createRng } from "../sim/rng.ts";
import { assertNever, clamp, lerp, lerpAngle, wrapAngle } from "../sim/math.ts";
import { createArena } from "../sim/arena.ts";
import { bodyFromSnapshot, predictStep, reconcile, type PendingInput } from "../sim/predict.ts";
import { TICK_DT, type ShipState } from "../protocol/messages.ts";
import { entityId, isPlayerId, isSeq, playerId, seq, tick } from "../protocol/ids.ts";
import { parseServerMessage, CLOSE, parseClientMessage } from "../protocol/control.ts";

const P1 = playerId(1);
const body = (): ShipBody => ({
  pos: new Vector2(100, 100),
  vel: new Vector2(),
  angle: 0,
  thrust: false,
});
const THRUST: Controls = { ...NO_CONTROLS, thrust: true };

describe("Vector2", () => {
  test("pure ops do not mutate; in-place ops do and return this", () => {
    const a = new Vector2(3, 4);
    expect(a.scale(2)).toEqual(new Vector2(6, 8));
    expect(a.sub(new Vector2(1, 1))).toEqual(new Vector2(2, 3));
    expect(a.length()).toBe(5);
    expect(a.lengthSq()).toBe(25);
    expect(a.cross(new Vector2(1, 0))).toBe(-4);
    expect(new Vector2().normalize()).toEqual(new Vector2(0, 0)); // no NaN for the zero vector
    expect(a).toEqual(new Vector2(3, 4));
    expect(
      a.set(1, 2).copy(new Vector2(5, 6)).scaleInPlace(2).addInPlace(new Vector2(1, 1)),
    ).toEqual(new Vector2(11, 13));
    expect(new Vector2(1, 2).equals({ x: 1, y: 2 })).toBe(true);
    expect(Vector2.from({ x: 7, y: 8 }).clone().toString()).toBe("(7.00, 8.00)");
  });
});

describe("integrate (known inputs)", () => {
  test("no input from rest: nothing moves", () => {
    const b = integrate(body(), NO_CONTROLS, TICK_DT);
    expect([b.pos.x, b.pos.y, b.vel.x, b.vel.y, b.angle]).toEqual([100, 100, 0, 0, 0]);
  });
  test("one step of thrust along +x: v = a·dt·e^(−drag·dt), x += v·dt (semi-implicit Euler)", () => {
    const b = integrate(body(), THRUST, TICK_DT);
    const v = SHIP_PARAMS.thrust * TICK_DT * Math.exp(-SHIP_PARAMS.drag * TICK_DT);
    expect(b.vel.x).toBeCloseTo(v, 12);
    expect(b.pos.x).toBeCloseTo(100 + v * TICK_DT, 12);
    expect(b.thrust).toBe(true);
  });
  test("turning: exactly turnRate·dt per step; left and right cancel", () => {
    expect(integrate(body(), { ...NO_CONTROLS, right: true }, 0.1).angle).toBeCloseTo(0.34, 12);
    expect(integrate(body(), { ...NO_CONTROLS, left: true, right: true }, 0.1).angle).toBe(0);
  });
});

describe("collision detection", () => {
  const arena = createArena(1000, 1000);
  const disc = (x: number, radius = 10) => ({
    alive: true,
    collides: true,
    pos: new Vector2(x, 500),
    radius,
  });
  test.each([
    ["overlapping", 100, 115, 1],
    ["exactly touching (distance = r1 + r2) does NOT count", 100, 120, 0],
    ["missing", 100, 150, 0],
    ["across the wrap-around edge (5 and 995 are 10 apart)", 5, 995, 1],
  ])("%s", (_name, x1, x2, pairs) => {
    expect(findCollisionsNaive([disc(x1), disc(x2)], arena)).toHaveLength(pairs);
  });
  test("dead or non-colliding bodies are skipped", () => {
    expect(
      findCollisionsNaive(
        [disc(100), { ...disc(105), alive: false }, { ...disc(108), collides: false }],
        arena,
      ),
    ).toEqual([]);
  });
  test("fast bullet TUNNELING: at 1200 u/s a bullet jumps 40 units per 1/30 s step — through a ship", () => {
    // Known limitation, measured: detection is discrete (positions AFTER the step). Bullet radius 3
    // + ship radius 14 = 17, so anything faster than 34 units/step can skip a ship entirely. Our
    // bullets reach 640 + 460 = 1100 u/s = 36.7 units/step only at maximum closing speed.
    const world = new World({ asteroids: 0, pickupEvery: 1e9 });
    world.addPlayer({ id: P1 });
    const ship = world.shipOf(P1);
    if (!ship) throw new Error("no ship");
    ship.invulnerable = 0;
    ship.pos.set(500, 450);
    const bullet = new Bullet({
      pos: new Vector2(480, 450),
      vel: new Vector2(1200, 0),
      ownerId: playerId(2),
    });
    world.spawn(bullet);
    world.step(TICK_DT);
    expect(bullet.pos.x).toBeCloseTo(520, 6); // it is now on the far side…
    expect(ship.hp).toBe(SHIP_PARAMS.maxHp); // …and never touched the ship
  });
});

describe("World.step determinism", () => {
  test("two worlds from the same seed, stepped with the same inputs, are deep-equal", () => {
    const make = () => {
      const w = new World({ seed: 99 });
      w.addPlayer({ id: P1 });
      return w;
    };
    const a = make();
    const b = make();
    for (let i = 0; i < 300; i++) {
      const inputs = new Map([[P1, { ...NO_CONTROLS, thrust: i % 3 === 0, fire: i % 5 === 0 }]]);
      a.step(TICK_DT, inputs);
      b.step(TICK_DT, inputs);
    }
    expect(a.snapshot()).toEqual(b.snapshot());
    expect(a.tick).toBe(300);
  });
});

describe("reconciliation (pure function)", () => {
  const arena = createArena();
  const server = (x: number, y: number, vx = 0): ShipState => ({
    kind: "ship",
    id: entityId(1),
    playerId: P1,
    hp: 100,
    flags: 0,
    cooldown: 0,
    x,
    y,
    a: 0,
    vx,
    vy: 0,
  });
  const pending = (from: number, to: number, controls: Controls = THRUST): PendingInput[] =>
    Array.from({ length: to - from + 1 }, (_, i) => ({ seq: seq(from + i), controls }));

  test("acknowledged inputs are dropped; the rest are replayed on top of the server state", () => {
    const r = reconcile(server(100, 100), pending(1, 10), seq(6), arena, null);
    expect(r.pending.map((p) => p.seq)).toEqual([7, 8, 9, 10]);
    const manual = bodyFromSnapshot(server(100, 100));
    for (let i = 0; i < 4; i++) predictStep(manual, THRUST, TICK_DT, arena);
    expect(r.body.pos).toEqual(manual.pos);
    expect(r.correction).toBeNull(); // no previous prediction to compare with
  });

  test("a correct prediction gives a zero correction", () => {
    const predicted = bodyFromSnapshot(server(100, 100));
    for (let i = 0; i < 4; i++) predictStep(predicted, THRUST, TICK_DT, arena);
    const r = reconcile(server(100, 100), pending(7, 10), seq(6), arena, predicted.pos);
    expect(r.correction?.distance).toBe(0);
  });

  test("a wrong prediction gives the exact difference, the short way around the arena", () => {
    const r = reconcile(server(10, 100), [], seq(5), arena, { x: arena.width - 10, y: 100 });
    expect(r.correction).toEqual({ dx: -20, dy: 0, distance: 20 });
  });

  test("the same arguments always give the same result (no hidden state)", () => {
    const args = [server(300, 200, 50), pending(3, 30), seq(2), arena, { x: 1, y: 2 }] as const;
    expect(reconcile(...args)).toEqual(reconcile(...args));
  });
});

describe("small pieces", () => {
  test("Bus: typed emit/on, unsubscribe, AbortSignal", () => {
    const bus = new Bus<{ ping: { n: number } }>();
    const got: number[] = [];
    const off = bus.on("ping", ({ n }) => got.push(n));
    const ac = new AbortController();
    bus.on("ping", ({ n }) => got.push(n * 10), ac.signal);
    bus.emit("ping", { n: 1 });
    off();
    ac.abort();
    bus.emit("ping", { n: 2 });
    expect(got).toEqual([1, 10]);
    expect(bus.listenerCount("ping")).toBe(0);
  });

  test("branded-id guards check the real ranges", () => {
    expect([isPlayerId(0), isPlayerId(1), isPlayerId(256), isPlayerId(1.5)]).toEqual([
      false,
      true,
      false,
      false,
    ]);
    expect([isSeq(-1), isSeq(0), isSeq(2 ** 32)]).toEqual([false, true, false]);
    expect(() => tick(-1)).toThrow(RangeError);
    expect(() => entityId(0)).toThrow(/EntityId/);
  });

  test("rng: deterministic, ranges respected, pick from a non-empty list", () => {
    const a = createRng(5);
    const b = createRng(5);
    const xs = Array.from({ length: 100 }, () => a.int(1, 6));
    expect(xs).toEqual(Array.from({ length: 100 }, () => b.int(1, 6)));
    expect(xs.every((x) => x >= 1 && x <= 6)).toBe(true);
    expect(["a", "b"]).toContain(a.pick(["a", "b"]));
  });

  test("math helpers", () => {
    expect(lerp(0, 10, 0.25)).toBe(2.5);
    expect(clamp(5, 0, 3)).toBe(3);
    expect(clamp(-1, 0, 3)).toBe(0);
    expect(wrapAngle(3 * Math.PI)).toBeCloseTo(-Math.PI, 12);
    expect(Math.abs(lerpAngle(3, -3, 0.5))).toBeCloseTo(Math.PI, 1);
    expect(() => assertNever("x" as never)).toThrow(/unexpected/);
  });

  test("ship effects expire; the shield absorbs exactly one hit", () => {
    const ship = new Ship({ playerId: P1 });
    ship.invulnerable = 0;
    ship.applyEffect("rapid", 0.05);
    ship.applyEffect("shield", 10);
    ship.update(0.1, new World({ asteroids: 0, pickupEvery: 1e9 }));
    expect(ship.effects.has("rapid")).toBe(false);
    expect(ship.damage(30)).toBe(false);
    expect(ship.hp).toBe(100);
    ship.invulnerable = 0;
    expect(ship.damage(30)).toBe(false);
    expect(ship.hp).toBe(70);
  });

  test("parseServerMessage: valid messages pass, garbage gets a close code", () => {
    expect(parseServerMessage('{"type":"pong","t":1,"tick":3}').ok).toBe(true);
    const bad = parseServerMessage('{"type":"pong","t":1}');
    expect(bad.ok ? null : bad.code).toBe(CLOSE.BAD_SHAPE);
    const notJson = parseServerMessage("{");
    expect(notJson.ok ? null : notJson.code).toBe(CLOSE.BAD_JSON);
    const proto = parseClientMessage('{"type":"__proto__"}');
    expect(proto.ok ? null : proto.code).toBe(CLOSE.UNKNOWN_TYPE);
  });
});
