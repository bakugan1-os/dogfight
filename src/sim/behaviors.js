// Behavior components. A behavior is a plain object { name, update(entity, dt, world) }
// created by a factory function (its settings live in the closure). Any entity can carry any
// behavior — a bullet and an asteroid share `homing` without sharing a base class.

import { Vector2 } from "./vector.js";
import { wrappedDelta } from "./arena.js";
import { wrapAngle } from "./math.js";

/**
 * Steers the entity's velocity toward the nearest target, turning at most `turnRate` rad/s and
 * keeping its speed. Works on a torus: distances use the wrapped (shortest) delta.
 *
 * @param {object} o
 * @param {string[]} [o.targetKinds=["ship"]]
 * @param {number}   [o.turnRate=3]   rad/s
 * @param {number}   [o.range=420]    world units
 * @param {(target:object, self:object)=>boolean} [o.filter]  e.g. "not my owner"
 */
export function homing({ targetKinds = ["ship"], turnRate = 3, range = 420, filter } = {}) {
  return {
    name: "homing",
    target: null, // last chosen target (read by the renderer to draw a lock line)
    update(self, dt, world) {
      const { width, height } = world.arena;
      let best = null;
      let bestDistSq = range * range;
      let bestDx = 0;
      let bestDy = 0;
      for (const kind of targetKinds) {
        for (const target of world.ofKind(kind)) {
          if (!target.alive || target === self || target.isTargetable === false) continue;
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
export function timeToLive(seconds) {
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
export function spin(rate) {
  return {
    name: "spin",
    update(self, dt) {
      self.angle = wrapAngle(self.angle + rate * dt);
    },
  };
}
