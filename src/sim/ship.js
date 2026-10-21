// The player's ship: one level of inheritance (Ship extends Entity), private #hp,
// composition for everything optional (effects from pickups, homing on bullets).

import { Entity } from "./entity.js";
import { Vector2 } from "./vector.js";
import { Bullet } from "./bullet.js";
import { homing } from "./behaviors.js";
import { wrapAngle } from "./math.js";

/** Tuned by hand in Lab 1; the reasoning is in README ("Тюнінг керування"). */
export const SHIP_PARAMS = Object.freeze({
  turnRate: 3.4, // rad/s
  thrust: 380, // units/s^2
  drag: 0.55, // 1/s
  maxSpeed: 460, // units/s
  radius: 14, // units
  maxHp: 100,
  fireCooldown: 0.22, // s between shots
  rapidCooldown: 0.07, // s between shots with the "rapid" pickup
  bulletSpeed: 640, // units/s, ADDED to the ship's own velocity
  bulletDamage: 20,
  spawnProtection: 2, // s of invulnerability after (re)spawn
});

/** Neutral controls: nothing pressed. */
export const NO_CONTROLS = Object.freeze({
  thrust: false,
  left: false,
  right: false,
  fire: false,
  firePressed: false,
});

/**
 * Lab 1's integration step, now on Vector2 fields. Pure function of (body, controls, dt):
 * it mutates `body` in place and touches nothing else. Semi-implicit Euler.
 */
export function integrate(body, controls, dt, params = SHIP_PARAMS) {
  const turn = (controls.right ? 1 : 0) - (controls.left ? 1 : 0);
  body.angle = wrapAngle(body.angle + turn * params.turnRate * dt);

  body.thrust = Boolean(controls.thrust);
  if (body.thrust) {
    body.vel.x += Math.cos(body.angle) * params.thrust * dt;
    body.vel.y += Math.sin(body.angle) * params.thrust * dt;
  }

  body.vel.scaleInPlace(Math.exp(-params.drag * dt)); // exact exponential drag

  const speed = body.vel.length();
  if (speed > params.maxSpeed) body.vel.scaleInPlace(params.maxSpeed / speed);

  body.pos.addScaledInPlace(body.vel, dt);
  return body;
}

export class Ship extends Entity {
  #hp = SHIP_PARAMS.maxHp; // private: only damage() can lower it

  constructor({ playerId, pos = new Vector2(800, 450), angle = -Math.PI / 2, color = "#7cf3c8" }) {
    super({ kind: "ship", pos, angle, radius: SHIP_PARAMS.radius });
    this.playerId = playerId;
    this.color = color;
    this.thrust = false;
    this.controls = NO_CONTROLS;
    this.cooldown = 0;
    this.contactCooldown = 0; // grace period after an asteroid hit (no damage every step)
    this.invulnerable = SHIP_PARAMS.spawnProtection;
    /** Active pickup effects: name -> seconds left. Data, not subclasses. */
    this.effects = new Map();
  }

  get hp() {
    return this.#hp;
  }

  get maxHp() {
    return SHIP_PARAMS.maxHp;
  }

  get isTargetable() {
    return this.invulnerable === 0;
  }

  /**
   * @param {number} amount
   * @returns {boolean} true if this hit destroyed the ship
   */
  damage(amount) {
    if (!this.alive || this.invulnerable > 0) return false;
    if (this.effects.has("shield")) {
      // The shield absorbs exactly one hit, then breaks.
      this.effects.delete("shield");
      this.invulnerable = 0.25;
      return false;
    }
    this.#hp = Math.max(0, this.#hp - amount);
    if (this.#hp === 0) {
      this.kill();
      return true;
    }
    return false;
  }

  applyEffect(name, seconds) {
    this.effects.set(name, Math.max(this.effects.get(name) ?? 0, seconds));
  }

  update(dt, world) {
    integrate(this, this.controls, dt);
    this.cooldown = Math.max(0, this.cooldown - dt);
    this.contactCooldown = Math.max(0, this.contactCooldown - dt);
    this.invulnerable = Math.max(0, this.invulnerable - dt);

    // Deleting the CURRENT entry while iterating a Map is well-defined (it is just skipped
    // later); adding entries would be visited too — that's why the World defers spawns.
    for (const [name, left] of this.effects) {
      if (left - dt <= 0) this.effects.delete(name);
      else this.effects.set(name, left - dt);
    }

    // Implicit binding: `this.fire(...)` — `this` is the ship, because it's left of the dot.
    if ((this.controls.fire || this.controls.firePressed) && this.cooldown === 0) {
      this.fire(world);
    }
  }

  /**
   * Spawns a bullet from the nose with the ship's velocity added (inherited velocity).
   * NOTE: a method, so `this` depends on the CALL SITE. `input.onPress("KeyF", ship.fire)`
   * calls it as a plain function -> `this` is undefined -> TypeError. See README, Lab 2.
   */
  fire(world) {
    const dir = Vector2.fromAngle(this.angle);
    const bullet = new Bullet({
      pos: this.pos.add(dir.scale(this.radius + 6)),
      vel: this.vel.add(dir.scale(SHIP_PARAMS.bulletSpeed)),
      angle: this.angle,
      ownerId: this.playerId,
      damage: SHIP_PARAMS.bulletDamage,
    });
    if (this.effects.has("homing")) {
      bullet.with(
        homing({
          targetKinds: ["ship", "asteroid"],
          turnRate: 4.5,
          range: 360,
          // Arrow function: `this` is captured lexically — it is still the ship here.
          filter: (target) => target.playerId !== this.playerId,
        }),
      );
    }
    world.spawn(bullet);
    this.cooldown = this.effects.has("rapid")
      ? SHIP_PARAMS.rapidCooldown
      : SHIP_PARAMS.fireCooldown;
    return bullet;
  }
}
