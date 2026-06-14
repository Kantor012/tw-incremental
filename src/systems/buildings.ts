import { D, type Decimal } from '../engine/decimal'
import type { GameState } from '../engine/state'
import { recomputeDerived } from '../engine/state'
import { BUILDINGS, BUILDING_IDS, type BuildingId, type ResourceCost } from '../content/buildings'

/**
 * Building engine — generic, data-driven purchase logic. Pure functions of
 * `GameState` + the {@link BUILDINGS} catalogue; Node-safe (no DOM/clock). The
 * only mutation is in {@link build}, which spends resources, bumps a level and
 * re-derives cached stats. Adding a building never touches this file.
 *
 * The whole economy is on Decimal; costs are rounded UP so a level never costs
 * less than its formula.
 */

/** Floor the global cost multiplier can never drop below, however many HQ levels. */
const COST_REDUCTION_FLOOR = D(0.5)

/**
 * Global build-cost multiplier from EVERY building whose effect reduces build
 * cost: the product of `(1 - perLevel) ^ level` across all `cost_reduction`
 * buildings, clamped to never go below {@link COST_REDUCTION_FLOOR} so costs stay
 * meaningful. Data-driven — mirrors how {@link recomputeDerived} rolls up the
 * other effect kinds, so adding a second cost_reduction building (e.g. a tavern)
 * is a data entry with zero engine changes. Exposed for UI ("koszt -X%").
 */
export function costReduction(state: GameState): Decimal {
  let factor = D(1)
  for (const id of BUILDING_IDS) {
    const effect = BUILDINGS[id].effect
    if (effect.kind !== 'cost_reduction') continue
    const level = state.buildings[id]
    if (level > 0) factor = factor.mul(D(1 - effect.perLevel).pow(level))
  }
  return factor.lt(COST_REDUCTION_FLOOR) ? COST_REDUCTION_FLOOR : factor
}

/**
 * Cost of the NEXT level of `id` (current level -> +1), per resource:
 * `ceil(baseCost[r] * costFactor ^ currentLevel * costReduction)`.
 * Still defined when the building is maxed (callers should gate on `maxed`).
 */
export function buildingCost(state: GameState, id: BuildingId): ResourceCost {
  const def = BUILDINGS[id]
  const level = state.buildings[id]
  const growth = D(def.costFactor).pow(level)
  const reduction = costReduction(state)
  const scaled = growth.mul(reduction)
  return {
    wood: D(def.baseCost.wood).mul(scaled).ceil(),
    clay: D(def.baseCost.clay).mul(scaled).ceil(),
    iron: D(def.baseCost.iron).mul(scaled).ceil(),
  }
}

/** True when the player can pay `cost` from current resources. */
export function canAfford(state: GameState, cost: ResourceCost): boolean {
  return (
    state.resources.wood.gte(cost.wood) &&
    state.resources.clay.gte(cost.clay) &&
    state.resources.iron.gte(cost.iron)
  )
}

/**
 * Attempt to upgrade `id` by one level. Returns false (no mutation) when the
 * building is already maxed or the player cannot afford the next level; otherwise
 * spends the cost, increments the level, re-derives cached stats and returns true.
 */
export function build(state: GameState, id: BuildingId): boolean {
  const def = BUILDINGS[id]
  if (state.buildings[id] >= def.maxLevel) return false

  const cost = buildingCost(state, id)
  if (!canAfford(state, cost)) return false

  state.resources.wood = state.resources.wood.sub(cost.wood)
  state.resources.clay = state.resources.clay.sub(cost.clay)
  state.resources.iron = state.resources.iron.sub(cost.iron)
  state.buildings[id] += 1
  recomputeDerived(state)
  return true
}

/** UI helper: the next level's cost plus whether it is affordable / maxed. */
export function nextCostAffordable(
  state: GameState,
  id: BuildingId,
): { cost: ResourceCost; affordable: boolean; maxed: boolean } {
  const maxed = state.buildings[id] >= BUILDINGS[id].maxLevel
  const cost = buildingCost(state, id)
  return { cost, affordable: !maxed && canAfford(state, cost), maxed }
}
