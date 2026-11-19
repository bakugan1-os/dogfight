// Composition root: creates every module and wires them together. No game rules live here.
// Flow:  loading screen (await loadAll) -> lobby (HTTP, polling) -> room (WebSocket: roster +
// chat, Lab 4) -> game: since Lab 5 the SERVER runs it; this page sends inputs and draws
// snapshots (net/netgame.js). The local game remains for the Lab 1–3 experiment flags.

import { createLoop } from "./loop.js";
import { createInput, readControls, BINDINGS } from "./input.js";
import { World } from "@dogfight/shared/sim/world.js";
import { createArena } from "@dogfight/shared/sim/arena.js";
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
import { createRoomView } from "./lobby/room-view.js";
import { Connection, socketUrl } from "./net/connection.js";
import { NetGame } from "./net/netgame.js";
import { TICK_DT } from "@dogfight/shared/protocol/messages.js";
import { PLAYER_COLORS as SLOT_COLORS } from "@dogfight/shared/sim/arenas.js";
import { PROTOCOL_VERSION } from "./net/protocol.js";

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
const roomEl = document.getElementById("room");

let screen = "loading"; // "loading" | "lobby" | "room" | "game"
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
lobby.addEventListener("join", (e) => enterRoom(e.detail.room, e.detail.name));
lobby.addEventListener("error", (e) => console.warn("[lobby]", describeError(e.detail.error)));

function showLobby(notice) {
  screen = "lobby";
  world = null;
  roomView?.hide();
  lobbyView ??= createLobbyView(lobbyEl, lobby, { arenas });
  lobbyView.show();
  if (notice) lobbyView.notice(notice);
}

// ---- room: one WebSocket per visit (Lab 4) -----------------------------------------------------
let connection = null;
let roomView = null;
let net = null; // Lab 5: the networked game for the current room visit
let netAcc = 0; // accumulator: the page loop steps at 1/60 s, the network game at 1/30 s
let netFirePressed = false;
let showNetgraph = true;
let lagPreset = 0;
const LAG_PRESETS = [
  { lag: 0, jitter: 0, drop: 0 },
  { lag: 100, jitter: 30, drop: 0.02 },
  { lag: 200, jitter: 50, drop: 0.05 },
];

/** ws URL with the Lab 5 experiment parameters passed through (?codec=json&lag=100…). */
function gameSocketUrl() {
  const params = new URLSearchParams();
  if (flags.codec === "json") params.set("codec", "json");
  for (const key of ["lag", "jitter", "drop"])
    if (flags.netsim[key]) params.set(key, flags.netsim[key]);
  const query = params.toString();
  return socketUrl() + (query ? `?${query}` : "");
}

const REFUSED = {
  4004: "Сервер не пустив у кімнату: її немає або вона повна.",
  4003: "Сервер закрив з'єднання: не встигли приєднатися за 5 с.",
  4008: "Сервер закрив з'єднання: забагато повідомлень за секунду.",
};

function enterRoom(selectedRoom, name) {
  lobbyView?.hide(); // stops polling and aborts the in-flight room request
  room = selectedRoom;
  pilotName = name;
  roomView ??= createRoomView(roomEl, {
    onPlay: () => startNetGame(),
    onLeave: leaveRoom,
  });
  connection?.close();
  net?.dispose();
  net = null;
  connection = new Connection(gameSocketUrl());
  let roster = [];
  // Every (re)join gets a welcome with our slot: a fresh NetGame for that slot.
  connection.on("welcome", (msg) => {
    net?.dispose();
    net = new NetGame({
      conn: connection,
      arena: lobbyArena,
      slot: msg.slot,
      codec: msg.codec,
      interpDelayMs: flags.interpDelay,
      bus,
      flags: { predict: flags.predict, breakDeterminism: flags.breakDeterminism },
    });
    net.setNames(roster);
    console.info(
      `[net] slot ${msg.slot}, codec ${msg.codec}, netsim ${JSON.stringify(msg.netsim)}`,
    );
  });
  connection.on("roster", (msg) => {
    roster = msg.players;
    net?.setNames(roster);
  });
  // "open" fires on the first connect AND after every reconnect: (re)join each time.
  connection.on("open", () =>
    connection.send({ type: "join", v: PROTOCOL_VERSION, room: room.id, name: pilotName }),
  );
  connection.on("status", ({ state, code }) => {
    console.info(`[ws] ${state}${code ? ` (${code})` : ""}`);
    if (state === "closed" && REFUSED[code]) showLobby(REFUSED[code]);
  });
  roomView.bind(connection, room, arenas[room.arena]?.name);
  connection.open();
  showRoom();
}

function showRoom() {
  screen = "room";
  world = null;
  roomView.show();
}

function leaveRoom() {
  connection?.send({ type: "leave" });
  connection?.close();
  connection = null;
  net?.dispose();
  net = null;
  showLobby();
}

/** Lab 5: "Грати" in a room = the server's game; this page only sends inputs and draws. */
function startNetGame() {
  if (!net) return; // not welcomed yet
  roomView?.hide();
  screen = "game";
  world = null;
  hud.clear();
  SLOT_COLORS.forEach((color, i) => hud.setPlayerColor(i + 1, color));
  document.getElementById("game").focus();
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
  roomView?.hide(); // the socket stays open: Esc brings the room (and its chat) back
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
const typing = (e) => e.target?.tagName === "INPUT";
input.onPress("KeyP", () => screen === "game" && !net && (paused = !paused));
// Lab 5 netcode keys (in a network game): N netgraph · [ ] interpolation delay · L latency
// presets · O prediction on/off · K break determinism (the M2 experiment)
const inNetGame = () => screen === "game" && net;
input.onPress("KeyN", (e) => !typing(e) && (showNetgraph = !showNetgraph));
input.onPress(
  "BracketLeft",
  () => inNetGame() && (net.interpDelayMs = Math.max(0, net.interpDelayMs - 17)),
);
input.onPress(
  "BracketRight",
  () => inNetGame() && (net.interpDelayMs = Math.min(500, net.interpDelayMs + 17)),
);
input.onPress("KeyO", () => inNetGame() && (net.predict = !net.predict));
input.onPress("KeyK", () => inNetGame() && (net.breakDeterminism = !net.breakDeterminism));
input.onPress("KeyL", () => {
  if (!inNetGame()) return;
  lagPreset = (lagPreset + 1) % LAG_PRESETS.length;
  connection.send({ type: "netsim", ...LAG_PRESETS[lagPreset] });
});
input.onPress("KeyR", () => {
  if (screen !== "game" || net) return;
  world = createWorld();
  probe.result = null;
});
input.onPress("KeyH", (e) => !typing(e) && (showHelp = !showHelp));
input.onPress("KeyM", (e) => !typing(e) && sound?.toggleMute());
input.onPress("Escape", () => {
  if (screen === "loading") loading.controller?.abort();
  else if (screen === "game" && connection) showRoom();
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

/** Either keyboard layout steers the ONE local ship of a network game. */
function netControls() {
  const a = readControls(input, BINDINGS[1]);
  const b = readControls(input, BINDINGS[2]);
  return {
    thrust: a.thrust || b.thrust,
    left: a.left || b.left,
    right: a.right || b.right,
    fire: a.fire || b.fire,
    firePressed: a.firePressed || b.firePressed,
  };
}

function simulate(dt) {
  if (screen === "game" && net) {
    const controls = netControls();
    netFirePressed ||= controls.firePressed; // a click between two 1/30 s steps is not lost
    netAcc += dt;
    while (netAcc >= TICK_DT - 1e-9) {
      net.step({ ...controls, firePressed: netFirePressed });
      netFirePressed = false;
      netAcc -= TICK_DT;
    }
    input.endStep();
    return;
  }
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
  if (screen === "lobby" || screen === "room") {
    drawBackground(ctx, view, lobbyArena, stars);
    return;
  }

  if (net && !world) return renderNet(time);

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
      { text: "P пауза · R рестарт · M звук · Esc назад · H сховати", color: "#9fb0d8" },
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

function renderNet(time) {
  drawBackground(ctx, view, lobbyArena, stars);
  ctx.save();
  applyCamera(ctx, view);
  ctx.beginPath();
  ctx.rect(0, 0, lobbyArena.width, lobbyArena.height);
  ctx.clip();
  drawWorld(ctx, net.view(netAcc / TICK_DT), 1, time, TICK_DT, assets.sprites);
  hud.drawFloaters(ctx);
  ctx.restore();

  const lines = [];
  if (showNetgraph) lines.push(...net.netgraph().map((text) => ({ text, color: "#9fe8ff" })));
  lines.push({
    text: `room     ${room.name} · ${arenas[room.arena]?.name ?? room.arena} · сервер рахує гру, 30 тіків/с`,
    color: "#9fb0d8",
  });
  for (const [slot, p] of net.players) {
    const status = p.respawn > 0 ? `respawn ${p.respawn.toFixed(1)}s` : "";
    lines.push({
      text: `${net.nameOf(slot).padEnd(10)} score ${String(p.score).padStart(5)}   ${status}${slot === net.slot ? "  (ви)" : ""}`,
      color: SLOT_COLORS[(slot - 1) % SLOT_COLORS.length],
    });
  }
  if (!net.alive) lines.push({ text: "Ваш корабель знищено — респаун за 2 с", color: "#ffd479" });
  if (showHelp) {
    lines.push(
      {
        text: "W/↑ тяга · A/D ←/→ поворот · Space/Enter вогонь · Esc кімната · H сховати",
        color: "#9fb0d8",
      },
      {
        text: "N netgraph · [ ] затримка інтерполяції · L затримка мережі · O передбачення · K зламати детермінізм",
        color: "#9fb0d8",
      },
    );
  }
  lines.push(...hud.feedLines());
  drawHud(ctx, lines);
  if (showNetgraph) drawCorrectionGraph(net.corrections);
}

/** Netgraph sparkline: reconciliation correction per snapshot, last 5 s (top right). */
function drawCorrectionGraph(values) {
  const w = 240;
  const h = 70;
  const x = view.width - w - 12;
  const y = view.height - h - 30; // bottom right: the HUD text owns the top
  const max = Math.max(5, ...values);
  ctx.fillStyle = "rgba(5, 8, 16, 0.75)";
  ctx.fillRect(x, y, w, h + 18);
  ctx.strokeStyle = "#9fe8ff";
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  values.forEach((v, i) => {
    const px = x + (i / 149) * w;
    const py = y + 16 + h - (v / max) * (h - 4);
    if (i) ctx.lineTo(px, py);
    else ctx.moveTo(px, py);
  });
  ctx.stroke();
  ctx.fillStyle = "#9fb0d8";
  ctx.font = "11px ui-monospace, Consolas, monospace";
  ctx.textBaseline = "alphabetic";
  ctx.fillText(`correction, 5 s · max ${max.toFixed(1)}`, x + 6, y + 12);
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
  get connection() {
    return connection;
  },
  get net() {
    return net;
  },
  bus,
  probe,
  flags,
  loop,
};
