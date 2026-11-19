// Lab 5, M4: JSON vs binary at 30 Hz with 4 players. For each codec: a fresh server, four bot
// clients join one room and send inputs every 1/30 s (thrust, turns, fire) for 10 s; we count
// the bytes each client receives and sends. Then encode+decode time on a real snapshot.
//
//   node scripts/measure-codecs.js

import { spawn } from "node:child_process";
import { once } from "node:events";
import { WebSocket } from "ws";
import * as binary from "@dogfight/shared/codec/binary.js";
import * as json from "@dogfight/shared/codec/json.js";

const SECONDS = 10;
const PORT = 8792;

async function run(codecName) {
  const codec = codecName === "json" ? json : binary;
  const server = spawn(process.execPath, ["src/index.js"], {
    cwd: new URL("..", import.meta.url),
    env: { ...process.env, PORT: String(PORT), QUIET: "true" },
    stdio: ["ignore", "pipe", "inherit"],
  });
  let banner = "";
  server.stdout.on("data", (d) => (banner += d));
  while (!banner.includes("dogfight server on")) await new Promise((r) => setTimeout(r, 30));

  const bots = await Promise.all(
    [0, 1, 2, 3].map(async (i) => {
      const query = codecName === "json" ? "?codec=json" : "";
      const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws${query}`);
      await once(ws, "open");
      const bot = { ws, down: 0, up: 0, snapshots: 0, last: null, measuring: false };
      ws.on("message", (data, isBinary) => {
        const isSnap = isBinary || String(data).startsWith('{"type":"snapshot"');
        if (!bot.measuring || !isSnap) return;
        bot.down += data.length;
        bot.snapshots++;
        bot.last = data;
      });
      ws.send(JSON.stringify({ type: "join", v: 2, room: "r-104", name: `Bot${i}` }));
      return bot;
    }),
  );
  await new Promise((r) => setTimeout(r, 500));
  let seq = 0;
  bots.forEach((b) => (b.measuring = true));
  const timer = setInterval(() => {
    seq++;
    bots.forEach((b, i) => {
      const t = (seq + i * 13) % 60;
      const frame = codec.encodeInput({
        seq,
        tick: seq,
        thrust: t < 40,
        left: t > 45,
        right: i % 2 === 0 && t < 10,
        fire: t % 6 === 0,
        firePressed: false,
      });
      b.ws.send(frame);
      b.up += typeof frame === "string" ? Buffer.byteLength(frame) : frame.byteLength;
    });
  }, 1000 / 30);
  await new Promise((r) => setTimeout(r, SECONDS * 1000));
  clearInterval(timer);
  bots.forEach((b) => (b.measuring = false));
  const sample = bots[0].last;
  bots.forEach((b) => b.ws.close());
  server.kill("SIGTERM");
  await once(server, "exit");

  const avg = (f) => bots.reduce((s, b) => s + f(b), 0) / bots.length;
  return {
    codecName,
    bytesPerSnapshot: avg((b) => b.down / b.snapshots),
    downKBs: avg((b) => b.down / SECONDS / 1024),
    upKBs: avg((b) => b.up / SECONDS / 1024),
    snapshot:
      codecName === "json" ? json.decodeSnapshot(String(sample)) : binary.decodeSnapshot(sample),
  };
}

function bench(codec, snap) {
  const N = 20_000;
  for (let i = 0; i < 2000; i++) codec.decodeSnapshot(codec.encodeSnapshot(snap)); // warm-up (JIT)
  const t0 = performance.now();
  for (let i = 0; i < N; i++) codec.decodeSnapshot(codec.encodeSnapshot(snap));
  return ((performance.now() - t0) * 1000) / N;
}

const results = [await run("json"), await run("binary")];
const snap = results[1].snapshot; // the same world content for both benchmarks
console.log(
  `snapshot used for timing: ${snap.entities.length} entities, ${snap.players.length} players`,
);
console.log(
  "| Codec | Bytes/snapshot | KB/s per client (down) | KB/s per client (up) | Encode+decode µs |",
);
console.log("|---|---|---|---|---|");
for (const r of results) {
  const us = bench(r.codecName === "json" ? json : binary, snap);
  console.log(
    `| ${r.codecName === "json" ? "JSON" : "Binary (`DataView`)"} | ${r.bytesPerSnapshot.toFixed(0)} | ${r.downKBs.toFixed(1)} | ${r.upKBs.toFixed(2)} | ${us.toFixed(1)} |`,
  );
}
