// HUD reactions (Lab 3, M2): floating "+20" over destroyed asteroids and a message feed.
// Like audio.js, it LISTENS to the world's event bus; the simulation does not know it exists.

import type { Bus } from "@dogfight/shared/sim/bus.ts";
import type { WorldEvents } from "@dogfight/shared/sim/world.ts";

export type Hud = {
  setPlayerColor(id: number, color: string): void;
  clear(): void;
  feedLines(max?: number): Array<{ text: string; color: string }>;
  drawFloaters(ctx: CanvasRenderingContext2D): void;
  dispose(): void;
};

export function createHud(bus: Bus<WorldEvents>, { now = () => performance.now() } = {}): Hud {
  const feed: Array<{ text: string; until: number }> = [];
  const floaters: Array<{ text: string; x: number; y: number; color: string; born: number }> = [];
  const colors = new Map<number, string>(); // playerId -> color, filled by the game

  const controller = new AbortController();
  const { signal } = controller;

  bus.on("message", ({ text }) => feed.push({ text, until: now() + 3000 }), signal);
  bus.on(
    "scored",
    ({ points, x, y, playerId }) => {
      if (x == null || y == null) return;
      floaters.push({
        text: `+${points}`,
        x,
        y,
        color: colors.get(playerId) ?? "#ffd479",
        born: now(),
      });
    },
    signal,
  );

  return {
    setPlayerColor: (id, color) => void colors.set(id, color),
    clear() {
      feed.length = 0;
      floaters.length = 0;
    },
    /** The last few messages, oldest first. */
    feedLines(max = 4) {
      const t = now();
      while (feed[0] && feed[0].until < t) feed.shift();
      return feed.slice(-max).map((item) => ({ text: `» ${item.text}`, color: "#ffd479" }));
    },
    /** Draw in WORLD coordinates (call inside the camera transform). */
    drawFloaters(ctx) {
      const t = now();
      while (floaters[0] && t - floaters[0].born > 900) floaters.shift();
      ctx.save();
      ctx.font = "bold 18px ui-monospace, Consolas, monospace";
      ctx.textAlign = "center";
      for (const f of floaters) {
        const age = (t - f.born) / 900;
        ctx.globalAlpha = 1 - age;
        ctx.fillStyle = f.color;
        ctx.fillText(f.text, f.x, f.y - 20 - age * 30);
      }
      ctx.restore();
    },
    dispose: () => controller.abort(),
  };
}
