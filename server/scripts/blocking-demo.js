// M4: what a 300 ms synchronous handler does to EVERYONE on the server.
// Two players chat in a room: A sends a line every 50 ms, B measures how long each takes to
// arrive. Halfway through, a third client calls GET /api/slow?ms=300 (a busy loop).
//
//   node scripts/blocking-demo.js
//
// The server runs in a child process, so the busy loop blocks IT, not this measuring script.

import { spawn } from "node:child_process";
import { once } from "node:events";
import { WebSocket } from "ws";

const PORT = 8791;
const server = spawn(process.execPath, ["src/index.js"], {
  cwd: new URL("..", import.meta.url),
  env: {
    ...process.env,
    PORT: String(PORT),
    DEBUG_ROUTES: "true",
    QUIET: "true",
    RATE_LIMIT_PER_SEC: "100",
  },
  stdio: ["ignore", "pipe", "inherit"],
});
let banner = "";
server.stdout.on("data", (d) => (banner += d));
while (!banner.includes("dogfight server on")) await new Promise((r) => setTimeout(r, 50));

async function player(name) {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
  ws.on("error", (e) => console.error(name, e.message));
  await once(ws, "open");
  ws.send(JSON.stringify({ type: "join", v: 1, room: "r-104", name }));
  return ws;
}

const a = await player("A");
const b = await player("B");
const t0 = performance.now();
const samples = [];
b.on("message", (data) => {
  const msg = JSON.parse(String(data));
  if (msg.type !== "chat") return;
  const sentAt = Number(msg.text);
  samples.push({ at: sentAt - t0, latency: performance.now() - sentAt });
});

let slowAt = null;
const sender = setInterval(
  () => a.send(JSON.stringify({ type: "chat", text: String(performance.now()) })),
  50,
);
setTimeout(async () => {
  slowAt = performance.now() - t0;
  const res = await fetch(`http://127.0.0.1:${PORT}/api/slow?ms=300`);
  console.log(
    `GET /api/slow -> ${JSON.stringify(await res.json())} (sent at ${slowAt.toFixed(0)} ms)`,
  );
}, 1000);
await new Promise((r) => setTimeout(r, 2000));
clearInterval(sender);
await new Promise((r) => setTimeout(r, 400));

const before = samples.filter((s) => s.at < slowAt - 50).map((s) => s.latency);
const worst = samples.reduce((m, s) => (s.latency > m.latency ? s : m));
const median = (xs) => xs.sort((x, y) => x - y)[Math.floor(xs.length / 2)];
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
server.kill("SIGTERM");
await once(server, "exit");
