import { D, type Decimal } from '../engine/decimal'
import type { Village, TechModifiers } from '../engine/state'
import { recomputeVillageDerived, NO_TECH_MODS } from '../engine/state'
import { BUILDINGS, BUILDING_IDS, type BuildingId, type ResourceCost } from '../content/buildings'

/**
 * Building engine — generic, data-driven purchase logic. Pure functions of a
 * single {@link Village} + the {@link BUILDINGS} catalogue; Node-safe (no
 * DOM/clock). The only mutation is in {@link build}, which spends that village's
 * resources, bumps a level and re-derives its cached stats. Adding a building
 * never touches this file.
 *
 * Since M2.1 these take a `Village`, not the whole `GameState`: each village owns
 * its economy, so build cost / affordability / purchase are all scoped to one
 * village's buildings + resources.
 *
 * The whole economy is on Decimal; costs are rounded UP so a level never costs
 * less than its formula.
 */

/** Floor the global cost multiplier can never drop below, however many HQ levels. */
const COST_REDUCTION_FLOOR = D(0.5)

/**
 * Per-village build-cost multiplier from EVERY building whose effect reduces build
 * cost: the product of `(1 - perLevel) ^ level` across all `cost_reduction`
 * buildings in this village, clamped to never go below {@link COST_REDUCTION_FLOOR}
 * so costs stay meaningful. Data-driven — mirrors how
 * {@link recomputeVillageDerived} rolls up the other effect kinds, so adding a
 * second cost_reduction building (e.g. a tavern) is a data entry with zero engine
 * changes. Exposed for UI ("koszt -X%").
 */
export function costReduction(v: Village): Decimal {
  let factor = D(1)
  for (const id of BUILDING_IDS) {
    const effect = BUILDINGS[id].effect
    if (effect.kind !== 'cost_reduction') continue
    const level = v.buildings[id]
    if (level > 0) factor = factor.mul(D(1 - effect.perLevel).pow(level))
  }
  return factor.lt(COST_REDUCTION_FLOOR) ? COST_REDUCTION_FLOOR : factor
}

/**
 * Cost of the NEXT level of `id` (current level -> +1) in `v`, per resource:
 * `ceil(baseCost[r] * costFactor ^ currentLevel * costReduction)`.
 * Still defined when the building is maxed (callers should gate on `maxed`).
 */
export function buildingCost(v: Village, id: BuildingId): ResourceCost {
  const def = BUILDINGS[id]
  const level = v.buildings[id]
  const growth = D(def.costFactor).pow(level)
  const reduction = costReduction(v)
  const scaled = growth.mul(reduction)
  return {
    wood: D(def.baseCost.wood).mul(scaled).ceil(),
    clay: D(def.baseCost.clay).mul(scaled).ceil(),
    iron: D(def.baseCost.iron).mul(scaled).ceil(),
  }
}

/** True when `v` can pay `cost` from its current resources. */
export function canAfford(v: Village, cost: ResourceCost): boolean {
  return (
    v.resources.wood.gte(cost.wood) &&
    v.resources.clay.gte(cost.clay) &&
    v.resources.iron.gte(cost.iron)
  )
}

/**
 * Attempt to upgrade `id` by one level in `v`. Returns false (no mutation) when the
 * building is already maxed or the village cannot afford the next level; otherwise
 * spends the cost, increments the level, re-derives that village's cached stats
 * (folding the account-wide tech multipliers `mods` so the fresh level reflects
 * them immediately) and returns true.
 */
export function build(
  v: Village,
  id: BuildingId,
  mods: TechModifiers = NO_TECH_MODS,
): boolean {
  const def = BUILDINGS[id]
  if (v.buildings[id] >= def.maxLevel) return false

  const cost = buildingCost(v, id)
  if (!canAfford(v, cost)) return false

  v.resources.wood = v.resources.wood.sub(cost.wood)
  v.resources.clay = v.resources.clay.sub(cost.clay)
  v.resources.iron = v.resources.iron.sub(cost.iron)
  v.buildings[id] += 1
  recomputeVillageDerived(v, mods)
  return true
}

/** UI helper: the next level's cost in `v` plus whether it is affordable / maxed. */
export function nextCostAffordable(
  v: Village,
  id: BuildingId,
): { cost: ResourceCost; affordable: boolean; maxed: boolean } {
  const maxed = v.buildings[id] >= BUILDINGS[id].maxLevel
  const cost = buildingCost(v, id)
  return { cost, affordable: !maxed && canAfford(v, cost), maxed }
}
