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
  });
}

export function describeFlags(flags) {
  const parts = [`scheduler: ${flags.scheduler}`, `timestep: ${flags.timestep}`];
  if (flags.blockMs) parts.push(`block: ${flags.blockMs} ms / 60 frames`);
  if (flags.autopilot) parts.push("autopilot: thrust");
  if (flags.thisBug) parts.push("bug: this (press F)");
  return parts.join(" · ");
}

/** Experiment 1: a synchronous block. Nothing else on this thread can run until it returns. */
export function busyWait(ms) {
  const until = performance.now() + ms;
  while (performance.now() < until) {
    // spin
  }
}
