// Lab 7: the heartbeat under fake timers — minutes of pings in microseconds, deterministic.

import { test, expect, vi, afterEach } from "vitest";
import { startHeartbeat, heartbeatRound, type HeartbeatClient } from "../src/heartbeat.ts";

afterEach(() => vi.useRealTimers());

function client(answers: boolean): HeartbeatClient & { pings: number; terminated: boolean } {
  const c = {
    missedPongs: 0,
    pings: 0,
    terminated: false,
    ping() {
      c.pings++;
      if (answers) queueMicrotask(() => (c.missedPongs = 0)); // the "pong" arrives
    },
    terminate() {
      c.terminated = true;
    },
  };
  return c;
}

test("a silent client is terminated on the 3rd round (two missed pongs), an answering one never", async () => {
  vi.useFakeTimers();
  const alive = client(true);
  const dead = client(false);
  let live = [alive, dead];
  let terminated = 0;
  const stop = startHeartbeat(
    15_000,
    () => live,
    (n) => (terminated += n),
  );

  await vi.advanceTimersByTimeAsync(15_000 * 2);
  expect(dead.terminated).toBe(false); // two rounds = two missed pongs, not terminated yet
  await vi.advanceTimersByTimeAsync(15_000);
  expect(dead.terminated).toBe(true);
  expect(terminated).toBe(1);
  live = live.filter((c) => !c.terminated);

  await vi.advanceTimersByTimeAsync(15_000 * 100); // 25 minutes of heartbeats, instantly
  expect(alive.terminated).toBe(false);
  expect(alive.pings).toBe(103);
  stop();
});

test("heartbeatRound pings exactly once per round and counts the terminated", () => {
  const cs = [client(false), client(false)];
  expect(heartbeatRound(cs)).toBe(0);
  expect(heartbeatRound(cs)).toBe(0);
  expect(heartbeatRound(cs)).toBe(2);
  expect(cs.map((c) => c.pings)).toEqual([2, 2]);
});
