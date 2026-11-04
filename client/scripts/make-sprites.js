// Generates the sprite sheets by drawing them on a canvas in headless Chromium and saving PNGs.
// One-off tool, not part of the build: needs Playwright (`npm i -D playwright` +
// `npx playwright install chromium`). Output: public/assets/sprites/*.png (committed).
//
// Sheet layout (must match public/assets/manifest.json):
//   ships.png      64x64 cells, cols: idle, thrust A, thrust B; rows: P1 (mint), P2 (orange)
//   asteroids.png  96x96 cells, cols: 4 rock shapes;            rows: normal, seeker
//   items.png      32x32 cells, cols: bullet, homing bullet, shield, rapid, homing pickup

import { writeFileSync, mkdirSync } from "node:fs";
import { chromium } from "playwright";

const OUT = new URL("../public/assets/sprites/", import.meta.url);

function drawSheets() {
  /* eslint-disable no-undef -- runs inside the browser page */
  const sheets = {};
  const sheet = (name, cw, ch, cols, rows) => {
    const c = document.createElement("canvas");
    c.width = cw * cols;
    c.height = ch * rows;
    sheets[name] = c;
    return c.getContext("2d");
  };

  // ---- ships
  let ctx = sheet("ships", 64, 64, 3, 2);
  const shipColors = [
    ["#7cf3c8", "#1f8f6c"],
    ["#ffa36c", "#b4552a"],
  ];
  shipColors.forEach(([light, dark], row) => {
    for (let col = 0; col < 3; col++) {
      ctx.save();
      ctx.translate(col * 64 + 32, row * 64 + 32);
      const r = 14 * 1.6;
      if (col > 0) {
        const len = col === 1 ? 1.5 : 1.95;
        const flame = ctx.createLinearGradient(-r * 0.6, 0, -r * len, 0);
        flame.addColorStop(0, "#fff2b0");
        flame.addColorStop(0.5, "#ffb347");
        flame.addColorStop(1, "rgba(255,90,40,0)");
        ctx.fillStyle = flame;
        ctx.beginPath();
        ctx.moveTo(-r * 0.55, -r * 0.33);
        ctx.lineTo(-r * len, 0);
        ctx.lineTo(-r * 0.55, r * 0.33);
        ctx.fill();
      }
      const body = ctx.createLinearGradient(0, -r, 0, r);
      body.addColorStop(0, light);
      body.addColorStop(1, dark);
      ctx.fillStyle = body;
      ctx.strokeStyle = "#f2fffb";
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      ctx.moveTo(r * 1.05, 0);
      ctx.lineTo(-r * 0.75, -r * 0.8);
      ctx.lineTo(-r * 0.4, 0);
      ctx.lineTo(-r * 0.75, r * 0.8);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = "rgba(10,20,40,0.8)"; // cockpit
      ctx.beginPath();
      ctx.ellipse(r * 0.25, 0, r * 0.28, r * 0.15, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
  });

  // ---- asteroids
  ctx = sheet("asteroids", 96, 96, 4, 2);
  let s = 99;
  const rand = () => (s = (s * 16807) % 2147483647) / 2147483647;
  for (let col = 0; col < 4; col++) {
    const shape = Array.from({ length: 11 }, () => 0.78 + rand() * 0.22);
    const craters = Array.from({ length: 3 }, () => [
      rand() - 0.5,
      rand() - 0.5,
      0.08 + rand() * 0.1,
    ]);
    for (let row = 0; row < 2; row++) {
      const seeker = row === 1;
      ctx.save();
      ctx.translate(col * 96 + 48, row * 96 + 48);
      const R = 44;
      ctx.beginPath();
      shape.forEach((k, i) => {
        const a = (i / shape.length) * Math.PI * 2;
        ctx[i ? "lineTo" : "moveTo"](Math.cos(a) * R * k, Math.sin(a) * R * k);
      });
      ctx.closePath();
      const g = ctx.createRadialGradient(-R * 0.3, -R * 0.35, R * 0.1, 0, 0, R);
      g.addColorStop(0, seeker ? "#7a3440" : "#6b6050");
      g.addColorStop(1, seeker ? "#2a0f15" : "#221e19");
      ctx.fillStyle = g;
      ctx.fill();
      ctx.lineWidth = 2.5;
      ctx.strokeStyle = seeker ? "#ff8a8a" : "#c9b38f";
      ctx.stroke();
      for (const [cx, cy, cr] of craters) {
        ctx.beginPath();
        ctx.arc(cx * R, cy * R, cr * R, 0, Math.PI * 2);
        ctx.fillStyle = "rgba(0,0,0,0.28)";
        ctx.fill();
      }
      if (seeker) {
        ctx.fillStyle = "#ff5d6c"; // glowing "eye"
        ctx.shadowColor = "#ff5d6c";
        ctx.shadowBlur = 8;
        ctx.beginPath();
        ctx.arc(R * 0.35, 0, 5, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
    }
  }

  // ---- items
  ctx = sheet("items", 32, 32, 5, 1);
  const bolt = (col, core, glow) => {
    ctx.save();
    ctx.translate(col * 32 + 16, 16);
    ctx.shadowColor = glow;
    ctx.shadowBlur = 6;
    ctx.fillStyle = glow;
    ctx.fillRect(-11, -2.5, 22, 5);
    ctx.fillStyle = core;
    ctx.fillRect(-9, -1.2, 18, 2.4);
    ctx.restore();
  };
  bolt(0, "#ffffff", "#fff3b0");
  bolt(1, "#ffffff", "#ff7ad9");
  [
    ["S", "#6fb7ff"],
    ["R", "#ffd166"],
    ["H", "#ff7ad9"],
  ].forEach(([label, color], i) => {
    ctx.save();
    ctx.translate((i + 2) * 32 + 16, 16);
    ctx.fillStyle = "rgba(10,16,30,0.85)";
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.roundRect(-13, -13, 26, 26, 6);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = color;
    ctx.font = "bold 16px sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(label, 0, 1);
    ctx.restore();
  });

  return Object.fromEntries(Object.entries(sheets).map(([k, c]) => [k, c.toDataURL("image/png")]));
}

const browser = await chromium.launch();
const page = await browser.newPage();
const sheets = await page.evaluate(drawSheets);
await browser.close();

mkdirSync(OUT, { recursive: true });
for (const [name, dataUrl] of Object.entries(sheets)) {
  const png = Buffer.from(dataUrl.split(",")[1], "base64");
  writeFileSync(new URL(`${name}.png`, OUT), png);
  console.log(`${name}.png  ${png.length} bytes`);
}
