import { Entity } from "./entity.js";
import { Vector2 } from "./vector.js";
import { spin, homing } from "./behaviors.js";

export const ASTEROID_SIZES = Object.freeze({
  big: { radius: 40, hp: 60, score: 20, speed: [30, 70] },
  small: { radius: 20, hp: 20, score: 10, speed: [60, 120] },
});

export class Asteroid extends Entity {
  /**
   * @param {object} o
   * @param {"big"|"small"} o.size
   * @param {boolean} [o.seeker]  a seeker asteroid slowly homes on the nearest ship
   * @param {ReturnType<import("./rng.js").createRng>} o.rng  for the shape and spin
   */
  constructor({ pos, vel, size = "big", seeker = false, rng }) {
    const spec = ASTEROID_SIZES[size];
    super({ kind: "asteroid", pos, vel, angle: rng.range(-Math.PI, Math.PI), radius: spec.radius });
    this.size = size;
    this.hp = spec.hp;
    this.seeker = seeker;
    // Jagged outline: 11 radii around the circle. Generated once from the seeded RNG.
    this.shape = Array.from({ length: 11 }, () => rng.range(0.75, 1.15));
    this.with(spin(rng.range(-1.2, 1.2)));
    if (seeker) this.with(homing({ targetKinds: ["ship"], turnRate: 0.7, range: 520 }));
  }

  get mass() {
    return this.radius * this.radius;
  }

  /** Random asteroid moving in a random direction. */
  static random(rng, pos, size = "big", seeker = false) {
    const [min, max] = ASTEROID_SIZES[size].speed;
    const vel = Vector2.fromAngle(rng.range(-Math.PI, Math.PI), rng.range(min, max));
    return new Asteroid({ pos, vel, size, seeker, rng });
  }
}
