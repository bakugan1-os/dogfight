// Lab 4 (client side): the Connection wrapper — dispatch by type, send queue while connecting,
// reconnect with backoff, no reconnect after a deliberate or "you did it wrong" close.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  Connection,
  socketUrl,
  type ConnectionOptions,
  type SocketLike,
} from "../src/net/connection.ts";
import { PROTOCOL_VERSION, type ClientMessage } from "@dogfight/shared/protocol/control.ts";

/** A scriptable stand-in for the browser's WebSocket — `implements` makes TS check the shape. */
class FakeSocket implements SocketLike {
  static instances: FakeSocket[] = [];
  readonly url: string;
  readyState = 0; // CONNECTING
  binaryType: BinaryType = "blob";
  readonly sent: Array<{ type: string }> = [];
  onopen: ((e: Event) => void) | null = null;
  onmessage: ((e: MessageEvent) => void) | null = null;
  onerror: ((e: Event) => void) | null = null;
  onclose: ((e: CloseEvent) => void) | null = null;
  constructor(url: string) {
    this.url = url;
    FakeSocket.instances.push(this);
  }
  send(text: string | Uint8Array): void {
    const msg: unknown = JSON.parse(String(text));
    if (typeof msg === "object" && msg && "type" in msg && typeof msg.type === "string")
      this.sent.push({ type: msg.type });
  }
  close(code = 1000, reason = ""): void {
    this.serverClose(code, reason);
  }
  // ---- test controls
  serverOpen(): void {
    this.readyState = 1;
    this.onopen?.(new Event("open"));
  }
  serverSend(msg: object): void {
    this.serverSendRaw(JSON.stringify(msg));
  }
  serverSendRaw(data: string): void {
    this.onmessage?.(new MessageEvent("message", { data }));
  }
  serverClose(code: number, reason = ""): void {
    this.readyState = 3;
    this.onclose?.(new FakeCloseEvent(code, reason));
  }
}

/**
 * Node 22 has Event and MessageEvent but NOT CloseEvent (Node 23+) — while the DOM types say it
 * exists. Types describe the browser; the test runs in Node. A structural stand-in fits the type.
 */
class FakeCloseEvent extends Event implements CloseEvent {
  readonly code: number;
  readonly reason: string;
  readonly wasClean = true;
  constructor(code: number, reason: string) {
    super("close");
    this.code = code;
    this.reason = reason;
  }
}

type Timer = { fn: () => void; ms: number };

function setup(options: ConnectionOptions = {}) {
  FakeSocket.instances = [];
  const timers: Timer[] = [];
  const conn = new Connection("ws://test/ws", {
    WebSocketImpl: FakeSocket,
    random: () => 1, // jitter at its cap: delays are deterministic
    setTimer: (fn, ms) => timers.push({ fn, ms }), // a fake timer: its handle is the queue length
    clearTimer: () => {},
    ...options,
  });
  const statuses: string[] = [];
  conn.on("status", (s) => statuses.push(s.state));
  const socket = (): FakeSocket => {
    const last = FakeSocket.instances.at(-1);
    assert.ok(last, "a socket was opened");
    return last;
  };
  const lastTimer = (): Timer => {
    const last = timers.at(-1);
    assert.ok(last, "a reconnect was scheduled");
    return last;
  };
  return { conn, timers, statuses, socket, lastTimer };
}

test("Connection: messages are dispatched by their type", () => {
  const { conn, socket } = setup();
  conn.open();
  socket().serverOpen();
  const chats: string[] = [];
  conn.on("chat", (m) => chats.push(m.text));
  socket().serverSend({ type: "chat", from: { id: "a", name: "A" }, text: "hi", t: 1 });
  socket().serverSend({ type: "roster", room: "r", players: [] });
  socket().serverSendRaw("not json"); // ignored, no throw
  socket().serverSend({ type: "chat", text: "no sender" }); // Lab 6: fails the schema -> ignored
  assert.deepEqual(chats, ["hi"]);
  assert.equal(conn.rejected, 2);
});

test("Connection: sends while connecting are queued; 'open' handlers go first", () => {
  const { conn, socket } = setup();
  const join: ClientMessage = { type: "join", v: PROTOCOL_VERSION, room: "r", name: "A" };
  conn.on("open", () => conn.send(join));
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
  const { conn, statuses, socket, lastTimer } = setup({ baseMs: 100, maxMs: 1000 });
  let joins = 0;
  conn.on("open", () => joins++);
  conn.open();
  socket().serverOpen();
  socket().serverClose(1006); // network dropped
  socket().serverClose(1006); // (same socket, ignored)
  assert.equal(lastTimer().ms, 100);
  lastTimer().fn();
  socket().serverClose(1006); // failed again before opening
  assert.equal(lastTimer().ms, 200);
  lastTimer().fn();
  socket().serverClose(1001); // server restarting
  assert.equal(lastTimer().ms, 400);
  lastTimer().fn();
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
