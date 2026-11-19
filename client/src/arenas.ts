// Built-in arena settings: the fallback when arenas.json can't be loaded (Lab 3 failure gallery).
// Lab 6: arenas.json is data from the network — parsed with a zod schema, not trusted.

import { z } from "zod";
import type { ArenaSettings } from "@dogfight/shared/sim/arenas.ts";

export type ArenaTable = Readonly<Record<string, ArenaSettings>>;

export const DEFAULT_ARENAS: ArenaTable = Object.freeze({
  classic: { name: "Класика", asteroids: 5, seekerChance: 0.25, pickupEvery: 7 },
});

const ArenaSchema = z.object({
  name: z.string(),
  asteroids: z.number().finite(),
  seekerChance: z.number().finite(),
  pickupEvery: z.number().finite(),
});

/** Keeps only well-formed arena entries — data from the network is never trusted as-is. */
export function validateArenas(data: unknown): ArenaTable {
  const table = z.record(z.string(), z.unknown()).safeParse(data);
  if (!table.success) throw new TypeError("arenas: expected an object");
  const arenas: Record<string, ArenaSettings> = {};
  for (const [id, entry] of Object.entries(table.data)) {
    const arena = ArenaSchema.safeParse(entry);
    if (arena.success) arenas[id] = arena.data;
  }
  if (!Object.keys(arenas).length) throw new TypeError("arenas: no valid arena");
  return arenas;
}
