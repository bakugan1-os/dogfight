// The arena: fixed logical size in world units, independent of the browser window.
// A fixed size keeps the simulation deterministic: resizing the window changes only the camera.

export const ARENA_WIDTH = 1600;
export const ARENA_HEIGHT = 900;

export function createArena(width = ARENA_WIDTH, height = ARENA_HEIGHT) {
  return { width, height };
}

/** Wraps a single coordinate into [0, size). */
export function wrapCoord(value, size) {
  return ((value % size) + size) % size;
}

/** Teleports a body that left the arena to the opposite edge (torus topology). Mutates `body`. */
export function wrapPosition(arena, body) {
  body.x = wrapCoord(body.x, arena.width);
  body.y = wrapCoord(body.y, arena.height);
  return body;
}

/**
 * Shortest signed distance from a to b on a wrapped axis.
 * Used by the renderer so that interpolation across an edge does not sweep through the whole arena.
 */
export function wrappedDelta(a, b, size) {
  let d = b - a;
  if (d > size / 2) d -= size;
  else if (d < -size / 2) d += size;
  return d;
}
