// Lab 7, M3 (server): a 60-second match under `node --cpu-prof`, with N bots in one room
// (default 32 — the human 8 would barely register). Prints the tick-time p50/p99 from
// /api/stats and the top self-time functions of the CPU profile.
//
//   node server/scripts/profile-server.ts before [bots=32] [seconds=60]
//   -> docs/perf/server-before.json, docs/perf/server-before.cpuprofile

import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

const label = process.argv[2] ?? "run";
const BOTS = Number(process.argv[3] ?? 32);
const SECONDS = Number(process.argv[4] ?? 60);
const PORT = 8793;
const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const base = `http://127.0.0.1:${PORT}`;
const profDir = await mkdtemp(join(tmpdir(), "dogfight-prof-"));

const server = spawn(
  process.execPath,
  ["--cpu-prof", `--cpu-prof-dir=${profDir}`, "server/src/index.ts"],
  {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(PORT),
      QUIET: "true",
      MAX_PLAYERS_PER_ROOM: "255",
      ...(process.env.EXTRA_ENV
        ? (JSON.parse(process.env.EXTRA_ENV) as Record<string, string>)
        : {}),
    },
    stdio: ["ignore", "pipe", "inherit"],
  },
);
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
const { room } = z.object({ room: z.object({ id: z.string() }) }).parse(
  await post("/api/rooms", {
    name: "Server profile",
    arena: "belt",
    mode: "duel",
    maxPlayers: BOTS,
  }),
);
let left = BOTS;
while (left > 0) {
  const n = Math.min(64, left);
  await post(`/api/rooms/${room.id}/bots`, { count: n });
  left -= n;
}
await new Promise((r) => setTimeout(r, SECONDS * 1000));
const Stats = z.object({
  elu: z.number(),
  rssMB: z.number(),
  matches: z.array(
    z.object({
      entities: z.number(),
      tickMs: z.object({ p50: z.number(), p99: z.number(), max: z.number() }),
    }),
  ),
});
const stats = Stats.parse(await (await fetch(`${base}/api/stats`)).json());
server.kill("SIGINT"); // --cpu-prof writes the profile on a clean exit
await once(server, "exit");

const file = (await readdir(profDir)).find((f) => f.endsWith(".cpuprofile"));
if (!file) throw new Error("no .cpuprofile written");
const text = await readFile(join(profDir, file), "utf8");
await writeFile(`${ROOT}docs/perf/server-${label}.cpuprofile`, text);
await rm(profDir, { recursive: true, force: true });

const Profile = z.object({
  nodes: z.array(
    z.object({
      id: z.number(),
      callFrame: z.object({ functionName: z.string(), url: z.string(), lineNumber: z.number() }),
    }),
  ),
  samples: z.array(z.number()),
  timeDeltas: z.array(z.number()),
});
const profile = Profile.parse(JSON.parse(text));
const time = new Map<number, number>();
profile.samples.forEach((id, i) =>
  time.set(id, (time.get(id) ?? 0) + (profile.timeDeltas[i] ?? 0)),
);
const self = new Map<string, number>();
let busy = 0;
for (const n of profile.nodes) {
  const f = n.callFrame;
  const name = `${f.functionName || "(anonymous)"} ${f.url.replace(/^.*\/dogfight\//, "")}:${f.lineNumber + 1}`;
  const t = time.get(n.id) ?? 0;
  if (f.functionName === "(idle)" || f.functionName === "(program)" || f.functionName === "(root)")
    continue;
  busy += t;
  self.set(name, (self.get(name) ?? 0) + t);
}
const match = stats.matches[0];
const result = {
  label,
  bots: BOTS,
  seconds: SECONDS,
  entities: match?.entities,
  tickMs: match?.tickMs,
  elu: stats.elu,
  rssMB: stats.rssMB,
  busyMs: busy / 1000,
  selfTime: [...self]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([fn, us]) => ({ fn, ms: us / 1000, pct: (100 * us) / busy })),
};
await writeFile(`${ROOT}docs/perf/server-${label}.json`, JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
