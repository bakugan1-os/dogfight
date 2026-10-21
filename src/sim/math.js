// Small pure math helpers shared by the simulation and the renderer.
// No DOM, no canvas: this file must run unchanged in Node (tests) and later on the server.

export const TAU = Math.PI * 2;

/** Linear interpolation between a and b; t in [0, 1]. */
export function lerp(a, b, t) {
  return a + (b - a) * t;
}

/** Wraps an angle into [-PI, PI). */
export function wrapAngle(angle) {
  return angle - TAU * Math.floor((angle + Math.PI) / TAU);
}

/**
 * Interpolates between two headings along the SHORTEST arc.
 * Naive lerp from 3.1 rad to -3.1 rad would spin the ship almost a full turn the wrong way —
 * the classic interpolation bug. Here the difference is wrapped into [-PI, PI) first.
 */
export function lerpAngle(a, b, t) {
  return wrapAngle(a + wrapAngle(b - a) * t);
}

/** Clamps v into [min, max]. */
export function clamp(v, min, max) {
  return v < min ? min : v > max ? max : v;
}
