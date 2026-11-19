// The closed set of things that live in the world (Lab 6). A discriminated union: every member
// has a literal `kind`, so `if (e.kind === "ship")` narrows `e` to Ship and its fields appear.
// Adding a kind here makes every exhaustive `switch (e.kind)` in the codebase fail to compile
// until it handles the new one.

import type { Ship } from "./ship.ts";
import type { Bullet } from "./bullet.ts";
import type { Asteroid } from "./asteroid.ts";
import type { Pickup } from "./pickup.ts";
import type { Explosion } from "./explosion.ts";

export type AnyEntity = Ship | Bullet | Asteroid | Pickup | Explosion;
export type EntityKind = AnyEntity["kind"];
/** `OfKind<"bullet">` is Bullet — Extract picks the union member(s) with that kind. */
export type OfKind<K extends EntityKind> = Extract<AnyEntity, { kind: K }>;

/** Type guard: narrows a union member by its kind (used by World.ofKind). */
export function isKind<K extends EntityKind>(e: AnyEntity, kind: K): e is OfKind<K> {
  return e.kind === kind;
}
