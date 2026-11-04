// The lobby's DATA layer (Lab 3, M3). No DOM here: it fetches rooms and dispatches events;
// lobby-view.js listens and renders. Same split as sim/ vs render/.
//
// Events:  "loading"   detail: { request }            a refresh started
//          "rooms"     detail: { rooms, request, ms }   fresh list arrived
//          "error"     detail: { error, request }       refresh failed (old list is kept)
//          "join"      detail: { room, name }           the player picked a room
//          "stopped"                                    polling stopped, in-flight request aborted

import { fetchJson, sleep, withTimeout } from "../net/http.js";

export class Lobby extends EventTarget {
  #url;
  #fetch;
  #timeoutMs;
  #intervalMs;
  #controller = null; // alive while the lobby is on screen; abort() = "the player left"

  constructor({
    url,
    fetch = globalThis.fetch.bind(globalThis),
    timeoutMs = 3000,
    intervalMs = 4000,
  }) {
    super();
    this.#url = url;
    this.#fetch = fetch;
    this.#timeoutMs = timeoutMs;
    this.#intervalMs = intervalMs;
    this.rooms = [];
    this.requests = 0;
    this.lastUpdated = null;
  }

  get running() {
    return this.#controller !== null;
  }

  #emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }

  /**
   * Starts polling: refresh, wait, refresh... A loop with an awaited sleep instead of
   * setInterval, so a slow response can never overlap the next request.
   */
  start() {
    if (this.#controller) return;
    const controller = new AbortController();
    this.#controller = controller;
    (async () => {
      while (!controller.signal.aborted) {
        await this.refresh();
        await sleep(this.#intervalMs, controller.signal).catch(() => {});
      }
    })();
  }

  /** Cancels the in-flight request and the pending timer. No orphaned requests. */
  stop() {
    if (!this.#controller) return;
    this.#controller.abort();
    this.#controller = null;
    this.#emit("stopped");
  }

  /** One request, with its own timeout AND the lobby's "player left" signal. */
  async refresh() {
    const controller = this.#controller ?? new AbortController();
    const request = ++this.requests;
    const t0 = performance.now();
    this.#emit("loading", { request });
    try {
      const body = await fetchJson(this.#url, {
        signal: withTimeout(controller.signal, this.#timeoutMs),
        fetch: this.#fetch,
      });
      const rooms = validateRooms(body);
      if (controller.signal.aborted) return; // the player left while the body was parsing
      this.rooms = rooms;
      this.lastUpdated = new Date();
      this.#emit("rooms", { rooms, request, ms: performance.now() - t0 });
    } catch (error) {
      // "Left the lobby" is not an error worth showing — it's the cancellation working.
      if (controller.signal.aborted) return;
      this.#emit("error", { error, request });
    }
  }

  /** POST /api/rooms (Lab 4). The server validates; its error message is shown as is. */
  async create({ name, arena, mode }) {
    const response = await this.#fetch(this.#url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name, arena, mode }),
      signal: AbortSignal.timeout(this.#timeoutMs),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`);
    await this.refresh();
    return body.room;
  }

  join(roomId, name) {
    const room = this.rooms.find((r) => r.id === roomId);
    if (!room) throw new Error(`no room ${roomId}`);
    if (room.players >= room.maxPlayers) throw new Error(`room ${room.name} is full`);
    this.stop(); // leaving the lobby cancels everything it had in flight
    this.#emit("join", { room, name: name.trim() || "Пілот" });
  }
}

/** Never trust JSON from the network: check the shape before the UI touches it. */
export function validateRooms(body) {
  if (!body || !Array.isArray(body.rooms)) throw new Error("rooms: expected { rooms: [...] }");
  return body.rooms.filter(
    (r) =>
      r &&
      typeof r.id === "string" &&
      typeof r.name === "string" &&
      Number.isInteger(r.players) &&
      Number.isInteger(r.maxPlayers),
  );
}
