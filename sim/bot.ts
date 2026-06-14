import { ZERO, type Decimal } from '../src/engine/decimal'
import { RESOURCE_IDS, type GameState } from '../src/engine/state'
import { BUILDING_IDS, type BuildingId } from '../src/content/buildings'
import { UNITS, UNIT_IDS, type UnitId } from '../src/content/units'
import { nextCostAffordable } from '../src/systems/buildings'
import {
  barracksUnlocked,
  canRecruit,
  recruitCost,
  freePopulation,
} from '../src/systems/recruitment'

/**
 * Bot-player heuristic. The runner consults it once per simulated step so the
 * harness exercises the same purchase/recruit code paths a real player drives,
 * and the no-softlock invariant uses it to ask "is any progress action available?".
 *
 * Pure function of `GameState` only — no hidden counters — so the determinism /
 * save-load invariants hold and checkNoSoftlock can probe `chooseAction(state)`
 * to detect "nothing left to do" without perturbing any cadence.
 */
export type BotAction =
  | { kind: 'build'; id: BuildingId }
  | { kind: 'recruit'; unitId: UnitId; count: number }

/**
 * Surplus multiplier for the build-vs-recruit tiebreak: when total resources reach
 * at least this multiple of the cheapest building's cost, the bot spends the
 * SURPLUS on recruitment instead of hoarding it; below it, the bot keeps buying
 * buildings. This interleaves economy growth with population filling without any
 * external clock — purely from the current resource level. The recruit batch is
 * separately bounded by free population, so early game (small popCap) the bot only
 * trains a handful of units, then resumes building (incl. the farm) to grow popCap.
 */
const BUILD_RESERVE = 2

/** Sum of all resources — a coarse proxy used only for the build-vs-recruit gate. */
function resourceSum(state: GameState): Decimal {
  let total = ZERO
  for (const id of RESOURCE_IDS) total = total.add(state.resources[id])
  return total
}

/**
 * Cheapest affordable, non-maxed building, ranked by total cost across resources
 * (wood + clay + iron) on Decimal so the comparison stays exact past 2^53. Ties
 * resolve to the first id in {@link BUILDING_IDS} order — fully deterministic.
 */
function cheapestBuilding(state: GameState): { id: BuildingId; sum: Decimal } | null {
  let best: BuildingId | null = null
  let bestSum: Decimal | null = null
  for (const id of BUILDING_IDS) {
    const { cost, affordable, maxed } = nextCostAffordable(state, id)
    if (maxed || !affordable) continue
    const sum = cost.wood.add(cost.clay).add(cost.iron)
    if (bestSum === null || sum.lt(bestSum)) {
      bestSum = sum
      best = id
    }
  }
  return best === null || bestSum === null ? null : { id: best, sum: bestSum }
}

/**
 * How many of `unitId` the bot can train in ONE order right now: bounded by free
 * population (so it never over-commits the farm) and by per-resource affordability.
 * Counts are plain integers; resource division uses Decimal then floors. Returns 0
 * when nothing fits.
 */
function recruitBatch(state: GameState, unitId: UnitId): number {
  const def = UNITS[unitId]
  if (def.pop <= 0) return 0
  const free = freePopulation(state).toNumber()
  let count = Math.floor(free / def.pop)
  count = Math.min(count, affordableUnits(state.resources.wood, def.cost.wood))
  count = Math.min(count, affordableUnits(state.resources.clay, def.cost.clay))
  count = Math.min(count, affordableUnits(state.resources.iron, def.cost.iron))
  return count > 0 ? count : 0
}

/** How many units a single resource pool can pay for at `per` cost each. */
function affordableUnits(have: Decimal, per: number): number {
  if (per <= 0) return Number.POSITIVE_INFINITY
  return Math.floor(have.div(per).toNumber())
}

/**
 * Cheapest recruitable unit as a full batch action, or null when nothing can be
 * trained (barracks locked, no free population, or unaffordable). Ranks by single
 * -unit cost sum; ties resolve to the first id in {@link UNIT_IDS} order.
 */
function cheapestRecruit(state: GameState): Extract<BotAction, { kind: 'recruit' }> | null {
  let best: UnitId | null = null
  let bestSum: Decimal | null = null
  for (const id of UNIT_IDS) {
    if (!canRecruit(state, id, 1).ok) continue
    const c = recruitCost(id, 1)
    const sum = c.wood.add(c.clay).add(c.iron)
    if (bestSum === null || sum.lt(bestSum)) {
      bestSum = sum
      best = id
    }
  }
  if (best === null) return null
  const count = recruitBatch(state, best)
  return count >= 1 ? { kind: 'recruit', unitId: best, count } : null
}

/**
 * Choose the next action, or null when nothing is affordable / available.
 *
 * M1.2 strategy:
 *  1. Build the BARRACKS first (the recruitment gate) as soon as it is affordable —
 *     it is not the cheapest building, so it needs an explicit priority.
 *  2. Otherwise pick between the cheapest building upgrade and the cheapest unit
 *     batch: spend the surplus above a {@link BUILD_RESERVE} multiple of the next
 *     building's cost on recruitment, else buy the building. This keeps buildings
 *     marching toward their maxLevel while population fills over time — a steady
 *     resource SINK that extends the loop past the building ceiling.
 *
 * Returns null only when every non-maxed building is unaffordable AND no unit can
 * be trained — the signal checkNoSoftlock pairs with resource growth / content
 * consumption to classify a stall.
 */
export function chooseAction(state: GameState): BotAction | null {
  if (!barracksUnlocked(state)) {
    const b = nextCostAffordable(state, 'barracks')
    if (!b.maxed && b.affordable) return { kind: 'build', id: 'barracks' }
    // Can't afford the barracks yet — grow the economy via the cheapest build below.
  }

  const building = cheapestBuilding(state)
  const recruit = barracksUnlocked(state) ? cheapestRecruit(state) : null

  if (building === null) return recruit // recruit if possible, else null (nothing to do)
  if (recruit === null) return { kind: 'build', id: building.id }

  // Both available: spend the surplus on units, keep the reserve for buildings.
  const flush = resourceSum(state).gte(building.sum.mul(BUILD_RESERVE))
  return flush ? recruit : { kind: 'build', id: building.id }
}
