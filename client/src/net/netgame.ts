// The network game on the client (Lab 5). Three techniques, one per kind of entity:
//
//   own ship     PREDICTION — apply my input immediately with the shared integrate();
//                RECONCILIATION — on every snapshot: take the server's state, drop the inputs it
//                acknowledged, replay the rest; a visual offset hides the correction (~100 ms)
//   own bullets  predicted on the frame I fire; the server's bullet (same input seq) takes over
//   everyone else INTERPOLATION — drawn `interpDelay` in the past, between two snapshots
//
// The client never tells the server where anything is: it only sends inputs.

import {
  TICK_DT,
  TICK_MS,
  SHIP_FLAG,
  EVENT,
  KIND,
  PICKUP_NAME,
  type Input,
  type Snapshot,
  type EntityState,
  type ShipState,
  type PlayerState,
  type SnapshotEvent,
} from "@dogfight/shared/protocol/messages.ts";
import { binaryCodec } from "@dogfight/shared/codec/binary.ts";
import { jsonCodec } from "@dogfight/shared/codec/json.ts";
import { CodecError, type CodecName } from "@dogfight/shared/codec/codec.ts";
import {
  bodyFromSnapshot,
  cloneBody,
  predictStep,
  bulletFrom,
  type PredictedBody,
} from "@dogfight/shared/sim/predict.ts";
import { BULLET_TTL } from "@dogfight/shared/sim/bullet.ts";
import { SHIP_PARAMS, type Controls } from "@dogfight/shared/sim/ship.ts";
import { PICKUP_TYPES, type PickupType } from "@dogfight/shared/sim/pickup.ts";
import { PLAYER_COLORS } from "@dogfight/shared/sim/arenas.ts";
import { Explosion } from "@dogfight/shared/sim/explosion.ts";
import { createRng } from "@dogfight/shared/sim/rng.ts";
import { Vector2 } from "@dogfight/shared/sim/vector.ts";
import { wrappedDelta, wrapCoord, wrapPosition, type Arena } from "@dogfight/shared/sim/arena.ts";
import { lerpAngle, assertNever } from "@dogfight/shared/sim/math.ts";
import type { Bus } from "@dogfight/shared/sim/bus.ts";
import type { WorldEvents } from "@dogfight/shared/sim/world.ts";
import {
  isPlayerId,
  seq as toSeq,
  tick as toTick,
  type EntityId,
  type PlayerId,
  type Seq,
} from "@dogfight/shared/protocol/ids.ts";
import type { Connection } from "./connection.ts";
import type {
  AsteroidDrawable,
  BulletDrawable,
  Drawable,
  DrawableWorld,
  PickupDrawable,
  ShipDrawable,
} from "../render/draw.ts";

const SMOOTHING_RATE = 30; // 1/s: a correction fades to 5 % in 100 ms (e^-3)
const TELEPORT = 150; // units: bigger corrections (respawn) snap instead of gliding
const BUFFER_MS = 1500; // snapshots kept for interpolation

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

/** The client's side of a codec: encode inputs, decode snapshots — from whatever frame arrived. */
type ClientCodec = {
  encodeInput(input: Input): string | Uint8Array<ArrayBuffer>;
  decodeSnapshot(frame: ArrayBuffer | string): Snapshot;
};
const CLIENT_CODECS: Record<CodecName, ClientCodec> = {
  binary: {
    encodeInput: binaryCodec.encodeInput,
    decodeSnapshot(frame) {
      if (typeof frame === "string") throw new CodecError("binary codec got a text frame");
      return binaryCodec.decodeSnapshot(frame);
    },
  },
  json: {
    encodeInput: jsonCodec.encodeInput,
    decodeSnapshot(frame) {
      if (typeof frame !== "string") throw new CodecError("JSON codec got a binary frame");
      return jsonCodec.decodeSnapshot(frame);
    },
  },
};

type Pending = { seq: Seq; controls: Controls };
type LocalBullet = {
  seq: Seq;
  pos: Vector2;
  vel: Vector2;
  angle: number;
  ttl: number;
  serverId: EntityId | null;
};
type Buffered = { time: number; arrival: number; snap: Snapshot; byId: Map<EntityId, EntityState> };

export type NetStats = {
  rtt: number;
  correction: number;
  correctionAvg: number;
  snapshots: number;
  lostSnapshots: number;
  serverTick: number;
  bytesInPerSec: number;
  bytesOutPerSec: number;
};

export type NetGameOptions = {
  conn: Connection;
  arena: Arena;
  slot: PlayerId;
  codec?: CodecName;
  interpDelayMs?: number;
  bus?: Bus<WorldEvents> | undefined;
  flags?: { predict?: boolean; breakDeterminism?: boolean };
};

export class NetGame {
  readonly #codec: ClientCodec;
  #seq = 0;
  #pending: Pending[] = []; // sent but not yet acknowledged
  #body: PredictedBody | null = null; // predicted own ship (current step)
  #prevBody: PredictedBody | null = null; // previous step, for render interpolation inside a step
  readonly #offset = { x: 0, y: 0 }; // visual smoothing of corrections
  #ownInfo: ShipState | null = null; // own ship's latest server fields (hp, flags)
  #localBullets: LocalBullet[] = [];
  readonly #buffer: Buffered[] = []; // ordered by server time
  #clockOffset: number | null = null; // server ms − performance.now(), smoothed
  #fx: Explosion[] = [];
  readonly #fxRng = createRng(7);
  readonly #shapes = new Map<EntityId, readonly number[]>();
  #names = new Map<PlayerId, string>(); // slot -> name
  readonly #unsubscribe: Array<() => void> = [];
  readonly #pingTimer: ReturnType<typeof setInterval>;
  #lastSnapshotTick = 0;

  readonly conn: Connection;
  readonly arena: Arena;
  readonly slot: PlayerId;
  readonly codecName: CodecName;
  interpDelayMs: number;
  readonly bus: Bus<WorldEvents> | undefined;
  predict: boolean;
  breakDeterminism: boolean;
  readonly players = new Map<PlayerId, PlayerState>(); // slot -> { score, respawn }
  readonly corrections: number[] = []; // correction per snapshot, for the netgraph sparkline
  readonly stats: NetStats = {
    rtt: 0,
    correction: 0,
    correctionAvg: 0,
    snapshots: 0,
    lostSnapshots: 0,
    serverTick: 0,
    bytesInPerSec: 0,
    bytesOutPerSec: 0,
  };
  lastSnapshotAt = 0;
  renderLagMs = 0;

  constructor({
    conn,
    arena,
    slot,
    codec = "binary",
    interpDelayMs = 100,
    bus,
    flags = {},
  }: NetGameOptions) {
    this.conn = conn;
    this.arena = arena;
    this.slot = slot;
    this.#codec = CLIENT_CODECS[codec];
    this.codecName = codec;
    this.interpDelayMs = interpDelayMs;
    this.bus = bus;
    this.predict = flags.predict !== false; // ?predict=0 -> the M1 "dumb client"
    this.breakDeterminism = Boolean(flags.breakDeterminism); // ?breakdet=1, the M2 experiment
    this.#unsubscribe.push(
      conn.on("binary", (buf) => this.#onSnapshot(buf)),
      conn.on("realtime", (text) => this.#onSnapshot(text)),
      conn.on("pong", (msg) => {
        const rtt = performance.now() - msg.t;
        this.stats.rtt = this.stats.rtt ? lerp(this.stats.rtt, rtt, 0.3) : rtt;
      }),
    );
    let lastIn = conn.bytesIn;
    let lastOut = conn.bytesOut;
    this.#pingTimer = setInterval(() => {
      conn.send({ type: "ping", t: performance.now() });
      this.stats.bytesInPerSec = conn.bytesIn - lastIn;
      this.stats.bytesOutPerSec = conn.bytesOut - lastOut;
      lastIn = conn.bytesIn;
      lastOut = conn.bytesOut;
    }, 1000);
  }

  setNames(roster: ReadonlyArray<{ name: string; slot?: PlayerId | undefined }>): void {
    this.#names = new Map(
      roster.flatMap((p): Array<[PlayerId, string]> => (p.slot != null ? [[p.slot, p.name]] : [])),
    );
  }

  nameOf(slot: PlayerId): string {
    return this.#names.get(slot) ?? `P${slot}`;
  }

  get pendingInputs(): number {
    return this.#pending.length;
  }

  get alive(): boolean {
    return this.#body !== null;
  }

  dispose(): void {
    this.#unsubscribe.forEach((off) => off());
    clearInterval(this.#pingTimer);
  }

  // ---- input + prediction, once per 1/30 s step -------------------------------------------------

  step(controls: Controls): void {
    const seq = toSeq(++this.#seq);
    const input: Input = { ...controls, seq, tick: toTick(this.#estimatedTick()) };
    this.conn.sendFrame(this.#codec.encodeInput(input));
    this.#pending.push({ seq, controls });
    if (this.#pending.length > 120) this.#pending.shift(); // server silent for 4 s: don't grow

    if (this.#body && this.predict) {
      this.#prevBody = cloneBody(this.#body);
      if (this.#predict(this.#body, controls)) {
        const b = bulletFrom(this.#body);
        this.#localBullets.push({
          seq,
          pos: b.pos,
          vel: b.vel,
          angle: b.angle,
          ttl: BULLET_TTL,
          serverId: null,
        });
        this.bus?.emit("fired", { playerId: this.slot, x: b.pos.x, y: b.pos.y });
      }
    }
    for (const b of this.#localBullets) {
      b.pos.addScaledInPlace(b.vel, TICK_DT);
      wrapPosition(this.arena, b.pos);
      b.ttl -= TICK_DT;
    }
    this.#localBullets = this.#localBullets.filter((b) => b.ttl > 0);
    for (const e of this.#fx) e.update(TICK_DT);
    this.#fx = this.#fx.filter((e) => e.age < e.duration);
    const decay = Math.exp(-SMOOTHING_RATE * TICK_DT);
    this.#offset.x *= decay;
    this.#offset.y *= decay;
  }

  /** One predicted step of the own ship; the determinism experiment hooks in here. */
  #predict(body: PredictedBody, controls: Controls): boolean {
    const fired = predictStep(body, controls, TICK_DT, this.arena);
    if (this.breakDeterminism) {
      // M2 experiment: "Math.random() in integrate" — in the CLIENT's copy only (prediction AND
      // replay), so client and server compute different things from the same inputs.
      body.angle += (Math.random() - 0.5) * 0.2; // a "harmless" wobble of up to ±0.1 rad
    }
    return fired;
  }

  #estimatedTick(): number {
    if (this.#clockOffset === null) return 0;
    return Math.max(0, Math.round((performance.now() + this.#clockOffset) / TICK_MS));
  }

  // ---- snapshots: reconciliation + buffer for interpolation ------------------------------------

  #onSnapshot(frame: ArrayBuffer | string): void {
    let snap: Snapshot;
    try {
      snap = this.#codec.decodeSnapshot(frame);
    } catch (error: unknown) {
      console.warn("[net] bad snapshot", error instanceof Error ? error.message : error);
      return;
    }
    const arrival = performance.now();
    const time = snap.tick * TICK_MS;
    const sample = time - arrival;
    this.#clockOffset = this.#clockOffset === null ? sample : lerp(this.#clockOffset, sample, 0.05);
    if (this.#lastSnapshotTick && snap.tick > this.#lastSnapshotTick + 1) {
      this.stats.lostSnapshots += snap.tick - this.#lastSnapshotTick - 1;
    }
    this.#lastSnapshotTick = Math.max(this.#lastSnapshotTick, snap.tick);
    this.stats.snapshots++;
    this.stats.serverTick = snap.tick;
    this.lastSnapshotAt = arrival;

    const byId = new Map(snap.entities.map((e) => [e.id, e]));
    this.#buffer.push({ time, arrival, snap, byId });
    this.#buffer.sort((a, b) => a.time - b.time);
    while (this.#buffer.length > 2 && (this.#buffer[0]?.time ?? Infinity) < time - BUFFER_MS)
      this.#buffer.shift();

    for (const p of snap.players) this.players.set(p.id, p);
    this.#reconcile(snap);
    this.#confirmBullets(snap);
    this.#playEvents(snap.events);
  }

  #reconcile(snap: Snapshot): void {
    // A type-guard callback: find() then returns ShipState, not EntityState.
    const own = snap.entities.find(
      (e): e is ShipState => e.kind === "ship" && e.playerId === this.slot,
    );
    this.#pending = this.#pending.filter((p) => p.seq > snap.ack); // acknowledged: done
    if (!own) {
      this.#body = null;
      this.#prevBody = null;
      this.#ownInfo = null;
      return;
    }
    this.#ownInfo = own;
    if (!this.predict) return; // M1: own ship is drawn straight from snapshots
    const before = this.#body ? this.#body.pos.clone() : null;
    const body = bodyFromSnapshot(own, Boolean(own.flags & SHIP_FLAG.rapid));
    for (const p of this.#pending) this.#predict(body, p.controls); // replay the unacknowledged
    if (before) {
      const dx = wrappedDelta(body.pos.x, before.x, this.arena.width);
      const dy = wrappedDelta(body.pos.y, before.y, this.arena.height);
      const error = Math.hypot(dx, dy);
      this.stats.correction = error;
      this.corrections.push(error);
      if (this.corrections.length > 150) this.corrections.shift(); // last 5 s for the graph
      this.stats.correctionAvg = lerp(this.stats.correctionAvg, error, 0.1);
      if (error < TELEPORT) {
        this.#offset.x += dx; // draw where we WERE, then glide to where we ARE
        this.#offset.y += dy;
      } else {
        this.#offset.x = this.#offset.y = 0;
      }
    }
    this.#body = body;
    this.#prevBody = cloneBody(body);
  }

  /** Predicted bullet <-> server bullet, matched by the 16-bit input seq that fired them. */
  #confirmBullets(snap: Snapshot): void {
    const mine = new Map<number, EntityState & { kind: "bullet" }>();
    for (const e of snap.entities) {
      if (e.kind === "bullet" && e.ownerId === this.slot) mine.set(e.seq, e);
    }
    const ahead = this.#pending.length * TICK_DT; // how far our timeline runs ahead of this tick
    const ackSeq = snap.ack & 0xffff;
    this.#localBullets = this.#localBullets.filter((b) => {
      const server = mine.get(b.seq & 0xffff);
      if (server) {
        b.serverId = server.id;
        b.pos.set(server.x + server.vx * ahead, server.y + server.vy * ahead);
        wrapPosition(this.arena, b.pos);
        b.vel.set(server.vx, server.vy);
        return true;
      }
      // The server processed the input that fired it, but the bullet is gone (hit something,
      // or the server's ship could not fire): remove our copy.
      const processed = ((ackSeq - (b.seq & 0xffff)) & 0xffff) < 0x8000;
      return !(processed || b.serverId !== null);
    });
  }

  /**
   * Snapshot events -> the same typed bus events the local World emits, so audio and HUD do
   * not care where the game runs. Numbers from the wire become PlayerIds only through a guard.
   */
  #playEvents(events: readonly SnapshotEvent[]): void {
    const bus = this.bus;
    for (const ev of events) {
      const { x, y } = ev;
      const a = isPlayerId(ev.a) ? ev.a : null;
      const b = isPlayerId(ev.b) ? ev.b : null;
      switch (ev.type) {
        case EVENT.fired:
          if (a && (a !== this.slot || !this.predict)) bus?.emit("fired", { playerId: a, x, y });
          break;
        case EVENT.hit:
          if (ev.a === KIND.ship && b)
            bus?.emit("hit", { target: "ship", playerId: b, by: null, x, y });
          else bus?.emit("hit", { target: "asteroid", by: null, x, y });
          break;
        case EVENT.exploded: {
          const big = ev.b === 0;
          this.#explode(x, y, big ? 30 : 18, "#c9b38f", big ? 180 : 140);
          bus?.emit("exploded", { kind: "asteroid", size: big ? "big" : "small", x, y });
          break;
        }
        case EVENT.kill: {
          if (!a) break;
          this.#explode(x, y, 40, PLAYER_COLORS[(a - 1) % PLAYER_COLORS.length] ?? "#fff", 220);
          bus?.emit("exploded", { kind: "ship", playerId: a, killerId: b, x, y });
          const text =
            b && b !== a
              ? `${this.nameOf(b)} збив ${this.nameOf(a)}`
              : `${this.nameOf(a)} розбився`;
          bus?.emit("message", { text });
          break;
        }
        case EVENT.picked: {
          const type = PICKUP_NAME[ev.b];
          if (!a || !type) break;
          bus?.emit("picked", { playerId: a, type, x, y });
          bus?.emit("message", { text: `${this.nameOf(a)}: ${type}` });
          break;
        }
        case EVENT.scored:
          if (a)
            bus?.emit("scored", {
              playerId: a,
              points: ev.b,
              total: this.players.get(a)?.score ?? 0,
              x,
              y,
            });
          break;
        default:
          assertNever(ev.type, "event type");
      }
    }
  }

  #explode(x: number, y: number, count: number, color: string, speed: number): void {
    const explosion = new Explosion({
      pos: new Vector2(x, y),
      rng: this.#fxRng,
      count,
      speed,
      color,
      duration: 1,
    });
    this.#fx.push(explosion);
  }

  // ---- what to draw this frame -----------------------------------------------------------------

  /**
   * A world-like object for render/draw.ts: iterable entities + arena + nameOf().
   * @param alpha fraction of the current 1/30 s step (own-ship smoothing)
   */
  view(alpha: number): DrawableWorld {
    const entities: Drawable[] = [];
    const renderTime = performance.now() + (this.#clockOffset ?? 0) - this.interpDelayMs;
    const newest = this.#buffer.at(-1);
    this.renderLagMs = newest ? newest.time - renderTime : 0;
    const [a, b, t] = this.#bracket(renderTime);
    const confirmed = new Set(
      this.#localBullets.flatMap((lb) => (lb.serverId !== null ? [lb.serverId] : [])),
    );

    if (a) {
      for (const e of a.snap.entities) {
        if (this.predict && e.kind === "ship" && e.playerId === this.slot) continue; // predicted
        if (this.predict && e.kind === "bullet" && e.ownerId === this.slot && confirmed.has(e.id))
          continue;
        const next = b?.byId.get(e.id);
        entities.push(this.#viewEntity(e, next, t));
      }
    }
    if (!this.predict && this.#ownInfo) {
      entities.push(this.#viewEntity(this.#ownInfo, null, 0)); // M1: raw, latest snapshot
    }
    if (this.predict && this.#body && this.#ownInfo) {
      const prev = this.#prevBody ?? this.#body;
      const x = wrapCoord(
        prev.pos.x +
          wrappedDelta(prev.pos.x, this.#body.pos.x, this.arena.width) * alpha +
          this.#offset.x,
        this.arena.width,
      );
      const y = wrapCoord(
        prev.pos.y +
          wrappedDelta(prev.pos.y, this.#body.pos.y, this.arena.height) * alpha +
          this.#offset.y,
        this.arena.height,
      );
      entities.push(
        this.#shipView(
          this.#ownInfo,
          x,
          y,
          lerpAngle(prev.angle, this.#body.angle, alpha),
          this.#body.thrust,
        ),
      );
    }
    for (const lb of this.#localBullets) {
      const homing = Boolean(this.#ownInfo && this.#ownInfo.flags & SHIP_FLAG.homing);
      entities.push(this.#bulletView(lb.pos.x, lb.pos.y, lb.angle, homing));
    }
    entities.push(...this.#fx);
    return {
      arena: this.arena,
      nameOf: (slot) => this.nameOf(slot),
      [Symbol.iterator]: () => entities[Symbol.iterator](),
    };
  }

  /** Two buffered snapshots around `time`, and how far between them (0..1). */
  #bracket(time: number): [Buffered | null, Buffered | null, number] {
    const buf = this.#buffer;
    const first = buf[0];
    if (!first) return [null, null, 0];
    if (time <= first.time) return [first, null, 0];
    for (let i = buf.length - 1; i >= 0; i--) {
      const cur = buf[i];
      if (cur && cur.time <= time) {
        const next = buf[i + 1];
        if (!next) return [cur, null, 0]; // ran out of future: hold the newest (no guessing)
        return [cur, next, (time - cur.time) / (next.time - cur.time)];
      }
    }
    return [first, null, 0];
  }

  #viewEntity(e: EntityState, next: EntityState | null | undefined, t: number): Drawable {
    let x = e.x;
    let y = e.y;
    let angle = e.a;
    if (next) {
      // Lerp through the shorter way around the torus, like render interpolation in Lab 1.
      x = wrapCoord(e.x + wrappedDelta(e.x, next.x, this.arena.width) * t, this.arena.width);
      y = wrapCoord(e.y + wrappedDelta(e.y, next.y, this.arena.height) * t, this.arena.height);
      angle = lerpAngle(e.a, next.a, t);
    }
    switch (e.kind) {
      case "ship":
        return this.#shipView(e, x, y, angle, Boolean(e.flags & SHIP_FLAG.thrust));
      case "bullet":
        return this.#bulletView(x, y, angle, Boolean(e.flags & 1));
      case "asteroid": {
        const small = Boolean(e.flags & 1);
        const asteroid: AsteroidDrawable = {
          ...placed(x, y, angle, small ? 20 : 40),
          kind: "asteroid",
          id: e.id,
          size: small ? "small" : "big",
          seeker: Boolean(e.flags & 2),
          shape: this.#shape(e.id),
        };
        return asteroid;
      }
      case "pickup": {
        const type: PickupType = PICKUP_NAME[e.type] ?? "shield";
        const pickup: PickupDrawable = {
          ...placed(x, y, angle, 14),
          kind: "pickup",
          type,
          spec: PICKUP_TYPES[type],
        };
        return pickup;
      }
      default:
        return assertNever(e, "entity kind");
    }
  }

  #shipView(e: ShipState, x: number, y: number, angle: number, thrust: boolean): ShipDrawable {
    const effects = new Set<PickupType>();
    if (e.flags & SHIP_FLAG.shield) effects.add("shield");
    if (e.flags & SHIP_FLAG.rapid) effects.add("rapid");
    if (e.flags & SHIP_FLAG.homing) effects.add("homing");
    return {
      ...placed(x, y, angle, SHIP_PARAMS.radius),
      kind: "ship",
      playerId: e.playerId,
      color: PLAYER_COLORS[(e.playerId - 1) % PLAYER_COLORS.length] ?? "#fff",
      thrust,
      invulnerable: e.flags & SHIP_FLAG.invulnerable ? 1 : 0,
      effects,
      hp: e.hp,
      maxHp: SHIP_PARAMS.maxHp,
    };
  }

  #bulletView(x: number, y: number, angle: number, homing: boolean): BulletDrawable {
    return {
      ...placed(x, y, angle, 3),
      kind: "bullet",
      behaviors: homing ? [{ name: "homing" }] : [],
    };
  }

  /** Asteroid outlines are cosmetic: derived from the id, so they never travel on the wire. */
  #shape(id: EntityId): readonly number[] {
    let shape = this.#shapes.get(id);
    if (!shape) {
      const rng = createRng(id * 7919);
      shape = Array.from({ length: 11 }, () => rng.range(0.75, 1.15));
      this.#shapes.set(id, shape);
      const oldest = this.#shapes.keys().next();
      if (this.#shapes.size > 500 && !oldest.done) this.#shapes.delete(oldest.value);
    }
    return shape;
  }

  /** Lines for the netgraph overlay. */
  netgraph(): string[] {
    const s = this.stats;
    const age = this.lastSnapshotAt ? performance.now() - this.lastSnapshotAt : 0;
    return [
      `net  rtt ${s.rtt.toFixed(0).padStart(4)} ms   snapshot age ${age.toFixed(0).padStart(4)} ms   tick ${s.serverTick}`,
      `     down ${(s.bytesInPerSec / 1024).toFixed(1).padStart(5)} KB/s   up ${(s.bytesOutPerSec / 1024).toFixed(2).padStart(5)} KB/s   codec ${this.codecName}`,
      `     pending inputs ${String(this.#pending.length).padStart(2)}   correction ${s.correction.toFixed(1).padStart(5)} (avg ${s.correctionAvg.toFixed(1)})   lost snapshots ${s.lostSnapshots}`,
      `     interp delay ${this.interpDelayMs} ms (behind newest ${this.renderLagMs.toFixed(0)} ms)   prediction ${this.predict ? "on" : "OFF"}${this.breakDeterminism ? "   DETERMINISM BROKEN" : ""}`,
    ];
  }
}

/** Position fields of a drawable that is drawn where it is (no previous step to blend from). */
function placed(x: number, y: number, angle: number, radius: number) {
  const pos = { x, y };
  return { pos, prevPos: pos, angle, prevAngle: angle, radius };
}
