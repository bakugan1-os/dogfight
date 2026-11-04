// Generates a large synthetic match log for the backpressure experiment (Lab 4, M3).
//   node scripts/make-big-log.js [megabytes=200] [id=big-synthetic]
// The generator itself is backpressure-safe: pipeline() pulls from it only as fast as the
// disk accepts, so writing 200 MB uses a few MB of memory.

import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { loadConfig } from "../src/config.js";
import { NdjsonEncoder } from "../src/log/matchlog.js";

const megabytes = Number(process.argv[2] ?? 200);
const id = process.argv[3] ?? "big-synthetic";
const { logDir } = loadConfig(process.env);
await mkdir(logDir, { recursive: true });

function* events(targetBytes) {
  let bytes = 0;
  let t = Date.parse("2026-11-04T12:00:00Z");
  for (let i = 0; bytes < targetBytes; i++) {
    t += 16;
    const event = {
      t,
      room: "r-big",
      type: "chat",
      player: { id: `p${i % 8}`, name: `Pilot ${i % 8}` },
      text: `synthetic message ${i} `.padEnd(120, "·"),
    };
    bytes += Buffer.byteLength(JSON.stringify(event)) + 1;
    yield event;
  }
}

const file = join(logDir, `${id}.ndjson`);
const t0 = performance.now();
await pipeline(
  Readable.from(events(megabytes * 2 ** 20)),
  new NdjsonEncoder(),
  createWriteStream(file),
);
const rss = process.memoryUsage().rss / 2 ** 20;
console.log(
  `${file}: ${megabytes} MB in ${((performance.now() - t0) / 1000).toFixed(1)} s, rss ${rss.toFixed(0)} MB`,
);
