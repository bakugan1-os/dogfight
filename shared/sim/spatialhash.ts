// Lab 7: collision detection with a uniform grid (a "spatial hash") instead of all pairs.
//
// The naive pass compares every body with every other: n·(n−1)/2 distance checks — 12,700 for
// 160 bodies, 80,000 for 400. The grid puts each body into the cell that holds its centre; two
// bodies can only touch if their cells are neighbours, so each body is compared only with the
// bodies in its own and the 8 surrounding cells. On a torus the neighbours wrap around.
//
// Requirement: a cell must be at least as wide as the largest r1 + r2 (two big asteroids:
// 40 + 40 = 80), otherwise a touching pair could sit two cells apart. 100 units -> 16 × 9 cells.
//
// The result is IDENTICAL to findCollisionsNaive — same pairs, same order (sorted by the bodies'
// positions in the input, as the naive double loop produces them). Order matters: the rules
// resolve pairs one by one, so a different order would make a different (still valid) world and
// break the determinism tests. All buffers are typed arrays reused between calls.

import { wrappedDelta, type Arena } from "./arena.ts";
import type { Body } from "./collision.ts";

export function createSpatialHash(cellSize = 100) {
  let cellOf = new Int32Array(256); // body index -> cell
  let order = new Int32Array(256); // body indices sorted by cell (counting sort)
  let cellStart = new Int32Array(0);
  let cellCount = new Int32Array(0);
  let pairKeys = new Float64Array(1024); // i * 65536 + j, sorted at the end

  return function findCollisionsHashed<B extends Body>(
    entities: Iterable<B>,
    arena: Arena,
  ): Array<[B, B]> {
    const cols = Math.max(3, Math.floor(arena.width / cellSize));
    const rows = Math.max(3, Math.floor(arena.height / cellSize));
    const cw = arena.width / cols;
    const ch = arena.height / rows;
    const cells = cols * rows;
    if (cellStart.length !== cells) {
      cellStart = new Int32Array(cells);
      cellCount = new Int32Array(cells);
    }

    const list: B[] = [];
    for (const e of entities) if (e.alive && e.collides) list.push(e);
    const n = list.length;
    if (cellOf.length < n) {
      cellOf = new Int32Array(n * 2);
      order = new Int32Array(n * 2);
    }

    // 1. bucket by cell (counting sort: count, prefix sums, place)
    cellCount.fill(0);
    for (let i = 0; i < n; i++) {
      const b = list[i];
      if (!b) continue;
      const cx = Math.min(cols - 1, Math.max(0, Math.floor(b.pos.x / cw)));
      const cy = Math.min(rows - 1, Math.max(0, Math.floor(b.pos.y / ch)));
      const c = cy * cols + cx;
      cellOf[i] = c;
      cellCount[c] = (cellCount[c] ?? 0) + 1;
    }
    let sum = 0;
    for (let c = 0; c < cells; c++) {
      cellStart[c] = sum;
      sum += cellCount[c] ?? 0;
    }
    cellCount.fill(0);
    for (let i = 0; i < n; i++) {
      const c = cellOf[i] ?? 0;
      order[(cellStart[c] ?? 0) + (cellCount[c] ?? 0)] = i;
      cellCount[c] = (cellCount[c] ?? 0) + 1;
    }

    // 2. each body against the bodies of the 3 × 3 neighbourhood with a HIGHER index (each pair once)
    let pairs = 0;
    for (let i = 0; i < n; i++) {
      const a = list[i];
      if (!a) continue;
      const c = cellOf[i] ?? 0;
      const cx = c % cols;
      const cy = (c - cx) / cols;
      for (let dy = -1; dy <= 1; dy++) {
        const ny = (cy + dy + rows) % rows;
        for (let dx = -1; dx <= 1; dx++) {
          const nc = ny * cols + ((cx + dx + cols) % cols);
          const start = cellStart[nc] ?? 0;
          const end = start + (cellCount[nc] ?? 0);
          for (let k = start; k < end; k++) {
            const j = order[k] ?? 0;
            if (j <= i) continue;
            const b = list[j];
            if (!b) continue;
            const ddx = wrappedDelta(a.pos.x, b.pos.x, arena.width);
            const ddy = wrappedDelta(a.pos.y, b.pos.y, arena.height);
            const r = a.radius + b.radius;
            if (ddx * ddx + ddy * ddy < r * r) {
              if (pairs === pairKeys.length) {
                const grown = new Float64Array(pairs * 2);
                grown.set(pairKeys);
                pairKeys = grown;
              }
              pairKeys[pairs++] = i * 65536 + j;
            }
          }
        }
      }
    }

    // 3. the naive loop's order: by i, then j
    const keys = pairKeys.subarray(0, pairs).sort();
    const out: Array<[B, B]> = [];
    for (const key of keys) {
      const a = list[Math.floor(key / 65536)];
      const b = list[key % 65536];
      if (a && b) out.push([a, b]);
    }
    return out;
  };
}

/** The default grid for the 1600 × 900 arena. */
export const findCollisionsHashed = createSpatialHash();
