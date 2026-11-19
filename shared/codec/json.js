// JSON codec (Lab 5): the same decoded shapes as binary.js, as text frames. Kept behind
// ?codec=json for the README comparison. Numbers are rounded the way the binary codec quantizes
// them, so both codecs give the client exactly the same picture of the world.

import { inputFromButtons, buttonsOf } from "../protocol/messages.js";
import { CodecError } from "./binary.js";

const round = (x, digits) => Math.round(x * 10 ** digits) / 10 ** digits;

export function encodeInput(input) {
  return JSON.stringify({ type: "input", seq: input.seq, tick: input.tick, b: buttonsOf(input) });
}

export function decodeInput(text) {
  const msg = JSON.parse(text);
  if (msg?.type !== "input" || !Number.isInteger(msg.b) || msg.b < 0 || msg.b > 31) {
    throw new CodecError("input: bad shape");
  }
  return inputFromButtons(msg.seq, msg.tick, msg.b);
}

export function encodeSnapshot(snap) {
  return JSON.stringify({
    type: "snapshot",
    tick: snap.tick,
    ack: snap.ack ?? 0,
    players: snap.players,
    entities: snap.entities.map((e) => ({
      ...e,
      x: round(e.x, 2),
      y: round(e.y, 2),
      a: round(e.a, 3),
    })),
    events: snap.events,
  });
}

export function decodeSnapshot(text) {
  const msg = JSON.parse(text);
  if (msg?.type !== "snapshot") throw new CodecError("snapshot: bad shape");
  delete msg.type;
  return msg;
}
