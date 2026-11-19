// The client's half of the control protocol (see server/src/protocol.js for the full description).
// The real-time part (input/snapshot layouts, tick rate) lives in shared/protocol since Lab 5.

export const PROTOCOL_VERSION = 2; // v2 (Lab 5): binary input/snapshot frames, player slots
