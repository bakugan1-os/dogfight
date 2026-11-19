// Arena settings the SERVER simulates with (Lab 5). The client still downloads
// public/assets/arenas.json for names in the lobby (Lab 3 pipeline); a test keeps both equal.

export const ARENAS = Object.freeze({
  classic: { name: "Класика", asteroids: 5, seekerChance: 0.25, pickupEvery: 7 },
  belt: { name: "Пояс астероїдів", asteroids: 9, seekerChance: 0.1, pickupEvery: 6 },
  calm: { name: "Тиха гавань", asteroids: 3, seekerChance: 0, pickupEvery: 5 },
  hunters: { name: "Мисливці", asteroids: 4, seekerChance: 0.9, pickupEvery: 8 },
});

export const PLAYER_COLORS = Object.freeze([
  "#7cf3c8",
  "#ffa36c",
  "#9db4ff",
  "#ff7ad9",
  "#ffd166",
  "#b5f36c",
  "#6ce0f3",
  "#f36c6c",
]);
