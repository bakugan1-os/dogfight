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

import { World } from "@dogfight/shared/sim/world.ts";
import { NO_CONTROLS, type Controls } from "@dogfight/shared/sim/ship.ts";
import { ARENAS, PLAYER_COLORS } from "@dogfight/shared/sim/arenas.ts";
import {
  TICK_RATE,
  TICK_DT,
  NO_SEQ,
  type Input,
  type Snapshot,
} from "@dogfight/shared/protocol/messages.ts";
import { buildSnapshot, collectEvents } from "@dogfight/shared/protocol/snapshot.ts";
import {
  isPlayerId,
  tick as toTick,
  type PlayerId,
  type Seq,
} from "@dogfight/shared/protocol/ids.ts";
import { binaryCodec, withAck } from "@dogfight/shared/codec/binary.ts";
import { jsonCodec } from "@dogfight/shared/codec/json.ts";
import type { CodecName } from "@dogfight/shared/codec/codec.ts";
import { TickLoop, type TickStats } from "./tickloop.ts";
import type { Room } from "./rooms.ts";
import type { PlayerInput } from "./bot.ts";

const MAX_QUEUE = 8; // inputs buffered per player; more = the client runs fast, drop the oldest

/** Where a client's snapshots go: the socket layer decides how (latency injector, backpressure). */
export type Sink = { codec: CodecName; send: (frame: Uint8Array | string) => void };

type Client = {
  readonly playerId: PlayerId;
  readonly sink: Sink;
  readonly queue: Input[];
  lastQueued: number;
  lastProcessed: Seq;
  held: Controls;
  dropped: number;
};

export type MatchStats = TickStats & {
  room: string;
  players: number;
  bots: number;
  tick: number;
  entities: number;
  jitter: { meanMs: number; p95Ms: number };
  tickMs: { p50: number; p99: number; max: number; n: number };
  bytesOut: number;
  bytesIn: number;
};

export class Match {
  readonly #clients = new Map<string, Client>(); // sessionId -> client record
  readonly #bots = new Map<string, { bot: PlayerInput; slot: PlayerId }>();
  readonly #events: ReturnType<typeof collectEvents>;
  readonly room: Pick<Room, "id" | "arena">;
  readonly seed: number;
  readonly world: World;
  readonly loop: TickLoop;
  bytesOut = 0;
  bytesIn = 0;

  constructor(
    room: Pick<Room, "id" | "arena">,
    {
      seed = 1 + Math.floor(Math.random() * 2 ** 31),
      tickRate = TICK_RATE,
    }: { seed?: number; tickRate?: number } = {},
  ) {
    this.room = room;
    this.seed = seed;
    this.world = new World({ seed, ...ARENAS[room.arena] });
    this.#events = collectEvents(this.world);
    this.loop = new TickLoop(tickRate, () => this.step());
  }

  get tick(): number {
    return this.world.tick;
  }

  get size(): number {
    return this.#clients.size;
  }

  start(): void {
    this.loop.start();
  }

  stop(): void {
    this.loop.stop();
    this.#events.stop();
  }

  /** @returns the slot (player id 1..255) this player's ship carries in snapshots */
  addClient(sessionId: string, name: string, sink: Sink): PlayerId {
    const used = new Set<number>([...this.#clients.values()].map((c) => c.playerId));
    let slot = 1;
    while (used.has(slot)) slot++;
    if (!isPlayerId(slot)) throw new RangeError("match is full: no free player slot");
    this.world.addPlayer({
      id: slot,
      name,
      color: PLAYER_COLORS[(slot - 1) % PLAYER_COLORS.length],
    });
    this.#clients.set(sessionId, {
      playerId: slot,
      sink,
      queue: [],
      lastQueued: 0,
      lastProcessed: NO_SEQ,
      held: NO_CONTROLS,
      dropped: 0,
    });
    return slot;
  }

  removeClient(sessionId: string): void {
    this.#bots.delete(sessionId);
    const c = this.#clients.get(sessionId);
    if (!c) return;
    this.world.removePlayer(c.playerId);
    this.#clients.delete(sessionId);
  }

  slotOf(sessionId: string): PlayerId | undefined {
    return this.#clients.get(sessionId)?.playerId;
  }

  /** Lab 7: an AI player. It gets a slot like a human; its sink throws the snapshots away. */
  addBot(sessionId: string, name: string, bot: PlayerInput): PlayerId {
    const slot = this.addClient(sessionId, name, { codec: "binary", send: () => {} });
    this.#bots.set(sessionId, { bot, slot });
    return slot;
  }

  get bots(): number {
    return this.#bots.size;
  }

  /** A validated input. Old or duplicate sequence numbers are ignored. */
  pushInput(sessionId: string, input: Input, bytes = 0): boolean {
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

  step(): void {
    // Bots decide first and go through the SAME queue as socket inputs.
    for (const [sessionId, { bot, slot }] of this.#bots) {
      const input = bot.next(this.world, slot);
      if (input) this.pushInput(sessionId, input);
    }
    const inputs = new Map<PlayerId, Controls>();
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
    this.#broadcast(buildSnapshot(this.world, toTick(this.world.tick), this.#events.drain()));
  }

  #broadcast(snap: Snapshot): void {
    let bin: Uint8Array<ArrayBuffer> | null = null; // encoded once per tick; only the 4-byte ack differs
    for (const [sessionId, c] of this.#clients) {
      // Lab 7: bots read the world directly. Encoding + copying a snapshot for each of them was
      // 4 % of the server's CPU at 128 bots — for frames that were thrown away.
      if (this.#bots.has(sessionId)) continue;
      let frame: Uint8Array | string;
      if (c.sink.codec === "json") {
        frame = jsonCodec.encodeSnapshot({ ...snap, ack: c.lastProcessed });
        this.bytesOut += Buffer.byteLength(frame);
      } else {
        bin ??= binaryCodec.encodeSnapshot(snap);
        frame = withAck(bin, c.lastProcessed);
        this.bytesOut += frame.byteLength;
      }
      c.sink.send(frame);
    }
  }

  stats(): MatchStats {
    return {
      room: this.room.id,
      players: this.#clients.size,
      bots: this.#bots.size,
      tick: this.world.tick,
      entities: this.world.size,
      ...this.loop.stats,
      jitter: this.loop.jitter(),
      tickMs: this.loop.durations(),
      bytesOut: this.bytesOut,
      bytesIn: this.bytesIn,
    };
  }
}
