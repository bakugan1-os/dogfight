// Built-in arena settings: the fallback when arenas.json can't be loaded (Lab 3 failure gallery).

export const DEFAULT_ARENAS = Object.freeze({
  classic: { name: "Класика", asteroids: 5, seekerChance: 0.25, pickupEvery: 7 },
});

const NUMERIC = ["asteroids", "seekerChance", "pickupEvery"];

/** Keeps only well-formed arena entries — data from the network is never trusted as-is. */
export function validateArenas(data) {
  if (!data || typeof data !== "object") throw new TypeError("arenas: expected an object");
  const arenas = {};
  for (const [id, a] of Object.entries(data)) {
    if (a && typeof a.name === "string" && NUMERIC.every((k) => Number.isFinite(a[k]))) {
      arenas[id] = a;
    }
  }
  if (!Object.keys(arenas).length) throw new TypeError("arenas: no valid arena");
  return arenas;
}
