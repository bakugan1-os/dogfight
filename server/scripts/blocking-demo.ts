// M4: what a 300 ms synchronous handler does to EVERYONE on the server.
// Two players chat in a room: A sends a line every 50 ms, B measures how long each takes to
// arrive. Halfway through, a third client calls GET /api/slow?ms=300 (a busy loop).
//
//   node scripts/blocking-demo.ts
//
// The server runs in a child process, so the busy loop blocks IT, not this measuring script.

import { once } from "node:events";
import { WebSocket } from "ws";
import { PROTOCOL_VERSION, parseServerMessage } from "@dogfight/shared/protocol/control.ts";
import { startServerProcess, stopServerProcess, sendMessage } from "./spawn-server.ts";

const PORT = 8791;
const server = await startServerProcess(PORT, { DEBUG_ROUTES: "true", RATE_LIMIT_PER_SEC: "100" });

async function player(name: string): Promise<WebSocket> {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
  ws.on("error", (e) => console.error(name, e.message));
  await once(ws, "open");
  sendMessage(ws, { type: "join", v: PROTOCOL_VERSION, room: "r-104", name });
  return ws;
}

const a = await player("A");
const b = await player("B");
const t0 = performance.now();
const samples: Array<{ at: number; latency: number }> = [];
b.on("message", (data, isBinary) => {
  if (isBinary) return; // snapshots (Lab 5) — not what we measure
  const parsed = parseServerMessage(data);
  if (!parsed.ok || parsed.msg.type !== "chat") return;
  const sentAt = Number(parsed.msg.text);
  samples.push({ at: sentAt - t0, latency: performance.now() - sentAt });
});

let slowAt = Infinity;
const sender = setInterval(
  () => sendMessage(a, { type: "chat", text: String(performance.now()) }),
  50,
);
setTimeout(() => {
  slowAt = performance.now() - t0;
  void fetch(`http://127.0.0.1:${PORT}/api/slow?ms=300`)
    .then((res) => res.text())
    .then((body) => console.log(`GET /api/slow -> ${body} (sent at ${slowAt.toFixed(0)} ms)`));
}, 1000);
await new Promise((r) => setTimeout(r, 2000));
clearInterval(sender);
await new Promise((r) => setTimeout(r, 400));

const before = samples.filter((s) => s.at < slowAt - 50).map((s) => s.latency);
const worst = samples.reduce((m, s) => (s.latency > m.latency ? s : m), { at: 0, latency: 0 });
const median = (xs: number[]) => xs.sort((x, y) => x - y)[Math.floor(xs.length / 2)] ?? NaN;
console.log(`chat lines measured: ${samples.length}`);
console.log(`median latency before the slow request: ${median(before).toFixed(1)} ms`);
console.log(
  `worst latency: ${worst.latency.toFixed(0)} ms (line sent at ${worst.at.toFixed(0)} ms)`,
);
console.log("timeline (sent at -> latency):");
for (const s of samples.filter((s) => Math.abs(s.at - slowAt) < 400)) {
  console.log(
    `  ${s.at.toFixed(0).padStart(5)} ms -> ${s.latency.toFixed(0).padStart(4)} ms ${"█".repeat(Math.round(s.latency / 10))}`,
  );
}
a.close();
b.close();
await stopServerProcess(server);
