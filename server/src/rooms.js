// Rooms (Lab 4, M2). A Room is an EventEmitter: it owns its players and announces what happens
// ("open", "join", "leave", "chat", "empty", "close"); it never touches a socket. "open" = the
// first player arrived (a match session starts), "empty" = the last one left (it ends). Every announcement is
// also emitted as a generic "event" with a timestamp — the match log (log/matchlog.js) consumes
// exactly that stream, so logging never needs its own hooks in the room code.

import { EventEmitter } from "node:events";

export const ARENAS = Object.freeze(["classic", "belt", "calm", "hunters"]);
export const MODES = Object.freeze(["duel", "solo"]);

export class RoomError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "RoomError";
    this.code = code; // "full" | "not_found" | "too_many_rooms" | "invalid"
  }
}

export class Room extends EventEmitter {
  #closed = false;

  constructor({ id, name, arena = "classic", mode = "duel", maxPlayers = 2, persistent = false }) {
    super();
    this.id = id;
    this.name = name;
    this.arena = arena;
    this.mode = mode;
    this.maxPlayers = maxPlayers;
    this.persistent = persistent; // default rooms survive being empty
    this.createdAt = Date.now();
    /** @type {Map<string, {id:string, name:string, joinedAt:number}>} */
    this.players = new Map();
  }

  get size() {
    return this.players.size;
  }

  get isFull() {
    return this.players.size >= this.maxPlayers;
  }

  #announce(type, detail) {
    const event = { t: Date.now(), room: this.id, type, ...detail };
    this.emit("event", event); // for the match log
    return event;
  }

  join(player) {
    if (this.#closed) throw new RoomError("not_found", `room ${this.id} is closed`);
    if (this.isFull) throw new RoomError("full", `room ${this.name} is full`);
    if (this.players.size === 0) this.emit("open", this); // a match session begins
    this.players.set(player.id, { ...player, joinedAt: Date.now() });
    this.#announce("join", { player: { id: player.id, name: player.name } });
    this.emit("join", player);
  }

  leave(playerId, reason = "left") {
    const player = this.players.get(playerId);
    if (!player) return false;
    this.players.delete(playerId);
    this.#announce("leave", { player: { id: player.id, name: player.name }, reason });
    this.emit("leave", player, reason);
    if (this.players.size === 0) this.emit("empty", this);
    return true;
  }

  chat(playerId, text) {
    const player = this.players.get(playerId);
    if (!player) throw new RoomError("not_found", "not in this room");
    const { t } = this.#announce("chat", { player: { id: player.id, name: player.name }, text });
    this.emit("chat", player, text, t);
    return t;
  }

  roster() {
    return [...this.players.values()].map(({ id, name }) => ({ id, name }));
  }

  /** Public summary for GET /api/rooms (the shape the Lab 3 lobby already understands). */
  summary() {
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
  close() {
    if (this.#closed) return;
    this.#closed = true;
    this.#announce("close", {});
    this.emit("close");
    this.removeAllListeners();
  }
}

export const DEFAULT_ROOMS = Object.freeze([
  { id: "r-101", name: "Дуель у поясі", arena: "belt", mode: "duel", maxPlayers: 2 },
  { id: "r-102", name: "Тренування", arena: "calm", mode: "solo", maxPlayers: 1 },
  { id: "r-103", name: "Полювання", arena: "hunters", mode: "duel", maxPlayers: 2 },
  { id: "r-104", name: "Кают-компанія", arena: "classic", mode: "duel", maxPlayers: 8 },
]);

/**
 * Creates, finds and deletes rooms. A room created through the API is deleted when it becomes
 * empty — or if nobody joins it within `idleMs`. Emits "created" and "deleted".
 */
export class RoomManager extends EventEmitter {
  #rooms = new Map();
  #nextId = 1;
  #idleTimers = new Map();

  constructor({
    maxRooms = 50,
    maxPlayersPerRoom = 8,
    idleMs = 60_000,
    defaults = DEFAULT_ROOMS,
  } = {}) {
    super();
    this.maxRooms = maxRooms;
    this.maxPlayersPerRoom = maxPlayersPerRoom;
    this.idleMs = idleMs;
    for (const spec of defaults) this.create({ ...spec, persistent: true });
  }

  get size() {
    return this.#rooms.size;
  }

  get(id) {
    return this.#rooms.get(id);
  }

  list() {
    return [...this.#rooms.values()].map((room) => room.summary());
  }

  /** Validates untrusted input (POST /api/rooms) and creates the room. */
  create({ id, name, arena = "classic", mode = "duel", maxPlayers, persistent = false }) {
    if (this.#rooms.size >= this.maxRooms) {
      throw new RoomError("too_many_rooms", `server limit: ${this.maxRooms} rooms`);
    }
    if (typeof name !== "string" || !name.trim() || name.length > 40) {
      throw new RoomError("invalid", "name: 1..40 chars");
    }
    if (!ARENAS.includes(arena))
      throw new RoomError("invalid", `arena: one of ${ARENAS.join(", ")}`);
    if (!MODES.includes(mode)) throw new RoomError("invalid", `mode: one of ${MODES.join(", ")}`);
    const limit = maxPlayers ?? (mode === "solo" ? 1 : 2);
    if (!Number.isInteger(limit) || limit < 1 || limit > this.maxPlayersPerRoom) {
      throw new RoomError("invalid", `maxPlayers: 1..${this.maxPlayersPerRoom}`);
    }
    const room = new Room({
      id: id ?? `r-${this.#nextId++}`,
      name: name.trim(),
      arena,
      mode,
      maxPlayers: limit,
      persistent,
    });
    this.#rooms.set(room.id, room);
    room.on("empty", () => {
      if (!room.persistent) this.delete(room.id);
    });
    if (!persistent) {
      const timer = setTimeout(() => room.size === 0 && this.delete(room.id), this.idleMs);
      timer.unref(); // an idle timer must not keep the process alive on shutdown
      this.#idleTimers.set(room.id, timer);
      room.once("join", () => clearTimeout(timer));
    }
    this.emit("created", room);
    return room;
  }

  delete(id) {
    const room = this.#rooms.get(id);
    if (!room) return false;
    clearTimeout(this.#idleTimers.get(id));
    this.#idleTimers.delete(id);
    this.#rooms.delete(id);
    this.emit("deleted", room);
    room.close();
    return true;
  }

  closeAll() {
    for (const id of [...this.#rooms.keys()]) this.delete(id);
  }
}
