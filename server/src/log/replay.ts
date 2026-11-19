// Reading match logs back (Lab 4, M3): an async generator over a file stream. Memory use is one
// line at a time, whatever the file size — the file is never read whole.

import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { createInterface } from "node:readline";
import { join } from "node:path";
import { errorCode } from "../errors.ts";

const ID = /^[\w-]{1,120}$/; // ids are file names we generated: letters, digits, _ and -

/** Safe file path for a replay id, or null (no "../", no slashes, no surprises). */
export function replayFile(dir: string, id: string): string | null {
  return ID.test(id) ? join(dir, `${id}.ndjson`) : null;
}

export type ReplayLine = { type: string; t?: number; [field: string]: unknown };

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** Yields parsed events, one per NDJSON line. Bad lines are reported, not fatal. */
export async function* readReplayLines(
  file: string,
  { signal }: { signal?: AbortSignal } = {},
): AsyncGenerator<ReplayLine> {
  const lines = createInterface({ input: createReadStream(file, { signal }), crlfDelay: Infinity });
  let lineNo = 0;
  for await (const line of lines) {
    lineNo++;
    if (!line.trim()) continue;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      value = null;
    }
    // A log line is data from disk: checked like data from the network.
    if (
      isRecord(value) &&
      typeof value.type === "string" &&
      (value.t === undefined || typeof value.t === "number")
    ) {
      yield { ...value, type: value.type, t: value.t };
    } else {
      yield { type: "corrupt", line: lineNo };
    }
  }
}
export const readReplay = readReplayLines;

export type ReplayInfo = { id: string; bytes: number; modified: Date };

export async function listReplays(dir: string): Promise<ReplayInfo[]> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch (error: unknown) {
    if (errorCode(error) === "ENOENT") return [];
    throw error;
  }
  const replays = await Promise.all(
    names
      .filter((n) => n.endsWith(".ndjson"))
      .map(async (n) => {
        const info = await stat(join(dir, n));
        return { id: n.slice(0, -".ndjson".length), bytes: info.size, modified: info.mtime };
      }),
  );
  return replays.sort((a, b) => b.modified.getTime() - a.modified.getTime());
}
