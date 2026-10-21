// Game rules: what happens when two kinds of things touch. One handler per unordered pair of
// kinds, looked up in a table — adding a new kind adds rows, not subclasses.

import { Asteroid } from "./asteroid.js";
import { Explosion } from "./explosion.js";
import { wrappedDelta } from "./arena.js";

const ASTEROID_CONTACT_DAMAGE = 25;

/** Elastic-ish bounce between two circles + positional separation. Masses ~ radius^2. */
export function bounce(a, b, arena, restitution = 0.9) {
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

function destroyAsteroid(world, asteroid, byPlayerId) {
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
  world.addScore(byPlayerId, asteroid.size === "big" ? 20 : 10);
}

const HANDLERS = {
  "asteroid|bullet"(world, asteroid, bullet) {
    bullet.kill();
    asteroid.hp -= bullet.damage;
    asteroid.vel.addScaledInPlace(bullet.vel, 0.02); // a little knock-back
    if (asteroid.hp <= 0) destroyAsteroid(world, asteroid, bullet.ownerId);
  },

  "bullet|ship"(world, bullet, ship) {
    if (bullet.ownerId === ship.playerId) return; // no friendly fire on yourself
    bullet.kill();
    if (ship.damage(bullet.damage)) world.onShipDestroyed(ship, bullet.ownerId);
  },

  "asteroid|ship"(world, asteroid, ship) {
    bounce(asteroid, ship, world.arena, 0.6);
    if (ship.contactCooldown > 0) return;
    ship.contactCooldown = 0.5;
    if (ship.damage(ASTEROID_CONTACT_DAMAGE)) world.onShipDestroyed(ship, null);
  },

  "asteroid|asteroid"(world, a, b) {
    bounce(a, b, world.arena);
  },

  "pickup|ship"(world, pickup, ship) {
    pickup.kill();
    ship.applyEffect(pickup.type, pickup.spec.duration);
    world.emit(`P${ship.playerId}: ${pickup.type}`);
  },

  "ship|ship"(world, a, b) {
    bounce(a, b, world.arena, 0.8);
  },
  // bullet|bullet, bullet|pickup, asteroid|pickup: intentionally nothing
};

/** Dispatches a detected pair to its handler (kinds sorted so "a|b" == "b|a"). */
export function resolveCollision(world, a, b) {
  const [first, second] = a.kind <= b.kind ? [a, b] : [b, a];
  HANDLERS[`${first.kind}|${second.kind}`]?.(world, first, second);
}
