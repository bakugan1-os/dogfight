// Small pure math helpers shared by the simulation and the renderer.
// No DOM, no canvas: this file must run unchanged in Node (tests) and on the server.

export const TAU = Math.PI * 2;

/** Linear interpolation between a and b; t in [0, 1]. */
export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Wraps an angle into [-PI, PI). */
export function wrapAngle(angle: number): number {
  return angle - TAU * Math.floor((angle + Math.PI) / TAU);
}

/**
 * Interpolates between two headings along the SHORTEST arc.
 * Naive lerp from 3.1 rad to -3.1 rad would spin the ship almost a full turn the wrong way —
 * the classic interpolation bug. Here the difference is wrapped into [-PI, PI) first.
 */
export function lerpAngle(a: number, b: number, t: number): number {
  return wrapAngle(a + wrapAngle(b - a) * t);
}

/** Clamps v into [min, max]. */
export function clamp(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v;
}

/** Exhaustiveness check: the call only compiles if every case was handled before it. */
export function assertNever(value: never, what = "value"): never {
  throw new Error(`unexpected ${what}: ${JSON.stringify(value)}`);
}
