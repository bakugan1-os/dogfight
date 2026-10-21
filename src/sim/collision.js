// Collision DETECTION as a standalone system: takes the world, returns pairs, decides nothing.
// What a collision MEANS lives in rules.js. Because detection is just a function with this
// signature, the naive O(n^2) pass can later be swapped for a spatial hash (Lab 7) without
// touching the rules or the world.

import { wrappedDelta } from "./arena.js";

/**
 * Naive all-pairs circle–circle test on a torus.
 * @param {Iterable<import("./entity.js").Entity>} entities
 * @param {{width:number,height:number}} arena
 * @returns {Array<[object, object]>}
 */
export function findCollisionsNaive(entities, arena) {
  const bodies = [];
  for (const e of entities) if (e.alive && e.collides) bodies.push(e);

  const pairs = [];
  for (let i = 0; i < bodies.length; i++) {
    const a = bodies[i];
    for (let j = i + 1; j < bodies.length; j++) {
      const b = bodies[j];
      const dx = wrappedDelta(a.pos.x, b.pos.x, arena.width);
      const dy = wrappedDelta(a.pos.y, b.pos.y, arena.height);
      const r = a.radius + b.radius;
      if (dx * dx + dy * dy < r * r) pairs.push([a, b]);
    }
  }
  return pairs;
}
