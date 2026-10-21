// Composition root: creates every module and wires them together. No game rules live here.

import { createLoop } from "./loop.js";
import { createInput, readControls, BINDINGS } from "./input.js";
import { World } from "./sim/world.js";
import { setupCanvas, applyCamera } from "./render/canvas.js";
import { createStarfield, drawBackground, drawWorld, drawHud } from "./render/draw.js";
import { readExperimentFlags, describeFlags, busyWait } from "./experiments.js";

const STEP = 1 / 60;
const flags = readExperimentFlags(window.location.search);
const PLAYER_COLORS = { 1: "#7cf3c8", 2: "#ffa36c" };

function createWorld() {
  const world = new World({ seed: flags.seed });
  world.addPlayer({ id: 1, color: PLAYER_COLORS[1] });
  if (flags.players === 2) world.addPlayer({ id: 2, color: PLAYER_COLORS[2] });
  return world;
}

let world = createWorld();
const input = createInput(window);
const { ctx, view } = setupCanvas(document.getElementById("game"), world.arena);
const stars = createStarfield(world.arena);

let paused = false;
let showHelp = true;
const feed = []; // recent world messages for the HUD: { text, until }
let stepMs = 0; // how long the last world.step took — the number Lab 7 will profile

// ---- UI actions: event callbacks, NOT simulation input. Arrow functions, so `this` is moot.
input.onPress("KeyP", () => (paused = !paused));
input.onPress("KeyR", () => {
  world = createWorld();
  probe.result = null;
});
input.onPress("KeyH", () => (showHelp = !showHelp));

if (flags.thisBug) {
  // DELIBERATE BUG (Lab 2, Theory §2). `ship.fire` is passed by reference and later called as a
  // plain function by the input module: default binding, `this === undefined` in a module,
  // so `this.angle` throws "Cannot read properties of undefined (reading 'angle')".
  const ship = world.shipOf(1);
  input.onPress("KeyF", ship.fire);
  // The fixes, in the order we prefer them:
  //   input.onPress("KeyF", () => ship.fire(world));      // arrow wrapper — chosen
  //   input.onPress("KeyF", ship.fire.bind(ship, world)); // bind
  //   fire = (world) => { ... }  as a class field         // arrow per instance
}

// Lab 1 experiment 3 probe: where is P1 after exactly 5 s of holding thrust?
const AUTOPILOT = Object.freeze({
  thrust: true,
  left: false,
  right: false,
  fire: false,
  firePressed: false,
});
const probe = { result: null };

function simulate(dt) {
  if (paused) return;
  const inputs = new Map([
    [1, flags.autopilot ? AUTOPILOT : readControls(input, BINDINGS[1])],
    [2, readControls(input, BINDINGS[2])],
  ]);
  const t0 = performance.now();
  world.step(dt, inputs);
  stepMs = performance.now() - t0;
  input.endStep();

  const now = performance.now();
  for (const text of world.messages) feed.push({ text, until: now + 3000 });

  if (flags.autopilot && !probe.result && world.time >= 5 - 1e-9) {
    const ship = world.shipOf(1);
    probe.result = ship && { x: ship.pos.x, y: ship.pos.y, simTime: world.time, steps: world.tick };
    console.log("[probe] after 5 s of thrust:", JSON.stringify(probe.result));
  }
}

let frameNo = 0;

function effectsText(ship) {
  return [...ship.effects].map(([name, left]) => `${name} ${left.toFixed(1)}s`).join(" ");
}

function render(alpha, stats) {
  frameNo++;
  if (flags.blockMs && frameNo % 60 === 0) busyWait(flags.blockMs);
  const time = performance.now() / 1000;

  drawBackground(ctx, view, world.arena, stars);
  ctx.save();
  applyCamera(ctx, view);
  ctx.beginPath();
  ctx.rect(0, 0, world.arena.width, world.arena.height);
  ctx.clip();
  drawWorld(ctx, world, paused ? 1 : alpha, time, STEP);
  ctx.restore();

  let bullets = 0;
  for (const _ of world.ofKind("bullet")) bullets++;

  const lines = [
    `steps/s  ${stats.stepsPerSec.toFixed(1).padStart(5)}    frames/s ${stats.framesPerSec.toFixed(1).padStart(5)}`,
    `frame    ${stats.frameTime.toFixed(1).padStart(5)} ms  σ ${stats.jitter.toFixed(2)}  max ${stats.maxFrameTime.toFixed(1)}  work ${stats.frameWork.toFixed(2)} ms`,
    `world    ${String(world.size).padStart(3)} entities (${bullets} bullets)  step ${stepMs.toFixed(3)} ms`,
  ];
  for (const player of world.players.values()) {
    const ship = world.shipOf(player.id);
    const status = ship
      ? `hp ${String(ship.hp).padStart(3)}  ${effectsText(ship)}`
      : `respawn ${Math.max(0, player.respawnIn).toFixed(1)}s`;
    lines.push({
      text: `P${player.id}  score ${String(player.score).padStart(5)}   ${status}`,
      color: player.color,
    });
  }
  if (showHelp) {
    lines.push(
      { text: describeFlags(flags), color: "#9fb0d8" },
      { text: "P1: W тяга, A/D поворот, Space вогонь", color: "#9fb0d8" },
      { text: "P2: ↑ тяга, ←/→ поворот, Enter вогонь", color: "#9fb0d8" },
      { text: "P пауза · R рестарт · H сховати довідку", color: "#9fb0d8" },
    );
  }
  if (paused) lines.push({ text: "ПАУЗА", color: "#ffd479" });
  if (probe.result) {
    lines.push({
      text: `5 s probe: x ${probe.result.x.toFixed(3)}  y ${probe.result.y.toFixed(3)}`,
      color: "#ffd479",
    });
  }
  const now = performance.now();
  while (feed.length && feed[0].until < now) feed.shift();
  for (const item of feed.slice(-4)) lines.push({ text: `» ${item.text}`, color: "#ffd479" });
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
window.__dogfight = {
  stats: loop.stats,
  get world() {
    return world;
  },
  get ship() {
    return world.shipOf(1) ?? null;
  },
  probe,
  flags,
  loop,
};
