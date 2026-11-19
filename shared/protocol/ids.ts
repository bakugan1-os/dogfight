// Branded ids (Lab 6). At runtime every one of these is a plain number; at compile time they
// are different types, so passing a tick where an entity id is expected is an ERROR, not a bug
// to find on the wire. The brands come from zod, so a schema that parses a seq returns a `Seq`.
//
// Each brand has a guard (`isSeq(n): n is Seq`) that checks the real range — the only way to
// make one without an `as` cast.

import { z } from "zod";

export const U8_MAX = 0xff;
export const U16_MAX = 0xffff;
export const U32_MAX = 2 ** 32 - 1;

const int = (min: number, max: number) => z.number().int().min(min).max(max);

/** Entity id on the wire (u16, per world, reused after wrap-around). 0 = none. */
export const EntityIdSchema = int(1, U16_MAX).brand<"EntityId">();
export type EntityId = z.infer<typeof EntityIdSchema>;

/** Player slot in a match (u8). 1..8 in practice. */
export const PlayerIdSchema = int(1, U8_MAX).brand<"PlayerId">();
export type PlayerId = z.infer<typeof PlayerIdSchema>;

/** Simulation tick number (u32). */
export const TickSchema = int(0, U32_MAX).brand<"Tick">();
export type Tick = z.infer<typeof TickSchema>;

/** Input sequence number (u32). 0 = "no input yet" (an ack before the first input). */
export const SeqSchema = int(0, U32_MAX).brand<"Seq">();
export type Seq = z.infer<typeof SeqSchema>;

const inRange = (n: number, min: number, max: number) =>
  Number.isInteger(n) && n >= min && n <= max;

export const isEntityId = (n: number): n is EntityId => inRange(n, 1, U16_MAX);
export const isPlayerId = (n: number): n is PlayerId => inRange(n, 1, U8_MAX);
export const isTick = (n: number): n is Tick => inRange(n, 0, U32_MAX);
export const isSeq = (n: number): n is Seq => inRange(n, 0, U32_MAX);

function make<T extends number>(guard: (n: number) => n is T, name: string) {
  return (n: number): T => {
    if (!guard(n)) throw new RangeError(`${n} is not a valid ${name}`);
    return n;
  };
}

/** Checked constructors: throw on out-of-range numbers (a programming error, not bad input). */
export const entityId = make(isEntityId, "EntityId");
export const playerId = make(isPlayerId, "PlayerId");
export const tick = make(isTick, "Tick");
export const seq = make(isSeq, "Seq");
