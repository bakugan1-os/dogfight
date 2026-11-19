// World -> snapshot (plain data, codec-agnostic) and world events -> compact snapshot events.
// Runs on the server; the client only ever sees the decoded result.

import { KIND, SHIP_FLAG, PICKUP_CODE, EVENT, NO_SEQ } from "./messages.ts";
import type { EntityState, PlayerState, Snapshot, SnapshotEvent } from "./messages.ts";
import { assertNever } from "../sim/math.ts";
import type { World } from "../sim/world.ts";
import type { Ship } from "../sim/ship.ts";
import type { Tick } from "./ids.ts";

const ASTEROID_SMALL = 1;
const ASTEROID_SEEKER = 2;
const BULLET_HOMING = 1;

function shipFlags(ship: Ship): number {
  let flags = 0;
  if (ship.thrust) flags |= SHIP_FLAG.thrust;
  if (ship.invulnerable > 0) flags |= SHIP_FLAG.invulnerable;
  if (ship.effects.has("shield")) flags |= SHIP_FLAG.shield;
  if (ship.effects.has("rapid")) flags |= SHIP_FLAG.rapid;
  if (ship.effects.has("homing")) flags |= SHIP_FLAG.homing;
  return flags;
}

export function buildSnapshot(
  world: World,
  tick: Tick,
  events: readonly SnapshotEvent[] = [],
): Snapshot {
  const entities: EntityState[] = [];
  for (const e of world) {
    if (!e.alive || e.netId == null) continue;
    const base = { id: e.netId, x: e.pos.x, y: e.pos.y, a: e.angle };
    switch (e.kind) {
      case "ship":
        entities.push({
          ...base,
          kind: "ship",
          playerId: e.playerId,
          hp: e.hp,
          flags: shipFlags(e),
          cooldown: e.cooldown,
          vx: e.vel.x,
          vy: e.vel.y,
        });
        break;
      case "bullet":
        entities.push({
          ...base,
          kind: "bullet",
          ownerId: e.ownerId,
          flags: e.behaviors.some((b) => b.name === "homing") ? BULLET_HOMING : 0,
          vx: e.vel.x,
          vy: e.vel.y,
          seq: e.seq & 0xffff,
        });
        break;
      case "asteroid":
        entities.push({
          ...base,
          kind: "asteroid",
          flags: (e.size === "small" ? ASTEROID_SMALL : 0) | (e.seeker ? ASTEROID_SEEKER : 0),
        });
        break;
      case "pickup":
        entities.push({ ...base, kind: "pickup", type: PICKUP_CODE[e.type] });
        break;
      case "explosion":
        break; // explosions are visual only: events, not state
      default:
        assertNever(e, "entity kind");
    }
  }
  const players: PlayerState[] = [...world.players.values()].map((p) => ({
    id: p.id,
    score: p.score,
    respawn: Math.max(0, p.respawnIn),
  }));
  return { tick, ack: NO_SEQ, players, entities, events };
}

export const asteroidFlags = { small: ASTEROID_SMALL, seeker: ASTEROID_SEEKER };
export const bulletFlags = { homing: BULLET_HOMING };

/**
 * Subscribes to a world's event bus and turns its events into compact snapshot events.
 * `drain()` returns (and clears) everything since the last call — one batch per tick.
 */
export function collectEvents(world: World): { drain(): SnapshotEvent[]; stop(): void } {
  const batch: SnapshotEvent[] = [];
  const controller = new AbortController();
  const { signal } = controller;
  const bus = world.events;
  bus.on(
    "fired",
    (d) => batch.push({ type: EVENT.fired, a: d.playerId, b: 0, x: d.x, y: d.y }),
    signal,
  );
  bus.on(
    "hit",
    (d) =>
      batch.push({
        type: EVENT.hit,
        a: KIND[d.target],
        b: d.target === "ship" ? d.playerId : 0,
        x: d.x,
        y: d.y,
      }),
    signal,
  );
  bus.on(
    "exploded",
    (d) =>
      batch.push(
        d.kind === "ship"
          ? { type: EVENT.kill, a: d.playerId, b: d.killerId ?? 0, x: d.x, y: d.y }
          : {
              type: EVENT.exploded,
              a: KIND.asteroid,
              b: d.size === "small" ? 1 : 0,
              x: d.x,
              y: d.y,
            },
      ),
    signal,
  );
  bus.on(
    "picked",
    (d) =>
      batch.push({ type: EVENT.picked, a: d.playerId, b: PICKUP_CODE[d.type], x: d.x, y: d.y }),
    signal,
  );
  bus.on(
    "scored",
    (d) =>
      batch.push({
        type: EVENT.scored,
        a: d.playerId,
        b: Math.min(255, d.points),
        x: d.x ?? 0,
        y: d.y ?? 0,
      }),
    signal,
  );
  return {
    drain: () => batch.splice(0, Math.min(batch.length, 255)),
    stop: () => controller.abort(),
  };
}
