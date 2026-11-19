// The player's ship: one level of inheritance (Ship extends Entity), private #hp,
// composition for everything optional (effects from pickups, homing on bullets).

import { Entity } from "./entity.ts";
import { Vector2 } from "./vector.ts";
import { Bullet } from "./bullet.ts";
import { homing } from "./behaviors.ts";
import { wrapAngle } from "./math.ts";
import type { World } from "./world.ts";
import type { PickupType } from "./pickup.ts";
import { NO_SEQ } from "../protocol/messages.ts";
import type { PlayerId, Seq } from "../protocol/ids.ts";

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
export type ShipParams = typeof SHIP_PARAMS;

/** What a player holds down during one step. Plain, read-only data. */
export type Controls = Readonly<{
  thrust: boolean;
  left: boolean;
  right: boolean;
  fire: boolean;
  /** fire was pressed since the last step (a tap shorter than one step still shoots) */
  firePressed: boolean;
  /** Lab 5: the input that produced these controls (bullets remember it) */
  seq?: Seq | undefined;
}>;

/** Neutral controls: nothing pressed. */
export const NO_CONTROLS: Controls = Object.freeze({
  thrust: false,
  left: false,
  right: false,
  fire: false,
  firePressed: false,
});

/** The part of a ship that integrate() moves. A Ship is one; so is a predicted body. */
export type ShipBody = { pos: Vector2; vel: Vector2; angle: number; thrust: boolean };

/**
 * Lab 1's integration step, now on Vector2 fields. Pure function of (body, controls, dt):
 * it mutates `body` in place and touches nothing else. Semi-implicit Euler.
 */
export function integrate<B extends ShipBody>(
  body: B,
  controls: Controls,
  dt: number,
  params: ShipParams = SHIP_PARAMS,
): B {
  const turn = (controls.right ? 1 : 0) - (controls.left ? 1 : 0);
  body.angle = wrapAngle(body.angle + turn * params.turnRate * dt);

  body.thrust = controls.thrust;
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

export type ShipOptions = {
  playerId: PlayerId;
  pos?: Vector2;
  angle?: number;
  color?: string | undefined;
};

export class Ship extends Entity<"ship"> implements ShipBody {
  #hp: number = SHIP_PARAMS.maxHp; // private: only damage() can lower it

  readonly playerId: PlayerId;
  readonly color: string;
  thrust = false;
  controls: Controls = NO_CONTROLS;
  cooldown = 0;
  contactCooldown = 0; // grace period after an asteroid hit (no damage every step)
  invulnerable: number = SHIP_PARAMS.spawnProtection;
  /** Active pickup effects: name -> seconds left. Data, not subclasses. */
  readonly effects = new Map<PickupType, number>();

  constructor({ playerId, pos = new Vector2(800, 450), angle = -Math.PI / 2, color }: ShipOptions) {
    super({ kind: "ship", pos, angle, radius: SHIP_PARAMS.radius });
    this.playerId = playerId;
    this.color = color ?? "#7cf3c8";
  }

  get hp(): number {
    return this.#hp;
  }

  get maxHp(): number {
    return SHIP_PARAMS.maxHp;
  }

  override get isTargetable(): boolean {
    return this.invulnerable === 0;
  }

  /** @returns true if this hit destroyed the ship */
  damage(amount: number): boolean {
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

  applyEffect(name: PickupType, seconds: number): void {
    this.effects.set(name, Math.max(this.effects.get(name) ?? 0, seconds));
  }

  override update(dt: number, world: World): void {
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
   * Lab 6: the `this: Ship` parameter (erased at runtime) makes that a COMPILE error.
   * The world parameter is the minimum fire() needs: tests pass a bare { spawn } stub.
   */
  fire(this: Ship, world: Pick<World, "spawn"> & Partial<Pick<World, "notify">>): Bullet {
    const dir = Vector2.fromAngle(this.angle);
    const bullet = new Bullet({
      pos: this.pos.add(dir.scale(this.radius + 6)),
      vel: this.vel.add(dir.scale(SHIP_PARAMS.bulletSpeed)),
      angle: this.angle,
      ownerId: this.playerId,
      damage: SHIP_PARAMS.bulletDamage,
    });
    // Lab 5: the input that fired it. The client predicted a bullet for that seq and replaces
    // it with this one when the snapshot arrives.
    bullet.seq = this.controls.seq ?? NO_SEQ;
    if (this.effects.has("homing")) {
      bullet.with(
        homing({
          targetKinds: ["ship", "asteroid"],
          turnRate: 4.5,
          range: 360,
          // Arrow function: `this` is captured lexically — it is still the ship here.
          filter: (target) => target.kind !== "ship" || target.playerId !== this.playerId,
        }),
      );
    }
    world.spawn(bullet);
    world.notify?.("fired", { playerId: this.playerId, x: bullet.pos.x, y: bullet.pos.y });
    this.cooldown = this.effects.has("rapid")
      ? SHIP_PARAMS.rapidCooldown
      : SHIP_PARAMS.fireCooldown;
    return bullet;
  }
}
