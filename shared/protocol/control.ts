// Control protocol v2 (Lab 4, typed in Lab 6): JSON text frames with a `type`. The real-time
// traffic (input up, snapshot down) goes through the codecs in shared/codec instead.
//
// ONE definition, both directions: every message is a zod schema; its TypeScript type is
// INFERRED from the schema (`z.infer`), so the runtime check and the compile-time type cannot
// drift apart. The server parses what clients send; the client parses what the server sends —
// neither side trusts the other (anyone can open DevTools and send whatever they like).
//
// client -> server                         server -> client
//   { type:"join", v:2, room, name }         { type:"welcome", v:2, playerId, slot, room, tickRate, codec, netsim }
//   { type:"chat", text }                    { type:"roster", room, players:[{id,name,slot?}] }
//   { type:"ping", t }                       { type:"pong", t, tick }
//   { type:"input", seq, tick, b }  (?codec=json only; otherwise a binary INPUT frame)
//   { type:"netsim", lag, jitter, drop }  (only if the server allows the latency injector)
//   { type:"leave" }                         { type:"chat", from:{id,name}, text, t }
//                                            { type:"system", text, t }
//                                            { type:"error", code, message }

import { z } from "zod";
import { PlayerIdSchema, TickSchema } from "./ids.ts";
import { ARENA_IDS } from "../sim/arenas.ts";

export const PROTOCOL_VERSION = 2; // v2 (Lab 5): binary input/snapshot frames, slots

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
} as const);
export type CloseCode = (typeof CLOSE)[keyof typeof CLOSE];

export const LIMITS = Object.freeze({ name: 16, text: 280, roomId: 64, roomName: 40 });

/** 1..max characters, measured BEFORE trimming; the parsed value is trimmed. */
const text = (max: number) => z.string().max(max).trim().min(1);

// ---- shared pieces ----------------------------------------------------------------------------

export const ArenaIdSchema = z.enum(ARENA_IDS);
export const ModeSchema = z.enum(["duel", "solo"]);
export type Mode = z.infer<typeof ModeSchema>;

/** GET /api/rooms entry — the shape the Lab 3 lobby understands. */
export const RoomSummarySchema = z.object({
  id: z.string().min(1).max(LIMITS.roomId),
  name: z.string(),
  arena: ArenaIdSchema,
  mode: ModeSchema,
  players: z.number().int().min(0),
  maxPlayers: z.number().int().min(1),
  host: z.string(),
});
export type RoomSummary = z.infer<typeof RoomSummarySchema>;
export const RoomListSchema = z.object({ rooms: z.array(RoomSummarySchema) });

/** POST /api/rooms body. Unknown fields are refused (strictObject). */
export const CreateRoomSchema = z.strictObject({
  name: text(LIMITS.roomName),
  arena: ArenaIdSchema.default("classic"),
  mode: ModeSchema.default("duel"),
  maxPlayers: z.number().int().min(1).optional(),
});
export type CreateRoomRequest = z.infer<typeof CreateRoomSchema>;

export const NetsimSchema = z.strictObject({
  lag: z.number().min(0).max(2000),
  jitter: z.number().min(0).max(1000),
  drop: z.number().min(0).max(0.5),
});
export type NetsimSettings = z.infer<typeof NetsimSchema>;

// ---- client -> server -------------------------------------------------------------------------

const Join = z.strictObject({
  type: z.literal("join"),
  v: z.literal(PROTOCOL_VERSION),
  room: text(LIMITS.roomId),
  name: text(LIMITS.name),
});
const Chat = z.strictObject({ type: z.literal("chat"), text: text(LIMITS.text) });
const Leave = z.strictObject({ type: z.literal("leave") });
const Ping = z.strictObject({ type: z.literal("ping"), t: z.number().min(0) });
const InputJson = z.strictObject({
  type: z.literal("input"),
  seq: z.number().int().positive(),
  tick: z.number().int().min(0),
  b: z.number().int().min(0).max(31),
});
const Netsim = NetsimSchema.extend({ type: z.literal("netsim") });

export const ClientMessageSchema = z.discriminatedUnion("type", [
  Join,
  Chat,
  Leave,
  Ping,
  InputJson,
  Netsim,
]);
export type ClientMessage = z.infer<typeof ClientMessageSchema>;
export type ClientMessageType = ClientMessage["type"];
/** `MessageOf<"join">` is just the join message type. */
export type ClientMessageOf<T extends ClientMessageType> = Extract<ClientMessage, { type: T }>;

// ---- server -> client -------------------------------------------------------------------------

const Welcome = z.object({
  type: z.literal("welcome"),
  v: z.literal(PROTOCOL_VERSION),
  playerId: z.string(),
  slot: PlayerIdSchema,
  room: RoomSummarySchema,
  tickRate: z.number().int().positive(),
  codec: z.enum(["binary", "json"]),
  netsim: NetsimSchema,
});
const Roster = z.object({
  type: z.literal("roster"),
  room: z.string(),
  players: z.array(z.object({ id: z.string(), name: z.string(), slot: PlayerIdSchema.optional() })),
});
const Pong = z.object({ type: z.literal("pong"), t: z.number(), tick: TickSchema });
const ChatOut = z.object({
  type: z.literal("chat"),
  from: z.object({ id: z.string(), name: z.string() }),
  text: z.string(),
  t: z.number(),
});
const System = z.object({ type: z.literal("system"), text: z.string(), t: z.number() });
const ErrorOut = z.object({
  type: z.literal("error"),
  code: z.number().int(),
  message: z.string(),
});

export const ServerMessageSchema = z.discriminatedUnion("type", [
  Welcome,
  Roster,
  Pong,
  ChatOut,
  System,
  ErrorOut,
]);
export type ServerMessage = z.infer<typeof ServerMessageSchema>;
export type ServerMessageType = ServerMessage["type"];
export type ServerMessageOf<T extends ServerMessageType> = Extract<ServerMessage, { type: T }>;
/** Event map for the client's Connection: message type -> that message ("key remapping"). */
export type ServerMessageMap = { [M in ServerMessage as M["type"]]: M };

// ---- parsing ----------------------------------------------------------------------------------

/** A result instead of an exception: bad input from the network is expected, not exceptional. */
export type Parsed<T> = { ok: true; msg: T } | { ok: false; code: CloseCode; reason: string };

const decoder = new TextDecoder();

/** Frame payload (string, Node Buffer, ArrayBuffer…) -> text, or null if it is not text. */
function asText(data: unknown): string | null {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer || data instanceof Uint8Array) return decoder.decode(data);
  if (Array.isArray(data) && data.every((d) => d instanceof Uint8Array)) {
    return data.map((d) => decoder.decode(d)).join(""); // ws: fragmented message
  }
  return null;
}

function parseJson(data: unknown): { ok: true; value: unknown } | { ok: false } {
  const textData = asText(data);
  if (textData === null) return { ok: false };
  try {
    return { ok: true, value: JSON.parse(textData) };
  } catch {
    return { ok: false };
  }
}

const KNOWN_CLIENT_TYPES: ReadonlySet<unknown> = new Set<ClientMessageType>(
  ClientMessageSchema.options.map((o) => o.shape.type.value),
);

/** Builds a short, single-line reason from a zod error (close reasons must stay < 123 bytes). */
function reasonOf(error: z.ZodError): string {
  const issue = error.issues[0];
  if (!issue) return "bad message";
  const path = issue.path.join(".");
  return path ? `${path}: ${issue.message}` : issue.message;
}

/**
 * Parses an untrusted frame from a client. Never throws: bad input is answered with a close
 * code (the server logs it and closes the socket), as in Lab 4.
 */
export function parseClientMessage(data: unknown): Parsed<ClientMessage> {
  const json = parseJson(data);
  if (!json.ok) return { ok: false, code: CLOSE.BAD_JSON, reason: "not JSON" };
  const value = json.value;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { ok: false, code: CLOSE.BAD_SHAPE, reason: "expected an object" };
  }
  const type: unknown = "type" in value ? value.type : undefined;
  if (!KNOWN_CLIENT_TYPES.has(type)) {
    return { ok: false, code: CLOSE.UNKNOWN_TYPE, reason: `unknown type ${String(type)}` };
  }
  if (type === "join" && "v" in value && value.v !== PROTOCOL_VERSION) {
    return { ok: false, code: CLOSE.VERSION, reason: "unsupported protocol version" };
  }
  const result = ClientMessageSchema.safeParse(value);
  if (!result.success) return { ok: false, code: CLOSE.BAD_SHAPE, reason: reasonOf(result.error) };
  return { ok: true, msg: result.data };
}

/** The client's side: the same discipline for what the server sends. */
export function parseServerMessage(data: unknown): Parsed<ServerMessage> {
  const json = parseJson(data);
  if (!json.ok) return { ok: false, code: CLOSE.BAD_JSON, reason: "not JSON" };
  const result = ServerMessageSchema.safeParse(json.value);
  if (!result.success) return { ok: false, code: CLOSE.BAD_SHAPE, reason: reasonOf(result.error) };
  return { ok: true, msg: result.data };
}
