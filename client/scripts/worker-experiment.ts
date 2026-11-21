// Lab 7, M4: should the particle update run in a Web Worker? Measures, in Chromium, the MAIN
// THREAD time per 1/60 s step for N particles:
//
//   main:   update the structure-of-arrays pool in place (what client/src/render/particles.ts does)
//   worker: transfer the buffer to a worker, which updates it and transfers it back (zero-copy
//           ownership hand-off); the main thread pays postMessage + the message event, and the
//           result arrives one step later (double buffering)
//
//   node client/scripts/worker-experiment.ts

import { chromium } from "playwright";

const browser = await chromium.launch();
const page = await browser.newPage();
await page.setContent("<!doctype html><title>worker experiment</title>");
const rows = await page.evaluate(async () => {
  // 6 floats per particle in ONE buffer: x, y, vx, vy, age, life
  const STRIDE = 6;
  const update = (a: Float32Array, n: number, dt: number) => {
    const damping = Math.exp(-2 * dt);
    for (let i = 0; i < n; i++) {
      const o = i * STRIDE;
      a[o] = (a[o] ?? 0) + (a[o + 2] ?? 0) * dt;
      a[o + 1] = (a[o + 1] ?? 0) + (a[o + 3] ?? 0) * dt;
      a[o + 2] = (a[o + 2] ?? 0) * damping;
      a[o + 3] = (a[o + 3] ?? 0) * damping;
      a[o + 4] = (a[o + 4] ?? 0) + dt;
      if ((a[o + 4] ?? 0) > (a[o + 5] ?? 1)) a[o + 4] = 0; // recycle: keeps n constant
    }
  };
  const workerSrc = `const STRIDE=${STRIDE}; const update=${update.toString()};
    onmessage = (e) => { const a = new Float32Array(e.data.buf); update(a, e.data.n, e.data.dt);
      postMessage({ buf: e.data.buf }, [e.data.buf]); };`;
  const worker = new Worker(
    URL.createObjectURL(new Blob([workerSrc], { type: "text/javascript" })),
  );
  const fill = (n: number) => {
    const a = new Float32Array(n * STRIDE);
    for (let i = 0; i < a.length; i++) a[i] = Math.random() * 100;
    return a;
  };
  const out: Array<{ n: number; mainUs: number; workerMainUs: number; roundTripUs: number }> = [];
  for (const n of [500, 2000, 10_000, 50_000]) {
    const steps = 600;
    // main thread
    let a = fill(n);
    for (let s = 0; s < 100; s++) update(a, n, 1 / 60); // warm-up
    const t0 = performance.now();
    for (let s = 0; s < steps; s++) update(a, n, 1 / 60);
    const mainUs = ((performance.now() - t0) * 1000) / steps;
    // worker: main-thread cost = postMessage + the 'message' callback; latency = round trip
    a = fill(n);
    let busy = 0;
    let trip = 0;
    for (let s = 0; s < steps + 100; s++) {
      const start = performance.now();
      const back = new Promise<ArrayBuffer>((resolve) => {
        worker.onmessage = (e: MessageEvent<{ buf: ArrayBuffer }>) => {
          const t = performance.now();
          resolve(e.data.buf);
          if (s >= 100) busy += performance.now() - t;
        };
      });
      const p0 = performance.now();
      worker.postMessage({ buf: a.buffer, n, dt: 1 / 60 }, [a.buffer]);
      if (s >= 100) busy += performance.now() - p0;
      a = new Float32Array(await back);
      if (s >= 100) trip += performance.now() - start;
    }
    out.push({
      n,
      mainUs,
      workerMainUs: (busy * 1000) / steps,
      roundTripUs: (trip * 1000) / steps,
    });
  }
  worker.terminate();
  return out;
});
await browser.close();
console.log(
  "| particles | main thread, in place µs/step | worker: main-thread cost µs/step | worker round trip µs |",
);
console.log("|---|---|---|---|");
for (const r of rows) {
  console.log(
    `| ${r.n} | ${r.mainUs.toFixed(1)} | ${r.workerMainUs.toFixed(1)} | ${r.roundTripUs.toFixed(0)} |`,
  );
}
