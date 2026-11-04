// Base class for everything that lives in the world. ONE level of inheritance stops here:
// `class Ship extends Entity` is fine, `class HomingBullet extends Bullet` is not — extra
// behavior is attached as components (see behaviors.js and the README design write-up).

import { Vector2 } from "./vector.js";

export class Entity {
  // Private static counter: shared by every subclass, invisible outside this class body.
  static #nextId = 1;
  #id = Entity.#nextId++;

  /**
   * @param {object} o
   * @param {string} o.kind       "ship" | "bullet" | "asteroid" | "pickup" | "explosion"
   * @param {Vector2} [o.pos]
   * @param {Vector2} [o.vel]
   * @param {number} [o.angle]
   * @param {number} [o.radius]   collision radius; 0 = nothing to collide with
   */
  constructor({ kind, pos = new Vector2(), vel = new Vector2(), angle = 0, radius = 0 }) {
    this.kind = kind;
    this.pos = pos;
    this.vel = vel;
    this.angle = angle;
    this.radius = radius;
    this.alive = true;
    this.collides = radius > 0;
    /** Components: small objects with update(entity, dt, world). Composition, not subclasses. */
    this.behaviors = [];
    // Previous-step state for render interpolation. A copy, not a reference: the sim mutates
    // `pos` in place, so `prevPos = pos` would make both the same object.
    this.prevPos = pos.clone();
    this.prevAngle = angle;
  }

  get id() {
    return this.#id;
  }

  /** Attach a behavior component; returns `this` so calls can be chained. */
  with(behavior) {
    this.behaviors.push(behavior);
    return this;
  }

  savePrevious() {
    this.prevPos.copy(this.pos);
    this.prevAngle = this.angle;
  }

  /** Default motion: straight line. Subclasses override and may call super.update(dt). */
  update(dt, _world) {
    this.pos.addScaledInPlace(this.vel, dt);
  }

  /** Marks the entity for removal; the world sweeps it at the end of the step. */
  kill() {
    this.alive = false;
  }
}
