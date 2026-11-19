// Game rules: what happens when two kinds of things touch. One handler per unordered pair of
// kinds.
//
// Lab 6: the string-keyed handler table became two nested switches on `kind`. A table keyed by
// "asteroid|bullet" cannot be checked by the compiler (any string fits); the switches can —
// each one ends in assertNever, so adding a sixth kind of entity makes this file fail to
// compile until every pair involving it has been given a meaning (even if that meaning is
// "nothing happens").

import { Asteroid } from "./asteroid.ts";
import { Explosion } from "./explosion.ts";
import { wrappedDelta, type Arena } from "./arena.ts";
import { assertNever } from "./math.ts";
import type { World } from "./world.ts";
import type { AnyEntity } from "./kinds.ts";
import type { Ship } from "./ship.ts";
import type { Bullet } from "./bullet.ts";
import type { Pickup } from "./pickup.ts";
import type { Vector2 } from "./vector.ts";
import type { PlayerId } from "../protocol/ids.ts";

const ASTEROID_CONTACT_DAMAGE = 25;

type Movable = { pos: Vector2; vel: Vector2; radius: number };

/** Elastic-ish bounce between two circles + positional separation. Masses ~ radius^2. */
export function bounce(a: Movable, b: Movable, arena: Arena, restitution = 0.9): void {
  let nx = wrappedDelta(a.pos.x, b.pos.x, arena.width);
  let ny = wrappedDelta(a.pos.y, b.pos.y, arena.height);
  let dist = Math.hypot(nx, ny);
  if (dist === 0) {
    nx = 1;
    ny = 0;
    dist = 1e-6;
  }
  nx /= dist;
  ny /= dist;

  const ma = a.radius * a.radius;
  const mb = b.radius * b.radius;
  const overlap = a.radius + b.radius - dist;
  if (overlap > 0) {
    // push apart proportionally to the other's mass
    a.pos.x -= nx * overlap * (mb / (ma + mb));
    a.pos.y -= ny * overlap * (mb / (ma + mb));
    b.pos.x += nx * overlap * (ma / (ma + mb));
    b.pos.y += ny * overlap * (ma / (ma + mb));
  }

  const relVel = (b.vel.x - a.vel.x) * nx + (b.vel.y - a.vel.y) * ny;
  if (relVel >= 0) return; // already separating
  const impulse = (-(1 + restitution) * relVel) / (1 / ma + 1 / mb);
  a.vel.x -= (impulse / ma) * nx;
  a.vel.y -= (impulse / ma) * ny;
  b.vel.x += (impulse / mb) * nx;
  b.vel.y += (impulse / mb) * ny;
}

function destroyAsteroid(world: World, asteroid: Asteroid, byPlayerId: PlayerId): void {
  asteroid.kill();
  world.spawn(
    new Explosion({
      pos: asteroid.pos.clone(),
      rng: world.rng,
      count: asteroid.size === "big" ? 28 : 14,
      color: asteroid.seeker ? "#ff8a8a" : "#c9b38f",
    }),
  );
  if (asteroid.size === "big") {
    // Split into two smaller ones flying apart.
    for (const side of [-1, 1]) {
      const dir = asteroid.vel.normalize().rotate((side * Math.PI) / 2);
      const pos = asteroid.pos.add(dir.scale(22));
      const vel = asteroid.vel.add(dir.scale(world.rng.range(50, 90)));
      world.spawn(new Asteroid({ pos, vel, size: "small", rng: world.rng }));
    }
  }
  world.notify("exploded", {
    kind: "asteroid",
    size: asteroid.size,
    x: asteroid.pos.x,
    y: asteroid.pos.y,
  });
  world.addScore(byPlayerId, asteroid.size === "big" ? 20 : 10, asteroid.pos);
}

function asteroidBullet(world: World, asteroid: Asteroid, bullet: Bullet): void {
  bullet.kill();
  asteroid.hp -= bullet.damage;
  asteroid.vel.addScaledInPlace(bullet.vel, 0.02); // a little knock-back
  if (asteroid.hp <= 0) destroyAsteroid(world, asteroid, bullet.ownerId);
  else
    world.notify("hit", {
      target: "asteroid",
      by: bullet.ownerId,
      x: bullet.pos.x,
      y: bullet.pos.y,
    });
}

function bulletShip(world: World, bullet: Bullet, ship: Ship): void {
  if (bullet.ownerId === ship.playerId) return; // no friendly fire on yourself
  bullet.kill();
  if (ship.damage(bullet.damage)) world.onShipDestroyed(ship, bullet.ownerId);
  else
    world.notify("hit", {
      target: "ship",
      playerId: ship.playerId,
      by: bullet.ownerId,
      x: ship.pos.x,
      y: ship.pos.y,
    });
}

function asteroidShip(world: World, asteroid: Asteroid, ship: Ship): void {
  bounce(asteroid, ship, world.arena, 0.6);
  if (ship.contactCooldown > 0) return;
  ship.contactCooldown = 0.5;
  if (ship.damage(ASTEROID_CONTACT_DAMAGE)) world.onShipDestroyed(ship, null);
  else
    world.notify("hit", {
      target: "ship",
      playerId: ship.playerId,
      by: null,
      x: ship.pos.x,
      y: ship.pos.y,
    });
}

function pickupShip(world: World, pickup: Pickup, ship: Ship): void {
  pickup.kill();
  ship.applyEffect(pickup.type, pickup.spec.duration);
  world.notify("picked", {
    playerId: ship.playerId,
    type: pickup.type,
    x: pickup.pos.x,
    y: pickup.pos.y,
  });
  world.emit(`${world.nameOf(ship.playerId)}: ${pickup.type}`);
}

/**
 * Dispatches a detected pair. The two entities are sorted by kind first, so only pairs with
 * a.kind <= b.kind (alphabetically) can reach a branch; the others are listed to keep the
 * switches exhaustive and do nothing.
 */
export function resolveCollision(world: World, a: AnyEntity, b: AnyEntity): void {
  const [first, second] = a.kind <= b.kind ? [a, b] : [b, a];
  switch (first.kind) {
    case "asteroid":
      switch (second.kind) {
        case "asteroid":
          return bounce(first, second, world.arena);
        case "bullet":
          return asteroidBullet(world, first, second);
        case "ship":
          return asteroidShip(world, first, second);
        case "pickup": // pickups float through asteroids
        case "explosion": // radius 0: never collides
          return;
        default:
          return assertNever(second, "entity kind");
      }
    case "bullet":
      switch (second.kind) {
        case "ship":
          return bulletShip(world, first, second);
        case "asteroid":
        case "bullet": // bullets pass through each other
        case "pickup": // and through pickups
        case "explosion":
          return;
        default:
          return assertNever(second, "entity kind");
      }
    case "pickup":
      switch (second.kind) {
        case "ship":
          return pickupShip(world, first, second);
        case "asteroid":
        case "bullet":
        case "pickup":
        case "explosion":
          return;
        default:
          return assertNever(second, "entity kind");
      }
    case "ship":
      switch (second.kind) {
        case "ship":
          return bounce(first, second, world.arena, 0.8);
        case "asteroid":
        case "bullet":
        case "pickup":
        case "explosion":
          return;
        default:
          return assertNever(second, "entity kind");
      }
    case "explosion":
      return;
    default:
      return assertNever(first, "entity kind");
  }
}
