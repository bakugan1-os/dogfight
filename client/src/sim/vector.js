// 2D vector. The ordinary methods are PURE: they return a new Vector2 and never touch `this`,
// so `a.add(b)` can't surprise anyone who still holds `a`.
// The *InPlace variants mutate and return `this`; they exist for the per-step hot path
// (entity integration), where a new object per entity per step is measurable garbage —
// see scripts/bench-vector.js and the README for the numbers.

export class Vector2 {
  constructor(x = 0, y = 0) {
    this.x = x;
    this.y = y;
  }

  static fromAngle(angle, length = 1) {
    return new Vector2(Math.cos(angle) * length, Math.sin(angle) * length);
  }

  // ---- pure ----------------------------------------------------------------------------
  add(v) {
    return new Vector2(this.x + v.x, this.y + v.y);
  }
  sub(v) {
    return new Vector2(this.x - v.x, this.y - v.y);
  }
  scale(k) {
    return new Vector2(this.x * k, this.y * k);
  }
  dot(v) {
    return this.x * v.x + this.y * v.y;
  }
  cross(v) {
    return this.x * v.y - this.y * v.x;
  }
  length() {
    return Math.hypot(this.x, this.y);
  }
  lengthSq() {
    return this.x * this.x + this.y * this.y;
  }
  normalize() {
    const len = this.length();
    return len === 0 ? new Vector2(0, 0) : new Vector2(this.x / len, this.y / len);
  }
  rotate(angle) {
    const c = Math.cos(angle);
    const s = Math.sin(angle);
    return new Vector2(this.x * c - this.y * s, this.x * s + this.y * c);
  }
  angle() {
    return Math.atan2(this.y, this.x);
  }
  clone() {
    return new Vector2(this.x, this.y);
  }
  equals(v) {
    return this.x === v.x && this.y === v.y;
  }
  toString() {
    return `(${this.x.toFixed(2)}, ${this.y.toFixed(2)})`;
  }

  // ---- in place (hot path) ---------------------------------------------------------------
  set(x, y) {
    this.x = x;
    this.y = y;
    return this;
  }
  copy(v) {
    this.x = v.x;
    this.y = v.y;
    return this;
  }
  addInPlace(v) {
    this.x += v.x;
    this.y += v.y;
    return this;
  }
  /** this += v * k — the integration step `pos += vel * dt` without allocating. */
  addScaledInPlace(v, k) {
    this.x += v.x * k;
    this.y += v.y * k;
    return this;
  }
  scaleInPlace(k) {
    this.x *= k;
    this.y *= k;
    return this;
  }
}
