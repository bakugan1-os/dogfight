// The loading screen, drawn on the canvas (Lab 3, M1). Pure drawing from a state object.

import type { View } from "./canvas.ts";

type Style = readonly [glyph: string, color: string, label: string];
const STATUS_STYLE: Readonly<Record<string, Style | undefined>> & { pending: Style } = {
  pending: ["·", "#5d6b8f", "чекає"],
  loading: ["…", "#9fb0d8", "завантажується"],
  ok: ["✓", "#7cf3a0", "готово"],
  skipped: ["!", "#ffd166", "пропущено"],
  failed: ["✗", "#ff6b6b", "помилка"],
  cancelled: ["–", "#8b9bc2", "скасовано"],
};

export type LoadingPhase = "loading" | "done" | "error" | "aborted";
export type LoadingState = {
  /** 0..1, items settled / total */
  progress: number;
  items: ReadonlyArray<{ key: string; status: string; note?: string }>;
  phase: LoadingPhase;
  headline: string;
  /** ms since loading started */
  elapsed: number;
};

/** @returns y just below the text, in CSS pixels */
export function drawLoading(
  ctx: CanvasRenderingContext2D,
  view: View,
  state: LoadingState,
  time: number,
): number {
  const { width, height } = view;
  ctx.fillStyle = "#05070d";
  ctx.fillRect(0, 0, width, height);

  const w = Math.min(560, width - 32);
  const x = (width - w) / 2;
  const rows = state.items.length;
  let y = Math.max(24, height / 2 - (150 + rows * 20) / 2 - 40);

  ctx.textBaseline = "top";
  ctx.fillStyle = "#dbe5ff";
  ctx.font = "bold 28px system-ui, sans-serif";
  ctx.fillText("Dogfight", x, y);
  ctx.font = "14px system-ui, sans-serif";
  ctx.fillStyle = "#8b9bc2";
  ctx.fillText("lab-03 · завантаження асетів", x, y + 36);
  y += 72;

  // progress bar
  const barColors: Record<LoadingPhase, string> = {
    loading: "#7cf3c8",
    done: "#7cf3a0",
    error: "#ff6b6b",
    aborted: "#8b9bc2",
  };
  const barColor = barColors[state.phase];
  ctx.fillStyle = "#121a2e";
  ctx.fillRect(x, y, w, 14);
  ctx.fillStyle = barColor;
  ctx.fillRect(x, y, w * state.progress, 14);
  if (state.phase === "loading") {
    // a moving sheen: proves the thread is free while we wait
    const sheen = ((time * 0.8) % 1) * w;
    ctx.fillStyle = "rgba(255,255,255,0.18)";
    ctx.fillRect(x + Math.max(0, sheen - 40), y, Math.min(40, sheen), 14);
  }
  ctx.strokeStyle = "#23304d";
  ctx.strokeRect(x + 0.5, y + 0.5, w - 1, 13);
  y += 24;

  ctx.font = "13px ui-monospace, Consolas, monospace";
  ctx.fillStyle = "#dbe5ff";
  const pct = `${Math.round(state.progress * 100)}%`;
  ctx.fillText(`${pct}  ·  ${(state.elapsed / 1000).toFixed(2)} s`, x, y);
  y += 26;

  for (const item of state.items) {
    const [glyph, color, label] = STATUS_STYLE[item.status] ?? STATUS_STYLE.pending;
    const status = item.status.startsWith("retry") ? item.status.replace("retry", "повтор") : label;
    ctx.fillStyle = item.status.startsWith("retry") ? "#ffb347" : color;
    ctx.fillText(glyph, x, y);
    ctx.fillStyle = "#c7d3f2";
    ctx.fillText(item.key, x + 20, y);
    ctx.fillStyle = item.status.startsWith("retry") ? "#ffb347" : color;
    const text = item.note ? `${status}: ${item.note}` : status;
    ctx.fillText(text, x + 190, y);
    y += 20;
  }

  y += 12;
  ctx.font = "15px system-ui, sans-serif";
  const headlineColor: Record<LoadingPhase, string> = {
    loading: "#9fb0d8",
    error: "#ff8f8f",
    aborted: "#c7d3f2",
    done: "#7cf3a0",
  };
  ctx.fillStyle = headlineColor[state.phase];
  return wrapText(ctx, state.headline, x, y, w, 20) + 16; // where the DOM buttons should go
}

function wrapText(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  maxWidth: number,
  lineHeight: number,
): number {
  let line = "";
  for (const word of text.split(" ")) {
    const test = line ? `${line} ${word}` : word;
    if (ctx.measureText(test).width > maxWidth && line) {
      ctx.fillText(line, x, y);
      line = word;
      y += lineHeight;
    } else {
      line = test;
    }
  }
  ctx.fillText(line, x, y);
  return y + lineHeight;
}
