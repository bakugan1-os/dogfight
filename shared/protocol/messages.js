// Real-time protocol (Lab 5). Shared by client and server: one definition of the numbers.
//
// Two kinds of traffic on the same WebSocket:
//   - control messages (join, roster, chat, ping…) stay JSON text frames — rare, human-readable;
//   - the hot path — INPUT up (30/s per player) and SNAPSHOT down (30/s per player) — goes through
//     a codec: binary DataView frames (default) or JSON (for comparison, ?codec=json).
//
// The decoded shapes below are what the rest of the code sees, whatever the codec.
//
//   input    { seq, tick, thrust, left, right, fire, firePressed }
//   snapshot { tick, ack, players: [{ id, score, respawn }],
//              entities: [{ id, kind, x, y, a, ...kind fields }], events: [{ type, a, b, x, y }] }

export const TICK_RATE = 30; // server ticks per second
export const TICK_DT = 1 / TICK_RATE; // fixed simulation step on BOTH sides
export const TICK_MS = 1000 / TICK_RATE;

/** Byte 0 of every binary frame. */
export const MSG = Object.freeze({ SNAPSHOT: 1, INPUT: 2 });
export const CODEC_VERSION = 1;

export const KIND = Object.freeze({ ship: 1, bullet: 2, asteroid: 3, pickup: 4 });
export const KIND_NAME = Object.freeze(
  Object.fromEntries(Object.entries(KIND).map(([k, v]) => [v, k])),
);

export const PICKUP_CODE = Object.freeze({ shield: 0, rapid: 1, homing: 2 });
export const PICKUP_NAME = Object.freeze(["shield", "rapid", "homing"]);

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
export const BUTTON_MASK = 0b11111;

/** Gameplay events carried inside snapshots (sounds, explosions, kill feed). */
export const EVENT = Object.freeze({
  fired: 1,
  hit: 2,
  exploded: 3,
  picked: 4,
  scored: 5,
  kill: 6,
});
export const EVENT_NAME = Object.freeze(
  Object.fromEntries(Object.entries(EVENT).map(([k, v]) => [v, k])),
);

export const MAX_SEQ = 2 ** 32 - 1;

export function buttonsOf(input) {
  let bits = 0;
  for (const [name, bit] of Object.entries(BUTTON)) if (input[name]) bits |= bit;
  return bits;
}

export function inputFromButtons(seq, tick, bits) {
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
 * Validates a decoded input: the server never trusts it. Returns a reason string or null.
 * (A "turn of 1000" cannot even be expressed: turning is two booleans, not a number.)
 */
export function inputProblem(input) {
  if (!input || typeof input !== "object") return "not an object";
  if (!Number.isInteger(input.seq) || input.seq < 1 || input.seq > MAX_SEQ) return "bad seq";
  if (!Number.isInteger(input.tick) || input.tick < 0 || input.tick > MAX_SEQ) return "bad tick";
  for (const name of Object.keys(BUTTON)) {
    if (typeof input[name] !== "boolean") return `bad ${name}`;
  }
  return null;
}
