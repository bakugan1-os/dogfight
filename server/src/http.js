// The HTTP side (Lab 4, M1): plain node:http, no framework — the point is to see the layer.
//   GET  /health                 liveness + a few numbers (rss, rooms, connections)
//   GET  /api/rooms              room list (the Lab 3 lobby's format)
//   POST /api/rooms              create a room; JSON body, size-capped, validated
//   GET  /api/replays            match logs on disk
//   GET  /api/replays/:id        the NDJSON file, STREAMED (pipeline: file -> response)
//   GET  /api/replays/:id/summary  event counts, read line by line through replay.js
//   GET  /api/slow?ms=300        DEBUG_ROUTES only: blocks the event loop on purpose
//   GET  /*                      the built client (client/dist), with a path-traversal guard

import { createReadStream } from "node:fs";
import { stat, readFile } from "node:fs/promises";
import { extname, join, resolve, sep } from "node:path";
import { pipeline } from "node:stream/promises";
import { RoomError } from "./rooms.js";
import { listReplays, readReplay, replayFile } from "./log/replay.js";

export const MIME = Object.freeze({
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
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function sendJson(res, status, body, headers = {}) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": MIME[".json"],
    "content-length": Buffer.byteLength(text), // BYTES, not characters: "привіт" is 12 bytes
    "cache-control": "no-store",
    ...headers,
  });
  res.end(text);
}

/** Collects a request body up to `limit` bytes; anything bigger is refused with 413. */
export async function readJsonBody(req, limit = MAX_BODY_BYTES) {
  if (!/^application\/json\b/.test(req.headers["content-type"] ?? "")) {
    throw new HttpError(415, "expected content-type: application/json");
  }
  if (Number(req.headers["content-length"]) > limit) throw new HttpError(413, "body too large");
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new HttpError(413, "body too large");
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "body is not valid JSON");
  }
}

/**
 * Maps a URL path to a file INSIDE `root`, or returns null. Decoding happens first, so
 * "/..%2f..%2fpackage.json" is caught too; the check is on the resolved absolute path.
 */
export function safeJoin(root, urlPath) {
  let decoded;
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

async function serveStatic(req, res, { staticDir }) {
  if (req.method !== "GET" && req.method !== "HEAD") throw new HttpError(405, "method not allowed");
  const { pathname } = new URL(req.url, "http://localhost");
  let file = safeJoin(staticDir, pathname);
  if (!file) throw new HttpError(403, "forbidden path");
  let info = await stat(file).catch(() => null);
  if (info?.isDirectory()) {
    file = join(file, "index.html");
    info = await stat(file).catch(() => null);
  }
  if (!info?.isFile()) {
    const built = await stat(join(staticDir, "index.html")).catch(() => null);
    throw new HttpError(404, built ? "not found" : "client is not built: run `npm run build`");
  }
  const type = MIME[extname(file).toLowerCase()] ?? "application/octet-stream";
  res.writeHead(200, {
    "content-type": type,
    "content-length": info.size,
    "cache-control": type.startsWith("text/html") ? "no-cache" : "public, max-age=3600",
    "x-content-type-options": "nosniff",
  });
  if (req.method === "HEAD") return res.end();
  await pipeline(createReadStream(file), res);
}

/** The "never do this" route for the M4 write-up: a synchronous busy loop. */
function busyWait(ms) {
  const until = performance.now() + ms;
  while (performance.now() < until) {
    // every connected client waits too
  }
}

/**
 * @param {object} deps  { config, rooms, stats(), log }
 * @returns {(req, res) => void}  the "request" listener for http.createServer
 */
export function createRequestHandler({ config, rooms, stats = () => ({}), log = () => {} }) {
  const routes = [
    ["GET", /^\/health$/, () => ({ status: "ok", ...stats() })],
    ["GET", /^\/api\/rooms$/, () => ({ rooms: rooms.list() })],
    [
      "POST",
      /^\/api\/rooms$/,
      async (req, res) => {
        const body = await readJsonBody(req);
        try {
          const room = rooms.create({
            name: body?.name,
            arena: body?.arena,
            mode: body?.mode,
            maxPlayers: body?.maxPlayers,
          });
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
      async (_req, _res, [id]) => {
        const file = replayFile(config.logDir, id);
        if (!file || !(await stat(file).catch(() => null)))
          throw new HttpError(404, "no such replay");
        const counts = {};
        let first = null;
        let last = null;
        for await (const event of readReplay(file)) {
          counts[event.type] = (counts[event.type] ?? 0) + 1;
          first ??= event.t;
          last = event.t ?? last;
        }
        return { id, counts, durationMs: first && last ? last - first : 0 };
      },
    ],
    [
      "GET",
      /^\/api\/replays\/([^/]+)$/,
      async (req, res, [id], url) => {
        const file = replayFile(config.logDir, id);
        const info = file && (await stat(file).catch(() => null));
        if (!info) throw new HttpError(404, "no such replay");
        const headers = {
          "content-type": MIME[".ndjson"],
          "content-length": info.size,
          "content-disposition": `attachment; filename="${id}.ndjson"`,
        };
        if (config.debugRoutes && url.searchParams.get("naive") === "1") {
          // The anti-pattern, for the M3 comparison: the WHOLE file in memory, then one write.
          const all = await readFile(file);
          res.writeHead(200, headers);
          return res.end(all);
        }
        res.writeHead(200, headers);
        // pipeline: reads a chunk, writes it, and waits for "drain" whenever the client is slow.
        await pipeline(createReadStream(file), res);
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
    const url = new URL(req.url, "http://localhost");
    try {
      const isApi = url.pathname.startsWith("/api/") || url.pathname === "/health";
      if (!isApi) return await serveStatic(req, res, config);
      const route = routes.find(([m, re]) => re.test(url.pathname) && m === req.method);
      if (!route) {
        const exists = routes.some(([, re]) => re.test(url.pathname));
        throw new HttpError(exists ? 405 : 404, exists ? "method not allowed" : "no such endpoint");
      }
      const match = url.pathname.match(route[1]).slice(1);
      const result = await route[2](req, res, match, url);
      if (result !== undefined && !res.headersSent) sendJson(res, 200, result);
    } catch (error) {
      if (res.headersSent) {
        // mid-stream failure (client went away, disk error): nothing to answer, just clean up
        if (error.code !== "ERR_STREAM_PREMATURE_CLOSE")
          log(`stream error ${url.pathname}: ${error.message}`);
        res.destroy();
        return;
      }
      const status = error instanceof HttpError ? error.status : 500;
      if (status === 500) log(`500 ${req.method} ${url.pathname}: ${error.stack}`);
      sendJson(res, status, { error: status === 500 ? "internal error" : error.message });
    }
  };
}
