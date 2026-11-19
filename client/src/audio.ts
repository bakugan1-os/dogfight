// Sound (Lab 3, M2). Owns the AudioContext and plays decoded AudioBuffers.
// The simulation never imports this file: `connectAudio` SUBSCRIBES to the world's event bus.
//
// Two platform rules (Theory §8):
//  - an AudioContext may be created any time, but it stays "suspended" (silent) until a user
//    gesture — so we create it early, decode during loading, and resume() on the first click/key;
//  - decoding is real work: done once on the loading screen, never on the first shot.

import type { Bus } from "@dogfight/shared/sim/bus.ts";
import type { WorldEvents } from "@dogfight/shared/sim/world.ts";

/** Old Safari only has the prefixed constructor; the DOM types don't know it. */
declare global {
  var webkitAudioContext: typeof AudioContext | undefined;
}

export function createAudioContext(): AudioContext | null {
  const Ctor = globalThis.AudioContext ?? globalThis.webkitAudioContext;
  return Ctor ? new Ctor() : null;
}

/** Resume on the first pointer/key gesture. Returns a promise that settles once unlocked. */
export function unlockOnGesture(
  ctx: AudioContext | null,
  target: EventTarget = window,
): Promise<boolean> {
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

export type SoundName = "shoot" | "hit" | "explosion" | "pickup";
export type PlayOptions = { volume?: number; rate?: number; minGap?: number };
export type Sound = {
  play(name: SoundName, options?: PlayOptions): void;
  toggleMute(): boolean;
  readonly muted: boolean;
  readonly state: string;
  reset(): void;
};

/** @param buffers decoded on the loading screen; may be partial */
export function createSound(
  ctx: AudioContext | null,
  buffers: Readonly<Record<string, AudioBuffer | undefined>>,
): Sound {
  const master = ctx ? ctx.createGain() : null;
  if (ctx && master) {
    master.gain.value = 0.6;
    master.connect(ctx.destination);
  }
  let muted = false;
  let lastPlayed = new Map<SoundName, number>(); // name -> ctx time: no 60 identical sounds a frame

  function play(name: SoundName, { volume = 1, rate = 1, minGap = 0.03 }: PlayOptions = {}): void {
    const buffer = buffers[name];
    if (!ctx || !master || !buffer || muted || ctx.state !== "running") return; // missing = silence
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
export function connectAudio(bus: Bus<WorldEvents>, sound: Pick<Sound, "play">): () => void {
  const jitter = () => 0.92 + Math.random() * 0.16;
  const controller = new AbortController(); // one abort() removes every listener at once
  const { signal } = controller;
  bus.on("fired", () => sound.play("shoot", { volume: 0.5, rate: jitter() }), signal);
  bus.on("hit", (d) => sound.play("hit", { volume: d.target === "ship" ? 0.9 : 0.6 }), signal);
  bus.on(
    "exploded",
    (d) => {
      const big = d.kind === "ship" || d.size === "big";
      sound.play("explosion", { volume: big ? 1 : 0.55, rate: big ? 0.9 : 1.25, minGap: 0.01 });
    },
    signal,
  );
  bus.on("picked", () => sound.play("pickup", { volume: 0.7 }), signal);
  return () => controller.abort();
}
