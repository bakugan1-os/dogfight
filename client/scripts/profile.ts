// Lab 7, M3: a reproducible 30-second profiling session. Builds nothing itself: run
// `npm run build` first. Starts the real server (which serves client/dist), creates a room,
// opens the game in headless Chromium with ?join=<room>&autopilot=1 (our ship circles and shoots
// non-stop), adds 8 server-side bots and records for 30 s. Two runs, so the measuring tools do
// not distort each other:
//
//   run 1 "trace": frame deltas (a rAF probe in the page) + GC events from a Chrome trace
//   run 2 "cpu":   the sampling CPU profile (.cpuprofile, open it in DevTools) + allocation sampling
//
//   node client/scripts/profile.ts before        -> docs/perf/before.json (+ before.cpuprofile)
//
// Needs Playwright (dev dependency) and its Chromium. For readable function names build without
// minification first: `npx vite build client --minify false`.

import { spawn } from "node:child_process";
import { once } from "node:events";
import { writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { chromium, type CDPSession, type Page } from "playwright";
import { z } from "zod";

const label = process.argv[2] ?? "run";
const SECONDS = Number(process.argv[3] ?? 30);
const PORT = 8790;
const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const OUT = `${ROOT}docs/perf/`;
const base = `http://127.0.0.1:${PORT}`;

const server = spawn(process.execPath, ["server/src/index.ts"], {
  cwd: ROOT,
  env: { ...process.env, PORT: String(PORT), QUIET: "true", MAX_PLAYERS_PER_ROOM: "16" },
  stdio: ["ignore", "pipe", "inherit"],
});
let banner = "";
server.stdout.on("data", (d: Buffer) => (banner += String(d)));
while (!banner.includes("dogfight server on")) await new Promise((r) => setTimeout(r, 50));

const post = async (path: string, body: object): Promise<unknown> =>
  (
    await fetch(base + path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    })
  ).json();

async function session(page: Page): Promise<void> {
  const created = z
    .object({ room: z.object({ id: z.string() }) })
    .parse(
      await post("/api/rooms", {
        name: `Profile ${label}`,
        arena: "belt",
        mode: "duel",
        maxPlayers: 9,
      }),
    );
  const room = created.room.id;
  await page.goto(`${base}/?join=${room}&autopilot=1&perf=${process.env.PERF ?? "1"}&name=Prof`);
  await page.waitForFunction(
    () => (window as unknown as { __dogfight: { screen: string } }).__dogfight.screen === "game",
  );
  await post(`/api/rooms/${room}/bots`, { count: 8 });
  await page.waitForTimeout(2000); // let the match fill up and the JIT warm up
}

type TraceEvent = { name: string; ph: string; dur?: number; cat: string; ts: number; args: string };

// JSFLAGS="--no-memory-reducer" etc.: V8 flags for experiments (README, Lab 7)
const browser = await chromium.launch({
  args: process.env.JSFLAGS ? [`--js-flags=${process.env.JSFLAGS}`] : [],
});
const result: Record<string, unknown> = { label, seconds: SECONDS, chromium: browser.version() };

// ---- run 1: frames + GC ----------------------------------------------------------------------------
{
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  await session(page);
  const cdp: CDPSession = await page.context().newCDPSession(page);
  const events: TraceEvent[] = [];
  cdp.on("Tracing.dataCollected", ({ value }) => {
    for (const e of value) {
      events.push({
        name: String(e.name),
        ph: String(e.ph),
        dur: Number(e.dur ?? 0),
        cat: String(e.cat),
        ts: Number(e.ts ?? 0),
        args: e.name === "MajorGC" ? JSON.stringify(e.args) : "",
      });
    }
  });
  await cdp.send("Tracing.start", {
    categories: "devtools.timeline,v8.gc",
    transferMode: "ReportEvents",
  });
  // the probe: one rAF callback per frame, deltas into a preallocated array
  await page.evaluate(() => {
    const w = window as unknown as { __frames: Float64Array; __n: number };
    w.__frames = new Float64Array(10_000);
    w.__n = 0;
    let last = performance.now();
    const tick = (now: number) => {
      w.__frames[w.__n++ % 10_000] = now - last;
      last = now;
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  await page.evaluate(() =>
    (window as unknown as { __dogfight: { perf: () => unknown } }).__dogfight.perf(),
  ); // reset
  await page.waitForTimeout(SECONDS * 1000);
  const frames = await page.evaluate(() => {
    const w = window as unknown as { __frames: Float64Array; __n: number };
    return Array.from(w.__frames.subarray(0, Math.min(w.__n, 10_000)));
  });
  const phases = await page.evaluate(() =>
    (window as unknown as { __dogfight: { perf: () => unknown } }).__dogfight.perf(),
  );
  const done = new Promise<void>((resolve) => cdp.once("Tracing.tracingComplete", () => resolve()));
  await cdp.send("Tracing.end");
  await done;
  const sorted = frames.slice(1).sort((a, b) => a - b);
  const q = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ?? 0;
  const gc = (name: string) => {
    const xs = events
      .filter((e) => e.name === name && e.ph === "X")
      .map((e) => (e.dur ?? 0) / 1000);
    const first = Math.min(...events.filter((e) => e.ts > 0).map((e) => e.ts));
    const at = events
      .filter((e) => e.name === name && e.ph === "X")
      .map((e) => `${((e.ts - first) / 1e6).toFixed(1)}s ${e.args}`);
    return {
      count: xs.length,
      totalMs: xs.reduce((a, b) => a + b, 0),
      maxMs: Math.max(0, ...xs),
      at: name === "MajorGC" ? at : [],
    };
  };
  result.frames = {
    n: sorted.length,
    p50: q(0.5),
    p95: q(0.95),
    p99: q(0.99),
    max: q(1),
    over16_7: sorted.filter((f) => f > 16.7 * 1.5).length,
  };
  result.gc = { minor: gc("MinorGC"), major: gc("MajorGC") };
  result.phases = phases;
  await page.close();
}

// ---- run 2: CPU profile + allocation sampling ----------------------------------------------------------
type ProfileNode = {
  id: number;
  callFrame: { functionName: string; url: string; lineNumber: number };
  children?: number[];
};
type CpuProfile = {
  nodes: ProfileNode[];
  samples: number[];
  timeDeltas: number[];
  startTime: number;
  endTime: number;
};
type HeapNode = {
  callFrame: { functionName: string; url: string; lineNumber: number };
  selfSize: number;
  children: HeapNode[];
};
{
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  await session(page);
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Profiler.enable");
  await cdp.send("Profiler.setSamplingInterval", { interval: 200 });
  await cdp.send("HeapProfiler.enable");
  await cdp.send("Profiler.start");
  // include what the GC already freed: we want everything ALLOCATED, not what survived
  await cdp.send("HeapProfiler.startSampling", {
    samplingInterval: 4096,
    // RETAINED=1: only what is still alive at the end (who fills the old generation?)
    includeObjectsCollectedByMajorGC: process.env.RETAINED !== "1",
    includeObjectsCollectedByMinorGC: process.env.RETAINED !== "1",
  });
  await page.waitForTimeout(SECONDS * 1000);
  const { profile } = (await cdp.send("Profiler.stop")) as unknown as { profile: CpuProfile };
  const { profile: heap } = (await cdp.send("HeapProfiler.stopSampling")) as unknown as {
    profile: { head: HeapNode };
  };
  await mkdir(OUT, { recursive: true });
  await writeFile(`${OUT}${label}.cpuprofile`, JSON.stringify(profile));

  const where = (f: { functionName: string; url: string; lineNumber: number }) =>
    `${f.functionName || "(anonymous)"} ${f.url.replace(/^.*\/(assets|src)\//, "")}:${f.lineNumber + 1}`;
  // self time = samples whose LEAF is this node
  const dt = new Map<number, number>();
  profile.samples.forEach((id, i) => dt.set(id, (dt.get(id) ?? 0) + (profile.timeDeltas[i] ?? 0)));
  const self = new Map<string, number>();
  for (const node of profile.nodes) {
    const name = where(node.callFrame);
    if (/^\((idle|program|garbage collector|root)\)/.test(name)) {
      self.set(
        name.split(" ")[0] ?? name,
        (self.get(name.split(" ")[0] ?? name) ?? 0) + (dt.get(node.id) ?? 0),
      );
      continue;
    }
    self.set(name, (self.get(name) ?? 0) + (dt.get(node.id) ?? 0));
  }
  const total = profile.endTime - profile.startTime;
  result.selfTime = [...self]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 12)
    .map(([fn, us]) => ({ fn, ms: us / 1000, pct: (100 * us) / total }));
  const alloc = new Map<string, number>();
  const walk = (n: HeapNode) => {
    if (n.selfSize)
      alloc.set(where(n.callFrame), (alloc.get(where(n.callFrame)) ?? 0) + n.selfSize);
    n.children.forEach(walk);
  };
  walk(heap.head);
  const allocTotal = [...alloc.values()].reduce((a, b) => a + b, 0);
  result.allocators = [...alloc]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([fn, bytes]) => ({ fn, MB: bytes / 2 ** 20, pct: (100 * bytes) / allocTotal }));
  result.allocatedMBperS = allocTotal / 2 ** 20 / SECONDS;
  await page.close();
}

await browser.close();
server.kill("SIGTERM");
await once(server, "exit");
await writeFile(`${OUT}${label}.json`, JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
