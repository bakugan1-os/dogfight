// WebSocket connection lifecycle (Lab 4, M2 + M4).
//
//  upgrade ─▶ connection ─▶ must send "join" within JOIN_TIMEOUT_MS ─▶ in a room ─▶ close
//
// Every frame is rate-limited (token bucket), parsed and validated (shared/protocol/control.ts);
// anything wrong closes the socket with a specific code. Heartbeat: a ping every HEARTBEAT_MS,
// and a socket that missed two pongs in a row is terminated (dead NAT mappings, sleeping
// laptops). Rooms never see sockets: this module LISTENS to room events and broadcasts.
//
// Lab 5: each room with players has a Match (match.ts) — the authoritative 30 Hz simulation.
// Binary frames are INPUTs (shared/codec/binary.ts); snapshots go out through the same per-socket
// latency injector (netsim.ts) as everything else, so a test lag affects all traffic alike.
//
// Lab 6: every incoming text frame goes through parseClientMessage(data: unknown) and comes out
// as a ClientMessage — a discriminated union; the dispatch below is an exhaustive switch.
//
// Lab 8: the handshake checks the Origin header (the WebSocket's CORS) and caps connections per
// IP; every refusal and every server-side close is counted by reason (-> /metrics). Logs are
// pino events with playerId/roomId fields. On shutdown each client gets a "shutdown" message
// and then close code 1001.

import { randomUUID } from "node:crypto";
import type { Server, IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, WebSocket, type RawData } from "ws";
import {
  CLOSE,
  PROTOCOL_VERSION,
  parseClientMessage,
  type ClientMessage,
  type ClientMessageOf,
  type CloseCode,
  type NetsimSettings,
  type RoomSummary,
  type ServerMessage,
} from "@dogfight/shared/protocol/control.ts";
import { parseInputFields, TICK_RATE, type Input } from "@dogfight/shared/protocol/messages.ts";
import { binaryCodec } from "@dogfight/shared/codec/binary.ts";
import type { CodecName } from "@dogfight/shared/codec/codec.ts";
import { assertNever } from "@dogfight/shared/sim/math.ts";
import { tick as toTick, type PlayerId } from "@dogfight/shared/protocol/ids.ts";
import { TokenBucket } from "./ratelimit.ts";
import { startHeartbeat, type HeartbeatClient } from "./heartbeat.ts";
import { Match, type MatchStats } from "./match.ts";
import { createLink, parseNetsim, NO_NETSIM, type Link } from "./netsim.ts";
import { RoomError, type Member, type Room, type RoomManager } from "./rooms.ts";
import { Bot } from "./bot.ts";
import type { ServerConfig } from "./config.ts";
import { errorMessage } from "./errors.ts";
import { silentLogger, type Logger } from "./logger.ts";

const MAX_REASON_BYTES = 120; // close reasons must fit in 123 bytes (RFC 6455 §5.5)

const clip = (text: string) => {
  const buf = Buffer.from(text);
  return buf.length <= MAX_REASON_BYTES ? text : buf.subarray(0, MAX_REASON_BYTES).toString();
};

/** Builders for server -> client messages: one place decides their shape (typed by the schema). */
export const out = {
  welcome: (
    playerId: string,
    slot: PlayerId,
    room: RoomSummary,
    extra: { tickRate: number; codec: CodecName; netsim: NetsimSettings; boot?: string },
  ): ServerMessage => ({ type: "welcome", v: PROTOCOL_VERSION, playerId, slot, room, ...extra }),
  roster: (
    room: Room,
    slotOf: (id: string) => PlayerId | undefined = () => undefined,
  ): ServerMessage => ({
    type: "roster",
    room: room.id,
    players: room.roster().map((p) => ({ ...p, slot: slotOf(p.id) })),
  }),
  pong: (t: number, tick: number): ServerMessage => ({ type: "pong", t, tick: toTick(tick) }),
  chat: (player: Member, text: string, t: number): ServerMessage => ({
    type: "chat",
    from: { id: player.id, name: player.name },
    text,
    t,
  }),
  system: (text: string, t: number): ServerMessage => ({ type: "system", text, t }),
  error: (code: number, message: string): ServerMessage => ({ type: "error", code, message }),
  shutdown: (reason: string, retryMs: number): ServerMessage => ({
    type: "shutdown",
    reason,
    retryMs,
  }),
};

/** 4008 -> "rate_limit": close codes as metric labels. */
const CLOSE_NAME: ReadonlyMap<number, string> = new Map(
  Object.entries(CLOSE).map(([name, code]) => [code, name.toLowerCase()]),
);

/** Everything the server keeps about one socket. */
type Session = {
  readonly id: string;
  readonly codec: CodecName;
  readonly link: Link;
  readonly bucket: TokenBucket;
  readonly inputBucket: TokenBucket;
  readonly joinTimer: ReturnType<typeof setTimeout>;
  readonly ip: string;
  log: Logger;
  name: string | null;
  room: Room | null;
  missedPongs: number;
  dropped: number;
};

export type SocketCounters = {
  slowDrops: number;
  terminated: number;
  /** total of `rejections` */
  rejected: number;
  snapshotsSkipped: number;
  /** Lab 8: refused handshakes and server-side closes, by reason (origin, per_ip, rate_limit…) */
  rejections: Record<string, number>;
  messagesIn: number;
  messagesOut: number;
  bytesIn: number;
  bytesOut: number;
};

export type Sockets = {
  readonly wss: WebSocketServer;
  readonly counters: SocketCounters;
  readonly connections: number;
  matchStats(): MatchStats[];
  addBots(roomId: string, count: number): number;
  /** players connected from one address (Lab 8 per-IP cap) */
  perIp(ip: string): number;
  shutdown(graceMs?: number): Promise<void>;
};

const byteLength = (data: RawData): number =>
  Array.isArray(data) ? data.reduce((n, b) => n + b.length, 0) : data.byteLength;

export function attachWebSockets(
  server: Server,
  {
    config,
    rooms,
    log = silentLogger,
    boot = randomUUID().slice(0, 8),
    onTick,
    onMatchEnd,
  }: {
    config: ServerConfig;
    rooms: RoomManager;
    log?: Logger;
    /** Lab 8: this process's id, sent in "welcome": a client that sees a new one knows we restarted */
    boot?: string;
    onTick?: (roomId: string, ms: number) => void;
    onMatchEnd?: (roomId: string) => void;
  },
): Sockets {
  const wss = new WebSocketServer({ noServer: true, maxPayload: config.maxPayloadBytes });
  const members = new Map<string, Set<WebSocket>>(); // roomId -> sockets
  const state = new WeakMap<WebSocket, Session>(); // WebSocket -> per-socket state
  const counters: SocketCounters = {
    slowDrops: 0,
    terminated: 0,
    rejected: 0,
    snapshotsSkipped: 0,
    rejections: {},
    messagesIn: 0,
    messagesOut: 0,
    bytesIn: 0,
    bytesOut: 0,
  };
  const count = (reason: string) => {
    counters.rejected++;
    counters.rejections[reason] = (counters.rejections[reason] ?? 0) + 1;
  };
  const connectionsPerIp = new Map<string, number>();
  let stopping = false;
  const matches = new Map<string, Match>(); // roomId -> Match
  const netsimAllowed = config.netsim || config.debugRoutes;

  wss.on("error", (err) => log.error({ event: "wss.error", err }));

  /** Behind a proxy every socket comes from the proxy: the client is in X-Forwarded-For. */
  function clientIp(req: IncomingMessage): string {
    const forwarded = req.headers["x-forwarded-for"];
    const first = (Array.isArray(forwarded) ? forwarded[0] : forwarded)?.split(",")[0]?.trim();
    return (config.trustProxy && first) || req.socket.remoteAddress || "unknown";
  }

  /**
   * The WebSocket's "CORS": a browser always sends the page's Origin on the handshake, and any
   * page on the internet can open `new WebSocket("wss://our.app/ws")` as its visitors. Allowed:
   * our own page (Origin host == Host), the ALLOWED_ORIGINS list, and no Origin at all — that is
   * not a browser (load test, curl), and a script can fake any header anyway.
   */
  function originAllowed(req: IncomingMessage): boolean {
    const origin = req.headers.origin;
    if (origin === undefined) return true;
    if (config.allowedOrigins.includes("*") || config.allowedOrigins.includes(origin)) return true;
    try {
      return new URL(origin).host === req.headers.host;
    } catch {
      return false; // "null" (file://, sandboxed iframe) and garbage
    }
  }

  // ---- the handshake: HTTP "Upgrade: websocket" on /ws only ------------------------------------
  server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    socket.on("error", () => socket.destroy()); // a raw socket is an emitter too
    const { pathname } = new URL(req.url ?? "/", "http://localhost");
    const ip = clientIp(req);
    const refuse = (status: number, text: string, reason: string) => {
      count(reason);
      log.warn({ event: "ws.rejected", reason, ip, origin: req.headers.origin });
      socket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    };
    if (pathname !== "/ws") return refuse(404, "Not Found", "not_found");
    if (stopping) return refuse(503, "Shutting Down", "shutdown");
    if (!originAllowed(req)) return refuse(403, "Forbidden", "origin");
    if (wss.clients.size >= config.maxConnections) return refuse(503, "Server Full", "full");
    if ((connectionsPerIp.get(ip) ?? 0) >= config.maxConnectionsPerIp)
      return refuse(429, "Too Many Connections", "per_ip");
    wss.handleUpgrade(req, socket, head, (ws) => onConnection(ws, req, ip));
  });

  // ---- sending, with the slow-client policy -----------------------------------------------------
  function send(ws: WebSocket, message: ServerMessage, { critical = false } = {}): boolean {
    if (ws.readyState !== WebSocket.OPEN) return false;
    const s = state.get(ws);
    if (ws.bufferedAmount > config.dropClientBytes) {
      // The client stopped reading. Its queue lives in OUR memory: cut it off.
      (s?.log ?? log).warn({
        event: "ws.terminated",
        reason: "slow_client",
        queued: ws.bufferedAmount,
      });
      counters.terminated++;
      count("slow_client");
      ws.terminate();
      return false;
    }
    if (!critical && ws.bufferedAmount > config.slowClientBytes) {
      counters.slowDrops++;
      if (s) s.dropped++;
      return false; // a chat line may be lost; the roster never is
    }
    const text = JSON.stringify(message);
    counters.messagesOut++;
    counters.bytesOut += text.length; // ASCII-ish JSON: close enough, and no extra pass
    if (s) s.link.out(() => ws.readyState === WebSocket.OPEN && ws.send(text));
    else ws.send(text);
    return true;
  }

  /** Real-time frame (snapshot): droppable by the injector, skipped for a slow client. */
  function sendFrame(ws: WebSocket, frame: Uint8Array | string): void {
    const s = state.get(ws);
    if (!s || ws.readyState !== WebSocket.OPEN) return;
    if (ws.bufferedAmount > config.slowClientBytes) {
      counters.snapshotsSkipped++; // the next snapshot supersedes this one anyway
      return;
    }
    counters.messagesOut++;
    counters.bytesOut += typeof frame === "string" ? frame.length : frame.byteLength;
    s.link.out(() => ws.readyState === WebSocket.OPEN && ws.send(frame), true);
  }

  function broadcast(
    roomId: string,
    message: ServerMessage,
    options?: { critical?: boolean },
  ): void {
    for (const ws of members.get(roomId) ?? []) send(ws, message, options);
  }

  function close(ws: WebSocket, code: CloseCode, reason: string): void {
    const s = state.get(ws);
    count(CLOSE_NAME.get(code) ?? String(code));
    (s?.log ?? log).warn({ event: "ws.close", code, reason });
    if (ws.readyState === WebSocket.OPEN) {
      send(ws, out.error(code, reason), { critical: true });
      ws.close(code, clip(reason));
    }
  }

  // ---- room events -> sockets -------------------------------------------------------------------
  const slotOf = (room: Room) => (sessionId: string) => matches.get(room.id)?.slotOf(sessionId);

  function stopMatch(room: Room): void {
    const match = matches.get(room.id);
    if (!match) return;
    match.stop();
    matches.delete(room.id);
    onMatchEnd?.(room.id);
    log.info({ event: "match.stopped", roomId: room.id, ticks: match.tick });
  }

  function watchRoom(room: Room): void {
    room.on("empty", () => stopMatch(room));
    room.on("close", () => stopMatch(room));
    room.on("join", (player) => {
      broadcast(room.id, out.roster(room, slotOf(room)), { critical: true });
      broadcast(room.id, out.system(`${player.name} приєднався`, Date.now()));
    });
    room.on("leave", (player, reason) => {
      broadcast(room.id, out.roster(room, slotOf(room)), { critical: true });
      broadcast(room.id, out.system(`${player.name} вийшов (${reason})`, Date.now()));
    });
    room.on("chat", (player, text, t) => broadcast(room.id, out.chat(player, text, t)));
    room.on("close", () => members.delete(room.id));
  }
  for (const room of rooms.rooms()) watchRoom(room);
  rooms.on("created", watchRoom);

  function ensureMatch(room: Room): Match {
    let match = matches.get(room.id);
    if (!match) {
      match = new Match(room, onTick && { onTickMs: (ms: number) => onTick(room.id, ms) });
      matches.set(room.id, match);
      match.start();
      log.info({ event: "match.started", roomId: room.id, seed: match.seed });
    }
    return match;
  }

  // ---- bots (Lab 7) ------------------------------------------------------------------------------
  const botsByRoom = new Map<string, string[]>(); // roomId -> bot session ids
  let botSeed = 1;

  /** Adds up to `count` bots (as many as fit). Returns how many were added. */
  function addBots(roomId: string, count: number): number {
    const room = rooms.get(roomId);
    if (!room) throw new RoomError("not_found", `no room ${roomId}`);
    const ids = botsByRoom.get(roomId) ?? [];
    botsByRoom.set(roomId, ids);
    let added = 0;
    while (added < count && !room.isFull) {
      const id = `bot-${botSeed}`;
      const name = `Бот ${ids.length + 1}`;
      const match = ensureMatch(room);
      match.addBot(id, name, new Bot(botSeed++));
      room.join({ id, name }); // bots are in the roster: players can see who they fight
      ids.push(id);
      added++;
    }
    return added;
  }

  /** Bots never keep a room alive on their own: when the last human leaves, they go too. */
  function removeBots(room: Room): void {
    const ids = botsByRoom.get(room.id) ?? [];
    botsByRoom.delete(room.id);
    for (const id of ids) {
      matches.get(room.id)?.removeClient(id);
      room.leave(id, "bot removed");
    }
  }

  function leaveRoom(ws: WebSocket, reason: string): void {
    const s = state.get(ws);
    if (!s?.room) return;
    const room = s.room;
    s.room = null;
    members.get(room.id)?.delete(ws);
    matches.get(room.id)?.removeClient(s.id);
    room.leave(s.id, reason); // may emit "empty" -> RoomManager deletes a temporary room
    if (!members.get(room.id)?.size && botsByRoom.has(room.id)) removeBots(room);
  }

  // ---- one message, by type ---------------------------------------------------------------------
  function onJoin(ws: WebSocket, s: Session, msg: ClientMessageOf<"join">): void {
    if (s.room) return close(ws, CLOSE.BAD_SHAPE, "already in a room");
    const room = rooms.get(msg.room);
    if (!room) return close(ws, CLOSE.ROOM_UNAVAILABLE, `no room ${msg.room}`);
    if (room.isFull) return close(ws, CLOSE.ROOM_UNAVAILABLE, `room ${room.name} is full`);
    clearTimeout(s.joinTimer);
    s.name = msg.name;
    s.room = room;
    s.log = s.log.child({ roomId: room.id });
    const sockets = members.get(room.id) ?? new Set<WebSocket>();
    members.set(room.id, sockets.add(ws));
    // The match exists BEFORE room.join() so the roster broadcast already knows the slot.
    const match = ensureMatch(room);
    const slot = match.addClient(s.id, msg.name, {
      codec: s.codec,
      send: (frame) => sendFrame(ws, frame),
    });
    send(
      ws,
      out.welcome(s.id, slot, room.summary(), {
        tickRate: TICK_RATE,
        codec: s.codec,
        netsim: s.link.settings,
        boot,
      }),
      {
        critical: true,
      },
    );
    room.join({ id: s.id, name: msg.name }); // -> "join" -> roster broadcast to everyone
    s.log.info({ event: "player.joined", slot, name: msg.name });
  }

  function acceptInput(ws: WebSocket, s: Session, input: Input, bytes: number): void {
    if (!s.room) return close(ws, CLOSE.NOT_JOINED, "join a room first");
    matches.get(s.room.id)?.pushInput(s.id, input, bytes);
  }

  /** One validated control message. Exhaustive: a new message type must be handled here. */
  function handle(ws: WebSocket, s: Session, msg: ClientMessage, bytes: number): void {
    switch (msg.type) {
      case "join":
        return onJoin(ws, s, msg);
      case "chat":
        if (!s.room) return close(ws, CLOSE.NOT_JOINED, "join a room first");
        s.room.chat(s.id, msg.text);
        return;
      case "leave":
        leaveRoom(ws, "left");
        ws.close(CLOSE.NORMAL, "bye");
        return;
      case "ping":
        send(ws, out.pong(msg.t, s.room ? (matches.get(s.room.id)?.tick ?? 0) : 0), {
          critical: true,
        });
        return;
      case "input": {
        const input = parseInputFields(msg.seq, msg.tick, msg.b);
        if (typeof input === "string") return close(ws, CLOSE.BAD_SHAPE, `input: ${input}`);
        return acceptInput(ws, s, input, bytes);
      }
      case "netsim":
        if (!netsimAllowed) return close(ws, CLOSE.BAD_SHAPE, "latency injector is disabled");
        s.link.set({ lag: msg.lag, jitter: msg.jitter, drop: msg.drop });
        s.log.debug({ event: "netsim.set", ...s.link.settings });
        return;
      default:
        return assertNever(msg, "client message");
    }
  }

  function onBinary(ws: WebSocket, s: Session, data: RawData): void {
    let input: Input;
    try {
      // ws hands a Buffer (or Buffer[] for a fragmented message, or an ArrayBuffer)
      input = binaryCodec.decodeInput(Array.isArray(data) ? Buffer.concat(data) : data);
    } catch (error: unknown) {
      return close(ws, CLOSE.BAD_SHAPE, errorMessage(error));
    }
    acceptInput(ws, s, input, byteLength(data));
  }

  function onConnection(ws: WebSocket, req: IncomingMessage, ip: string): void {
    const id = randomUUID().slice(0, 8);
    const query = new URL(req.url ?? "/", "http://localhost").searchParams;
    const s: Session = {
      codec: query.get("codec") === "json" ? "json" : "binary",
      link: createLink(netsimAllowed ? parseNetsim(query) : NO_NETSIM),
      inputBucket: new TokenBucket({
        perSecond: config.inputRatePerSec,
        burst: config.inputRateBurst,
      }),
      id,
      ip,
      log: log.child({ playerId: id }),
      name: null,
      room: null,
      missedPongs: 0,
      dropped: 0,
      bucket: new TokenBucket({ perSecond: config.rateLimitPerSec, burst: config.rateLimitBurst }),
      joinTimer: setTimeout(
        () => close(ws, CLOSE.JOIN_TIMEOUT, "no join within timeout"),
        config.joinTimeoutMs,
      ),
    };
    state.set(ws, s);
    connectionsPerIp.set(ip, (connectionsPerIp.get(ip) ?? 0) + 1);
    s.log.info({ event: "ws.connected", ip });

    // ALWAYS: an "error" with no listener would throw and take the whole server down.
    ws.on("error", (error) => s.log.warn({ event: "ws.error", message: error.message }));
    ws.on("pong", () => (s.missedPongs = 0));
    ws.on("message", (data, isBinary) => {
      counters.messagesIn++;
      counters.bytesIn += byteLength(data);
      // Real-time inputs (binary, or JSON "input") have their own, larger budget.
      const isInput = isBinary || String(data).startsWith('{"type":"input"');
      const bucket = isInput ? s.inputBucket : s.bucket;
      if (!bucket.take()) return close(ws, CLOSE.RATE_LIMIT, "too many messages");
      // Through the latency injector: inputs may be dropped, control messages never.
      s.link.in(() => {
        if (ws.readyState !== WebSocket.OPEN) return;
        if (isBinary) return onBinary(ws, s, data);
        const parsed = parseClientMessage(data);
        if (!parsed.ok) return close(ws, parsed.code, parsed.reason);
        try {
          handle(ws, s, parsed.msg, byteLength(data));
        } catch (err: unknown) {
          s.log.error({ event: "ws.handler_error", err });
          close(ws, CLOSE.BAD_SHAPE, "could not process message");
        }
      }, isInput);
    });
    ws.on("close", (code) => {
      clearTimeout(s.joinTimer);
      const left = (connectionsPerIp.get(ip) ?? 1) - 1;
      if (left > 0) connectionsPerIp.set(ip, left);
      else connectionsPerIp.delete(ip); // the map never grows with addresses that left
      const reason =
        code === CLOSE.NORMAL
          ? "left"
          : code === CLOSE.GOING_AWAY
            ? "server shutdown"
            : "disconnected";
      leaveRoom(ws, reason);
      s.log.info({ event: "ws.closed", code });
    });
  }

  // ---- heartbeat ---------------------------------------------------------------------------------
  function* heartbeatClients(): Generator<HeartbeatClient> {
    for (const ws of wss.clients) {
      const s = state.get(ws);
      if (!s) continue;
      yield {
        get missedPongs() {
          return s.missedPongs;
        },
        set missedPongs(n) {
          s.missedPongs = n;
        },
        ping: () => ws.ping(),
        terminate: () => {
          s.log.warn({ event: "ws.terminated", reason: "missed_pongs" });
          count("missed_pongs");
          ws.terminate();
        },
      };
    }
  }
  const stopHeartbeat = startHeartbeat(config.heartbeatMs, heartbeatClients, (n) => {
    counters.terminated += n;
  });

  return {
    wss,
    counters,
    matchStats: () => [...matches.values()].map((m) => m.stats()),
    addBots,
    get connections() {
      return wss.clients.size;
    },
    perIp: (ip) => connectionsPerIp.get(ip) ?? 0,
    /**
     * Graceful: refuse new handshakes, tell every client why ("shutdown" message — the lobby
     * shows it), close with 1001, wait up to `graceMs`, then terminate whoever is left.
     */
    async shutdown(graceMs = config.shutdownGraceMs) {
      stopping = true;
      stopHeartbeat();
      for (const room of rooms.rooms()) stopMatch(room);
      const closed = [...wss.clients].map(
        (ws) =>
          new Promise<void>((resolve) => {
            if (ws.readyState === WebSocket.CLOSED) return resolve();
            ws.once("close", () => resolve());
            // Straight to the socket, not through the latency injector: we are leaving NOW.
            if (ws.readyState === WebSocket.OPEN)
              ws.send(JSON.stringify(out.shutdown("сервер перезапускається", 2000)));
            ws.close(CLOSE.GOING_AWAY, "server shutting down");
          }),
      );
      const timer = setTimeout(() => {
        for (const ws of wss.clients) ws.terminate();
      }, graceMs);
      await Promise.all(closed);
      clearTimeout(timer);
      await new Promise<void>((resolve) => wss.close(() => resolve()));
    },
  };
}
