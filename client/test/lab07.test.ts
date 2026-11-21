// Lab 7: the real game loop under FAKE timers. Vitest replaces setTimeout/setInterval and
// performance.now with a virtual clock; Node has no requestAnimationFrame, so the test installs
// one on top of the fake setTimeout (a "display" refreshing every 16 ms). Advancing the virtual
// clock by 1000 ms runs exactly the frames that would have happened — instantly, deterministically.

import { test, expect, beforeEach, afterEach, vi } from "vitest";
import { createLoop } from "../src/loop.ts";

let displayPaused = false;

beforeEach(() => {
  vi.useFakeTimers({
    toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "performance"],
  });
  displayPaused = false;
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) =>
    setTimeout(function frame() {
      if (displayPaused)
        setTimeout(frame, 16); // a frozen tab: no frames, time still passes
      else cb(performance.now());
    }, 16),
  );
  vi.stubGlobal("cancelAnimationFrame", (id: ReturnType<typeof setTimeout>) => clearTimeout(id));
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

test("rAF loop: 60 fixed steps per simulated second, one render per frame", () => {
  let steps = 0;
  let renders = 0;
  const loop = createLoop({ step: 1 / 60, simulate: () => steps++, render: () => renders++ });
  loop.start();
  vi.advanceTimersByTime(1000);
  loop.stop();
  // the fake display refreshes every 16 ms (62.5 Hz); the accumulator still produces 60 steps
  expect(Math.abs(steps - 60)).toBeLessThanOrEqual(1);
  expect(renders).toBe(62);
  expect(loop.stats.totalSteps).toBe(steps);
  vi.advanceTimersByTime(1000);
  expect(loop.stats.totalSteps).toBe(steps); // stopped: nothing more ran
});

test("interval scheduler (Experiment 2) + variable timestep (Experiment 3): one simulate per tick", () => {
  const dts: number[] = [];
  const loop = createLoop({
    simulate: (dt) => dts.push(dt),
    render: () => {},
    scheduler: "interval",
    timestep: "variable",
  });
  loop.start();
  vi.advanceTimersByTime(160);
  loop.stop();
  expect(dts).toHaveLength(10);
  expect(dts.every((dt) => Math.abs(dt - 0.016) < 1e-9)).toBe(true);
});

test("a 2-second freeze is clamped to maxFrame: 15 catch-up steps, not 120", () => {
  let steps = 0;
  const loop = createLoop({
    step: 1 / 60,
    simulate: () => steps++,
    render: () => {},
    maxFrame: 0.25,
  });
  loop.start();
  vi.advanceTimersByTime(160); // normal play
  displayPaused = true;
  vi.advanceTimersByTime(2000); // the tab is frozen for 2 s
  displayPaused = false;
  const before = steps;
  vi.advanceTimersByTime(16); // the first frame after the freeze
  loop.stop();
  expect(steps - before).toBe(15); // 0.25 s / (1/60 s)
});
