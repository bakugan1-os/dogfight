import { Entity } from "./entity.js";
import { spin, timeToLive } from "./behaviors.js";

/** Behavior as data: one table instead of ShieldPickup / RapidPickup / HomingPickup classes. */
export const PICKUP_TYPES = Object.freeze({
  shield: { duration: 10, label: "S", color: "#6fb7ff" }, // absorbs one hit
  rapid: { duration: 6, label: "R", color: "#ffd166" }, // fire cooldown 0.22 s -> 0.07 s
  homing: { duration: 8, label: "H", color: "#ff7ad9" }, // bullets get the homing behavior
});

export const PICKUP_LIFETIME = 14; // s on the field before it disappears

/** Stationary and collidable, but not a ship and not a mover. */
export class Pickup extends Entity {
  constructor({ pos, type }) {
    super({ kind: "pickup", pos, radius: 14 });
    this.type = type;
    this.with(spin(1.5)).with(timeToLive(PICKUP_LIFETIME));
  }

  get spec() {
    return PICKUP_TYPES[this.type];
  }
}
