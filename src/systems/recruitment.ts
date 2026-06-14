import { D, ZERO, type Decimal } from '../engine/decimal'
import type { GameState } from '../engine/state'
import { BUILDINGS, BUILDING_IDS, type ResourceCost } from '../content/buildings'
import { UNITS, UNIT_IDS, type UnitId } from '../content/units'

/**
 * Recruitment engine — generic, data-driven, Node-safe (no DOM/clock). Pure
 * functions of `GameState` + the {@link UNITS} / {@link BUILDINGS} catalogues; the
 * only mutating ones are {@link recruit} (spend + enqueue) and
 * {@link advanceRecruitment} (the per-tick clock, called by simulate).
 *
 * Mirrors src/systems/buildings.ts: adding a unit is a data edit to units.ts and
 * adding a second training-speed building is a data edit to buildings.ts — neither
 * touches this file. The whole resource economy stays on Decimal; unit COUNTS are
 * plain integers (bounded by popCap), as is training TIME.
 */

/** Hard floor on the training-speed multiplier, however many barracks levels. */
const RECRUIT_SPEED_FLOOR = 0.25

/** True once the barracks exist (level >= 1) — the gate for all recruitment. */
export function barracksUnlocked(state: GameState): boolean {
  return state.buildings.barracks > 0
}

/**
 * Training-time multiplier: the product of `(1 - perLevel) ^ level` across EVERY
 * building whose effect is `recruit_speed`, clamped to {@link RECRUIT_SPEED_FLOOR}
 * so training never becomes instant. Data-driven (mirrors costReduction): a second
 * speed building is a data entry with zero engine change. A unit's live training
 * time is `UnitDef.recruitSeconds * recruitSpeedMult(state)`.
 */
export function recruitSpeedMult(state: GameState): number {
  let mult = 1
  for (const id of BUILDING_IDS) {
    const effect = BUILDINGS[id].effect
    if (effect.kind !== 'recruit_speed') continue
    const level = state.buildings[id]
    if (level > 0) mult *= Math.pow(1 - effect.perLevel, level)
  }
  return mult < RECRUIT_SPEED_FLOOR ? RECRUIT_SPEED_FLOOR : mult
}

/**
 * Population currently committed: trained units PLUS every unit still queued for
 * training. Counting queued units keeps the popCap budget honest — you cannot
 * over-commit by enqueuing more than the farm can ever feed.
 */
export function usedPopulation(state: GameState): Decimal {
  let used = ZERO
  for (const id of UNIT_IDS) {
    const n = state.units[id]
    if (n > 0) used = used.add(D(UNITS[id].pop).mul(n))
  }
  for (const order of state.recruitQueue) {
    if (order.count > 0) used = used.add(D(UNITS[order.unitId].pop).mul(order.count))
  }
  return used
}

/** Spare population headroom (never negative). */
export function freePopulation(state: GameState): Decimal {
  const free = state.popCap.sub(usedPopulation(state))
  return free.lt(0) ? ZERO : free
}

/** Total resource cost to recruit `count` of `unitId`, on Decimal. */
export function recruitCost(unitId: UnitId, count: number): ResourceCost {
  const def = UNITS[unitId]
  return {
    wood: D(def.cost.wood).mul(count),
    clay: D(def.cost.clay).mul(count),
    iron: D(def.cost.iron).mul(count),
  }
}

/**
 * Whether `count` of `unitId` can be recruited right now, with a PL reason when
 * not (surfaced by the UI). Gates on: barracks unlocked, a positive integer count,
 * affordable resources, and enough free population.
 */
export function canRecruit(
  state: GameState,
  unitId: UnitId,
  count: number,
): { ok: boolean; reason?: string } {
  if (!barracksUnlocked(state)) return { ok: false, reason: 'Wymaga koszar (poziom 1).' }
  if (!Number.isInteger(count) || count <= 0) return { ok: false, reason: 'Niepoprawna liczba.' }

  const cost = recruitCost(unitId, count)
  if (
    state.resources.wood.lt(cost.wood) ||
    state.resources.clay.lt(cost.clay) ||
    state.resources.iron.lt(cost.iron)
  ) {
    return { ok: false, reason: 'Brak surowców.' }
  }

  const need = D(UNITS[unitId].pop).mul(count)
  if (freePopulation(state).lt(need)) return { ok: false, reason: 'Brak miejsca (populacja).' }

  return { ok: true }
}

/**
 * Spend resources and enqueue a training order. No-op returning false when
 * {@link canRecruit} rejects. The order snapshots the current per-unit training
 * time (see {@link RecruitOrder}) so later barracks upgrades cannot perturb an
 * order already in flight — preserving deterministic offline/online replay.
 */
export function recruit(state: GameState, unitId: UnitId, count: number): boolean {
  if (!canRecruit(state, unitId, count).ok) return false

  const cost = recruitCost(unitId, count)
  state.resources.wood = state.resources.wood.sub(cost.wood)
  state.resources.clay = state.resources.clay.sub(cost.clay)
  state.resources.iron = state.resources.iron.sub(cost.iron)

  const perUnitSeconds = UNITS[unitId].recruitSeconds * recruitSpeedMult(state)
  state.recruitQueue.push({ unitId, count, remaining: perUnitSeconds, perUnitSeconds })
  return true
}

/**
 * Advance the head of the training queue by `dtSeconds`, mutating `state`. Pure,
 * deterministic and Node-safe.
 *
 * This is the per-CHUNK clock primitive. Because it accumulates time via iterative
 * float subtraction with integer completion boundaries, its result is sensitive to
 * how `dt` is sliced — so {@link simulate} always feeds it FIXED TICK_RATE chunks
 * (the same grid the live loop and offline catch-up use), making the recruitment
 * timeline a pure function of elapsed game time. The live loop, offline catch-up
 * and the sim harness therefore all advance training through one identical grid,
 * regardless of the `dt` each passes to simulate().
 *
 * It still tolerates ANY `dt` when called directly (e.g. unit tests): each loop
 * iteration finishes EXACTLY one unit — it subtracts that unit's `remaining` from
 * the time budget, mints the unit, and either re-arms `remaining` for the next unit
 * in the order or, when the order is exhausted, drops it and lets the LEFTOVER
 * budget spill into the following order. So a single large `dt` can complete many
 * units across several orders in one call, with the dt accounted explicitly so no
 * time is lost or double-counted.
 */
export function advanceRecruitment(state: GameState, dtSeconds: number): void {
  if (!(dtSeconds > 0)) return

  let dt = dtSeconds
  const queue = state.recruitQueue
  while (dt > 0 && queue.length > 0) {
    const order = queue[0]
    if (dt < order.remaining) {
      // Not enough time to finish the next unit: bank the progress and stop.
      order.remaining -= dt
      dt = 0
    } else {
      // The next unit completes; consume its share of the budget and mint it.
      dt -= order.remaining
      state.units[order.unitId] += 1
      order.count -= 1
      if (order.count <= 0) {
        queue.shift() // order done — leftover dt spills into the next order
      } else {
        order.remaining = order.perUnitSeconds
      }
    }
  }
}
