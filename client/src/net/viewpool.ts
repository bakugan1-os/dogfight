// Lab 7: the objects NetGame.view() hands to the renderer, POOLED. Before, every frame built a
// fresh object (plus a pos object, plus a Set of effects for ships) for every entity on screen:
// at 60 fps with ~60 entities that is thousands of short-lived objects per second — the
// renderer's top allocator in the profile. Now each kind has a slab of objects that is reused
// frame after frame: reset() rewinds the counters, take*() hands out the next slot and the
// caller overwrites EVERY field (a pooled object keeps whatever the last user left in it).

import type {
  AsteroidDrawable,
  BulletDrawable,
  PickupDrawable,
  ShipDrawable,
} from "../render/draw.ts";
import { PICKUP_TYPES, type PickupType } from "@dogfight/shared/sim/pickup.ts";
import { playerId } from "@dogfight/shared/protocol/ids.ts";

/** The same shape as the read-only drawable, but writable — only the pool writes. */
type Mutable<T> = { -readonly [K in keyof T]: T[K] };
type Pos = { x: number; y: number };
type PooledShip = Mutable<ShipDrawable> & { pos: Pos; effects: Set<PickupType> };
type PooledBullet = Mutable<BulletDrawable> & { pos: Pos };
type PooledAsteroid = Mutable<AsteroidDrawable> & { pos: Pos };
type PooledPickup = Mutable<PickupDrawable> & { pos: Pos };

const NO_BEHAVIORS: readonly { name: string }[] = Object.freeze([]);
const HOMING: readonly { name: string }[] = Object.freeze([{ name: "homing" }]);

/** One kind's slab: objects are created on first use and then reused forever. */
class Slab<T extends { pos: Pos; prevPos: unknown; angle: number; prevAngle: number }> {
  readonly #items: T[] = [];
  #used = 0;
  readonly #create: () => T;
  constructor(create: () => T) {
    this.#create = create;
  }
  reset(): void {
    this.#used = 0;
  }
  get created(): number {
    return this.#items.length;
  }
  take(x: number, y: number, angle: number): T {
    let item = this.#items[this.#used];
    if (!item) {
      item = this.#create();
      this.#items.push(item);
    }
    this.#used++;
    item.pos.x = x;
    item.pos.y = y;
    item.angle = item.prevAngle = angle; // already interpolated: no "previous" to blend from
    return item;
  }
}

function placed(radius: number) {
  const pos = { x: 0, y: 0 };
  return { pos, prevPos: pos, angle: 0, prevAngle: 0, radius };
}

export class ViewPool {
  readonly #ships = new Slab<PooledShip>(() => ({
    ...placed(0),
    kind: "ship",
    playerId: playerId(1), // placeholder: overwritten by the caller before use
    color: "",
    thrust: false,
    invulnerable: 0,
    effects: new Set(),
    hp: 0,
    maxHp: 0,
  }));
  readonly #bullets = new Slab<PooledBullet>(() => ({
    ...placed(3),
    kind: "bullet",
    behaviors: NO_BEHAVIORS,
  }));
  readonly #asteroids = new Slab<PooledAsteroid>(() => ({
    ...placed(0),
    kind: "asteroid",
    id: 0,
    size: "big",
    seeker: false,
    shape: [],
  }));
  readonly #pickups = new Slab<PooledPickup>(() => ({
    ...placed(14),
    kind: "pickup",
    type: "shield",
    spec: PICKUP_TYPES.shield,
  }));

  /** Start of a frame: every slot is free again. */
  reset(): void {
    this.#ships.reset();
    this.#bullets.reset();
    this.#asteroids.reset();
    this.#pickups.reset();
  }

  /** Objects ever created — stops growing once the busiest frame has been seen. */
  get created(): number {
    return (
      this.#ships.created + this.#bullets.created + this.#asteroids.created + this.#pickups.created
    );
  }

  ship(x: number, y: number, angle: number, radius: number): PooledShip {
    const s = this.#ships.take(x, y, angle);
    s.radius = radius;
    s.effects.clear();
    return s;
  }

  bullet(x: number, y: number, angle: number, homing: boolean): BulletDrawable {
    const b = this.#bullets.take(x, y, angle);
    b.behaviors = homing ? HOMING : NO_BEHAVIORS;
    return b;
  }

  asteroid(x: number, y: number, angle: number): PooledAsteroid {
    return this.#asteroids.take(x, y, angle);
  }

  pickup(x: number, y: number, angle: number, type: PickupType): PickupDrawable {
    const p = this.#pickups.take(x, y, angle);
    p.type = type;
    p.spec = PICKUP_TYPES[type];
    return p;
  }
}
