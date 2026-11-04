// The game loop: requestAnimationFrame drives rendering, a clamped accumulator drives a
// fixed-timestep simulation ("Fix Your Timestep!", Glenn Fiedler).
//
//  rAF callback (once per display refresh)
//    └─ accumulator += min(frameDelta, maxFrame)
//    └─ while (accumulator >= step) simulate(step)     ← 0, 1 or several times
//    └─ render(alpha = accumulator / step)              ← exactly once
//
// The accumulator itself is a separate, DOM-free object so it can be unit-tested in Node.

/**
 * Pure fixed-step accumulator. Feed it real frame deltas, it calls `simulate(step)` a whole
 * number of times and returns the interpolation factor alpha in [0, 1).
 */
export function createAccumulator({ step = 1 / 60, maxFrame = 0.25 } = {}) {
  let accumulator = 0;
  return {
    step,
    /** @returns {{ steps: number, alpha: number }} */
    advance(deltaSeconds, simulate) {
      // Clamp: after a 2-second hitch (tab switch, breakpoint, GC) we do NOT try to run 120
      // catch-up steps — that would make the next frame even slower ("spiral of death").
      accumulator += Math.min(Math.max(deltaSeconds, 0), maxFrame);
      let steps = 0;
      while (accumulator >= step) {
        simulate(step);
        accumulator -= step;
        steps++;
      }
      return { steps, alpha: accumulator / step };
    },
    reset() {
      accumulator = 0;
    },
  };
}

/**
 * @param {object} options
 * @param {number} [options.step=1/60]          fixed simulation step, seconds
 * @param {(dt:number)=>void} options.simulate  advances the world by dt
 * @param {(alpha:number, stats:object)=>void} options.render
 * @param {number} [options.maxFrame=0.25]      clamp for one frame's delta, seconds
 * @param {"raf"|"interval"} [options.scheduler="raf"]   Experiment 2 switches to setInterval
 * @param {"fixed"|"variable"} [options.timestep="fixed"] Experiment 3 switches to variable dt
 * @returns {{ start(): void, stop(): void, stats: object }}
 */
export function createLoop({
  step = 1 / 60,
  simulate,
  render,
  maxFrame = 0.25,
  scheduler = "raf",
  timestep = "fixed",
} = {}) {
  const accumulator = createAccumulator({ step, maxFrame });

  // Public, live-updated numbers for the HUD and for experiments.
  const stats = {
    stepsPerSec: 0, // simulation steps in the last measured second
    framesPerSec: 0, // render calls in the last measured second
    frameTime: 0, // ms between this frame and the previous one (what the player feels)
    frameWork: 0, // ms spent inside our own callback (simulate + render)
    jitter: 0, // standard deviation of frameTime over the last 120 frames, ms
    maxFrameTime: 0, // worst frameTime over the last 120 frames, ms
    totalSteps: 0,
    totalFrames: 0,
    scheduler,
    timestep,
  };

  const history = new Float64Array(120); // ring buffer of recent frame deltas
  let historyIndex = 0;
  let historyCount = 0;

  let running = false;
  let handle = 0;
  let last = 0;
  let windowStart = 0;
  let stepsInWindow = 0;
  let framesInWindow = 0;

  function countedSimulate(dt) {
    simulate(dt);
    stepsInWindow++;
    stats.totalSteps++;
  }

  function recordFrame(deltaMs, now) {
    stats.frameTime = deltaMs;
    history[historyIndex] = deltaMs;
    historyIndex = (historyIndex + 1) % history.length;
    historyCount = Math.min(historyCount + 1, history.length);

    let sum = 0;
    let max = 0;
    for (let i = 0; i < historyCount; i++) {
      sum += history[i];
      if (history[i] > max) max = history[i];
    }
    const mean = sum / historyCount;
    let variance = 0;
    for (let i = 0; i < historyCount; i++) variance += (history[i] - mean) ** 2;
    stats.jitter = Math.sqrt(variance / historyCount);
    stats.maxFrameTime = max;

    framesInWindow++;
    stats.totalFrames++;
    const elapsed = now - windowStart;
    if (elapsed >= 1000) {
      stats.stepsPerSec = (stepsInWindow * 1000) / elapsed;
      stats.framesPerSec = (framesInWindow * 1000) / elapsed;
      stepsInWindow = 0;
      framesInWindow = 0;
      windowStart = now;
    }
  }

  function frame(now) {
    if (!running) return;
    const workStart = performance.now();
    const deltaMs = Math.max(0, now - last);
    last = now;
    recordFrame(deltaMs, now);

    let alpha;
    if (timestep === "fixed") {
      alpha = accumulator.advance(deltaMs / 1000, countedSimulate).alpha;
    } else {
      // Experiment 3: one simulate() per frame with the real (clamped) elapsed time.
      countedSimulate(Math.min(deltaMs / 1000, maxFrame));
      alpha = 1; // nothing to interpolate: the current state IS the frame time
    }
    render(alpha, stats);

    stats.frameWork = performance.now() - workStart;
    if (running && scheduler === "raf") handle = requestAnimationFrame(frame);
  }

  return {
    stats,
    start() {
      if (running) return;
      running = true;
      last = performance.now();
      windowStart = last;
      accumulator.reset();
      if (scheduler === "raf") {
        handle = requestAnimationFrame(frame);
      } else {
        // Experiment 2: the "wrong" way. Not aligned to vsync, 16 != 16.667, keeps firing in
        // background tabs (but is throttled there to >= 1000 ms by the browser).
        handle = setInterval(() => frame(performance.now()), 16);
      }
    },
    stop() {
      running = false;
      if (scheduler === "raf") cancelAnimationFrame(handle);
      else clearInterval(handle);
    },
  };
}
