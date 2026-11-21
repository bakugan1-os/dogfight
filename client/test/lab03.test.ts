// Lab 3: fetch helpers, retry/backoff, concurrent loading with progress and cancellation,
// the lobby's polling + abort-on-leave, the event bus, and the ordering puzzles.

import { test } from "vitest";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";

import { HttpError, fetchOk, fetchJson, withRetry, isTransient, sleep } from "../src/net/http.ts";
import { parseFault, createFaultFetch } from "../src/net/faults.ts";
import { loadAll, planItems, AssetError, type Loaders } from "../src/assets/loader.ts";
import { Lobby, validateRooms } from "../src/lobby/lobby.ts";
import type { RoomSummary } from "@dogfight/shared/protocol/control.ts";
import { validateArenas } from "../src/arenas.ts";
import { World } from "@dogfight/shared/sim/world.ts";
import { Asteroid } from "@dogfight/shared/sim/asteroid.ts";
import { Bullet } from "@dogfight/shared/sim/bullet.ts";
import { Vector2 } from "@dogfight/shared/sim/vector.ts";
import { NO_CONTROLS } from "@dogfight/shared/sim/ship.ts";
import { PUZZLES, runPuzzle } from "../src/puzzles/puzzles.ts";
import { Bus } from "@dogfight/shared/sim/bus.ts";
import type { WorldEvents } from "@dogfight/shared/sim/world.ts";
import { playerId } from "@dogfight/shared/protocol/ids.ts";

type Route = { status?: number; body?: string; delay?: number; network?: boolean };
type FetchLog = Array<{ url: string; signal: AbortSignal | null | undefined }>;

/** A fake fetch: answers by URL after `delay` ms, and honours the abort signal like the real one. */
function fakeFetch(routes: Record<string, Route>, log: FetchLog = []): typeof fetch {
  return (url, { signal } = {}) =>
    new Promise((resolve, reject) => {
      const route = routes[String(url)] ?? { status: 404 };
      log.push({ url: String(url), signal });
      if (signal?.aborted) return reject(signal.reason);
      const timer = setTimeout(() => {
        if (route.network) return reject(new TypeError("fetch failed"));
        resolve(new Response(route.body ?? null, { status: route.status ?? 200 }));
      }, route.delay ?? 0);
      signal?.addEventListener("abort", () => {
        clearTimeout(timer);
        reject(signal.reason);
      });
    });
}

const json = (value: unknown, extra: Route = {}): Route => ({
  body: JSON.stringify(value),
  ...extra,
});
const nameOf = (e: unknown) => (e instanceof Error || e instanceof DOMException ? e.name : "");

// ---- fetch & retry ---------------------------------------------------------------------------

test("fetchJson: a 404 FULFILLS fetch, so we must check ok ourselves", async () => {
  const fetch = fakeFetch({ "/a": json({ x: 1 }), "/bad": { body: "{ nope" } });
  assert.deepEqual(await fetchJson("/a", { fetch }), { x: 1 });
  await assert.rejects(
    fetchJson("/missing", { fetch }),
    (e) => e instanceof HttpError && e.status === 404,
  );
  await assert.rejects(
    fetchJson("/bad", { fetch }),
    (e) => e instanceof SyntaxError && /\/bad/.test(e.message),
  );
});

test("isTransient: retry network/timeout/5xx, never 4xx, aborts or bad JSON", () => {
  assert.equal(isTransient(new TypeError("fetch failed")), true);
  assert.equal(isTransient(new DOMException("t", "TimeoutError")), true);
  assert.equal(isTransient(new HttpError(503, "/x")), true);
  assert.equal(isTransient(new HttpError(404, "/x")), false);
  assert.equal(isTransient(new HttpError(429, "/x")), false);
  assert.equal(isTransient(new DOMException("a", "AbortError")), false);
  assert.equal(isTransient(new SyntaxError("json")), false);
});

test("withRetry: 503, 503, OK -> 3 calls; backoff grows and stays within the jitter cap", async () => {
  let calls = 0;
  const delays: number[] = [];
  const value = await withRetry(
    async () => {
      calls++;
      if (calls < 3) throw new HttpError(503, "/x");
      return "ok";
    },
    {
      attempts: 5,
      baseMs: 100,
      random: () => 0.999,
      wait: async () => {},
      onRetry: ({ delay }) => delays.push(delay),
    },
  );
  assert.equal(value, "ok");
  assert.equal(calls, 3);
  assert.deepEqual(delays, [100, 200]); // random ~1 -> the cap: base * 2^(n-1)
  const jittered: number[] = [];
  await withRetry(
    async () => {
      throw new HttpError(500, "/x");
    },
    {
      attempts: 4,
      baseMs: 100,
      wait: async () => {},
      onRetry: ({ delay }) => jittered.push(delay),
    },
  ).catch(() => {});
  jittered.forEach((d, i) => assert.ok(d >= 0 && d <= 100 * 2 ** i, `delay ${d} within cap`));
});

test("withRetry: a 404 is not retried; an abort during backoff stops at once", async () => {
  let calls = 0;
  await assert.rejects(
    withRetry(async () => {
      calls++;
      throw new HttpError(404, "/x");
    }),
    HttpError,
  );
  assert.equal(calls, 1);

  const controller = new AbortController();
  const t0 = performance.now();
  const pending = withRetry(
    async () => {
      throw new TypeError("network");
    },
    { attempts: 5, baseMs: 10_000, random: () => 1, signal: controller.signal },
  );
  setTimeout(() => controller.abort(), 20);
  await assert.rejects(pending, (e) => nameOf(e) === "AbortError");
  assert.ok(performance.now() - t0 < 1000, "did not sit out the 10 s backoff");
});

test("sleep: resolves after the delay, rejects with the signal's reason on abort", async () => {
  await sleep(5);
  await assert.rejects(sleep(10, AbortSignal.abort()), (e) => nameOf(e) === "AbortError");
});

// ---- loadAll ---------------------------------------------------------------------------------

const MANIFEST = {
  sprites: { ships: { url: "s.png", optional: true } },
  sounds: { boom: { url: "b.wav", optional: true } },
  data: { arenas: { url: "a.json" } },
};
const BASE = "http://test/assets/manifest.json";

/** Loaders that just "download" via fetch and return the URL — no Image/AudioContext in Node. */
const fetchLoaders: Loaders<string, string> = {
  image: async (url, options) => (await fetchOk(url, options), `img:${url}`),
  audio: async (url, options) => (await fetchOk(url, options), `snd:${url}`),
  json: (url, options) => fetchJson(url, options),
};

test("planItems: resolves URLs against the manifest's URL", () => {
  const items = planItems(MANIFEST, BASE);
  assert.deepEqual(
    items.map((i) => [i.key, i.url, i.optional]),
    [
      ["sprites.ships", "http://test/assets/s.png", true],
      ["sounds.boom", "http://test/assets/b.wav", true],
      ["data.arenas", "http://test/assets/a.json", false],
    ],
  );
});

test("loadAll: starts every request at once; total time ~ the slowest, not the sum", async () => {
  const log: FetchLog = [];
  const fetch = fakeFetch(
    {
      "http://test/assets/s.png": { delay: 60 },
      "http://test/assets/b.wav": { delay: 60 },
      "http://test/assets/a.json": json({ classic: {} }, { delay: 60 }),
    },
    log,
  );
  const items = planItems(MANIFEST, BASE);
  const progress: number[] = [];
  const options = {
    fetch,
    loaders: fetchLoaders,
    onProgress: (p: number) => void progress.push(p),
  };

  const concurrent = await loadAll(items, options);
  assert.equal(log.length, 3);
  assert.deepEqual(progress, [1 / 3, 2 / 3, 1]);
  assert.deepEqual(concurrent.data.arenas, { classic: {} });
  assert.equal(concurrent.sounds.boom, "snd:http://test/assets/b.wav");

  const sequential = await loadAll(items, { ...options, sequential: true });
  assert.ok(concurrent.ms < 150, `concurrent ${concurrent.ms.toFixed(0)} ms`);
  assert.ok(sequential.ms >= 170, `sequential ${sequential.ms.toFixed(0)} ms`);
});

test("loadAll: an optional 404 is skipped; the rest still loads", async () => {
  const fetch = fakeFetch({
    "http://test/assets/b.wav": {},
    "http://test/assets/a.json": json({}),
  });
  const result = await loadAll(planItems(MANIFEST, BASE), {
    fetch,
    loaders: fetchLoaders,
  });
  assert.equal(result.sprites.ships, undefined);
  assert.equal(result.failures.length, 1);
  const [failure] = result.failures;
  assert.equal(failure?.item.key, "sprites.ships");
  assert.ok(failure.error instanceof HttpError && failure.error.status === 404);
});

test("loadAll: a required failure rejects at once AND aborts the requests still running", async () => {
  const log: FetchLog = [];
  const fetch = fakeFetch(
    {
      "http://test/assets/s.png": { delay: 500 },
      "http://test/assets/b.wav": { delay: 500 },
      "http://test/assets/a.json": { body: "{ broken" },
    },
    log,
  );
  const statuses = new Map<string, string>();
  const t0 = performance.now();
  await assert.rejects(
    loadAll(planItems(MANIFEST, BASE), {
      fetch,
      loaders: fetchLoaders,
      onItem: (item, status) => void statuses.set(item.key, status),
    }),
    // Lab 6: the failed item travels in a typed AssetError; the original error is its `cause`.
    (e) =>
      e instanceof AssetError && e.cause instanceof SyntaxError && e.item.key === "data.arenas",
  );
  assert.ok(performance.now() - t0 < 200, "did not wait for the slow ones");
  await sleep(10);
  assert.ok(
    log
      .filter((r) => r.url.endsWith(".png") || r.url.endsWith(".wav"))
      .every((r) => r.signal?.aborted),
  );
  assert.equal(statuses.get("sprites.ships"), "cancelled");
  assert.equal(statuses.get("data.arenas"), "failed");
});

test("loadAll: the caller's abort cancels everything with AbortError", async () => {
  const fetch = fakeFetch({
    "http://test/assets/s.png": { delay: 300 },
    "http://test/assets/b.wav": { delay: 300 },
    "http://test/assets/a.json": json({}, { delay: 300 }),
  });
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 20);
  await assert.rejects(
    loadAll(planItems(MANIFEST, BASE), {
      fetch,
      loaders: fetchLoaders,
      signal: controller.signal,
    }),
    (e) => nameOf(e) === "AbortError",
  );
});

test("loadAll: a hung request times out and is retried, then the optional item is skipped", async () => {
  const log: FetchLog = [];
  const fetch = fakeFetch(
    {
      "http://test/assets/s.png": { delay: 10_000 },
      "http://test/assets/b.wav": {},
      "http://test/assets/a.json": json({}),
    },
    log,
  );
  const result = await loadAll(planItems(MANIFEST, BASE), {
    fetch,
    loaders: fetchLoaders,
    timeoutMs: 40,
    attempts: 2,
    baseMs: 1,
  });
  assert.equal(log.filter((r) => r.url.endsWith("s.png")).length, 2, "two attempts");
  assert.equal(nameOf(result.failures[0]?.error), "TimeoutError");
});

// ---- fault injection -------------------------------------------------------------------------

test("faults: URL scheme and the in-page fault fetch", async () => {
  assert.deepEqual(parseFault("/base/assets/__fault/delay/500/sprites/a.png"), {
    kind: "delay",
    arg: 500,
    base: "/base/assets/",
    rest: "sprites/a.png",
  });
  assert.equal(parseFault("/assets/a.png"), null);
  const real: typeof fetch = async (url) => new Response(`real:${new URL(String(url)).pathname}`);
  const f = createFaultFetch(real);
  const statuses: number[] = [];
  for (let i = 0; i < 3; i++) statuses.push((await f("http://h/x/__fault/flaky/2/a.txt")).status);
  assert.deepEqual(statuses, [503, 503, 200]);
  assert.equal((await f("http://h/__fault/status/404/a.txt")).status, 404);
  assert.equal(await (await f("http://h/x/__fault/delay/1/a.txt")).text(), "real:/x/a.txt");
  await assert.rejects(
    f("http://h/__fault/delay/5000/a.txt", { signal: AbortSignal.timeout(20) }),
    (e) => nameOf(e) === "TimeoutError",
  );
});

// ---- lobby -----------------------------------------------------------------------------------

const ROOM: RoomSummary = {
  id: "r1",
  name: "A",
  arena: "classic",
  mode: "duel",
  players: 0,
  maxPlayers: 2,
  host: "—",
};
const ROOMS = { rooms: [ROOM] };

/** Records every event of the given types from a typed bus, as [type, payload] pairs. */
function collect<E extends object, K extends keyof E>(
  bus: Bus<E>,
  types: readonly K[],
): Array<[K, E[K]]> {
  const events: Array<[K, E[K]]> = [];
  for (const type of types) bus.on(type, (payload) => events.push([type, payload]));
  return events;
}

test("Lobby: refresh dispatches rooms; a slow server becomes a TimeoutError event", async () => {
  const lobby = new Lobby({ url: "/rooms", fetch: fakeFetch({ "/rooms": json(ROOMS) }) });
  const events = collect(lobby, ["loading", "rooms", "error"]);
  await lobby.refresh();
  assert.deepEqual(
    events.map(([t]) => t),
    ["loading", "rooms"],
  );
  assert.equal(lobby.rooms[0]?.id, "r1");

  const slow = new Lobby({
    url: "/rooms",
    fetch: fakeFetch({ "/rooms": json(ROOMS, { delay: 500 }) }),
    timeoutMs: 30,
  });
  const slowEvents = collect(slow, ["error"]);
  await slow.refresh();
  assert.equal(nameOf(slowEvents[0]?.[1].error), "TimeoutError");
});

test("Lobby: polling repeats; stop() aborts the in-flight request and reports no error", async () => {
  const log: FetchLog = [];
  const lobby = new Lobby({
    url: "/rooms",
    fetch: fakeFetch({ "/rooms": json(ROOMS, { delay: 30 }) }, log),
    intervalMs: 10,
  });
  const events = collect(lobby, ["rooms", "error", "stopped"]);
  lobby.start();
  await sleep(120);
  const before = log.length;
  assert.ok(before >= 2, `polled ${before} times`);
  lobby.stop();
  await sleep(80);
  assert.equal(log.length, before, "no new requests after stop()");
  assert.ok(log.at(-1)?.signal?.aborted, "the in-flight request was aborted");
  assert.ok(!events.some(([t]) => t === "error"), "leaving is not an error");
  assert.equal(events.at(-1)?.[0], "stopped");
});

test("Lobby: join stops polling and announces the room; full rooms are refused", async () => {
  const lobby = new Lobby({
    url: "/rooms",
    fetch: fakeFetch({ "/rooms": json(ROOMS) }),
    intervalMs: 5,
  });
  const events = collect(lobby, ["join"]);
  lobby.start();
  await sleep(20);
  lobby.join("r1", "  Ада  ");
  assert.equal(lobby.running, false);
  assert.deepEqual(events[0]?.[1].name, "Ада");
  lobby.rooms = [{ ...ROOM, players: 2 }];
  assert.throws(() => lobby.join("r1", "x"), /full/);
  assert.throws(() => validateRooms({ nope: 1 }));
  assert.equal(validateRooms({ rooms: [{ id: 1 }, ROOM] }).length, 1);
});

test("validateArenas: keeps well-formed entries, rejects garbage", () => {
  const ok = { name: "A", asteroids: 3, seekerChance: 0, pickupEvery: 5 };
  assert.deepEqual(Object.keys(validateArenas({ a: ok, b: { name: "B" } })), ["a"]);
  assert.throws(() => validateArenas([]));
});

// ---- event bus -------------------------------------------------------------------------------

test("World dispatches fired / hit / exploded / scored on its event bus", () => {
  const bus = new Bus<WorldEvents>();
  const events = collect(bus, ["fired", "hit", "exploded", "scored"]);
  const world = new World({ asteroids: 0, pickupEvery: 1e9, events: bus });
  const P1 = playerId(1);
  world.addPlayer({ id: P1, color: "#fff" });
  world.step(1 / 60, new Map([[P1, { ...NO_CONTROLS, fire: true }]]));
  const [first] = events;
  assert.ok(first?.[0] === "fired");
  assert.deepEqual(first[1], { playerId: 1, x: first[1].x, y: first[1].y });

  const asteroid = world.spawn(
    new Asteroid({ pos: new Vector2(100, 100), size: "small", rng: world.rng }),
  );
  for (let i = 0; i < 3; i++) {
    world.spawn(
      new Bullet({ pos: new Vector2(100, 100), vel: new Vector2(), ownerId: P1, damage: 10 }),
    );
    world.step(1 / 60, new Map());
  }
  assert.equal(asteroid.alive, false);
  const types = events.map(([t]) => t);
  assert.ok(
    types.includes("hit") && types.includes("exploded") && types.includes("scored"),
    types.join(),
  );
  // A type-guard callback narrows the [type, payload] pair, so `scored[1].points` is typed.
  const scored = events.find((ev): ev is ["scored", WorldEvents["scored"]] => ev[0] === "scored");
  assert.equal(scored?.[1].points, 10);
});

test("the simulation never imports audio or HUD code", () => {
  const dir = new URL("../../shared/sim/", import.meta.url);
  for (const file of readdirSync(dir)) {
    const source = readFileSync(new URL(file, dir), "utf8");
    const imports = [...source.matchAll(/from\s+["']([^"']+)["']/g)].map((m) => m[1] ?? "");
    for (const path of imports) {
      // its own folder, or the shared protocol types (ids, messages) — nothing from the client
      assert.ok(
        path.startsWith("./") || path.startsWith("../protocol/"),
        `${file} imports ${path}`,
      );
      assert.doesNotMatch(path, /audio|hud|client/, `${file} imports ${path}`);
    }
  }
});

// ---- ordering puzzles ------------------------------------------------------------------------

for (const puzzle of PUZZLES.filter((p) => !p.browserOnly)) {
  test(`ordering puzzle ${puzzle.id}: ${puzzle.title}`, async () => {
    assert.deepEqual(await runPuzzle(puzzle), puzzle.expected);
  });
}
