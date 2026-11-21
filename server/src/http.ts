// The HTTP side (Lab 4, M1): plain node:http, no framework — the point is to see the layer.
//   GET  /health                 liveness + a few numbers (rss, rooms, connections)
//   GET  /api/rooms              room list (the Lab 3 lobby's format)
//   POST /api/rooms              create a room; JSON body, size-capped, validated
//   GET  /api/replays            match logs on disk
//   GET  /api/replays/:id        the NDJSON file, STREAMED (pipeline: file -> response)
//   GET  /api/replays/:id/summary  event counts, read line by line through replay.js
//   GET  /api/slow?ms=300        DEBUG_ROUTES only: blocks the event loop on purpose
//   GET  /*                      the built client (client/dist), with a path-traversal guard

import { createReadStream, type Stats } from "node:fs";
import { stat, readFile } from "node:fs/promises";
import { extname, join, resolve, sep } from "node:path";
import { pipeline } from "node:stream/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { RoomError, type RoomManager } from "./rooms.ts";
import { listReplays, readReplay, replayFile } from "./log/replay.ts";
import type { ServerConfig } from "./config.ts";
import { errorCode, errorMessage, errorStack } from "./errors.ts";
import { z } from "zod";

const BotsRequest = z.strictObject({ count: z.number().int().min(1).max(64) });

type Req = IncomingMessage;
type Res = ServerResponse;
type Log = (message: string) => void;

export const MIME: Readonly<Record<string, string>> = Object.freeze({
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".ndjson": "application/x-ndjson; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".wav": "audio/wav",
  ".txt": "text/plain; charset=utf-8",
});

const MAX_BODY_BYTES = 4096;

export class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export function sendJson(
  res: Res,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(text), // BYTES, not characters: "привіт" is 12 bytes
    "cache-control": "no-store",
    ...headers,
  });
  res.end(text);
}

/** Collects a request body up to `limit` bytes; anything bigger is refused with 413. */
export async function readJsonBody(req: Req, limit = MAX_BODY_BYTES): Promise<unknown> {
  if (!/^application\/json\b/.test(req.headers["content-type"] ?? "")) {
    throw new HttpError(415, "expected content-type: application/json");
  }
  if (Number(req.headers["content-length"]) > limit) throw new HttpError(413, "body too large");
  const chunks: Buffer[] = [];
  let size = 0;
  // A request stream is typed as yielding `any`; instanceof narrows it to what it really is.
  for await (const chunk of req) {
    if (!(chunk instanceof Buffer)) throw new HttpError(400, "unexpected body chunk");
    size += chunk.length;
    if (size > limit) throw new HttpError(413, "body too large");
    chunks.push(chunk);
  }
  try {
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    return value;
  } catch {
    throw new HttpError(400, "body is not valid JSON");
  }
}

/**
 * Maps a URL path to a file INSIDE `root`, or returns null. Decoding happens first, so
 * "/..%2f..%2fpackage.json" is caught too; the check is on the resolved absolute path.
 */
export function safeJoin(root: string, urlPath: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return null; // malformed %-escape
  }
  if (decoded.includes("\0")) return null;
  const base = resolve(root);
  const file = resolve(join(base, decoded));
  return file === base || file.startsWith(base + sep) ? file : null;
}

const statOrNull = (file: string): Promise<Stats | null> => stat(file).catch(() => null);

async function serveStatic(req: Req, res: Res, { staticDir }: ServerConfig): Promise<void> {
  if (req.method !== "GET" && req.method !== "HEAD") throw new HttpError(405, "method not allowed");
  const { pathname } = new URL(req.url ?? "/", "http://localhost");
  let file = safeJoin(staticDir, pathname);
  if (!file) throw new HttpError(403, "forbidden path");
  let info = await statOrNull(file);
  if (info?.isDirectory()) {
    file = join(file, "index.html");
    info = await statOrNull(file);
  }
  if (!info?.isFile()) {
    const built = await statOrNull(join(staticDir, "index.html"));
    throw new HttpError(404, built ? "not found" : "client is not built: run `npm run build`");
  }
  const type = MIME[extname(file).toLowerCase()] ?? "application/octet-stream";
  res.writeHead(200, {
    "content-type": type,
    "content-length": info.size,
    "cache-control": type.startsWith("text/html") ? "no-cache" : "public, max-age=3600",
    "x-content-type-options": "nosniff",
  });
  if (req.method === "HEAD") {
    res.end();
    return;
  }
  await pipeline(createReadStream(file), res);
}

/** The "never do this" route for the M4 write-up: a synchronous busy loop. */
function busyWait(ms: number): void {
  const until = performance.now() + ms;
  while (performance.now() < until) {
    // every connected client waits too
  }
}

export type HandlerDeps = {
  config: ServerConfig;
  rooms: RoomManager;
  stats?: () => object;
  matchStats?: () => object[];
  /** Lab 7: POST /api/rooms/:id/bots */
  addBots?: (roomId: string, count: number) => number;
  log?: Log;
};

/** A route returns a JSON body, or undefined if it answered by itself (streams). */
type Route = readonly [
  method: "GET" | "POST",
  path: RegExp,
  handler: (req: Req, res: Res, params: string[], url: URL) => unknown,
];

/** The "request" listener for http.createServer. */
export function createRequestHandler({
  config,
  rooms,
  stats = () => ({}),
  matchStats = () => [],
  addBots = () => 0,
  log = () => {},
}: HandlerDeps): (req: Req, res: Res) => Promise<void> {
  const routes: Route[] = [
    ["GET", /^\/health$/, () => ({ status: "ok", ...stats() })],
    ["GET", /^\/api\/rooms$/, () => ({ rooms: rooms.list() })],
    ["GET", /^\/api\/stats$/, () => ({ ...stats(), matches: matchStats() })],
    [
      "POST",
      /^\/api\/rooms\/([\w-]+)\/bots$/,
      async (req, _res, [id = ""]) => {
        const body = BotsRequest.safeParse(await readJsonBody(req));
        if (!body.success) throw new HttpError(400, "body: { count: 1..64 }");
        try {
          return { added: addBots(id, body.data.count) };
        } catch (error: unknown) {
          if (error instanceof RoomError) throw new HttpError(404, error.message);
          throw error;
        }
      },
    ],
    [
      "POST",
      /^\/api\/rooms$/,
      async (req, res) => {
        const body = await readJsonBody(req); // unknown: RoomManager.create validates it
        try {
          const room = rooms.create(body);
          log(`room ${room.id} "${room.name}" created via API`);
          sendJson(res, 201, { room: room.summary() }, { location: `/api/rooms/${room.id}` });
        } catch (error) {
          if (!(error instanceof RoomError)) throw error;
          throw new HttpError(error.code === "too_many_rooms" ? 503 : 400, error.message);
        }
      },
    ],
    ["GET", /^\/api\/replays$/, async () => ({ replays: await listReplays(config.logDir) })],
    [
      "GET",
      /^\/api\/replays\/([^/]+)\/summary$/,
      async (_req, _res, [id = ""]) => {
        const file = replayFile(config.logDir, id);
        if (!file || !(await statOrNull(file))) throw new HttpError(404, "no such replay");
        const counts: Record<string, number> = {};
        let first: number | null = null;
        let last: number | null = null;
        for await (const event of readReplay(file)) {
          counts[event.type] = (counts[event.type] ?? 0) + 1;
          first ??= event.t ?? null;
          last = event.t ?? last;
        }
        return { id, counts, durationMs: first && last ? last - first : 0 };
      },
    ],
    [
      "GET",
      /^\/api\/replays\/([^/]+)$/,
      async (_req, res, [id = ""], url) => {
        const file = replayFile(config.logDir, id);
        const info = file ? await statOrNull(file) : null;
        if (!file || !info) throw new HttpError(404, "no such replay");
        const headers = {
          "content-type": "application/x-ndjson; charset=utf-8",
          "content-length": info.size,
          "content-disposition": `attachment; filename="${id}.ndjson"`,
        };
        if (config.debugRoutes && url.searchParams.get("naive") === "1") {
          // The anti-pattern, for the M3 comparison: the WHOLE file in memory, then one write.
          const all = await readFile(file);
          res.writeHead(200, headers);
          res.end(all);
          return undefined;
        }
        res.writeHead(200, headers);
        // pipeline: reads a chunk, writes it, and waits for "drain" whenever the client is slow.
        await pipeline(createReadStream(file), res);
        return undefined;
      },
    ],
  ];
  if (config.debugRoutes) {
    routes.push([
      "GET",
      /^\/api\/slow$/,
      (_req, _res, _m, url) => {
        const ms = Math.min(5000, Number(url.searchParams.get("ms")) || 300);
        const t0 = performance.now();
        busyWait(ms);
        return { blockedMs: Math.round(performance.now() - t0) };
      },
    ]);
  }

  return async function handle(req, res) {
    const url = new URL(req.url ?? "/", "http://localhost");
    try {
      const isApi = url.pathname.startsWith("/api/") || url.pathname === "/health";
      if (!isApi) return await serveStatic(req, res, config);
      const route = routes.find(([m, re]) => re.test(url.pathname) && m === req.method);
      if (!route) {
        const exists = routes.some(([, re]) => re.test(url.pathname));
        throw new HttpError(exists ? 405 : 404, exists ? "method not allowed" : "no such endpoint");
      }
      const [, pattern, handler] = route;
      const params = url.pathname.match(pattern)?.slice(1) ?? [];
      const result = await handler(req, res, params, url);
      if (result !== undefined && !res.headersSent) sendJson(res, 200, result);
    } catch (error: unknown) {
      if (res.headersSent) {
        // mid-stream failure (client went away, disk error): nothing to answer, just clean up
        if (errorCode(error) !== "ERR_STREAM_PREMATURE_CLOSE")
          log(`stream error ${url.pathname}: ${errorMessage(error)}`);
        res.destroy();
        return;
      }
      const status = error instanceof HttpError ? error.status : 500;
      if (status === 500) log(`500 ${req.method} ${url.pathname}: ${errorStack(error)}`);
      sendJson(res, status, { error: status === 500 ? "internal error" : errorMessage(error) });
    }
  };
}
