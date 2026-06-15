import { D, ZERO, type Decimal } from '../engine/decimal'
import { NO_TECH_MODS, type TechModifiers, type Village } from '../engine/state'
import { BUILDINGS, BUILDING_IDS, type ResourceCost } from '../content/buildings'
import { UNITS, UNIT_IDS, type UnitId } from '../content/units'

/**
 * Recruitment engine — generic, data-driven, Node-safe (no DOM/clock). Pure
 * functions of a single {@link Village} + the {@link UNITS} / {@link BUILDINGS}
 * catalogues; the only mutating ones are {@link recruit} (spend + enqueue) and
 * {@link advanceRecruitment} (the per-tick clock, called by simulate). Since M2.1
 * every function operates on one village's economy (resources / buildings / units /
 * recruitQueue / popCap), never the whole GameState — the tick threads each village
 * through in turn.
 *
 * Mirrors src/systems/buildings.ts: adding a unit is a data edit to units.ts and
 * adding a second training-speed building is a data edit to buildings.ts — neither
 * touches this file. The whole resource economy stays on Decimal; unit COUNTS are
 * plain integers (bounded by popCap), as is training TIME.
 */

/** Hard floor on the training-speed multiplier, however many barracks levels. */
const RECRUIT_SPEED_FLOOR = 0.25

/**
 * True once the barracks exist (level >= 1). KEPT as the marches/combat gate (only
 * battle units come from the barracks); recruitment itself now gates per-unit via
 * {@link unitUnlocked}, since the noble is unlocked by the academy, not the barracks.
 */
export function barracksUnlocked(v: Village): boolean {
  return v.buildings.barracks > 0
}

/**
 * Whether `unitId` can be recruited at all in `v`: its required building (UNITS[id]
 * .requires — barracks for the infantry triad, academy for the noble) is at level
 * >= 1. DATA-DRIVEN: a unit's unlock is a single `requires` edit in units.ts and a
 * new building entry; this engine function never changes.
 */
export function unitUnlocked(v: Village, unitId: UnitId): boolean {
  return v.buildings[UNITS[unitId].requires] > 0
}

/**
 * Training-time multiplier: the product of `(1 - perLevel) ^ level` across EVERY
 * building whose effect is `recruit_speed`, clamped to {@link RECRUIT_SPEED_FLOOR}
 * so training never becomes instant. Data-driven (mirrors costReduction): a second
 * speed building is a data entry with zero engine change. A unit's live training
 * time is `UnitDef.recruitSeconds * recruitSpeedMult(v, mods)`.
 *
 * The GLOBAL tech training-speed reduction (M3.2, `mods.recruitSpeedFrac`, already
 * capped at 0.75 by aggregateTechMods) is folded in as a final `* (1 - frac)` AFTER
 * the per-barracks floor — tech is a SEPARATE reduction path, so it can shorten
 * training below the building-only floor (which guards only against unbounded
 * barracks stacking) without ever reaching zero. Defaults to {@link NO_TECH_MODS}
 * (frac 0, a no-op), so callers that do not thread tech reproduce the building-only
 * timeline byte-for-byte.
 */
export function recruitSpeedMult(v: Village, mods: TechModifiers = NO_TECH_MODS): number {
  let mult = 1
  for (const id of BUILDING_IDS) {
    const effect = BUILDINGS[id].effect
    if (effect.kind !== 'recruit_speed') continue
    const level = v.buildings[id]
    if (level > 0) mult *= Math.pow(1 - effect.perLevel, level)
  }
  if (mult < RECRUIT_SPEED_FLOOR) mult = RECRUIT_SPEED_FLOOR
  return mult * (1 - mods.recruitSpeedFrac)
}

/**
 * Population currently committed: trained units PLUS every unit still queued for
 * training. Counting queued units keeps the popCap budget honest — you cannot
 * over-commit by enqueuing more than the farm can ever feed.
 */
export function usedPopulation(v: Village): Decimal {
  let used = ZERO
  for (const id of UNIT_IDS) {
    const n = v.units[id]
    if (n > 0) used = used.add(D(UNITS[id].pop).mul(n))
  }
  for (const order of v.recruitQueue) {
    if (order.count > 0) used = used.add(D(UNITS[order.unitId].pop).mul(order.count))
  }
  return used
}

/** Spare population headroom (never negative). */
export function freePopulation(v: Village): Decimal {
  const free = v.popCap.sub(usedPopulation(v))
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
  v: Village,
  unitId: UnitId,
  count: number,
): { ok: boolean; reason?: string } {
  if (!unitUnlocked(v, unitId)) {
    return { ok: false, reason: `Wymaga: ${BUILDINGS[UNITS[unitId].requires].name} (poziom 1).` }
  }
  if (!Number.isInteger(count) || count <= 0) return { ok: false, reason: 'Niepoprawna liczba.' }

  const cost = recruitCost(unitId, count)
  if (
    v.resources.wood.lt(cost.wood) ||
    v.resources.clay.lt(cost.clay) ||
    v.resources.iron.lt(cost.iron)
  ) {
    return { ok: false, reason: 'Brak surowców.' }
  }

  const need = D(UNITS[unitId].pop).mul(count)
  if (freePopulation(v).lt(need)) return { ok: false, reason: 'Brak miejsca (populacja).' }

  return { ok: true }
}

/**
 * Spend resources and enqueue a training order. No-op returning false when
 * {@link canRecruit} rejects. The order snapshots the current per-unit training
 * time (see {@link RecruitOrder}) — folding in the GLOBAL tech speed bonus via
 * `mods` at snapshot time — so neither later barracks upgrades NOR later tech
 * purchases can perturb an order already in flight, preserving deterministic
 * offline/online replay. `mods` defaults to {@link NO_TECH_MODS} (no-op); the live
 * caller threads `aggregateTechMods(state.tech)`.
 */
export function recruit(
  v: Village,
  unitId: UnitId,
  count: number,
  mods: TechModifiers = NO_TECH_MODS,
): boolean {
  if (!canRecruit(v, unitId, count).ok) return false

  const cost = recruitCost(unitId, count)
  v.resources.wood = v.resources.wood.sub(cost.wood)
  v.resources.clay = v.resources.clay.sub(cost.clay)
  v.resources.iron = v.resources.iron.sub(cost.iron)

  const perUnitSeconds = UNITS[unitId].recruitSeconds * recruitSpeedMult(v, mods)
  v.recruitQueue.push({ unitId, count, remaining: perUnitSeconds, perUnitSeconds })
  return true
}

/**
 * Advance the head of the training queue by `dtSeconds`, mutating the village `v`.
 * Pure, deterministic and Node-safe.
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
export function advanceRecruitment(v: Village, dtSeconds: number): void {
  if (!(dtSeconds > 0)) return

  let dt = dtSeconds
  const queue = v.recruitQueue
  while (dt > 0 && queue.length > 0) {
    const order = queue[0]
    if (dt < order.remaining) {
      // Not enough time to finish the next unit: bank the progress and stop.
      order.remaining -= dt
      dt = 0
    } else {
      // The next unit completes; consume its share of the budget and mint it.
      dt -= order.remaining
      v.units[order.unitId] += 1
      order.count -= 1
      if (order.count <= 0) {
        queue.shift() // order done — leftover dt spills into the next order
      } else {
        order.remaining = order.perUnitSeconds
      }
    }
  }
}
