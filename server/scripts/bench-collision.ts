// Lab 7: naive all-pairs vs the spatial hash, per call, for N random bodies in the 1600×900 arena
// (radii like the game: mostly bullets and ships, some asteroids).
//
//   node server/scripts/bench-collision.ts

import { findCollisionsNaive } from "@dogfight/shared/sim/collision.ts";
import { createSpatialHash } from "@dogfight/shared/sim/spatialhash.ts";
import { createArena } from "@dogfight/shared/sim/arena.ts";
import { createRng } from "@dogfight/shared/sim/rng.ts";

const arena = createArena();
const hashed = createSpatialHash();
const rng = createRng(1);
console.log("| bodies | naive µs | hash µs | speed-up |\n|---|---|---|---|");
for (const n of [50, 100, 200, 400, 800, 1600]) {
  const bodies = Array.from({ length: n }, () => ({
    alive: true,
    collides: true,
    pos: { x: rng.range(0, arena.width), y: rng.range(0, arena.height) },
    radius: rng.pick([3, 3, 3, 14, 20, 40]),
  }));
  const time = (fn: () => unknown) => {
    for (let i = 0; i < 200; i++) fn(); // warm-up (JIT)
    const reps = Math.max(20, Math.floor(200_000 / n));
    const t0 = performance.now();
    for (let i = 0; i < reps; i++) fn();
    return ((performance.now() - t0) * 1000) / reps;
  };
  const a = time(() => findCollisionsNaive(bodies, arena));
  const b = time(() => hashed(bodies, arena));
  console.log(`| ${n} | ${a.toFixed(1)} | ${b.toFixed(1)} | ${(a / b).toFixed(1)}× |`);
}
