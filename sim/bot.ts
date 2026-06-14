import { ZERO, type Decimal } from '../src/engine/decimal'
import { RESOURCE_IDS, type Village, type World } from '../src/engine/state'
import { BUILDING_IDS, type BuildingId } from '../src/content/buildings'
import { UNITS, UNIT_IDS, type UnitId } from '../src/content/units'
import { nextCostAffordable } from '../src/systems/buildings'
import {
  barracksUnlocked,
  canRecruit,
  recruitCost,
  freePopulation,
} from '../src/systems/recruitment'
import { stationedUnits } from '../src/systems/marches'
import { targetsByDistance } from '../src/systems/world'
import { battleOutcome, armyAttackPower, armyCarry, applyLosses } from '../src/systems/combat'
import { barbarianTarget, MAX_TARGET_LEVEL } from '../src/content/barbarians'

/**
 * Bot-player heuristic. The runner consults it once per simulated step so the
 * harness exercises the same purchase/recruit code paths a real player drives,
 * and the no-softlock invariant uses it to ask "is any progress action available?".
 *
 * Since M2.1 the bot acts on ONE {@link Village} (the runner drives the first
 * village in {@link import('../src/engine/state').GameState.villageOrder}); the
 * functions are pure over that village + the catalogues (and, since M2.2, the seed-
 * generated {@link World} for picking a concrete attack target) — no hidden counters
 * — so the determinism / save-load invariants hold and checkNoSoftlock can probe
 * `chooseAction(village, world)` to detect "nothing left to do" without perturbing any
 * cadence. Founding/managing extra villages is a later milestone (M2.3+); the bot
 * deliberately stays single-village so the run still exercises one economy at a time.
 */
export type BotAction =
  | { kind: 'build'; id: BuildingId }
  | { kind: 'recruit'; unitId: UnitId; count: number }
  | { kind: 'attack'; targetId: string; targetLevel: number; units: Record<UnitId, number> }

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

/**
 * Highest fraction of the attacking army the bot will accept losing on a raid of a
 * barbarian camp. The bot picks the HIGHEST camp tier it beats while staying under
 * this loss — so as the home army grows it graduates to richer, harder camps on its
 * own (battleOutcome's super-linear loss curve makes a comfortable win nearly free
 * and a narrow one ruinous, so this single knob both protects the army and steers it
 * toward the most profitable winnable tier). Kept moderate so attacks net loot rather
 * than throwing the army away.
 */
const MAX_ATTACK_LOSS = 0.35

/**
 * Smallest home army the bot will commit to an attack. Below this the army is too
 * thin to be worth a march (and too thin to out-power even tier 1 with acceptable
 * losses); the bot keeps recruiting instead. Acts as the accumulate-before-strike
 * floor so the loop alternates "grow the stack" and "send it for loot".
 */
const STRIKE_MIN_ARMY = 8

/** Sum of a village's resources — a coarse proxy used only for the build-vs-recruit gate. */
function resourceSum(v: Village): Decimal {
  let total = ZERO
  for (const id of RESOURCE_IDS) total = total.add(v.resources[id])
  return total
}

/**
 * Cheapest affordable, non-maxed building in `v`, ranked by total cost across
 * resources (wood + clay + iron) on Decimal so the comparison stays exact past
 * 2^53. Ties resolve to the first id in {@link BUILDING_IDS} order — fully
 * deterministic.
 */
function cheapestBuilding(v: Village): { id: BuildingId; sum: Decimal } | null {
  let best: BuildingId | null = null
  let bestSum: Decimal | null = null
  for (const id of BUILDING_IDS) {
    const { cost, affordable, maxed } = nextCostAffordable(v, id)
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
 * How many of `unitId` the bot can train in ONE order right now in `v`: bounded by
 * free population (so it never over-commits the farm) and by per-resource
 * affordability. Counts are plain integers; resource division uses Decimal then
 * floors. Returns 0 when nothing fits.
 */
function recruitBatch(v: Village, unitId: UnitId): number {
  const def = UNITS[unitId]
  if (def.pop <= 0) return 0
  const free = freePopulation(v).toNumber()
  let count = Math.floor(free / def.pop)
  count = Math.min(count, affordableUnits(v.resources.wood, def.cost.wood))
  count = Math.min(count, affordableUnits(v.resources.clay, def.cost.clay))
  count = Math.min(count, affordableUnits(v.resources.iron, def.cost.iron))
  return count > 0 ? count : 0
}

/** How many units a single resource pool can pay for at `per` cost each. */
function affordableUnits(have: Decimal, per: number): number {
  if (per <= 0) return Number.POSITIVE_INFINITY
  return Math.floor(have.div(per).toNumber())
}

/**
 * Cheapest recruitable unit in `v` as a full batch action, or null when nothing can
 * be trained (barracks locked, no free population, or unaffordable). Ranks by
 * single-unit cost sum; ties resolve to the first id in {@link UNIT_IDS} order.
 */
function cheapestRecruit(v: Village): Extract<BotAction, { kind: 'recruit' }> | null {
  let best: UnitId | null = null
  let bestSum: Decimal | null = null
  for (const id of UNIT_IDS) {
    if (!canRecruit(v, id, 1).ok) continue
    const c = recruitCost(id, 1)
    const sum = c.wood.add(c.clay).add(c.iron)
    if (bestSum === null || sum.lt(bestSum)) {
      bestSum = sum
      best = id
    }
  }
  if (best === null) return null
  const count = recruitBatch(v, best)
  return count >= 1 ? { kind: 'recruit', unitId: best, count } : null
}

/** Head-count of a home roster (units AT HOME, available to march). */
function homeArmySize(home: Record<UnitId, number>): number {
  let n = 0
  for (const id of UNIT_IDS) n += home[id] ?? 0
  return n
}

/**
 * Pick an attack for the army currently AT HOME in `v` against a CONCRETE barbarian
 * village on the world map (M2.2), or null when none is worthwhile.
 *
 * The loop's loot SOURCE: first find the HIGHEST camp tier the home stack beats with
 * losses under {@link MAX_ATTACK_LOSS} AND with at least one surviving hauler (carry >
 * 0, so loot actually comes home) — defence/loot are still tier-derived, so this is
 * the same ladder scan as before M2.2. Then resolve that tier to the NEAREST real
 * village of that level via {@link targetsByDistance} (ascending, so the first match
 * is closest) — the shortest march, hence the best loot throughput, among the hardest
 * winnable targets. Because every tier 1..MAX is always populated by generateWorld
 * (countForLevel >= 1) and the ring radius is ~tier·DISTANCE_PER_LEVEL, the chosen
 * level — and so the march time — matches the pre-spatial behaviour, preserving balance.
 *
 * Sends the WHOLE home army — after dispatch the home is empty, so at most one attack
 * is issued per step and the freshly-trained / returning units rebuild the stack for
 * the next strike. Pure function of the village + world (stationedUnits − catalogues),
 * so it stays deterministic and safe for the no-softlock probe to call.
 *
 * Returns null when the barracks are locked, the home stack is below
 * {@link STRIKE_MIN_ARMY}, or no tier is winnable within the loss budget.
 */
function chooseAttack(v: Village, world: World): Extract<BotAction, { kind: 'attack' }> | null {
  if (!barracksUnlocked(v)) return null
  const home = stationedUnits(v)
  if (homeArmySize(home) < STRIKE_MIN_ARMY) return null
  const atkPower = armyAttackPower(home)
  if (atkPower <= 0) return null

  // Highest beatable camp tier within the loss budget and with surviving carry.
  let bestLevel = 0
  for (let lvl = MAX_TARGET_LEVEL; lvl >= 1; lvl--) {
    const target = barbarianTarget(lvl)
    const outcome = battleOutcome(atkPower, target.defensePower)
    if (!outcome.attackerWins) continue
    if (outcome.attackerLossFrac > MAX_ATTACK_LOSS) continue
    // Survivors must still be able to carry loot home, else the march nets nothing.
    if (armyCarry(applyLosses(home, outcome.attackerLossFrac)) <= 0) continue
    bestLevel = lvl
    break
  }
  if (bestLevel === 0) return null

  // Resolve the tier to the nearest concrete village of that level (fastest march).
  for (const b of targetsByDistance(v, world)) {
    if (b.level === bestLevel) {
      return { kind: 'attack', targetId: b.id, targetLevel: b.level, units: home }
    }
  }
  return null
}

/**
 * Choose the next action for village `v`, or null when nothing is affordable /
 * available.
 *
 * M1.3 strategy:
 *  0. Build the BARRACKS first (recruitment + military gate), as in M1.2.
 *  1. STRIKE: if a home stack of at least {@link STRIKE_MIN_ARMY} can beat a camp
 *     within the loss budget, send it (the loot source + a unit sink via casualties).
 *     This is given priority over economy so a ready army never idles — but because
 *     the army is usually away or below the floor, the economy/recruit logic below
 *     still runs most steps. The attack frees population via casualties and brings
 *     loot, which finances the next wave: recruit -> attack -> loot -> recruit.
 *  2. Otherwise fall back to the M1.2 economy logic.
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
export function chooseAction(v: Village, world: World): BotAction | null {
  if (!barracksUnlocked(v)) {
    const b = nextCostAffordable(v, 'barracks')
    if (!b.maxed && b.affordable) return { kind: 'build', id: 'barracks' }
    // Can't afford the barracks yet — grow the economy via the cheapest build below.
  }

  // M1.3: a ready home army strikes for loot before the economy spends below.
  // M2.2: the strike targets a concrete world village (chooseAttack reads `world`).
  const attack = chooseAttack(v, world)
  if (attack !== null) return attack

  const building = cheapestBuilding(v)
  const recruit = barracksUnlocked(v) ? cheapestRecruit(v) : null

  if (building === null) return recruit // recruit if possible, else null (nothing to do)
  if (recruit === null) return { kind: 'build', id: building.id }

  // Both available: spend the surplus on units, keep the reserve for buildings.
  const flush = resourceSum(v).gte(building.sum.mul(BUILD_RESERVE))
  return flush ? recruit : { kind: 'build', id: building.id }
}
