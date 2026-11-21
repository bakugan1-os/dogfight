// Prove-it #5: the same 1,000 steps of the shared simulation in Node and in Chromium, hashed.
// Identical hashes = the client's prediction can match the server bit for bit.
//   npm run dev            (in another terminal: Vite serves shared/ to the browser)
//   node client/scripts/check-determinism.ts
// Needs Playwright (a dev dependency) and its Chromium.
//
// Lab 6: Node strips the TYPES from this file when it loads it, so `simulate.toString()` below
// is plain JavaScript the browser can run; the modules it imports are .ts — Vite serves them
// compiled to the page, Node strips them itself.

import { chromium } from "playwright";
import { fileURLToPath } from "node:url";
import type * as WorldModuleNs from "@dogfight/shared/sim/world.ts";
import type * as ShipModuleNs from "@dogfight/shared/sim/ship.ts";
import type * as IdsModuleNs from "@dogfight/shared/protocol/ids.ts";

type WorldModule = typeof WorldModuleNs;
type ShipModule = typeof ShipModuleNs;
type IdsModule = typeof IdsModuleNs;

const SHARED = fileURLToPath(new URL("../../shared/", import.meta.url));

/** Runs in BOTH places (stringified into the page). FNV-1a over every entity's numbers. */
async function simulate(base: string, noise: boolean): Promise<string> {
  // A computed URL: TypeScript cannot see the module, so we tell it which one it is. The import
  // itself is `any` — the one place the type-checked lint rules are switched off, on purpose.
  /* eslint-disable @typescript-eslint/no-unsafe-assignment */
  const sim: WorldModule = await import(`${base}sim/world.ts`);
  const ship: ShipModule = await import(`${base}sim/ship.ts`);
  const ids: IdsModule = await import(`${base}protocol/ids.ts`);
  const { World } = sim;
  const { NO_CONTROLS } = ship;
  const [p1, p2] = [ids.playerId(1), ids.playerId(2)];
  const world = new World({ seed: 42 });
  world.addPlayer({ id: p1 });
  world.addPlayer({ id: p2 });
  for (let i = 0; i < 1000; i++) {
    const t = i % 90;
    world.step(
      1 / 30,
      new Map([
        [p1, { ...NO_CONTROLS, thrust: t < 50, left: t > 60, fire: i % 7 === 0 }],
        [p2, { ...NO_CONTROLS, thrust: true, right: t < 30, fire: i % 5 === 0 }],
      ]),
    );
    if (noise) world.shipOf(p1)?.vel.scaleInPlace(1 + Math.random() * 1e-9); // the experiment
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
  async ({ src, base }) => {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-call -- a function rebuilt from its source text in the page
    const fn: typeof simulate = new Function(`return (${src})`)();
    return [await fn(base, false), await fn(base, true)];
  },
  { src: simulate.toString(), base: `/@fs${SHARED}` },
);
await browser.close();
console.log(
  `deterministic run:   node ${node[0]}   chromium ${chrome[0]}   ${node[0] === chrome[0] ? "IDENTICAL" : "DIFFERENT"}`,
);
console.log(
  `with Math.random(): node ${node[1]}   chromium ${chrome[1]}   ${node[1] === chrome[1] ? "IDENTICAL" : "DIFFERENT"}`,
);
