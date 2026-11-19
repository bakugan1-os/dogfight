// Collision DETECTION as a standalone system: takes the world, returns pairs, decides nothing.
// What a collision MEANS lives in rules.ts. Because detection is just a function with this
// signature, the naive O(n^2) pass can later be swapped for a spatial hash (Lab 7) without
// touching the rules or the world.

import { wrappedDelta, type Arena } from "./arena.ts";
import type { Vec2 } from "./vector.ts";

/** What detection needs to know about a thing. Structural: any entity has these fields. */
export type Body = {
  readonly alive: boolean;
  readonly collides: boolean;
  readonly pos: Vec2;
  readonly radius: number;
};

/**
 * Naive all-pairs circle–circle test on a torus.
 * Generic: whatever type of body goes in comes back out in the pairs (entities in the game,
 * plain objects in tests) — the relationship between input and output is the point.
 */
export function findCollisionsNaive<B extends Body>(
  entities: Iterable<B>,
  arena: Arena,
): Array<[B, B]> {
  const bodies: B[] = [];
  for (const e of entities) if (e.alive && e.collides) bodies.push(e);

  const pairs: Array<[B, B]> = [];
  for (let i = 0; i < bodies.length; i++) {
    const a = bodies[i];
    if (a === undefined) continue; // noUncheckedIndexedAccess: never true for i < length
    for (let j = i + 1; j < bodies.length; j++) {
      const b = bodies[j];
      if (b === undefined) continue;
      const dx = wrappedDelta(a.pos.x, b.pos.x, arena.width);
      const dy = wrappedDelta(a.pos.y, b.pos.y, arena.height);
      const r = a.radius + b.radius;
      if (dx * dx + dy * dy < r * r) pairs.push([a, b]);
    }
  }
  return pairs;
}
