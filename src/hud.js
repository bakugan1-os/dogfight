// HUD reactions (Lab 3, M2): floating "+20" over destroyed asteroids and a message feed.
// Like audio.js, it LISTENS to the world's event bus; the simulation does not know it exists.

export function createHud(bus, { now = () => performance.now() } = {}) {
  const feed = []; // { text, until }
  const floaters = []; // { text, x, y, color, born }
  const colors = new Map(); // playerId -> color, filled by the game

  const controller = new AbortController();
  const { signal } = controller;

  bus.addEventListener("message", (e) => feed.push({ text: e.detail.text, until: now() + 3000 }), {
    signal,
  });
  bus.addEventListener(
    "scored",
    (e) => {
      const { points, x, y, playerId } = e.detail;
      if (x == null) return;
      floaters.push({
        text: `+${points}`,
        x,
        y,
        color: colors.get(playerId) ?? "#ffd479",
        born: now(),
      });
    },
    { signal },
  );

  return {
    setPlayerColor: (id, color) => colors.set(id, color),
    clear() {
      feed.length = 0;
      floaters.length = 0;
    },
    /** The last few messages, oldest first. */
    feedLines(max = 4) {
      const t = now();
      while (feed.length && feed[0].until < t) feed.shift();
      return feed.slice(-max).map((item) => ({ text: `» ${item.text}`, color: "#ffd479" }));
    },
    /** Draw in WORLD coordinates (call inside the camera transform). */
    drawFloaters(ctx) {
      const t = now();
      while (floaters.length && t - floaters[0].born > 900) floaters.shift();
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
