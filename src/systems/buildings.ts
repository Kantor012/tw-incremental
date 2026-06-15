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

/** Floor the BUILDING-only cost multiplier can never drop below, however many HQ levels. */
const COST_REDUCTION_FLOOR = D(0.5)

/**
 * Hard ceiling on the COMBINED (buildings + tech) cost reduction FRACTION: a fully
 * built-up HQ plus a maxed `construction` tree branch can shave at most 90% off, so
 * the returned multiplier never falls below 0.1 and a build is never (near-)free.
 * Mirrors `aggregateTechMods`' per-source caps; see M3.2 contract ("clamp total 0..0.9").
 */
const MAX_TOTAL_COST_REDUCTION = D(0.9)

/**
 * Per-village build-cost multiplier (1 = no discount; 0.1 = the {@link MAX_TOTAL_COST_REDUCTION}
 * cap). Combines two sources:
 *  - BUILDINGS: the product of `(1 - perLevel) ^ level` across every `cost_reduction`
 *    building in this village, floored at {@link COST_REDUCTION_FLOOR} so building
 *    discounts alone stay meaningful (data-driven — mirrors how
 *    {@link recomputeVillageDerived} rolls up the other effect kinds, so adding a
 *    second cost_reduction building is a data entry with zero engine changes).
 *  - TECH (M3.2): the account-wide `mods.costReduction` FRACTION (already clamped to
 *    [0, 0.8] by `aggregateTechMods`), folded in ADDITIVELY on the reduction side and
 *    the combined reduction clamped to {@link MAX_TOTAL_COST_REDUCTION}.
 *
 * With {@link NO_TECH_MODS} (`mods.costReduction === 0`) the building reduction is
 * <= 0.5 < the 0.9 cap, so this returns the floored building factor UNCHANGED — the
 * pure-building economy (and every existing caller/test) is byte-identical. Exposed
 * for UI ("koszt -X%").
 */
export function costReduction(v: Village, mods: TechModifiers = NO_TECH_MODS): Decimal {
  let factor = D(1)
  for (const id of BUILDING_IDS) {
    const effect = BUILDINGS[id].effect
    if (effect.kind !== 'cost_reduction') continue
    const level = v.buildings[id]
    if (level > 0) factor = factor.mul(D(1 - effect.perLevel).pow(level))
  }
  const buildingFactor = factor.lt(COST_REDUCTION_FLOOR) ? COST_REDUCTION_FLOOR : factor

  // Combine the two REDUCTION fractions: (1 - buildingFactor) + tech, clamped to the
  // 0.9 total cap, then convert back to a multiplier.
  let total = D(1).sub(buildingFactor).add(mods.costReduction)
  if (total.lt(0)) total = D(0)
  if (total.gt(MAX_TOTAL_COST_REDUCTION)) total = MAX_TOTAL_COST_REDUCTION
  return D(1).sub(total)
}

/**
 * Cost of the NEXT level of `id` (current level -> +1) in `v`, per resource:
 * `ceil(baseCost[r] * costFactor ^ currentLevel * costReduction(v, mods))`.
 * Still defined when the building is maxed (callers should gate on `maxed`).
 *
 * `mods` are the account-wide tech multipliers (M3.2): their `costReduction` fraction
 * is folded into the discount by {@link costReduction}. Defaults to {@link NO_TECH_MODS}
 * so existing call sites keep the pure-building cost; live callers thread the real mods.
 */
export function buildingCost(
  v: Village,
  id: BuildingId,
  mods: TechModifiers = NO_TECH_MODS,
): ResourceCost {
  const def = BUILDINGS[id]
  const level = v.buildings[id]
  const growth = D(def.costFactor).pow(level)
  const reduction = costReduction(v, mods)
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

  // Cost MUST reflect the same `mods` used for the recompute below, so the village is
  // charged exactly the (tech-discounted) amount the UI displayed.
  const cost = buildingCost(v, id, mods)
  if (!canAfford(v, cost)) return false

  v.resources.wood = v.resources.wood.sub(cost.wood)
  v.resources.clay = v.resources.clay.sub(cost.clay)
  v.resources.iron = v.resources.iron.sub(cost.iron)
  v.buildings[id] += 1
  recomputeVillageDerived(v, mods)
  return true
}

/**
 * Multiplicative shield this village's standing army enjoys when DEFENDING against
 * incoming raids (M5.2 wall). 1 = no bonus (no wall); 1.5 = a maxed wall at the
 * default perLevel 0.05 (+50% defence).
 *
 * Data-driven and ADDITIVE, exactly mirroring how {@link costReduction} rolls up its
 * own effect kind: it sums `level * perLevel` across every `defense_bonus` building in
 * the village and returns `1 + that sum`. With only the `wall` building this is the
 * contract's `1 + wallLevel * perLevel`, but a second fortification building is a pure
 * data entry in buildings.ts with ZERO change here (CLAUDE.md hard rule #5).
 *
 * Returns a plain `number` to multiply straight into {@link armyDefensePower}'s output
 * in raids.ts — the wall raises ONLY raid defence, never attack, production or the
 * conquest path, so the balance impact is the intended LOW one. Pure / deterministic:
 * no clock, no RNG, no allocation.
 */
export function villageDefenseMult(v: Village): number {
  let bonus = 0
  for (const id of BUILDING_IDS) {
    const effect = BUILDINGS[id].effect
    if (effect.kind !== 'defense_bonus') continue
    bonus += v.buildings[id] * effect.perLevel
  }
  return 1 + bonus
}

/**
 * UI helper: the next level's cost in `v` plus whether it is affordable / maxed.
 * `mods` (M3.2) are the account-wide tech multipliers folded into the cost; defaults to
 * {@link NO_TECH_MODS} so existing callers compile, live callers thread the real mods.
 */
export function nextCostAffordable(
  v: Village,
  id: BuildingId,
  mods: TechModifiers = NO_TECH_MODS,
): { cost: ResourceCost; affordable: boolean; maxed: boolean } {
  const maxed = v.buildings[id] >= BUILDINGS[id].maxLevel
  const cost = buildingCost(v, id, mods)
  return { cost, affordable: !maxed && canAfford(v, cost), maxed }
}
