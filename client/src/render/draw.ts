// Drawing only. Reads state, never changes it.

import { SHIP_PARAMS } from "@dogfight/shared/sim/ship.ts";
import { wrapCoord, wrappedDelta, type Arena } from "@dogfight/shared/sim/arena.ts";
import { lerpAngle, assertNever } from "@dogfight/shared/sim/math.ts";
import type { Vec2 } from "@dogfight/shared/sim/vector.ts";
import type { PickupSpec, PickupType } from "@dogfight/shared/sim/pickup.ts";
import type { AsteroidSize } from "@dogfight/shared/sim/asteroid.ts";
import type { Particle } from "@dogfight/shared/sim/explosion.ts";
import type { PlayerId } from "@dogfight/shared/protocol/ids.ts";
import type { View } from "./canvas.ts";
import type { Sprite } from "../assets/loader.ts";
import type { ParticlePool } from "./particles.ts";

// ---- what the renderer needs to know (Lab 6) ---------------------------------------------------
// STRUCTURAL types: the real simulation entities (Ship, Bullet…) fit them, and so do the plain
// objects NetGame builds from snapshots. Neither side imports or extends the other.

type Placed = {
  readonly pos: Vec2;
  readonly prevPos: Vec2;
  readonly angle: number;
  readonly prevAngle: number;
  readonly radius: number;
};
export type ShipDrawable = Placed & {
  readonly kind: "ship";
  readonly playerId: PlayerId;
  readonly color: string;
  readonly thrust: boolean;
  readonly invulnerable: number;
  readonly effects: { has(type: PickupType): boolean };
  readonly hp: number;
  readonly maxHp: number;
};
export type BulletDrawable = Placed & {
  readonly kind: "bullet";
  readonly behaviors: readonly { readonly name: string }[];
};
export type AsteroidDrawable = Placed & {
  readonly kind: "asteroid";
  readonly id: number;
  readonly size: AsteroidSize;
  readonly seeker: boolean;
  readonly shape: readonly number[];
};
export type PickupDrawable = Placed & {
  readonly kind: "pickup";
  readonly type: PickupType;
  readonly spec: PickupSpec;
};
export type ExplosionDrawable = Placed & {
  readonly kind: "explosion";
  readonly age: number;
  readonly duration: number;
  readonly color: string;
  readonly particles: readonly Particle[];
};
export type Drawable =
  ShipDrawable | BulletDrawable | AsteroidDrawable | PickupDrawable | ExplosionDrawable;

/** A World fits this; so does NetGame.view(). `particles`: Lab 7's pooled explosions. */
export type DrawableWorld = Iterable<Drawable> & {
  readonly arena: Arena;
  nameOf(playerId: PlayerId): string;
  readonly particles?: ParticlePool;
};

export type Sprites = Readonly<Record<string, Sprite<CanvasImageSource> | undefined>>;
type Ctx = CanvasRenderingContext2D;
export type Star = { x: number; y: number; r: number; a: number };
export type HudLine = string | { text: string; color?: string };

/** Deterministic star positions (tiny LCG), generated once — the background must not flicker. */
export function createStarfield(arena: Arena, count = 160, seed = 12345): Star[] {
  let s = seed;
  const rand = () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296;
  return Array.from({ length: count }, () => ({
    x: rand() * arena.width,
    y: rand() * arena.height,
    r: 0.6 + rand() * 1.4,
    a: 0.3 + rand() * 0.7,
  }));
}

/**
 * Lab 7: the background never changes, but it was repainted every frame: ~200 path calls whose
 * float arguments V8 has to box into heap numbers on the way into the canvas API — the second
 * biggest allocator in the profile. Now it is painted ONCE per window size into an offscreen
 * canvas and copied with a single drawImage.
 */
let backgroundCache: { canvas: HTMLCanvasElement; key: string } | null = null;

export function drawBackground(ctx: Ctx, view: View, arena: Arena, stars: readonly Star[]): void {
  const key = `${view.width}x${view.height}@${view.dpr}`;
  if (typeof document === "undefined") return paintBackground(ctx, view, arena, stars);
  if (backgroundCache?.key !== key) {
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(view.width * view.dpr);
    canvas.height = Math.round(view.height * view.dpr);
    const off = canvas.getContext("2d");
    if (!off) return paintBackground(ctx, view, arena, stars);
    off.scale(view.dpr, view.dpr);
    paintBackground(off, view, arena, stars);
    backgroundCache = { canvas, key };
  }
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0); // copy device pixels 1:1
  ctx.drawImage(backgroundCache.canvas, 0, 0);
  ctx.restore();
}

function paintBackground(ctx: Ctx, view: View, arena: Arena, stars: readonly Star[]): void {
  ctx.fillStyle = "#05070d";
  ctx.fillRect(0, 0, view.width, view.height);

  ctx.save();
  ctx.translate(view.offsetX, view.offsetY);
  ctx.scale(view.scale, view.scale);

  ctx.fillStyle = "#0a0f1c";
  ctx.fillRect(0, 0, arena.width, arena.height);

  // Grid: makes motion visible even when the ship is the only object.
  ctx.strokeStyle = "rgba(90, 120, 200, 0.12)";
  ctx.lineWidth = 1 / view.scale;
  ctx.beginPath();
  for (let x = 0; x <= arena.width; x += 100) {
    ctx.moveTo(x, 0);
    ctx.lineTo(x, arena.height);
  }
  for (let y = 0; y <= arena.height; y += 100) {
    ctx.moveTo(0, y);
    ctx.lineTo(arena.width, y);
  }
  ctx.stroke();

  for (const star of stars) {
    ctx.globalAlpha = star.a;
    ctx.fillStyle = "#cfe0ff";
    ctx.beginPath();
    ctx.arc(star.x, star.y, star.r, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;

  ctx.strokeStyle = "rgba(120, 160, 255, 0.45)";
  ctx.lineWidth = 2 / view.scale;
  ctx.strokeRect(0, 0, arena.width, arena.height);
  ctx.restore();
}

/**
 * Draws the ship at the ORIGIN pointing along +x, then lets the canvas transform place it:
 * translate to (x, y), rotate by the heading. The ship's geometry never has to know its angle.
 */
export function drawShip(
  ctx: Ctx,
  x: number,
  y: number,
  angle: number,
  thrusting: boolean,
  time: number,
  color = "#7cf3c8",
): void {
  const r = SHIP_PARAMS.radius;
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(angle);

  if (thrusting) {
    const flicker = 0.75 + 0.25 * Math.sin(time * 60);
    ctx.fillStyle = "#ffb347";
    ctx.beginPath();
    ctx.moveTo(-r * 0.8, -r * 0.4);
    ctx.lineTo(-r * (1.6 + flicker), 0);
    ctx.lineTo(-r * 0.8, r * 0.4);
    ctx.closePath();
    ctx.fill();
  }

  ctx.fillStyle = color;
  ctx.strokeStyle = "#e9fff7";
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(r * 1.2, 0); // nose
  ctx.lineTo(-r * 0.9, -r * 0.8);
  ctx.lineTo(-r * 0.5, 0);
  ctx.lineTo(-r * 0.9, r * 0.8);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
  ctx.restore();
}

/**
 * Draws a body on a torus: when it overlaps an edge, also draws its copy on the opposite side,
 * so the ship slides through the edge instead of popping.
 */
/**
 * Where to draw something near an edge so it shows on both sides (torus). Writes up to two
 * coordinates into `out` and returns how many — no arrays, no closures (Lab 7: this used to
 * allocate two arrays and receive a fresh closure for EVERY entity, EVERY frame).
 */
export function wrapOffsets(v: number, size: number, margin: number, out: Float64Array): number {
  out[0] = v;
  if (v < margin) {
    out[1] = v + size;
    return 2;
  }
  if (v > size - margin) {
    out[1] = v - size;
    return 2;
  }
  return 1;
}

const HUD_FONT = "13px ui-monospace, SFMono-Regular, Consolas, monospace";
const textOf = (l: HudLine) => (typeof l === "string" ? l : l.text);

/** Width of the HUD box for these lines (measureText allocates: call it when the text changes). */
export function measureHud(ctx: Ctx, lines: readonly HudLine[]): number {
  ctx.save();
  ctx.font = HUD_FONT;
  let width = 0;
  for (const l of lines) width = Math.max(width, ctx.measureText(textOf(l)).width);
  ctx.restore();
  return width + 20;
}

export function drawHud(ctx: Ctx, lines: readonly HudLine[], knownWidth?: number): void {
  const width = knownWidth ?? measureHud(ctx, lines);
  ctx.save();
  ctx.font = HUD_FONT;
  ctx.textBaseline = "top";
  ctx.fillStyle = "rgba(5, 8, 16, 0.72)";
  ctx.fillRect(8, 8, width, lines.length * 18 + 12);
  lines.forEach((line, i) => {
    const text = textOf(line);
    ctx.fillStyle = (typeof line === "string" ? undefined : line.color) ?? "#d8e4ff";
    ctx.fillText(text, 18, 16 + i * 18);
  });
  ctx.restore();
}

/** Position and heading of an entity between its previous and current step. */
export type Interpolated = { x: number; y: number; angle: number };

/** Render position between the previous and the current step. Writes into `out` (reused). */
export function interpolate(
  entity: Placed,
  alpha: number,
  arena: Arena,
  out: Interpolated = { x: 0, y: 0, angle: 0 },
): Interpolated {
  const { prevPos, pos } = entity;
  out.x = wrapCoord(prevPos.x + wrappedDelta(prevPos.x, pos.x, arena.width) * alpha, arena.width);
  out.y = wrapCoord(prevPos.y + wrappedDelta(prevPos.y, pos.y, arena.height) * alpha, arena.height);
  out.angle = lerpAngle(entity.prevAngle, entity.angle, alpha);
  return out;
}

/**
 * Lab 3: one cell of a sprite sheet. `drawImage` with a SOURCE rectangle (sx, sy, sw, sh)
 * cuts the frame out of the sheet; the destination is centred on (x, y) and rotated.
 */
export function drawSprite(
  ctx: Ctx,
  sheet: Sprite<CanvasImageSource>,
  col: number,
  row: number,
  x: number,
  y: number,
  angle: number,
  size: number,
): void {
  const { image, cell = 64 } = sheet;
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(angle);
  ctx.drawImage(image, col * cell, row * cell, cell, cell, -size / 2, -size / 2, size, size);
  ctx.restore();
}

const PICKUP_COLUMN: Record<PickupType, number> = { shield: 2, rapid: 3, homing: 4 };

function drawShipEntity(
  ctx: Ctx,
  ship: ShipDrawable,
  x: number,
  y: number,
  angle: number,
  time: number,
  sprites: Sprites,
  label: string,
): void {
  // Blink while invulnerable after (re)spawn.
  if (ship.invulnerable > 0 && Math.floor(time * 10) % 2 === 0) ctx.globalAlpha = 0.35;
  if (sprites.ships) {
    const col = ship.thrust ? 1 + (Math.floor(time * 20) % 2) : 0;
    const row = Math.min(1, Math.max(0, ship.playerId - 1));
    drawSprite(ctx, sprites.ships, col, row, x, y, angle, 40); // sheet ship r=22.4 px -> 14 units
  } else {
    drawShip(ctx, x, y, angle, ship.thrust, time, ship.color); // fallback: Lab 1 vector art
  }
  ctx.globalAlpha = 1;

  if (ship.effects.has("shield")) {
    ctx.strokeStyle = "rgba(111, 183, 255, 0.85)";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(x, y, ship.radius + 9 + Math.sin(time * 6) * 1.5, 0, Math.PI * 2);
    ctx.stroke();
  }

  // HP bar above the ship
  const w = 34;
  const frac = ship.hp / ship.maxHp;
  ctx.fillStyle = "rgba(0,0,0,0.6)";
  ctx.fillRect(x - w / 2, y - ship.radius - 16, w, 4);
  ctx.fillStyle = frac > 0.5 ? "#7cf3a0" : frac > 0.25 ? "#ffd166" : "#ff5d5d";
  ctx.fillRect(x - w / 2, y - ship.radius - 16, w * frac, 4);
  ctx.fillStyle = ship.color;
  ctx.font = "bold 11px ui-monospace, Consolas, monospace";
  ctx.textAlign = "center";
  ctx.fillText(label, x, y - ship.radius - 20);
  ctx.textAlign = "start";
}

function drawBullet(
  ctx: Ctx,
  bullet: BulletDrawable,
  x: number,
  y: number,
  angle: number,
  sprites: Sprites,
): void {
  const homing = bullet.behaviors.some((b) => b.name === "homing");
  if (sprites.items) return drawSprite(ctx, sprites.items, homing ? 1 : 0, 0, x, y, angle, 22);
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(angle);
  ctx.fillStyle = homing ? "#ff7ad9" : "#fff3b0";
  ctx.fillRect(-7, -1.5, 14, 3);
  ctx.restore();
}

function drawAsteroid(
  ctx: Ctx,
  asteroid: AsteroidDrawable,
  x: number,
  y: number,
  angle: number,
  sprites: Sprites,
): void {
  const { radius, shape } = asteroid;
  if (sprites.asteroids) {
    const size = (96 * radius) / 44; // the sheet's rock has radius 44 px in a 96 px cell
    return drawSprite(
      ctx,
      sprites.asteroids,
      asteroid.id % 4,
      asteroid.seeker ? 1 : 0,
      x,
      y,
      angle,
      size,
    );
  }
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(angle);
  ctx.beginPath();
  shape.forEach((k, i) => {
    const a = (i / shape.length) * Math.PI * 2;
    const px = Math.cos(a) * radius * k;
    const py = Math.sin(a) * radius * k;
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  });
  ctx.closePath();
  ctx.fillStyle = asteroid.seeker ? "#3a1c22" : "#2a2620";
  ctx.strokeStyle = asteroid.seeker ? "#ff8a8a" : "#c9b38f";
  ctx.lineWidth = 2;
  ctx.fill();
  ctx.stroke();
  ctx.restore();
}

function drawPickup(
  ctx: Ctx,
  pickup: PickupDrawable,
  x: number,
  y: number,
  angle: number,
  time: number,
  sprites: Sprites,
): void {
  const { color, label } = pickup.spec;
  const pulse = 1 + Math.sin(time * 5) * 0.08;
  if (sprites.items) {
    const col = PICKUP_COLUMN[pickup.type];
    return drawSprite(ctx, sprites.items, col, 0, x, y, angle * 0.25, 36 * pulse);
  }
  ctx.save();
  ctx.translate(x, y);
  ctx.save();
  ctx.rotate(angle);
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.strokeRect(
    -pickup.radius * pulse,
    -pickup.radius * pulse,
    2 * pickup.radius * pulse,
    2 * pickup.radius * pulse,
  );
  ctx.restore();
  ctx.fillStyle = color;
  ctx.font = "bold 14px ui-monospace, Consolas, monospace";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(label, 0, 1);
  ctx.restore();
}

function drawExplosion(ctx: Ctx, explosion: ExplosionDrawable, alpha: number, step: number): void {
  const life = 1 - explosion.age / explosion.duration;
  ctx.globalAlpha = Math.max(0, life);
  ctx.fillStyle = explosion.color;
  // Particles have no "previous" copy: step them back by (1 - alpha) of a step instead.
  const back = (alpha - 1) * step;
  for (const p of explosion.particles) {
    ctx.fillRect(p.x + p.vx * back - 1.5, p.y + p.vy * back - 1.5, 3, 3);
  }
  ctx.globalAlpha = 1;
}

/**
 * Draws every entity. Dispatch on `kind` (data) instead of a draw() method on each class:
 * the simulation classes stay free of canvas code and can run on the server in Lab 4–5.
 */
// Scratch storage reused by every drawWorld call: one frame allocates nothing here.
const at: Interpolated = { x: 0, y: 0, angle: 0 };
const xs = new Float64Array(2);
const ys = new Float64Array(2);

function drawEntity(
  ctx: Ctx,
  e: Exclude<Drawable, ExplosionDrawable>,
  x: number,
  y: number,
  angle: number,
  time: number,
  sprites: Sprites,
  world: DrawableWorld,
): void {
  switch (e.kind) {
    case "ship":
      return drawShipEntity(ctx, e, x, y, angle, time, sprites, world.nameOf(e.playerId));
    case "bullet":
      return drawBullet(ctx, e, x, y, angle, sprites);
    case "asteroid":
      return drawAsteroid(ctx, e, x, y, angle, sprites);
    case "pickup":
      return drawPickup(ctx, e, x, y, angle, time, sprites);
    default:
      return assertNever(e, "drawable kind");
  }
}

export function drawWorld(
  ctx: Ctx,
  world: DrawableWorld,
  alpha: number,
  time: number,
  step: number,
  sprites: Sprites = {},
): void {
  const { arena } = world;
  for (const e of world) {
    if (e.kind === "explosion") {
      drawExplosion(ctx, e, alpha, step);
      continue;
    }
    interpolate(e, alpha, arena, at);
    const margin = e.kind === "ship" ? e.radius * 3 : e.radius * 1.3;
    const nx = wrapOffsets(at.x, arena.width, margin, xs);
    const ny = wrapOffsets(at.y, arena.height, margin, ys);
    for (let i = 0; i < nx; i++) {
      for (let j = 0; j < ny; j++)
        drawEntity(ctx, e, xs[i] ?? 0, ys[j] ?? 0, at.angle, time, sprites, world);
    }
  }
  world.particles?.draw(ctx, (alpha - 1) * step);
}
