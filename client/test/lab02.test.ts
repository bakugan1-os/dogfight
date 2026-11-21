// Lab 2: Vector2 purity, the entity model, the Map-based world, collisions, composition, `this`.

import { test } from "vitest";
import assert from "node:assert/strict";

import { Vector2 } from "@dogfight/shared/sim/vector.ts";
import { Entity } from "@dogfight/shared/sim/entity.ts";
import { Ship, NO_CONTROLS, SHIP_PARAMS } from "@dogfight/shared/sim/ship.ts";
import { Bullet, BULLET_TTL } from "@dogfight/shared/sim/bullet.ts";
import { Asteroid } from "@dogfight/shared/sim/asteroid.ts";
import { Pickup } from "@dogfight/shared/sim/pickup.ts";
import { Explosion } from "@dogfight/shared/sim/explosion.ts";
import { World } from "@dogfight/shared/sim/world.ts";
import { findCollisionsNaive } from "@dogfight/shared/sim/collision.ts";
import { homing } from "@dogfight/shared/sim/behaviors.ts";
import { createRng } from "@dogfight/shared/sim/rng.ts";
import { playerId, type PlayerId } from "@dogfight/shared/protocol/ids.ts";
import type { WorldOptions } from "@dogfight/shared/sim/world.ts";

const STEP = 1 / 60;
const P1 = playerId(1);
const P2 = playerId(2);
const emptyWorld = (options: WorldOptions = {}) =>
  new World({ asteroids: 0, pickupEvery: 1e9, ...options });
const FIRE = { ...NO_CONTROLS, fire: true };

/** "This player has a ship" — a failed assertion instead of a TypeError on undefined. */
function shipOf(world: World, id: PlayerId): Ship {
  const ship = world.shipOf(id);
  assert.ok(ship, `player ${id} has a ship`);
  return ship;
}

test("Vector2: pure methods return new vectors and never mutate", () => {
  const a = new Vector2(1, 2);
  const b = new Vector2(3, 4);
  const sum = a.add(b);
  assert.deepEqual([sum.x, sum.y], [4, 6]);
  assert.deepEqual([a.x, a.y], [1, 2]);
  assert.notEqual(a.normalize(), a);
  assert.equal(b.length(), 5);
  assert.equal(a.dot(b), 11);
  const r = new Vector2(1, 0).rotate(Math.PI / 2);
  assert.ok(Math.abs(r.x) < 1e-12 && Math.abs(r.y - 1) < 1e-12);
  const f = Vector2.fromAngle(Math.PI, 2);
  assert.ok(Math.abs(f.x + 2) < 1e-12);
  assert.equal(a.addScaledInPlace(b, 2), a); // in-place variants DO mutate and return this
  assert.deepEqual([a.x, a.y], [7, 10]);
});

test("Entity ids: unique, read-only, private counter", () => {
  const a = new Entity({ kind: "asteroid" });
  const b = new Entity({ kind: "asteroid" });
  assert.notEqual(a.id, b.id);
  assert.throws(() => {
    // @ts-expect-error -- Lab 6: the compiler refuses this too ("read-only property"); the test
    // still checks the RUNTIME behaviour, because types are erased.
    a.id = 999; // getter only; classes are strict mode -> TypeError
  }, TypeError);
  assert.equal(Object.keys(a).includes("id"), false);
  assert.equal("nextId" in Entity, false);
});

test("inheritance is exactly one level deep", () => {
  for (const Cls of [Ship, Bullet, Asteroid, Pickup, Explosion]) {
    assert.equal(Object.getPrototypeOf(Cls.prototype), Entity.prototype, Cls.name);
  }
  assert.equal(Object.getPrototypeOf(Entity.prototype), Object.prototype);
});

test("methods are shared via the prototype, not copied per instance", () => {
  const rng = createRng(1);
  const a = Asteroid.random(rng, new Vector2(), "big");
  const b = Asteroid.random(rng, new Vector2(), "small");
  assert.equal(a.update, b.update);
  assert.equal(Object.hasOwn(a, "update"), false);
});

test("Ship #hp is private; damage() is the only way down", () => {
  const ship = new Ship({ playerId: P1 });
  ship.invulnerable = 0;
  assert.equal(ship.hp, 100);
  assert.throws(() => {
    // @ts-expect-error -- read-only at compile time; the getter-only TypeError at run time
    ship.hp = 1;
  }, TypeError);
  assert.equal(ship.damage(30), false);
  assert.equal(ship.hp, 70);
  assert.equal(ship.damage(100), true);
  assert.equal(ship.alive, false);
});

test("the `this` bug: a detached method loses its receiver", () => {
  const world = emptyWorld();
  world.addPlayer({ id: P1 });
  const ship = shipOf(world, P1);
  const detached = ship.fire;
  // @ts-expect-error -- Lab 6: fire() declares `this: Ship`, so a bare call does not compile
  assert.throws(() => detached(world), TypeError); // default binding: this === undefined
  // the three fixes
  ship.cooldown = 0;
  assert.ok((() => ship.fire(world))() instanceof Bullet);
  assert.ok(ship.fire.bind(ship)(world) instanceof Bullet);
  assert.ok(detached.call(ship, world) instanceof Bullet);
});

test("Map vs object as a dictionary", () => {
  const o = { 1: "x" };
  const m = new Map<unknown, string>([[1, "x"]]);
  assert.equal(o["1"], "x"); // object keys become strings
  assert.equal(m.get("1"), undefined); // Map keys keep their type
  assert.equal(m.get(1), "x");
});

test("World: Map storage, iterable, ofKind is a per-kind index (Lab 7; was a generator)", () => {
  const world = emptyWorld();
  world.addPlayer({ id: P1 });
  world.spawn(Asteroid.random(world.rng, new Vector2(100, 100)));
  assert.equal(world.size, 2);
  assert.deepEqual(
    [...world].map((e) => e.kind),
    ["ship", "asteroid"],
  );
  const rocks = world.ofKind("asteroid");
  assert.equal(rocks.size, 1);
  assert.equal([...world.ofKind("ship")][0]?.kind, "ship");
});

test("World: despawn is deferred to the sweep at the end of the step", () => {
  const world = emptyWorld();
  const a = world.spawn(Asteroid.random(world.rng, new Vector2(100, 100)));
  world.despawn(a.id);
  assert.equal(world.get(a.id), a); // still there...
  assert.equal(a.alive, false); // ...but marked dead
  world.step(STEP);
  assert.equal(world.get(a.id), undefined); // swept
});

test("World: entities spawned during a step are not updated in that step", () => {
  const world = emptyWorld();
  world.addPlayer({ id: P1 });
  const ship = shipOf(world, P1);
  world.step(STEP, new Map([[P1, FIRE]]));
  const [bullet] = world.ofKind("bullet");
  assert.ok(bullet, "a bullet was fired");
  assert.deepEqual([bullet.prevPos.x, bullet.prevPos.y], [bullet.pos.x, bullet.pos.y]);
  // inherited velocity: bullet speed = ship velocity + muzzle speed along the heading
  const expected = ship.vel.add(Vector2.fromAngle(ship.angle, SHIP_PARAMS.bulletSpeed));
  assert.ok(bullet.vel.sub(expected).length() < 1e-9);
});

test("Bullet expires after its TTL", () => {
  const world = emptyWorld();
  const b = world.spawn(
    new Bullet({ pos: new Vector2(10, 10), vel: new Vector2(1, 0), angle: 0, ownerId: P1 }),
  );
  for (let t = 0; t < BULLET_TTL + 0.05; t += STEP) world.step(STEP);
  assert.equal(world.get(b.id), undefined);
});

test("collision system returns pairs and honours wrap-around", () => {
  const arena = { width: 1000, height: 1000 };
  // Plain objects: detection is generic over anything with alive/collides/pos/radius.
  const body = (x: number) => ({
    alive: true,
    collides: true,
    pos: new Vector2(x, 500),
    radius: 5,
  });
  const a = body(2);
  const b = body(997); // 5 units apart via the edge
  const c = body(500);
  const pairs = findCollisionsNaive([a, b, c], arena);
  assert.equal(pairs.length, 1);
  assert.deepEqual(pairs[0], [a, b]);
});

test("bullet damages another ship, kill scores, ship respawns after 2 s", () => {
  const world = emptyWorld();
  world.addPlayer({ id: P1 });
  world.addPlayer({ id: P2 });
  const victim = shipOf(world, P2);
  victim.invulnerable = 0;
  for (let i = 0; i < 5; i++) {
    world.spawn(
      new Bullet({
        pos: victim.pos.clone(),
        vel: new Vector2(),
        angle: 0,
        ownerId: P1,
        damage: 20,
      }),
    );
  }
  world.step(STEP);
  assert.equal(victim.alive, false);
  assert.equal(world.players.get(P1)?.score, 100);
  assert.ok([...world.ofKind("explosion")].length >= 1);
  for (let t = 0; t < 2.05; t += STEP) world.step(STEP);
  const reborn = world.shipOf(P2);
  assert.ok(reborn && reborn !== victim && reborn.hp === 100);
});

test("own bullets do not hit their owner", () => {
  const world = emptyWorld();
  world.addPlayer({ id: P1 });
  const ship = shipOf(world, P1);
  ship.invulnerable = 0;
  world.spawn(new Bullet({ pos: ship.pos.clone(), vel: new Vector2(), angle: 0, ownerId: P1 }));
  world.step(STEP);
  assert.equal(ship.hp, 100);
});

test("big asteroid splits into two small ones and scores", () => {
  const world = emptyWorld();
  world.addPlayer({ id: P1 });
  const rock = world.spawn(Asteroid.random(world.rng, new Vector2(300, 300), "big"));
  for (let i = 0; i < 3; i++) {
    world.spawn(
      new Bullet({ pos: rock.pos.clone(), vel: new Vector2(), angle: 0, ownerId: P1, damage: 20 }),
    );
  }
  world.step(STEP);
  assert.equal(rock.alive, false);
  assert.equal([...world.ofKind("asteroid")].filter((a) => a.size === "small").length, 2);
  assert.equal(world.players.get(P1)?.score, 20);
});

test("composition: the SAME homing behavior steers a bullet and an asteroid", () => {
  const world = emptyWorld();
  world.addPlayer({ id: P1 });
  const target = shipOf(world, P1);
  target.invulnerable = 0;
  target.pos.set(800, 450);
  const make = [
    () =>
      new Bullet({
        pos: new Vector2(500, 450),
        vel: new Vector2(0, 300),
        angle: 0,
        ownerId: playerId(9),
      }),
    () => Asteroid.random(world.rng, new Vector2(500, 450), "small"),
  ];
  for (const create of make) {
    const e = world.spawn(create().with(homing({ turnRate: 10, range: 1000 })));
    e.vel = new Vector2(0, 300);
    for (let i = 0; i < 10; i++) world.step(STEP);
    // after turning, the velocity points (roughly) at the target, to the right
    assert.ok(e.vel.x > 250, `${e.kind}: vel ${e.vel}`);
  }
});

test("pickups: shield absorbs one hit, rapid shortens the cooldown, homing tags bullets", () => {
  const world = emptyWorld();
  world.addPlayer({ id: P1 });
  const ship = shipOf(world, P1);
  ship.invulnerable = 0;
  for (const type of ["shield", "rapid", "homing"] as const) {
    world.spawn(new Pickup({ pos: ship.pos.clone(), type }));
  }
  world.step(STEP);
  assert.deepEqual([...ship.effects.keys()].sort(), ["homing", "rapid", "shield"]);
  assert.equal(ship.damage(50), false);
  assert.equal(ship.hp, 100); // shield took it
  assert.equal(ship.effects.has("shield"), false);
  ship.cooldown = 0;
  const bullet = ship.fire(world);
  assert.equal(ship.cooldown, SHIP_PARAMS.rapidCooldown);
  assert.ok(bullet.behaviors.some((b) => b.name === "homing"));
});

test("determinism: same seed + same inputs -> same world", () => {
  const run = () => {
    const world = new World({ seed: 7 });
    world.addPlayer({ id: P1 });
    world.addPlayer({ id: P2 });
    for (let i = 0; i < 600; i++) {
      const c1 = { ...NO_CONTROLS, thrust: i % 100 < 60, left: i % 50 < 10, fire: i % 7 === 0 };
      const c2 = { ...NO_CONTROLS, right: true, fire: i % 11 === 0 };
      world.step(
        STEP,
        new Map([
          [P1, c1],
          [P2, c2],
        ]),
      );
    }
    return world.snapshot();
  };
  assert.deepEqual(run(), run());
});
