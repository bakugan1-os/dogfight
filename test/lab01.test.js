// Lab 1: the simulation is DOM-free, deterministic, and independent of the display's frame rate.
// Run with: npm test

import { test } from "node:test";
import assert from "node:assert/strict";

import { createAccumulator } from "../src/loop.js";
import { integrate } from "../src/sim/ship.js";
import { Vector2 } from "../src/sim/vector.js";
import { createArena, wrapPosition, wrappedDelta } from "../src/sim/arena.js";
import { lerpAngle, wrapAngle } from "../src/sim/math.js";

const STEP = 1 / 60;

/** Lab 1's ship state as plain data (Lab 2 moved it onto Vector2 fields). */
const createShip = () => ({
  pos: new Vector2(800, 450),
  vel: new Vector2(),
  angle: -Math.PI / 2,
  thrust: false,
});
const THRUST = { thrust: true, left: false, right: false };
const THRUST_LEFT = { thrust: true, left: true, right: false };

/** Runs the real accumulator against a list of frame deltas (seconds). */
function runWithFrames(frameDeltas, controlsForStep) {
  const arena = createArena();
  const ship = createShip();
  const acc = createAccumulator({ step: STEP });
  let step = 0;
  for (const delta of frameDeltas) {
    acc.advance(delta, (dt) => {
      integrate(ship, controlsForStep(step++), dt);
      wrapPosition(arena, ship.pos);
    });
  }
  return { ship, steps: step };
}

/** Frame deltas for `seconds` of play at a given refresh rate (+ optional jitter). */
function frames(hz, seconds, jitter = 0) {
  const out = [];
  let seed = 7;
  const rand = () => (seed = (seed * 1103515245 + 12345) >>> 0) / 4294967296;
  for (let t = 0; t < seconds; t += 1 / hz) out.push(1 / hz + (rand() - 0.5) * jitter);
  return out;
}

test("same inputs -> bit-identical state", () => {
  const a = createShip();
  const b = createShip();
  for (let i = 0; i < 600; i++) {
    integrate(a, i % 120 < 60 ? THRUST : THRUST_LEFT, STEP);
    integrate(b, i % 120 < 60 ? THRUST : THRUST_LEFT, STEP);
  }
  assert.deepEqual(a, b);
});

test("fixed step: 60 Hz, 144 Hz and a jittery 30 Hz display produce the SAME trajectory", () => {
  const controls = (i) => (i % 90 < 45 ? THRUST : THRUST_LEFT);
  // Run each display long enough, then compare the state after exactly 300 steps.
  const at300 = (deltas) => {
    const arena = createArena();
    const ship = createShip();
    const acc = createAccumulator({ step: STEP });
    let step = 0;
    let snapshot = null;
    for (const d of deltas) {
      acc.advance(d, (dt) => {
        if (step >= 300) return;
        integrate(ship, controls(step++), dt);
        wrapPosition(arena, ship.pos);
        if (step === 300) snapshot = structuredClone(ship);
      });
    }
    return snapshot;
  };
  const s60 = at300(frames(60, 6));
  const s144 = at300(frames(144, 6));
  const s30 = at300(frames(30, 6, 0.01));
  assert.ok(s60 && s144 && s30, "every run reached 300 steps");
  assert.deepEqual(s144, s60);
  assert.deepEqual(s30, s60);
});

test("simulate() runs ~60 times per second whatever the refresh rate", () => {
  for (const hz of [30, 60, 75, 120, 144, 240]) {
    const { steps } = runWithFrames(frames(hz, 10), () => THRUST);
    assert.ok(Math.abs(steps - 600) <= 2, `${hz} Hz -> ${steps} steps in 10 s`);
  }
});

test("the frame delta is clamped: a 3 s hitch does not cause 180 catch-up steps", () => {
  const acc = createAccumulator({ step: STEP, maxFrame: 0.25 });
  let n = 0;
  const { steps } = acc.advance(3, () => n++);
  assert.equal(steps, 15); // 0.25 s / (1/60)
  assert.equal(n, 15);
});

test("alpha is always in [0, 1)", () => {
  const acc = createAccumulator({ step: STEP });
  for (const d of frames(144, 2, 0.004)) {
    const { alpha } = acc.advance(d, () => {});
    assert.ok(alpha >= 0 && alpha < 1, `alpha=${alpha}`);
  }
});

test("variable timestep (the anti-pattern) diverges between frame rates", () => {
  const run = (hz) => {
    const ship = createShip();
    let t = 0;
    while (t < 5 - 1e-9) {
      const dt = 1 / hz;
      integrate(ship, THRUST, dt);
      t += dt;
    }
    return ship.pos.y;
  };
  assert.notEqual(run(60), run(10)); // same 5 s of input, different result
});

test("lerpAngle takes the shortest arc across the ±PI seam", () => {
  const a = Math.PI - 0.1;
  const b = -Math.PI + 0.1; // only 0.2 rad away, through the seam
  const mid = lerpAngle(a, b, 0.5);
  assert.ok(Math.abs(Math.abs(mid) - Math.PI) < 1e-9, `mid=${mid}`);
  // the naive lerp would give 0 — pointing the opposite way
  assert.ok(Math.abs(wrapAngle(a + (b - a) * 0.5)) < 1e-9);
});

test("arena wraps positions and wrappedDelta picks the short way", () => {
  const arena = createArena(100, 50);
  const body = { x: 105, y: -3 };
  wrapPosition(arena, body);
  assert.deepEqual(body, { x: 5, y: 47 });
  assert.equal(wrappedDelta(98, 2, 100), 4);
  assert.equal(wrappedDelta(2, 98, 100), -4);
});

test("integrate respects max speed", () => {
  const ship = createShip();
  for (let i = 0; i < 1000; i++) integrate(ship, THRUST, STEP);
  assert.ok(ship.vel.length() <= 460 + 1e-9);
});
