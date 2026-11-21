// Lab 8: structured logs. One JSON object per line on stdout — the platform (Docker, Render,
// Fly) collects stdout; files and pretty text are for laptops (`npm run dev` pipes the same lines
// through pino-pretty).
//
//   {"level":30,"time":…,"event":"player.joined","roomId":"arena","playerId":"3f2a…","name":"Ада"}
//
// We log EVENTS with fields (`event`, `roomId`, `playerId`, `reason`), not prose: a match can be
// filtered with `jq 'select(.roomId=="arena")'`. Never log secrets or whole client messages.

import { pino, type Logger, type DestinationStream } from "pino";
import type { ServerConfig } from "./config.ts";

export type { Logger };

/** A logger that writes nothing (tests, QUIET=true). */
export const silentLogger: Logger = pino({ level: "silent" });

export function createLogger(
  config: Pick<ServerConfig, "logLevel" | "quiet" | "gitSha">,
  destination?: DestinationStream,
): Logger {
  return pino(
    {
      level: config.quiet ? "silent" : config.logLevel,
      base: { pid: process.pid, version: config.gitSha }, // on every line: which build said it
      // Belt and braces: if a secret-looking field is ever passed in, it never reaches stdout.
      redact: { paths: ["*.token", "*.password", "*.secret", "*.authorization"], remove: true },
    },
    destination,
  );
}
