// Binary codec (Lab 5, M4). DataView with EXPLICIT little-endian everywhere: the bytes mean the
// same thing on every CPU. Typed arrays (Float32Array…) use the platform's byte order, which is
// fine inside one machine and wrong on the wire.
//
// ── SPEC v1 ──────────────────────────────────────────────────────────────────────────────────
// All multi-byte numbers little-endian. f32 = IEEE-754 float32, angle = i16 in 1/1000 rad
// (precision 0.001 rad ≈ 0.057°, range ±3.142 fits in ±32767).
//
// INPUT (client → server), 11 bytes:
//   0  u8   type = 2            1  u8   version = 1
//   2  u32  seq                 6  u32  client tick
//   10 u8   buttons: bit0 thrust, bit1 left, bit2 right, bit3 fire, bit4 firePressed, bits5-7 = 0
//
// SNAPSHOT (server → client), 14-byte header, then three sections:
//   0  u8   type = 1            1  u8   version = 1
//   2  u32  server tick         6  u32  ack = last input seq the server processed FOR THIS CLIENT
//   10 u8   player count P      11 u16  entity count E          13 u8  event count V
//   players  × P, 6 B:  u8 id, i32 score, u8 respawn (1/10 s)
//   entities × E, 13 B common: u16 id, u8 kind, f32 x, f32 y, i16 angle
//     ship     +12 B:  u8 playerId, u8 hp, u8 flags (thrust|invuln|shield|rapid|homing),
//                      u8 cooldown (1/100 s), f32 vx, f32 vy                       = 25 B
//     bullet   +12 B:  u8 ownerId, u8 flags (bit0 homing), f32 vx, f32 vy, u16 seq = 25 B
//     asteroid  +1 B:  u8 flags (bit0 small, bit1 seeker)                          = 14 B
//     pickup    +1 B:  u8 type (0 shield, 1 rapid, 2 homing)                       = 14 B
//   events   × V, 11 B: u8 type, u8 a, u8 b, f32 x, f32 y
// ─────────────────────────────────────────────────────────────────────────────────────────────

import {
  MSG,
  CODEC_VERSION,
  KIND,
  KIND_NAME,
  buttonsOf,
  inputFromButtons,
  BUTTON_MASK,
} from "../protocol/messages.js";

const LE = true;
const HEADER = 14;
const PLAYER_BYTES = 6;
const EVENT_BYTES = 11;
const ENTITY_BYTES = { ship: 25, bullet: 25, asteroid: 14, pickup: 14 };
const ANGLE_SCALE = 1000;

export class CodecError extends Error {
  constructor(message) {
    super(message);
    this.name = "CodecError";
  }
}

const toView = (bytes) =>
  bytes instanceof ArrayBuffer
    ? new DataView(bytes)
    : new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

const u8 = (v) => Math.max(0, Math.min(255, Math.round(v)));
const quantizeAngle = (a) => Math.round(a * ANGLE_SCALE);

/** Message type of a binary frame (byte 0), or -1 if empty. */
export function peekType(bytes) {
  const view = toView(bytes);
  return view.byteLength ? view.getUint8(0) : -1;
}

// ---- input ------------------------------------------------------------------------------------

export function encodeInput(input) {
  const out = new Uint8Array(11);
  const v = new DataView(out.buffer);
  v.setUint8(0, MSG.INPUT);
  v.setUint8(1, CODEC_VERSION);
  v.setUint32(2, input.seq, LE);
  v.setUint32(6, input.tick, LE);
  v.setUint8(10, buttonsOf(input));
  return out;
}

export function decodeInput(bytes) {
  const v = toView(bytes);
  if (v.byteLength !== 11) throw new CodecError(`input: expected 11 bytes, got ${v.byteLength}`);
  if (v.getUint8(0) !== MSG.INPUT) throw new CodecError("input: wrong message type");
  if (v.getUint8(1) !== CODEC_VERSION) throw new CodecError("input: unsupported version");
  const buttons = v.getUint8(10);
  if (buttons & ~BUTTON_MASK) throw new CodecError("input: reserved button bits set");
  return inputFromButtons(v.getUint32(2, LE), v.getUint32(6, LE), buttons);
}

// ---- snapshot ---------------------------------------------------------------------------------

export function snapshotSize(snap) {
  let size = HEADER + snap.players.length * PLAYER_BYTES + snap.events.length * EVENT_BYTES;
  for (const e of snap.entities) size += ENTITY_BYTES[e.kind];
  return size;
}

export function encodeSnapshot(snap) {
  if (snap.entities.length > 0xffff || snap.players.length > 255 || snap.events.length > 255) {
    throw new CodecError("snapshot: too many items");
  }
  const out = new Uint8Array(snapshotSize(snap));
  const v = new DataView(out.buffer);
  v.setUint8(0, MSG.SNAPSHOT);
  v.setUint8(1, CODEC_VERSION);
  v.setUint32(2, snap.tick, LE);
  v.setUint32(6, snap.ack ?? 0, LE);
  v.setUint8(10, snap.players.length);
  v.setUint16(11, snap.entities.length, LE);
  v.setUint8(13, snap.events.length);
  let o = HEADER;
  for (const p of snap.players) {
    v.setUint8(o, p.id);
    v.setInt32(o + 1, p.score, LE);
    v.setUint8(o + 5, u8(p.respawn * 10));
    o += PLAYER_BYTES;
  }
  for (const e of snap.entities) {
    v.setUint16(o, e.id, LE);
    v.setUint8(o + 2, KIND[e.kind]);
    v.setFloat32(o + 3, e.x, LE);
    v.setFloat32(o + 7, e.y, LE);
    v.setInt16(o + 11, quantizeAngle(e.a), LE);
    o += 13;
    switch (e.kind) {
      case "ship":
        v.setUint8(o, e.playerId);
        v.setUint8(o + 1, u8(e.hp));
        v.setUint8(o + 2, e.flags);
        v.setUint8(o + 3, u8(e.cooldown * 100));
        v.setFloat32(o + 4, e.vx, LE);
        v.setFloat32(o + 8, e.vy, LE);
        o += 12;
        break;
      case "bullet":
        v.setUint8(o, e.ownerId);
        v.setUint8(o + 1, e.flags);
        v.setFloat32(o + 2, e.vx, LE);
        v.setFloat32(o + 6, e.vy, LE);
        v.setUint16(o + 10, e.seq & 0xffff, LE);
        o += 12;
        break;
      case "asteroid":
      case "pickup":
        v.setUint8(o, e.kind === "asteroid" ? e.flags : e.type);
        o += 1;
        break;
      default:
        throw new CodecError(`snapshot: unknown kind ${e.kind}`);
    }
  }
  for (const ev of snap.events) {
    v.setUint8(o, ev.type);
    v.setUint8(o + 1, ev.a);
    v.setUint8(o + 2, ev.b);
    v.setFloat32(o + 3, ev.x, LE);
    v.setFloat32(o + 7, ev.y, LE);
    o += EVENT_BYTES;
  }
  return out;
}

/** The server encodes a snapshot ONCE and patches the per-client ack in a copy. */
export function withAck(bytes, ack) {
  const copy = bytes.slice();
  new DataView(copy.buffer).setUint32(6, ack, LE);
  return copy;
}

export function decodeSnapshot(bytes) {
  const v = toView(bytes);
  const need = (n) => {
    if (n > v.byteLength) throw new CodecError(`snapshot: truncated (${v.byteLength} < ${n})`);
  };
  need(HEADER);
  if (v.getUint8(0) !== MSG.SNAPSHOT) throw new CodecError("snapshot: wrong message type");
  if (v.getUint8(1) !== CODEC_VERSION) throw new CodecError("snapshot: unsupported version");
  const snap = {
    tick: v.getUint32(2, LE),
    ack: v.getUint32(6, LE),
    players: [],
    entities: [],
    events: [],
  };
  const playerCount = v.getUint8(10);
  const entityCount = v.getUint16(11, LE);
  const eventCount = v.getUint8(13);
  let o = HEADER;
  need(o + playerCount * PLAYER_BYTES);
  for (let i = 0; i < playerCount; i++, o += PLAYER_BYTES) {
    snap.players.push({
      id: v.getUint8(o),
      score: v.getInt32(o + 1, LE),
      respawn: v.getUint8(o + 5) / 10,
    });
  }
  for (let i = 0; i < entityCount; i++) {
    need(o + 13);
    const kind = KIND_NAME[v.getUint8(o + 2)];
    if (!kind) throw new CodecError(`snapshot: unknown kind code ${v.getUint8(o + 2)}`);
    need(o + ENTITY_BYTES[kind]);
    const e = {
      id: v.getUint16(o, LE),
      kind,
      x: v.getFloat32(o + 3, LE),
      y: v.getFloat32(o + 7, LE),
      a: v.getInt16(o + 11, LE) / ANGLE_SCALE,
    };
    o += 13;
    if (kind === "ship") {
      e.playerId = v.getUint8(o);
      e.hp = v.getUint8(o + 1);
      e.flags = v.getUint8(o + 2);
      e.cooldown = v.getUint8(o + 3) / 100;
      e.vx = v.getFloat32(o + 4, LE);
      e.vy = v.getFloat32(o + 8, LE);
      o += 12;
    } else if (kind === "bullet") {
      e.ownerId = v.getUint8(o);
      e.flags = v.getUint8(o + 1);
      e.vx = v.getFloat32(o + 2, LE);
      e.vy = v.getFloat32(o + 6, LE);
      e.seq = v.getUint16(o + 10, LE);
      o += 12;
    } else {
      if (kind === "asteroid") e.flags = v.getUint8(o);
      else e.type = v.getUint8(o);
      o += 1;
    }
    snap.entities.push(e);
  }
  need(o + eventCount * EVENT_BYTES);
  for (let i = 0; i < eventCount; i++, o += EVENT_BYTES) {
    snap.events.push({
      type: v.getUint8(o),
      a: v.getUint8(o + 1),
      b: v.getUint8(o + 2),
      x: v.getFloat32(o + 3, LE),
      y: v.getFloat32(o + 7, LE),
    });
  }
  if (o !== v.byteLength) throw new CodecError(`snapshot: ${v.byteLength - o} trailing bytes`);
  return snap;
}
