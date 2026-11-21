// Server-side AI players (Lab 7, M4). A bot is a PlayerInput: once per tick it looks at the world
// and returns an Input — exactly what a human's client sends. The match pushes it into the same
// queue as a socket's inputs, so from the simulation's point of view a bot IS a player.
//
// Behaviour, in priority order: dodge an asteroid that is about to hit us; otherwise chase the
// nearest enemy ship (or, with none, the nearest asteroid), aim with a little lead, shoot when
// lined up.

import type { World } from "@dogfight/shared/sim/world.ts";
import type { AnyEntity } from "@dogfight/shared/sim/kinds.ts";
import { wrappedDelta } from "@dogfight/shared/sim/arena.ts";
import { wrapAngle } from "@dogfight/shared/sim/math.ts";
import { createRng, type Rng } from "@dogfight/shared/sim/rng.ts";
import { SHIP_PARAMS } from "@dogfight/shared/sim/ship.ts";
import type { Input } from "@dogfight/shared/protocol/messages.ts";
import { seq as toSeq, tick as toTick, type PlayerId } from "@dogfight/shared/protocol/ids.ts";

/** Anything that produces one input per tick for a player: a socket's queue, or a bot. */
export interface PlayerInput {
  next(world: World, self: PlayerId): Input | null;
}

export class Bot implements PlayerInput {
  #seq = 0;
  readonly #rng: Rng;
  /** personality: how close it likes to get, how picky it is about aiming */
  readonly #range: number;
  readonly #aim: number;

  constructor(seed: number) {
    this.#rng = createRng(seed);
    this.#range = this.#rng.range(180, 320);
    this.#aim = this.#rng.range(0.08, 0.2);
  }

  next(world: World, self: PlayerId): Input | null {
    const ship = world.shipOf(self);
    const seq = toSeq(++this.#seq);
    const tick = toTick(world.tick);
    const idle = {
      seq,
      tick,
      thrust: false,
      left: false,
      right: false,
      fire: false,
      firePressed: false,
    };
    if (!ship) return idle; // dead: waiting for the respawn
    const { width, height } = world.arena;
    const toward = (e: AnyEntity) => {
      const dx = wrappedDelta(ship.pos.x, e.pos.x, width);
      const dy = wrappedDelta(ship.pos.y, e.pos.y, height);
      return { dx, dy, d: Math.hypot(dx, dy) };
    };

    // 1. evade: an asteroid closer than 90 units + both radii, roughly in front of us
    for (const rock of world.ofKind("asteroid")) {
      const { dx, dy, d } = toward(rock);
      if (d - rock.radius - ship.radius > 90) continue;
      const off = wrapAngle(Math.atan2(dy, dx) - ship.angle);
      if (Math.abs(off) > 1.2) continue;
      return { ...idle, thrust: true, left: off > 0, right: off <= 0, fire: Math.abs(off) < 0.3 };
    }

    // 2. hunt: nearest enemy ship, else nearest asteroid
    let target: AnyEntity | null = null;
    let best = Infinity;
    for (const other of world.ofKind("ship")) {
      if (other.playerId === self || !other.isTargetable) continue;
      const { d } = toward(other);
      if (d < best) [target, best] = [other, d];
    }
    if (!target) {
      for (const rock of world.ofKind("asteroid")) {
        const { d } = toward(rock);
        if (d < best) [target, best] = [rock, d];
      }
    }
    if (!target) return { ...idle, thrust: this.#rng.next() < 0.3, left: this.#rng.next() < 0.5 };

    const { dx, dy, d } = toward(target);
    const lead = d / SHIP_PARAMS.bulletSpeed; // where it will be when the bullet gets there
    const aimX = dx + (target.vel.x - ship.vel.x) * lead;
    const aimY = dy + (target.vel.y - ship.vel.y) * lead;
    const off = wrapAngle(Math.atan2(aimY, aimX) - ship.angle);
    return {
      ...idle,
      left: off < -0.04,
      right: off > 0.04,
      thrust: d > this.#range && Math.abs(off) < 0.7,
      fire: Math.abs(off) < this.#aim && d < 650,
    };
  }
}
