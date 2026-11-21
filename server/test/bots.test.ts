// Lab 7: server-side bots go through the same input path as humans.

import { test, expect, afterAll } from "vitest";
import { Match } from "../src/match.ts";
import { Bot } from "../src/bot.ts";
import { Room } from "../src/rooms.ts";
import { startServer, joined, cleanupTmp } from "./helpers.ts";
import * as binary from "@dogfight/shared/codec/binary.ts";

afterAll(cleanupTmp);

test("bots fly, turn and shoot: after 10 s of simulated play they have fired and moved", () => {
  const match = new Match(new Room({ id: "r", name: "R", arena: "classic", maxPlayers: 8 }), {
    seed: 3,
  });
  let fired = 0;
  match.world.events.on("fired", () => fired++);
  for (let i = 0; i < 4; i++) match.addBot(`bot-${i}`, `B${i}`, new Bot(i + 1));
  const start = [...match.world.ofKind("ship")].map((s) => s.pos.clone());
  for (let t = 0; t < 300; t++) match.step();
  expect(match.bots).toBe(4);
  expect(fired).toBeGreaterThan(20);
  const moved = [...match.world.ofKind("ship")].filter((s, i) => {
    const p = start[i];
    return p && Math.hypot(s.pos.x - p.x, s.pos.y - p.y) > 50;
  });
  expect(moved.length).toBeGreaterThan(0);
  match.stop();
});

test("POST /api/rooms/:id/bots adds bots to the roster; they leave with the last human", async ({
  onTestFinished,
}) => {
  const { game, base, ws } = await startServer();
  onTestFinished(() => game.stop());
  const human = await joined(ws, "r-104", "Ada");
  const res = await fetch(`${base}/api/rooms/r-104/bots`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ count: 3 }),
  });
  expect(await res.json()).toEqual({ added: 3 });
  let roster = await human.next("roster");
  while (roster.players.length < 4) roster = await human.next("roster");
  expect(roster.players.map((p) => p.name)).toEqual(["Ada", "Бот 1", "Бот 2", "Бот 3"]);
  await new Promise((r) => setTimeout(r, 300));
  const frame = human.snapshots.at(-1);
  expect(frame && binary.decodeSnapshot(frame).players).toHaveLength(4);
  const bad = await fetch(`${base}/api/rooms/r-104/bots`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ count: 999 }),
  });
  expect(bad.status).toBe(400);

  human.ws.close();
  await new Promise((r) => setTimeout(r, 200));
  expect(game.rooms.get("r-104")?.size).toBe(0);
  expect(game.sockets.matchStats()).toHaveLength(0); // the match stopped: bots don't keep it alive
});
