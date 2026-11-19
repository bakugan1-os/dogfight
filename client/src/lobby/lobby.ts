// The lobby's DATA layer (Lab 3, M3). No DOM here: it fetches rooms and dispatches events;
// lobby-view.ts listens and renders. Same split as sim/ vs render/.
//
// Events:  "loading"   detail: { request }            a refresh started
//          "rooms"     detail: { rooms, request, ms }   fresh list arrived
//          "error"     detail: { error, request }       refresh failed (old list is kept)
//          "join"      detail: { room, name }           the player picked a room
//          "stopped"                                    polling stopped, in-flight request aborted

import { z } from "zod";
import { fetchJson, sleep, withTimeout } from "../net/http.ts";
import { Bus } from "@dogfight/shared/sim/bus.ts";
import {
  RoomSummarySchema,
  type CreateRoomRequest,
  type RoomSummary,
} from "@dogfight/shared/protocol/control.ts";

/** Lab 6: a typed bus instead of EventTarget + CustomEvent — `detail` is no longer `any`. */
export type LobbyEvents = {
  loading: { request: number };
  rooms: { rooms: RoomSummary[]; request: number; ms: number };
  error: { error: unknown; request: number };
  join: { room: RoomSummary; name: string };
  stopped: Record<string, never>;
};

export type LobbyOptions = {
  url: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
  intervalMs?: number;
};

export class Lobby extends Bus<LobbyEvents> {
  readonly #url: string;
  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;
  readonly #intervalMs: number;
  #controller: AbortController | null = null; // alive while on screen; abort() = "the player left"
  rooms: RoomSummary[] = [];
  requests = 0;
  lastUpdated: Date | null = null;

  constructor({
    url,
    fetch = globalThis.fetch.bind(globalThis),
    timeoutMs = 3000,
    intervalMs = 4000,
  }: LobbyOptions) {
    super();
    this.#url = url;
    this.#fetch = fetch;
    this.#timeoutMs = timeoutMs;
    this.#intervalMs = intervalMs;
  }

  get running(): boolean {
    return this.#controller !== null;
  }

  /**
   * Starts polling: refresh, wait, refresh... A loop with an awaited sleep instead of
   * setInterval, so a slow response can never overlap the next request.
   */
  start(): void {
    if (this.#controller) return;
    const controller = new AbortController();
    this.#controller = controller;
    void (async () => {
      while (!controller.signal.aborted) {
        await this.refresh();
        await sleep(this.#intervalMs, controller.signal).catch(() => {});
      }
    })();
  }

  /** Cancels the in-flight request and the pending timer. No orphaned requests. */
  stop(): void {
    if (!this.#controller) return;
    this.#controller.abort();
    this.#controller = null;
    this.emit("stopped", {});
  }

  /** One request, with its own timeout AND the lobby's "player left" signal. */
  async refresh(): Promise<void> {
    const controller = this.#controller ?? new AbortController();
    const request = ++this.requests;
    const t0 = performance.now();
    this.emit("loading", { request });
    try {
      const body = await fetchJson(this.#url, {
        signal: withTimeout(controller.signal, this.#timeoutMs),
        fetch: this.#fetch,
      });
      const rooms = validateRooms(body);
      if (controller.signal.aborted) return; // the player left while the body was parsing
      this.rooms = rooms;
      this.lastUpdated = new Date();
      this.emit("rooms", { rooms, request, ms: performance.now() - t0 });
    } catch (error: unknown) {
      // "Left the lobby" is not an error worth showing — it's the cancellation working.
      if (controller.signal.aborted) return;
      this.emit("error", { error, request });
    }
  }

  /** POST /api/rooms (Lab 4). The server validates; its error message is shown as is. */
  async create({ name, arena, mode }: Omit<CreateRoomRequest, "maxPlayers">): Promise<RoomSummary> {
    const response = await this.#fetch(this.#url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name, arena, mode }),
      signal: AbortSignal.timeout(this.#timeoutMs),
    });
    const body: unknown = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = z.object({ error: z.string() }).safeParse(body);
      throw new Error(error.success ? error.data.error : `HTTP ${response.status}`);
    }
    const created = z.object({ room: RoomSummarySchema }).parse(body);
    await this.refresh();
    return created.room;
  }

  join(roomId: string, name: string): void {
    const room = this.rooms.find((r) => r.id === roomId);
    if (!room) throw new Error(`no room ${roomId}`);
    if (room.players >= room.maxPlayers) throw new Error(`room ${room.name} is full`);
    this.stop(); // leaving the lobby cancels everything it had in flight
    this.emit("join", { room, name: name.trim() || "Пілот" });
  }
}

/**
 * Never trust JSON from the network: check the shape before the UI touches it. The list must be
 * there; a single malformed room is dropped (one bad entry should not hide the others).
 */
export function validateRooms(body: unknown): RoomSummary[] {
  const list = z.object({ rooms: z.array(z.unknown()) }).safeParse(body);
  if (!list.success) throw new Error("rooms: expected { rooms: [...] }");
  return list.data.rooms.flatMap((r) => {
    const room = RoomSummarySchema.safeParse(r);
    return room.success ? [room.data] : [];
  });
}
