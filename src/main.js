// Composition root: creates every module and wires them together. No game rules live here.
// Lab 3 flow:  loading screen (await loadAll) -> lobby (HTTP, polling) -> game.

import { createLoop } from "./loop.js";
import { createInput, readControls, BINDINGS } from "./input.js";
import { World } from "./sim/world.js";
import { createArena } from "./sim/arena.js";
import { setupCanvas, applyCamera } from "./render/canvas.js";
import { createStarfield, drawBackground, drawWorld, drawHud } from "./render/draw.js";
import { drawLoading } from "./render/loading.js";
import {
  readExperimentFlags,
  describeFlags,
  busyWait,
  skipsLobby,
  applyLoadFaults,
  loadOptionsFor,
  roomsUrlFor,
} from "./experiments.js";
import { fetchJson, withRetry, withTimeout, describeError } from "./net/http.js";
import { createFaultFetch } from "./net/faults.js";
import { planItems, loadAll } from "./assets/loader.js";
import { DEFAULT_ARENAS, validateArenas } from "./arenas.js";
import { createAudioContext, unlockOnGesture, createSound, connectAudio } from "./audio.js";
import { createHud } from "./hud.js";
import { Lobby } from "./lobby/lobby.js";
import { createLobbyView } from "./lobby/lobby-view.js";

const STEP = 1 / 60;
const flags = readExperimentFlags(window.location.search);
const PLAYER_COLORS = { 1: "#7cf3c8", 2: "#ffa36c" };
const fetchImpl = flags.staticHost ? createFaultFetch() : globalThis.fetch.bind(globalThis);

// ---- long-lived modules ----------------------------------------------------------------------
const bus = new EventTarget(); // survives restarts: listeners attach once
const audioCtx = createAudioContext(); // created now (suspended), decoded into while loading
unlockOnGesture(audioCtx); // the first click / key press anywhere resumes it
const hud = createHud(bus);
const input = createInput(window);
const lobbyArena = createArena();
const { ctx, view } = setupCanvas(document.getElementById("game"), lobbyArena);
const stars = createStarfield(lobbyArena);

const actionsEl = document.getElementById("loading-actions");
const lobbyEl = document.getElementById("lobby");

let screen = "loading"; // "loading" | "lobby" | "game"
let assets = { sprites: {}, sounds: {}, data: {}, failures: [] };
let arenas = DEFAULT_ARENAS;
let sound = null;
let lobbyView = null;
let world = null;
let room = null;
let pilotName = "Пілот";

let paused = false;
let showHelp = true;
let stepMs = 0;

// ---- loading screen ---------------------------------------------------------------------------
const loading = {
  items: [],
  progress: 0,
  phase: "loading",
  headline: "",
  started: 0,
  finished: 0,
  controller: null,
};

function showActions(...names) {
  actionsEl.hidden = names.length === 0;
  for (const button of actionsEl.querySelectorAll("button")) {
    button.hidden = !names.includes(button.dataset.action);
  }
  actionsEl.querySelector(`[data-action="${names.at(-1)}"]`)?.focus();
}

async function loadAssets({ useDefaultArenas = false, firstAttempt = false } = {}) {
  screen = "loading";
  const controller = new AbortController();
  Object.assign(loading, {
    items: [],
    progress: 0,
    phase: "loading",
    headline: "Завантажую маніфест…",
    started: performance.now(),
    finished: 0,
    controller,
  });
  showActions("cancel");
  if (flags.fail === "abort" && firstAttempt) setTimeout(() => controller.abort(), 900);

  try {
    const manifestUrl = new URL("assets/manifest.json", window.location.href);
    const manifest = await withRetry(
      () =>
        fetchJson(manifestUrl, { signal: withTimeout(controller.signal, 4000), fetch: fetchImpl }),
      { signal: controller.signal },
    );
    let items = planItems(applyLoadFaults(manifest, flags.fail), manifestUrl);
    if (useDefaultArenas) items = items.filter((item) => item.key !== "data.arenas");
    loading.items = items.map((item) => ({ key: item.key, status: "pending" }));
    loading.headline = flags.sequential
      ? "Послідовно: кожен файл чекає на попередній…"
      : "Паралельно: усі запити стартували одночасно…";

    const result = await loadAll(items, {
      signal: controller.signal,
      audioCtx,
      fetch: fetchImpl,
      sequential: flags.sequential,
      ...loadOptionsFor(flags.fail),
      onProgress: (fraction) => (loading.progress = fraction),
      onItem: (item, status, error) => {
        const row = loading.items.find((r) => r.key === item.key);
        if (row) Object.assign(row, { status, note: error ? describeError(error) : "" });
        if (status.startsWith("retry")) console.info(`[load] ${item.key}: ${status}`);
        if (error) console.warn(`[load] ${item.key}: ${status} (${describeError(error)})`);
      },
    });

    try {
      arenas = useDefaultArenas ? DEFAULT_ARENAS : validateArenas(result.data.arenas);
    } catch (error) {
      throw Object.assign(error, { item: { key: "data.arenas" } });
    }
    assets = result;
    loading.phase = "done";
    loading.finished = performance.now();
    const skipped = result.failures.map((f) => f.item.key);
    console.log(
      `[load] ${items.length} assets in ${result.ms.toFixed(0)} ms (${flags.sequential ? "sequential" : "concurrent"})`,
      skipped.length ? `skipped: ${skipped.join(", ")}` : "",
    );
    loading.headline =
      `Готово за ${result.ms.toFixed(0)} мс. ` +
      (skipped.length ? `Без ${skipped.join(", ")} — гра працюватиме і так. ` : "") +
      (useDefaultArenas ? "Арени: вбудовані за замовчуванням. " : "") +
      "Натисни «Почати» — цей клік ще й вмикає звук.";
    showActions("start");
    if (skipsLobby(flags)) afterLoading(); // Lab 1/2 experiments: no click needed
  } catch (error) {
    loading.finished = performance.now();
    if (error.name === "AbortError" && controller.signal.aborted) {
      loading.phase = "aborted";
      loading.headline = "Завантаження скасовано. Нічого не зламалося — можна спробувати ще раз.";
      console.log("[load] aborted by the player");
      showActions("retry");
    } else {
      loading.phase = "error";
      const what = error.item?.key ?? "manifest";
      loading.headline = `Не вдалося завантажити ${what}: ${describeError(error)} — ${error.message}`;
      console.error("[load] failed:", what, error);
      if (what === "data.arenas") showActions("defaults", "retry");
      else showActions("retry");
    }
  } finally {
    if (loading.controller === controller) loading.controller = null;
  }
}

actionsEl.addEventListener("click", (e) => {
  const action = e.target.closest("button")?.dataset.action;
  if (action === "cancel") loading.controller?.abort();
  if (action === "retry") loadAssets();
  if (action === "defaults") loadAssets({ useDefaultArenas: true });
  if (action === "start") afterLoading();
});

function afterLoading() {
  showActions();
  if (!sound) {
    sound = createSound(audioCtx, assets.sounds);
    connectAudio(bus, sound); // subscribe once; the world only ever dispatches events
  }
  audioCtx?.resume(); // we are inside a click handler: a user gesture
  if (skipsLobby(flags)) return startGame(null, "P1");
  showLobby();
}

// ---- lobby ------------------------------------------------------------------------------------
const lobby = new Lobby({
  url: new URL(roomsUrlFor(flags.lobby), window.location.href).href,
  fetch: fetchImpl,
});
lobby.addEventListener("join", (e) => startGame(e.detail.room, e.detail.name));
lobby.addEventListener("error", (e) => console.warn("[lobby]", describeError(e.detail.error)));

function showLobby() {
  screen = "lobby";
  world = null;
  lobbyView ??= createLobbyView(lobbyEl, lobby, { arenas });
  lobbyView.show();
}

// ---- game -------------------------------------------------------------------------------------
function createWorld() {
  const arena = (room && arenas[room.arena]) || arenas.classic || DEFAULT_ARENAS.classic;
  const players = flags.explicitPlayers || !room ? flags.players : room.mode === "solo" ? 1 : 2;
  const w = new World({ ...arena, seed: flags.seed, events: bus });
  w.addPlayer({ id: 1, name: pilotName, color: PLAYER_COLORS[1] });
  if (players === 2) w.addPlayer({ id: 2, name: "Гість", color: PLAYER_COLORS[2] });
  for (const [id, color] of Object.entries(PLAYER_COLORS)) hud.setPlayerColor(Number(id), color);
  hud.clear();
  return w;
}

function startGame(selectedRoom, name) {
  lobbyView?.hide(); // stops polling and aborts the in-flight room request
  room = selectedRoom;
  pilotName = name;
  world = createWorld();
  screen = "game";
  paused = false;
  probe.result = null;
  document.getElementById("game").focus();

  if (flags.thisBug) {
    // DELIBERATE BUG (Lab 2, Theory §2). `ship.fire` is passed by reference and later called as
    // a plain function by the input module: default binding, `this === undefined` in a module,
    // so `this.angle` throws "Cannot read properties of undefined (reading 'angle')".
    const ship = world.shipOf(1);
    input.onPress("KeyF", ship.fire);
    // The fixes, in the order we prefer them:
    //   input.onPress("KeyF", () => ship.fire(world));      // arrow wrapper — chosen
    //   input.onPress("KeyF", ship.fire.bind(ship, world)); // bind
  }
}

// ---- UI keys: event callbacks, NOT simulation input --------------------------------------------
input.onPress("KeyP", () => screen === "game" && (paused = !paused));
input.onPress("KeyR", () => {
  if (screen !== "game") return;
  world = createWorld();
  probe.result = null;
});
const typing = (e) => e.target?.tagName === "INPUT";
input.onPress("KeyH", (e) => !typing(e) && (showHelp = !showHelp));
input.onPress("KeyM", (e) => !typing(e) && sound?.toggleMute());
input.onPress("Escape", () => {
  if (screen === "loading") loading.controller?.abort();
  else if (screen === "game" && !skipsLobby(flags)) showLobby();
});

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
  if (screen !== "game" || paused) {
    input.endStep();
    return;
  }
  const inputs = new Map([
    [1, flags.autopilot ? AUTOPILOT : readControls(input, BINDINGS[1])],
    [2, readControls(input, BINDINGS[2])],
  ]);
  const t0 = performance.now();
  world.step(dt, inputs);
  stepMs = performance.now() - t0;
  input.endStep();

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

  if (screen === "loading") {
    const end = loading.finished || performance.now();
    const bottom = drawLoading(ctx, view, { ...loading, elapsed: end - loading.started }, time);
    const top = `${Math.round(bottom)}px`;
    if (actionsEl.style.top !== top) actionsEl.style.top = top; // buttons sit right under the text
    return;
  }
  if (screen === "lobby") {
    drawBackground(ctx, view, lobbyArena, stars);
    return;
  }

  drawBackground(ctx, view, world.arena, stars);
  ctx.save();
  applyCamera(ctx, view);
  ctx.beginPath();
  ctx.rect(0, 0, world.arena.width, world.arena.height);
  ctx.clip();
  drawWorld(ctx, world, paused ? 1 : alpha, time, STEP, assets.sprites);
  hud.drawFloaters(ctx);
  ctx.restore();

  let bullets = 0;
  for (const _ of world.ofKind("bullet")) bullets++;

  const lines = [
    `steps/s  ${stats.stepsPerSec.toFixed(1).padStart(5)}    frames/s ${stats.framesPerSec.toFixed(1).padStart(5)}`,
    `frame    ${stats.frameTime.toFixed(1).padStart(5)} ms  σ ${stats.jitter.toFixed(2)}  max ${stats.maxFrameTime.toFixed(1)}  work ${stats.frameWork.toFixed(2)} ms`,
    `world    ${String(world.size).padStart(3)} entities (${bullets} bullets)  step ${stepMs.toFixed(3)} ms`,
  ];
  if (room) {
    lines.push({
      text: `room     ${room.name} · ${arenas[room.arena]?.name ?? room.arena} · звук: ${sound?.muted ? "вимк" : (sound?.state ?? "—")}`,
      color: "#9fb0d8",
    });
  }
  for (const player of world.players.values()) {
    const ship = world.shipOf(player.id);
    const status = ship
      ? `hp ${String(ship.hp).padStart(3)}  ${effectsText(ship)}`
      : `respawn ${Math.max(0, player.respawnIn).toFixed(1)}s`;
    lines.push({
      text: `${player.name.padEnd(8)} score ${String(player.score).padStart(5)}   ${status}`,
      color: player.color,
    });
  }
  if (showHelp) {
    lines.push(
      { text: describeFlags(flags), color: "#9fb0d8" },
      { text: "P1: W тяга, A/D поворот, Space вогонь", color: "#9fb0d8" },
      { text: "P2: ↑ тяга, ←/→ поворот, Enter вогонь", color: "#9fb0d8" },
      { text: "P пауза · R рестарт · M звук · Esc лобі · H сховати", color: "#9fb0d8" },
    );
  }
  if (paused) lines.push({ text: "ПАУЗА", color: "#ffd479" });
  if (probe.result) {
    lines.push({
      text: `5 s probe: x ${probe.result.x.toFixed(3)}  y ${probe.result.y.toFixed(3)}`,
      color: "#ffd479",
    });
  }
  lines.push(...hud.feedLines());
  drawHud(ctx, lines);
}

const loop = createLoop({
  step: STEP,
  simulate,
  render,
  scheduler: flags.scheduler,
  timestep: flags.timestep,
});
loop.start(); // the loop runs from the first frame: loading never blocks it
loadAssets({ firstAttempt: true });

// Handle for experiments and debugging from the DevTools console.
window.__dogfight = {
  stats: loop.stats,
  get world() {
    return world;
  },
  get ship() {
    return world?.shipOf(1) ?? null;
  },
  get screen() {
    return screen;
  },
  get loading() {
    return loading;
  },
  get assets() {
    return assets;
  },
  lobby,
  bus,
  probe,
  flags,
  loop,
};
