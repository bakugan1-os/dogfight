// Lab 7, M4: how many players can ONE match hold? For each N a fresh server, one room, N headless
// WebSocket clients (the `ws` library) that join, then send a binary input every 1/30 s flying a
// scripted path (circle, thrust in bursts, fire every few ticks) — exactly what a browser sends.
// Every second we read /api/stats; after a warm-up we keep the tick-time p99 (the budget is
// 33.3 ms at 30 Hz), event-loop utilization, RSS, and the bytes the clients received.
//
//   node server/scripts/load-test.ts [8,32,64,128,192,255] [seconds=20]   -> docs/perf/load.json
//
// Caveat, measured: the load generator runs on the same machine (its own process), so at large N
// it competes for CPU with the server.

import { spawn } from "node:child_process";
import { once } from "node:events";
import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";
import { z } from "zod";
import { binaryCodec } from "@dogfight/shared/codec/binary.ts";
import { PROTOCOL_VERSION } from "@dogfight/shared/protocol/control.ts";
import { seq, tick } from "@dogfight/shared/protocol/ids.ts";
import { waitReady } from "./spawn-server.ts";

const LEVELS = (process.argv[2] ?? "8,32,64,128,192,255").split(",").map(Number);
const SECONDS = Number(process.argv[3] ?? 20);
const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const PORT = 8794;
const base = `http://127.0.0.1:${PORT}`;

const Stats = z.object({
  elu: z.number(),
  rssMB: z.number(),
  matches: z.array(
    z.object({
      entities: z.number(),
      players: z.number(),
      tickMs: z.object({ p50: z.number(), p99: z.number(), max: z.number() }),
    }),
  ),
});

async function level(n: number) {
  const server = spawn(process.execPath, ["server/src/index.ts"], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(PORT),
      QUIET: "true",
      MAX_PLAYERS_PER_ROOM: "255",
      MAX_CONNECTIONS: "1000",
      INPUT_RATE_BURST: "200",
      SLOW_CLIENT_BYTES: String(4 * 1024 * 1024),
      DROP_CLIENT_BYTES: String(64 * 1024 * 1024),
    },
    stdio: ["ignore", "pipe", "inherit"],
  });
  await waitReady(base);
  const created = z.object({ room: z.object({ id: z.string() }) }).parse(
    await (
      await fetch(`${base}/api/rooms`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: `Load ${n}`, arena: "classic", mode: "duel", maxPlayers: n }),
      })
    ).json(),
  );

  let bytesIn = 0;
  const clients: WebSocket[] = [];
  for (let i = 0; i < n; i++) {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
    ws.on("error", () => {});
    ws.on("message", (data: Buffer) => (bytesIn += data.length));
    await once(ws, "open");
    ws.send(
      JSON.stringify({ type: "join", v: PROTOCOL_VERSION, room: created.room.id, name: `L${i}` }),
    );
    clients.push(ws);
  }
  let s = 0;
  const timer = setInterval(() => {
    s++;
    clients.forEach((ws, i) => {
      const phase = (s + i * 7) % 90;
      if (ws.readyState !== WebSocket.OPEN) return;
      ws.send(
        binaryCodec.encodeInput({
          seq: seq(s),
          tick: tick(s),
          thrust: phase < 50,
          left: i % 2 === 0 && phase > 60,
          right: i % 2 === 1 && phase > 60,
          fire: phase % 5 === 0,
          firePressed: false,
        }),
      );
    });
  }, 1000 / 30);

  await new Promise((r) => setTimeout(r, 4000)); // warm-up: everyone in, JIT warm
  const bytes0 = bytesIn;
  const t0 = performance.now();
  const samples: Array<z.infer<typeof Stats>> = [];
  for (let i = 0; i < SECONDS; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    samples.push(Stats.parse(await (await fetch(`${base}/api/stats`)).json()));
  }
  const seconds = (performance.now() - t0) / 1000;
  clearInterval(timer);
  const open = clients.filter((ws) => ws.readyState === WebSocket.OPEN).length;
  clients.forEach((ws) => ws.terminate());
  server.kill("SIGTERM");
  await once(server, "exit");
  const last = samples.at(-1)?.matches[0];
  const avg = (f: (x: z.infer<typeof Stats>) => number) =>
    samples.reduce((a, x) => a + f(x), 0) / samples.length;
  return {
    n,
    connected: open,
    entities: last?.entities ?? 0,
    tickP50: last?.tickMs.p50 ?? 0,
    tickP99: last?.tickMs.p99 ?? 0,
    tickMax: last?.tickMs.max ?? 0,
    elu: avg((x) => x.elu),
    rssMB: Math.max(...samples.map((x) => x.rssMB)),
    outMBs: (bytesIn - bytes0) / seconds / 2 ** 20,
  };
}

const results = [];
console.log(
  "| players | entities | tick p50 ms | tick p99 ms | tick max ms | ELU | RSS MB | server → clients MB/s |",
);
console.log("|---|---|---|---|---|---|---|---|");
for (const n of LEVELS) {
  const r = await level(n);
  results.push(r);
  console.log(
    `| ${r.n} | ${r.entities} | ${r.tickP50.toFixed(2)} | ${r.tickP99.toFixed(2)} | ${r.tickMax.toFixed(1)} | ${r.elu.toFixed(2)} | ${r.rssMB.toFixed(0)} | ${r.outMBs.toFixed(1)} |`,
  );
}
await writeFile(`${ROOT}docs/perf/load.json`, JSON.stringify(results, null, 2));
