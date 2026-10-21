// The entity manager. Holds every live thing in a Map<id, Entity>, steps them once per
// simulation tick, runs collision detection + rules, and sweeps the dead at the END of the
// step. Spawns requested mid-step are queued: a Map iterator DOES visit entries added during
// iteration, so a bullet spawned while updating would otherwise be moved in the same step.

import { createArena, wrapPosition, wrappedDelta } from "./arena.js";
import { createRng } from "./rng.js";
import { Vector2 } from "./vector.js";
import { Ship, NO_CONTROLS } from "./ship.js";
import { Asteroid } from "./asteroid.js";
import { Pickup, PICKUP_TYPES } from "./pickup.js";
import { Explosion } from "./explosion.js";
import { findCollisionsNaive } from "./collision.js";
import { resolveCollision } from "./rules.js";

export const WORLD_DEFAULTS = Object.freeze({
  seed: 2026,
  asteroids: 5, // big asteroids kept on the field
  seekerChance: 0.25, // share of new big asteroids that home on ships
  pickupEvery: 7, // s between pickup spawns
  maxPickups: 2,
  respawnDelay: 2, // s
  shipKillScore: 100,
});

export class World {
  #entities = new Map();
  #pending = [];
  #stepping = false;
  #pickupTimer = 3;

  constructor(options = {}) {
    this.config = { ...WORLD_DEFAULTS, ...options };
    this.arena = options.arena ?? createArena();
    this.rng = createRng(this.config.seed);
    this.findCollisions = options.findCollisions ?? findCollisionsNaive; // swappable system
    this.time = 0;
    this.tick = 0;
    /** @type {Map<number, {id:number,name:string,color:string,score:number,shipId:number|null,respawnIn:number}>} */
    this.players = new Map();
    /** Short human-readable messages produced during the last step (for the HUD). */
    this.messages = [];
    for (let i = 0; i < this.config.asteroids; i++) this.#spawnAsteroid();
    this.#flush();
  }

  // ---- collection API ----------------------------------------------------------------------

  get size() {
    return this.#entities.size;
  }

  /** `for (const e of world)` — iterates entities in insertion order. */
  *[Symbol.iterator]() {
    yield* this.#entities.values();
  }

  /** Lazy filter: no intermediate array. `for (const b of world.ofKind("bullet"))` */
  *ofKind(kind) {
    for (const e of this) if (e.kind === kind) yield e;
  }

  get(id) {
    return this.#entities.get(id);
  }

  spawn(entity) {
    if (this.#stepping) this.#pending.push(entity);
    else this.#entities.set(entity.id, entity);
    return entity;
  }

  /** Deferred: marks dead now, removed by the sweep at the end of the step. */
  despawn(id) {
    this.#entities.get(id)?.kill();
  }

  // ---- players ---------------------------------------------------------------------------

  addPlayer({ id, name = `P${id}`, color }) {
    const player = { id, name, color, score: 0, shipId: null, respawnIn: 0 };
    this.players.set(id, player);
    this.#spawnShip(player);
    return player;
  }

  shipOf(playerId) {
    const player = this.players.get(playerId);
    const ship = player?.shipId != null ? this.get(player.shipId) : undefined;
    return ship?.alive ? ship : undefined;
  }

  addScore(playerId, points) {
    const player = this.players.get(playerId);
    if (player) player.score += points;
  }

  emit(message) {
    this.messages.push(message);
  }

  onShipDestroyed(ship, killerId) {
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
    if (killerId != null && killerId !== ship.playerId) {
      this.addScore(killerId, this.config.shipKillScore);
      this.emit(`P${killerId} збив P${ship.playerId}`);
    } else {
      this.emit(`P${ship.playerId} розбився`);
    }
  }

  // ---- the step ----------------------------------------------------------------------------

  /**
   * @param {number} dt
   * @param {Map<number, object>} inputs  playerId -> controls (plain data)
   */
  step(dt, inputs = new Map()) {
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

  #sweep() {
    // Collect first, delete second: no mutation of the Map while its iterator is live.
    const dead = [];
    for (const [id, e] of this.#entities) if (!e.alive) dead.push(id);
    for (const id of dead) this.#entities.delete(id);
  }

  #flush() {
    for (const e of this.#pending) {
      wrapPosition(this.arena, e.pos);
      e.savePrevious(); // a new entity has no "previous" state: don't interpolate from (0,0)
      this.#entities.set(e.id, e);
    }
    this.#pending.length = 0;
  }

  #runSpawners(dt) {
    let bigEquivalent = 0;
    for (const a of this.ofKind("asteroid")) bigEquivalent += a.size === "big" ? 1 : 0.34;
    if (bigEquivalent < this.config.asteroids - 0.5) this.#spawnAsteroid();

    this.#pickupTimer -= dt;
    if (this.#pickupTimer <= 0) {
      this.#pickupTimer = this.config.pickupEvery;
      if ([...this.ofKind("pickup")].length < this.config.maxPickups) {
        const type = this.rng.pick(Object.keys(PICKUP_TYPES));
        this.spawn(new Pickup({ pos: this.findSafeSpot(90), type }));
      }
    }
  }

  #spawnAsteroid() {
    const seeker = this.rng.next() < this.config.seekerChance;
    this.spawn(Asteroid.random(this.rng, this.findSafeSpot(220), "big", seeker));
  }

  #spawnShip(player) {
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
  findSafeSpot(clearance) {
    let best = null;
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
  snapshot() {
    return [...this].map((e) => [
      e.kind,
      e.pos.x,
      e.pos.y,
      e.vel.x,
      e.vel.y,
      e.angle,
      e.hp ?? null,
    ]);
  }
}
