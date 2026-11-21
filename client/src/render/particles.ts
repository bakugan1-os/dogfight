// Lab 7: an OBJECT POOL for explosion particles, as a structure of arrays. Before, every
// explosion made an Explosion entity with 18–40 particle objects that died a second later —
// exactly the short-lived garbage the profiler showed. Here all particles live in fixed
// Float32Arrays allocated once; an explosion only writes numbers into free slots, and a dead
// particle is removed by moving the LAST live one into its slot (swap-remove: O(1), no holes).
//
// Costs (the reason pools are not free): a fixed capacity (bursts beyond it are dropped — 4096
// is ~100 simultaneous explosions), and stale data in free slots if code forgets to overwrite.

import type { Rng } from "@dogfight/shared/sim/rng.ts";

export class ParticlePool {
  readonly capacity: number;
  readonly x: Float32Array;
  readonly y: Float32Array;
  readonly vx: Float32Array;
  readonly vy: Float32Array;
  readonly age: Float32Array;
  readonly life: Float32Array;
  /** index into `palette`: colors are strings, so they are interned, not stored per particle */
  readonly color: Uint8Array;
  readonly palette: string[] = [];
  count = 0;
  dropped = 0;

  constructor(capacity = 4096) {
    this.capacity = capacity;
    this.x = new Float32Array(capacity);
    this.y = new Float32Array(capacity);
    this.vx = new Float32Array(capacity);
    this.vy = new Float32Array(capacity);
    this.age = new Float32Array(capacity);
    this.life = new Float32Array(capacity);
    this.color = new Uint8Array(capacity);
  }

  #colorIndex(color: string): number {
    let i = this.palette.indexOf(color);
    if (i < 0) i = this.palette.push(color) - 1;
    return i;
  }

  /** One explosion: `n` particles flying out from (x, y). Same look as shared/sim/explosion.ts. */
  burst(
    x: number,
    y: number,
    n: number,
    speed: number,
    color: string,
    life: number,
    rng: Rng,
  ): void {
    const c = this.#colorIndex(color);
    for (let k = 0; k < n; k++) {
      if (this.count === this.capacity) {
        this.dropped += n - k;
        return;
      }
      const i = this.count++;
      const a = rng.range(-Math.PI, Math.PI);
      const s = rng.range(0.25, 1) * speed;
      this.x[i] = x;
      this.y[i] = y;
      this.vx[i] = Math.cos(a) * s;
      this.vy[i] = Math.sin(a) * s;
      this.age[i] = 0;
      this.life[i] = life;
      this.color[i] = c;
    }
  }

  update(dt: number): void {
    const damping = Math.exp(-2 * dt);
    for (let i = 0; i < this.count;) {
      const age = (this.age[i] ?? 0) + dt;
      if (age >= (this.life[i] ?? 0)) {
        this.#remove(i); // the last particle moved into slot i: look at i again
        continue;
      }
      this.age[i] = age;
      this.x[i] = (this.x[i] ?? 0) + (this.vx[i] ?? 0) * dt;
      this.y[i] = (this.y[i] ?? 0) + (this.vy[i] ?? 0) * dt;
      this.vx[i] = (this.vx[i] ?? 0) * damping;
      this.vy[i] = (this.vy[i] ?? 0) * damping;
      i++;
    }
  }

  #remove(i: number): void {
    const last = --this.count;
    this.x[i] = this.x[last] ?? 0;
    this.y[i] = this.y[last] ?? 0;
    this.vx[i] = this.vx[last] ?? 0;
    this.vy[i] = this.vy[last] ?? 0;
    this.age[i] = this.age[last] ?? 0;
    this.life[i] = this.life[last] ?? 0;
    this.color[i] = this.color[last] ?? 0;
  }

  /** Draws every live particle; `back` steps them back to the render time (see drawExplosion). */
  draw(ctx: CanvasRenderingContext2D, back: number): void {
    for (let i = 0; i < this.count; i++) {
      ctx.globalAlpha = Math.max(0, 1 - (this.age[i] ?? 0) / (this.life[i] ?? 1));
      ctx.fillStyle = this.palette[this.color[i] ?? 0] ?? "#fff";
      ctx.fillRect(
        (this.x[i] ?? 0) + (this.vx[i] ?? 0) * back - 1.5,
        (this.y[i] ?? 0) + (this.vy[i] ?? 0) * back - 1.5,
        3,
        3,
      );
    }
    ctx.globalAlpha = 1;
  }
}
