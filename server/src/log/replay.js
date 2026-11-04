// Reading match logs back (Lab 4, M3): an async generator over a file stream. Memory use is one
// line at a time, whatever the file size — the file is never read whole.

import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { createInterface } from "node:readline";
import { join } from "node:path";

const ID = /^[\w-]{1,120}$/; // ids are file names we generated: letters, digits, _ and -

/** Safe file path for a replay id, or null (no "../", no slashes, no surprises). */
export function replayFile(dir, id) {
  return ID.test(id) ? join(dir, `${id}.ndjson`) : null;
}

/** Yields parsed events, one per NDJSON line. Bad lines are reported, not fatal. */
export async function* readReplay(file, { signal } = {}) {
  const lines = createInterface({ input: createReadStream(file, { signal }), crlfDelay: Infinity });
  let lineNo = 0;
  for await (const line of lines) {
    lineNo++;
    if (!line.trim()) continue;
    try {
      yield JSON.parse(line);
    } catch {
      yield { type: "corrupt", line: lineNo };
    }
  }
}

export async function listReplays(dir) {
  let names;
  try {
    names = await readdir(dir);
  } catch (error) {
    if (error.code === "ENOENT") return [];
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
  return replays.sort((a, b) => b.modified - a.modified);
}
