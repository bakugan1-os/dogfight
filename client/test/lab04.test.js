// Lab 4 (client side): the Connection wrapper — dispatch by type, send queue while connecting,
// reconnect with backoff, no reconnect after a deliberate or "you did it wrong" close.

import { test } from "node:test";
import assert from "node:assert/strict";
import { Connection, socketUrl } from "../src/net/connection.js";

/** A scriptable stand-in for the browser's WebSocket. */
class FakeSocket {
  static instances = [];
  constructor(url) {
    this.url = url;
    this.readyState = 0; // CONNECTING
    this.sent = [];
    FakeSocket.instances.push(this);
  }
  send(text) {
    this.sent.push(JSON.parse(text));
  }
  close(code = 1000, reason = "") {
    this.serverClose(code, reason);
  }
  // ---- test controls
  serverOpen() {
    this.readyState = 1;
    this.onopen?.();
  }
  serverSend(msg) {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }
  serverClose(code, reason = "") {
    this.readyState = 3;
    this.onclose?.({ code, reason });
  }
}

function setup(options = {}) {
  FakeSocket.instances = [];
  const timers = [];
  const conn = new Connection("ws://test/ws", {
    WebSocketImpl: FakeSocket,
    random: () => 1, // jitter at its cap: delays are deterministic
    setTimer: (fn, ms) => timers.push({ fn, ms }),
    clearTimer: () => {},
    ...options,
  });
  const statuses = [];
  conn.on("status", (s) => statuses.push(s.state));
  return { conn, timers, statuses, socket: () => FakeSocket.instances.at(-1) };
}

test("Connection: messages are dispatched by their type", () => {
  const { conn, socket } = setup();
  conn.open();
  socket().serverOpen();
  const chats = [];
  conn.on("chat", (m) => chats.push(m.text));
  socket().serverSend({ type: "chat", text: "hi" });
  socket().serverSend({ type: "roster", players: [] });
  socket().onmessage({ data: "not json" }); // ignored, no throw
  assert.deepEqual(chats, ["hi"]);
});

test("Connection: sends while connecting are queued; 'open' handlers go first", () => {
  const { conn, socket } = setup();
  conn.on("open", () => conn.send({ type: "join" }));
  conn.open();
  conn.send({ type: "chat", text: "early" });
  assert.equal(conn.queued, 1);
  socket().serverOpen();
  assert.deepEqual(
    socket().sent.map((m) => m.type),
    ["join", "chat"],
  );
  assert.equal(conn.queued, 0);
});

test("Connection: unexpected close -> reconnect with growing backoff, rejoin on open", () => {
  const { conn, timers, statuses, socket } = setup({ baseMs: 100, maxMs: 1000 });
  let joins = 0;
  conn.on("open", () => joins++);
  conn.open();
  socket().serverOpen();
  socket().serverClose(1006); // network dropped
  socket().serverClose(1006); // (same socket, ignored)
  assert.equal(timers.at(-1).ms, 100);
  timers.at(-1).fn();
  socket().serverClose(1006); // failed again before opening
  assert.equal(timers.at(-1).ms, 200);
  timers.at(-1).fn();
  socket().serverClose(1001); // server restarting
  assert.equal(timers.at(-1).ms, 400);
  timers.at(-1).fn();
  socket().serverOpen();
  assert.equal(joins, 2, "open fired again after the reconnect");
  assert.equal(FakeSocket.instances.length, 4);
  assert.ok(statuses.includes("reconnecting"));
  assert.equal(conn.state, "open");
});

test("Connection: deliberate close and protocol-error codes do not reconnect", () => {
  for (const code of [4004, 4008, 1009]) {
    const { conn, timers, socket } = setup();
    conn.open();
    socket().serverOpen();
    socket().serverClose(code);
    assert.equal(timers.length, 0, `no reconnect after ${code}`);
    assert.equal(conn.state, "closed");
  }
  const { conn, timers, socket } = setup();
  conn.open();
  socket().serverOpen();
  conn.close();
  assert.equal(timers.length, 0);
  assert.equal(conn.state, "closed");
});

test("socketUrl: same origin, ws:// or wss://", () => {
  assert.equal(socketUrl({ protocol: "http:", host: "localhost:5173" }), "ws://localhost:5173/ws");
  assert.equal(socketUrl({ protocol: "https:", host: "game.example" }), "wss://game.example/ws");
});
