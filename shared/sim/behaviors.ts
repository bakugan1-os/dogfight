// Behavior components. A behavior is a plain object { name, update(entity, dt, world) }
// created by a factory function (its settings live in the closure). Any entity can carry any
// behavior — a bullet and an asteroid share `homing` without sharing a base class.
//
// Lab 6: `Behavior` is a discriminated union on `name`, so code that looks for the homing
// component (the renderer's lock line) gets a typed `target` after checking the name.

import { Vector2 } from "./vector.ts";
import { wrappedDelta } from "./arena.ts";
import { wrapAngle } from "./math.ts";
import type { World } from "./world.ts";
import type { AnyEntity, EntityKind } from "./kinds.ts";

type Update = (self: AnyEntity, dt: number, world: World) => void;

export type HomingBehavior = { readonly name: "homing"; target: AnyEntity | null; update: Update };
export type TtlBehavior = { readonly name: "ttl"; remaining: number; update: Update };
export type SpinBehavior = { readonly name: "spin"; update: Update };
export type Behavior = HomingBehavior | TtlBehavior | SpinBehavior;

export type HomingOptions = {
  targetKinds?: readonly EntityKind[];
  /** rad/s */
  turnRate?: number;
  /** world units */
  range?: number;
  /** e.g. "not my owner" */
  filter?: (target: AnyEntity, self: AnyEntity) => boolean;
};

export const isHoming = (b: Behavior): b is HomingBehavior => b.name === "homing";

/**
 * Steers the entity's velocity toward the nearest target, turning at most `turnRate` rad/s and
 * keeping its speed. Works on a torus: distances use the wrapped (shortest) delta.
 */
export function homing({
  targetKinds = ["ship"],
  turnRate = 3,
  range = 420,
  filter,
}: HomingOptions = {}): HomingBehavior {
  return {
    name: "homing",
    target: null, // last chosen target (read by the renderer to draw a lock line)
    update(self, dt, world) {
      const { width, height } = world.arena;
      let best: AnyEntity | null = null;
      let bestDistSq = range * range;
      let bestDx = 0;
      let bestDy = 0;
      for (const kind of targetKinds) {
        for (const target of world.ofKind(kind)) {
          if (!target.alive || target === self || !target.isTargetable) continue;
          if (filter && !filter(target, self)) continue;
          const dx = wrappedDelta(self.pos.x, target.pos.x, width);
          const dy = wrappedDelta(self.pos.y, target.pos.y, height);
          const d2 = dx * dx + dy * dy;
          if (d2 < bestDistSq) {
            best = target;
            bestDistSq = d2;
            bestDx = dx;
            bestDy = dy;
          }
        }
      }
      this.target = best;
      if (!best) return;

      const speed = self.vel.length();
      const current = self.vel.angle();
      const desired = Math.atan2(bestDy, bestDx);
      const diff = wrapAngle(desired - current);
      const maxTurn = turnRate * dt;
      const turned = current + Math.max(-maxTurn, Math.min(maxTurn, diff));
      self.vel = Vector2.fromAngle(turned, speed);
      if (self.kind === "bullet") self.angle = turned; // bullets point where they fly
    },
  };
}

/** Removes the entity after `seconds`. Shared by bullets, pickups, explosions. */
export function timeToLive(seconds: number): TtlBehavior {
  return {
    name: "ttl",
    remaining: seconds,
    update(self, dt) {
      this.remaining -= dt;
      if (this.remaining <= 0) self.kill();
    },
  };
}

/** Constant rotation for visuals (asteroids, pickups). */
export function spin(rate: number): SpinBehavior {
  return {
    name: "spin",
    update(self, dt) {
      self.angle = wrapAngle(self.angle + rate * dt);
    },
  };
}
