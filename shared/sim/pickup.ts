import { Entity } from "./entity.ts";
import { spin, timeToLive } from "./behaviors.ts";
import type { Vector2 } from "./vector.ts";

/** The pickup types, in wire order (index = code on the wire). `as const` keeps the literals. */
export const PICKUP_TYPE_LIST = ["shield", "rapid", "homing"] as const;
export type PickupType = (typeof PICKUP_TYPE_LIST)[number]; // "shield" | "rapid" | "homing"

export type PickupSpec = {
  readonly duration: number;
  readonly label: string;
  readonly color: string;
};

/**
 * Behavior as data: one table instead of ShieldPickup / RapidPickup / HomingPickup classes.
 * `satisfies` checks that EVERY pickup type has a spec (a missing one is a compile error)
 * without widening the table's own type.
 */
export const PICKUP_TYPES = Object.freeze({
  shield: { duration: 10, label: "S", color: "#6fb7ff" }, // absorbs one hit
  rapid: { duration: 6, label: "R", color: "#ffd166" }, // fire cooldown 0.22 s -> 0.07 s
  homing: { duration: 8, label: "H", color: "#ff7ad9" }, // bullets get the homing behavior
} satisfies Record<PickupType, PickupSpec>);

export const PICKUP_LIFETIME = 14; // s on the field before it disappears

/** Stationary and collidable, but not a ship and not a mover. */
export class Pickup extends Entity<"pickup"> {
  readonly type: PickupType;

  constructor({ pos, type }: { pos: Vector2; type: PickupType }) {
    super({ kind: "pickup", pos, radius: 14 });
    this.type = type;
    this.with(spin(1.5)).with(timeToLive(PICKUP_LIFETIME));
  }

  get spec(): PickupSpec {
    return PICKUP_TYPES[this.type];
  }
}
