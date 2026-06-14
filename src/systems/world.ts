import { RNG } from '../engine/rng'
import { MAX_TARGET_LEVEL } from '../content/barbarians'
import type { BarbarianVillage, Village, World } from '../engine/state'

/**
 * World geometry & generation (M2.2). Turns the abstract camp ladder into a
 * SPATIAL map: barbarian villages laid out in radial rings around the capital,
 * with march time derived from the Euclidean distance between source and target.
 *
 * Balance is preserved BY CONSTRUCTION. A tier-L village sits in a ring of radius
 * ~ L * {@link DISTANCE_PER_LEVEL} (= the legacy `barbarianTarget(level).distance`)
 * around {@link WORLD_CENTER}, where the capital stands — so the capital→target
 * Euclidean distance reproduces the old per-level distance, and therefore the old
 * march time, with no retuning. Lower tiers are both nearer and more numerous, so
 * the early game has plenty of reachable targets.
 *
 * Determinism: generation draws from a DEDICATED RNG stream
 * (`RNG.fromString(seed + ':world')`) so it never touches the run's `rngState`,
 * and the resulting list is stably ordered (index = id suffix). The module is pure
 * and Node-safe (no DOM/clock/Math.random).
 *
 * Import discipline (cycle-safe): this module imports only the RNG, the value
 * {@link MAX_TARGET_LEVEL} and ERASED types from state.ts — never a runtime value
 * from state.ts. state.ts imports `generateWorld` / `WORLD_CENTER` back, but uses
 * them only inside function bodies (createInitialState), so the value-level cycle
 * never reads an uninitialised binding at module-evaluation time.
 */

/**
 * Fields of radius added per camp tier. Kept identical to the legacy
 * `DISTANCE_PER_LEVEL` in content/barbarians.ts so a ring's radius matches the old
 * `barbarianTarget(level).distance` and march time is unchanged.
 */
export const DISTANCE_PER_LEVEL = 3

/** Map centre, in field coordinates. The capital ('v0') stands here. */
export const WORLD_CENTER = { x: 200, y: 200 }

/** Map extent: every coordinate is clamped to the inclusive range [0, WORLD_SIZE]. */
export const WORLD_SIZE = 400

/**
 * How many barbarian villages to spawn at camp tier `level`: a linear taper from
 * ~8 at level 1 down to 1 at the ceiling (many easy nearby targets, a handful of
 * distant hard ones). Summed across 1..MAX_TARGET_LEVEL this lands ~125 villages,
 * inside the 90–130 design budget. Always at least 1 so no tier is unreachable.
 */
function countForLevel(level: number): number {
  return Math.max(1, Math.round(8 * (1 - (level - 1) / MAX_TARGET_LEVEL)))
}

/** Clamp a field coordinate into the inclusive map range [0, WORLD_SIZE]. */
function clampCoord(n: number): number {
  if (n < 0) return 0
  if (n > WORLD_SIZE) return WORLD_SIZE
  return n
}

/** Grid key for collision detection. */
function cellKey(x: number, y: number): string {
  return x + ',' + y
}

/**
 * Deterministically generate the barbarian world for `seed`. Places
 * {@link countForLevel} villages per tier on its ring (random angle, radius =
 * tier·DISTANCE_PER_LEVEL ± a one-ring jitter), rounds and clamps to the map, and
 * nudges any collision (including the reserved capital cell at the centre) to the
 * next free field — so no two villages share a coordinate. Ids are `'b'+index` in
 * generation order (tier-ascending), giving a stable, reproducible list.
 */
export function generateWorld(seed: string): World {
  // Dedicated stream: world generation must NEVER advance the run's rngState.
  const rng = RNG.fromString(seed + ':world')
  const barbarians: BarbarianVillage[] = []
  // Reserve the capital's cell so no barbarian can land on the world centre.
  const occupied = new Set<string>([cellKey(WORLD_CENTER.x, WORLD_CENTER.y)])

  let index = 0
  for (let level = 1; level <= MAX_TARGET_LEVEL; level++) {
    const count = countForLevel(level)
    for (let k = 0; k < count; k++) {
      const angle = rng.next() * Math.PI * 2
      const radius =
        level * DISTANCE_PER_LEVEL + rng.range(-DISTANCE_PER_LEVEL, DISTANCE_PER_LEVEL)
      let x = clampCoord(Math.round(WORLD_CENTER.x + radius * Math.cos(angle)))
      let y = clampCoord(Math.round(WORLD_CENTER.y + radius * Math.sin(angle)))
      // Deterministic nudge to the next free cell on any collision.
      while (occupied.has(cellKey(x, y))) {
        x += 1
        if (x > WORLD_SIZE) {
          x = 0
          y += 1
          if (y > WORLD_SIZE) y = 0
        }
      }
      occupied.add(cellKey(x, y))
      barbarians.push({
        id: 'b' + index,
        x,
        y,
        level,
        name: `Wioska barbarzyńska (poz. ${level})`,
      })
      index++
    }
  }

  return { barbarians }
}

/** Euclidean distance (in fields) between two map points. */
export function distance(ax: number, ay: number, bx: number, by: number): number {
  return Math.hypot(ax - bx, ay - by)
}

/** Look up a barbarian village by id; undefined when absent (e.g. a 'legacy' id). */
export function barbarianById(world: World, id: string): BarbarianVillage | undefined {
  return world.barbarians.find((b) => b.id === id)
}

/** Numeric index baked into a `'b'+index` id, for a stable distance-tie ordering. */
function idIndex(id: string): number {
  const n = Number.parseInt(id.slice(1), 10)
  return Number.isFinite(n) ? n : 0
}

/**
 * A COPY of `world.barbarians` sorted ascending by Euclidean distance from village
 * `v` (nearest first), with the id index as a deterministic tiebreaker so equal
 * distances always order the same way. The source array is never mutated.
 */
export function targetsByDistance(v: Village, world: World): BarbarianVillage[] {
  return world.barbarians
    .map((b) => ({ b, d: distance(v.x, v.y, b.x, b.y) }))
    .sort((p, q) => (p.d !== q.d ? p.d - q.d : idIndex(p.b.id) - idIndex(q.b.id)))
    .map((p) => p.b)
}
