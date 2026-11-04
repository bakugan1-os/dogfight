// The client's WebSocket wrapper (Lab 4, M2).
//  - messages are JSON with a `type`; each arrives as an event of that type: on("chat", fn)
//  - send() while (re)connecting queues the message; the queue flushes after "open"
//  - an unexpected close reconnects with exponential backoff + full jitter (Lab 3's retry idea)
//  - a deliberate close, or a close code that means "you did something wrong", does not
//
// Status changes arrive as "status" events: connecting | open | reconnecting | closed.

/** Server close codes after which reconnecting would only repeat the same mistake. */
const PERMANENT = new Set([1000, 1008, 1009, 4000, 4001, 4002, 4003, 4004, 4005, 4006, 4008, 4011]);

export class Connection extends EventTarget {
  #url;
  #WebSocket;
  #socket = null;
  #queue = [];
  #attempt = 0;
  #timer = null;
  #manual = false;

  constructor(
    url,
    {
      WebSocketImpl = globalThis.WebSocket,
      baseMs = 500,
      maxMs = 8000,
      maxQueue = 50,
      random = Math.random,
      setTimer = (fn, ms) => setTimeout(fn, ms),
      clearTimer = (t) => clearTimeout(t),
    } = {},
  ) {
    super();
    this.#url = url;
    this.#WebSocket = WebSocketImpl;
    Object.assign(this, { baseMs, maxMs, maxQueue, random, setTimer, clearTimer });
    this.state = "idle";
  }

  /** Subscribe to one message type (or "status"/"open"); returns an unsubscribe function. */
  on(type, handler) {
    const listener = (e) => handler(e.detail);
    this.addEventListener(type, listener);
    return () => this.removeEventListener(type, listener);
  }

  #emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }

  #status(state, extra = {}) {
    this.state = state;
    this.#emit("status", { state, ...extra });
  }

  get queued() {
    return this.#queue.length;
  }

  open() {
    this.#manual = false;
    if (this.#socket) return this;
    this.#connect();
    return this;
  }

  #connect() {
    this.#status(this.#attempt ? "reconnecting" : "connecting", { attempt: this.#attempt });
    const socket = new this.#WebSocket(this.#url);
    this.#socket = socket;
    socket.onopen = () => {
      this.#attempt = 0;
      this.#status("open");
      this.#emit("open"); // the app sends "join" here — before anything queued
      const pending = this.#queue.splice(0);
      for (const text of pending) socket.send(text);
    };
    socket.onmessage = (e) => {
      let msg;
      try {
        msg = JSON.parse(e.data);
      } catch {
        return; // the server only sends JSON; ignore anything else
      }
      if (msg && typeof msg.type === "string") this.#emit(msg.type, msg);
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

  /** Sends now if open, otherwise queues (oldest dropped beyond maxQueue). */
  send(message) {
    const text = JSON.stringify(message);
    if (this.#socket?.readyState === 1 /* OPEN */) {
      this.#socket.send(text);
      return true;
    }
    this.#queue.push(text);
    if (this.#queue.length > this.maxQueue) this.#queue.shift();
    return false;
  }

  close(code = 1000, reason = "bye") {
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
export function socketUrl(location = globalThis.location) {
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${location.host}/ws`;
}
