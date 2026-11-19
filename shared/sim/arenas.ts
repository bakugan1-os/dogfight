// Arena settings the SERVER simulates with (Lab 5). The client still downloads
// public/assets/arenas.json for names in the lobby (Lab 3 pipeline); a test keeps both equal.

export type ArenaSettings = {
  readonly name: string;
  readonly asteroids: number;
  readonly seekerChance: number;
  readonly pickupEvery: number;
};

export const ARENAS = Object.freeze({
  classic: { name: "Класика", asteroids: 5, seekerChance: 0.25, pickupEvery: 7 },
  belt: { name: "Пояс астероїдів", asteroids: 9, seekerChance: 0.1, pickupEvery: 6 },
  calm: { name: "Тиха гавань", asteroids: 3, seekerChance: 0, pickupEvery: 5 },
  hunters: { name: "Мисливці", asteroids: 4, seekerChance: 0.9, pickupEvery: 8 },
} satisfies Record<string, ArenaSettings>);

export type ArenaId = keyof typeof ARENAS;
export const ARENA_IDS = Object.keys(ARENAS).filter((k): k is ArenaId => k in ARENAS);
export const isArenaId = (s: string): s is ArenaId => Object.hasOwn(ARENAS, s);

export const PLAYER_COLORS = Object.freeze([
  "#7cf3c8",
  "#ffa36c",
  "#9db4ff",
  "#ff7ad9",
  "#ffd166",
  "#b5f36c",
  "#6ce0f3",
  "#f36c6c",
] as const);
