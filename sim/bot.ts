import { ZERO, type Decimal } from '../src/engine/decimal'
import {
  RESOURCE_IDS,
  NO_TECH_MODS,
  type GameState,
  type Village,
  type World,
  type Fortress,
  type TechModifiers,
} from '../src/engine/state'
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
import { targetsByDistance, distance } from '../src/systems/world'
import {
  battleOutcome,
  armyAttackPower,
  armyDefensePower,
  armyCarry,
  applyLosses,
  ramDefenseFactor,
  WORST_LUCK,
} from '../src/systems/combat'
import { barbarianTarget, MAX_TARGET_LEVEL } from '../src/content/barbarians'
import { fortressTarget } from '../src/content/fortresses'
import { foundCost, findFoundingSpot, canFound, playerVillageCount } from '../src/systems/villages'
import { raidPower } from '../src/systems/raids'
import { nobleCount, LOYALTY_NOBLE_HIT } from '../src/systems/conquest'
import { TECH_NODE_IDS } from '../src/content/tech'
import {
  nodeAvailable,
  nodeLevel,
  techCost,
  globalResources,
  aggregateTechMods,
} from '../src/systems/tech'
import { PRESTIGE_NODE_IDS } from '../src/content/prestige'
import {
  pendingPrestigePoints,
  prestigeNodeAvailable,
  prestigeNodeLevel,
  prestigeNodeCost,
} from '../src/systems/prestige'
import { pendingEraPoints } from '../src/systems/era'
import { pendingDynastyPoints } from '../src/systems/dynasty'

/**
 * Bot-player heuristic. The runner consults it once per simulated step so the
 * harness exercises the same purchase/recruit code paths a real player drives,
 * and the no-softlock invariant uses it to ask "is any progress action available?".
 *
 * The per-village economy/military decision ({@link chooseAction}) acts on ONE
 * {@link Village} (the runner drives the first village in
 * {@link import('../src/engine/state').GameState.villageOrder}); it is pure over that
 * village + the catalogues (and, since M2.2, the seed-generated {@link World} for
 * picking a concrete attack target) — no hidden counters — so the determinism /
 * save-load invariants hold and checkNoSoftlock can probe `chooseAction(village,
 * world)` to detect "nothing left to do" without perturbing any cadence.
 *
 * M2.3 adds a SEPARATE, global EXPANSION decision ({@link chooseFounding}) that reads
 * the whole {@link GameState} (cost scales with how many villages are already owned,
 * and a valid site must be searched on the world map). It is kept OUT of
 * {@link chooseAction} on purpose: founding is paid from the capital but is not a
 * per-village economy move, and folding it into the softlock probe would let "you can
 * always found another village" mask a genuine economy stall. The runner consults it
 * once per step AFTER the per-village loop, so expansion only spends what the
 * recruit -> attack -> loot loop left idle. It is likewise a pure function of state,
 * so determinism / save-load continuation hold across a founded village too.
 *
 * M2.4 adds a second global decision ({@link chooseConquest}, consulted once per step
 * BEFORE the per-village loop so it gets first claim on resources / the reserved
 * population): build the Pałac, train a noble strike force behind a raid-repelling home
 * garrison, and march it into a barbarian camp until the camp's loyalty hits 0 and it
 * flips to a player village. It is self-limited ({@link BOT_MAX_CONQUESTS}) so it leaves
 * the village cap room for founding. Its enabler is the M2.4 shift in the loot strategy:
 * {@link chooseAttack} now marches only the {@link marchSurplus} beyond a garrison the
 * bot actively holds above the raid threshold ({@link garrisonRecruit}), because a
 * successful raid wipes the ENTIRE home stack — so without a standing wall the fragile
 * nobles could never survive at home. Both are pure functions of state, so determinism /
 * save-load continuation hold with conquest in play.
 *
 * M3.2 threads the aggregated tech {@link TechModifiers} through every decision that
 * weighs power or cost, so the bot judges combat and affordability against the SAME
 * numbers the engine resolves with: {@link chooseAction} (and its garrison / surplus /
 * strike helpers) takes `mods` as an argument (the per-village probe has no GameState),
 * while the state-level {@link chooseConquest} / {@link chooseFounding} derive
 * `aggregateTechMods(state.tech)` internally. `mods` is a pure function of `state.tech`,
 * so two identical runs compute identical bonuses — determinism / save-load continuation
 * hold with the M3.2 military / fortification / logistics / plunder / construction /
 * training branches in play. The runner threads the same `mods` into the live
 * build / recruit / sendAttack calls, and chooseTech (unchanged) keeps buying the
 * cheapest available node, so the widened ~180-node tree is bought breadth-first.
 */
export type BotAction =
  | { kind: 'build'; id: BuildingId }
  | { kind: 'recruit'; unitId: UnitId; count: number }
  | { kind: 'attack'; targetId: string; targetLevel: number; units: Record<UnitId, number> }
  | { kind: 'assault'; fortressId: string; fortressLevel: number; units: Record<UnitId, number> }
  | { kind: 'found'; x: number; y: number }

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
 *
 * `mods` (M3.2) thread the account-wide tech `costReduction` into `nextCostAffordable`
 * so the bot judges affordability against the SAME discounted price `build(v, id, mods)`
 * actually charges — without it the bot would pass over a building it can in fact afford
 * once construction perks are bought. The discount is a single multiplier applied
 * uniformly to every building, so the cheapest RANKING is unchanged; only the
 * affordability cut moves. Defaults to {@link NO_TECH_MODS} (no discount).
 */
function cheapestBuilding(
  v: Village,
  mods: TechModifiers = NO_TECH_MODS,
): { id: BuildingId; sum: Decimal } | null {
  let best: BuildingId | null = null
  let bestSum: Decimal | null = null
  for (const id of BUILDING_IDS) {
    const { cost, affordable, maxed } = nextCostAffordable(v, id, mods)
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
 * the supplied `popBudget` (so it never over-commits the farm — and, via a reduced
 * budget, so combat recruitment can leave room for the noble strike force, see
 * {@link combatPopBudget}) and by per-resource affordability. Counts are plain
 * integers; resource division uses Decimal then floors. Returns 0 when nothing fits.
 */
function recruitBatch(
  v: Village,
  unitId: UnitId,
  popBudget: number = freePopulation(v).toNumber(),
): number {
  const def = UNITS[unitId]
  if (def.pop <= 0) return 0
  let count = Math.floor(popBudget / def.pop)
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
 * be trained (gate locked, no free population in `popBudget`, or unaffordable). Ranks
 * by single-unit cost sum; ties resolve to the first id in {@link UNIT_IDS} order.
 *
 * The noble is by far the most expensive unit, so it is never the "cheapest" pick —
 * combat recruitment naturally trains the infantry triad, and the noble is trained
 * separately by the conquest pipeline ({@link chooseConquest}). `popBudget` defaults
 * to the full free population; {@link chooseAction} passes a reduced
 * {@link combatPopBudget} so the noble strike force always has room to train.
 */
function cheapestRecruit(
  v: Village,
  popBudget: number = freePopulation(v).toNumber(),
): Extract<BotAction, { kind: 'recruit' }> | null {
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
  const count = recruitBatch(v, best, popBudget)
  return count >= 1 ? { kind: 'recruit', unitId: best, count } : null
}

/** Head-count of a home roster (units AT HOME, available to march). */
function homeArmySize(home: Record<UnitId, number>): number {
  let n = 0
  for (const id of UNIT_IDS) n += home[id] ?? 0
  return n
}

/** A fresh complete zero roster (every UnitId present). */
function emptyRoster(): Record<UnitId, number> {
  const r = {} as Record<UnitId, number>
  for (const id of UNIT_IDS) r[id] = 0
  return r
}

/**
 * Defence of the COMBAT garrison currently at home (nobles excluded — they march off).
 * `mods.defenseMult` (M3.2 fortification tech) is threaded so the bot reads the SAME
 * boosted defence the raid resolver applies (`armyDefensePower(home, mods)` in raids.ts);
 * without it the bot would over-build the wall. Defaults to {@link NO_TECH_MODS} (×1).
 */
function combatGarrisonDef(v: Village, mods: TechModifiers = NO_TECH_MODS): number {
  return armyDefensePower({ ...stationedUnits(v), noble: 0 }, mods)
}

/**
 * Defence the home garrison must hold to repel the next raid with a safety margin. Built
 * from {@link raidPower} (the INCOMING raid strength), which is deliberately left on the
 * NO_TECH_MODS default — raidPower's army term is a coarse village-progress proxy, not the
 * player's defence, so it is NOT scaled by fortification tech (mirrors resolveRaid, which
 * boosts only the defending garrison). The defender side carries the tech bonus instead,
 * via {@link combatGarrisonDef}.
 */
function raidThreshold(v: Village): number {
  return raidPower(v) * RAID_REPEL_MARGIN
}

/** Whether the home combat garrison already out-defends the next raid (defence tech-boosted). */
function homeRepelsRaid(v: Village, mods: TechModifiers = NO_TECH_MODS): boolean {
  return combatGarrisonDef(v, mods) >= raidThreshold(v)
}

/**
 * The COMBAT units (nobles never) that can march RIGHT NOW while leaving a home garrison
 * that still repels the next raid by {@link RAID_REPEL_MARGIN}. This is the linchpin of
 * M2.4 survival: a raid that out-powers the home garrison wipes EVERY home unit (loss
 * fraction 1, see raids.ts), and units only dodge raids by being in transit — so the
 * pre-M2.4 bot kept its whole stack on the road and let the home be wiped. That makes
 * holding the fragile nobles at home impossible. Instead the bot now ALWAYS keeps a
 * raid-proof wall at home ({@link garrisonRecruit} tops it up) and marches only the
 * surplus: home defence stays >= threshold, so raids are repelled and the nobles
 * accumulate safely behind the garrison.
 *
 * raidPower scales with the WHOLE owned army (home + away), and dispatch doesn't change
 * `v.units`, so the surplus is computed against a fixed bar: send the fraction of each
 * combat unit whose removal still leaves the threshold at home (floored, so a hair MORE
 * than needed stays). Returns an all-zero roster when nothing can be spared (whole
 * garrison is needed — early game, or a stack already out).
 */
function marchSurplus(v: Village, mods: TechModifiers = NO_TECH_MODS): Record<UnitId, number> {
  const combatHome = { ...stationedUnits(v), noble: 0 }
  const homeDef = armyDefensePower(combatHome, mods)
  if (homeDef <= 0) return emptyRoster()
  const surplusDef = homeDef - raidThreshold(v)
  const out = emptyRoster()
  if (surplusDef <= 0) return out
  const frac = surplusDef / homeDef
  for (const id of UNIT_IDS) {
    if (id === 'noble') continue
    out[id] = Math.floor(combatHome[id] * frac)
  }
  return out
}

/**
 * A defensive recruit that shores the home garrison up to the raid threshold, or null
 * when it already holds (or nothing can be trained). Recruits the cheap Pikinier (the
 * bot's main unit; spear defence is enough in bulk) sized to close the defence gap,
 * bounded by {@link combatPopBudget} (so it never eats the noble reserve) and
 * affordability. This is what keeps the wall standing as raidPower climbs with the army
 * and the building count — established cheaply early (low threshold) and topped up
 * thereafter, so the garrison is NEVER wiped and the conquest pipeline has a safe home.
 */
function garrisonRecruit(
  v: Village,
  mods: TechModifiers = NO_TECH_MODS,
): Extract<BotAction, { kind: 'recruit' }> | null {
  if (!barracksUnlocked(v)) return null
  const gap = raidThreshold(v) - combatGarrisonDef(v, mods)
  if (gap <= 0) return null
  // Each recruited spearman closes `defInfantry * defenseMult` of the (post-tech) gap,
  // so size the batch against the boosted per-unit defence — fewer units once
  // fortification perks are bought, matching the tech-aware repel check above.
  const want = Math.ceil(gap / (UNITS.spearman.defInfantry * mods.defenseMult))
  const batch = Math.min(want, recruitBatch(v, 'spearman', combatPopBudget(v)))
  if (batch >= 1 && canRecruit(v, 'spearman', batch).ok) {
    return { kind: 'recruit', unitId: 'spearman', count: batch }
  }
  return null
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
 * Sends the {@link marchSurplus} (the combat units beyond the raid-repelling garrison),
 * not the whole stack — the home wall stays up so raids are repelled and the nobles are
 * safe. As the surplus shrinks per dispatch, a few loot marches may go out per step until
 * the rest is needed at home. Pure function of the village + world (stationedUnits −
 * catalogues), so it stays deterministic and safe for the no-softlock probe to call.
 *
 * Returns null when the barracks are locked, the sparable surplus is below
 * {@link STRIKE_MIN_ARMY}, or no tier is winnable within the loss budget.
 */
function chooseAttack(
  v: Village,
  world: World,
  mods: TechModifiers = NO_TECH_MODS,
): Extract<BotAction, { kind: 'attack' }> | null {
  if (!barracksUnlocked(v)) return null
  // March only the SURPLUS beyond a raid-repelling home garrison (see marchSurplus): the
  // home stack survives raids, so the accumulating nobles (excluded here anyway — carry 0)
  // stay alive. Early game / a stack already out leaves no surplus, so the army builds up
  // at home until it can spare a striking force.
  const army = marchSurplus(v, mods)
  if (homeArmySize(army) < STRIKE_MIN_ARMY) return null
  // `mods.attackMult` (M3.2 military tech) scales the army's power to the SAME figure
  // advanceMarches resolves with — so the ladder scan below picks the true highest
  // beatable tier (and the survivor/carry projection matches the real outcome).
  const atkPower = armyAttackPower(army, mods)
  if (atkPower <= 0) return null

  // Highest beatable camp tier within the loss budget and with surviving carry.
  let bestLevel = 0
  for (let lvl = MAX_TARGET_LEVEL; lvl >= 1; lvl--) {
    const target = barbarianTarget(lvl)
    const outcome = battleOutcome(atkPower, target.defensePower)
    if (!outcome.attackerWins) continue
    if (outcome.attackerLossFrac > MAX_ATTACK_LOSS) continue
    // Survivors must still be able to carry loot home, else the march nets nothing.
    if (armyCarry(applyLosses(army, outcome.attackerLossFrac)) <= 0) continue
    bestLevel = lvl
    break
  }
  if (bestLevel === 0) return null

  // Resolve the tier to the nearest concrete village of that level (fastest march).
  for (const b of targetsByDistance(v, world)) {
    if (b.level === bestLevel) {
      return { kind: 'attack', targetId: b.id, targetLevel: b.level, units: army }
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
export function chooseAction(
  v: Village,
  world: World,
  mods: TechModifiers = NO_TECH_MODS,
): BotAction | null {
  if (!barracksUnlocked(v)) {
    const b = nextCostAffordable(v, 'barracks', mods)
    if (!b.maxed && b.affordable) return { kind: 'build', id: 'barracks' }
    // Can't afford the barracks yet — grow the economy via the cheapest build below.
  }

  // M2.4: hold the home garrison above the raid threshold BEFORE anything else. A
  // successful raid wipes the ENTIRE home stack (loss fraction 1), so the wall must come
  // first — and while it is still below threshold, DON'T spend on the academy / economy /
  // loot. That spending would both drain the resources the wall needs AND raise the
  // building count, which pushes raidPower (hence the threshold) up FASTER than the wall
  // can rise — the very deadlock that kept the garrison from ever bootstrapping. Holding
  // off keeps the building count (and threshold) low so the wall is cheap to establish;
  // once it holds, normal play resumes and tops it up incrementally (raids repelled, so
  // the garrison is never wiped again).
  if (barracksUnlocked(v) && !homeRepelsRaid(v, mods)) {
    return garrisonRecruit(v, mods) // a defensive spearman batch, or null to accumulate for it
  }

  // M2.4: the Pałac is the conquest unlock — buy level 1 the moment it is affordable (its
  // higher levels are left to the cheapest-building economy). Placed AFTER the garrison
  // gate so the wall always takes precedence.
  if (v.buildings.academy === 0) {
    const a = nextCostAffordable(v, 'academy', mods)
    if (!a.maxed && a.affordable) return { kind: 'build', id: 'academy' }
  }

  // M1.3: a ready home army strikes for loot before the economy spends below.
  // M2.2: the strike targets a concrete world village (chooseAttack reads `world`).
  // M2.4: chooseAttack now marches only the SURPLUS beyond a raid-repelling home
  // garrison (see marchSurplus), so the home stack always survives raids — which is what
  // keeps the accumulating nobles alive (a successful raid wipes the whole home garrison).
  const attack = chooseAttack(v, world, mods)
  if (attack !== null) return attack

  const building = cheapestBuilding(v, mods)
  // Combat recruitment uses a REDUCED population budget so the noble strike force always
  // has room to train (see combatPopBudget); the noble itself is never the cheapest pick.
  const recruit = barracksUnlocked(v) ? cheapestRecruit(v, combatPopBudget(v)) : null

  if (building === null) return recruit // recruit if possible, else null (nothing to do)
  if (recruit === null) return { kind: 'build', id: building.id }

  // Both available: spend the surplus on units, keep the reserve for buildings.
  const flush = resourceSum(v).gte(building.sum.mul(BUILD_RESERVE))
  return flush ? recruit : { kind: 'build', id: building.id }
}

/**
 * Size of the noble strike force the bot accumulates AT HOME before marching a conquest
 * (M2.4). The combat model floors survivors, so a won march keeps `N-1` of `N` nobles
 * even in a crushing win (floor(N·(1−ε))); with {@link LOYALTY_NOBLE_HIT}=25 a
 * full-loyalty (100) camp needs 4 surviving nobles, so 5 sent capture it in ONE march —
 * holds even for the worst case of nobles attacking with no escort (loss ≈ 9% → 4
 * survive). A balance floor: smaller and a single march can't finish a full camp.
 */
const CONQUEST_TARGET_NOBLES = 5

/** Population reserved for the noble strike force so combat recruitment never starves it. */
const NOBLE_POP_RESERVE = CONQUEST_TARGET_NOBLES * UNITS.noble.pop

/**
 * Self-limit on how many barbarian villages the bot will CONQUER over a run. Conquest
 * adds a player village (it counts toward {@link playerVillageCount}), so an unbounded
 * siege loop would crowd out {@link chooseFounding} under {@link BOT_MAX_VILLAGES}; this
 * keeps room for both the founding AND the conquest balance targets. >= the conquest
 * target (1) with headroom to prove the mechanic repeats deterministically.
 */
const BOT_MAX_CONQUESTS = 2

/** Count of a single unit type still queued for training in `v`. */
function queuedUnits(v: Village, unitId: UnitId): number {
  let n = 0
  for (const order of v.recruitQueue) if (order.unitId === unitId) n += order.count
  return n
}

/**
 * Free population a COMBAT recruit may use: the full headroom MINUS whatever the noble
 * strike force still needs ({@link NOBLE_POP_RESERVE} less the pop already held by owned
 * or queued nobles). Before any noble exists this withholds 50 pop so the academy-funded
 * conquest pipeline can always train its strike force even when the farm is otherwise
 * full of infantry; once the nobles exist (and so count against `freePopulation`) the
 * reserve relaxes to 0 and combat reclaims the headroom. No reserve before the Pałac.
 */
function combatPopBudget(v: Village): number {
  const free = freePopulation(v).toNumber()
  if (v.buildings.academy <= 0) return free
  const noblePop = (v.units.noble + queuedUnits(v, 'noble')) * UNITS.noble.pop
  const reserve = Math.max(0, NOBLE_POP_RESERVE - noblePop)
  return Math.max(0, free - reserve)
}

/** How many of `state`'s villages were CONQUERED (named by {@link applyConquest}). */
function conqueredVillageCount(state: GameState): number {
  let n = 0
  for (const id of state.villageOrder) {
    if (state.villages[id].name.startsWith('Zdobyta')) n++
  }
  return n
}

/** Safety factor the home garrison's defence must keep over the next raid's power. */
const RAID_REPEL_MARGIN = 1.15

/**
 * Pick a conquest march for `v` (ALL home nobles + the combat surplus as escort), or
 * null when none is finishable this strike. Scans barbarians nearest-first ({@link
 * targetsByDistance}) and takes the first still-loyal camp the strike force (a) beats
 * and (b) crushes hard enough that enough nobles SURVIVE to drop its remaining loyalty
 * to <= 0 in this single march — `survivingNobles >= ceil(loyalty / LOYALTY_NOBLE_HIT)`.
 * Because the nearest camps are the low tiers (small walls), the escort makes the loss
 * fraction tiny, so the nobles survive and the capture lands. Using only the surplus as
 * escort keeps the garrison home, so the conquest march never exposes the village to a
 * raid. Pure over (village + world); safe to call repeatedly.
 */
function chooseConquestAttack(
  v: Village,
  world: World,
  mods: TechModifiers = NO_TECH_MODS,
): Extract<BotAction, { kind: 'attack' }> | null {
  const home = stationedUnits(v)
  const nobles = nobleCount(home)
  if (nobles < 1) return null
  // The strike force: ALL home nobles + the combat SURPLUS as escort. Keeping the
  // garrison home means the conquest march doesn't expose the village to raids, and the
  // escort makes the loss fraction tiny so the nobles survive (the nobles alone already
  // beat a low-tier camp, but the escort guarantees the floor leaves enough of them).
  const army = marchSurplus(v, mods)
  army.noble = nobles
  // `mods.attackMult` matches the resolution power, so the surviving-noble projection
  // below (battleOutcome of this power) is exactly what advanceMarches will compute —
  // a tech-boosted strike only ever survives BETTER, so the one-march capture still lands.
  const atkPower = armyAttackPower(army, mods)
  if (atkPower <= 0) return null
  for (const b of targetsByDistance(v, world)) {
    if (b.loyalty <= 0) continue // already taken / being taken
    const target = barbarianTarget(b.level)
    const outcome = battleOutcome(atkPower, target.defensePower)
    if (!outcome.attackerWins) continue
    const survivors = applyLosses(army, outcome.attackerLossFrac)
    const needed = Math.ceil(b.loyalty / LOYALTY_NOBLE_HIT)
    if (nobleCount(survivors) >= needed) {
      return { kind: 'attack', targetId: b.id, targetLevel: b.level, units: army }
    }
  }
  return null
}

/**
 * CONQUEST pipeline (M2.4): the capital's one conquest move this step, or null. Drives
 * the loyalty -> capture loop end to end once the Pałac stands:
 *
 *  1. STOP once {@link BOT_MAX_CONQUESTS} camps are already taken — so the village cap
 *     leaves room for {@link chooseFounding} (both mechanics must hit their targets).
 *  2. GATE on the academy: until it is built (by {@link chooseAction}'s priority) there
 *     is nothing to do here.
 *  3. STRIKE when a full noble force is home AND a camp can be finished in one march
 *     ({@link chooseConquestAttack}) — sends all nobles + the combat surplus as escort,
 *     keeping the raid-repelling garrison home.
 *  4. Otherwise TRAIN toward the strike force: recruit nobles (counting any already
 *     queued) up to {@link CONQUEST_TARGET_NOBLES}, drawing on the reserved population.
 *
 * State-level (like {@link chooseFounding}) because it must see the whole village ledger
 * to self-limit; the runner consults it once per step BEFORE the per-village economy so
 * the noble force gets first claim on the reserved population and on resources. Pure and
 * deterministic (ledger + world + catalogues), so determinism / save-load continuation
 * hold with conquest in play.
 */
export function chooseConquest(state: GameState): Extract<BotAction, { kind: 'recruit' | 'attack' }> | null {
  if (conqueredVillageCount(state) >= BOT_MAX_CONQUESTS) return null

  const v = state.villages[state.villageOrder[0]]
  if (v.buildings.academy <= 0) return null

  // M3.2: fold the account-wide tech bonuses so the conquest power/defence projections
  // match what the engine resolves with. Derived from state.tech (deterministic).
  const mods = aggregateTechMods(state.tech)

  const home = stationedUnits(v)
  if (nobleCount(home) >= CONQUEST_TARGET_NOBLES) {
    const attack = chooseConquestAttack(v, state.world, mods)
    if (attack !== null) return attack
  }

  // Train nobles only once the home garrison repels raids — they accumulate behind that
  // wall (a raid would otherwise wipe the home stack, nobles included). garrisonRecruit
  // stands the wall up first, so this gate clears in the ordinary course of play.
  if (!homeRepelsRaid(v, mods)) return null

  // Keep topping up toward the strike force (owned home + away + queued all count).
  const have = v.units.noble + queuedUnits(v, 'noble')
  if (have < CONQUEST_TARGET_NOBLES) {
    const need = CONQUEST_TARGET_NOBLES - have
    const batch = Math.min(need, recruitBatch(v, 'noble', freePopulation(v).toNumber()))
    if (batch >= 1 && canRecruit(v, 'noble', batch).ok) {
      return { kind: 'recruit', unitId: 'noble', count: batch }
    }
  }
  return null
}

// --- M7 fortress assault (finite boss targets) ------------------------------------------
//
// A SEPARATE strike pipeline, mirroring the M2.4 conquest pipeline: fortresses are FINITE,
// far-ring boss targets that need a REAL siege army to crack. The bot accumulates a siege
// train (Tarany / rams) behind the raid-repelling wall, then — the moment its home strike
// force (the whole siege train + the combat surplus) would crack the NEAREST un-razed
// fortress EVEN ON THE UNLUCKIEST luck roll — assaults it, razing it for a one-time loot
// cache. Kept OUT of {@link chooseAction} (the no-softlock probe) on purpose, like
// conquest / founding: "you can always prep a fortress" must not mask a per-village economy
// stall. Pure functions of state + the catalogues, so determinism / save-load continuation
// hold with fortresses in play — and a run that never fields a beatable strike force simply
// never assaults one (only a modest siege-train recruit ever fires), so the existing combat
// loop is barely perturbed.

/**
 * Siege train size the bot holds at home for a fortress assault (M7). {@link ramDefenseFactor}
 * floors at RAM_DEF_MIN (a -60% wall) once a stack carries (1 - 0.4)/RAM_DEF_RED = 30 Tarany,
 * so 30 buys the FULL wall reduction — past it a ram adds only its tiny attack. Held behind the
 * raid wall and EXCLUDED from the camp-raid surplus (treated like the noble strike force in
 * {@link marchSurplus}), so the camp loop never marches the siege train off to a barbarian camp.
 */
const FORTRESS_TARGET_RAMS = 30

/**
 * Highest fraction of the assault army the bot will accept losing to raze a fortress. Set above
 * {@link MAX_ATTACK_LOSS} (a fortress is a one-time prize worth a costlier win) but still
 * bounded, so paired with the WORST-luck win check and the surviving-carry check below the bot
 * only ever assaults a fortress it cracks even on the unluckiest roll AND still hauls the cache
 * home.
 */
const MAX_FORTRESS_LOSS = 0.5

/**
 * A COPY of `world.fortresses` sorted ascending by Euclidean distance from village `v` (nearest
 * first), with the numeric id index ('f0','f1',…) as a deterministic tiebreak — mirrors
 * {@link targetsByDistance} for camps so the assault always picks the closest beatable fortress
 * (the shortest siege march). The source array is never mutated; pure + deterministic.
 */
function fortressesByDistance(v: Village, world: World): Fortress[] {
  return world.fortresses
    .map((f) => ({ f, d: distance(v.x, v.y, f.x, f.y) }))
    .sort((p, q) =>
      p.d !== q.d ? p.d - q.d : Number(p.f.id.slice(1)) - Number(q.f.id.slice(1)),
    )
    .map((p) => p.f)
}

/**
 * The fortress strike force for `v` (M7): the WHOLE home siege train (every Taran) plus the
 * combat SURPLUS beyond the raid-repelling garrison. Mirrors {@link chooseConquestAttack}'s
 * "marchSurplus + all nobles", with rams as the special hoarded unit instead of nobles — rams
 * are EXCLUDED from the protected garrison baseline (exactly as nobles are in {@link marchSurplus}),
 * so sending the whole siege train never eats into the wall the home keeps against raids: the
 * surplus is sized so the NON-ram garrison left behind still holds the raid threshold. Returns an
 * all-zero roster when no surplus can be spared.
 */
function fortressStrikeForce(
  v: Village,
  mods: TechModifiers = NO_TECH_MODS,
): Record<UnitId, number> {
  const home = stationedUnits(v)
  const out = emptyRoster()
  out.ram = home.ram // the whole siege train marches
  // Surplus of the NON-siege combat units, treating rams (and nobles) as already committed —
  // excluded from the defended garrison — so the wall stays >= threshold when the rams leave.
  const combatHome = { ...home, noble: 0, ram: 0 }
  const homeDef = armyDefensePower(combatHome, mods)
  if (homeDef <= 0) return out
  const surplusDef = homeDef - raidThreshold(v)
  if (surplusDef <= 0) return out
  const frac = surplusDef / homeDef
  for (const id of UNIT_IDS) {
    if (id === 'noble' || id === 'ram') continue
    out[id] = Math.floor(combatHome[id] * frac)
  }
  return out
}

/**
 * Pick a fortress assault for the strike force currently AT HOME in `v` (M7), or null when none
 * is winnable. Scans fortresses nearest-first ({@link fortressesByDistance}) and takes the first
 * still-un-razed one the strike force beats with the rams' wall reduction applied
 * ({@link ramDefenseFactor}) EVEN AT WORST-CASE LUCK ({@link WORST_LUCK}) — so the bot never
 * throws its siege train at a fortress a bad roll could lose — within the {@link MAX_FORTRESS_LOSS}
 * budget AND with at least one surviving hauler (so the loot cache actually comes home). Needs at
 * least one ram (a fortress wall is uncrackable without siege) and a strike force above
 * {@link STRIKE_MIN_ARMY}. Pure over (village + world); safe to call repeatedly.
 */
function chooseFortressTarget(
  v: Village,
  world: World,
  mods: TechModifiers = NO_TECH_MODS,
): Extract<BotAction, { kind: 'assault' }> | null {
  const army = fortressStrikeForce(v, mods)
  if ((army.ram ?? 0) < 1) return null // a fortress wall is uncrackable without siege
  if (homeArmySize(army) < STRIKE_MIN_ARMY) return null
  // Plan for the UNLUCKIEST roll: the army's power × WORST_LUCK must still beat the (ram-reduced)
  // wall, so the assault wins on every possible luck draw — never a coin-flip with the siege train.
  const atkWorst = armyAttackPower(army, mods) * WORST_LUCK
  if (atkWorst <= 0) return null
  for (const f of fortressesByDistance(v, world)) {
    if (f.razed) continue
    const target = fortressTarget(f.level)
    const effDef = target.defensePower * ramDefenseFactor(army)
    const outcome = battleOutcome(atkWorst, effDef)
    if (!outcome.attackerWins) continue
    if (outcome.attackerLossFrac > MAX_FORTRESS_LOSS) continue
    // Survivors must still carry the cache home, else the assault nets nothing.
    if (armyCarry(applyLosses(army, outcome.attackerLossFrac)) <= 0) continue
    return { kind: 'assault', fortressId: f.id, fortressLevel: f.level, units: army }
  }
  return null
}

/**
 * FORTRESS pipeline (M7): the capital's one fortress move this step, or null. Mirrors
 * {@link chooseConquest}:
 *
 *  1. GATE on the academy — the Taran (siege) is academy-gated, so until the Pałac stands there
 *     is nothing to do here (the bot builds it via {@link chooseAction}'s priority).
 *  2. STRIKE when a home strike force cracks the nearest un-razed fortress even at worst luck
 *     ({@link chooseFortressTarget}) — razes it for the one-time cache.
 *  3. Otherwise TRAIN the siege train toward {@link FORTRESS_TARGET_RAMS} rams, but only once the
 *     home garrison repels raids (a raid would wipe the whole home stack, rams included), so the
 *     wall always comes first — exactly like the noble accumulation in {@link chooseConquest}.
 *
 * State-level (like {@link chooseConquest} / {@link chooseFounding}) and consulted once per step
 * by the runner; pure + deterministic, so determinism / save-load continuation hold. It naturally
 * self-limits: a razed fortress is skipped forever, and there are only FORTRESS_COUNT of them.
 */
export function chooseFortressAssault(
  state: GameState,
): Extract<BotAction, { kind: 'recruit' | 'assault' }> | null {
  const v = state.villages[state.villageOrder[0]]
  if (!barracksUnlocked(v)) return null
  if (v.buildings.academy <= 0) return null // the siege (Taran) gate

  // M3.2: project power/defence with the account-wide tech bonuses, matching what the engine
  // resolves with. Derived from state.tech (deterministic). It only ever UNDER-counts when
  // prestige is active (prestige's attackMult is omitted) — which is SAFE here, since the bot
  // just stays more conservative about whether a fortress is winnable.
  const mods = aggregateTechMods(state.tech)

  const assault = chooseFortressTarget(v, state.world, mods)
  if (assault !== null) return assault

  // Build the siege train behind the raid wall (rams accumulate like nobles; a successful raid
  // would otherwise wipe the whole home stack, the siege train included).
  if (!homeRepelsRaid(v, mods)) return null
  const haveRams = v.units.ram + queuedUnits(v, 'ram')
  if (haveRams < FORTRESS_TARGET_RAMS) {
    const need = FORTRESS_TARGET_RAMS - haveRams
    const batch = Math.min(need, recruitBatch(v, 'ram', freePopulation(v).toNumber()))
    if (batch >= 1 && canRecruit(v, 'ram', batch).ok) {
      return { kind: 'recruit', unitId: 'ram', count: batch }
    }
  }
  return null
}

/**
 * Surplus multiplier over {@link foundCost} the capital must hold (in EVERY resource)
 * before the bot will spend on a new village. A buffer above the bare cost so founding
 * never drains the pool the recruit -> attack loop draws on — combined with the
 * idle-sink gate below it means expansion only ever uses resources that would
 * otherwise sit pinned at the warehouse cap doing nothing.
 */
const BOT_FOUND_RESERVE = 2

/**
 * Safety ceiling on how many villages the bot will own. The founding cost grows
 * geometrically ({@link FOUND_COST_GROWTH}) while the capital's storage is capped, so
 * founding self-limits to a handful of settlements well before this; the cap is a
 * belt-and-suspenders bound so a balance change to the cost curve can never let the
 * bot expand without limit and starve the measured economy/combat targets.
 */
const BOT_MAX_VILLAGES = 8

/**
 * EXPANSION decision (M2.3): occasionally found a new village, paid from the capital
 * (`villageOrder[0]`), or null when the bot should not expand this step. Deliberately
 * CONSERVATIVE so it cannot regress the M1.1–M1.3 targets:
 *
 *  1. owned village count is below {@link BOT_MAX_VILLAGES} (hard runaway guard),
 *  2. the capital's per-village resource sinks are BOTH idle — no affordable building
 *     upgrade ({@link cheapestBuilding} is null) AND no trainable unit
 *     ({@link cheapestRecruit} is null, i.e. population is full / nothing affordable),
 *     so the resources are genuinely surplus and not needed by the economy/army loop,
 *  3. the capital still holds at least {@link BOT_FOUND_RESERVE}× {@link foundCost} in
 *     every resource (a buffer on top of the bare price), and
 *  4. a valid founding site exists ({@link findFoundingSpot}) that {@link canFound}
 *     accepts (geometry + affordability).
 *
 * Pure function of `state` (cost / spot search / gates are all deterministic), so two
 * identical runs found the same villages in the same order — the determinism and
 * save-load-continuation invariants hold with expansion in play. The found site is the
 * nearest valid tile to the capital, so the empire grows outward in steps.
 */
export function chooseFounding(state: GameState): Extract<BotAction, { kind: 'found' }> | null {
  if (playerVillageCount(state) >= BOT_MAX_VILLAGES) return null

  const payerId = state.villageOrder[0]
  const payer = state.villages[payerId]

  // M3.2: judge "could still build" against the tech-discounted price (cheapestBuilding
  // threads mods), so founding waits behind a genuinely idle build queue — not one that
  // only looks exhausted at full price. Recruit cost is mod-independent, so cheapestRecruit
  // needs no mods. Derived from state.tech (deterministic).
  const mods = aggregateTechMods(state.tech)

  // Only expand with idle resources: never when the capital could still build or train.
  if (cheapestBuilding(payer, mods) !== null) return null
  if (cheapestRecruit(payer) !== null) return null

  const cost = foundCost(state)
  if (!payer.resources.wood.gte(cost.wood.mul(BOT_FOUND_RESERVE))) return null
  if (!payer.resources.clay.gte(cost.clay.mul(BOT_FOUND_RESERVE))) return null
  if (!payer.resources.iron.gte(cost.iron.mul(BOT_FOUND_RESERVE))) return null

  const spot = findFoundingSpot(state, payerId)
  if (spot === null) return null
  if (!canFound(state, payerId, spot.x, spot.y).ok) return null
  return { kind: 'found', x: spot.x, y: spot.y }
}

/**
 * Reserve multiplier over a tech node's next-level cost the GLOBAL resource pool (summed
 * across every village) must hold — in EVERY resource — before the bot buys it. A buffer
 * above the bare price so a tech purchase only ever spends genuine surplus and never
 * drains the empire below what the per-village economy / combat loop needs. Combined with
 * the runner consulting {@link chooseTech} LAST in a step (after the per-village economy,
 * founding AND conquest have taken their claim, so the capital is spent down to its
 * unspendable residual), this makes the passive tree a sink for the resources that would
 * otherwise sit pinned at the warehouse cap — exactly the "real sink that scales with the
 * empire and is bought gradually" design goal (CLAUDE.md / DESIGN.md).
 */
const TECH_RESERVE = 1.25

/**
 * TECH decision (M3.1): the next passive-tree node the bot should buy from the GLOBAL
 * pool this step, or null. Picks the CHEAPEST available node (prerequisites met, not yet
 * maxed) whose next-level {@link techCost} the global pool covers with the
 * {@link TECH_RESERVE} buffer in every resource — ranked by total cost across resources
 * on Decimal, ties resolved to the first id in {@link TECH_NODE_IDS} order, so it is
 * fully deterministic. Returns only the id; the runner performs the purchase via
 * {@link import('../src/systems/tech').purchaseTech} (mirroring chooseFounding /
 * foundVillage), which spends greedily across villages and re-derives every village so
 * the new multiplier folds into production / storage / population before time advances.
 *
 * A pure function of `state` (catalogue scan + global pool), so two identical runs buy
 * the same nodes in the same order — the determinism / save-load-continuation invariants
 * hold with the tree in play. Kept OUT of {@link chooseAction} (the no-softlock probe) on
 * purpose: like founding, "you can always buy another node" must not mask a genuine
 * per-village economy stall.
 */
export function chooseTech(state: GameState): string | null {
  const pool = globalResources(state)
  let best: string | null = null
  let bestSum: Decimal | null = null
  for (const id of TECH_NODE_IDS) {
    if (!nodeAvailable(state, id)) continue
    const cost = techCost(id, nodeLevel(state, id))
    if (pool.wood.lt(cost.wood.mul(TECH_RESERVE))) continue
    if (pool.clay.lt(cost.clay.mul(TECH_RESERVE))) continue
    if (pool.iron.lt(cost.iron.mul(TECH_RESERVE))) continue
    const sum = cost.wood.add(cost.clay).add(cost.iron)
    if (bestSum === null || sum.lt(bestSum)) {
      bestSum = sum
      best = id
    }
  }
  return best
}

/**
 * Profitability floor for ascending (M4.1): the bot resets the run only once doing so
 * RIGHT NOW would bank at least this many prestige points — enough for a meaningful
 * prestige purchase (several baseCost-1 root levels). This threshold is what PACES the
 * ascension loop and guarantees it can never spin: a fresh post-ascension run scores
 * only ~8 (a single capital) → pendingPP ~2 < this, so the bot must rebuild the economy
 * to score >= ASCEND_MIN_PP² (≈ 36) before it will ascend again — there is no degenerate
 * "ascend for nothing" cycle. Sized so the FIRST ascension lands in a reasonable session
 * (a built-up capital reaches it within a couple thousand ticks — see the sim).
 */
export const ASCEND_MIN_PP = 6

/**
 * Hard cap on ascensions the bot performs in one harness run (M4.1). Each ascension
 * RESETS the run, so an unbounded ascend loop would never terminate the headless sim;
 * this bounds it while still proving the mechanic REPEATS deterministically (>= 1 with
 * headroom). The {@link ASCEND_MIN_PP} threshold already paces them; this is the
 * belt-and-suspenders runtime guard the brief calls for ("ogranicz liczbę ascensions").
 */
export const BOT_MAX_ASCENSIONS = 4

/**
 * ASCEND decision (M4.1): true when the bot should reset the run for prestige points
 * THIS step. Gated on (a) the ascension cap {@link BOT_MAX_ASCENSIONS} (so the resetting
 * loop always terminates) and (b) the {@link ASCEND_MIN_PP} profitability floor on
 * {@link pendingPrestigePoints} (so a reset always banks a worthwhile, spendable amount —
 * and so a just-reset run can never immediately re-ascend). A pure function of `state`, so
 * two identical runs ascend at the same ticks — the determinism / save-load-continuation
 * invariants hold across the reset. `maxAscensions` is overridable for tests.
 */
export function chooseAscend(state: GameState, maxAscensions: number = BOT_MAX_ASCENSIONS): boolean {
  if (state.prestige.ascensions >= maxAscensions) return false
  return pendingPrestigePoints(state) >= ASCEND_MIN_PP
}

/**
 * PRESTIGE-tree decision (M4.1): the next prestige node to buy from the BANKED points,
 * or null when nothing affordable/available remains. Picks the CHEAPEST available node
 * (prerequisites met, not maxed) whose next-level {@link prestigeNodeCost} the bank
 * covers — ranked by PP cost, ties resolved to the first id in {@link PRESTIGE_NODE_IDS}
 * order, so it is fully deterministic. Cheapest-first spends each ascension's PP on
 * BREADTH (the roots — incl. the production root, so the permanent economy bonus folds in
 * — then their cheap minors), which is exactly what the prestige targets verify.
 *
 * PP has no idle accrual (it is earned ONLY by ascending), so the runner calls this in a
 * loop after each ascension to spend the bank DOWN to its unaffordable residual. A pure
 * function of `state`, so the buy order is identical across the determinism / save-load
 * runs.
 */
export function choosePrestige(state: GameState): string | null {
  const points = state.prestige.points
  let best: string | null = null
  let bestCost = Infinity
  for (const id of PRESTIGE_NODE_IDS) {
    if (!prestigeNodeAvailable(state, id)) continue
    const cost = prestigeNodeCost(id, prestigeNodeLevel(state, id))
    if (cost > points) continue
    if (cost < bestCost) {
      bestCost = cost
      best = id
    }
  }
  return best
}

/**
 * Profitability floor for starting a Nowa Era (M6.1): the bot performs the GREAT RESET
 * only once doing so RIGHT NOW would bank at least this many era points — enough for a
 * meaningful era purchase (a couple of baseCost-1 root levels). EP is far rarer than PP
 * (the EP yield is a CUBE root of the prestige-account score, where PP uses a square
 * root), so this threshold paces the era loop the way {@link ASCEND_MIN_PP} paces
 * ascensions: a just-reset era wipes the prestige account, so {@link pendingEraPoints}
 * collapses to 0 and the bot must rebuild — and re-ascend — the prestige account before it
 * can ever start another era. There is no degenerate "Nowa Era for nothing" cycle.
 */
export const ERA_MIN_EP = 3

/**
 * Hard cap on eras the bot starts in one harness run (M6.1), mirroring
 * {@link BOT_MAX_ASCENSIONS}. Each Nowa Era is itself a (greater) reset, so an unbounded
 * loop would never terminate the headless sim; this bounds it while still proving the
 * mechanic REPEATS deterministically (>= 1 with headroom). The {@link ERA_MIN_EP}
 * threshold already paces them; this is the belt-and-suspenders runtime guard.
 */
export const BOT_MAX_ERAS = 2

/**
 * NOWA ERA decision (M6.1): true when the bot should perform the great reset for era points
 * THIS step. Gated on (a) the era cap {@link BOT_MAX_ERAS} (so the resetting loop always
 * terminates) and (b) the {@link ERA_MIN_EP} profitability floor on {@link pendingEraPoints}
 * (so a reset always banks a worthwhile, spendable amount — and so a just-reset era, whose
 * prestige account is wiped to a 0 score, can never immediately re-fire). A pure function of
 * `state`, so two identical runs start eras at the same ticks — the determinism / save-load
 * invariants hold across the reset. `maxEras` is overridable for tests.
 */
export function chooseEra(state: GameState, maxEras: number = BOT_MAX_ERAS): boolean {
  if (state.era.eras >= maxEras) return false
  return pendingEraPoints(state) >= ERA_MIN_EP
}

/**
 * Profitability floor for founding a Nowa Dynastia (M6.2): the bot performs the GREAT-GREAT
 * RESET only once doing so RIGHT NOW would bank at least this many dynasty points — enough for
 * a meaningful dynasty purchase (a couple of baseCost-1 root levels). DP is rarer still than EP
 * (the DP yield is a CUBE root of the ERA-account score, exactly as the EP yield is a cube root
 * of the PRESTIGE-account score), so this threshold paces the dynasty loop the way
 * {@link ERA_MIN_EP} paces eras: a just-founded dynasty wipes the ENTIRE era account, so
 * {@link pendingDynastyPoints} collapses to 0 and the bot must rebuild — and re-era — the era
 * account before it could ever found another dynasty. There is no degenerate "Nowa Dynastia for
 * nothing" cycle. A single era (eras=1 alone scores DYN_ERA_WEIGHT=10 → cbrt ≈ 2) already clears
 * it, so the dynasty fires shortly after the era run banks its first era.
 */
export const DYN_MIN_DP = 2

/**
 * Hard cap on dynasties the bot founds in one harness run (M6.2), mirroring
 * {@link BOT_MAX_ERAS}. Each Nowa Dynastia is itself a (greatest) reset, so an unbounded loop
 * would never terminate the headless sim; this bounds it while still proving the mechanic is
 * reachable (>= 1). The {@link DYN_MIN_DP} threshold already paces it; this is the
 * belt-and-suspenders runtime guard.
 */
export const BOT_MAX_DYNASTIES = 1

/**
 * NOWA DYNASTIA decision (M6.2): true when the bot should perform the great-great reset for
 * dynasty points THIS step. Gated on (a) the dynasty cap {@link BOT_MAX_DYNASTIES} (so the
 * resetting loop always terminates) and (b) the {@link DYN_MIN_DP} profitability floor on
 * {@link pendingDynastyPoints} (so a reset always banks a worthwhile, spendable amount — and so a
 * just-founded dynasty, whose era account is wiped to a 0 score, can never immediately re-fire).
 * A pure function of `state`, so two identical runs found dynasties at the same ticks — the
 * determinism / save-load invariants hold across the reset. `maxDynasties` is overridable for tests.
 */
export function chooseDynasty(state: GameState, maxDynasties: number = BOT_MAX_DYNASTIES): boolean {
  if (state.dynasty.dynasties >= maxDynasties) return false
  return pendingDynastyPoints(state) >= DYN_MIN_DP
}
