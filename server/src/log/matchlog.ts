// Match logs as streams (Lab 4, M3). Each match session of a room (first player in -> last
// player out) becomes one NDJSON file: one JSON object per line.
//
//   room "event"s ──room.on──▶ async generator ──▶ Readable.from ──▶ NdjsonEncoder ──▶ file
//                                                  (object mode)     (Transform)      (Writable)
//
// `pipeline` connects the three, forwards errors from any stage, destroys the others on failure
// and respects backpressure: if the disk is slower than the room, the source simply waits.

import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Room, RoomEvent, RoomManager } from "../rooms.ts";
import { silentLogger, type Logger } from "../logger.ts";

type SessionHeader = {
  t: number;
  room: string;
  type: "session";
  info: Pick<Room, "name" | "arena" | "mode" | "maxPlayers">;
};

/** Object in, text out: the writable side is in object mode, the readable side is bytes. */
export class NdjsonEncoder extends Transform {
  constructor() {
    super({ writableObjectMode: true });
  }

  override _transform(
    event: unknown,
    _encoding: BufferEncoding,
    callback: (error?: Error | null, data?: string) => void,
  ): void {
    try {
      callback(null, `${JSON.stringify(event)}\n`);
    } catch (error) {
      callback(error instanceof Error ? error : new Error(String(error))); // e.g. a circular object
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
function sessionEvents(room: Room): AsyncGenerator<SessionHeader | RoomEvent> {
  const { id, name, arena, mode, maxPlayers } = room;
  const header: SessionHeader = {
    t: Date.now(),
    room: id,
    type: "session",
    info: { name, arena, mode, maxPlayers },
  };
  // events.on() is untyped (it yields `any[]`), but Room's typed emitter knows the payload:
  // `room.on("event", …)` takes a RoomEvent. So: subscribe with the typed API, queue, yield.
  const queue: RoomEvent[] = [];
  let wake: (() => void) | null = null;
  let ended = false;
  const push = (event: RoomEvent) => {
    queue.push(event);
    wake?.();
  };
  const end = () => {
    ended = true;
    room.off("event", push);
    wake?.();
  };
  room.on("event", push); // subscribes right now, synchronously
  room.once("empty", end);
  room.once("close", end);
  return (async function* () {
    yield header;
    for (;;) {
      const event = queue.shift();
      if (event) yield event;
      else if (ended) return;
      else await new Promise<void>((resolve) => (wake = resolve));
      wake = null;
    }
  })();
}

export const stamp = (d = new Date()): string => d.toISOString().replace(/[:.]/g, "-");

/**
 * Starts a log for one session. MUST be called synchronously from the room's "open" handler:
 * `events.on` subscribes immediately, so the "join" that follows is not missed.
 */
export function startMatchLog(
  room: Room,
  dir: string,
): { id: string; file: string; done: Promise<void> } {
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
export type MatchLogger = { readonly open: number; flush(): Promise<void[]> };

export async function createMatchLogger(
  rooms: RoomManager,
  { dir, log = silentLogger }: { dir: string; log?: Logger },
): Promise<MatchLogger> {
  await mkdir(dir, { recursive: true });
  const active = new Set<Promise<void>>();

  const attach = (room: Room) => {
    room.on("open", () => {
      const session = startMatchLog(room, dir);
      log.debug({ event: "matchlog.started", roomId: room.id, file: session.id });
      const tracked = session.done
        .then(() => log.debug({ event: "matchlog.closed", roomId: room.id, file: session.id }))
        .catch((err: unknown) =>
          log.error({ event: "matchlog.failed", roomId: room.id, file: session.id, err }),
        )
        .finally(() => active.delete(tracked));
      active.add(tracked);
    });
  };

  for (const room of rooms.rooms()) attach(room);
  rooms.on("created", attach);

  return {
    get open() {
      return active.size;
    },
    flush: () => Promise.all([...active]),
  };
}
