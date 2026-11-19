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
} from "@dogfight/shared/protocol/messages.js";
import * as binary from "@dogfight/shared/codec/binary.js";
import * as json from "@dogfight/shared/codec/json.js";
import {
  bodyFromSnapshot,
  cloneBody,
  predictStep,
  bulletFrom,
} from "@dogfight/shared/sim/predict.js";
import { BULLET_TTL } from "@dogfight/shared/sim/bullet.js";
import { SHIP_PARAMS } from "@dogfight/shared/sim/ship.js";
import { PICKUP_TYPES } from "@dogfight/shared/sim/pickup.js";
import { PLAYER_COLORS } from "@dogfight/shared/sim/arenas.js";
import { Explosion } from "@dogfight/shared/sim/explosion.js";
import { createRng } from "@dogfight/shared/sim/rng.js";
import { Vector2 } from "@dogfight/shared/sim/vector.js";
import { wrappedDelta, wrapCoord, wrapPosition } from "@dogfight/shared/sim/arena.js";
import { lerpAngle } from "@dogfight/shared/sim/math.js";

const SMOOTHING_RATE = 30; // 1/s: a correction fades to 5 % in 100 ms (e^-3)
const TELEPORT = 150; // units: bigger corrections (respawn) snap instead of gliding
const BUFFER_MS = 1500; // snapshots kept for interpolation

const lerp = (a, b, t) => a + (b - a) * t;

export class NetGame {
  #codec;
  #seq = 0;
  #pending = []; // [{ seq, controls }] sent but not yet acknowledged
  #body = null; // predicted own ship (current step)
  #prevBody = null; // previous step, for render interpolation inside a step
  #offset = { x: 0, y: 0 }; // visual smoothing of corrections
  #ownInfo = null; // own ship's latest server fields (hp, flags)
  #localBullets = [];
  #buffer = []; // [{ time (server ms), arrival, snap, byId }]
  #clockOffset = null; // server ms − performance.now(), smoothed
  #fx = [];
  #fxRng = createRng(7);
  #shapes = new Map();
  #names = new Map(); // slot -> name
  #unsubscribe = [];
  #pingTimer = null;
  #lastSnapshotTick = 0;

  constructor({ conn, arena, slot, codec = "binary", interpDelayMs = 100, bus, flags = {} }) {
    this.conn = conn;
    this.arena = arena;
    this.slot = slot;
    this.#codec = codec === "json" ? json : binary;
    this.codecName = codec;
    this.interpDelayMs = interpDelayMs;
    this.bus = bus;
    this.predict = flags.predict !== false; // ?predict=0 -> the M1 "dumb client"
    this.breakDeterminism = Boolean(flags.breakDeterminism); // ?breakdet=1, the M2 experiment
    this.players = new Map(); // slot -> { score, respawn }
    this.corrections = []; // correction magnitude per snapshot, for the netgraph sparkline
    this.stats = {
      rtt: 0,
      correction: 0,
      correctionAvg: 0,
      snapshots: 0,
      lostSnapshots: 0,
      serverTick: 0,
      bytesInPerSec: 0,
      bytesOutPerSec: 0,
    };
    this.#unsubscribe = [
      conn.on("binary", (buf) => this.#onSnapshot(buf)),
      conn.on("realtime", (text) => this.#onSnapshot(text)),
      conn.on("pong", (msg) => {
        const rtt = performance.now() - msg.t;
        this.stats.rtt = this.stats.rtt ? lerp(this.stats.rtt, rtt, 0.3) : rtt;
      }),
    ];
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

  setNames(roster) {
    this.#names = new Map(roster.filter((p) => p.slot != null).map((p) => [p.slot, p.name]));
  }

  nameOf(slot) {
    return this.#names.get(slot) ?? `P${slot}`;
  }

  get pendingInputs() {
    return this.#pending.length;
  }

  get alive() {
    return this.#body !== null;
  }

  dispose() {
    this.#unsubscribe.forEach((off) => off());
    clearInterval(this.#pingTimer);
  }

  // ---- input + prediction, once per 1/30 s step -------------------------------------------------

  step(controls) {
    const seq = ++this.#seq;
    const input = { seq, tick: this.#estimatedTick(), ...controls };
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
        this.bus?.dispatchEvent(
          new CustomEvent("fired", { detail: { playerId: this.slot, x: b.pos.x, y: b.pos.y } }),
        );
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
  #predict(body, controls) {
    const fired = predictStep(body, controls, TICK_DT, this.arena);
    if (this.breakDeterminism) {
      // M2 experiment: "Math.random() in integrate" — in the CLIENT's copy only (prediction AND
      // replay), so client and server compute different things from the same inputs.
      body.angle += (Math.random() - 0.5) * 0.2; // a "harmless" wobble of up to ±0.1 rad
    }
    return fired;
  }

  #estimatedTick() {
    if (this.#clockOffset === null) return 0;
    return Math.max(0, Math.round((performance.now() + this.#clockOffset) / TICK_MS));
  }

  // ---- snapshots: reconciliation + buffer for interpolation ------------------------------------

  #onSnapshot(frame) {
    let snap;
    try {
      snap = this.#codec.decodeSnapshot(frame);
    } catch (error) {
      console.warn("[net] bad snapshot", error.message);
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
    while (this.#buffer.length > 2 && this.#buffer[0].time < time - BUFFER_MS) this.#buffer.shift();

    for (const p of snap.players) this.players.set(p.id, p);
    this.#reconcile(snap);
    this.#confirmBullets(snap);
    this.#playEvents(snap.events);
  }

  #reconcile(snap) {
    const own = snap.entities.find((e) => e.kind === "ship" && e.playerId === this.slot);
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
  #confirmBullets(snap) {
    const mine = new Map();
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

  #playEvents(events) {
    const emit = (type, detail) => this.bus?.dispatchEvent(new CustomEvent(type, { detail }));
    for (const ev of events) {
      switch (ev.type) {
        case EVENT.fired:
          if (ev.a !== this.slot || !this.predict)
            emit("fired", { playerId: ev.a, x: ev.x, y: ev.y });
          break;
        case EVENT.hit:
          emit("hit", {
            target: ev.a === KIND.ship ? "ship" : "asteroid",
            playerId: ev.b,
            x: ev.x,
            y: ev.y,
          });
          break;
        case EVENT.exploded: {
          const big = ev.b === 0;
          this.#explode(ev.x, ev.y, big ? 30 : 18, "#c9b38f", big ? 180 : 140);
          emit("exploded", { kind: "asteroid", size: big ? "big" : "small", x: ev.x, y: ev.y });
          break;
        }
        case EVENT.kill: {
          this.#explode(ev.x, ev.y, 40, PLAYER_COLORS[(ev.a - 1) % PLAYER_COLORS.length], 220);
          emit("exploded", { kind: "ship", playerId: ev.a, x: ev.x, y: ev.y });
          const text =
            ev.b && ev.b !== ev.a
              ? `${this.nameOf(ev.b)} збив ${this.nameOf(ev.a)}`
              : `${this.nameOf(ev.a)} розбився`;
          emit("message", { text });
          break;
        }
        case EVENT.picked:
          emit("picked", { playerId: ev.a, type: PICKUP_NAME[ev.b], x: ev.x, y: ev.y });
          emit("message", { text: `${this.nameOf(ev.a)}: ${PICKUP_NAME[ev.b]}` });
          break;
        case EVENT.scored:
          emit("scored", { playerId: ev.a, points: ev.b, x: ev.x, y: ev.y });
          break;
      }
    }
  }

  #explode(x, y, count, color, speed) {
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
   * A world-like object for render/draw.js: iterable entities + arena + nameOf().
   * @param {number} alpha  fraction of the current 1/30 s step (own-ship smoothing)
   */
  view(alpha) {
    const entities = [];
    const renderTime = performance.now() + (this.#clockOffset ?? 0) - this.interpDelayMs;
    this.renderLagMs = this.#buffer.length ? this.#buffer.at(-1).time - renderTime : 0;
    const [a, b, t] = this.#bracket(renderTime);
    const confirmed = new Set(
      this.#localBullets.map((lb) => lb.serverId).filter((id) => id !== null),
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
    const game = this;
    return {
      arena: this.arena,
      nameOf: (slot) => game.nameOf(slot),
      [Symbol.iterator]: () => entities[Symbol.iterator](),
    };
  }

  /** Two buffered snapshots around `time`, and how far between them (0..1). */
  #bracket(time) {
    const buf = this.#buffer;
    if (!buf.length) return [null, null, 0];
    if (time <= buf[0].time) return [buf[0], null, 0];
    for (let i = buf.length - 1; i >= 0; i--) {
      if (buf[i].time <= time) {
        const next = buf[i + 1];
        if (!next) return [buf[i], null, 0]; // ran out of future: hold the newest (no guessing)
        return [buf[i], next, (time - buf[i].time) / (next.time - buf[i].time)];
      }
    }
    return [buf[0], null, 0];
  }

  #viewEntity(e, next, t) {
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
        return this.#plain("asteroid", x, y, angle, small ? 20 : 40, {
          id: e.id,
          size: small ? "small" : "big",
          seeker: Boolean(e.flags & 2),
          shape: this.#shape(e.id),
        });
      }
      case "pickup": {
        const type = PICKUP_NAME[e.type] ?? "shield";
        return this.#plain("pickup", x, y, angle, 14, { type, spec: PICKUP_TYPES[type] });
      }
    }
    return this.#plain(e.kind, x, y, angle, 0);
  }

  #plain(kind, x, y, angle, radius, extra = {}) {
    const pos = { x, y };
    return { kind, pos, prevPos: pos, angle, prevAngle: angle, radius, behaviors: [], ...extra };
  }

  #shipView(e, x, y, angle, thrust) {
    const effects = new Set();
    if (e.flags & SHIP_FLAG.shield) effects.add("shield");
    if (e.flags & SHIP_FLAG.rapid) effects.add("rapid");
    if (e.flags & SHIP_FLAG.homing) effects.add("homing");
    return this.#plain("ship", x, y, angle, SHIP_PARAMS.radius, {
      playerId: e.playerId,
      color: PLAYER_COLORS[(e.playerId - 1) % PLAYER_COLORS.length],
      thrust,
      invulnerable: e.flags & SHIP_FLAG.invulnerable ? 1 : 0,
      effects,
      hp: e.hp,
      maxHp: SHIP_PARAMS.maxHp,
    });
  }

  #bulletView(x, y, angle, homing) {
    return this.#plain("bullet", x, y, angle, 3, { behaviors: homing ? [{ name: "homing" }] : [] });
  }

  /** Asteroid outlines are cosmetic: derived from the id, so they never travel on the wire. */
  #shape(id) {
    let shape = this.#shapes.get(id);
    if (!shape) {
      const rng = createRng(id * 7919);
      shape = Array.from({ length: 11 }, () => rng.range(0.75, 1.15));
      this.#shapes.set(id, shape);
      if (this.#shapes.size > 500) this.#shapes.delete(this.#shapes.keys().next().value);
    }
    return shape;
  }

  /** Lines for the netgraph overlay. */
  netgraph() {
    const s = this.stats;
    const age = this.lastSnapshotAt ? performance.now() - this.lastSnapshotAt : 0;
    return [
      `net  rtt ${s.rtt.toFixed(0).padStart(4)} ms   snapshot age ${age.toFixed(0).padStart(4)} ms   tick ${s.serverTick}`,
      `     down ${(s.bytesInPerSec / 1024).toFixed(1).padStart(5)} KB/s   up ${(s.bytesOutPerSec / 1024).toFixed(2).padStart(5)} KB/s   codec ${this.codecName}`,
      `     pending inputs ${String(this.#pending.length).padStart(2)}   correction ${s.correction.toFixed(1).padStart(5)} (avg ${s.correctionAvg.toFixed(1)})   lost snapshots ${s.lostSnapshots}`,
      `     interp delay ${this.interpDelayMs} ms (behind newest ${this.renderLagMs?.toFixed(0) ?? 0} ms)   prediction ${this.predict ? "on" : "OFF"}${this.breakDeterminism ? "   DETERMINISM BROKEN" : ""}`,
    ];
  }
}
