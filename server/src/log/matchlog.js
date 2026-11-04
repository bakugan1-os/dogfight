// Match logs as streams (Lab 4, M3). Each match session of a room (first player in -> last
// player out) becomes one NDJSON file: one JSON object per line.
//
//   room "event"s ──events.on──▶ Readable.from (object mode) ──▶ NdjsonEncoder ──▶ file
//                                                                 (Transform)      (Writable)
//
// `pipeline` connects the three, forwards errors from any stage, destroys the others on failure
// and respects backpressure: if the disk is slower than the room, the source simply waits.

import { on } from "node:events";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

/** Object in, text out: the writable side is in object mode, the readable side is bytes. */
export class NdjsonEncoder extends Transform {
  constructor() {
    super({ writableObjectMode: true });
  }

  _transform(event, _encoding, callback) {
    try {
      callback(null, `${JSON.stringify(event)}\n`);
    } catch (error) {
      callback(error); // e.g. a circular object: pipeline rejects and closes the file
    }
  }
}

/**
 * Room events from now until the session ends ("empty") or the room closes.
 * The subscription and the header are taken EAGERLY, outside the generator: a generator body
 * runs only when the stream first pulls from it — a tick later, after the "join" that opened
 * the session had already been emitted and lost. (Found exactly that way: the first join was
 * missing from the first log.)
 */
function sessionEvents(room) {
  const { id, name, arena, mode, maxPlayers } = room;
  const header = {
    t: Date.now(),
    room: id,
    type: "session",
    info: { name, arena, mode, maxPlayers },
  };
  const events = on(room, "event", { close: ["empty", "close"] }); // subscribes right now
  return (async function* () {
    yield header;
    for await (const [event] of events) yield event;
  })();
}

export const stamp = (d = new Date()) => d.toISOString().replace(/[:.]/g, "-");

/**
 * Starts a log for one session. MUST be called synchronously from the room's "open" handler:
 * `events.on` subscribes immediately, so the "join" that follows is not missed.
 * @returns {{ id:string, file:string, done:Promise<void> }}
 */
export function startMatchLog(room, dir) {
  const id = `${room.id}-${stamp()}`;
  const file = join(dir, `${id}.ndjson`);
  const source = Readable.from(sessionEvents(room)); // object mode: Readable.from keeps objects
  const done = pipeline(source, new NdjsonEncoder(), createWriteStream(file));
  return { id, file, done };
}

/**
 * Attaches match logging to every room the manager has or will create.
 * `flush()` resolves when every open log file has been written and closed (graceful shutdown).
 */
export async function createMatchLogger(rooms, { dir, log = () => {} }) {
  await mkdir(dir, { recursive: true });
  const active = new Set();

  const attach = (room) => {
    room.on("open", () => {
      const session = startMatchLog(room, dir);
      log(`match log ${session.id} started`);
      const tracked = session.done
        .then(() => log(`match log ${session.id} closed`))
        .catch((error) => log(`match log ${session.id} FAILED: ${error.message}`))
        .finally(() => active.delete(tracked));
      active.add(tracked);
    });
  };

  for (const summary of rooms.list()) attach(rooms.get(summary.id));
  rooms.on("created", attach);

  return {
    get open() {
      return active.size;
    },
    flush: () => Promise.all([...active]),
  };
}
