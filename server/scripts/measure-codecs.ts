// Lab 5, M4: JSON vs binary at 30 Hz with 4 players. For each codec: a fresh server, four bot
// clients join one room and send inputs every 1/30 s (thrust, turns, fire) for 10 s; we count
// the bytes each client receives and sends. Then encode+decode time on a real snapshot.
//
//   node scripts/measure-codecs.ts

import { once } from "node:events";
import { WebSocket, type RawData } from "ws";
import { binaryCodec } from "@dogfight/shared/codec/binary.ts";
import { jsonCodec } from "@dogfight/shared/codec/json.ts";
import type { Codec, CodecName } from "@dogfight/shared/codec/codec.ts";
import type { Snapshot } from "@dogfight/shared/protocol/messages.ts";
import { PROTOCOL_VERSION } from "@dogfight/shared/protocol/control.ts";
import { seq as toSeq, tick as toTick } from "@dogfight/shared/protocol/ids.ts";
import { startServerProcess, stopServerProcess, sendMessage } from "./spawn-server.ts";

const SECONDS = 10;
const PORT = 8792;

type Bot = {
  ws: WebSocket;
  down: number;
  up: number;
  snapshots: number;
  last: RawData | null;
  measuring: boolean;
};

const sizeOf = (data: RawData) =>
  Array.isArray(data) ? data.reduce((n, b) => n + b.length, 0) : data.byteLength;
const asBuffer = (data: RawData) =>
  Array.isArray(data) ? Buffer.concat(data) : Buffer.isBuffer(data) ? data : Buffer.from(data);

/** Both codecs behind one signature: what a bot needs to send an input and read a snapshot. */
const codecs = {
  json: {
    encodeInput: jsonCodec.encodeInput,
    decode: (data: RawData) => jsonCodec.decodeSnapshot(String(asBuffer(data))),
    bench: (snap: Snapshot) => jsonCodec.decodeSnapshot(jsonCodec.encodeSnapshot(snap)),
  },
  binary: {
    encodeInput: binaryCodec.encodeInput,
    decode: (data: RawData) => binaryCodec.decodeSnapshot(asBuffer(data)),
    bench: (snap: Snapshot) => binaryCodec.decodeSnapshot(binaryCodec.encodeSnapshot(snap)),
  },
} satisfies Record<
  CodecName,
  { encodeInput: Codec<unknown>["encodeInput"]; decode: unknown; bench: unknown }
>;

async function run(codecName: CodecName) {
  const codec = codecs[codecName];
  const server = await startServerProcess(PORT);

  const bots = await Promise.all(
    [0, 1, 2, 3].map(async (i) => {
      const query = codecName === "json" ? "?codec=json" : "";
      const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws${query}`);
      await once(ws, "open");
      const bot: Bot = { ws, down: 0, up: 0, snapshots: 0, last: null, measuring: false };
      ws.on("message", (data, isBinary) => {
        const isSnap = isBinary || String(data).startsWith('{"type":"snapshot"');
        if (!bot.measuring || !isSnap) return;
        bot.down += sizeOf(data);
        bot.snapshots++;
        bot.last = data;
      });
      sendMessage(ws, { type: "join", v: PROTOCOL_VERSION, room: "r-104", name: `Bot${i}` });
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
        seq: toSeq(seq),
        tick: toTick(seq),
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
  const sample = bots[0]?.last;
  if (!sample) throw new Error("no snapshot received");
  bots.forEach((b) => b.ws.close());
  await stopServerProcess(server);

  const avg = (f: (b: Bot) => number) => bots.reduce((s, b) => s + f(b), 0) / bots.length;
  return {
    codecName,
    bytesPerSnapshot: avg((b) => b.down / b.snapshots),
    downKBs: avg((b) => b.down / SECONDS / 1024),
    upKBs: avg((b) => b.up / SECONDS / 1024),
    snapshot: codec.decode(sample),
  };
}

function bench(roundTrip: (snap: Snapshot) => Snapshot, snap: Snapshot): number {
  const N = 20_000;
  for (let i = 0; i < 2000; i++) roundTrip(snap); // warm-up (JIT)
  const t0 = performance.now();
  for (let i = 0; i < N; i++) roundTrip(snap);
  return ((performance.now() - t0) * 1000) / N;
}

const results = [await run("json"), await run("binary")];
const snap = results[1]?.snapshot; // the same world content for both benchmarks
if (!snap) throw new Error("no binary run");
console.log(
  `snapshot used for timing: ${snap.entities.length} entities, ${snap.players.length} players`,
);
console.log(
  "| Codec | Bytes/snapshot | KB/s per client (down) | KB/s per client (up) | Encode+decode µs |",
);
console.log("|---|---|---|---|---|");
for (const r of results) {
  const us = bench(codecs[r.codecName].bench, snap);
  console.log(
    `| ${r.codecName === "json" ? "JSON" : "Binary (`DataView`)"} | ${r.bytesPerSnapshot.toFixed(0)} | ${r.downKBs.toFixed(1)} | ${r.upKBs.toFixed(2)} | ${us.toFixed(1)} |`,
  );
}
