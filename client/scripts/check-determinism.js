// Prove-it #5: the same 1,000 steps of the shared simulation in Node and in Chromium, hashed.
// Identical hashes = the client's prediction can match the server bit for bit.
//   npm run dev            (in another terminal: Vite serves shared/ to the browser)
//   node client/scripts/check-determinism.js
// Needs Playwright (a measuring tool, not a project dependency).

import { chromium } from "playwright";
import { fileURLToPath } from "node:url";

const SHARED = fileURLToPath(new URL("../../shared/sim/", import.meta.url));

/** Runs in BOTH places (stringified into the page). FNV-1a over every entity's numbers. */
async function simulate(base, noise) {
  const { World } = await import(`${base}world.js`);
  const { NO_CONTROLS } = await import(`${base}ship.js`);
  const world = new World({ seed: 42 });
  world.addPlayer({ id: 1 });
  world.addPlayer({ id: 2 });
  for (let i = 0; i < 1000; i++) {
    const t = i % 90;
    world.step(
      1 / 30,
      new Map([
        [1, { ...NO_CONTROLS, thrust: t < 50, left: t > 60, fire: i % 7 === 0 }],
        [2, { ...NO_CONTROLS, thrust: true, right: t < 30, fire: i % 5 === 0 }],
      ]),
    );
    if (noise) world.shipOf(1)?.vel.scaleInPlace(1 + Math.random() * 1e-9); // the experiment
  }
  let h = 0x811c9dc5;
  for (const e of world) {
    for (const ch of `${e.kind}:${e.pos.x}:${e.pos.y}:${e.angle};`) {
      h ^= ch.charCodeAt(0);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
  }
  return h.toString(16).padStart(8, "0");
}

const node = [await simulate(`file://${SHARED}`, false), await simulate(`file://${SHARED}`, true)];
const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto("http://localhost:5173/puzzles.html");
await page.waitForLoadState("networkidle");
const chrome = await page.evaluate(
  async ([src, base]) => {
    const fn = new Function(`return (${src})`)();
    return [await fn(base, false), await fn(base, true)];
  },
  [simulate.toString(), `/@fs${SHARED}`],
);
await browser.close();
console.log(
  `deterministic run:   node ${node[0]}   chromium ${chrome[0]}   ${node[0] === chrome[0] ? "IDENTICAL" : "DIFFERENT"}`,
);
console.log(
  `with Math.random(): node ${node[1]}   chromium ${chrome[1]}   ${node[1] === chrome[1] ? "IDENTICAL" : "DIFFERENT"}`,
);
