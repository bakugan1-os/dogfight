import { Entity } from "./entity.ts";
import { Vector2 } from "./vector.ts";
import { spin, homing } from "./behaviors.ts";
import type { Rng } from "./rng.ts";

export type AsteroidSize = "big" | "small";

export const ASTEROID_SIZES = Object.freeze({
  big: { radius: 40, hp: 60, score: 20, speed: [30, 70] },
  small: { radius: 20, hp: 20, score: 10, speed: [60, 120] },
} satisfies Record<
  AsteroidSize,
  { radius: number; hp: number; score: number; speed: [number, number] }
>);

export type AsteroidOptions = {
  pos: Vector2;
  vel?: Vector2;
  size?: AsteroidSize;
  /** a seeker asteroid slowly homes on the nearest ship */
  seeker?: boolean;
  /** for the shape and spin */
  rng: Rng;
};

export class Asteroid extends Entity<"asteroid"> {
  readonly size: AsteroidSize;
  hp: number;
  readonly seeker: boolean;
  /** Jagged outline: 11 radii around the circle. Generated once from the seeded RNG. */
  readonly shape: readonly number[];

  constructor({ pos, vel, size = "big", seeker = false, rng }: AsteroidOptions) {
    const spec = ASTEROID_SIZES[size];
    super({ kind: "asteroid", pos, vel, angle: rng.range(-Math.PI, Math.PI), radius: spec.radius });
    this.size = size;
    this.hp = spec.hp;
    this.seeker = seeker;
    this.shape = Array.from({ length: 11 }, () => rng.range(0.75, 1.15));
    this.with(spin(rng.range(-1.2, 1.2)));
    if (seeker) this.with(homing({ targetKinds: ["ship"], turnRate: 0.7, range: 520 }));
  }

  get mass(): number {
    return this.radius * this.radius;
  }

  /** Random asteroid moving in a random direction. */
  static random(rng: Rng, pos: Vector2, size: AsteroidSize = "big", seeker = false): Asteroid {
    const [min, max] = ASTEROID_SIZES[size].speed;
    const vel = Vector2.fromAngle(rng.range(-Math.PI, Math.PI), rng.range(min, max));
    return new Asteroid({ pos, vel, size, seeker, rng });
  }
}
