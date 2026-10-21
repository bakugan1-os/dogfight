// Composition root: creates every module and wires them together. No game logic lives here.

import { createLoop } from "./loop.js";
import { createInput, readControls } from "./input.js";
import { createArena, wrapPosition, wrapCoord, wrappedDelta } from "./sim/arena.js";
import { createShip, copyShip, integrate, SHIP_PARAMS } from "./sim/ship.js";
import { lerpAngle } from "./sim/math.js";
import { setupCanvas, applyCamera } from "./render/canvas.js";
import { createStarfield, drawBackground, drawShip, drawWrapped, drawHud } from "./render/draw.js";
import { readExperimentFlags, describeFlags, busyWait } from "./experiments.js";

const STEP = 1 / 60;
const flags = readExperimentFlags(window.location.search);

const arena = createArena();
const current = createShip(arena.width / 2, arena.height / 2);
const previous = copyShip({}, current); // state one step ago — the renderer blends the two
const input = createInput(window);
const { ctx, view } = setupCanvas(document.getElementById("game"), arena);
const stars = createStarfield(arena);

// Experiment 3 probe: where is the ship after exactly 5 s of holding thrust?
const AUTOPILOT = Object.freeze({ thrust: true, left: false, right: false, fire: false });
const probe = { simTime: 0, steps: 0, result: null };

function simulate(dt) {
  copyShip(previous, current);
  const controls = flags.autopilot ? AUTOPILOT : readControls(input);
  integrate(current, controls, dt);
  wrapPosition(arena, current);
  input.endStep();

  probe.steps++;
  probe.simTime += dt;
  if (flags.autopilot && !probe.result && probe.simTime >= 5 - 1e-9) {
    probe.result = {
      x: current.x,
      y: current.y,
      vy: current.vy,
      simTime: probe.simTime,
      steps: probe.steps,
    };
    console.log("[probe] after 5 s of thrust:", JSON.stringify(probe.result));
  }
}

let frameNo = 0;

function render(alpha, stats) {
  frameNo++;
  if (flags.blockMs && frameNo % 60 === 0) busyWait(flags.blockMs);

  // Interpolate between the last two simulation states. Position uses the wrapped delta so a
  // ship crossing an edge doesn't sweep across the whole arena for one frame; the heading uses
  // the shortest arc.
  const x = wrapCoord(
    previous.x + wrappedDelta(previous.x, current.x, arena.width) * alpha,
    arena.width,
  );
  const y = wrapCoord(
    previous.y + wrappedDelta(previous.y, current.y, arena.height) * alpha,
    arena.height,
  );
  const angle = lerpAngle(previous.angle, current.angle, alpha);
  const time = performance.now() / 1000;

  drawBackground(ctx, view, arena, stars);

  ctx.save();
  applyCamera(ctx, view);
  ctx.beginPath();
  ctx.rect(0, 0, arena.width, arena.height);
  ctx.clip();
  drawWrapped(arena, x, y, SHIP_PARAMS.radius * 2.5, (dx, dy) =>
    drawShip(ctx, dx, dy, angle, current.thrust, time),
  );
  ctx.restore();

  const speed = Math.hypot(current.vx, current.vy);
  const lines = [
    `steps/s  ${stats.stepsPerSec.toFixed(1).padStart(5)}    frames/s ${stats.framesPerSec.toFixed(1).padStart(5)}`,
    `frame    ${stats.frameTime.toFixed(1).padStart(5)} ms  σ ${stats.jitter.toFixed(2)}  max ${stats.maxFrameTime.toFixed(1)}  work ${stats.frameWork.toFixed(2)} ms`,
    `ship     x ${current.x.toFixed(0).padStart(4)}  y ${current.y.toFixed(0).padStart(4)}  speed ${speed.toFixed(0).padStart(3)}`,
    { text: describeFlags(flags), color: "#9fb0d8" },
    { text: "W/↑ тяга   A/← D/→ поворот", color: "#9fb0d8" },
  ];
  if (probe.result) {
    lines.push({
      text: `5 s probe: x ${probe.result.x.toFixed(3)}  y ${probe.result.y.toFixed(3)}`,
      color: "#ffd479",
    });
  }
  drawHud(ctx, lines);
}

const loop = createLoop({
  step: STEP,
  simulate,
  render,
  scheduler: flags.scheduler,
  timestep: flags.timestep,
});
loop.start();

// Handle for experiments and debugging from the DevTools console.
window.__dogfight = { stats: loop.stats, ship: current, probe, flags, loop };
