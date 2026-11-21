// Client-side prediction of ONE ship (Lab 5, M2). The same `integrate` the server's Ship.update
// uses, plus the same wrap and cooldown bookkeeping, on a plain body. No collisions: the server
// decides those, and a reconciliation corrects the client when it disagrees.

import { integrate, SHIP_PARAMS, type Controls, type ShipBody } from "./ship.ts";
import { wrapPosition, wrappedDelta, type Arena } from "./arena.ts";
import { Vector2 } from "./vector.ts";
import { SHIP_FLAG, TICK_DT, type ShipState } from "../protocol/messages.ts";
import type { Seq } from "../protocol/ids.ts";

/** A ship's predictable state: plain data + Vector2 fields so integrate() can run on it. */
export type PredictedBody = ShipBody & { cooldown: number; rapid: boolean };

export function bodyFromSnapshot(e: ShipState, rapid = false): PredictedBody {
  return {
    pos: new Vector2(e.x, e.y),
    vel: new Vector2(e.vx, e.vy),
    angle: e.a,
    thrust: false,
    cooldown: e.cooldown,
    rapid,
  };
}

export function cloneBody(b: PredictedBody): PredictedBody {
  return { ...b, pos: b.pos.clone(), vel: b.vel.clone() };
}

/**
 * One fixed step of the local ship. Returns true if this step fires a bullet — the server's
 * Ship.update fires under exactly the same condition (cooldown reached 0 and fire held).
 */
export function predictStep(
  body: PredictedBody,
  controls: Controls,
  dt: number,
  arena: Arena,
): boolean {
  integrate(body, controls, dt);
  body.cooldown = Math.max(0, body.cooldown - dt);
  wrapPosition(arena, body.pos);
  if ((controls.fire || controls.firePressed) && body.cooldown === 0) {
    body.cooldown = body.rapid ? SHIP_PARAMS.rapidCooldown : SHIP_PARAMS.fireCooldown;
    return true;
  }
  return false;
}

/** Where a bullet fired from `body` this step starts and how fast it goes (as Ship.fire). */
export function bulletFrom(body: PredictedBody): { pos: Vector2; vel: Vector2; angle: number } {
  const dir = Vector2.fromAngle(body.angle);
  return {
    pos: body.pos.add(dir.scale(SHIP_PARAMS.radius + 6)),
    vel: body.vel.add(dir.scale(SHIP_PARAMS.bulletSpeed)),
    angle: body.angle,
  };
}

/** An input the client sent and the server has not acknowledged yet. */
export type PendingInput = { readonly seq: Seq; readonly controls: Controls };

export type Reconciled = {
  /** the own ship as the server says it was at `ack`, then fast-forwarded through `pending` */
  body: PredictedBody;
  /** the inputs still not acknowledged (seq > ack), in order */
  pending: PendingInput[];
  /** how far the prediction was off, the short way around the arena (0 = it agreed) */
  correction: { dx: number; dy: number; distance: number } | null;
};

/**
 * Reconciliation (Lab 5) as a PURE function (Lab 7): server state + unacknowledged inputs ->
 * the corrected prediction. No clock, no socket, no `this`: the same arguments always give the
 * same result, which is what makes it testable.
 *
 * @param previous the position the client had predicted before this snapshot (null = none yet)
 * @param step     one predicted step (predictStep, or the determinism experiment's noisy copy)
 */
export function reconcile(
  server: ShipState,
  pending: readonly PendingInput[],
  ack: Seq,
  arena: Arena,
  previous: { readonly x: number; readonly y: number } | null,
  step: (body: PredictedBody, controls: Controls) => boolean = (b, c) =>
    predictStep(b, c, TICK_DT, arena),
): Reconciled {
  const remaining = pending.filter((p) => p.seq > ack); // acknowledged: done
  const body = bodyFromSnapshot(server, Boolean(server.flags & SHIP_FLAG.rapid));
  for (const p of remaining) step(body, p.controls); // replay the unacknowledged
  let correction: Reconciled["correction"] = null;
  if (previous) {
    const dx = wrappedDelta(body.pos.x, previous.x, arena.width);
    const dy = wrappedDelta(body.pos.y, previous.y, arena.height);
    correction = { dx, dy, distance: Math.hypot(dx, dy) };
  }
  return { body, pending: remaining, correction };
}
