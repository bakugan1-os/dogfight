// Measures the per-step cost of `pos = pos.add(vel.scale(dt))` (pure, 2 allocations per entity)
// against `pos.addScaledInPlace(vel, dt)` (no allocation). Run: node scripts/bench-vector.ts
// Numbers vary by machine; the README records one run.

import { Vector2 } from "@dogfight/shared/sim/vector.ts";

const ENTITIES = 5000;
const STEPS = 600; // 10 s of simulation at 60 Hz
const DT = 1 / 60;

type Body = { pos: Vector2; vel: Vector2 };

function makeBodies(): Body[] {
  return Array.from({ length: ENTITIES }, (_, i) => ({
    pos: new Vector2(i, i * 0.5),
    vel: new Vector2(Math.cos(i) * 100, Math.sin(i) * 100),
  }));
}

function pure(bodies: Body[]): void {
  for (let s = 0; s < STEPS; s++) for (const b of bodies) b.pos = b.pos.add(b.vel.scale(DT));
}

function inPlace(bodies: Body[]): void {
  for (let s = 0; s < STEPS; s++) for (const b of bodies) b.pos.addScaledInPlace(b.vel, DT);
}

function measure(name: string, fn: (bodies: Body[]) => void): number {
  const runs: number[] = [];
  for (let r = 0; r < 7; r++) {
    const bodies = makeBodies();
    const t0 = performance.now();
    fn(bodies);
    runs.push(performance.now() - t0);
  }
  runs.sort((a, b) => a - b);
  const median = runs[3] ?? NaN;
  const perStep = (median / STEPS) * 1000;
  console.log(
    `${name.padEnd(9)} median ${median.toFixed(1).padStart(6)} ms per ${STEPS} steps  ` +
      `= ${perStep.toFixed(1).padStart(5)} µs per step for ${ENTITIES} entities`,
  );
  return median;
}

measure("warm-up", pure);
measure("warm-up", inPlace);
const a = measure("pure", pure);
const b = measure("in-place", inPlace);
console.log(
  `in-place is ${(a / b).toFixed(1)}x faster; pure allocates ${2 * ENTITIES} vectors per step`,
);
