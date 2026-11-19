import { Entity } from "./entity.ts";
import { timeToLive } from "./behaviors.ts";
import type { Vector2 } from "./vector.ts";
import type { Rng } from "./rng.ts";

export type Particle = { x: number; y: number; vx: number; vy: number };

export type ExplosionOptions = {
  pos: Vector2;
  rng: Rng;
  count?: number;
  speed?: number;
  color?: string;
  duration?: number;
};

/**
 * A burst of short-lived particles. Particles are plain objects inside ONE entity, not
 * entities themselves: dozens per explosion would flood the world Map and the collision pass.
 * (They are still allocations every explosion — Lab 7 replaces them with an object pool.)
 */
export class Explosion extends Entity<"explosion"> {
  readonly color: string;
  readonly duration: number;
  age = 0;
  readonly particles: Particle[];

  constructor({
    pos,
    rng,
    count = 24,
    speed = 160,
    color = "#ffb347",
    duration = 0.9,
  }: ExplosionOptions) {
    super({ kind: "explosion", pos }); // radius 0 -> never collides
    this.color = color;
    this.duration = duration;
    this.particles = Array.from({ length: count }, () => {
      const a = rng.range(-Math.PI, Math.PI);
      const s = rng.range(0.25, 1) * speed;
      return { x: pos.x, y: pos.y, vx: Math.cos(a) * s, vy: Math.sin(a) * s };
    });
    this.with(timeToLive(duration));
  }

  override update(dt: number): void {
    this.age += dt;
    const damping = Math.exp(-2 * dt);
    for (const p of this.particles) {
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.vx *= damping;
      p.vy *= damping;
    }
  }
}
