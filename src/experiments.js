// Switches for experiments and demos. All off by default; turn on with URL parameters,
// e.g.  http://localhost:5173/?sched=interval
//
// Lab 1 (Milestone 4 — "break it on purpose"):
//   ?block=100          busy-wait 100 ms inside render() every 60th frame       (Experiment 1)
//   ?sched=interval     drive the loop with setInterval(frame, 16) instead of rAF (Experiment 2)
//   ?timestep=variable  one simulate(dt) per frame instead of the accumulator   (Experiment 3)
//   ?autopilot=1        P1 holds "thrust" from t = 0; position recorded at t = 5 s (Experiment 3)
// Lab 2:
//   ?bug=this           wires `input.onPress("KeyF", ship.fire)` — press F, read the console
//   ?players=1          solo mode (no second ship)
//   ?seed=42            world seed (same seed + same inputs -> same game)
// Lab 3 (failure gallery — see README):
//   ?fail=404           the asteroid sheet answers HTTP 404     -> vector fallback, game starts
//   ?fail=slow          every asset arrives 0.3-2.8 s late      -> watch the progress bar
//   ?fail=timeout       explosion sound hangs; 1.5 s timeout    -> 2 attempts, then skipped
//   ?fail=flaky         shoot sound: 503, 503, then OK          -> retry with backoff succeeds
//   ?fail=abort         slow assets, auto-abort at 0.9 s        -> "cancelled" + Retry button
//   ?fail=json          arenas.json is corrupt                  -> error + Retry / defaults
//   ?load=sequential    one await after another instead of Promise.all (README timing)
//   ?lobby=slow         rooms answer after 5 s, timeout 3 s     -> lobby shows the error
//   ?lobby=down         rooms answer HTTP 503
//   ?lobby=0            skip the lobby (Lab 1/2 experiment flags skip it too)
//   ?static=1           static host: run the fault rules in the page (src/net/faults.js)

import { faultUrl } from "./net/faults.js";

export function readExperimentFlags(search) {
  const params = new URLSearchParams(search);
  return Object.freeze({
    blockMs: Number(params.get("block")) || 0,
    scheduler: params.get("sched") === "interval" ? "interval" : "raf",
    timestep: params.get("timestep") === "variable" ? "variable" : "fixed",
    autopilot: params.get("autopilot") === "1",
    thisBug: params.get("bug") === "this",
    players: params.get("players") === "1" ? 1 : 2,
    seed: Number(params.get("seed")) || undefined,
    explicitPlayers: params.has("players"),
    fail: params.get("fail"),
    sequential: params.get("load") === "sequential",
    lobby: params.get("lobby"),
    staticHost: params.get("static") === "1",
  });
}

/** Lab 1/2 experiments need the plain game, not menus. */
export function skipsLobby(flags) {
  return (
    flags.lobby === "0" ||
    flags.autopilot ||
    flags.blockMs > 0 ||
    flags.scheduler !== "raf" ||
    flags.timestep !== "fixed" ||
    flags.thisBug
  );
}

/** Rewrites manifest URLs so the server misbehaves in the requested way. Returns a copy. */
export function applyLoadFaults(manifest, fail) {
  const m = structuredClone(manifest);
  const wrap = (entry, kind, arg) => (entry.url = faultUrl(kind, arg, entry.url));
  const all = () => [m.sprites, m.sounds, m.data].flatMap((g) => Object.values(g ?? {}));
  switch (fail) {
    case "404":
      wrap(m.sprites.asteroids, "status", 404);
      break;
    case "slow":
    case "abort":
      all().forEach((entry, i) => wrap(entry, "delay", 300 + i * 250));
      break;
    case "timeout":
      wrap(m.sounds.explosion, "delay", 6000);
      break;
    case "flaky":
      wrap(m.sounds.shoot, "flaky", 2);
      break;
    case "json":
      m.data.arenas.url = "arenas.broken.json";
      break;
  }
  return m;
}

/** Load options per failure mode (timeouts short enough to watch). */
export function loadOptionsFor(fail) {
  return fail === "timeout" ? { timeoutMs: 1500, attempts: 2 } : { timeoutMs: 4000, attempts: 3 };
}

export function roomsUrlFor(lobbyFlag) {
  if (lobbyFlag === "slow") return faultUrl("delay", 5000, "api/rooms.json");
  if (lobbyFlag === "down") return faultUrl("status", 503, "api/rooms.json");
  return "api/rooms.json";
}

export function describeFlags(flags) {
  const parts = [`scheduler: ${flags.scheduler}`, `timestep: ${flags.timestep}`];
  if (flags.blockMs) parts.push(`block: ${flags.blockMs} ms / 60 frames`);
  if (flags.autopilot) parts.push("autopilot: thrust");
  if (flags.thisBug) parts.push("bug: this (press F)");
  if (flags.fail) parts.push(`fail: ${flags.fail}`);
  return parts.join(" · ");
}

/** Experiment 1: a synchronous block. Nothing else on this thread can run until it returns. */
export function busyWait(ms) {
  const until = performance.now() + ms;
  while (performance.now() < until) {
    // spin
  }
}
