// Client-side prediction of ONE ship (Lab 5, M2). The same `integrate` the server's Ship.update
// uses, plus the same wrap and cooldown bookkeeping, on a plain body. No collisions: the server
// decides those, and a reconciliation corrects the client when it disagrees.

import { integrate, SHIP_PARAMS } from "./ship.js";
import { wrapPosition } from "./arena.js";
import { Vector2 } from "./vector.js";

/** A ship's predictable state as plain data (+ Vector2 fields so integrate() can run on it). */
export function bodyFromSnapshot(e, rapid = false) {
  return {
    pos: new Vector2(e.x, e.y),
    vel: new Vector2(e.vx, e.vy),
    angle: e.a,
    thrust: false,
    cooldown: e.cooldown,
    rapid,
  };
}

export function cloneBody(b) {
  return { ...b, pos: b.pos.clone(), vel: b.vel.clone() };
}

/**
 * One fixed step of the local ship. Returns true if this step fires a bullet — the server's
 * Ship.update fires under exactly the same condition (cooldown reached 0 and fire held).
 */
export function predictStep(body, controls, dt, arena) {
  integrate(body, controls, dt);
  body.cooldown = Math.max(0, body.cooldown - dt);
  wrapPosition(arena, body.pos);
  if ((controls.fire || controls.firePressed) && body.cooldown === 0) {
    body.cooldown = body.rapid ? SHIP_PARAMS.rapidCooldown : SHIP_PARAMS.fireCooldown;
    return true;
  }
  return false;
}

/** Where a bullet fired from `body` this step starts and how fast it goes (as Ship.fire). */
export function bulletFrom(body) {
  const dir = Vector2.fromAngle(body.angle);
  return {
    pos: body.pos.add(dir.scale(SHIP_PARAMS.radius + 6)),
    vel: body.vel.add(dir.scale(SHIP_PARAMS.bulletSpeed)),
    angle: body.angle,
  };
}
