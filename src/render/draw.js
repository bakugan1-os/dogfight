// Drawing only. Reads state, never changes it.

import { SHIP_PARAMS } from "../sim/ship.js";
import { wrapCoord, wrappedDelta } from "../sim/arena.js";
import { lerpAngle } from "../sim/math.js";

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

/** Position and heading of an entity between its previous and current step. */
export function interpolate(entity, alpha, arena) {
  const { prevPos, pos } = entity;
  return {
    x: wrapCoord(prevPos.x + wrappedDelta(prevPos.x, pos.x, arena.width) * alpha, arena.width),
    y: wrapCoord(prevPos.y + wrappedDelta(prevPos.y, pos.y, arena.height) * alpha, arena.height),
    angle: lerpAngle(entity.prevAngle, entity.angle, alpha),
  };
}

function drawShipEntity(ctx, ship, x, y, angle, time) {
  // Blink while invulnerable after (re)spawn.
  if (ship.invulnerable > 0 && Math.floor(time * 10) % 2 === 0) ctx.globalAlpha = 0.35;
  drawShip(ctx, x, y, angle, ship.thrust, time, ship.color);
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
  ctx.fillText(`P${ship.playerId}`, x, y - ship.radius - 20);
  ctx.textAlign = "start";
}

function drawBullet(ctx, bullet, x, y, angle) {
  const homing = bullet.behaviors.some((b) => b.name === "homing");
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(angle);
  ctx.fillStyle = homing ? "#ff7ad9" : "#fff3b0";
  ctx.fillRect(-7, -1.5, 14, 3);
  ctx.restore();
}

function drawAsteroid(ctx, asteroid, x, y, angle) {
  const { radius, shape } = asteroid;
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

function drawPickup(ctx, pickup, x, y, angle, time) {
  const { color, label } = pickup.spec;
  const pulse = 1 + Math.sin(time * 5) * 0.08;
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

function drawExplosion(ctx, explosion, alpha, step) {
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
export function drawWorld(ctx, world, alpha, time, step) {
  const { arena } = world;
  for (const e of world) {
    if (e.kind === "explosion") {
      drawExplosion(ctx, e, alpha, step);
      continue;
    }
    const { x, y, angle } = interpolate(e, alpha, arena);
    const margin = e.kind === "ship" ? e.radius * 3 : e.radius * 1.3;
    drawWrapped(arena, x, y, margin, (dx, dy) => {
      switch (e.kind) {
        case "ship":
          return drawShipEntity(ctx, e, dx, dy, angle, time);
        case "bullet":
          return drawBullet(ctx, e, dx, dy, angle);
        case "asteroid":
          return drawAsteroid(ctx, e, dx, dy, angle);
        case "pickup":
          return drawPickup(ctx, e, dx, dy, angle, time);
      }
    });
  }
}
