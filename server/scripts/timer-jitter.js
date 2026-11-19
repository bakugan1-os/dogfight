// Prove-it #4: setInterval(fn, 33) vs an absolute-target setTimeout loop, 5 s each.
// Prints mean interval, jitter (std dev of intervals) and how far each drifted from 30 Hz.
//   node scripts/timer-jitter.js

const SECONDS = 5;
const PERIOD = 1000 / 30;

function summarize(name, times) {
  const intervals = times.slice(1).map((t, i) => t - times[i]);
  const mean = intervals.reduce((a, b) => a + b, 0) / intervals.length;
  const sd = Math.sqrt(intervals.reduce((a, b) => a + (b - mean) ** 2, 0) / intervals.length);
  console.log(
    `${name.padEnd(28)} ticks ${times.length} (30 Hz would be ${SECONDS * 30})  mean ${mean.toFixed(2)} ms  sd ${sd.toFixed(2)} ms  drift ${(times.at(-1) - times[0] - (times.length - 1) * PERIOD).toFixed(1)} ms`,
  );
}

async function viaInterval() {
  const times = [];
  const t0 = performance.now();
  await new Promise((resolve) => {
    const id = setInterval(() => {
      times.push(performance.now());
      if (performance.now() - t0 >= SECONDS * 1000) {
        clearInterval(id);
        resolve();
      }
    }, 33);
  });
  return times;
}

async function viaAbsolute() {
  const times = [];
  const t0 = performance.now();
  let next = t0;
  await new Promise((resolve) => {
    const tick = () => {
      times.push(performance.now());
      if (performance.now() - t0 >= SECONDS * 1000) return resolve();
      next += PERIOD;
      setTimeout(tick, Math.max(0, next - performance.now()));
    };
    setTimeout(tick, 0);
  });
  return times;
}

/** Background load: 20 ms of synchronous work every 70 ms (other rooms, a GC pause…). */
function withLoad(run) {
  const id = setInterval(() => {
    const until = performance.now() + 20;
    while (performance.now() < until);
  }, 70);
  return run().finally(() => clearInterval(id));
}

console.log("idle:");
summarize("setInterval(fn, 33)", await viaInterval());
summarize("absolute target setTimeout", await viaAbsolute());
console.log("under load (20 ms busy every 70 ms):");
summarize("setInterval(fn, 33)", await withLoad(viaInterval));
summarize("absolute target setTimeout", await withLoad(viaAbsolute));
