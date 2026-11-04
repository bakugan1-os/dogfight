// Protocol v1 — JSON text frames, one object per message, always with a `type`.
// The server validates EVERY incoming message: it never trusts a client, not even our own
// (anyone can open the DevTools console and send whatever they like).
//
// client -> server                         server -> client
//   { type:"join", v:1, room, name }         { type:"welcome", v:1, playerId, room }
//   { type:"chat", text }                    { type:"roster", room, players:[{id,name}] }
//   { type:"leave" }                         { type:"chat", from:{id,name}, text, t }
//                                            { type:"system", text, t }
//                                            { type:"error", code, message }

export const PROTOCOL_VERSION = 1;

/** WebSocket close codes. 4000-4999 are ours (RFC 6455 §7.4.2: reserved for applications). */
export const CLOSE = Object.freeze({
  NORMAL: 1000,
  GOING_AWAY: 1001, // server shutting down
  TOO_BIG: 1009, // sent by `ws` itself when a frame exceeds maxPayload
  BAD_JSON: 4000,
  UNKNOWN_TYPE: 4001,
  BAD_SHAPE: 4002,
  JOIN_TIMEOUT: 4003,
  ROOM_UNAVAILABLE: 4004,
  VERSION: 4005,
  NOT_JOINED: 4006,
  RATE_LIMIT: 4008,
  SLOW_CLIENT: 4009,
  HEARTBEAT: 4010,
  SERVER_FULL: 4011,
});

export const LIMITS = Object.freeze({ name: 16, text: 280, roomId: 64 });

const isString = (v, max) => typeof v === "string" && v.trim().length > 0 && v.length <= max;

/** Per type: the exact set of allowed keys and a check for each. Unknown keys are refused. */
const SCHEMAS = {
  join: {
    v: (v) => v === PROTOCOL_VERSION || "unsupported protocol version",
    room: (v) => isString(v, LIMITS.roomId) || `room: 1..${LIMITS.roomId} chars`,
    name: (v) => isString(v, LIMITS.name) || `name: 1..${LIMITS.name} chars`,
  },
  chat: {
    text: (v) => isString(v, LIMITS.text) || `text: 1..${LIMITS.text} chars`,
  },
  leave: {},
};

/**
 * @param {Buffer|string} data  raw frame payload
 * @param {boolean} isBinary
 * @returns {{ok:true, msg:object} | {ok:false, code:number, reason:string}}
 */
export function parseClientMessage(data, isBinary = false) {
  if (isBinary) return { ok: false, code: CLOSE.BAD_SHAPE, reason: "binary frames not supported" };
  let msg;
  try {
    msg = JSON.parse(String(data));
  } catch {
    return { ok: false, code: CLOSE.BAD_JSON, reason: "not JSON" };
  }
  if (!msg || typeof msg !== "object" || Array.isArray(msg)) {
    return { ok: false, code: CLOSE.BAD_SHAPE, reason: "expected an object" };
  }
  const schema = Object.hasOwn(SCHEMAS, msg.type) ? SCHEMAS[msg.type] : null;
  if (!schema) return { ok: false, code: CLOSE.UNKNOWN_TYPE, reason: `unknown type ${msg.type}` };
  for (const key of Object.keys(msg)) {
    if (key !== "type" && !Object.hasOwn(schema, key)) {
      return { ok: false, code: CLOSE.BAD_SHAPE, reason: `unexpected field ${key}` };
    }
  }
  for (const [key, check] of Object.entries(schema)) {
    const verdict = check(msg[key]);
    if (verdict !== true) {
      const code = key === "v" ? CLOSE.VERSION : CLOSE.BAD_SHAPE;
      return { ok: false, code, reason: verdict };
    }
  }
  if (msg.name) msg.name = msg.name.trim();
  if (msg.text) msg.text = msg.text.trim();
  return { ok: true, msg };
}

/** Builders for server -> client messages: one place decides their shape. */
export const out = {
  welcome: (playerId, room) => ({ type: "welcome", v: PROTOCOL_VERSION, playerId, room }),
  roster: (room) => ({ type: "roster", room: room.id, players: room.roster() }),
  chat: (player, text, t) => ({
    type: "chat",
    from: { id: player.id, name: player.name },
    text,
    t,
  }),
  system: (text, t) => ({ type: "system", text, t }),
  error: (code, message) => ({ type: "error", code, message }),
};
