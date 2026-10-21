// Drawing only. Reads state, never changes it.

import { SHIP_PARAMS } from "../sim/ship.js";

/** Deterministic star positions (tiny LCG), generated once — the background must not flicker. */
export function createStarfield(arena, count = 160, seed = 12345) {
  let s = seed;
  const rand = () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296;
  return Array.from({ length: count }, () => ({
    x: rand() * arena.width,
    y: rand() * arena.height,
    r: 0.6 + rand() * 1.4,
    a: 0.3 + rand() * 0.7,
  }));
}

export function drawBackground(ctx, view, arena, stars) {
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
export function drawShip(ctx, x, y, angle, thrusting, time, color = "#7cf3c8") {
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
export function drawWrapped(arena, x, y, radius, drawAt) {
  const xs = [x];
  const ys = [y];
  if (x < radius) xs.push(x + arena.width);
  if (x > arena.width - radius) xs.push(x - arena.width);
  if (y < radius) ys.push(y + arena.height);
  if (y > arena.height - radius) ys.push(y - arena.height);
  for (const dx of xs) for (const dy of ys) drawAt(dx, dy);
}

export function drawHud(ctx, lines) {
  ctx.save();
  ctx.font = "13px ui-monospace, SFMono-Regular, Consolas, monospace";
  ctx.textBaseline = "top";
  const width = Math.max(...lines.map((l) => ctx.measureText(l.text ?? l).width)) + 20;
  ctx.fillStyle = "rgba(5, 8, 16, 0.72)";
  ctx.fillRect(8, 8, width, lines.length * 18 + 12);
  lines.forEach((line, i) => {
    const text = line.text ?? line;
    ctx.fillStyle = line.color ?? "#d8e4ff";
    ctx.fillText(text, 18, 16 + i * 18);
  });
  ctx.restore();
}
