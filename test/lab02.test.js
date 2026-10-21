// Lab 2: Vector2 purity, the entity model, the Map-based world, collisions, composition, `this`.

import { test } from "node:test";
import assert from "node:assert/strict";

import { Vector2 } from "../src/sim/vector.js";
import { Entity } from "../src/sim/entity.js";
import { Ship, NO_CONTROLS, SHIP_PARAMS } from "../src/sim/ship.js";
import { Bullet, BULLET_TTL } from "../src/sim/bullet.js";
import { Asteroid } from "../src/sim/asteroid.js";
import { Pickup } from "../src/sim/pickup.js";
import { Explosion } from "../src/sim/explosion.js";
import { World } from "../src/sim/world.js";
import { findCollisionsNaive } from "../src/sim/collision.js";
import { homing } from "../src/sim/behaviors.js";
import { createRng } from "../src/sim/rng.js";

const STEP = 1 / 60;
const emptyWorld = (options = {}) => new World({ asteroids: 0, pickupEvery: 1e9, ...options });
const FIRE = { ...NO_CONTROLS, fire: true };

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
  const a = new Entity({ kind: "x" });
  const b = new Entity({ kind: "x" });
  assert.notEqual(a.id, b.id);
  assert.throws(() => {
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
  const ship = new Ship({ playerId: 1 });
  ship.invulnerable = 0;
  assert.equal(ship.hp, 100);
  assert.throws(() => {
    ship.hp = 1;
  }, TypeError);
  assert.equal(ship.damage(30), false);
  assert.equal(ship.hp, 70);
  assert.equal(ship.damage(100), true);
  assert.equal(ship.alive, false);
});

test("the `this` bug: a detached method loses its receiver", () => {
  const world = emptyWorld();
  const ship = world.addPlayer({ id: 1 }) && world.shipOf(1);
  const detached = ship.fire;
  assert.throws(() => detached(world), TypeError); // default binding: this === undefined
  // the three fixes
  ship.cooldown = 0;
  assert.ok((() => ship.fire(world))() instanceof Bullet);
  assert.ok(ship.fire.bind(ship)(world) instanceof Bullet);
  assert.ok(detached.call(ship, world) instanceof Bullet);
});

test("Map vs object as a dictionary", () => {
  const o = { 1: "x" };
  const m = new Map([[1, "x"]]);
  assert.equal(o["1"], "x"); // object keys become strings
  assert.equal(m.get("1"), undefined); // Map keys keep their type
  assert.equal(m.get(1), "x");
});

test("World: Map storage, iterable, ofKind is a lazy generator", () => {
  const world = emptyWorld();
  world.addPlayer({ id: 1 });
  world.spawn(Asteroid.random(world.rng, new Vector2(100, 100)));
  assert.equal(world.size, 2);
  assert.deepEqual(
    [...world].map((e) => e.kind),
    ["ship", "asteroid"],
  );
  const gen = world.ofKind("asteroid");
  assert.equal(typeof gen.next, "function");
  assert.equal([...gen].length, 1);
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
  world.addPlayer({ id: 1 });
  const ship = world.shipOf(1);
  world.step(STEP, new Map([[1, FIRE]]));
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
    new Bullet({ pos: new Vector2(10, 10), vel: new Vector2(1, 0), angle: 0, ownerId: 1 }),
  );
  for (let t = 0; t < BULLET_TTL + 0.05; t += STEP) world.step(STEP);
  assert.equal(world.get(b.id), undefined);
});

test("collision system returns pairs and honours wrap-around", () => {
  const arena = { width: 1000, height: 1000 };
  const a = new Entity({ kind: "a", pos: new Vector2(2, 500), radius: 5 });
  const b = new Entity({ kind: "b", pos: new Vector2(997, 500), radius: 5 }); // 5 units apart via the edge
  const c = new Entity({ kind: "c", pos: new Vector2(500, 500), radius: 5 });
  const pairs = findCollisionsNaive([a, b, c], arena);
  assert.equal(pairs.length, 1);
  assert.deepEqual(pairs[0], [a, b]);
});

test("bullet damages another ship, kill scores, ship respawns after 2 s", () => {
  const world = emptyWorld();
  world.addPlayer({ id: 1 });
  world.addPlayer({ id: 2 });
  const victim = world.shipOf(2);
  victim.invulnerable = 0;
  for (let i = 0; i < 5; i++) {
    world.spawn(
      new Bullet({ pos: victim.pos.clone(), vel: new Vector2(), angle: 0, ownerId: 1, damage: 20 }),
    );
  }
  world.step(STEP);
  assert.equal(victim.alive, false);
  assert.equal(world.players.get(1).score, 100);
  assert.ok([...world.ofKind("explosion")].length >= 1);
  for (let t = 0; t < 2.05; t += STEP) world.step(STEP);
  const reborn = world.shipOf(2);
  assert.ok(reborn && reborn !== victim && reborn.hp === 100);
});

test("own bullets do not hit their owner", () => {
  const world = emptyWorld();
  world.addPlayer({ id: 1 });
  const ship = world.shipOf(1);
  ship.invulnerable = 0;
  world.spawn(new Bullet({ pos: ship.pos.clone(), vel: new Vector2(), angle: 0, ownerId: 1 }));
  world.step(STEP);
  assert.equal(ship.hp, 100);
});

test("big asteroid splits into two small ones and scores", () => {
  const world = emptyWorld();
  world.addPlayer({ id: 1 });
  const rock = world.spawn(Asteroid.random(world.rng, new Vector2(300, 300), "big"));
  for (let i = 0; i < 3; i++) {
    world.spawn(
      new Bullet({ pos: rock.pos.clone(), vel: new Vector2(), angle: 0, ownerId: 1, damage: 20 }),
    );
  }
  world.step(STEP);
  assert.equal(rock.alive, false);
  assert.equal([...world.ofKind("asteroid")].filter((a) => a.size === "small").length, 2);
  assert.equal(world.players.get(1).score, 20);
});

test("composition: the SAME homing behavior steers a bullet and an asteroid", () => {
  const world = emptyWorld();
  world.addPlayer({ id: 1 });
  const target = world.shipOf(1);
  target.invulnerable = 0;
  target.pos.set(800, 450);
  const make = [
    () =>
      new Bullet({ pos: new Vector2(500, 450), vel: new Vector2(0, 300), angle: 0, ownerId: 9 }),
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
  world.addPlayer({ id: 1 });
  const ship = world.shipOf(1);
  ship.invulnerable = 0;
  for (const type of ["shield", "rapid", "homing"]) {
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
    world.addPlayer({ id: 1 });
    world.addPlayer({ id: 2 });
    for (let i = 0; i < 600; i++) {
      const c1 = { ...NO_CONTROLS, thrust: i % 100 < 60, left: i % 50 < 10, fire: i % 7 === 0 };
      const c2 = { ...NO_CONTROLS, right: true, fire: i % 11 === 0 };
      world.step(
        STEP,
        new Map([
          [1, c1],
          [2, c2],
        ]),
      );
    }
    return world.snapshot();
  };
  assert.deepEqual(run(), run());
});
