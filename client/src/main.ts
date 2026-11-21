// Composition root: creates every module and wires them together. No game rules live here.
// Flow:  loading screen (await loadAll) -> lobby (HTTP, polling) -> room (WebSocket: roster +
// chat, Lab 4) -> game: since Lab 5 the SERVER runs it; this page sends inputs and draws
// snapshots (net/netgame.js). The local game remains for the Lab 1–3 experiment flags.

import { createLoop, type LoopStats } from "./loop.ts";
import { createInput, readControls, BINDINGS } from "./input.ts";
import { World, type WorldEvents } from "@dogfight/shared/sim/world.ts";
import { Bus } from "@dogfight/shared/sim/bus.ts";
import type { Ship, Controls } from "@dogfight/shared/sim/ship.ts";
import { playerId, type PlayerId } from "@dogfight/shared/protocol/ids.ts";
import {
  PROTOCOL_VERSION,
  type NetsimSettings,
  type RoomSummary,
} from "@dogfight/shared/protocol/control.ts";
import { byId } from "./dom.ts";
import * as perf from "./perf.ts";
import { CLIENT_VERSION, fetchServerVersion } from "./version.ts";
import { registerServiceWorker } from "./pwa.ts";
import type { HudLine } from "./render/draw.ts";
import type { LoadingState } from "./render/loading.ts";
import type { Sound } from "./audio.ts";
import type { LobbyView } from "./lobby/lobby-view.ts";
import type { RoomView } from "./lobby/room-view.ts";
import { createArena } from "@dogfight/shared/sim/arena.ts";
import { setupCanvas, applyCamera } from "./render/canvas.ts";
import { createStarfield, drawBackground, drawWorld, drawHud, measureHud } from "./render/draw.ts";
import { drawLoading } from "./render/loading.ts";
import {
  readExperimentFlags,
  describeFlags,
  busyWait,
  skipsLobby,
  applyLoadFaults,
  loadOptionsFor,
  roomsUrlFor,
} from "./experiments.ts";
import { fetchJson, withRetry, withTimeout, describeError, errorName } from "./net/http.ts";
import { createFaultFetch } from "./net/faults.ts";
import {
  planItems,
  loadAll,
  browserLoaders,
  ManifestSchema,
  AssetError,
  type LoadedAssets,
} from "./assets/loader.ts";
import { DEFAULT_ARENAS, validateArenas, type ArenaTable } from "./arenas.ts";
import { createAudioContext, unlockOnGesture, createSound, connectAudio } from "./audio.ts";
import { createHud } from "./hud.ts";
import { Lobby, validateRooms } from "./lobby/lobby.ts";
import { createLobbyView } from "./lobby/lobby-view.ts";
import { createRoomView } from "./lobby/room-view.ts";
import { Connection, socketUrl } from "./net/connection.ts";
import { NetGame } from "./net/netgame.ts";
import { TICK_DT } from "@dogfight/shared/protocol/messages.ts";
import { PLAYER_COLORS as SLOT_COLORS } from "@dogfight/shared/sim/arenas.ts";

const STEP = 1 / 60;
const flags = readExperimentFlags(window.location.search);
const P1 = playerId(1);
const P2 = playerId(2);
const PLAYER_COLORS: Record<1 | 2, string> = { 1: "#7cf3c8", 2: "#ffa36c" };
const slotColor = (slot: PlayerId) => SLOT_COLORS[(slot - 1) % SLOT_COLORS.length] ?? "#fff";
const fetchImpl = flags.staticHost ? createFaultFetch() : globalThis.fetch.bind(globalThis);

// ---- long-lived modules ----------------------------------------------------------------------
const bus = new Bus<WorldEvents>(); // survives restarts: listeners attach once
const audioCtx = createAudioContext(); // created now (suspended), decoded into while loading
void unlockOnGesture(audioCtx); // the first click / key press anywhere resumes it (never rejects)
const hud = createHud(bus);
const input = createInput(window);
const lobbyArena = createArena();
const canvas = byId("game", HTMLCanvasElement);
const { ctx, view } = setupCanvas(canvas, lobbyArena);
const stars = createStarfield(lobbyArena);

const actionsEl = byId("loading-actions", HTMLElement);
const lobbyEl = byId("lobby", HTMLElement);
const roomEl = byId("room", HTMLElement);

type Screen = "loading" | "lobby" | "room" | "game";
let screen: Screen = "loading";
let assets: LoadedAssets<HTMLImageElement, AudioBuffer> = {
  sprites: {},
  sounds: {},
  data: {},
  failures: [],
  ms: 0,
};
let arenas: ArenaTable = DEFAULT_ARENAS;
let sound: Sound | null = null;
let lobbyView: LobbyView | null = null;
let world: World | null = null;
let room: RoomSummary | null = null;
let pilotName = "Пілот";

let paused = false;
let showHelp = true;
let stepMs = 0;

// ---- loading screen ---------------------------------------------------------------------------
const loading: Omit<LoadingState, "elapsed" | "items"> & {
  items: Array<{ key: string; status: string; note?: string }>;
  started: number;
  finished: number;
  controller: AbortController | null;
} = {
  items: [],
  progress: 0,
  phase: "loading",
  headline: "",
  started: 0,
  finished: 0,
  controller: null,
};

function showActions(...names: string[]): void {
  actionsEl.hidden = names.length === 0;
  for (const button of actionsEl.querySelectorAll("button")) {
    button.hidden = !names.includes(button.dataset.action ?? "");
  }
  const last = actionsEl.querySelector(`[data-action="${names.at(-1)}"]`);
  if (last instanceof HTMLElement) last.focus(); // querySelector<T>() would be an unchecked cast
}

async function loadAssets({ useDefaultArenas = false, firstAttempt = false } = {}): Promise<void> {
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
    const manifest = ManifestSchema.parse(
      await withRetry(
        () =>
          fetchJson(manifestUrl, {
            signal: withTimeout(controller.signal, 4000),
            fetch: fetchImpl,
          }),
        { signal: controller.signal },
      ),
    );
    let items = planItems(applyLoadFaults(manifest, flags.fail), manifestUrl);
    if (useDefaultArenas) items = items.filter((item) => item.key !== "data.arenas");
    loading.items = items.map((item) => ({ key: item.key, status: "pending" }));
    loading.headline = flags.sequential
      ? "Послідовно: кожен файл чекає на попередній…"
      : "Паралельно: усі запити стартували одночасно…";

    const result = await loadAll(items, {
      loaders: browserLoaders(audioCtx),
      signal: controller.signal,
      fetch: fetchImpl,
      sequential: flags.sequential,
      ...loadOptionsFor(flags.fail),
      onProgress: (fraction) => void (loading.progress = fraction),
      onItem: (item, status, error) => {
        const row = loading.items.find((r) => r.key === item.key);
        if (row) Object.assign(row, { status, note: error ? describeError(error) : "" });
        if (status.startsWith("retry")) console.info(`[load] ${item.key}: ${status}`);
        if (error) console.warn(`[load] ${item.key}: ${status} (${describeError(error)})`);
      },
    });

    const arenasItem = items.find((i) => i.key === "data.arenas");
    try {
      arenas = useDefaultArenas ? DEFAULT_ARENAS : validateArenas(result.data.arenas);
    } catch (error: unknown) {
      throw arenasItem ? new AssetError(arenasItem, error) : error;
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
    if (skipsLobby(flags) || flags.join) afterLoading(); // experiments: no click needed
  } catch (error: unknown) {
    loading.finished = performance.now();
    if (errorName(error) === "AbortError" && controller.signal.aborted) {
      loading.phase = "aborted";
      loading.headline = "Завантаження скасовано. Нічого не зламалося — можна спробувати ще раз.";
      console.log("[load] aborted by the player");
      showActions("retry");
    } else {
      loading.phase = "error";
      const what = error instanceof AssetError ? error.item.key : "manifest";
      const message = error instanceof Error ? error.message : String(error);
      loading.headline = `Не вдалося завантажити ${what}: ${describeError(error)} — ${message}`;
      console.error("[load] failed:", what, error);
      if (what === "data.arenas") showActions("defaults", "retry");
      else showActions("retry");
    }
  } finally {
    if (loading.controller === controller) loading.controller = null;
  }
}

actionsEl.addEventListener("click", (e) => {
  const action =
    e.target instanceof Element ? e.target.closest("button")?.dataset.action : undefined;
  if (action === "cancel") loading.controller?.abort();
  if (action === "retry") void loadAssets();
  if (action === "defaults") void loadAssets({ useDefaultArenas: true });
  if (action === "start") afterLoading();
});

function afterLoading(): void {
  showActions();
  if (!sound) {
    sound = createSound(audioCtx, assets.sounds);
    connectAudio(bus, sound); // subscribe once; the world only ever dispatches events
  }
  void audioCtx?.resume(); // we are inside a click handler: a user gesture
  if (skipsLobby(flags)) return startGame(null, "P1");
  if (flags.join) return void autoJoin(flags.join);
  showLobby();
}

/** ?join=<room id>: straight into that room's game (Lab 7 profiling and the e2e demo). */
async function autoJoin(roomId: string): Promise<void> {
  try {
    const rooms = validateRooms(
      await fetchJson(new URL(roomsUrlFor(flags.lobby), window.location.href)),
    );
    const target = rooms.find((r) => r.id === roomId);
    if (target) return enterRoom(target, flags.name);
    showLobby(`Кімнати ${roomId} немає`);
  } catch (error: unknown) {
    showLobby(`Не вдалося зайти в ${roomId}: ${describeError(error)}`);
  }
}

// ---- lobby ------------------------------------------------------------------------------------
registerServiceWorker(); // Lab 8: installable (PWA)

const lobby = new Lobby({
  url: new URL(roomsUrlFor(flags.lobby), window.location.href).href,
  fetch: fetchImpl,
});
lobby.on("join", ({ room, name }) => enterRoom(room, name));
lobby.on("error", ({ error }) => console.warn("[lobby]", describeError(error)));

function showLobby(notice?: string): void {
  screen = "lobby";
  world = null;
  roomView?.hide();
  lobbyView ??= createLobbyView(lobbyEl, lobby, { arenas });
  lobbyView.show();
  if (notice) lobbyView.notice(notice);
}

// ---- room: one WebSocket per visit (Lab 4) -----------------------------------------------------
let connection: Connection | null = null;
let roomView: RoomView | null = null;
let net: NetGame | null = null; // Lab 5: the networked game for the current room visit
let netAcc = 0; // accumulator: the page loop steps at 1/60 s, the network game at 1/30 s
let netFirePressed = false;
let showNetgraph = true;
let lagPreset = 0;
const LAG_PRESETS: readonly [NetsimSettings, ...NetsimSettings[]] = [
  { lag: 0, jitter: 0, drop: 0 },
  { lag: 100, jitter: 30, drop: 0.02 },
  { lag: 200, jitter: 50, drop: 0.05 },
];

/** ws URL with the Lab 5 experiment parameters passed through (?codec=json&lag=100…). */
function gameSocketUrl(): string {
  const params = new URLSearchParams();
  if (flags.codec === "json") params.set("codec", "json");
  for (const key of ["lag", "jitter", "drop"] as const)
    if (flags.netsim[key]) params.set(key, String(flags.netsim[key]));
  const query = params.toString();
  return socketUrl() + (query ? `?${query}` : "");
}

const REFUSED: Readonly<Record<number, string | undefined>> = {
  4004: "Сервер не пустив у кімнату: її немає або вона повна.",
  4003: "Сервер закрив з'єднання: не встигли приєднатися за 5 с.",
  4008: "Сервер закрив з'єднання: забагато повідомлень за секунду.",
};

function enterRoom(selectedRoom: RoomSummary, name: string): void {
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
  serverVersion ??= "…";
  fetchServerVersion()
    .then((v) => (serverVersion = v ?? "?"))
    .catch(() => {});
  // Lab 8: ~1 min of backoff (0.5, 1, 2, 4, 8, 8… s, full jitter), then back to the lobby.
  const conn = new Connection(gameSocketUrl(), { maxAttempts: 10 });
  connection = conn;
  let roster: ReadonlyArray<{ name: string; slot?: PlayerId | undefined }> = [];
  let boot: string | undefined; // the server process we joined (welcome.boot)
  const backToLobby = (notice: string) => {
    if (connection !== conn) return;
    conn.close();
    connection = null;
    net?.dispose();
    net = null;
    showLobby(notice);
  };
  // Lab 8: a deploy/restart. The server says so before closing (1001): don't hammer it with
  // reconnects into a match that no longer exists — the lobby polls (with backoff) until it's back.
  conn.on("shutdown", () =>
    backToLobby("Сервер перезапускається (оновлення). За кілька секунд кімнати з'являться знову."),
  );
  // Every (re)join gets a welcome with our slot: a fresh NetGame for that slot.
  conn.on("welcome", (msg) => {
    // Reconnected to a DIFFERENT server process (it crashed and restarted): the match we were
    // in is gone, scores included. Say so instead of silently dropping the player into a new one.
    if (boot !== undefined && msg.boot !== undefined && msg.boot !== boot)
      return backToLobby("Сервер перезапустився — матч скинуто. Оберіть кімнату ще раз.");
    boot = msg.boot;
    net?.dispose();
    net = new NetGame({
      conn,
      arena: lobbyArena,
      slot: msg.slot,
      codec: msg.codec,
      interpDelayMs: flags.interpDelay,
      bus,
      flags: { predict: flags.predict, breakDeterminism: flags.breakDeterminism },
    });
    net.setNames(roster);
    if (flags.join && screen !== "game") startNetGame();
    console.info(
      `[net] slot ${msg.slot}, codec ${msg.codec}, netsim ${JSON.stringify(msg.netsim)}`,
    );
  });
  conn.on("roster", (msg) => {
    roster = msg.players;
    net?.setNames(roster);
  });
  // "open" fires on the first connect AND after every reconnect: (re)join each time.
  conn.on("open", () =>
    conn.send({ type: "join", v: PROTOCOL_VERSION, room: selectedRoom.id, name: pilotName }),
  );
  conn.on("status", ({ state, code, reason }) => {
    console.info(`[ws] ${state}${code ? ` (${code})` : ""}`);
    const refused = code === undefined ? undefined : REFUSED[code];
    if (state === "closed" && refused) showLobby(refused);
    else if (state === "closed" && reason === "gave up")
      backToLobby("Сервер не відповідає. Спробуйте пізніше — лобі оновиться саме.");
  });
  roomView.bind(conn, selectedRoom, arenas[selectedRoom.arena]?.name);
  conn.open();
  showRoom();
}

function showRoom(): void {
  screen = "room";
  world = null;
  roomView?.show();
}

function leaveRoom(): void {
  connection?.send({ type: "leave" });
  connection?.close();
  connection = null;
  net?.dispose();
  net = null;
  showLobby();
}

/** Lab 5: "Грати" in a room = the server's game; this page only sends inputs and draws. */
function startNetGame(): void {
  if (!net) return; // not welcomed yet
  roomView?.hide();
  screen = "game";
  world = null;
  hud.clear();
  SLOT_COLORS.forEach((color, i) => hud.setPlayerColor(i + 1, color));
  canvas.focus();
}

// ---- game -------------------------------------------------------------------------------------
function createWorld(): World {
  const arena = (room && arenas[room.arena]) ?? arenas.classic ?? DEFAULT_ARENAS.classic;
  const players = flags.explicitPlayers || !room ? flags.players : room.mode === "solo" ? 1 : 2;
  const w = new World({
    ...arena,
    ...(flags.seed !== undefined && { seed: flags.seed }),
    events: bus,
  });
  w.addPlayer({ id: P1, name: pilotName, color: PLAYER_COLORS[1] });
  if (players === 2) w.addPlayer({ id: P2, name: "Гість", color: PLAYER_COLORS[2] });
  for (const [id, color] of Object.entries(PLAYER_COLORS)) hud.setPlayerColor(Number(id), color);
  hud.clear();
  return w;
}

function startGame(selectedRoom: RoomSummary | null, name: string): void {
  lobbyView?.hide(); // stops polling and aborts the in-flight room request
  roomView?.hide(); // the socket stays open: Esc brings the room (and its chat) back
  room = selectedRoom;
  pilotName = name;
  const w = createWorld();
  world = w;
  screen = "game";
  paused = false;
  probe.result = null;
  canvas.focus();

  const ship = w.shipOf(P1);
  if (flags.thisBug && ship) {
    // DELIBERATE BUG (Lab 2, Theory §2). `ship.fire` is passed by reference and later called as
    // a plain function by the input module: default binding, `this === undefined` in a module,
    // so `this.angle` throws "Cannot read properties of undefined (reading 'angle')".
    // Lab 6: TypeScript refuses this line — fire() declares `this: Ship` — so the experiment
    // has to switch the check off for exactly this line to keep the bug reproducible.
    // @ts-expect-error -- the Lab 2 `this` experiment: "'this' context of type 'void' is not assignable"
    input.onPress("KeyF", ship.fire);
    // The fixes, in the order we prefer them:
    //   input.onPress("KeyF", () => ship.fire(world));      // arrow wrapper — chosen
    //   input.onPress("KeyF", ship.fire.bind(ship, world)); // bind
  }
}

// ---- UI keys: event callbacks, NOT simulation input --------------------------------------------
const typing = (e: KeyboardEvent) => e.target instanceof HTMLInputElement;
input.onPress("KeyP", () => {
  if (screen === "game" && !net) paused = !paused;
});
// Lab 5 netcode keys (in a network game): N netgraph · [ ] interpolation delay · L latency
// presets · O prediction on/off · K break determinism (the M2 experiment)
/** The network game, if one is on screen (null otherwise) — callers check, then use it. */
const netGameOnScreen = (): NetGame | null => (screen === "game" ? net : null);
input.onPress("KeyN", (e) => {
  if (!typing(e)) showNetgraph = !showNetgraph;
});
input.onPress("BracketLeft", () => {
  const g = netGameOnScreen();
  if (g) g.interpDelayMs = Math.max(0, g.interpDelayMs - 17);
});
input.onPress("BracketRight", () => {
  const g = netGameOnScreen();
  if (g) g.interpDelayMs = Math.min(500, g.interpDelayMs + 17);
});
input.onPress("KeyO", () => {
  const g = netGameOnScreen();
  if (g) g.predict = !g.predict;
});
input.onPress("KeyK", () => {
  const g = netGameOnScreen();
  if (g) g.breakDeterminism = !g.breakDeterminism;
});
input.onPress("KeyL", () => {
  if (!netGameOnScreen()) return;
  lagPreset = (lagPreset + 1) % LAG_PRESETS.length;
  const preset = LAG_PRESETS[lagPreset] ?? LAG_PRESETS[0];
  connection?.send({ type: "netsim", ...preset });
});
input.onPress("KeyR", () => {
  if (screen !== "game" || net) return;
  world = createWorld();
  probe.result = null;
});
input.onPress("KeyH", (e) => {
  if (!typing(e)) showHelp = !showHelp;
});
input.onPress("KeyM", (e) => {
  if (!typing(e)) sound?.toggleMute();
});
input.onPress("Escape", () => {
  if (screen === "loading") loading.controller?.abort();
  else if (screen === "game" && connection) showRoom();
  else if (screen === "game" && !skipsLobby(flags)) showLobby();
});

// Lab 1 experiment 3 probe: where is P1 after exactly 5 s of holding thrust?
const AUTOPILOT: Controls = Object.freeze({
  thrust: true,
  left: false,
  right: false,
  fire: false,
  firePressed: false,
});
type ProbeResult = { x: number; y: number; simTime: number; steps: number };
const probe: { result: ProbeResult | null } = { result: null };

/** Either keyboard layout steers the ONE local ship of a network game. */
function netControls(): Controls {
  if (flags.autopilot) {
    // ?autopilot=1 in a network game: circle and shoot without a human (profiling runs)
    const phase = Math.floor(performance.now() / 1500) % 4;
    return {
      thrust: phase !== 3,
      left: phase === 1,
      right: phase === 2,
      fire: true,
      firePressed: false,
    };
  }
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

/** Lab 7: each phase is measured (perf.ts, ?perf=1) — a no-op call when instrumentation is off. */
function simulate(dt: number): void {
  const t0 = perf.begin();
  simulateStep(dt);
  perf.end("simulate", t0);
}

function simulateStep(dt: number): void {
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
  if (screen !== "game" || paused || !world) {
    input.endStep();
    return;
  }
  const inputs = new Map<PlayerId, Controls>([
    [P1, flags.autopilot ? AUTOPILOT : readControls(input, BINDINGS[1])],
    [P2, readControls(input, BINDINGS[2])],
  ]);
  const t0 = performance.now();
  world.step(dt, inputs);
  stepMs = performance.now() - t0;
  input.endStep();

  if (flags.autopilot && !probe.result && world.time >= 5 - 1e-9) {
    const ship = world.shipOf(P1);
    probe.result = ship
      ? { x: ship.pos.x, y: ship.pos.y, simTime: world.time, steps: world.tick }
      : null;
    console.log("[probe] after 5 s of thrust:", JSON.stringify(probe.result));
  }
}

let frameNo = 0;

function effectsText(ship: Ship): string {
  return [...ship.effects].map(([name, left]) => `${name} ${left.toFixed(1)}s`).join(" ");
}

function render(alpha: number, stats: LoopStats): void {
  const t0 = perf.begin();
  renderFrame(alpha, stats);
  perf.end("render", t0);
}

function renderFrame(alpha: number, stats: LoopStats): void {
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

  if (net && !world) return renderNet(net, time);
  if (!world) return;

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

  const lines: HudLine[] = [
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
      ...(player.color && { color: player.color }),
    });
  }
  if (showHelp) {
    lines.push(
      { text: describeFlags(flags), color: "#9fb0d8" },
      { text: "P1: W тяга, A/D поворот, Space вогонь", color: "#9fb0d8" },
      { text: "P2: ↑ тяга, ←/→ поворот, Enter вогонь", color: "#9fb0d8" },
      { text: "P пауза · R рестарт · M звук · Esc назад · H сховати", color: "#9fb0d8" },
      { text: `version ${CLIENT_VERSION}`, color: "#6f7fa8" },
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

function renderNet(net: NetGame, time: number): void {
  drawBackground(ctx, view, lobbyArena, stars);
  ctx.save();
  applyCamera(ctx, view);
  ctx.beginPath();
  ctx.rect(0, 0, lobbyArena.width, lobbyArena.height);
  ctx.clip();
  drawWorld(ctx, net.view(netAcc / TICK_DT), 1, time, TICK_DT, assets.sprites);
  hud.drawFloaters(ctx);
  ctx.restore();

  // Lab 7: the HUD text was rebuilt (strings, objects, measureText) 60 times a second; numbers
  // that change 4 times a second are now rebuilt 5 times a second and reused in between.
  const now = performance.now();
  if (now - netHud.builtAt > 200) buildNetHud(net, now);
  drawHud(ctx, netHud.lines, netHud.width);
  if (showNetgraph) drawCorrectionGraph(net.corrections);
}

let serverVersion: string | null = null; // Lab 8: from /health, shown in the netgraph

const netHud: { lines: HudLine[]; width: number; builtAt: number } = {
  lines: [],
  width: 0,
  builtAt: -Infinity,
};

function buildNetHud(net: NetGame, now: number): void {
  const lines = netHud.lines;
  lines.length = 0;
  if (showNetgraph) for (const text of net.netgraph()) lines.push({ text, color: "#9fe8ff" });
  if (room) {
    lines.push({
      text: `room     ${room.name} · ${arenas[room.arena]?.name ?? room.arena} · сервер рахує гру, 30 тіків/с`,
      color: "#9fb0d8",
    });
  }
  if (showNetgraph)
    lines.push({
      text: `version  client ${CLIENT_VERSION} · server ${serverVersion ?? "?"}`,
      color: "#6f7fa8",
    });
  for (const [slot, p] of net.players) {
    const status = p.respawn > 0 ? `respawn ${p.respawn.toFixed(1)}s` : "";
    lines.push({
      text: `${net.nameOf(slot).padEnd(10)} score ${String(p.score).padStart(5)}   ${status}${slot === net.slot ? "  (ви)" : ""}`,
      color: slotColor(slot),
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
  netHud.width = measureHud(ctx, lines);
  netHud.builtAt = now;
}

/** Netgraph sparkline: reconciliation correction per snapshot, last 5 s (top right). */
let graphLabel = { max: -1, text: "" };

function drawCorrectionGraph(values: readonly number[]): void {
  const w = 240;
  const h = 70;
  const x = view.width - w - 12;
  const y = view.height - h - 30; // bottom right: the HUD text owns the top
  let max = 5; // Lab 7: was Math.max(5, ...values) — spreading 150 numbers into an arguments list
  for (const v of values) if (v > max) max = v;
  ctx.fillStyle = "rgba(5, 8, 16, 0.75)";
  ctx.fillRect(x, y, w, h + 18);
  ctx.strokeStyle = "#9fe8ff";
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  for (let i = 0; i < values.length; i++) {
    // integers: a float passed into a canvas call is boxed into a new heap number (Lab 7)
    const px = (x + (i / 149) * w) | 0;
    const py = (y + 16 + h - ((values[i] ?? 0) / max) * (h - 4)) | 0;
    if (i) ctx.lineTo(px, py);
    else ctx.moveTo(px, py);
  }
  ctx.stroke();
  ctx.fillStyle = "#9fb0d8";
  ctx.font = "11px ui-monospace, Consolas, monospace";
  ctx.textBaseline = "alphabetic";
  const rounded = Math.round(max * 10);
  if (graphLabel.max !== rounded)
    graphLabel = { max: rounded, text: `correction, 5 s · max ${max.toFixed(1)}` };
  ctx.fillText(graphLabel.text, x + 6, y + 12);
}

const loop = createLoop({
  step: STEP,
  simulate,
  render,
  scheduler: flags.scheduler,
  timestep: flags.timestep,
});
loop.start(); // the loop runs from the first frame: loading never blocks it
void loadAssets({ firstAttempt: true });

declare global {
  interface Window {
    /** Handle for experiments and debugging from the DevTools console (and Playwright). */
    __dogfight?: object;
  }
}
window.__dogfight = {
  stats: loop.stats,
  perf: perf.summary,
  /** Lab 7 (Playwright): my slot and the ships of the newest snapshot, or null outside a match */
  get netState() {
    return net ? { slot: net.slot, ships: net.ships() } : null;
  },
  get world() {
    return world;
  },
  get ship() {
    return world?.shipOf(P1) ?? null;
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
