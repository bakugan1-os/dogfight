// Lab 8, M2: chaos tests against a running server — by default a child process, or the
// production image as a "staging" container (DOCKER_IMAGE=dogfight:lab08).
//
//   node server/scripts/chaos.ts                         -> docs/perf/chaos.json
//   DOCKER_IMAGE=dogfight:lab08 node server/scripts/chaos.ts
//
// Room A (r-104): 6 bots + a watcher client that records when each snapshot arrives.
//   1. baseline        10 s of normal play: room A's tick time, tick lateness, snapshot gaps
//   2. client kill     a player's TCP connection is destroyed mid-match (no close frame)
//   3. garbage flood   10 s of ~1000 garbage frames/s from 8 sockets that reconnect when closed:
//                      every one closed, logged and counted — and room A's numbers don't move
//   4. server SIGTERM  a real browser in a match: "shutdown" -> lobby notice; server back -> rooms
//   5. server SIGKILL  no goodbye: the browser reconnects with backoff; the server comes back as
//                      a NEW process (new boot id) -> lobby notice "server restarted"

import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";
import { chromium, type Page } from "playwright";
import { PROTOCOL_VERSION } from "@dogfight/shared/protocol/control.ts";
import { waitReady } from "./spawn-server.ts";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const PORT = 8795;
const base = `http://127.0.0.1:${PORT}`;
const wsUrl = `ws://127.0.0.1:${PORT}/ws`;
const IMAGE = process.env.DOCKER_IMAGE;
const CONTAINER = "dogfight-staging";
const ROOM_A = "r-104";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---- the target: a process or a container, with its JSON log lines ---------------------------
type LogLine = { event?: string; reason?: string; code?: number; level?: number };
const logs: LogLine[] = [];
let child: ChildProcess | null = null;

function collect(stream: NodeJS.ReadableStream | null): void {
  let rest = "";
  stream?.on("data", (d: Buffer) => {
    const parts = (rest + String(d)).split("\n");
    rest = parts.pop() ?? "";
    for (const line of parts) {
      try {
        logs.push(JSON.parse(line) as LogLine);
      } catch {
        // not JSON (docker noise): ignore
      }
    }
  });
}

const env = { LOG_LEVEL: "info", MAX_CONNECTIONS_PER_IP: "50", SHUTDOWN_GRACE_MS: "2000" };

async function startTarget(): Promise<void> {
  if (IMAGE) {
    const args = Object.entries(env).flatMap(([k, v]) => ["-e", `${k}=${v}`]);
    try {
      execFileSync("docker", ["start", CONTAINER], { stdio: "ignore" });
    } catch {
      execFileSync("docker", [
        "run",
        "-d",
        "--name",
        CONTAINER,
        "-p",
        `${PORT}:8787`,
        ...args,
        IMAGE,
      ]);
    }
    child = spawn("docker", ["logs", "-f", "--since", "1s", CONTAINER], {
      stdio: ["ignore", "pipe", "ignore"],
    });
  } else {
    child = spawn(process.execPath, ["server/src/index.ts"], {
      cwd: ROOT,
      env: { ...process.env, PORT: String(PORT), ...env },
      stdio: ["ignore", "pipe", "inherit"],
    });
  }
  collect(child.stdout);
  await waitReady(base, 30_000);
}

async function killTarget(signal: "SIGTERM" | "SIGKILL"): Promise<void> {
  if (IMAGE) {
    if (signal === "SIGTERM") execFileSync("docker", ["stop", CONTAINER]);
    else execFileSync("docker", ["kill", "-s", "KILL", CONTAINER]);
    child?.kill();
    return;
  }
  const c = child;
  if (!c) return;
  const exited = new Promise((r) => c.once("exit", r));
  c.kill(signal);
  await exited;
}

// ---- metrics ------------------------------------------------------------------------------------
async function scrape(): Promise<Map<string, number>> {
  const text = await (await fetch(`${base}/metrics`)).text();
  const out = new Map<string, number>();
  for (const line of text.split("\n")) {
    const m = /^([a-z0-9_]+(?:\{[^}]*\})?) ([\d.e+-]+|NaN)$/.exec(line);
    if (m?.[1] && m[2]) out.set(m[1], Number(m[2]));
  }
  return out;
}
const delta = (a: Map<string, number>, b: Map<string, number>, key: string) =>
  (b.get(key) ?? 0) - (a.get(key) ?? 0);

/** p99 from histogram bucket DELTAS: the smallest bucket bound holding 99 % of the samples. */
function p99FromBuckets(a: Map<string, number>, b: Map<string, number>, room: string): number {
  const prefix = `dogfight_tick_duration_seconds_bucket{le="`;
  const bounds = [...b.keys()]
    .filter((k) => k.startsWith(prefix) && k.endsWith(`room="${room}"}`))
    .map((k) => ({ k, le: Number(k.slice(prefix.length, k.indexOf('"', prefix.length))) }))
    .sort((x, y) => x.le - y.le);
  const total = delta(a, b, `dogfight_tick_duration_seconds_count{room="${room}"}`);
  for (const { k, le } of bounds) if (delta(a, b, k) >= total * 0.99) return le * 1000;
  return Infinity;
}

const rejections = (m: Map<string, number>) =>
  Object.fromEntries(
    [...m]
      .filter(([k]) => k.startsWith("dogfight_ws_rejected_total{"))
      .map(([k, v]) => [/reason="([^"]+)"/.exec(k)?.[1] ?? k, v]),
  );

// ---- a headless player ---------------------------------------------------------------------------
function player(name: string, room: string) {
  const ws = new WebSocket(wsUrl);
  const arrivals: number[] = [];
  const rosters: Array<{ t: number; names: string[] }> = [];
  ws.on("open", () => ws.send(JSON.stringify({ type: "join", v: PROTOCOL_VERSION, room, name })));
  ws.on("message", (data, isBinary) => {
    if (isBinary) return void arrivals.push(performance.now());
    const msg = JSON.parse(String(data)) as { type: string; players?: Array<{ name: string }> };
    if (msg.type === "roster")
      rosters.push({ t: performance.now(), names: (msg.players ?? []).map((p) => p.name) });
  });
  ws.on("error", () => {});
  return { ws, arrivals, rosters };
}

/** Gaps between consecutive snapshots in [from, to): p99 and max, ms (ideal: 33.3). */
function gaps(arrivals: number[], from: number, to: number) {
  const t = arrivals.filter((x) => x >= from && x < to);
  const d = t
    .slice(1)
    .map((x, i) => x - (t[i] ?? x))
    .sort((a, b) => a - b);
  const q = (p: number) => d[Math.min(d.length - 1, Math.floor(d.length * p))] ?? 0;
  return {
    snapshots: t.length,
    p50: round(q(0.5)),
    p99: round(q(0.99)),
    max: round(d.at(-1) ?? 0),
  };
}
const round = (x: number) => Math.round(x * 100) / 100;

async function phase(name: string, ms: number, watcher: ReturnType<typeof player>) {
  const m0 = await scrape();
  const t0 = performance.now();
  await sleep(ms);
  const t1 = performance.now();
  const m1 = await scrape();
  const ticks = delta(m0, m1, `dogfight_tick_duration_seconds_count{room="${ROOM_A}"}`);
  const result = {
    phase: name,
    roomA: {
      ticks,
      tickMeanMs: round(
        (delta(m0, m1, `dogfight_tick_duration_seconds_sum{room="${ROOM_A}"}`) / ticks) * 1000,
      ),
      tickP99Ms: p99FromBuckets(m0, m1, ROOM_A),
      tickLatenessP95Ms: round(m1.get(`dogfight_tick_jitter_p95_ms{room="${ROOM_A}"}`) ?? NaN),
      snapshotGapsMs: gaps(watcher.arrivals, t0, t1),
    },
    elu: round(m1.get("dogfight_event_loop_utilization") ?? NaN),
    messagesInPerSec: Math.round(
      delta(m0, m1, `dogfight_ws_messages_total{direction="in"}`) / ((t1 - t0) / 1000),
    ),
    rejected: Object.fromEntries(
      Object.entries(rejections(m1)).map(([k, v]) => [k, v - (rejections(m0)[k] ?? 0)]),
    ),
  };
  console.log(JSON.stringify(result));
  return result;
}

// ---- the garbage flood -----------------------------------------------------------------------------
async function flood(ms: number, perSecond: number, sockets: number) {
  const closeCodes: Record<number, number> = {};
  const stats = { framesSent: 0, connections: 0, closedByServer: 0, closeCodes };
  const until = performance.now() + ms;
  const junk = [
    "{{{ not json",
    '{"type":"nope"}',
    Buffer.from([0xde, 0xad, 0xbe, 0xef, 0, 1, 2]),
    "x".repeat(10_000),
  ];
  const perSocketPerTick = Math.max(1, Math.round(perSecond / sockets / 100)); // a tick = 10 ms
  const loop = async () => {
    while (performance.now() < until) {
      const ws = new WebSocket(wsUrl);
      stats.connections++;
      ws.on("error", () => {});
      await new Promise<void>((resolve) => {
        let timer: ReturnType<typeof setInterval> | null = null;
        ws.on("open", () => {
          timer = setInterval(() => {
            for (let i = 0; i < perSocketPerTick && ws.readyState === WebSocket.OPEN; i++) {
              ws.send(junk[stats.framesSent % junk.length] ?? "");
              stats.framesSent++;
            }
            if (performance.now() > until) ws.terminate();
          }, 10);
        });
        ws.on("close", (code) => {
          if (timer) clearInterval(timer);
          if (code !== 1006) stats.closedByServer++;
          stats.closeCodes[code] = (stats.closeCodes[code] ?? 0) + 1;
          resolve();
        });
      });
    }
  };
  await Promise.all(Array.from({ length: sockets }, loop));
  return stats;
}

// ---- a real browser for the server-kill scenarios -------------------------------------------------
async function noticeAfter(page: Page, from: number, timeoutMs: number) {
  const notice = page.locator("p.notice:not([hidden])");
  await notice.waitFor({ timeout: timeoutMs });
  return { text: (await notice.textContent()) ?? "", ms: Math.round(performance.now() - from) };
}

async function inGame(page: Page): Promise<void> {
  await page.goto(`${base}/?join=${ROOM_A}&name=Chaos`);
  await page.waitForFunction(
    () =>
      (globalThis as unknown as { __dogfight?: { netState?: { slot: number } | null } }).__dogfight
        ?.netState?.slot,
    undefined,
    { timeout: 15_000 },
  );
}

// ---- run -----------------------------------------------------------------------------------------
await startTarget();
const report: Record<string, unknown> = { target: IMAGE ? `docker ${IMAGE}` : "node process" };
try {
  await fetch(`${base}/api/rooms/${ROOM_A}/bots`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ count: 6 }),
  });
  const watcher = player("Watcher", ROOM_A);
  await sleep(2000);

  // 1. baseline
  report.baseline = await phase("baseline", 10_000, watcher);

  // 2. client kill
  const kim = player("Kim", ROOM_A);
  while (!watcher.rosters.at(-1)?.names.includes("Kim")) await sleep(10);
  const m0 = await scrape();
  const killedAt = performance.now();
  kim.ws.terminate(); // destroys the TCP socket: no close frame, like a crashed tab
  while (watcher.rosters.at(-1)?.names.includes("Kim")) await sleep(5);
  const rosterMs = Math.round(performance.now() - killedAt);
  const m1 = await scrape();
  report.clientKill = {
    rosterUpdatedAfterMs: rosterMs,
    playersBefore: m0.get("dogfight_players"),
    playersAfter: m1.get("dogfight_players"),
    closeLogged: logs.some((l) => l.event === "ws.closed" && l.code === 1006),
  };
  console.log(JSON.stringify({ clientKill: report.clientKill }));

  // 3. garbage flood (and room A measured at the same time)
  const logsBefore = logs.length;
  const [floodStats, during] = await Promise.all([
    flood(10_000, 1000, 8),
    phase("garbage flood", 10_000, watcher),
  ]);
  const newLogs = logs.slice(logsBefore);
  report.flood = {
    ...floodStats,
    logged: {
      wsClose: newLogs.filter((l) => l.event === "ws.close").length,
      wsRejected: newLogs.filter((l) => l.event === "ws.rejected").length,
    },
    roomA: during,
  };
  console.log(JSON.stringify({ flood: floodStats }));
  report.after = await phase("after", 5000, watcher);
  watcher.ws.close();

  // 4 + 5. a browser in a match while the server goes away
  const browser = await chromium.launch();
  const page = await browser.newPage();
  try {
    await inGame(page);
    let t = performance.now();
    await killTarget("SIGTERM");
    const graceful = await noticeAfter(page, t, 10_000);
    t = performance.now();
    await startTarget();
    await page.locator("ul.rooms button.room").first().waitFor({ timeout: 30_000 });
    report.serverSigterm = {
      lobbyNotice: graceful,
      roomsBackAfterRestartMs: Math.round(performance.now() - t),
    };
    console.log(JSON.stringify({ serverSigterm: report.serverSigterm }));

    await inGame(page);
    await killTarget("SIGKILL");
    await sleep(3000); // the server is down; the page retries with backoff meanwhile
    t = performance.now();
    await startTarget();
    const ready = performance.now() - t;
    const crash = await noticeAfter(page, t, 30_000);
    report.serverSigkill = { downMs: 3000, restartReadyMs: Math.round(ready), lobbyNotice: crash };
    console.log(JSON.stringify({ serverSigkill: report.serverSigkill }));
  } finally {
    await browser.close();
  }
} finally {
  await killTarget("SIGTERM").catch(() => {});
  if (IMAGE) execFileSync("docker", ["rm", "-f", CONTAINER], { stdio: "ignore" });
}
await writeFile(
  new URL("../../docs/perf/chaos.json", import.meta.url),
  JSON.stringify(report, null, 2) + "\n",
);
console.log("-> docs/perf/chaos.json");
