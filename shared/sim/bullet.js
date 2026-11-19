import { Entity } from "./entity.js";
import { timeToLive } from "./behaviors.js";

export const BULLET_TTL = 1.1; // s — ~700 units of travel, less than the arena width

export class Bullet extends Entity {
  constructor({ pos, vel, angle, ownerId, damage = 20 }) {
    super({ kind: "bullet", pos, vel, angle, radius: 3 });
    this.ownerId = ownerId;
    this.damage = damage;
    this.seq = 0; // Lab 5: input seq that fired it (0 = not from an input)
    this.with(timeToLive(BULLET_TTL));
  }
}
