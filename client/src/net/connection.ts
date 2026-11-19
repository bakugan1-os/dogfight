// The client's WebSocket wrapper (Lab 4, M2).
//  - messages are JSON with a `type`; each arrives as an event of that type: on("chat", fn)
//  - send() while (re)connecting queues the message; the queue flushes after "open"
//  - an unexpected close reconnects with exponential backoff + full jitter (Lab 3's retry idea)
//  - a deliberate close, or a close code that means "you did something wrong", does not
//
// Status changes arrive as "status" events: connecting | open | reconnecting | closed.
//
// Lab 6: every JSON message is PARSED with the shared zod schema (parseServerMessage) before it
// becomes an event, and the events are typed: on("roster", (msg) => …) gives a roster message.

import { Bus } from "@dogfight/shared/sim/bus.ts";
import {
  CLOSE,
  parseServerMessage,
  type ClientMessage,
  type ServerMessage,
  type ServerMessageMap,
} from "@dogfight/shared/protocol/control.ts";
import { assertNever } from "@dogfight/shared/sim/math.ts";

/** Server close codes after which reconnecting would only repeat the same mistake. */
const PERMANENT: ReadonlySet<number> = new Set([
  CLOSE.NORMAL,
  1008,
  CLOSE.TOO_BIG,
  CLOSE.BAD_JSON,
  CLOSE.UNKNOWN_TYPE,
  CLOSE.BAD_SHAPE,
  CLOSE.JOIN_TIMEOUT,
  CLOSE.ROOM_UNAVAILABLE,
  CLOSE.VERSION,
  CLOSE.NOT_JOINED,
  CLOSE.RATE_LIMIT,
  CLOSE.SERVER_FULL,
]);

export type ConnectionState = "idle" | "connecting" | "open" | "reconnecting" | "closed";
export type StatusEvent = {
  state: ConnectionState;
  attempt?: number;
  delay?: number;
  code?: number;
  reason?: string;
};

/** One map for everything a Connection announces: server messages by type + its own events. */
export type ConnectionEvents = ServerMessageMap & {
  status: StatusEvent;
  open: Record<string, never>;
  /** a binary real-time frame (snapshot), undecoded */
  binary: ArrayBuffer;
  /** a JSON-codec snapshot, undecoded */
  realtime: string;
};

/** The parts of the browser WebSocket a Connection uses (tests pass a fake). */
export type SocketLike = {
  readonly readyState: number;
  binaryType: BinaryType;
  onopen: ((e: Event) => void) | null;
  onmessage: ((e: MessageEvent) => void) | null;
  onerror: ((e: Event) => void) | null;
  onclose: ((e: CloseEvent) => void) | null;
  send(data: string | Uint8Array<ArrayBuffer>): void;
  close(code?: number, reason?: string): void;
};
/** setTimeout's handle (a number in browsers, an object in Node) — or anything a fake returns. */
type Timer = ReturnType<typeof setTimeout> | number;

export type ConnectionOptions = {
  WebSocketImpl?: new (url: string) => SocketLike;
  baseMs?: number;
  maxMs?: number;
  maxQueue?: number;
  random?: () => number;
  setTimer?: (fn: () => void, ms: number) => Timer;
  clearTimer?: (t: Timer) => void;
};

export class Connection extends Bus<ConnectionEvents> {
  readonly #url: string;
  readonly #WebSocket: new (url: string) => SocketLike;
  #socket: SocketLike | null = null;
  readonly #queue: string[] = [];
  #attempt = 0;
  #timer: Timer | null = null;
  #manual = false;
  readonly baseMs: number;
  readonly maxMs: number;
  readonly maxQueue: number;
  readonly random: () => number;
  readonly setTimer: (fn: () => void, ms: number) => Timer;
  readonly clearTimer: (t: Timer) => void;
  state: ConnectionState = "idle";
  bytesIn = 0; // Lab 5: counters for the netgraph (bytes/s = difference per second)
  bytesOut = 0;
  /** server messages that failed the schema (ignored, counted) */
  rejected = 0;

  constructor(
    url: string,
    {
      WebSocketImpl = globalThis.WebSocket,
      baseMs = 500,
      maxMs = 8000,
      maxQueue = 50,
      random = Math.random,
      setTimer = (fn, ms) => setTimeout(fn, ms),
      clearTimer = (t) => clearTimeout(t),
    }: ConnectionOptions = {},
  ) {
    super();
    this.#url = url;
    this.#WebSocket = WebSocketImpl;
    this.baseMs = baseMs;
    this.maxMs = maxMs;
    this.maxQueue = maxQueue;
    this.random = random;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
  }

  #status(state: ConnectionState, extra: Omit<StatusEvent, "state"> = {}): void {
    this.state = state;
    this.emit("status", { state, ...extra });
  }

  get queued(): number {
    return this.#queue.length;
  }

  open(): this {
    this.#manual = false;
    if (this.#socket) return this;
    this.#connect();
    return this;
  }

  #connect(): void {
    this.#status(this.#attempt ? "reconnecting" : "connecting", { attempt: this.#attempt });
    const socket = new this.#WebSocket(this.#url);
    socket.binaryType = "arraybuffer"; // Lab 5: snapshots arrive as ArrayBuffer, not Blob
    this.#socket = socket;
    socket.onopen = () => {
      this.#attempt = 0;
      this.#status("open");
      this.emit("open", {}); // the app sends "join" here — before anything queued
      const pending = this.#queue.splice(0);
      for (const text of pending) socket.send(text);
    };
    socket.onmessage = (e) => {
      const data: unknown = e.data; // MessageEvent.data is `any`: name what it really is
      if (data instanceof ArrayBuffer) {
        this.bytesIn += data.byteLength;
        this.emit("binary", data); // real-time frames: decoded by the game, not here
        return;
      }
      if (typeof data !== "string") return;
      this.bytesIn += data.length; // ASCII-ish JSON: close enough for the netgraph
      // A JSON-codec snapshot is real-time traffic too: hand it over raw, like a binary one.
      if (data.startsWith('{"type":"snapshot"')) return this.emit("realtime", data);
      const parsed = parseServerMessage(data);
      if (!parsed.ok) {
        this.rejected++;
        console.warn(`[ws] ignored a bad server message: ${parsed.reason}`);
        return;
      }
      this.#dispatch(parsed.msg);
    };
    socket.onerror = () => {}; // a "close" always follows; that's where we decide
    socket.onclose = (e) => {
      if (this.#socket !== socket) return;
      this.#socket = null;
      const permanent = this.#manual || PERMANENT.has(e.code);
      if (permanent) {
        this.#status("closed", { code: e.code, reason: e.reason });
        return;
      }
      const cap = Math.min(this.maxMs, this.baseMs * 2 ** this.#attempt);
      const delay = Math.round(this.random() * cap);
      this.#attempt++;
      this.#status("reconnecting", { attempt: this.#attempt, delay, code: e.code });
      this.#timer = this.setTimer(() => {
        this.#timer = null;
        if (!this.#manual) this.#connect();
      }, delay);
    };
  }

  /**
   * Emits a parsed server message under its own type. Exhaustive: the switch narrows `msg`, so
   * each emit() call is checked against the right payload type — a generic `emit(msg.type, msg)`
   * cannot be (TypeScript does not correlate the two uses of the union).
   */
  #dispatch(msg: ServerMessage): void {
    switch (msg.type) {
      case "welcome":
        return this.emit("welcome", msg);
      case "roster":
        return this.emit("roster", msg);
      case "pong":
        return this.emit("pong", msg);
      case "chat":
        return this.emit("chat", msg);
      case "system":
        return this.emit("system", msg);
      case "error":
        return this.emit("error", msg);
      default:
        return assertNever(msg, "server message");
    }
  }

  /**
   * Real-time frame (an encoded input): sent only if open, never queued — a stale input is
   * worse than none, the next one is 33 ms away. Returns false if it was not sent.
   */
  sendFrame(frame: string | Uint8Array<ArrayBuffer>): boolean {
    if (this.#socket?.readyState !== 1) return false;
    this.#socket.send(frame);
    this.bytesOut += typeof frame === "string" ? frame.length : frame.byteLength;
    return true;
  }

  /** Sends now if open, otherwise queues (oldest dropped beyond maxQueue). Typed: ClientMessage. */
  send(message: ClientMessage): boolean {
    const text = JSON.stringify(message);
    if (this.#socket?.readyState === 1 /* OPEN */) {
      this.#socket.send(text);
      this.bytesOut += text.length;
      return true;
    }
    this.#queue.push(text);
    if (this.#queue.length > this.maxQueue) this.#queue.shift();
    return false;
  }

  close(code = 1000, reason = "bye"): void {
    this.#manual = true;
    this.#queue.length = 0;
    if (this.#timer) this.clearTimer(this.#timer);
    this.#timer = null;
    const socket = this.#socket;
    if (socket && socket.readyState <= 1) socket.close(code, reason);
    else this.#status("closed", { code, reason });
  }
}

/** ws://host/ws or wss://host/ws, same origin as the page (Vite proxies it in development). */
export function socketUrl(
  location: Pick<Location, "protocol" | "host"> = globalThis.location,
): string {
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${location.host}/ws`;
}
