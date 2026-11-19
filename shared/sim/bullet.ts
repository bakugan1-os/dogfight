import { Entity } from "./entity.ts";
import { timeToLive } from "./behaviors.ts";
import type { Vector2 } from "./vector.ts";
import { NO_SEQ } from "../protocol/messages.ts";
import type { PlayerId, Seq } from "../protocol/ids.ts";

export const BULLET_TTL = 1.1; // s — ~700 units of travel, less than the arena width

export type BulletOptions = {
  pos: Vector2;
  vel: Vector2;
  angle?: number;
  ownerId: PlayerId;
  damage?: number;
};

export class Bullet extends Entity<"bullet"> {
  readonly ownerId: PlayerId;
  readonly damage: number;
  /** Lab 5: input seq that fired it (NO_SEQ = not from an input). */
  seq: Seq = NO_SEQ;

  constructor({ pos, vel, angle, ownerId, damage = 20 }: BulletOptions) {
    super({ kind: "bullet", pos, vel, angle, radius: 3 });
    this.ownerId = ownerId;
    this.damage = damage;
    this.with(timeToLive(BULLET_TTL));
  }
}
