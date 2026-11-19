// The codec interface (Lab 6): the hot-path traffic — inputs up, snapshots down — through ONE
// shape with two implementations. binary.ts encodes to bytes, json.ts to text; the server and
// the client pick one per connection (?codec=json) and never look at the frames themselves.

import type { Input, Snapshot } from "../protocol/messages.ts";

export type CodecName = "binary" | "json";

/**
 * `Out` is what encode produces; `In` is what decode accepts (a binary decoder takes a Node
 * Buffer as well as a browser ArrayBuffer). Decoders THROW CodecError on a bad frame: the
 * caller (the socket handler) turns that into a close code.
 */
export interface Codec<Out, In = Out> {
  readonly name: CodecName;
  encodeInput(input: Input): Out;
  decodeInput(frame: In): Input;
  encodeSnapshot(snapshot: Snapshot): Out;
  decodeSnapshot(frame: In): Snapshot;
}

export class CodecError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CodecError";
  }
}
