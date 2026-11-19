// WebSocket connection lifecycle (Lab 4, M2 + M4).
//
//  upgrade ─▶ connection ─▶ must send "join" within JOIN_TIMEOUT_MS ─▶ in a room ─▶ close
//
// Every frame is rate-limited (token bucket), parsed and validated (protocol.js); anything
// wrong closes the socket with a specific code. Heartbeat: a ping every HEARTBEAT_MS, and a
// socket that missed two pongs in a row is terminated (dead NAT mappings, sleeping laptops).
// Rooms never see sockets: this module LISTENS to room events and broadcasts.
//
// Lab 5: each room with players has a Match (match.js) — the authoritative 30 Hz simulation.
// Binary frames are INPUTs (shared/codec/binary.js); snapshots go out through the same per-socket
// latency injector (netsim.js) as everything else, so a test lag affects all traffic alike.

import { randomUUID } from "node:crypto";
import { WebSocketServer, WebSocket } from "ws";
import { CLOSE, out, parseClientMessage } from "./protocol.js";
import { TokenBucket } from "./ratelimit.js";
import { Match } from "./match.js";
import { createLink, parseNetsim, NO_NETSIM } from "./netsim.js";
import * as binaryCodec from "@dogfight/shared/codec/binary.js";
import { inputFromButtons, inputProblem, TICK_RATE } from "@dogfight/shared/protocol/messages.js";

const MAX_REASON_BYTES = 120; // close reasons must fit in 123 bytes (RFC 6455 §5.5)

const clip = (text) => {
  const buf = Buffer.from(text);
  return buf.length <= MAX_REASON_BYTES ? text : buf.subarray(0, MAX_REASON_BYTES).toString();
};

export function attachWebSockets(server, { config, rooms, log = () => {} }) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: config.maxPayloadBytes });
  const members = new Map(); // roomId -> Set<WebSocket>
  const state = new WeakMap(); // WebSocket -> per-socket state
  const counters = { slowDrops: 0, terminated: 0, rejected: 0, snapshotsSkipped: 0 };
  const matches = new Map(); // roomId -> Match
  const netsimAllowed = config.netsim || config.debugRoutes;

  wss.on("error", (error) => log(`wss error: ${error.message}`));

  // ---- the handshake: HTTP "Upgrade: websocket" on /ws only ------------------------------------
  server.on("upgrade", (req, socket, head) => {
    socket.on("error", () => socket.destroy()); // a raw socket is an emitter too
    const { pathname } = new URL(req.url, "http://localhost");
    const refuse = (status, text) => {
      counters.rejected++;
      socket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    };
    if (pathname !== "/ws") return refuse(404, "Not Found");
    if (wss.clients.size >= config.maxConnections) return refuse(503, "Server Full");
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  });

  // ---- sending, with the slow-client policy -----------------------------------------------------
  function send(ws, message, { critical = false } = {}) {
    if (ws.readyState !== WebSocket.OPEN) return false;
    const s = state.get(ws);
    if (ws.bufferedAmount > config.dropClientBytes) {
      // The client stopped reading. Its queue lives in OUR memory: cut it off.
      log(`[${s?.id}] terminated: ${ws.bufferedAmount} bytes queued (slow client)`);
      counters.terminated++;
      ws.terminate();
      return false;
    }
    if (!critical && ws.bufferedAmount > config.slowClientBytes) {
      counters.slowDrops++;
      if (s) s.dropped++;
      return false; // a chat line may be lost; the roster never is
    }
    const text = JSON.stringify(message);
    if (s?.link) s.link.out(() => ws.readyState === WebSocket.OPEN && ws.send(text));
    else ws.send(text);
    return true;
  }

  /** Real-time frame (snapshot): droppable by the injector, skipped for a slow client. */
  function sendFrame(ws, frame) {
    const s = state.get(ws);
    if (ws.readyState !== WebSocket.OPEN) return;
    if (ws.bufferedAmount > config.slowClientBytes) {
      counters.snapshotsSkipped++; // the next snapshot supersedes this one anyway
      return;
    }
    s.link.out(() => ws.readyState === WebSocket.OPEN && ws.send(frame), true);
  }

  function broadcast(roomId, message, options) {
    for (const ws of members.get(roomId) ?? []) send(ws, message, options);
  }

  function close(ws, code, reason) {
    const s = state.get(ws);
    log(`[${s?.id}] close ${code}: ${reason}`);
    if (ws.readyState === WebSocket.OPEN) {
      send(ws, out.error(code, reason), { critical: true });
      ws.close(code, clip(reason));
    }
  }

  // ---- room events -> sockets -------------------------------------------------------------------
  const slotOf = (room) => (sessionId) => matches.get(room.id)?.slotOf(sessionId);

  function stopMatch(room) {
    matches.get(room.id)?.stop();
    matches.delete(room.id);
  }

  function watchRoom(room) {
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
  for (const summary of rooms.list()) watchRoom(rooms.get(summary.id));
  rooms.on("created", watchRoom);

  function leaveRoom(ws, reason) {
    const s = state.get(ws);
    if (!s?.room) return;
    const room = s.room;
    s.room = null;
    members.get(room.id)?.delete(ws);
    matches.get(room.id)?.removeClient(s.id);
    room.leave(s.id, reason); // may emit "empty" -> RoomManager deletes a temporary room
  }

  // ---- one connection ---------------------------------------------------------------------------
  const handlers = {
    join(ws, s, msg) {
      if (s.room) return close(ws, CLOSE.BAD_SHAPE, "already in a room");
      const room = rooms.get(msg.room);
      if (!room) return close(ws, CLOSE.ROOM_UNAVAILABLE, `no room ${msg.room}`);
      if (room.isFull) return close(ws, CLOSE.ROOM_UNAVAILABLE, `room ${room.name} is full`);
      clearTimeout(s.joinTimer);
      s.name = msg.name;
      s.room = room;
      if (!members.has(room.id)) members.set(room.id, new Set());
      members.get(room.id).add(ws);
      // The match exists BEFORE room.join() so the roster broadcast already knows the slot.
      let match = matches.get(room.id);
      if (!match) {
        match = new Match(room);
        matches.set(room.id, match);
        match.start();
        log(`match ${room.id} started (seed ${match.seed})`);
      }
      const slot = match.addClient(s.id, s.name, {
        codec: s.codec,
        send: (frame) => sendFrame(ws, frame),
      });
      send(
        ws,
        out.welcome(s.id, slot, room.summary(), {
          tickRate: TICK_RATE,
          codec: s.codec,
          netsim: s.link.settings,
        }),
        { critical: true },
      );
      room.join({ id: s.id, name: s.name }); // -> "join" -> roster broadcast to everyone
      log(`[${s.id}] ${s.name} joined ${room.id}`);
    },
    chat(ws, s, msg) {
      if (!s.room) return close(ws, CLOSE.NOT_JOINED, "join a room first");
      s.room.chat(s.id, msg.text);
    },
    leave(ws) {
      leaveRoom(ws, "left");
      ws.close(CLOSE.NORMAL, "bye");
    },
    ping(ws, s, msg) {
      send(ws, out.pong(msg.t, s.room ? (matches.get(s.room.id)?.tick ?? 0) : 0), {
        critical: true,
      });
    },
    input(ws, s, msg, bytes) {
      acceptInput(ws, s, inputFromButtons(msg.seq, msg.tick, msg.b), bytes);
    },
    netsim(ws, s, msg) {
      if (!netsimAllowed) return close(ws, CLOSE.BAD_SHAPE, "latency injector is disabled");
      s.link.set({ lag: msg.lag, jitter: msg.jitter, drop: msg.drop });
      log(`[${s.id}] netsim ${JSON.stringify(s.link.settings)}`);
    },
  };

  function acceptInput(ws, s, input, bytes) {
    if (!s.room) return close(ws, CLOSE.NOT_JOINED, "join a room first");
    const problem = inputProblem(input);
    if (problem) return close(ws, CLOSE.BAD_SHAPE, `input: ${problem}`);
    matches.get(s.room.id)?.pushInput(s.id, input, bytes);
  }

  function onBinary(ws, s, data) {
    let input;
    try {
      input = binaryCodec.decodeInput(data);
    } catch (error) {
      return close(ws, CLOSE.BAD_SHAPE, error.message);
    }
    acceptInput(ws, s, input, data.length);
  }

  wss.on("connection", (ws, req) => {
    const query = new URL(req.url, "http://localhost").searchParams;
    const s = {
      codec: query.get("codec") === "json" ? "json" : "binary",
      link: createLink(netsimAllowed ? parseNetsim(query) : NO_NETSIM),
      inputBucket: new TokenBucket({
        perSecond: config.inputRatePerSec,
        burst: config.inputRateBurst,
      }),
      id: randomUUID().slice(0, 8),
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
    log(`[${s.id}] connected from ${req.socket.remoteAddress}`);

    // ALWAYS: an "error" with no listener would throw and take the whole server down.
    ws.on("error", (error) => log(`[${s.id}] socket error: ${error.message}`));
    ws.on("pong", () => (s.missedPongs = 0));
    ws.on("message", (data, isBinary) => {
      // Real-time inputs (binary, or JSON "input") have their own, larger budget.
      const isInput = isBinary || String(data).startsWith('{"type":"input"');
      const bucket = isInput ? s.inputBucket : s.bucket;
      if (!bucket.take()) return close(ws, CLOSE.RATE_LIMIT, "too many messages");
      // Through the latency injector: inputs may be dropped, control messages never.
      s.link.in(() => {
        if (ws.readyState !== WebSocket.OPEN) return;
        if (isBinary) return onBinary(ws, s, data);
        const parsed = parseClientMessage(data, false);
        if (!parsed.ok) return close(ws, parsed.code, parsed.reason);
        try {
          handlers[parsed.msg.type](ws, s, parsed.msg, data.length);
        } catch (error) {
          log(`[${s.id}] handler error: ${error.stack}`);
          close(ws, CLOSE.BAD_SHAPE, "could not process message");
        }
      }, isInput);
    });
    ws.on("close", (code) => {
      clearTimeout(s.joinTimer);
      const reason =
        code === CLOSE.NORMAL
          ? "left"
          : code === CLOSE.GOING_AWAY
            ? "server shutdown"
            : "disconnected";
      leaveRoom(ws, reason);
      log(`[${s.id}] closed (${code})`);
    });
  });

  // ---- heartbeat ---------------------------------------------------------------------------------
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      const s = state.get(ws);
      if (s.missedPongs >= 2) {
        log(`[${s.id}] terminated: missed 2 pongs`);
        counters.terminated++;
        ws.terminate(); // no close handshake: the peer is not listening anyway
        continue;
      }
      s.missedPongs++;
      ws.ping();
    }
  }, config.heartbeatMs);
  heartbeat.unref();

  return {
    wss,
    counters,
    matchStats: () => [...matches.values()].map((m) => m.stats()),
    get connections() {
      return wss.clients.size;
    },
    /** Graceful: close every socket with 1001, wait up to `graceMs`, then terminate the rest. */
    async shutdown(graceMs = 2000) {
      clearInterval(heartbeat);
      for (const match of matches.values()) match.stop();
      const closed = [...wss.clients].map(
        (ws) =>
          new Promise((resolve) => {
            ws.once("close", resolve);
            ws.close(CLOSE.GOING_AWAY, "server shutting down");
          }),
      );
      const timer = setTimeout(() => {
        for (const ws of wss.clients) ws.terminate();
      }, graceMs);
      await Promise.all(closed);
      clearTimeout(timer);
      await new Promise((resolve) => wss.close(resolve));
    },
  };
}
