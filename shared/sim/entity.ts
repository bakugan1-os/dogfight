// Base class for everything that lives in the world. ONE level of inheritance stops here:
// `class Ship extends Entity` is fine, `class HomingBullet extends Bullet` is not — extra
// behavior is attached as components (see behaviors.ts and the README design write-up).

import { Vector2 } from "./vector.ts";
import type { World } from "./world.ts";
import type { Behavior } from "./behaviors.ts";
import type { EntityKind } from "./kinds.ts";
import type { EntityId } from "../protocol/ids.ts";

export type EntityOptions = {
  pos?: Vector2 | undefined;
  vel?: Vector2 | undefined;
  angle?: number | undefined;
  /** collision radius; 0 = nothing to collide with */
  radius?: number | undefined;
};

export class Entity<K extends EntityKind = EntityKind> {
  // Private static counter: shared by every subclass, invisible outside this class body.
  static #nextId = 1;
  readonly #id = Entity.#nextId++;

  readonly kind: K;
  pos: Vector2;
  vel: Vector2;
  angle: number;
  radius: number;
  alive = true;
  collides: boolean;
  /** Components: small objects with update(entity, dt, world). Composition, not subclasses. */
  readonly behaviors: Behavior[] = [];
  // Previous-step state for render interpolation. A copy, not a reference: the sim mutates
  // `pos` in place, so `prevPos = pos` would make both the same object.
  readonly prevPos: Vector2;
  prevAngle: number;
  /** Lab 5: small per-world id for the wire; assigned by World.spawn. */
  netId: EntityId | null = null;

  constructor({
    kind,
    pos = new Vector2(),
    vel = new Vector2(),
    angle = 0,
    radius = 0,
  }: EntityOptions & { kind: K }) {
    this.kind = kind;
    this.pos = pos;
    this.vel = vel;
    this.angle = angle;
    this.radius = radius;
    this.collides = radius > 0;
    this.prevPos = pos.clone();
    this.prevAngle = angle;
  }

  get id(): number {
    return this.#id;
  }

  /** Can homing pick this as a target? Ships override it (not while invulnerable). */
  get isTargetable(): boolean {
    return true;
  }

  /** Attach a behavior component; returns `this` so calls can be chained. */
  with(behavior: Behavior): this {
    this.behaviors.push(behavior);
    return this;
  }

  savePrevious(): void {
    this.prevPos.copy(this.pos);
    this.prevAngle = this.angle;
  }

  /** Default motion: straight line. Subclasses override and may call super.update(dt). */
  update(dt: number, _world: World): void {
    this.pos.addScaledInPlace(this.vel, dt);
  }

  /** Marks the entity for removal; the world sweeps it at the end of the step. */
  kill(): void {
    this.alive = false;
  }
}
