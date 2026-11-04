// WebSocket connection lifecycle (Lab 4, M2 + M4).
//
//  upgrade ─▶ connection ─▶ must send "join" within JOIN_TIMEOUT_MS ─▶ in a room ─▶ close
//
// Every frame is rate-limited (token bucket), parsed and validated (protocol.js); anything
// wrong closes the socket with a specific code. Heartbeat: a ping every HEARTBEAT_MS, and a
// socket that missed two pongs in a row is terminated (dead NAT mappings, sleeping laptops).
// Rooms never see sockets: this module LISTENS to room events and broadcasts.

import { randomUUID } from "node:crypto";
import { WebSocketServer, WebSocket } from "ws";
import { CLOSE, out, parseClientMessage } from "./protocol.js";
import { TokenBucket } from "./ratelimit.js";

const MAX_REASON_BYTES = 120; // close reasons must fit in 123 bytes (RFC 6455 §5.5)

const clip = (text) => {
  const buf = Buffer.from(text);
  return buf.length <= MAX_REASON_BYTES ? text : buf.subarray(0, MAX_REASON_BYTES).toString();
};

export function attachWebSockets(server, { config, rooms, log = () => {} }) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: config.maxPayloadBytes });
  const members = new Map(); // roomId -> Set<WebSocket>
  const state = new WeakMap(); // WebSocket -> per-socket state
  const counters = { slowDrops: 0, terminated: 0, rejected: 0 };

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
    ws.send(JSON.stringify(message));
    return true;
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
  function watchRoom(room) {
    room.on("join", (player) => {
      broadcast(room.id, out.roster(room), { critical: true });
      broadcast(room.id, out.system(`${player.name} приєднався`, Date.now()));
    });
    room.on("leave", (player, reason) => {
      broadcast(room.id, out.roster(room), { critical: true });
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
      send(ws, out.welcome(s.id, room.summary()), { critical: true });
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
  };

  wss.on("connection", (ws, req) => {
    const s = {
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
      if (!s.bucket.take()) return close(ws, CLOSE.RATE_LIMIT, "too many messages");
      const parsed = parseClientMessage(data, isBinary);
      if (!parsed.ok) return close(ws, parsed.code, parsed.reason);
      try {
        handlers[parsed.msg.type](ws, s, parsed.msg);
      } catch (error) {
        log(`[${s.id}] handler error: ${error.stack}`);
        close(ws, CLOSE.BAD_SHAPE, "could not process message");
      }
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
    get connections() {
      return wss.clients.size;
    },
    /** Graceful: close every socket with 1001, wait up to `graceMs`, then terminate the rest. */
    async shutdown(graceMs = 2000) {
      clearInterval(heartbeat);
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
