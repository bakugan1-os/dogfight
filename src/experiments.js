// Experiment switches for Milestone 4 ("break it on purpose"). All off by default.
// Turn them on with URL parameters, e.g.  http://localhost:5173/?sched=interval
//
//   ?block=100          busy-wait 100 ms inside render() every 60th frame       (Experiment 1)
//   ?sched=interval     drive the loop with setInterval(frame, 16) instead of rAF (Experiment 2)
//   ?timestep=variable  one simulate(dt) per frame instead of the accumulator   (Experiment 3)
//   ?autopilot=1        hold "thrust" from t = 0 and record the position at t = 5 s (Experiment 3)

export function readExperimentFlags(search) {
  const params = new URLSearchParams(search);
  return Object.freeze({
    blockMs: Number(params.get("block")) || 0,
    scheduler: params.get("sched") === "interval" ? "interval" : "raf",
    timestep: params.get("timestep") === "variable" ? "variable" : "fixed",
    autopilot: params.get("autopilot") === "1",
  });
}

export function describeFlags(flags) {
  const parts = [`scheduler: ${flags.scheduler}`, `timestep: ${flags.timestep}`];
  if (flags.blockMs) parts.push(`block: ${flags.blockMs} ms / 60 frames`);
  if (flags.autopilot) parts.push("autopilot: thrust");
  return parts.join(" · ");
}

/** Experiment 1: a synchronous block. Nothing else on this thread can run until it returns. */
export function busyWait(ms) {
  const until = performance.now() + ms;
  while (performance.now() < until) {
    // spin
  }
}
