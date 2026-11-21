// Lab 8: which build is this page? Vite replaces __APP_VERSION__ at build time ("1.0.0+3f2a9c1",
// see vite.config.ts); the server's own version comes from GET /health. Both are in the HUD, so
// "is the fix deployed?" is answered by looking at the game, not by guessing.

import { z } from "zod";

declare const __APP_VERSION__: string | undefined;

/** "dev" where nothing defined it (tests, scripts run by Node). */
export const CLIENT_VERSION: string = typeof __APP_VERSION__ === "string" ? __APP_VERSION__ : "dev";

const Health = z.object({ version: z.string(), sha: z.string() });

/** "1.0.0+3f2a9c1", or null if /health is unreachable or older than Lab 8. */
export async function fetchServerVersion(signal?: AbortSignal): Promise<string | null> {
  try {
    const res = await fetch("/health", { signal: signal ?? null });
    const parsed = Health.safeParse(await res.json());
    return parsed.success ? `${parsed.data.version}+${parsed.data.sha.slice(0, 7)}` : null;
  } catch {
    return null;
  }
}
