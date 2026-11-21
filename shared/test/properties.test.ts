// Lab 7: property-based tests (fast-check). Instead of a few hand-picked examples, each property
// is checked on hundreds of GENERATED inputs; when one fails, fast-check SHRINKS it to the
// smallest input that still fails and prints it.

import { test, expect } from "vitest";
import fc from "fast-check";

import * as binary from "../codec/binary.ts";
import * as json from "../codec/json.ts";
import { CodecError } from "../codec/codec.ts";
import {
  EVENT,
  TICK_DT,
  type EntityState,
  type Input,
  type Snapshot,
} from "../protocol/messages.ts";
import { entityId, playerId, seq, tick } from "../protocol/ids.ts";
import { PROTOCOL_VERSION, parseClientMessage, type ClientMessage } from "../protocol/control.ts";
import { World } from "../sim/world.ts";
import { NO_CONTROLS } from "../sim/ship.ts";

// ---- arbitraries: generators of valid protocol values ------------------------------------------

const f32 = fc.float({ noNaN: true, noDefaultInfinity: true, min: -1e6, max: 1e6 });
const angle = fc.double({ noNaN: true, min: -Math.PI, max: Math.PI });
const byte = fc.integer({ min: 0, max: 255 });
const id = fc.integer({ min: 1, max: 0xffff }).map(entityId);
const pid = fc.integer({ min: 1, max: 255 }).map(playerId);
const common = { id, x: f32, y: f32, a: angle };

const entity: fc.Arbitrary<EntityState> = fc.oneof(
  fc.record({
    ...common,
    kind: fc.constant("ship" as const),
    playerId: pid,
    hp: byte,
    flags: fc.integer({ min: 0, max: 31 }),
    cooldown: fc.integer({ min: 0, max: 255 }).map((c) => c / 100),
    vx: f32,
    vy: f32,
  }),
  fc.record({
    ...common,
    kind: fc.constant("bullet" as const),
    ownerId: pid,
    flags: fc.integer({ min: 0, max: 1 }),
    vx: f32,
    vy: f32,
    seq: fc.integer({ min: 0, max: 0xffff }),
  }),
  fc.record({
    ...common,
    kind: fc.constant("asteroid" as const),
    flags: fc.integer({ min: 0, max: 3 }),
  }),
  fc.record({
    ...common,
    kind: fc.constant("pickup" as const),
    type: fc.integer({ min: 0, max: 2 }),
  }),
);

const snapshot: fc.Arbitrary<Snapshot> = fc.record({
  tick: fc.integer({ min: 0, max: 2 ** 32 - 1 }).map(tick),
  ack: fc.integer({ min: 0, max: 2 ** 32 - 1 }).map(seq),
  players: fc.array(
    fc.record({
      id: pid,
      score: fc.integer({ min: -(2 ** 31), max: 2 ** 31 - 1 }),
      respawn: fc.integer({ min: 0, max: 255 }).map((r) => r / 10),
    }),
    { maxLength: 8 },
  ),
  entities: fc.array(entity, { maxLength: 60 }),
  events: fc.array(
    fc.record({ type: fc.constantFrom(...Object.values(EVENT)), a: byte, b: byte, x: f32, y: f32 }),
    { maxLength: 20 },
  ),
});

const input: fc.Arbitrary<Input> = fc.record({
  seq: fc.integer({ min: 1, max: 2 ** 32 - 1 }).map(seq),
  tick: fc.integer({ min: 0, max: 2 ** 32 - 1 }).map(tick),
  thrust: fc.boolean(),
  left: fc.boolean(),
  right: fc.boolean(),
  fire: fc.boolean(),
  firePressed: fc.boolean(),
});

// ---- 1. round-trip -------------------------------------------------------------------------------

test("property: binary snapshot round-trip — exact integers, f32 floats, 1/1000 rad angles", () => {
  fc.assert(
    fc.property(snapshot, (snap) => {
      const back = binary.decodeSnapshot(binary.encodeSnapshot(snap));
      expect(back.tick).toBe(snap.tick);
      expect(back.ack).toBe(snap.ack);
      expect(back.players).toEqual(snap.players);
      expect(back.events).toEqual(
        snap.events.map((e) => ({ ...e, x: Math.fround(e.x), y: Math.fround(e.y) })),
      );
      expect(back.entities).toHaveLength(snap.entities.length);
      snap.entities.forEach((e, i) => {
        const d = back.entities[i];
        expect(d?.kind).toBe(e.kind);
        expect(d?.id).toBe(e.id);
        expect(d?.x).toBe(Math.fround(e.x)); // float32: exactly the nearest f32
        expect(Math.abs((d?.a ?? NaN) - e.a)).toBeLessThanOrEqual(0.0005 + 1e-12);
      });
    }),
    { numRuns: 300 },
  );
});

test("property: input round-trips through BOTH codecs unchanged", () => {
  fc.assert(
    fc.property(input, (i) => {
      expect(binary.decodeInput(binary.encodeInput(i))).toEqual(i);
      expect(json.decodeInput(json.encodeInput(i))).toEqual(i);
    }),
  );
});

// ---- 2. length = the spec ------------------------------------------------------------------------

test("property: encoded length = 14 + 6·P + Σ(25 ship/bullet, 14 rock/pickup) + 11·V", () => {
  const SPEC = { ship: 25, bullet: 25, asteroid: 14, pickup: 14 } as const;
  fc.assert(
    fc.property(snapshot, (snap) => {
      const expected =
        14 +
        6 * snap.players.length +
        11 * snap.events.length +
        snap.entities.reduce((n, e) => n + SPEC[e.kind], 0);
      expect(binary.encodeSnapshot(snap).byteLength).toBe(expected);
    }),
  );
});

// ---- 3. garbage in -> typed error, never a crash -----------------------------------------------

test("property: arbitrary bytes never crash a decoder — they decode or throw CodecError", () => {
  const garbage = fc.oneof(
    fc.uint8Array({ maxLength: 300 }),
    // mostly-valid frames with one byte changed and the end cut: the interesting garbage
    fc.tuple(snapshot, fc.nat(), byte, fc.nat()).map(([snap, at, value, cut]) => {
      const bytes = binary.encodeSnapshot(snap);
      bytes[at % bytes.length] = value;
      return bytes.subarray(0, bytes.length - (cut % 4));
    }),
  );
  fc.assert(
    fc.property(garbage, (bytes) => {
      for (const decode of [binary.decodeSnapshot, binary.decodeInput]) {
        try {
          decode(bytes);
        } catch (error) {
          expect(error).toBeInstanceOf(CodecError);
        }
      }
    }),
    { numRuns: 1000 },
  );
});

test("property: arbitrary strings never crash the JSON codec — CodecError or a valid snapshot", () => {
  fc.assert(
    fc.property(fc.oneof(fc.string(), fc.json()), (text) => {
      try {
        json.decodeSnapshot(text);
      } catch (error) {
        expect(error).toBeInstanceOf(CodecError);
      }
    }),
  );
});

// ---- 4. the simulation keeps its invariants ----------------------------------------------------

test("property: ships stay inside the arena over 1,000 random input steps", () => {
  const controls = fc.record({
    thrust: fc.boolean(),
    left: fc.boolean(),
    right: fc.boolean(),
    fire: fc.boolean(),
    firePressed: fc.boolean(),
  });
  fc.assert(
    fc.property(
      fc.integer({ min: 1, max: 1e6 }),
      fc.array(controls, { minLength: 1000, maxLength: 1000 }),
      (s, steps) => {
        const world = new World({ seed: s });
        const p1 = playerId(1);
        world.addPlayer({ id: p1 });
        for (const c of steps) {
          world.step(TICK_DT, new Map([[p1, { ...NO_CONTROLS, ...c }]]));
          for (const e of world) {
            expect(e.pos.x >= 0 && e.pos.x < world.arena.width).toBe(true);
            expect(e.pos.y >= 0 && e.pos.y < world.arena.height).toBe(true);
            expect(Number.isFinite(e.vel.x) && Number.isFinite(e.vel.y)).toBe(true);
          }
        }
      },
    ),
    { numRuns: 20 },
  );
});

// ---- 5. the parser: accept every valid message, reject every mutation --------------------------

const text = (max: number) =>
  fc.string({ minLength: 1, maxLength: max }).filter((s) => s.trim().length > 0);
const validMessage: fc.Arbitrary<ClientMessage> = fc.oneof(
  fc.record({
    type: fc.constant("join" as const),
    v: fc.constant(PROTOCOL_VERSION),
    room: text(64),
    name: text(16),
  }),
  fc.record({ type: fc.constant("chat" as const), text: text(280) }),
  fc.record({ type: fc.constant("leave" as const) }),
  fc.record({
    type: fc.constant("ping" as const),
    t: fc.double({ min: 0, max: 1e12, noNaN: true }),
  }),
  fc.record({
    type: fc.constant("input" as const),
    seq: fc.integer({ min: 1, max: 2 ** 32 - 1 }),
    tick: fc.integer({ min: 0, max: 2 ** 32 - 1 }),
    b: fc.integer({ min: 0, max: 31 }),
  }),
  fc.record({
    type: fc.constant("netsim" as const),
    lag: fc.integer({ min: 0, max: 2000 }),
    jitter: fc.integer({ min: 0, max: 1000 }),
    drop: fc.double({ min: 0, max: 0.5, noNaN: true }),
  }),
);

test("property: parseClientMessage accepts every generated valid message", () => {
  fc.assert(
    fc.property(validMessage, (msg) => {
      const parsed = parseClientMessage(JSON.stringify(msg));
      expect(parsed.ok).toBe(true);
      if (parsed.ok) expect(parsed.msg.type).toBe(msg.type);
    }),
  );
});

test("property: …and rejects every mutation of one (extra field, wrong type, out of range, missing)", () => {
  const mutation = fc.constantFrom("extra", "typeName", "number", "drop", "huge");
  fc.assert(
    fc.property(validMessage, mutation, (msg, how) => {
      const m: Record<string, unknown> = { ...msg };
      const fields = Object.keys(m).filter((k) => k !== "type");
      switch (how) {
        case "extra":
          m.admin = true; // unknown keys are refused (strictObject)
          break;
        case "typeName":
          m.type = `${String(m.type)}!`;
          break;
        case "number": {
          const k = fields[0];
          if (!k) return; // "leave" has no fields: nothing to mutate this way
          m[k] = typeof m[k] === "number" ? "1" : 1; // wrong JSON type
          break;
        }
        case "drop": {
          const k = fields[0];
          if (!k) return;
          delete m[k];
          break;
        }
        case "huge": {
          const k = fields.find((f) => typeof m[f] === "number" || typeof m[f] === "string");
          if (!k) return;
          m[k] = typeof m[k] === "number" ? 1e300 : "x".repeat(1000);
          break;
        }
      }
      expect(parseClientMessage(JSON.stringify(m)).ok).toBe(false);
    }),
    { numRuns: 500 },
  );
});
