// Ship as plain data + one integration function.
// `integrate` depends only on (state, controls, dt): no DOM, no canvas, no clock, no randomness.
// Same inputs -> bit-for-bit the same result on every machine. That is what Lab 5 needs.

import { wrapAngle } from "./math.js";

/** Tuned by hand; the reasoning is written down in README ("Тюнінг керування"). */
export const SHIP_PARAMS = Object.freeze({
  turnRate: 3.4, // rad/s — a full turn in ~1.85 s: fast enough to dogfight, slow enough to aim
  thrust: 380, // units/s^2 — 0 -> 300 units/s in under a second
  drag: 0.55, // 1/s — exponential damping; ship coasts ~2 s after releasing thrust
  maxSpeed: 460, // units/s — crosses the 1600-wide arena in ~3.5 s
  radius: 14, // units — used for drawing now, for collisions in Lab 2
});

/** Neutral controls: nothing pressed. */
export const NO_CONTROLS = Object.freeze({ thrust: false, left: false, right: false, fire: false });

export function createShip(x = 800, y = 450, angle = -Math.PI / 2) {
  return { x, y, vx: 0, vy: 0, angle, thrust: false };
}

/** Copies every field of `src` into `dst` without allocating (used to keep the previous state). */
export function copyShip(dst, src) {
  dst.x = src.x;
  dst.y = src.y;
  dst.vx = src.vx;
  dst.vy = src.vy;
  dst.angle = src.angle;
  dst.thrust = src.thrust;
  return dst;
}

/**
 * Advances the ship by `dt` seconds. Semi-implicit Euler: velocity first, then position.
 * Mutates and returns `ship` (in-place mutation is the norm in game loops — no garbage per step).
 *
 * @param {{x:number,y:number,vx:number,vy:number,angle:number,thrust:boolean}} ship
 * @param {{thrust:boolean,left:boolean,right:boolean}} controls  plain data, not the input module
 * @param {number} dt seconds
 */
export function integrate(ship, controls, dt, params = SHIP_PARAMS) {
  // 1. Rotation
  const turn = (controls.right ? 1 : 0) - (controls.left ? 1 : 0);
  ship.angle = wrapAngle(ship.angle + turn * params.turnRate * dt);

  // 2. Thrust along the heading
  ship.thrust = Boolean(controls.thrust);
  if (ship.thrust) {
    ship.vx += Math.cos(ship.angle) * params.thrust * dt;
    ship.vy += Math.sin(ship.angle) * params.thrust * dt;
  }

  // 3. Drag: exact solution of dv/dt = -k*v over dt, so it behaves the same for any step size
  const damping = Math.exp(-params.drag * dt);
  ship.vx *= damping;
  ship.vy *= damping;

  // 4. Speed clamp
  const speed = Math.hypot(ship.vx, ship.vy);
  if (speed > params.maxSpeed) {
    const k = params.maxSpeed / speed;
    ship.vx *= k;
    ship.vy *= k;
  }

  // 5. Position
  ship.x += ship.vx * dt;
  ship.y += ship.vy * dt;
  return ship;
}
