// Binary codec (Lab 5, M4; typed in Lab 6). DataView with EXPLICIT little-endian everywhere: the bytes mean the
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
  parseInputFields,
  isEventCode,
  type Input,
  type Snapshot,
  type EntityState,
  type PlayerState,
  type SnapshotEvent,
} from "../protocol/messages.ts";
import { isEntityId, isPlayerId, isSeq, isTick } from "../protocol/ids.ts";
import { assertNever } from "../sim/math.ts";
import { CodecError, type Codec } from "./codec.ts";

export { CodecError };

const LE = true;
const HEADER = 14;
const PLAYER_BYTES = 6;
const EVENT_BYTES = 11;
const ENTITY_BYTES = { ship: 25, bullet: 25, asteroid: 14, pickup: 14 } as const;
const ANGLE_SCALE = 1000;

/** What a binary frame can arrive as: ArrayBuffer (browser), Buffer/Uint8Array (Node). */
export type BinaryFrame = ArrayBuffer | ArrayBufferView;

const toView = (bytes: BinaryFrame): DataView =>
  bytes instanceof ArrayBuffer
    ? new DataView(bytes)
    : new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

const u8 = (v: number) => Math.max(0, Math.min(255, Math.round(v)));
const quantizeAngle = (a: number) => Math.round(a * ANGLE_SCALE);

/** Reads a number and proves it is in range for its branded type — or rejects the frame. */
function expect<T extends number>(guard: (n: number) => n is T, n: number, what: string): T {
  if (!guard(n)) throw new CodecError(`snapshot: bad ${what} ${n}`);
  return n;
}

/** Message type of a binary frame (byte 0), or -1 if empty. */
export function peekType(bytes: BinaryFrame): number {
  const view = toView(bytes);
  return view.byteLength ? view.getUint8(0) : -1;
}

// ---- input ------------------------------------------------------------------------------------

export function encodeInput(input: Input): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(11);
  const v = new DataView(out.buffer);
  v.setUint8(0, MSG.INPUT);
  v.setUint8(1, CODEC_VERSION);
  v.setUint32(2, input.seq, LE);
  v.setUint32(6, input.tick, LE);
  v.setUint8(10, buttonsOf(input));
  return out;
}

export function decodeInput(bytes: BinaryFrame): Input {
  const v = toView(bytes);
  if (v.byteLength !== 11) throw new CodecError(`input: expected 11 bytes, got ${v.byteLength}`);
  if (v.getUint8(0) !== MSG.INPUT) throw new CodecError("input: wrong message type");
  if (v.getUint8(1) !== CODEC_VERSION) throw new CodecError("input: unsupported version");
  const input = parseInputFields(v.getUint32(2, LE), v.getUint32(6, LE), v.getUint8(10));
  if (typeof input === "string") throw new CodecError(`input: ${input}`);
  return input;
}

// ---- snapshot ---------------------------------------------------------------------------------

export function snapshotSize(snap: Snapshot): number {
  let size = HEADER + snap.players.length * PLAYER_BYTES + snap.events.length * EVENT_BYTES;
  for (const e of snap.entities) size += ENTITY_BYTES[e.kind];
  return size;
}

export function encodeSnapshot(snap: Snapshot): Uint8Array<ArrayBuffer> {
  if (snap.entities.length > 0xffff || snap.players.length > 255 || snap.events.length > 255) {
    throw new CodecError("snapshot: too many items");
  }
  const out = new Uint8Array(snapshotSize(snap));
  const v = new DataView(out.buffer);
  v.setUint8(0, MSG.SNAPSHOT);
  v.setUint8(1, CODEC_VERSION);
  v.setUint32(2, snap.tick, LE);
  v.setUint32(6, snap.ack, LE);
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
        v.setUint8(o, e.flags);
        o += 1;
        break;
      case "pickup":
        v.setUint8(o, e.type);
        o += 1;
        break;
      default:
        assertNever(e, "entity kind");
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
export function withAck(bytes: Uint8Array<ArrayBuffer>, ack: number): Uint8Array<ArrayBuffer> {
  const copy = bytes.slice();
  new DataView(copy.buffer).setUint32(6, ack, LE);
  return copy;
}

export function decodeSnapshot(bytes: BinaryFrame): Snapshot {
  const v = toView(bytes);
  const need = (n: number) => {
    if (n > v.byteLength) throw new CodecError(`snapshot: truncated (${v.byteLength} < ${n})`);
  };
  need(HEADER);
  if (v.getUint8(0) !== MSG.SNAPSHOT) throw new CodecError("snapshot: wrong message type");
  if (v.getUint8(1) !== CODEC_VERSION) throw new CodecError("snapshot: unsupported version");
  const players: PlayerState[] = [];
  const entities: EntityState[] = [];
  const events: SnapshotEvent[] = [];
  const playerCount = v.getUint8(10);
  const entityCount = v.getUint16(11, LE);
  const eventCount = v.getUint8(13);
  let o = HEADER;
  need(o + playerCount * PLAYER_BYTES);
  for (let i = 0; i < playerCount; i++, o += PLAYER_BYTES) {
    players.push({
      id: expect(isPlayerId, v.getUint8(o), "player id"),
      score: v.getInt32(o + 1, LE),
      respawn: v.getUint8(o + 5) / 10,
    });
  }
  for (let i = 0; i < entityCount; i++) {
    need(o + 13);
    const code = v.getUint8(o + 2);
    const kind = KIND_NAME[code];
    if (!kind) throw new CodecError(`snapshot: unknown kind code ${code}`);
    need(o + ENTITY_BYTES[kind]);
    const base = {
      id: expect(isEntityId, v.getUint16(o, LE), "entity id"),
      x: v.getFloat32(o + 3, LE),
      y: v.getFloat32(o + 7, LE),
      a: v.getInt16(o + 11, LE) / ANGLE_SCALE,
    };
    o += 13;
    switch (kind) {
      case "ship":
        entities.push({
          ...base,
          kind,
          playerId: expect(isPlayerId, v.getUint8(o), "player id"),
          hp: v.getUint8(o + 1),
          flags: v.getUint8(o + 2),
          cooldown: v.getUint8(o + 3) / 100,
          vx: v.getFloat32(o + 4, LE),
          vy: v.getFloat32(o + 8, LE),
        });
        o += 12;
        break;
      case "bullet":
        entities.push({
          ...base,
          kind,
          ownerId: expect(isPlayerId, v.getUint8(o), "owner id"),
          flags: v.getUint8(o + 1),
          vx: v.getFloat32(o + 2, LE),
          vy: v.getFloat32(o + 6, LE),
          seq: v.getUint16(o + 10, LE),
        });
        o += 12;
        break;
      case "asteroid":
        entities.push({ ...base, kind, flags: v.getUint8(o) });
        o += 1;
        break;
      case "pickup":
        entities.push({ ...base, kind, type: v.getUint8(o) });
        o += 1;
        break;
      default:
        assertNever(kind, "entity kind");
    }
  }
  need(o + eventCount * EVENT_BYTES);
  for (let i = 0; i < eventCount; i++, o += EVENT_BYTES) {
    events.push({
      type: expect(isEventCode, v.getUint8(o), "event type"),
      a: v.getUint8(o + 1),
      b: v.getUint8(o + 2),
      x: v.getFloat32(o + 3, LE),
      y: v.getFloat32(o + 7, LE),
    });
  }
  if (o !== v.byteLength) throw new CodecError(`snapshot: ${v.byteLength - o} trailing bytes`);
  return {
    tick: expect(isTick, v.getUint32(2, LE), "tick"),
    ack: expect(isSeq, v.getUint32(6, LE), "ack"),
    players,
    entities,
    events,
  };
}

export const binaryCodec: Codec<Uint8Array<ArrayBuffer>, BinaryFrame> = {
  name: "binary",
  encodeInput,
  decodeInput,
  encodeSnapshot,
  decodeSnapshot,
};
