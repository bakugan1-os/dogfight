// JSON codec (Lab 5): the same decoded shapes as binary.ts, as text frames. Kept behind
// ?codec=json for the README comparison. Numbers are rounded the way the binary codec quantizes
// them, so both codecs give the client exactly the same picture of the world.
//
// Lab 6: JSON.parse returns `any`; here it goes straight into a zod schema as `unknown`, and the
// TYPE of a decoded snapshot is inferred from that schema — they cannot drift apart.

import { z } from "zod";
import {
  buttonsOf,
  parseInputFields,
  EVENT,
  type Input,
  type Snapshot,
} from "../protocol/messages.ts";
import { EntityIdSchema, PlayerIdSchema, SeqSchema, TickSchema } from "../protocol/ids.ts";
import { CodecError, type Codec } from "./codec.ts";

const round = (x: number, digits: number) => Math.round(x * 10 ** digits) / 10 ** digits;
const byte = z.number().int().min(0).max(255);

const InputFrame = z.object({
  type: z.literal("input"),
  seq: z.number(),
  tick: z.number(),
  b: byte,
});

const common = { id: EntityIdSchema, x: z.number(), y: z.number(), a: z.number() };
const EntityFrame = z.discriminatedUnion("kind", [
  z.object({
    ...common,
    kind: z.literal("ship"),
    playerId: PlayerIdSchema,
    hp: z.number(),
    flags: byte,
    cooldown: z.number(),
    vx: z.number(),
    vy: z.number(),
  }),
  z.object({
    ...common,
    kind: z.literal("bullet"),
    ownerId: PlayerIdSchema,
    flags: byte,
    vx: z.number(),
    vy: z.number(),
    seq: z.number().int().min(0).max(0xffff),
  }),
  z.object({ ...common, kind: z.literal("asteroid"), flags: byte }),
  z.object({ ...common, kind: z.literal("pickup"), type: byte }),
]);

const SnapshotFrame = z.object({
  type: z.literal("snapshot"),
  tick: TickSchema,
  ack: SeqSchema,
  players: z.array(z.object({ id: PlayerIdSchema, score: z.number().int(), respawn: z.number() })),
  entities: z.array(EntityFrame),
  events: z.array(
    z.object({
      type: z.literal(Object.values(EVENT)),
      a: byte,
      b: byte,
      x: z.number(),
      y: z.number(),
    }),
  ),
});

/** JSON.parse that admits what it returns: `unknown`, to be narrowed by a schema. */
function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch (err: unknown) {
    throw new CodecError(`not JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export function encodeInput(input: Input): string {
  return JSON.stringify({ type: "input", seq: input.seq, tick: input.tick, b: buttonsOf(input) });
}

export function decodeInput(text: string): Input {
  const frame = InputFrame.safeParse(parseJson(text));
  if (!frame.success) throw new CodecError("input: bad shape");
  const input = parseInputFields(frame.data.seq, frame.data.tick, frame.data.b);
  if (typeof input === "string") throw new CodecError(`input: ${input}`);
  return input;
}

export function encodeSnapshot(snap: Snapshot): string {
  return JSON.stringify({
    type: "snapshot",
    tick: snap.tick,
    ack: snap.ack,
    players: snap.players,
    entities: snap.entities.map((e) => ({
      ...e,
      x: round(e.x, 2),
      y: round(e.y, 2),
      a: round(e.a, 3),
    })),
    events: snap.events,
  });
}

export function decodeSnapshot(text: string): Snapshot {
  const frame = SnapshotFrame.safeParse(parseJson(text));
  if (!frame.success)
    throw new CodecError(`snapshot: ${frame.error.issues[0]?.message ?? "bad shape"}`);
  const { type: _type, ...snapshot } = frame.data;
  return snapshot;
}

export const jsonCodec: Codec<string> = {
  name: "json",
  encodeInput,
  decodeInput,
  encodeSnapshot,
  decodeSnapshot,
};
