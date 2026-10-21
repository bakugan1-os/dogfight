// DPR-aware, resizable canvas + a camera that fits the fixed-size arena into any window.

/**
 * Backing store = CSS size x devicePixelRatio, then ctx is scaled by dpr, so everything we draw
 * in CSS pixels is crisp on retina / 4K / 150%-scaled Windows displays.
 */
export function setupCanvas(canvas, arena) {
  const ctx = canvas.getContext("2d");
  const view = { width: 0, height: 0, dpr: 1, scale: 1, offsetX: 0, offsetY: 0 };

  function resize() {
    const dpr = window.devicePixelRatio || 1;
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    // Changing canvas.width resets the context state, so the transform is re-applied every time.
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    // Camera: uniform scale so the whole arena is visible, centred (letterboxed).
    const scale = Math.min(width / arena.width, height / arena.height);
    Object.assign(view, {
      width,
      height,
      dpr,
      scale,
      offsetX: (width - arena.width * scale) / 2,
      offsetY: (height - arena.height * scale) / 2,
    });
  }

  // DPR changes without a resize event when the window is dragged to another monitor or the
  // browser zoom changes — a media query on the current resolution catches that.
  let dprQuery = null;
  function watchDpr() {
    dprQuery?.removeEventListener("change", onDprChange);
    dprQuery = window.matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`);
    dprQuery.addEventListener("change", onDprChange);
  }
  function onDprChange() {
    resize();
    watchDpr();
  }

  window.addEventListener("resize", resize);
  watchDpr();
  resize();

  return {
    ctx,
    view,
    dispose() {
      window.removeEventListener("resize", resize);
      dprQuery?.removeEventListener("change", onDprChange);
    },
  };
}

/** Applies the world -> screen transform. Call between ctx.save() and ctx.restore(). */
export function applyCamera(ctx, view) {
  ctx.translate(view.offsetX, view.offsetY);
  ctx.scale(view.scale, view.scale);
}
