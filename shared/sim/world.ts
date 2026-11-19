// The entity manager. Holds every live thing in a Map<id, Entity>, steps them once per
// simulation tick, runs collision detection + rules, and sweeps the dead at the END of the
// step. Spawns requested mid-step are queued: a Map iterator DOES visit entries added during
// iteration, so a bullet spawned while updating would otherwise be moved in the same step.
//
// Lab 3: the world TELLS, it never CALLS. Things that happen ("fired", "hit", "exploded",
// "picked", "scored", "message") go out on `world.events`; audio and HUD subscribe from
// outside. This file imports no audio/HUD module — a test checks that.
// Lab 6: the bus is typed (Bus<WorldEvents>): the event name decides the payload type.

import { createArena, wrapPosition, wrappedDelta, type Arena } from "./arena.ts";
import { createRng, type Rng } from "./rng.ts";
import { Vector2 } from "./vector.ts";
import { Ship, NO_CONTROLS, type Controls } from "./ship.ts";
import { Asteroid, type AsteroidSize } from "./asteroid.ts";
import { Pickup, PICKUP_TYPE_LIST, type PickupType } from "./pickup.ts";
import { Explosion } from "./explosion.ts";
import { findCollisionsNaive } from "./collision.ts";
import { resolveCollision } from "./rules.ts";
import { Bus } from "./bus.ts";
import { isKind, type AnyEntity, type EntityKind, type OfKind } from "./kinds.ts";
import { isEntityId, type EntityId, type PlayerId } from "../protocol/ids.ts";

/** Everything the world announces, by name. The bus checks payloads against this map. */
export type WorldEvents = {
  fired: { playerId: PlayerId; x: number; y: number };
  /** `by`: who shot (null = an asteroid rammed the ship, or a client that does not know). */
  hit:
    | { target: "asteroid"; by: PlayerId | null; x: number; y: number }
    | { target: "ship"; playerId: PlayerId; by: PlayerId | null; x: number; y: number };
  exploded:
    | { kind: "asteroid"; size: AsteroidSize; x: number; y: number }
    | { kind: "ship"; playerId: PlayerId; killerId: PlayerId | null; x: number; y: number };
  picked: { playerId: PlayerId; type: PickupType; x: number; y: number };
  scored: { playerId: PlayerId; points: number; total: number; x?: number; y?: number };
  message: { text: string };
};

export type Player = {
  readonly id: PlayerId;
  name: string;
  color: string | undefined;
  score: number;
  shipId: number | null;
  respawnIn: number;
};

export type CollisionSystem = (
  entities: Iterable<AnyEntity>,
  arena: Arena,
) => Iterable<readonly [AnyEntity, AnyEntity]>;

export const WORLD_DEFAULTS = Object.freeze({
  seed: 2026,
  asteroids: 5, // big asteroids kept on the field
  seekerChance: 0.25, // share of new big asteroids that home on ships
  pickupEvery: 7, // s between pickup spawns
  maxPickups: 2,
  respawnDelay: 2, // s
  shipKillScore: 100,
});
export type WorldConfig = { -readonly [K in keyof typeof WORLD_DEFAULTS]: number };

export type WorldOptions = Partial<WorldConfig> & {
  arena?: Arena;
  findCollisions?: CollisionSystem;
  /** Pass one in to keep listeners across restarts. */
  events?: Bus<WorldEvents>;
};

export class World implements Iterable<AnyEntity> {
  readonly #entities = new Map<number, AnyEntity>();
  readonly #pending: AnyEntity[] = [];
  #stepping = false;
  #pickupTimer = 3;
  #nextNetId = 1;
  readonly #netIds = new Set<EntityId>();

  readonly config: WorldConfig;
  readonly arena: Arena;
  readonly rng: Rng;
  findCollisions: CollisionSystem;
  readonly events: Bus<WorldEvents>;
  time = 0;
  tick = 0;
  readonly players = new Map<PlayerId, Player>();
  /** Short human-readable messages produced during the last step (for the HUD). */
  readonly messages: string[] = [];

  constructor(options: WorldOptions = {}) {
    const { arena, findCollisions, events, ...config } = options;
    this.config = { ...WORLD_DEFAULTS, ...config };
    this.arena = arena ?? createArena();
    this.rng = createRng(this.config.seed);
    this.findCollisions = findCollisions ?? findCollisionsNaive; // swappable system
    this.events = events ?? new Bus<WorldEvents>();
    for (let i = 0; i < this.config.asteroids; i++) this.#spawnAsteroid();
    this.#flush();
  }

  // ---- collection API ----------------------------------------------------------------------

  get size(): number {
    return this.#entities.size;
  }

  /** `for (const e of world)` — iterates entities in insertion order. */
  *[Symbol.iterator](): Generator<AnyEntity> {
    yield* this.#entities.values();
  }

  /** Lazy filter: no intermediate array. `for (const b of world.ofKind("bullet"))` — b: Bullet. */
  *ofKind<K extends EntityKind>(kind: K): Generator<OfKind<K>> {
    for (const e of this) if (isKind(e, kind)) yield e;
  }

  get(id: number): AnyEntity | undefined {
    return this.#entities.get(id);
  }

  spawn<E extends AnyEntity>(entity: E): E {
    // Lab 5: a small per-world id for the wire (u16), reused after wrap-around. Entity.id (the
    // process-wide counter from Lab 2) would overflow 16 bits on a long-running server.
    entity.netId ??= this.#allocNetId();
    if (this.#stepping) this.#pending.push(entity);
    else this.#entities.set(entity.id, entity);
    return entity;
  }

  #allocNetId(): EntityId {
    for (let tries = 0; tries < 0xffff; tries++) {
      const id = this.#nextNetId;
      this.#nextNetId = id === 0xffff ? 1 : id + 1;
      if (isEntityId(id) && !this.#netIds.has(id)) {
        this.#netIds.add(id);
        return id;
      }
    }
    throw new Error("out of network ids");
  }

  /** Deferred: marks dead now, removed by the sweep at the end of the step. */
  despawn(id: number): void {
    this.#entities.get(id)?.kill();
  }

  // ---- players ---------------------------------------------------------------------------

  addPlayer({
    id,
    name = `P${id}`,
    color,
  }: {
    id: PlayerId;
    name?: string;
    color?: string;
  }): Player {
    const player: Player = { id, name, color, score: 0, shipId: null, respawnIn: 0 };
    this.players.set(id, player);
    this.#spawnShip(player);
    return player;
  }

  /** Lab 5: a player left the match — their ship disappears without an explosion or score. */
  removePlayer(id: PlayerId): boolean {
    const player = this.players.get(id);
    if (!player) return false;
    if (player.shipId != null) this.get(player.shipId)?.kill();
    this.players.delete(id);
    return true;
  }

  nameOf(playerId: PlayerId): string {
    return this.players.get(playerId)?.name ?? `P${playerId}`;
  }

  shipOf(playerId: PlayerId): Ship | undefined {
    const player = this.players.get(playerId);
    const ship = player?.shipId != null ? this.get(player.shipId) : undefined;
    // Before Lab 6 this returned "whatever has that id"; now it must prove it is a ship.
    return ship?.kind === "ship" && ship.alive ? ship : undefined;
  }

  addScore(playerId: PlayerId, points: number, at: Vector2 | null = null): void {
    const player = this.players.get(playerId);
    if (!player) return;
    player.score += points;
    this.notify("scored", {
      playerId,
      points,
      total: player.score,
      ...(at && { x: at.x, y: at.y }),
    });
  }

  /** Announces an event on the bus. Synchronous: listeners run before this returns. */
  notify<K extends keyof WorldEvents>(type: K, detail: WorldEvents[K]): void {
    this.events.emit(type, detail);
  }

  emit(message: string): void {
    this.messages.push(message);
    this.notify("message", { text: message });
  }

  onShipDestroyed(ship: Ship, killerId: PlayerId | null): void {
    this.spawn(
      new Explosion({
        pos: ship.pos.clone(),
        rng: this.rng,
        count: 40,
        speed: 220,
        color: ship.color,
        duration: 1.2,
      }),
    );
    const player = this.players.get(ship.playerId);
    if (player) player.respawnIn = this.config.respawnDelay;
    this.notify("exploded", {
      kind: "ship",
      playerId: ship.playerId,
      killerId,
      x: ship.pos.x,
      y: ship.pos.y,
    });
    if (killerId != null && killerId !== ship.playerId) {
      this.addScore(killerId, this.config.shipKillScore, ship.pos);
      this.emit(`${this.nameOf(killerId)} збив ${this.nameOf(ship.playerId)}`);
    } else {
      this.emit(`${this.nameOf(ship.playerId)} розбився`);
    }
  }

  // ---- the step ----------------------------------------------------------------------------

  /** @param inputs playerId -> controls (plain data) */
  step(dt: number, inputs: ReadonlyMap<PlayerId, Controls> = new Map()): void {
    this.messages.length = 0;
    this.#stepping = true;

    for (const e of this) e.savePrevious();

    for (const player of this.players.values()) {
      const ship = this.shipOf(player.id);
      if (ship) {
        ship.controls = inputs.get(player.id) ?? NO_CONTROLS;
      } else if (player.respawnIn > 0) {
        player.respawnIn -= dt;
        if (player.respawnIn <= 0) this.#spawnShip(player);
      }
    }

    for (const e of this) {
      if (!e.alive) continue;
      e.update(dt, this);
      for (const behavior of e.behaviors) {
        if (e.alive) behavior.update(e, dt, this);
      }
      wrapPosition(this.arena, e.pos);
    }

    for (const [a, b] of this.findCollisions(this, this.arena)) {
      if (a.alive && b.alive) resolveCollision(this, a, b);
    }
    for (const e of this) if (e.alive) wrapPosition(this.arena, e.pos); // after bounces

    this.#stepping = false;
    this.#sweep();
    this.#runSpawners(dt);
    this.#flush();

    this.time += dt;
    this.tick++;
  }

  #sweep(): void {
    // Collect first, delete second: no mutation of the Map while its iterator is live.
    const dead: AnyEntity[] = [];
    for (const e of this.#entities.values()) if (!e.alive) dead.push(e);
    for (const e of dead) {
      if (e.netId != null) this.#netIds.delete(e.netId);
      this.#entities.delete(e.id);
    }
  }

  #flush(): void {
    for (const e of this.#pending) {
      wrapPosition(this.arena, e.pos);
      e.savePrevious(); // a new entity has no "previous" state: don't interpolate from (0,0)
      this.#entities.set(e.id, e);
    }
    this.#pending.length = 0;
  }

  #runSpawners(dt: number): void {
    let bigEquivalent = 0;
    for (const a of this.ofKind("asteroid")) bigEquivalent += a.size === "big" ? 1 : 0.34;
    if (bigEquivalent < this.config.asteroids - 0.5) this.#spawnAsteroid();

    this.#pickupTimer -= dt;
    if (this.#pickupTimer <= 0) {
      this.#pickupTimer = this.config.pickupEvery;
      if ([...this.ofKind("pickup")].length < this.config.maxPickups) {
        const type = this.rng.pick(PICKUP_TYPE_LIST);
        this.spawn(new Pickup({ pos: this.findSafeSpot(90), type }));
      }
    }
  }

  #spawnAsteroid(): void {
    const seeker = this.rng.next() < this.config.seekerChance;
    this.spawn(Asteroid.random(this.rng, this.findSafeSpot(220), "big", seeker));
  }

  #spawnShip(player: Player): Ship {
    const ship = new Ship({
      playerId: player.id,
      color: player.color,
      pos: this.findSafeSpot(160),
      angle: this.rng.range(-Math.PI, Math.PI),
    });
    player.shipId = ship.id;
    player.respawnIn = 0;
    this.spawn(ship);
    return ship;
  }

  /**
   * A random point at least `clearance` away from every collidable thing, or — if 40 tries
   * fail — the candidate with the largest clearance.
   */
  findSafeSpot(clearance: number): Vector2 {
    let best = new Vector2(this.arena.width / 2, this.arena.height / 2);
    let bestScore = -Infinity;
    for (let attempt = 0; attempt < 40; attempt++) {
      const candidate = new Vector2(
        this.rng.range(0, this.arena.width),
        this.rng.range(0, this.arena.height),
      );
      let nearest = Infinity;
      for (const e of [...this, ...this.#pending]) {
        if (!e.alive || !e.collides) continue;
        const dx = wrappedDelta(candidate.x, e.pos.x, this.arena.width);
        const dy = wrappedDelta(candidate.y, e.pos.y, this.arena.height);
        nearest = Math.min(nearest, Math.hypot(dx, dy) - e.radius);
      }
      if (nearest >= clearance) return candidate;
      if (nearest > bestScore) {
        best = candidate;
        bestScore = nearest;
      }
    }
    return best;
  }

  /** Id-free summary of the state, for determinism tests (ids come from a global counter). */
  snapshot(): Array<[EntityKind, number, number, number, number, number, number | null]> {
    return [...this].map((e) => [
      e.kind,
      e.pos.x,
      e.pos.y,
      e.vel.x,
      e.vel.y,
      e.angle,
      e.kind === "ship" || e.kind === "asteroid" ? e.hp : null,
    ]);
  }
}
