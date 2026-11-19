// 2D vector. The ordinary methods are PURE: they return a new Vector2 and never touch `this`,
// so `a.add(b)` can't surprise anyone who still holds `a`.
// The *InPlace variants mutate and return `this`; they exist for the per-step hot path
// (entity integration), where a new object per entity per step is measurable garbage —
// see scripts/bench-vector.ts and the README for the numbers.
//
// Lab 6: every parameter is a `Vec2` — a READONLY view. A function that takes a Vec2 cannot
// change it (the compiler refuses `v.x = 1`). Only the owner of a Vector2 (an entity's own
// pos/vel) mutates it, and only through the *InPlace methods.

/** Anything with numeric x and y, read-only. Structural: a snapshot entity is one too. */
export type Vec2 = { readonly x: number; readonly y: number };

export class Vector2 implements Vec2 {
  x: number;
  y: number;

  constructor(x = 0, y = 0) {
    this.x = x;
    this.y = y;
  }

  static fromAngle(angle: number, length = 1): Vector2 {
    return new Vector2(Math.cos(angle) * length, Math.sin(angle) * length);
  }

  static from(v: Vec2): Vector2 {
    return new Vector2(v.x, v.y);
  }

  // ---- pure ----------------------------------------------------------------------------
  add(v: Vec2): Vector2 {
    return new Vector2(this.x + v.x, this.y + v.y);
  }
  sub(v: Vec2): Vector2 {
    return new Vector2(this.x - v.x, this.y - v.y);
  }
  scale(k: number): Vector2 {
    return new Vector2(this.x * k, this.y * k);
  }
  dot(v: Vec2): number {
    return this.x * v.x + this.y * v.y;
  }
  cross(v: Vec2): number {
    return this.x * v.y - this.y * v.x;
  }
  length(): number {
    return Math.hypot(this.x, this.y);
  }
  lengthSq(): number {
    return this.x * this.x + this.y * this.y;
  }
  normalize(): Vector2 {
    const len = this.length();
    return len === 0 ? new Vector2(0, 0) : new Vector2(this.x / len, this.y / len);
  }
  rotate(angle: number): Vector2 {
    const c = Math.cos(angle);
    const s = Math.sin(angle);
    return new Vector2(this.x * c - this.y * s, this.x * s + this.y * c);
  }
  angle(): number {
    return Math.atan2(this.y, this.x);
  }
  clone(): Vector2 {
    return new Vector2(this.x, this.y);
  }
  equals(v: Vec2): boolean {
    return this.x === v.x && this.y === v.y;
  }
  toString(): string {
    return `(${this.x.toFixed(2)}, ${this.y.toFixed(2)})`;
  }

  // ---- in place (hot path) ---------------------------------------------------------------
  set(x: number, y: number): this {
    this.x = x;
    this.y = y;
    return this;
  }
  copy(v: Vec2): this {
    this.x = v.x;
    this.y = v.y;
    return this;
  }
  addInPlace(v: Vec2): this {
    this.x += v.x;
    this.y += v.y;
    return this;
  }
  /** this += v * k — the integration step `pos += vel * dt` without allocating. */
  addScaledInPlace(v: Vec2, k: number): this {
    this.x += v.x * k;
    this.y += v.y * k;
    return this;
  }
  scaleInPlace(k: number): this {
    this.x *= k;
    this.y *= k;
    return this;
  }
}
