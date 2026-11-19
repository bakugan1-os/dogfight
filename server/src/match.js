// One running game per room (Lab 5): the AUTHORITATIVE simulation.
//
// Every tick (30 Hz, TickLoop):
//   1. take at most ONE queued input per player (inputs arrive at the client's 30 Hz step rate;
//      one per tick keeps the server's history identical to what the client predicted);
//      no input this tick -> repeat the last held controls (the packet is late, not "no keys")
//   2. world.step(1/30, inputs)
//   3. build ONE snapshot; send it to every client with ITS OWN ack = last seq processed for it
//
// Clients send inputs, never positions. The server never asks a client where anything is.

import { World } from "@dogfight/shared/sim/world.js";
import { NO_CONTROLS } from "@dogfight/shared/sim/ship.js";
import { ARENAS, PLAYER_COLORS } from "@dogfight/shared/sim/arenas.js";
import { TICK_RATE, TICK_DT } from "@dogfight/shared/protocol/messages.js";
import { buildSnapshot, collectEvents } from "@dogfight/shared/protocol/snapshot.js";
import * as binary from "@dogfight/shared/codec/binary.js";
import * as json from "@dogfight/shared/codec/json.js";
import { TickLoop } from "./tickloop.js";

const MAX_QUEUE = 8; // inputs buffered per player; more = the client runs fast, drop the oldest

export class Match {
  #clients = new Map(); // sessionId -> client record
  #events;

  constructor(room, { seed = 1 + Math.floor(Math.random() * 2 ** 31), tickRate = TICK_RATE } = {}) {
    this.room = room;
    this.seed = seed;
    this.world = new World({ seed, ...(ARENAS[room.arena] ?? ARENAS.classic) });
    this.#events = collectEvents(this.world);
    this.loop = new TickLoop(tickRate, () => this.step());
    this.bytesOut = 0;
    this.bytesIn = 0;
  }

  get tick() {
    return this.world.tick;
  }

  get size() {
    return this.#clients.size;
  }

  start() {
    this.loop.start();
  }

  stop() {
    this.loop.stop();
    this.#events.stop();
  }

  /**
   * @param {string} sessionId
   * @param {string} name
   * @param {{ codec: "binary"|"json", send: (frame: Uint8Array|string) => void }} sink
   * @returns {number} playerId (1..255) — the slot this player's ship carries in snapshots
   */
  addClient(sessionId, name, sink) {
    const used = new Set([...this.#clients.values()].map((c) => c.playerId));
    let playerId = 1;
    while (used.has(playerId)) playerId++;
    this.world.addPlayer({
      id: playerId,
      name,
      color: PLAYER_COLORS[(playerId - 1) % PLAYER_COLORS.length],
    });
    this.#clients.set(sessionId, {
      playerId,
      sink,
      queue: [],
      lastQueued: 0,
      lastProcessed: 0,
      held: NO_CONTROLS,
      dropped: 0,
    });
    return playerId;
  }

  removeClient(sessionId) {
    const c = this.#clients.get(sessionId);
    if (!c) return;
    this.world.removePlayer(c.playerId);
    this.#clients.delete(sessionId);
  }

  slotOf(sessionId) {
    return this.#clients.get(sessionId)?.playerId;
  }

  /** A validated input. Old or duplicate sequence numbers are ignored. */
  pushInput(sessionId, input, bytes = 0) {
    const c = this.#clients.get(sessionId);
    if (!c) return false;
    this.bytesIn += bytes;
    if (input.seq <= c.lastQueued) return false;
    c.lastQueued = input.seq;
    c.queue.push(input);
    if (c.queue.length > MAX_QUEUE) {
      c.queue.shift();
      c.dropped++;
    }
    return true;
  }

  step() {
    const inputs = new Map();
    for (const c of this.#clients.values()) {
      const input = c.queue.shift();
      if (input) {
        c.lastProcessed = input.seq;
        c.held = input; // carries .seq: Ship.fire() stamps it on the bullet
      } else {
        c.held = { ...c.held, firePressed: false }; // late packet: keep holding, don't re-click
      }
      inputs.set(c.playerId, c.held);
    }
    this.world.step(TICK_DT, inputs);
    const snap = buildSnapshot(this.world, this.world.tick, this.#events.drain());
    this.#broadcast(snap);
  }

  #broadcast(snap) {
    let bin = null; // encoded once per tick, then only the 4-byte ack differs per client
    for (const c of this.#clients.values()) {
      let frame;
      if (c.sink.codec === "json") {
        snap.ack = c.lastProcessed;
        frame = json.encodeSnapshot(snap);
        this.bytesOut += Buffer.byteLength(frame);
      } else {
        bin ??= binary.encodeSnapshot(snap);
        frame = binary.withAck(bin, c.lastProcessed);
        this.bytesOut += frame.byteLength;
      }
      c.sink.send(frame);
    }
  }

  stats() {
    return {
      room: this.room.id,
      players: this.#clients.size,
      tick: this.world.tick,
      entities: this.world.size,
      ...this.loop.stats,
      jitter: this.loop.jitter(),
      bytesOut: this.bytesOut,
      bytesIn: this.bytesIn,
    };
  }
}
