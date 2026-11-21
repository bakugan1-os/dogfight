// Lab 8: production behaviour — origin check, per-IP cap, /ready, /metrics, config.

import { test, afterAll } from "vitest";
import assert from "node:assert/strict";
import { once } from "node:events";
import { WebSocket } from "ws";
import { loadConfig, ConfigError } from "../src/config.ts";
import { startServer, joined, cleanupTmp, until } from "./helpers.ts";

afterAll(cleanupTmp);

/** Opens a raw handshake and returns the HTTP status (101 = accepted). */
function handshake(url: string, headers: Record<string, string> = {}): Promise<number> {
  return new Promise((resolve) => {
    const ws = new WebSocket(url, { headers });
    ws.on("upgrade", (res) => {
      resolve(res.statusCode ?? 0);
      ws.close();
    });
    ws.on("unexpected-response", (_req, res) => {
      resolve(res.statusCode ?? 0);
      res.resume();
    });
    ws.on("error", () => {});
  });
}

test("config: ALLOWED_ORIGINS is a list of URLs (or *), LOG_LEVEL an enum", () => {
  const c = loadConfig({ ALLOWED_ORIGINS: "https://a.example, https://b.example/" });
  assert.deepEqual(c.allowedOrigins, ["https://a.example", "https://b.example"]);
  assert.deepEqual(loadConfig({}).allowedOrigins, []);
  assert.deepEqual(loadConfig({ ALLOWED_ORIGINS: "*" }).allowedOrigins, ["*"]);
  assert.throws(() => loadConfig({ ALLOWED_ORIGINS: "evil" }), ConfigError);
  assert.throws(() => loadConfig({ LOG_LEVEL: "loud" }), ConfigError);
  assert.equal(loadConfig({}).gitSha, "dev");
});

test("origin check: our own page and allowed origins pass, another site gets 403 (counted)", async ({
  onTestFinished,
}) => {
  const { game, ws, port } = await startServer({ ALLOWED_ORIGINS: "https://dogfight.example" });
  onTestFinished(() => game.stop());
  assert.equal(await handshake(ws), 101, "no Origin: not a browser");
  assert.equal(await handshake(ws, { origin: `http://127.0.0.1:${port}` }), 101, "same host");
  assert.equal(await handshake(ws, { origin: "https://dogfight.example" }), 101, "allowed");
  assert.equal(await handshake(ws, { origin: "https://evil.example" }), 403);
  assert.equal(await handshake(ws, { origin: "null" }), 403);
  assert.equal(game.sockets.counters.rejections.origin, 2);
});

test("per-IP cap: the (N+1)th connection from one address gets 429; X-Forwarded-For only with TRUST_PROXY", async ({
  onTestFinished,
}) => {
  const { game, ws } = await startServer({ MAX_CONNECTIONS_PER_IP: "2" });
  onTestFinished(() => game.stop());
  const a = await joined(ws, "r-101", "A");
  const b = await joined(ws, "r-101", "B");
  assert.equal(await handshake(ws), 429);
  // without TRUST_PROXY a forged header changes nothing
  assert.equal(await handshake(ws, { "x-forwarded-for": "203.0.113.9" }), 429);
  assert.equal(game.sockets.counters.rejections.per_ip, 2);
  a.ws.close();
  await a.closed;
  await until(() => game.sockets.perIp("127.0.0.1") === 1);
  assert.equal(await handshake(ws), 101, "a slot freed up");
  b.ws.close();

  const proxied = await startServer({ MAX_CONNECTIONS_PER_IP: "1", TRUST_PROXY: "true" });
  onTestFinished(() => proxied.game.stop());
  const first = await joined(proxied.ws, "r-101", "P1"); // no header: the socket address
  assert.equal(await handshake(proxied.ws, { "x-forwarded-for": "203.0.113.9, 10.0.0.1" }), 101);
  first.ws.close();
});

test("/ready turns 503 while shutting down; /health carries the version", async () => {
  const { game, base } = await startServer({ GIT_SHA: "abc1234" });
  const health: unknown = await (await fetch(`${base}/health`)).json();
  assert.ok(typeof health === "object" && health && "sha" in health && health.sha === "abc1234");
  assert.ok("version" in health && typeof health.version === "string");
  assert.equal((await fetch(`${base}/ready`)).status, 200);
  const c = await joined(base.replace("http", "ws") + "/ws", "r-101", "Ada");
  const stopping = game.stop();
  assert.equal(game.ready, false);
  assert.equal((await c.next("shutdown")).type, "shutdown");
  await stopping;
});

test("/metrics: Prometheus text with players, traffic, rejections and per-room tick histogram", async ({
  onTestFinished,
}) => {
  const { game, base, ws } = await startServer();
  onTestFinished(() => game.stop());
  const ada = await joined(ws, "r-101", "Ada");
  ada.send({ type: "chat", text: "hi" });
  await ada.next("chat");
  await until(() => ada.snapshots.length > 3); // a few ticks ran
  const bad = await joined(ws, "r-102", "Bad");
  bad.send("{not json");
  await bad.closed;

  const res = await fetch(`${base}/metrics`);
  assert.match(res.headers.get("content-type") ?? "", /text\/plain/);
  const text = await res.text();
  const value = (re: RegExp) => Number(text.match(re)?.[1] ?? NaN);
  assert.equal(value(/^dogfight_players (\d+)/m), 1);
  assert.ok(value(/^dogfight_ws_messages_total\{direction="in"\} (\d+)/m) >= 3);
  assert.ok(value(/^dogfight_ws_bytes_total\{direction="out"\} (\d+)/m) > 100);
  assert.equal(value(/^dogfight_ws_rejected_total\{reason="bad_json"\} (\d+)/m), 1);
  assert.ok(value(/^dogfight_tick_duration_seconds_count\{room="r-101"\} (\d+)/m) > 3);
  assert.match(text, /^dogfight_tick_p99_ms\{room="r-101"\} [\d.]+/m);
  assert.match(text, /^dogfight_event_loop_utilization [\d.]+/m);
  assert.match(text, /^process_resident_memory_bytes \d+/m);
  assert.match(text, /^dogfight_build_info\{version="[^"]+",sha="dev"\} 1/m);
  ada.ws.close();
  await once(ada.ws, "close");
});
