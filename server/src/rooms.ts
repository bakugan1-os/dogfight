// Rooms (Lab 4, M2). A Room is an EventEmitter: it owns its players and announces what happens
// ("open", "join", "leave", "chat", "empty", "close"); it never touches a socket. "open" = the
// first player arrived (a match session starts), "empty" = the last one left (it ends). Every
// announcement is also emitted as a generic "event" with a timestamp — the match log
// (log/matchlog.ts) consumes exactly that stream, so logging never needs its own hooks.
//
// Lab 6: TYPED events. Node's EventEmitter<T> takes a map "event name -> listener arguments",
// so `room.on("chat", (player, text, t) => …)` knows the types of all three, and
// `room.emit("chat", player)` (missing arguments) does not compile.

import { EventEmitter } from "node:events";
import { ARENA_IDS, type ArenaId } from "@dogfight/shared/sim/arenas.ts";
import {
  CreateRoomSchema,
  type Mode,
  type RoomSummary,
} from "@dogfight/shared/protocol/control.ts";

export type Member = { readonly id: string; readonly name: string };
type Present = Member & { readonly joinedAt: number };

/** What the match log records: one object per line of the NDJSON file. */
export type RoomEvent = { t: number; room: string } & (
  | { type: "join"; player: Member }
  | { type: "leave"; player: Member; reason: string }
  | { type: "chat"; player: Member; text: string }
  | { type: "close" }
);

export type RoomEvents = {
  open: [room: Room];
  join: [player: Member];
  leave: [player: Member, reason: string];
  chat: [player: Member, text: string, t: number];
  empty: [room: Room];
  close: [];
  event: [event: RoomEvent];
};

export type RoomErrorCode = "full" | "not_found" | "too_many_rooms" | "invalid";

export class RoomError extends Error {
  readonly code: RoomErrorCode;
  constructor(code: RoomErrorCode, message: string) {
    super(message);
    this.name = "RoomError";
    this.code = code;
  }
}

export type RoomOptions = {
  id: string;
  name: string;
  arena?: ArenaId;
  mode?: Mode;
  maxPlayers?: number;
  persistent?: boolean;
};

export class Room extends EventEmitter<RoomEvents> {
  #closed = false;
  readonly id: string;
  readonly name: string;
  readonly arena: ArenaId;
  readonly mode: Mode;
  readonly maxPlayers: number;
  readonly persistent: boolean;
  readonly createdAt = Date.now();
  readonly players = new Map<string, Present>();

  constructor({
    id,
    name,
    arena = "classic",
    mode = "duel",
    maxPlayers = 2,
    persistent = false,
  }: RoomOptions) {
    super();
    this.id = id;
    this.name = name;
    this.arena = arena;
    this.mode = mode;
    this.maxPlayers = maxPlayers;
    this.persistent = persistent; // default rooms survive being empty
  }

  get size(): number {
    return this.players.size;
  }

  get isFull(): boolean {
    return this.players.size >= this.maxPlayers;
  }

  /**
   * `DistributiveOmit`: Omit applied to EACH member of the union separately. Plain Omit on a
   * union keeps only the keys common to all members — `text` and `reason` would be lost.
   */
  #announce(detail: DistributiveOmit<RoomEvent, "t" | "room">): RoomEvent {
    const event: RoomEvent = { t: Date.now(), room: this.id, ...detail };
    this.emit("event", event); // for the match log
    return event;
  }

  join(player: Member): void {
    if (this.#closed) throw new RoomError("not_found", `room ${this.id} is closed`);
    if (this.isFull) throw new RoomError("full", `room ${this.name} is full`);
    if (this.players.size === 0) this.emit("open", this); // a match session begins
    this.players.set(player.id, { ...player, joinedAt: Date.now() });
    this.#announce({ type: "join", player: { id: player.id, name: player.name } });
    this.emit("join", player);
  }

  leave(playerId: string, reason = "left"): boolean {
    const player = this.players.get(playerId);
    if (!player) return false;
    this.players.delete(playerId);
    this.#announce({ type: "leave", player: { id: player.id, name: player.name }, reason });
    this.emit("leave", player, reason);
    if (this.players.size === 0) this.emit("empty", this);
    return true;
  }

  chat(playerId: string, text: string): number {
    const player = this.players.get(playerId);
    if (!player) throw new RoomError("not_found", "not in this room");
    const { t } = this.#announce({
      type: "chat",
      player: { id: player.id, name: player.name },
      text,
    });
    this.emit("chat", player, text, t);
    return t;
  }

  roster(): Member[] {
    return [...this.players.values()].map(({ id, name }) => ({ id, name }));
  }

  /** Public summary for GET /api/rooms (the shape the Lab 3 lobby already understands). */
  summary(): RoomSummary {
    return {
      id: this.id,
      name: this.name,
      arena: this.arena,
      mode: this.mode,
      players: this.players.size,
      maxPlayers: this.maxPlayers,
      host: this.players.values().next().value?.name ?? "—",
    };
  }

  /** Ends the room: the match log sees "close" and finishes its file. */
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#announce({ type: "close" });
    this.emit("close");
    this.removeAllListeners();
  }
}

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

export const DEFAULT_ROOMS = Object.freeze([
  { id: "r-101", name: "Дуель у поясі", arena: "belt", mode: "duel", maxPlayers: 2 },
  { id: "r-102", name: "Тренування", arena: "calm", mode: "solo", maxPlayers: 1 },
  { id: "r-103", name: "Полювання", arena: "hunters", mode: "duel", maxPlayers: 2 },
  { id: "r-104", name: "Кают-компанія", arena: "classic", mode: "duel", maxPlayers: 8 },
] as const satisfies readonly RoomOptions[]);

export type RoomManagerEvents = { created: [room: Room]; deleted: [room: Room] };

export type RoomManagerOptions = {
  maxRooms?: number;
  maxPlayersPerRoom?: number;
  idleMs?: number;
  defaults?: readonly RoomOptions[];
};

/**
 * Creates, finds and deletes rooms. A room created through the API is deleted when it becomes
 * empty — or if nobody joins it within `idleMs`. Emits "created" and "deleted".
 */
export class RoomManager extends EventEmitter<RoomManagerEvents> {
  readonly #rooms = new Map<string, Room>();
  #nextId = 1;
  readonly #idleTimers = new Map<string, ReturnType<typeof setTimeout>>();
  readonly maxRooms: number;
  readonly maxPlayersPerRoom: number;
  readonly idleMs: number;

  constructor({
    maxRooms = 50,
    maxPlayersPerRoom = 8,
    idleMs = 60_000,
    defaults = DEFAULT_ROOMS,
  }: RoomManagerOptions = {}) {
    super();
    this.maxRooms = maxRooms;
    this.maxPlayersPerRoom = maxPlayersPerRoom;
    this.idleMs = idleMs;
    for (const spec of defaults) this.#add(new Room({ ...spec, persistent: true }));
  }

  get size(): number {
    return this.#rooms.size;
  }

  get(id: string): Room | undefined {
    return this.#rooms.get(id);
  }

  list(): RoomSummary[] {
    return [...this.#rooms.values()].map((room) => room.summary());
  }

  rooms(): IterableIterator<Room> {
    return this.#rooms.values();
  }

  /**
   * Creates a room from UNTRUSTED input (POST /api/rooms body: `unknown`). The zod schema in
   * shared/protocol/control.ts checks the shape; the limits that depend on this server's config
   * are checked here.
   */
  create(body: unknown): Room {
    if (this.#rooms.size >= this.maxRooms) {
      throw new RoomError("too_many_rooms", `server limit: ${this.maxRooms} rooms`);
    }
    const parsed = CreateRoomSchema.safeParse(body);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const where = issue?.path.join(".") || "body";
      const hint =
        where === "arena"
          ? `one of ${ARENA_IDS.join(", ")}`
          : where === "mode"
            ? "one of duel, solo"
            : issue?.message;
      throw new RoomError("invalid", `${where}: ${hint}`);
    }
    const { name, arena, mode, maxPlayers } = parsed.data;
    const limit = maxPlayers ?? (mode === "solo" ? 1 : 2);
    if (limit > this.maxPlayersPerRoom) {
      throw new RoomError("invalid", `maxPlayers: 1..${this.maxPlayersPerRoom}`);
    }
    const room = new Room({ id: `r-${this.#nextId++}`, name, arena, mode, maxPlayers: limit });
    this.#add(room);
    const timer = setTimeout(() => room.size === 0 && this.delete(room.id), this.idleMs);
    timer.unref(); // an idle timer must not keep the process alive on shutdown
    this.#idleTimers.set(room.id, timer);
    room.once("join", () => clearTimeout(timer));
    return room;
  }

  #add(room: Room): void {
    this.#rooms.set(room.id, room);
    room.on("empty", () => {
      if (!room.persistent) this.delete(room.id);
    });
    this.emit("created", room);
  }

  delete(id: string): boolean {
    const room = this.#rooms.get(id);
    if (!room) return false;
    clearTimeout(this.#idleTimers.get(id));
    this.#idleTimers.delete(id);
    this.#rooms.delete(id);
    this.emit("deleted", room);
    room.close();
    return true;
  }

  closeAll(): void {
    for (const id of [...this.#rooms.keys()]) this.delete(id);
  }
}
