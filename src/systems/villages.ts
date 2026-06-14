import { D, type Decimal } from '../engine/decimal'
import type { GameState, VillageId } from '../engine/state'
import { createVillage, nextVillageId } from '../engine/state'
import type { ResourceCost } from '../content/buildings'
import { distance, WORLD_SIZE } from './world'

/**
 * Founding engine (M2.3) — letting the player plant a brand-new, empty owned
 * village on the world map. Pure, Node-safe and deterministic: the only mutation
 * lives in {@link foundVillage}, which spends the payer's resources and appends a
 * fresh {@link createVillage} to the state. No new save shape — a founded village
 * is just one more entry in the existing `villages` map / `villageOrder`, so
 * SAVE_VERSION is unchanged and there is no migration.
 *
 * Cost RISES with the number of villages already owned (geometric in
 * {@link FOUND_COST_GROWTH}) so expansion is a paced, escalating investment rather
 * than a one-off. Geometry gates keep the map sane: a new site must respect a
 * minimum spacing from EVERY village (owned or barbarian) and stay within
 * {@link FOUND_MAX_RANGE} of the nearest owned village, so the empire grows
 * outward in steps instead of teleporting across the map.
 *
 * Import discipline (cycle-safe): this module imports the value helpers
 * {@link createVillage} / {@link nextVillageId} and the {@link distance} /
 * {@link WORLD_SIZE} geometry from already-initialised modules, plus erased types
 * only. Nothing imports back from here at module-evaluation time, so there is no
 * initialisation cycle.
 */

/**
 * Base founding cost of the FIRST extra village (when only the capital exists),
 * per base resource as a plain number; {@link foundCost} lifts it onto Decimal and
 * scales it. A balance knob — sized so a maturing capital can afford its second
 * village after a meaningful (not trivial) accumulation, without stalling the
 * other progress targets. Tuned against the sim (see manifest notes).
 */
export const FOUND_BASE_COST: { wood: number; clay: number; iron: number } = {
  wood: 3000,
  clay: 3000,
  iron: 2000,
}

/**
 * Multiplier applied to the founding cost per village ALREADY owned: the Nth extra
 * village costs `FOUND_BASE_COST * FOUND_COST_GROWTH^(N-1)`. Geometric growth keeps
 * each new settlement a deliberate, escalating commitment.
 */
export const FOUND_COST_GROWTH = 1.6

/**
 * Minimum Euclidean spacing (in fields) a new site must keep from EVERY existing
 * village — both owned and barbarian. Stricter than mere cell-occupancy, so
 * villages never crowd onto adjacent tiles.
 */
export const FOUND_MIN_SPACING = 4

/**
 * Maximum Euclidean distance (in fields) a new site may sit from the NEAREST owned
 * village. Forces gradual, outward expansion: you can only settle within reach of
 * land you already hold.
 */
export const FOUND_MAX_RANGE = 30

/** How many villages the player currently owns. */
export function playerVillageCount(state: GameState): number {
  return Object.keys(state.villages).length
}

/**
 * Cost to found the NEXT village: `FOUND_BASE_COST * FOUND_COST_GROWTH^(count-1)`,
 * per resource, rounded UP on Decimal so a village never costs less than its
 * formula. With only the capital owned (`count === 1`) the exponent is 0, so the
 * first extra village costs exactly {@link FOUND_BASE_COST}.
 */
export function foundCost(state: GameState): ResourceCost {
  const count = playerVillageCount(state)
  const growth = D(FOUND_COST_GROWTH).pow(count - 1)
  return {
    wood: D(FOUND_BASE_COST.wood).mul(growth).ceil(),
    clay: D(FOUND_BASE_COST.clay).mul(growth).ceil(),
    iron: D(FOUND_BASE_COST.iron).mul(growth).ceil(),
  }
}

/**
 * Whether field `(x, y)` is already taken by some village — owned OR barbarian —
 * by exact integer-coordinate equality. (Spacing rules in {@link canFound} are
 * stricter; this is the bare "is this exact tile used" test, also reused by the
 * world's own collision handling conceptually.)
 */
export function isCellOccupied(state: GameState, x: number, y: number): boolean {
  for (const id of state.villageOrder) {
    const v = state.villages[id]
    if (v.x === x && v.y === y) return true
  }
  for (const b of state.world.barbarians) {
    if (b.x === x && b.y === y) return true
  }
  return false
}

/**
 * Geometry-only gate shared by {@link canFound} and {@link findFoundingSpot}:
 * everything EXCEPT affordability. Checks (in order) that the payer exists, the
 * target is an integer field inside the map, the tile is free, no village (owned
 * or barbarian) is closer than {@link FOUND_MIN_SPACING}, and at least one owned
 * village is within {@link FOUND_MAX_RANGE}. Returns a PL reason on the first
 * failing gate. Internal — {@link findFoundingSpot} can reuse it to locate a site
 * before the player can necessarily pay for it.
 */
function checkGeometry(
  state: GameState,
  payerVillageId: VillageId,
  x: number,
  y: number,
): { ok: boolean; reason?: string } {
  if (state.villages[payerVillageId] === undefined) {
    return { ok: false, reason: 'Wioska płacąca nie istnieje' }
  }
  if (
    !Number.isInteger(x) ||
    !Number.isInteger(y) ||
    x < 0 ||
    y < 0 ||
    x > WORLD_SIZE ||
    y > WORLD_SIZE
  ) {
    return { ok: false, reason: 'Pole poza mapą' }
  }
  if (isCellOccupied(state, x, y)) {
    return { ok: false, reason: 'Pole jest zajęte' }
  }

  let nearestOwned = Infinity
  for (const id of state.villageOrder) {
    const v = state.villages[id]
    const d = distance(x, y, v.x, v.y)
    if (d < FOUND_MIN_SPACING) return { ok: false, reason: 'Za blisko innej wioski' }
    if (d < nearestOwned) nearestOwned = d
  }
  for (const b of state.world.barbarians) {
    const d = distance(x, y, b.x, b.y)
    if (d < FOUND_MIN_SPACING) {
      return { ok: false, reason: 'Za blisko wioski barbarzyńskiej' }
    }
  }
  if (nearestOwned > FOUND_MAX_RANGE) {
    return { ok: false, reason: 'Za daleko od twoich wiosek' }
  }
  return { ok: true }
}

/**
 * Whether the player may found a village at `(x, y)` paid from `payerVillageId`.
 * Runs every geometry gate (see {@link checkGeometry}) and then affordability
 * against {@link foundCost}. Returns `{ ok: true }` when allowed, otherwise
 * `{ ok: false, reason }` with a PL explanation of the first failing rule.
 */
export function canFound(
  state: GameState,
  payerVillageId: VillageId,
  x: number,
  y: number,
): { ok: boolean; reason?: string } {
  const geo = checkGeometry(state, payerVillageId, x, y)
  if (!geo.ok) return geo

  const payer = state.villages[payerVillageId]
  const cost = foundCost(state)
  const r = payer.resources
  if (!(r.wood.gte(cost.wood) && r.clay.gte(cost.clay) && r.iron.gte(cost.iron))) {
    return { ok: false, reason: 'Brak surowców' }
  }
  return { ok: true }
}

/** Subtract `cost` from `have`, clamped at zero (a payment never goes negative). */
function clampSub(have: Decimal, cost: Decimal): Decimal {
  const out = have.sub(cost)
  return out.lt(0) ? D(0) : out
}

/**
 * Found a new village at `(x, y)`, paid from `payerVillageId`. Returns `null`
 * (no mutation) when {@link canFound} rejects the site. On success it spends
 * {@link foundCost} from the payer (clamped at zero), creates a fresh village via
 * {@link createVillage} at the next free id, appends it to `villages` /
 * `villageOrder`, and returns the new id. Derived fields are reconciled inside
 * {@link createVillage}.
 */
export function foundVillage(
  state: GameState,
  payerVillageId: VillageId,
  x: number,
  y: number,
): VillageId | null {
  if (!canFound(state, payerVillageId, x, y).ok) return null

  const payer = state.villages[payerVillageId]
  const cost = foundCost(state)
  payer.resources.wood = clampSub(payer.resources.wood, cost.wood)
  payer.resources.clay = clampSub(payer.resources.clay, cost.clay)
  payer.resources.iron = clampSub(payer.resources.iron, cost.iron)

  const count = playerVillageCount(state)
  const id = nextVillageId(state)
  const v = createVillage(id, 'Wioska ' + (count + 1), x, y)
  state.villages[id] = v
  state.villageOrder.push(id)
  return id
}

/**
 * Search offsets within {@link FOUND_MAX_RANGE} of an origin, sorted nearest-first
 * with a deterministic `(dx, dy)` tiebreak. Computed once and cached: the set is
 * position-independent (it is added to a village's own coordinate), so the spiral
 * order is identical on every call and every machine.
 */
let cachedOffsets: { dx: number; dy: number }[] | null = null
function foundingOffsets(): { dx: number; dy: number }[] {
  if (cachedOffsets !== null) return cachedOffsets
  const r = FOUND_MAX_RANGE
  const offsets: { dx: number; dy: number }[] = []
  for (let dx = -r; dx <= r; dx++) {
    for (let dy = -r; dy <= r; dy++) {
      if (dx === 0 && dy === 0) continue
      if (dx * dx + dy * dy > r * r) continue
      offsets.push({ dx, dy })
    }
  }
  offsets.sort((a, b) => {
    const da = a.dx * a.dx + a.dy * a.dy
    const db = b.dx * b.dx + b.dy * b.dy
    if (da !== db) return da - db
    if (a.dx !== b.dx) return a.dx - b.dx
    return a.dy - b.dy
  })
  cachedOffsets = offsets
  return offsets
}

/**
 * Deterministically find the nearest free, VALID founding site around
 * `nearVillageId` — the first offset (scanned nearest-first, see
 * {@link foundingOffsets}) whose resulting tile passes every geometry gate of
 * {@link canFound} (affordability is NOT checked here; this is pure spatial
 * search). Returns `null` when no valid tile exists within
 * {@link FOUND_MAX_RANGE}. Searching around an owned village guarantees the
 * "within range of an owned village" gate is satisfiable.
 */
export function findFoundingSpot(
  state: GameState,
  nearVillageId: VillageId,
): { x: number; y: number } | null {
  const near = state.villages[nearVillageId]
  if (near === undefined) return null
  for (const { dx, dy } of foundingOffsets()) {
    const x = near.x + dx
    const y = near.y + dy
    if (checkGeometry(state, nearVillageId, x, y).ok) return { x, y }
  }
  return null
}
