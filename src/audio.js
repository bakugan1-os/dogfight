// Sound (Lab 3, M2). Owns the AudioContext and plays decoded AudioBuffers.
// The simulation never imports this file: `connectAudio` SUBSCRIBES to the world's event bus.
//
// Two platform rules (Theory §8):
//  - an AudioContext may be created any time, but it stays "suspended" (silent) until a user
//    gesture — so we create it early, decode during loading, and resume() on the first click/key;
//  - decoding is real work: done once on the loading screen, never on the first shot.

export function createAudioContext() {
  const Ctor = globalThis.AudioContext ?? globalThis.webkitAudioContext;
  return Ctor ? new Ctor() : null;
}

/** Resume on the first pointer/key gesture. Returns a promise that settles once unlocked. */
export function unlockOnGesture(ctx, target = window) {
  if (!ctx) return Promise.resolve(false);
  if (ctx.state === "running") return Promise.resolve(true);
  return new Promise((resolve) => {
    const unlock = () => {
      target.removeEventListener("pointerdown", unlock, true);
      target.removeEventListener("keydown", unlock, true);
      ctx.resume().then(
        () => resolve(true),
        () => resolve(false),
      );
    };
    target.addEventListener("pointerdown", unlock, true);
    target.addEventListener("keydown", unlock, true);
  });
}

/**
 * @param {AudioContext|null} ctx
 * @param {Record<string, AudioBuffer>} buffers  decoded on the loading screen; may be partial
 */
export function createSound(ctx, buffers) {
  const master = ctx ? ctx.createGain() : null;
  if (master) {
    master.gain.value = 0.6;
    master.connect(ctx.destination);
  }
  let muted = false;
  let lastPlayed = new Map(); // name -> ctx time, to avoid 60 identical sounds in one frame

  function play(name, { volume = 1, rate = 1, minGap = 0.03 } = {}) {
    const buffer = buffers[name];
    if (!ctx || !buffer || muted || ctx.state !== "running") return; // missing sound = silence
    if (ctx.currentTime - (lastPlayed.get(name) ?? -1) < minGap) return;
    lastPlayed.set(name, ctx.currentTime);
    // A source node plays ONCE; creating one per shot is the intended, cheap pattern.
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.playbackRate.value = rate;
    const gain = ctx.createGain();
    gain.gain.value = volume;
    source.connect(gain).connect(master);
    source.start();
  }

  return {
    play,
    toggleMute: () => (muted = !muted),
    get muted() {
      return muted;
    },
    get state() {
      return ctx?.state ?? "unavailable";
    },
    reset: () => (lastPlayed = new Map()),
  };
}

/** Event bus -> sounds. Returns an unsubscribe function. */
export function connectAudio(bus, sound) {
  const jitter = () => 0.92 + Math.random() * 0.16;
  const handlers = {
    fired: () => sound.play("shoot", { volume: 0.5, rate: jitter() }),
    hit: (e) => sound.play("hit", { volume: e.detail.target === "ship" ? 0.9 : 0.6 }),
    exploded: (e) => {
      const big = e.detail.kind === "ship" || e.detail.size === "big";
      sound.play("explosion", { volume: big ? 1 : 0.55, rate: big ? 0.9 : 1.25, minGap: 0.01 });
    },
    picked: () => sound.play("pickup", { volume: 0.7 }),
  };
  const controller = new AbortController(); // one abort() removes every listener at once
  for (const [type, handler] of Object.entries(handlers)) {
    bus.addEventListener(type, handler, { signal: controller.signal });
  }
  return () => controller.abort();
}
