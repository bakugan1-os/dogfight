// Real-time protocol (Lab 5). Shared by client and server: one definition of the numbers.
//
// Two kinds of traffic on the same WebSocket:
//   - control messages (join, roster, chat, ping…) stay JSON text frames — rare, human-readable;
//     their zod schemas live in control.ts;
//   - the hot path — INPUT up (30/s per player) and SNAPSHOT down (30/s per player) — goes through
//     a codec: binary DataView frames (default) or JSON (for comparison, ?codec=json).
//
// Lab 6: the decoded shapes are TYPES now (below). Whatever the codec, the rest of the code
// sees an `Input` and a `Snapshot` — and only after a decoder has checked every field.

import { PICKUP_TYPE_LIST, type PickupType } from "../sim/pickup.ts";
import type { Controls } from "../sim/ship.ts";
import { isSeq, isTick, seq, type EntityId, type PlayerId, type Seq, type Tick } from "./ids.ts";

export const TICK_RATE = 30; // server ticks per second
export const TICK_DT = 1 / TICK_RATE; // fixed simulation step on BOTH sides
export const TICK_MS = 1000 / TICK_RATE;

/** Byte 0 of every binary frame. */
export const MSG = Object.freeze({ SNAPSHOT: 1, INPUT: 2 } as const);
export const CODEC_VERSION = 1;

/** Entity kinds that travel in snapshots (explosions are visual only: events, not state). */
export const KIND = Object.freeze({ ship: 1, bullet: 2, asteroid: 3, pickup: 4 } as const);
export type NetKind = keyof typeof KIND;
export const KIND_NAME: Readonly<Record<number, NetKind | undefined>> = Object.freeze({
  1: "ship",
  2: "bullet",
  3: "asteroid",
  4: "pickup",
} satisfies Record<(typeof KIND)[NetKind], NetKind>);

export const PICKUP_CODE = Object.freeze({ shield: 0, rapid: 1, homing: 2 } satisfies Record<
  PickupType,
  number
>);
/** Code -> pickup type: the code is the index in PICKUP_TYPE_LIST. */
export const PICKUP_NAME = PICKUP_TYPE_LIST;

/** Ship flag bits. */
export const SHIP_FLAG = Object.freeze({
  thrust: 1,
  invulnerable: 2,
  shield: 4,
  rapid: 8,
  homing: 16,
});

/** Input button bits. Bits 5–7 are reserved and must be 0. */
export const BUTTON = Object.freeze({ thrust: 1, left: 2, right: 4, fire: 8, firePressed: 16 });
export type Button = keyof typeof BUTTON;
export const BUTTON_MASK = 0b11111;

/** Gameplay events carried inside snapshots (sounds, explosions, kill feed). */
export const EVENT = Object.freeze({
  fired: 1,
  hit: 2,
  exploded: 3,
  picked: 4,
  scored: 5,
  kill: 6,
} as const);
export type EventName = keyof typeof EVENT;
export type EventCode = (typeof EVENT)[EventName];

export const MAX_SEQ = 2 ** 32 - 1;
export const NO_SEQ: Seq = seq(0);

// ---- decoded shapes ---------------------------------------------------------------------------

/** One input from a client: the buttons held during one client tick. */
export type Input = Readonly<{
  seq: Seq;
  tick: Tick;
  thrust: boolean;
  left: boolean;
  right: boolean;
  fire: boolean;
  firePressed: boolean;
}>;

type Common = { readonly id: EntityId; readonly x: number; readonly y: number; readonly a: number };
export type ShipState = Common &
  Readonly<{
    kind: "ship";
    playerId: PlayerId;
    hp: number;
    flags: number;
    cooldown: number;
    vx: number;
    vy: number;
  }>;
export type BulletState = Common &
  Readonly<{
    kind: "bullet";
    ownerId: PlayerId;
    flags: number;
    vx: number;
    vy: number;
    seq: number;
  }>;
export type AsteroidState = Common & Readonly<{ kind: "asteroid"; flags: number }>;
export type PickupState = Common & Readonly<{ kind: "pickup"; type: number }>;
/** A discriminated union on `kind`: check the kind and the other fields become available. */
export type EntityState = ShipState | BulletState | AsteroidState | PickupState;

export type PlayerState = Readonly<{ id: PlayerId; score: number; respawn: number }>;

/** `a` and `b` are small numbers whose meaning depends on the type (see snapshot.ts). */
export type SnapshotEvent = Readonly<{
  type: EventCode;
  a: number;
  b: number;
  x: number;
  y: number;
}>;

export type Snapshot = Readonly<{
  tick: Tick;
  /** last input seq the server processed FOR THIS CLIENT */
  ack: Seq;
  players: readonly PlayerState[];
  entities: readonly EntityState[];
  events: readonly SnapshotEvent[];
}>;

const EVENT_CODES: ReadonlySet<number> = new Set(Object.values(EVENT));
export const isEventCode = (n: number): n is EventCode => EVENT_CODES.has(n);

// ---- buttons ----------------------------------------------------------------------------------

export function buttonsOf(input: Omit<Controls, "seq">): number {
  let bits = 0;
  if (input.thrust) bits |= BUTTON.thrust;
  if (input.left) bits |= BUTTON.left;
  if (input.right) bits |= BUTTON.right;
  if (input.fire) bits |= BUTTON.fire;
  if (input.firePressed) bits |= BUTTON.firePressed;
  return bits;
}

export function inputFromButtons(seq: Seq, tick: Tick, bits: number): Input {
  return {
    seq,
    tick,
    thrust: Boolean(bits & BUTTON.thrust),
    left: Boolean(bits & BUTTON.left),
    right: Boolean(bits & BUTTON.right),
    fire: Boolean(bits & BUTTON.fire),
    firePressed: Boolean(bits & BUTTON.firePressed),
  };
}

/**
 * Validates raw input numbers from a decoder. Returns the typed Input or a reason string.
 * (A "turn of 1000" cannot even be expressed: turning is two bits, not a number.)
 */
export function parseInputFields(rawSeq: number, rawTick: number, bits: number): Input | string {
  if (!isSeq(rawSeq) || rawSeq < 1) return "bad seq";
  if (!isTick(rawTick)) return "bad tick";
  if (!Number.isInteger(bits) || bits < 0 || bits & ~BUTTON_MASK) return "reserved button bits set";
  return inputFromButtons(rawSeq, rawTick, bits);
}
