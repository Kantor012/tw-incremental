import {
  createInitialState,
  recomputeDerived,
  INITIAL_UNITS,
  RESOURCE_IDS,
  EVENT_TTL,
  type GameState,
  type BattleReport,
} from '../src/engine/state'
import { D } from '../src/engine/decimal'
import { simulate } from '../src/engine/tick'
import { serialize, exportSave, importSave } from '../src/engine/save'
import { build } from '../src/systems/buildings'
import { BUILDING_IDS, BUILDINGS } from '../src/content/buildings'
import { recruit, canRecruit, freePopulation } from '../src/systems/recruitment'
import { sendAttack, stationedUnits } from '../src/systems/marches'
import { foundVillage, findFoundingSpot } from '../src/systems/villages'
import { sendShipment, exchangeResources } from '../src/systems/market'
import { claimEvent } from '../src/systems/events'
import { WORLD_EVENTS, WORLD_EVENTS_BY_ID, type BuffEvent } from '../src/content/events'
import { purchaseTech } from '../src/systems/tech'
import { TECH_NODES, TECH_NODE_IDS } from '../src/content/tech'
import { fortressTarget } from '../src/content/fortresses'
import { barbarianTarget } from '../src/content/barbarians'
import { UNIT_IDS, UNITS } from '../src/content/units'
import {
  armyAttackPower,
  armyDefensePower,
  ramDefenseFactor,
  battleOutcome,
  applyLosses,
  armyCarry,
  WORST_LUCK,
} from '../src/systems/combat'
import { canUpgrade, upgradeUnit } from '../src/systems/forge'
import { isUpgradeable } from '../src/content/forge'
import {
  effectiveMods,
  ascend,
  purchasePrestige,
  startResourceBonus,
  prestigeNodeLevel,
  pendingPrestigePoints,
} from '../src/systems/prestige'
import { PRESTIGE_NODE_IDS } from '../src/content/prestige'
import { newEra, purchaseEra, canPurchaseEra, eraNodeLevel, pendingEraPoints } from '../src/systems/era'
import { ERA_NODES, ERA_NODE_IDS } from '../src/content/era'
import {
  newDynasty,
  purchaseDynasty,
  canPurchaseDynasty,
  dynastyNodeLevel,
} from '../src/systems/dynasty'
import { DYNASTY_NODES, DYNASTY_NODE_IDS } from '../src/content/dynasty'
import { startChallenge } from '../src/systems/challenges'
import { CHALLENGES, CHALLENGE_IDS } from '../src/content/challenges'
import type { UnitId } from '../src/content/units'
import { TARGETS } from './targets'
import {
  runInvariants,
  checkArmyConsistency,
  checkWorldConsistency,
  checkVillagePlacement,
  checkLoyalty,
  checkRoundTrip,
  checkNoSoftlock,
  checkOfflineDeterminism,
  checkMarchesTerminate,
  checkWallMitigation,
  checkScoutReveals,
  checkM52Determinism,
  checkRamCracks,
  checkCatapultRazes,
  checkM53Determinism,
  checkFortressConsistency,
  checkFortressDeterminism,
  checkFortressSaveLoad,
  checkFortressRazeOnce,
  checkHordeEscalation,
  checkHordeBreachNoSoftlock,
  checkHordeSaveLoad,
  checkHordeDeterminism,
  checkMetaResetClearsHorde,
  checkTechTree,
  checkTechState,
  checkPrestigeTree,
  checkPrestigeState,
  checkAscendValid,
  checkStats,
  checkAchievementsValid,
  checkStatsAccumulated,
  checkAchievementsUnlocked,
  checkM54Determinism,
  checkLuckDistribution,
  checkLuckVaries,
  checkAutoAttackLuckSafe,
  checkLuckDeterminism,
  contentConsumed,
  totalResources,
  seedAutomation,
  checkAutomationDeterminism,
  checkEraTree,
  checkEraRoundTrip,
  checkNewEraDeterminism,
  checkEraNoSoftlock,
  checkDynastyTopology,
  checkDynastyRoundTrip,
  checkDynastyNoSoftlock,
  checkChallengeDeterminism,
  checkChallengeConstraint,
  checkChallengeCompletionOnce,
  checkChallengeRewardFolds,
  checkChallengeRewardStacks,
  checkChallengeNoSoftlock,
  checkChallengeRoundTrip,
  checkMarketCapacity,
  checkMarketConservation,
  checkMarketDeterminism,
  checkMarketNoSoftlock,
  checkMarketSaveLoad,
  checkCavalryGated,
  checkCavalryInert,
  checkCavalryUpkeep,
  checkCavalrySaveLoad,
  checkExchangeLoses,
  checkExchangeGated,
  checkExchangeDeterminism,
  checkExchangeInert,
  checkEventsInert,
  checkEventsDeterminism,
  checkEventsSaveLoad,
  checkBuffApplies,
  checkBuffExpiresReverts,
  checkBuffDeterminism,
  checkBuffInert,
  checkForgeInert,
  checkUpgradeApplies,
  checkUpgradeDeterminism,
  checkUpgradeSaveLoad,
  checkForgeResetsOnAscend,
  type InvariantResult,
} from './invariants'
import {
  chooseAction,
  chooseFounding,
  chooseConquest,
  chooseFortressAssault,
  chooseTech,
  chooseAscend,
  choosePrestige,
  chooseEra,
  chooseDynasty,
} from './bot'
import {
  collect,
  emptyCombatStats,
  newBattleReports,
  applyReport,
  totalProduction,
  type CombatStats,
  type RunMetrics,
  type RunStats,
  type PrestigeRunStats,
  type EraRunStats,
  type DynastyRunStats,
  type ChallengeRunStats,
  type MarketRunStats,
  type CavalryRunStats,
  type AutomationRunStats,
} from './metrics'

/**
 * Headless simulation runner. Drives the same `simulate` step the browser loop
 * uses, lets the bot spend greedily, samples invariants periodically, and proves
 * save/load continuation and determinism. Node-safe end to end.
 */
export interface RunResult {
  metrics: RunMetrics
  invariants: InvariantResult[]
  ok: boolean
}

/** How often (in steps) to sample the in-flight invariants. */
const SAMPLE_EVERY = 1000

/** Span (game-seconds) used by the offline-vs-online determinism check. */
const OFFLINE_CHECK_SECONDS = 3600

/**
 * Upper bound on actions (build OR recruit) the bot takes in a single step. The
 * greedy loop already stops as soon as nothing is affordable / available; this cap
 * just bounds the work per step when a windfall (e.g. after a long idle stretch)
 * would otherwise let the bot take a long run of actions at once. A recruit action
 * trains a whole batch, so one action can still mint many units.
 */
const MAX_ACTIONS_PER_STEP = 8

/**
 * Consult the tech decision (and its per-node Decimal cost scan) only every N steps. The
 * passive tree is a SLOW sink — the surplus it spends accumulates over many ticks — so a
 * once-per-N cadence still buys the whole tree well within the budget (measured: every
 * node maxed) while keeping the costly {@link chooseTech} scan (a Decimal `pow` per
 * available node) off the hot per-tick path. Deterministic: gated on the absolute step
 * index, identical across the continuous / split / repeat runs, so the determinism and
 * save-load-continuation invariants are unaffected.
 */
const TECH_DECIDE_EVERY = 8

/**
 * Step budget for the SEPARATE prestige (ascension) run (M4.1). Kept far shorter than the
 * main budget on purpose: the prestige run only needs to drive the bot to its
 * {@link import('./bot').BOT_MAX_ASCENSIONS} ascensions and buy the resulting points, which
 * the sim measures completing well inside this window (every seed reaches all ascensions by
 * tick ~4600). Short because (a) the resetting loop self-limits via the ascension cap, and
 * (b) keeping it small bounds the harness runtime — three passes of this per seed
 * (continuous + determinism repeat + split-with-save) is a small add over the main run.
 */
const PRESTIGE_TICKS = 6000

/**
 * Step budget for the SEPARATE era (great-reset) run (M6.1). Longer than {@link PRESTIGE_TICKS}
 * because each era is a SECOND-order reset: the bot must drive the prestige loop (several
 * ascensions) until the prestige account scores enough that the CUBE-root EP yield clears the era
 * floor, perform a Nowa Era — which WIPES the prestige account back to a 0 score — then rebuild and
 * do it again, up to {@link import('./bot').BOT_MAX_ERAS}. The sim measures both eras landing well
 * inside this window (the first era around tick ~3-4k, the second by ~7-8k); the surplus headroom
 * keeps the run robust to seed variation. Bounded by the era + ascension caps, so the loop always
 * terminates regardless of the budget.
 */
const ERA_TICKS = 12000

/**
 * Step budget for the SEPARATE dynasty (great-great-reset) run (M6.2). Longer than {@link ERA_TICKS}
 * because each dynasty is a THIRD-order reset: the bot must drive the prestige loop (several
 * ascensions) AND the era loop (at least one Nowa Era) until the era account scores enough that the
 * CUBE-root DP yield clears the dynasty floor, then found a Nowa Dynastia — which WIPES the era AND
 * prestige accounts back to a 0 score. A SINGLE era already scores DYN_ERA_WEIGHT=10 (cbrt ≈ 2 ≥
 * {@link import('./bot').DYN_MIN_DP}), so the dynasty fires the same step the first era lands (the era
 * sim measures that around tick ~3-4k); the generous headroom both keeps the run robust to seed
 * variation AND puts the half-mark (used by {@link runDynastySplit}) comfortably PAST the first
 * dynasty so the save/load continuation actually crosses the great-great reset. Bounded by the
 * dynasty + era + ascension caps, so the loop always terminates regardless of the budget.
 */
const DYNASTY_TICKS = 16000

/**
 * Step budget for the SEPARATE M7 fortress (boss-target) run. Sized so a maxed capital can train its
 * all-in siege strike force (the full ram train, then axemen up to the popCap — sequential training on
 * the recruit queue) AND march it to the nearest far-ring fortress and back, with headroom. The run is
 * a single pass (no determinism/split replays — it measures bot REACHABILITY, not save fidelity, which
 * {@link checkFortressRazeOnce} / {@link checkFortressSaveLoad} already pin), so the budget is a small
 * add over the main run.
 */
const FORTRESS_TICKS = 16000

/**
 * Step budget for the SEPARATE M8 challenge (WYZWANIA) run. The run STARTS a challenge whose goal is
 * reachable under its constraint (a PRODUCTION goal, untouched by the attack/defense/pop penalties),
 * then drives the bot's normal economy until {@link import('../src/systems/challenges').checkChallengeCompletion}
 * fires. A modest production threshold (the catalogue floor) is cleared by the building/tech economy
 * well inside this window — comparable to the prestige run, where the bot rebuilds a worthwhile economy
 * from a fresh capital several times over {@link PRESTIGE_TICKS}; here it builds ONE constrained economy
 * past the goal. Generous headroom keeps the run robust to seed variation, and the run STOPS the moment
 * the goal lands (single pass, no determinism/split replays — the dedicated checks pin those), so the
 * budget bounds the worst case rather than the common one.
 */
const CHALLENGE_TICKS = 12000

/** Full ram train the fortress run holds — {@link ramDefenseFactor} floors the wall at 30 Tarany. */
const FORTRESS_DRIVE_RAMS = 30

/**
 * Loss budget the fortress driver assaults within (mirrors the bot's MAX_FORTRESS_LOSS): it waits until
 * its all-in stack wins at WORST luck losing no more than this fraction, so > 40% survive to haul the
 * one-time cache home — and so the win has real margin (a thin win is fragile to any future drift in the
 * economy / fortress curves) rather than razing on a 99.7%-casualty coin-flip.
 */
const FORTRESS_DRIVE_MAX_LOSS = 0.5

/**
 * Span (game-seconds) of the SEPARATE M5.1 automation coverage run. One hour is long enough
 * for every idle routine to demonstrably fire (auto-build buys on the first sub-step,
 * auto-recruit completes axemen within ~100s each, auto-attack reaches the nearby tier-1
 * camps in ~110s round-trip and resolves repeatedly) yet stays well inside
 * {@link import('../src/engine/offline').MAX_OFFLINE_SECONDS} so the offline-parity branch
 * credits the whole span. Matches the offline-determinism check's hour for symmetry.
 */
const AUTOMATION_SECONDS = 3600

/**
 * Chunk size (game-seconds) the coverage run advances per observation. simulate() decomposes
 * any span onto the same fixed TICK_RATE grid, so the chunk size never changes the result
 * (the automation-determinism check proves chunked == one-big-step) — it only sets how often
 * the run samples progress / invariants. 60s keeps the recruit-completion and attack-report
 * deltas fine-grained while staying cheap (60 chunks over the hour).
 */
const AUTOMATION_CHUNK = 60

/** Sample the hard invariants every N chunks of the coverage run (plus once at the end). */
const AUTOMATION_SAMPLE_EVERY_CHUNKS = 10

/** What one {@link step} did: building upgrades bought, units ordered, attacks sent, villages founded, tech levels bought. */
interface StepResult {
  built: number
  recruited: number
  attacked: number
  founded: number
  tech: number
}

/** Prefix invariant names with the phase that produced them, for the report. */
function tag(results: InvariantResult[], phase: string): InvariantResult[] {
  return results.map((r) => ({ ...r, name: `${phase}:${r.name}` }))
}

/** A fresh zeroed per-unit counter (reuses INITIAL_UNITS, all 0). */
function emptyUnitCounts(): Record<UnitId, number> {
  return { ...INITIAL_UNITS }
}

/**
 * One simulation step: the bot acts greedily (build or recruit, repeatedly, up to
 * {@link MAX_ACTIONS_PER_STEP}) BEFORE time advances — matching a player who acts
 * at the top of a tick — then `simulate` accrues production and advances training.
 * Ordered units are accumulated per type into `recruited`; the count of builds and
 * the count of ordered units are returned so callers can track progress.
 *
 * Since M2.1 the bot drives the FIRST village (`state.villages[state.villageOrder[0]]`):
 * build / recruit / sendAttack all operate on that one village's economy, and the
 * global battle log (`state.battleLog`) is threaded into sendAttack. `simulate` then
 * advances EVERY village on the fixed grid (see tick.ts). With the single M2.1
 * village this reproduces the old single-village run exactly.
 */
function step(
  state: GameState,
  dt: number,
  recruited: Record<UnitId, number>,
  tick: number,
): StepResult {
  let built = 0
  let rec = 0
  let attacked = 0
  let founded = 0
  let tech = 0
  let actions = 0
  const v = state.villages[state.villageOrder[0]]

  // M3.2/M4.1: roll up the account-wide EFFECTIVE bonuses ONCE for this step and thread the
  // SAME bag into every live mutation (build cost / recruit time / march power-loot-speed)
  // AND into the bot's matching decision (chooseAction). effectiveMods folds the tech ledger
  // WITH the permanent prestige tree, exactly as the engine's tick does (tick.ts subStep) —
  // so a build re-derives the capital with prestige's production multiplier instead of
  // stripping it back to tech-only. For a prestige-empty state effectiveMods === the tech
  // bag byte-for-byte (combine with the identity prestige bag is exact), so the M1–M3 runs
  // are unchanged; the prestige run gets the correct combined economy. state.tech /
  // state.prestige.nodes only change at the END of the step (purchaseTech below; ascend /
  // purchasePrestige happen in the prestige driver), so this step's actions use the
  // pre-purchase bonuses and simulate() re-derives afterward. Pure function of state →
  // deterministic, identical across the continuous / split / repeat runs.
  const mods = effectiveMods(state)

  // M2.4 conquest pipeline FIRST, so the noble strike force gets first claim on the
  // reserved population and on resources before the per-village economy spends them.
  // One conquest move per step (train a noble OR march the force in); self-limited and
  // pure, so determinism / save-load continuation hold. Capital-scoped, like the loop.
  // chooseConquest derives its own (identical) mods to project power; the live recruit /
  // sendAttack here are charged with this step's `mods`.
  const conquest = chooseConquest(state)
  if (conquest !== null) {
    if (conquest.kind === 'recruit') {
      if (recruit(v, conquest.unitId, conquest.count, mods)) {
        recruited[conquest.unitId] += conquest.count
        rec += conquest.count
      }
    } else if (sendAttack(v, state.world, state.battleLog, conquest.targetId, conquest.units, mods)) {
      attacked++
    }
  }

  // M7 fortress pipeline, consulted AFTER conquest but BEFORE the per-village economy so the
  // siege strike force gets first claim on the combat surplus (before camp raids drain it).
  // One fortress move per step (train a Taran OR assault the nearest beatable un-razed fortress
  // via sendAttack(…, 'fortress')); self-limited and pure, so determinism / save-load continuation
  // hold. Capital-scoped, like the loop. chooseFortressAssault derives its own (identical) mods to
  // project power; the live recruit / sendAttack here are charged with this step's `mods`.
  const fortress = chooseFortressAssault(state)
  if (fortress !== null) {
    if (fortress.kind === 'recruit') {
      if (recruit(v, fortress.unitId, fortress.count, mods)) {
        recruited[fortress.unitId] += fortress.count
        rec += fortress.count
      }
    } else if (
      sendAttack(v, state.world, state.battleLog, fortress.fortressId, fortress.units, mods, 'fortress')
    ) {
      attacked++
    }
  }

  while (actions < MAX_ACTIONS_PER_STEP) {
    const action = chooseAction(v, state.world, mods)
    if (action === null) break
    if (action.kind === 'build') {
      // build(v, id, mods): charged the tech-discounted cost AND re-derives the capital
      // with the same mods, so its fresh level reflects the tree immediately (no separate
      // re-fold needed — see below).
      if (!build(v, action.id, mods)) break
      built++
    } else if (action.kind === 'recruit') {
      if (!recruit(v, action.unitId, action.count, mods)) break
      recruited[action.unitId] += action.count
      rec += action.count
    } else if (action.kind === 'attack') {
      // attack: dispatch the home army at a CONCRETE barbarian village on the world
      // map (loot source + unit sink); travel time is the Euclidean distance to it.
      // mods carry the march-speed / attack / loot bonuses into resolution.
      if (!sendAttack(v, state.world, state.battleLog, action.targetId, action.units, mods)) break
      attacked++
    } else {
      // 'found' is never emitted by chooseAction (it is a per-village decision); the
      // expansion move is handled once after the loop via chooseFounding below.
      break
    }
    actions++
  }

  // M2.3 expansion: AFTER the per-village loop, so founding only spends what the
  // economy/army loop left idle (chooseFounding gates on idle resource sinks). At most
  // one new village per step — a paced, deterministic outward expansion from the capital.
  const found = chooseFounding(state)
  if (found !== null && foundVillage(state, state.villageOrder[0], found.x, found.y) !== null) {
    founded++
  }

  // M3.1 global passive tree, consulted LAST so it spends only the surplus the
  // per-village economy, founding and conquest left idle (chooseTech gates on a global
  // reserve; the greedy spend in purchaseTech draws across villages and re-derives them).
  const techId = tick % TECH_DECIDE_EVERY === 0 ? chooseTech(state) : null
  const purchased = techId !== null && purchaseTech(state, techId)
  if (purchased) tech++

  // M3.2: no separate tech re-fold is needed before time advances. Every mutation that
  // can change a village's derived stats already folds the current mods: build(v, id, mods)
  // re-derives the capital with the tree bonus, and foundVillage / applyConquest /
  // purchaseTech each recomputeDerived(state) for ALL villages. recruit / sendAttack don't
  // touch production/storage/population, so they need no recompute. The capital therefore
  // always enters simulate() with the correct tech-folded economy — and the costly
  // whole-empire roll-up stays off the common no-purchase step.
  simulate(state, dt)
  return { built, recruited: rec, attacked, founded, tech }
}

/** What a continuous run yields: the final state, sampled invariants, counters. */
interface ContinuousRun {
  state: GameState
  invariants: InvariantResult[]
  stats: RunStats
}

/**
 * Run a fresh state forward for `ticks` steps. When `withInvariants` is set,
 * samples the hard invariants every SAMPLE_EVERY steps plus once at the end, and
 * tracks per-window progress for the no-plateau metric. Always returns the
 * upgrade counters so callers can build metrics.
 */
function runContinuous(
  seed: string,
  ticks: number,
  dt: number,
  withInvariants: boolean,
): ContinuousRun {
  const state = createInitialState(seed, 0)
  const invariants: InvariantResult[] = []
  // `prevTotal` anchors the per-window progress check; `initialTotal` anchors the
  // final, run-wide check so it stays meaningful even when `ticks` lands exactly
  // on a sample boundary (no tail window).
  const initialTotal = totalResources(state)
  let prevTotal = initialTotal

  let upgradesBought = 0
  let totalRecruited = 0
  let villagesFounded = 0
  let techPurchases = 0
  const unitsRecruited = emptyUnitCounts()
  // Progress actions (builds + recruits + attacks) since the last sample — a window
  // with any action counts as progress even if the spend left the resource sum lower.
  let actedInWindow = 0
  let windowsWithProgress = 0
  let windowCount = 0
  let contentFrontierTick: number | null = null

  // Cumulative combat tally, folded from the rolling battle log each step. The log is
  // trimmed to 20 entries, so we snapshot it before each step and diff afterwards
  // ({@link newBattleReports}) to never miss a resolved battle / raid over a long run.
  const combat: CombatStats = emptyCombatStats()
  let prevLog: BattleReport[] = state.battleLog.slice()

  for (let i = 0; i < ticks; i++) {
    const { built, recruited, attacked, founded, tech } = step(state, dt, unitsRecruited, i)
    upgradesBought += built
    totalRecruited += recruited
    villagesFounded += founded
    techPurchases += tech
    actedInWindow += built + recruited + attacked + founded + tech
    combat.attacksSent += attacked

    // Fold any battle / raid reports the step produced into the running tally.
    for (const report of newBattleReports(prevLog, state.battleLog)) applyReport(combat, report)
    prevLog = state.battleLog.slice()

    if (withInvariants && (i + 1) % SAMPLE_EVERY === 0) {
      const phase = `t${i + 1}`
      const grew = totalResources(state).gt(prevTotal)
      invariants.push(...tag(runInvariants(state), phase))
      invariants.push(...tag([checkArmyConsistency(state)], phase))
      invariants.push(...tag([checkWorldConsistency(state)], phase))
      invariants.push(...tag([checkFortressConsistency(state)], phase))
      invariants.push(...tag([checkVillagePlacement(state)], phase))
      invariants.push(...tag([checkLoyalty(state)], phase))
      invariants.push(...tag([checkTechState(state)], phase))
      invariants.push(...tag([checkRoundTrip(state)], phase))
      // M5.4: the lifetime counters stay well-formed and the unlock set stays settled
      // (every satisfied condition stamped) at every sample, not just at the end.
      invariants.push(...tag([checkStats(state)], phase))
      invariants.push(...tag([checkAchievementsValid(state)], phase))
      invariants.push(...tag([checkNoSoftlock(state, prevTotal, actedInWindow > 0)], phase))

      windowCount += 1
      if (grew || actedInWindow > 0) windowsWithProgress += 1

      // Record the first sampled tick at which the M1.2 content frontier holds.
      if (contentFrontierTick === null && contentConsumed(state)) contentFrontierTick = i + 1

      prevTotal = totalResources(state)
      actedInWindow = 0
    }
  }

  if (withInvariants) {
    invariants.push(...tag(runInvariants(state), 'final'))
    invariants.push(...tag([checkArmyConsistency(state)], 'final'))
    invariants.push(...tag([checkWorldConsistency(state)], 'final'))
    invariants.push(...tag([checkFortressConsistency(state)], 'final'))
    invariants.push(...tag([checkVillagePlacement(state)], 'final'))
    invariants.push(...tag([checkLoyalty(state)], 'final'))
    invariants.push(...tag([checkTechState(state)], 'final'))
    invariants.push(...tag([checkRoundTrip(state)], 'final'))
    invariants.push(...tag([checkStats(state)], 'final'))
    invariants.push(...tag([checkAchievementsValid(state)], 'final'))
    // Whole-run progress: any action ever taken, or resources above the start.
    invariants.push(
      ...tag([checkNoSoftlock(state, initialTotal, upgradesBought + totalRecruited > 0)], 'final'),
    )
    // Catch a frontier reached after the last sample boundary (e.g. at the very end).
    if (contentFrontierTick === null && contentConsumed(state)) contentFrontierTick = ticks
  }

  return {
    state,
    invariants,
    stats: {
      upgradesBought,
      villagesFounded,
      windowsWithProgress,
      windowCount,
      unitsRecruited,
      contentFrontierTick,
      combat,
      techPurchases,
    },
  }
}

/**
 * Run to the halfway point, persist via the real export/import (base64) path,
 * then continue to `ticks`. The total step count matches a continuous run
 * regardless of parity, so any divergence is a save/load fault.
 */
function runSplit(seed: string, ticks: number, dt: number): GameState {
  const half = Math.floor(ticks / 2)
  // Recruitment counters are irrelevant here (this run only proves save/load
  // continuation), so a single scratch accumulator is reused and discarded.
  const scratch = emptyUnitCounts()
  let state = createInitialState(seed, 0)
  for (let i = 0; i < half; i++) step(state, dt, scratch, i)
  state = importSave(exportSave(state))
  for (let i = half; i < ticks; i++) step(state, dt, scratch, i)
  return state
}

// --- M4.1 prestige (ascension) run ------------------------------------------------------
//
// A SEPARATE run from the economy/combat/tech/expansion measurement above. It must stay
// separate because ascend() RESETS the run (villages -> one capital, tech {}, world
// regenerated, battle log cleared) — folding it into the primary run would zero out the
// cumulative M1–M3 progression the existing targets measure. Here the bot plays normally
// via the same {@link step}, then once a reset would bank a worthwhile amount it ASCENDS
// and spends the points on the prestige tree, repeating up to the ascension cap. The
// PERMANENT prestige account (points / totals / node levels) survives every reset, so the
// bonuses compound — which is exactly what {@link checkAscendValid} / {@link checkPrestigeState}
// and the prestige balance targets verify.

/**
 * The prestige loop for ONE step's worth of decision, AFTER {@link step} has advanced the
 * economy/combat: if {@link chooseAscend} says it's worthwhile, ascend (banking the pending
 * points and resetting the run) then spend the banked points greedily on the prestige tree
 * via {@link choosePrestige} until nothing affordable remains. Returns the number of
 * prestige-node levels bought this step (0 when no ascension happened). Pure-ish — it only
 * mutates `state` through the engine's own {@link ascend} / {@link purchasePrestige}, so two
 * identical runs ascend and buy identically (the determinism / save-load invariants hold).
 */
function prestigeDrive(state: GameState): { ascended: boolean; purchases: number } {
  if (!chooseAscend(state)) return { ascended: false, purchases: 0 }
  ascend(state)
  let purchases = 0
  let id: string | null
  while ((id = choosePrestige(state)) !== null) {
    if (!purchasePrestige(state, id)) break
    purchases += 1
  }
  return { ascended: true, purchases }
}

/** What a prestige run yields: the final state, sampled invariants, and the prestige tally. */
interface PrestigeRun {
  state: GameState
  invariants: InvariantResult[]
  stats: PrestigeRunStats
}

/**
 * Run a fresh state forward for `ticks` steps WITH the prestige loop active. Each step
 * plays normally ({@link step}) then consults {@link prestigeDrive}; after every ascension,
 * when `withInvariants`, the post-reset state is asserted valid and playable (resource /
 * army / world / placement / loyalty / tech-state / prestige-state / round-trip /
 * no-softlock / ascend-valid). At the end the surviving prestige nodes are re-derived onto a
 * fresh capital to MEASURE the permanent bonus (production uplift + start-resource head-start)
 * — the proof that an ascension makes every future run stronger.
 */
function runPrestige(seed: string, ticks: number, dt: number, withInvariants: boolean): PrestigeRun {
  const state = createInitialState(seed, 0)
  const scratch = emptyUnitCounts()
  const invariants: InvariantResult[] = []
  let purchases = 0
  let firstAscendTick: number | null = null

  for (let i = 0; i < ticks; i++) {
    step(state, dt, scratch, i)
    const { ascended, purchases: bought } = prestigeDrive(state)
    if (!ascended) continue
    purchases += bought
    if (firstAscendTick === null) firstAscendTick = i

    if (withInvariants) {
      // Assert the RESET ITSELF left a valid, playable single-capital state. We do NOT sample
      // no-softlock at this instant: a just-reset capital has accrued nothing this tick, and
      // checkNoSoftlock deliberately ignores the production signal, so a fresh 0-resource
      // capital would read as a (false) stall even though the very next tick accrues and
      // unlocks an action — a post-ascend capital is structurally a fresh createInitialState
      // start, which runContinuous already proves playable. checkAscendValid covers the
      // structural post-reset playability (world non-empty, ledger consistent, finite
      // non-negative resources); the run REACHING the next ascension proves it progresses,
      // and a whole-run no-softlock is asserted at pfinal below.
      const phase = `asc${state.prestige.ascensions}`
      invariants.push(...tag(runInvariants(state), phase))
      invariants.push(...tag([checkArmyConsistency(state)], phase))
      invariants.push(...tag([checkWorldConsistency(state)], phase))
      invariants.push(...tag([checkVillagePlacement(state)], phase))
      invariants.push(...tag([checkLoyalty(state)], phase))
      invariants.push(...tag([checkTechState(state)], phase))
      invariants.push(...tag([checkPrestigeState(state)], phase))
      invariants.push(...tag([checkAscendValid(state)], phase))
      invariants.push(...tag([checkRoundTrip(state)], phase))
    }
  }

  if (withInvariants) {
    invariants.push(...tag(runInvariants(state), 'pfinal'))
    invariants.push(...tag([checkArmyConsistency(state)], 'pfinal'))
    invariants.push(...tag([checkWorldConsistency(state)], 'pfinal'))
    invariants.push(...tag([checkPrestigeState(state)], 'pfinal'))
    invariants.push(...tag([checkRoundTrip(state)], 'pfinal'))
    // M5.4: lifetime stats survive every ascension (ascend leaves them untouched) and the
    // unlock set is well-formed/settled on a heavily-ascended state (prestige achievements fire).
    invariants.push(...tag([checkStats(state)], 'pfinal'))
    invariants.push(...tag([checkAchievementsValid(state)], 'pfinal'))
    // Whole-run no-softlock (mirrors runContinuous's final check): the prestige run made
    // progress iff it ascended / bought at least once, so the run never stalled overall.
    invariants.push(
      ...tag([checkNoSoftlock(state, totalResources(state), purchases > 0 || firstAscendTick !== null)], 'pfinal'),
    )
  }

  // Bonus confirmation: re-derive the surviving prestige nodes onto a fresh capital and
  // compare production to a no-prestige fresh capital. > 1 proves the permanent prestige
  // multipliers fold into the economy (recomputeDerived). startResourceBonus is the other,
  // additive prestige-only kind. Both are pure of the final prestige ledger.
  const base = createInitialState(seed, 0)
  const baseProd = totalProduction(base)
  const boosted = createInitialState(seed, 0)
  boosted.prestige.nodes = { ...state.prestige.nodes }
  recomputeDerived(boosted)
  const boostedProd = totalProduction(boosted)
  const productionMult = baseProd.gt(0) ? boostedProd.div(baseProd).toNumber() : 1

  let nodesOwned = 0
  let levelsOwned = 0
  for (const id of PRESTIGE_NODE_IDS) {
    const lvl = prestigeNodeLevel(state, id)
    if (lvl > 0) {
      nodesOwned += 1
      levelsOwned += lvl
    }
  }

  return {
    state,
    invariants,
    stats: {
      ascensions: state.prestige.ascensions,
      firstAscendTick,
      pointsBanked: state.prestige.points,
      totalEarned: state.prestige.totalEarned,
      purchases,
      nodesOwned,
      levelsOwned,
      productionMult,
      startResourceBonus: startResourceBonus(state),
    },
  }
}

/**
 * Prestige run to the halfway point, persisted via the real export/import (base64) path —
 * crossing at least one ascension (the first lands well before the half mark) — then
 * continued. The total step count matches the continuous prestige run, so any divergence
 * is a save/load fault: this is the proof the PERMANENT prestige account (banked points +
 * purchased node levels) survives a save/load byte-identically (prestige is in the v9 save).
 */
function runPrestigeSplit(seed: string, ticks: number, dt: number): GameState {
  const half = Math.floor(ticks / 2)
  const scratch = emptyUnitCounts()
  let state = createInitialState(seed, 0)
  for (let i = 0; i < half; i++) {
    step(state, dt, scratch, i)
    prestigeDrive(state)
  }
  state = importSave(exportSave(state))
  for (let i = half; i < ticks; i++) {
    step(state, dt, scratch, i)
    prestigeDrive(state)
  }
  return state
}

// --- M6.1 era (great reset / second meta-layer) run -------------------------------------------
//
// A SEPARATE run from every measurement above, mirroring the prestige run's rationale: newEra
// performs the GREAT RESET — it WIPES the ENTIRE prestige account (PP, prestige nodes, ascensions)
// and resets the run to one fresh capital, banking permanent ERA POINTS (EP). Folding it into the
// primary or prestige run would zero out the cumulative progression those targets measure. Here the
// bot plays normally via the same {@link step}, ascends via {@link prestigeDrive} so the prestige
// account ACCUMULATES, and once that account scores enough that the cube-root EP yield clears the era
// floor it starts a Nowa Era ({@link eraDrive}) and spends the banked EP on the era tree — repeating
// up to the era cap. The PERMANENT era account (EP / totals / era count / node levels) survives every
// reset, AND its multipliers fold into every future run (effectiveMods) — exactly what
// {@link checkEraTree} / {@link checkEraRoundTrip} and the era balance targets verify.

/**
 * The era loop for ONE step's worth of decision, AFTER {@link step} + {@link prestigeDrive} have
 * advanced the economy and banked prestige progress: if {@link chooseEra} says it's worthwhile,
 * perform the great reset ({@link newEra}, banking the pending EP and wiping the prestige account)
 * then spend the banked EP greedily on the era tree — buying each node in {@link ERA_NODE_IDS} order
 * up to its ceiling / the EP on hand ({@link canPurchaseEra} -> {@link purchaseEra}). A source-order
 * forward pass suffices because prerequisites always precede their dependents in ERA_NODE_IDS (append
 * discipline). Returns whether an era started and the number of era-node levels bought this step.
 * Pure-ish — it only mutates `state` through the engine's own newEra / purchaseEra, so two identical
 * runs start eras and buy identically (the determinism / save-load invariants hold across the reset).
 */
function eraDrive(state: GameState): { started: boolean; purchases: number } {
  if (!chooseEra(state)) return { started: false, purchases: 0 }
  newEra(state)
  let purchases = 0
  for (const id of ERA_NODE_IDS) {
    while (canPurchaseEra(state, id).ok) {
      if (!purchaseEra(state, id)) break
      purchases += 1
    }
  }
  return { started: true, purchases }
}

/** What an era run yields: the final state, sampled invariants, and the era tally. */
interface EraRun {
  state: GameState
  invariants: InvariantResult[]
  stats: EraRunStats
}

/**
 * Run a fresh state forward for `ticks` steps WITH BOTH the prestige loop AND the era loop active.
 * Each step plays normally ({@link step}), then {@link prestigeDrive} ascends + buys so the prestige
 * account accumulates, then {@link eraDrive} converts a worthwhile account into a Nowa Era + era
 * buys. After every era reset, when `withInvariants`, the post-reset state is asserted valid and
 * playable (resource / army / world / placement / loyalty / prestige-state — now WIPED but valid —
 * era round-trip / whole-state round-trip). At the end the pp_mult uplift is MEASURED on a fixed
 * prestige score — the proof an era accelerates the prestige loop.
 */
function runEra(seed: string, ticks: number, dt: number, withInvariants: boolean): EraRun {
  const state = createInitialState(seed, 0)
  const scratch = emptyUnitCounts()
  const invariants: InvariantResult[] = []
  let purchases = 0
  let firstEraTick: number | null = null

  for (let i = 0; i < ticks; i++) {
    step(state, dt, scratch, i)
    // Prestige first so the account accumulates, then convert worthwhile progress to an era.
    prestigeDrive(state)
    const { started, purchases: bought } = eraDrive(state)
    if (!started) continue
    purchases += bought
    if (firstEraTick === null) firstEraTick = i

    if (withInvariants) {
      // Assert the RESET ITSELF left a valid, playable single-capital state with a WIPED prestige
      // account and a surviving era account. As in runPrestige we do NOT sample no-softlock at this
      // instant: a just-reset capital has accrued nothing this tick, so checkNoSoftlock (which
      // ignores production) would read a false stall — checkEraNoSoftlock covers post-era playability
      // structurally, and the run REACHING the next era proves it progresses.
      const phase = `era${state.era.eras}`
      invariants.push(...tag(runInvariants(state), phase))
      invariants.push(...tag([checkArmyConsistency(state)], phase))
      invariants.push(...tag([checkWorldConsistency(state)], phase))
      invariants.push(...tag([checkVillagePlacement(state)], phase))
      invariants.push(...tag([checkLoyalty(state)], phase))
      invariants.push(...tag([checkPrestigeState(state)], phase))
      invariants.push(...tag([checkEraRoundTrip(state)], phase))
      invariants.push(...tag([checkRoundTrip(state)], phase))
    }
  }

  if (withInvariants) {
    invariants.push(...tag(runInvariants(state), 'efinal'))
    invariants.push(...tag([checkArmyConsistency(state)], 'efinal'))
    invariants.push(...tag([checkWorldConsistency(state)], 'efinal'))
    invariants.push(...tag([checkPrestigeState(state)], 'efinal'))
    invariants.push(...tag([checkEraRoundTrip(state)], 'efinal'))
    invariants.push(...tag([checkRoundTrip(state)], 'efinal'))
    // Lifetime stats + achievements SURVIVE every era reset (newEra leaves them untouched).
    invariants.push(...tag([checkStats(state)], 'efinal'))
    invariants.push(...tag([checkAchievementsValid(state)], 'efinal'))
    // Whole-run no-softlock (mirrors runPrestige's pfinal): the era run made progress iff it
    // started an era / bought at least once, so the run never stalled overall.
    invariants.push(
      ...tag([checkNoSoftlock(state, totalResources(state), purchases > 0 || firstEraTick !== null)], 'efinal'),
    )
  }

  // eraPpUplift: CONSTRUCTED proof that a pp_mult era node lifts prestige-point gain for a FIXED
  // prestige score — independent of whether the bot's greedy source-order buy reached the pp_mult
  // node this run (EP is rare, so it usually fills the first root first). Take a fresh, fully-built
  // capital (so the score is large enough that the multiplier shows past the floor), measure
  // pendingPrestigePoints with no era nodes, then again with the pp_mult node maxed; the ratio > 1
  // is the proof. Data-driven: finds the pp_mult node rather than hard-coding legacy_root.
  const ppNodeId = ERA_NODE_IDS.find((id) => ERA_NODES[id].effect.kind === 'pp_mult')
  let ppUplift = 1
  if (ppNodeId !== undefined) {
    const probe = createInitialState(seed, 0)
    const cap = probe.villages[probe.villageOrder[0]]
    for (const id of BUILDING_IDS) cap.buildings[id] = BUILDINGS[id].maxLevel
    const before = pendingPrestigePoints(probe)
    probe.era.nodes = { [ppNodeId]: ERA_NODES[ppNodeId].maxLevel }
    const after = pendingPrestigePoints(probe)
    ppUplift = before > 0 ? after / before : 1
  }

  let nodesOwned = 0
  let levelsOwned = 0
  for (const id of ERA_NODE_IDS) {
    const lvl = eraNodeLevel(state, id)
    if (lvl > 0) {
      nodesOwned += 1
      levelsOwned += lvl
    }
  }

  return {
    state,
    invariants,
    stats: {
      eras: state.era.eras,
      purchases,
      nodesOwned,
      levelsOwned,
      ppUplift,
    },
  }
}

/**
 * Era run to the halfway point, persisted via the real export/import (base64) path — crossing at
 * least one Nowa Era (the first lands well before the half mark) — then continued. The total step
 * count matches the continuous era run, so any divergence is a save/load fault. This is the proof
 * the GREAT RESET survives a save/load ACROSS the reset byte-identically — the highest-risk save/load
 * path under CLAUDE.md hard rule #3: newEra regenerates the world + rngState, WIPES the prestige
 * account and banks EP, so a deserialize-then-diverge of the freshly-installed rngState / world would
 * strand the run. The per-era {@link checkEraRoundTrip} / {@link checkRoundTrip} only prove the
 * post-reset SNAPSHOT round-trips byte-identically; only CONTINUING the loaded post-era save (here)
 * proves it then runs identically to the continuous era run. The PERMANENT era account (banked EP +
 * purchased node levels) rides through the v15 save.
 */
function runEraSplit(seed: string, ticks: number, dt: number): GameState {
  const half = Math.floor(ticks / 2)
  const scratch = emptyUnitCounts()
  let state = createInitialState(seed, 0)
  for (let i = 0; i < half; i++) {
    step(state, dt, scratch, i)
    prestigeDrive(state)
    eraDrive(state)
  }
  state = importSave(exportSave(state))
  for (let i = half; i < ticks; i++) {
    step(state, dt, scratch, i)
    prestigeDrive(state)
    eraDrive(state)
  }
  return state
}

// --- M6.2 dynasty (great-great reset / third meta-layer) run ----------------------------------
//
// A SEPARATE run from every measurement above, mirroring the era run's rationale: newDynasty
// performs the GREAT-GREAT RESET — it WIPES the ENTIRE era account (EP, era nodes, eras) AND the
// ENTIRE prestige account (PP, prestige nodes, ascensions) and resets the run to one fresh capital,
// banking permanent DYNASTY POINTS (DP). Folding it into the primary / prestige / era run would zero
// out the cumulative progression those targets measure. Here the bot plays normally via the same
// {@link step}, ascends via {@link prestigeDrive} AND starts eras via {@link eraDrive} so the era
// account ACCUMULATES (eras feed dynastyScore), and once that account scores enough that the
// cube-root DP yield clears the dynasty floor it founds a Nowa Dynastia ({@link dynastyDrive}) and
// spends the banked DP on the dynasty tree — repeating up to the dynasty cap. The PERMANENT dynasty
// account (DP / totals / dynasty count / node levels) survives every reset, AND its multipliers fold
// into every future run (effectiveMods) — exactly what {@link checkDynastyTopology} /
// {@link checkDynastyRoundTrip} and the dynasty balance targets verify.

/**
 * The dynasty loop for ONE step's worth of decision, AFTER {@link step} + {@link prestigeDrive} +
 * {@link eraDrive} have advanced the economy and banked prestige + era progress: if
 * {@link chooseDynasty} says it's worthwhile, perform the great-great reset ({@link newDynasty},
 * banking the pending DP and wiping the era + prestige accounts) then spend the banked DP greedily on
 * the dynasty tree — buying each node in {@link DYNASTY_NODE_IDS} order up to its ceiling / the DP on
 * hand ({@link canPurchaseDynasty} -> {@link purchaseDynasty}). A source-order forward pass suffices
 * because prerequisites always precede their dependents in DYNASTY_NODE_IDS (append discipline).
 * Returns whether a dynasty was founded and the number of dynasty-node levels bought this step.
 * Pure-ish — it only mutates `state` through the engine's own newDynasty / purchaseDynasty, so two
 * identical runs found dynasties and buy identically (the determinism / save-load invariants hold
 * across the reset). Mirrors {@link eraDrive}.
 */
function dynastyDrive(state: GameState): { founded: boolean; purchases: number } {
  if (!chooseDynasty(state)) return { founded: false, purchases: 0 }
  newDynasty(state)
  let purchases = 0
  for (const id of DYNASTY_NODE_IDS) {
    while (canPurchaseDynasty(state, id).ok) {
      if (!purchaseDynasty(state, id)) break
      purchases += 1
    }
  }
  return { founded: true, purchases }
}

/** What a dynasty run yields: the final state, sampled invariants, and the dynasty tally. */
interface DynastyRun {
  state: GameState
  invariants: InvariantResult[]
  stats: DynastyRunStats
}

/**
 * Run a fresh state forward for `ticks` steps WITH the prestige loop, the era loop AND the dynasty
 * loop active. Each step plays normally ({@link step}), then {@link prestigeDrive} ascends + buys so
 * the prestige account accumulates, then {@link eraDrive} converts a worthwhile account into a Nowa
 * Era + era buys (so the era account — which feeds dynastyScore — accumulates), then
 * {@link dynastyDrive} converts a worthwhile ERA account into a Nowa Dynastia + dynasty buys. After
 * every dynasty reset, when `withInvariants`, the post-reset state is asserted valid and playable
 * (resource / army / world / placement / loyalty — both the prestige AND era accounts now WIPED but
 * valid — dynasty round-trip / whole-state round-trip). At the end the ep_mult uplift is MEASURED on
 * a fixed era score and the automation-unlock gate is probed — the proof a dynasty accelerates the
 * era loop AND turns on the idle routines from the start.
 */
function runDynasty(seed: string, ticks: number, dt: number, withInvariants: boolean): DynastyRun {
  const state = createInitialState(seed, 0)
  const scratch = emptyUnitCounts()
  const invariants: InvariantResult[] = []
  let purchases = 0
  let firstDynastyTick: number | null = null

  for (let i = 0; i < ticks; i++) {
    step(state, dt, scratch, i)
    // Prestige first so the account accumulates, then convert worthwhile progress to an era (which
    // accumulates the era account), then convert a worthwhile era account to a dynasty.
    prestigeDrive(state)
    eraDrive(state)
    const { founded, purchases: bought } = dynastyDrive(state)
    if (!founded) continue
    purchases += bought
    if (firstDynastyTick === null) firstDynastyTick = i

    if (withInvariants) {
      // Assert the RESET ITSELF left a valid, playable single-capital state with WIPED era + prestige
      // accounts and a surviving dynasty account. As in runEra we do NOT sample no-softlock at this
      // instant: a just-reset capital has accrued nothing this tick, so checkNoSoftlock (which ignores
      // production) would read a false stall — checkDynastyNoSoftlock covers post-dynasty playability
      // structurally, and the run REACHING the cap proves it progresses.
      const phase = `dyn${state.dynasty.dynasties}`
      invariants.push(...tag(runInvariants(state), phase))
      invariants.push(...tag([checkArmyConsistency(state)], phase))
      invariants.push(...tag([checkWorldConsistency(state)], phase))
      invariants.push(...tag([checkVillagePlacement(state)], phase))
      invariants.push(...tag([checkLoyalty(state)], phase))
      invariants.push(...tag([checkPrestigeState(state)], phase))
      invariants.push(...tag([checkDynastyRoundTrip(state)], phase))
      invariants.push(...tag([checkRoundTrip(state)], phase))
    }
  }

  if (withInvariants) {
    invariants.push(...tag(runInvariants(state), 'dynfinal'))
    invariants.push(...tag([checkArmyConsistency(state)], 'dynfinal'))
    invariants.push(...tag([checkWorldConsistency(state)], 'dynfinal'))
    invariants.push(...tag([checkPrestigeState(state)], 'dynfinal'))
    invariants.push(...tag([checkDynastyRoundTrip(state)], 'dynfinal'))
    invariants.push(...tag([checkRoundTrip(state)], 'dynfinal'))
    // Lifetime stats + achievements SURVIVE every dynasty reset (newDynasty leaves them untouched).
    invariants.push(...tag([checkStats(state)], 'dynfinal'))
    invariants.push(...tag([checkAchievementsValid(state)], 'dynfinal'))
    // Whole-run no-softlock (mirrors runEra's efinal): the dynasty run made progress iff it founded a
    // dynasty / bought at least once, so the run never stalled overall.
    invariants.push(
      ...tag([checkNoSoftlock(state, totalResources(state), purchases > 0 || firstDynastyTick !== null)], 'dynfinal'),
    )
  }

  // dynastyEpUplift: CONSTRUCTED proof that an ep_mult dynasty node lifts era-point gain for a FIXED
  // era score — independent of whether the bot's greedy source-order buy reached the ep_mult node this
  // run (DP is rare, so it usually fills the first root first). Seed a fresh state with a large,
  // FIXED prestige account (so the era score — and thus pendingEraPoints — clears the cube-root
  // floor), measure pendingEraPoints with no dynasty nodes, then again with the ep_mult node maxed;
  // the ratio > 1 is the proof. Data-driven: finds the ep_mult node rather than hard-coding the root.
  const epNodeId = DYNASTY_NODE_IDS.find((id) => DYNASTY_NODES[id].effect.kind === 'ep_mult')
  let epUplift = 1
  if (epNodeId !== undefined) {
    const probe = createInitialState(seed, 0)
    probe.prestige.totalEarned = 100000
    probe.prestige.ascensions = 50
    const before = pendingEraPoints(probe)
    probe.dynasty.nodes = { [epNodeId]: DYNASTY_NODES[epNodeId].maxLevel }
    const after = pendingEraPoints(probe)
    epUplift = before > 0 ? after / before : 1
  }

  // dynastyAutomationUnlocked: the GATED MECHANIC. The dynasty bag is the ONLY aggregate that can
  // flip the automation flags on, so owning the single automation_unlock gateway must make
  // effectiveMods(state).automations all true. Data-driven: finds the gateway node.
  const autoNodeId = DYNASTY_NODE_IDS.find((id) => DYNASTY_NODES[id].effect.kind === 'automation_unlock')
  let automationUnlocked = false
  if (autoNodeId !== undefined) {
    const probe = createInitialState(seed, 0)
    probe.dynasty.nodes = { [autoNodeId]: DYNASTY_NODES[autoNodeId].maxLevel }
    const a = effectiveMods(probe).automations
    automationUnlocked = a.build && a.recruit && a.attack
  }

  let nodesOwned = 0
  let levelsOwned = 0
  for (const id of DYNASTY_NODE_IDS) {
    const lvl = dynastyNodeLevel(state, id)
    if (lvl > 0) {
      nodesOwned += 1
      levelsOwned += lvl
    }
  }

  return {
    state,
    invariants,
    stats: {
      dynasties: state.dynasty.dynasties,
      purchases,
      nodesOwned,
      levelsOwned,
      epUplift,
      automationUnlocked,
    },
  }
}

/**
 * Dynasty run to the halfway point, persisted via the real export/import (base64) path — crossing at
 * least one Nowa Dynastia (the first lands shortly after the first era, well before the half mark) —
 * then continued. The total step count matches the continuous dynasty run, so any divergence is a
 * save/load fault. This is the proof the GREAT-GREAT RESET survives a save/load ACROSS the reset
 * byte-identically — the highest-risk save/load path under CLAUDE.md hard rule #3: newDynasty
 * regenerates the world + rngState, WIPES the era AND prestige accounts and banks DP, so a
 * deserialize-then-diverge of the freshly-installed rngState / world would strand the run. The
 * per-dynasty {@link checkDynastyRoundTrip} / {@link checkRoundTrip} only prove the post-reset
 * SNAPSHOT round-trips byte-identically; only CONTINUING the loaded post-dynasty save (here) proves
 * it then runs identically to the continuous dynasty run. The PERMANENT dynasty account (banked DP +
 * purchased node levels) rides through the v16 save. Mirrors {@link runEraSplit}.
 */
function runDynastySplit(seed: string, ticks: number, dt: number): GameState {
  const half = Math.floor(ticks / 2)
  const scratch = emptyUnitCounts()
  let state = createInitialState(seed, 0)
  for (let i = 0; i < half; i++) {
    step(state, dt, scratch, i)
    prestigeDrive(state)
    eraDrive(state)
    dynastyDrive(state)
  }
  state = importSave(exportSave(state))
  for (let i = half; i < ticks; i++) {
    step(state, dt, scratch, i)
    prestigeDrive(state)
    eraDrive(state)
    dynastyDrive(state)
  }
  return state
}

// --- M5.1 automation (idle routines) coverage --------------------------------------------
//
// A SEPARATE run from the main economy/combat/tech/expansion/prestige measurement. It must
// stay separate because it UNLOCKS and TURNS ON the three automation routines (auto build /
// recruit / attack); the main run leaves automation OFF so the 17 balance goals are still
// measured on the exact pre-M5.1 game path. Here NO bot acts — the deterministic
// {@link import('./invariants').seedAutomation} scenario is advanced by plain {@link simulate}
// and the idle routines (run inside subStep — tick.ts) do ALL the work, which is exactly what
// proves the M5.1 integration: that the engine itself drives build/recruit/attack each
// sub-step. The run measures that each routine demonstrably fires, samples the hard
// invariants throughout (no NaN / negative / over-cap, army & world consistency, round-trip,
// no-softlock), and the caller pairs it with {@link checkAutomationDeterminism} (online vs
// chunked-offline byte-identical with automation ON).

/** What the automation coverage run yields: sampled invariants + the progress tally. */
interface AutomationRun {
  invariants: InvariantResult[]
  stats: AutomationRunStats
}

/** Σ building levels of the capital — auto-build only ever raises this, so end − start is its work. */
function buildingLevelSum(state: GameState): number {
  const v = state.villages[state.villageOrder[0]]
  let n = 0
  for (const id of BUILDING_IDS) n += v.buildings[id]
  return n
}

/** Σ owned axemen across villages — rises ONLY on training completion (dispatch keeps them owned). */
function axemanTotal(state: GameState): number {
  let n = 0
  for (const vid of state.villageOrder) n += state.villages[vid].units.axeman
  return n
}

/**
 * Advance the {@link seedAutomation} scenario for `seconds` in {@link AUTOMATION_CHUNK}-second
 * chunks, letting the idle routines (in subStep) do everything, and MEASURE that each fired:
 *
 *  - BUILT:     end − start of {@link buildingLevelSum}. Auto-build only ever ADDS levels, so
 *               a positive total is unambiguous proof it bought.
 *  - RECRUITED: the cumulative POSITIVE deltas of {@link axemanTotal}. An axeman roster rises
 *               only when training completes — a dispatch keeps the unit owned (stationedUnits
 *               just subtracts it) and only casualties remove one — so summed increases are a
 *               true lower bound on what auto-recruit trained, robust to the army being sent
 *               out and chipped at by raids.
 *  - ATTACKED:  resolved `attack` battle reports, recovered from the rolling (trimmed) log via
 *               {@link newBattleReports} diffing each chunk — each one is a march auto-attack
 *               dispatched and that resolved at a camp.
 *
 * Hard invariants are sampled every {@link AUTOMATION_SAMPLE_EVERY_CHUNKS} chunks and once at
 * the end (tagged `auto`). checkTechState is intentionally NOT sampled: the scenario unlocks
 * the gateways by level alone without their prerequisite chain (see seedAutomation), which is
 * legal at the save layer but would trip the DAG check — that check is exercised by the main
 * run. The three progress facts are returned as bare-named hard invariants so a stalled
 * routine fails the run.
 */
function runAutomationCoverage(seed: string, seconds: number): AutomationRun {
  const state = createInitialState(seed, 0)
  seedAutomation(state)

  const invariants: InvariantResult[] = []
  const startBuild = buildingLevelSum(state)
  let prevAxe = axemanTotal(state)
  let recruited = 0
  let attacked = 0
  let prevLog: BattleReport[] = state.battleLog.slice()
  let prevTotal = totalResources(state)
  let actedInWindow = 0

  const chunks = Math.ceil(seconds / AUTOMATION_CHUNK)
  for (let i = 0; i < chunks; i++) {
    const dt = Math.min(AUTOMATION_CHUNK, seconds - i * AUTOMATION_CHUNK)
    const buildBefore = buildingLevelSum(state)
    simulate(state, dt)

    // Auto-recruit work: only-rising axeman roster, summed positive deltas.
    const axe = axemanTotal(state)
    if (axe > prevAxe) {
      recruited += axe - prevAxe
      actedInWindow += axe - prevAxe
    }
    prevAxe = axe

    // Auto-attack work: resolved attack reports the chunk produced.
    for (const r of newBattleReports(prevLog, state.battleLog)) {
      if (r.kind === 'attack') {
        attacked += 1
        actedInWindow += 1
      }
    }
    prevLog = state.battleLog.slice()

    // Auto-build work this chunk (for the no-softlock progress signal).
    if (buildingLevelSum(state) > buildBefore) actedInWindow += 1

    const last = i === chunks - 1
    if ((i + 1) % AUTOMATION_SAMPLE_EVERY_CHUNKS === 0 || last) {
      const phase = `auto t${i + 1}`
      invariants.push(...tag(runInvariants(state), phase))
      invariants.push(...tag([checkArmyConsistency(state)], phase))
      invariants.push(...tag([checkWorldConsistency(state)], phase))
      invariants.push(...tag([checkVillagePlacement(state)], phase))
      invariants.push(...tag([checkLoyalty(state)], phase))
      invariants.push(...tag([checkRoundTrip(state)], phase))
      invariants.push(...tag([checkNoSoftlock(state, prevTotal, actedInWindow > 0)], phase))
      prevTotal = totalResources(state)
      actedInWindow = 0
    }
  }

  const built = buildingLevelSum(state) - startBuild

  // The three proof-of-mechanic facts as bare-named HARD invariants: with the deterministic
  // seeded scenario each routine must do real work, so a regression that stops one firing is
  // a genuine bug that fails the run (not a balance-curve warning).
  invariants.push({
    name: 'automation-built',
    ok: built >= TARGETS.minAutomationBuilt,
    detail: `auto-build added ${built} building level(s) (target >= ${TARGETS.minAutomationBuilt})`,
  })
  invariants.push({
    name: 'automation-recruited',
    ok: recruited >= TARGETS.minAutomationRecruited,
    detail: `auto-recruit trained ${recruited} axeman/axemen (target >= ${TARGETS.minAutomationRecruited})`,
  })
  invariants.push({
    name: 'automation-attacked',
    ok: attacked >= TARGETS.minAutomationAttacked,
    detail: `auto-attack resolved ${attacked} attack(s) (target >= ${TARGETS.minAutomationAttacked})`,
  })

  return { invariants, stats: { built, recruited, attacked } }
}

/**
 * Run a single seed for `ticks` steps and assemble all invariants:
 *  - periodic + final resource/army-consistency/world-consistency/round-trip/no-softlock samples,
 *  - 'save-load-continuation': continuous run vs split-with-save run,
 *  - 'determinism': two identical continuous runs must serialize equally,
 *  - 'offline-determinism': chunked offline catch-up vs one big step (combat-armed),
 *  - 'marches-terminate': a dispatched army always resolves within bounded time.
 */
/** Units of `unitId` still queued for training in `v` (mirrors bot.queuedUnits). */
function queuedCount(v: GameState['villages'][string], unitId: UnitId): number {
  let n = 0
  for (const o of v.recruitQueue) if (o.unitId === unitId) n += o.count
  return n
}

/** A fresh all-zero roster over every unit id. */
function zeroRoster(): Record<UnitId, number> {
  const r = {} as Record<UnitId, number>
  for (const id of UNIT_IDS) r[id] = 0
  return r
}

/**
 * Recruit `unitId` up to `target` total (trained + queued) in `v`, paying real cost from the real
 * coffers and respecting the real popCap — the batch is the shortfall, clamped by the affordable count
 * and the free population. No-op when already at target, broke, or out of population. Returns the units
 * actually ordered (0 when nothing could be).
 */
function recruitToward(
  v: GameState['villages'][string],
  unitId: UnitId,
  target: number,
  mods: ReturnType<typeof effectiveMods>,
): number {
  const have = v.units[unitId] + queuedCount(v, unitId)
  if (have >= target) return 0
  const def = UNITS[unitId]
  const room = Math.floor(freePopulation(v).toNumber() / def.pop)
  const afford = Math.min(
    Math.floor(v.resources.wood.toNumber() / def.cost.wood),
    Math.floor(v.resources.clay.toNumber() / def.cost.clay),
    Math.floor(v.resources.iron.toNumber() / def.cost.iron),
  )
  const batch = Math.min(target - have, room, afford)
  if (batch < 1 || !canRecruit(v, unitId, batch).ok) return 0
  recruit(v, unitId, batch, mods)
  return batch
}

/**
 * M7 fortress (boss-target) run — the BOT-reachability proof the main run cannot give. The main loop
 * CHURNS its population (recruit -> march -> ~30% attrition), so its standing army never accumulates
 * into a boss-cracking stack; the fortress is a finite ONE-TIME prize, not a grind, so a real player
 * instead commits: amass a real army + the full siege train, then march it at the wall once. This
 * driver does exactly that on a fresh seeded capital handed the PROVEN endgame economy — every building
 * AND every tech node at its data-defined max (deterministic, the very state the main run reaches), the
 * warehouse the main run sits pinned at, and (raids frozen, like {@link checkFortressRazeOnce}, so the
 * mechanic — not raid survival, covered elsewhere — is what is measured) recruits the ram train then
 * axemen toward the real popCap, HOLDING them home, and assaults the nearest un-razed fortress the home
 * stack beats even at WORST luck (rams applied). The economy is REAL — real popCap from the maxed farm,
 * real recruit cost/time, real production refilling the coffers; only the slow grind to the maxed state
 * is short-circuited, and the army is recruited honestly within the popCap (no army/pop cheat, unlike
 * the engine-path {@link checkFortressRazeOnce}). Pure + deterministic. Returns how many it razed.
 */
export function runFortress(seed: string, ticks: number, dt: number): number {
  const state = createInitialState(seed, 0)
  const v = state.villages[state.villageOrder[0]]
  // The proven endgame economy, set deterministically (data-driven — no army/pop cheat).
  for (const id of BUILDING_IDS) v.buildings[id] = BUILDINGS[id].maxLevel
  for (const nodeId of TECH_NODE_IDS) state.tech[nodeId] = TECH_NODES[nodeId].maxLevel
  recomputeDerived(state)
  // Start at the cap the main run sits pinned at; production refills it as the strike force trains.
  v.resources = { wood: v.storageCap, clay: v.storageCap, iron: v.storageCap }
  v.raidTimer = ticks * dt + 1e9 // freeze raids: isolate the fortress mechanic from raid attrition.
  const mods = effectiveMods(state)

  for (let i = 0; i < ticks; i++) {
    // Train the siege train first (it gates the assault), then fill the rest of the popCap with axemen.
    recruitToward(v, 'ram', FORTRESS_DRIVE_RAMS, mods)
    recruitToward(v, 'axeman', Number.MAX_SAFE_INTEGER, mods)

    // Assault the nearest un-razed fortress the HOME stack beats at worst luck — but only when no
    // fortress march is already in flight (one all-in at a time). Fortresses are stored level-ascending
    // (f0,f1,…), so the first un-razed is the nearest/weakest.
    const inFlight = v.marches.some((m) => m.targetType === 'fortress')
    if (!inFlight) {
      const home = stationedUnits(v)
      const strike = zeroRoster()
      strike.axeman = home.axeman
      strike.ram = Math.min(home.ram, FORTRESS_DRIVE_RAMS)
      if (strike.ram >= 1 && strike.axeman >= 1) {
        const atkWorst = armyAttackPower(strike, mods) * WORST_LUCK
        const wallFactor = ramDefenseFactor(strike)
        for (const f of state.world.fortresses) {
          if (f.razed) continue
          const effDef = fortressTarget(f.level).defensePower * wallFactor
          const outcome = battleOutcome(atkWorst, effDef)
          // Hold until the all-in stack wins even on the UNLUCKIEST roll AND keeps it to the loss
          // budget (so > 40% survive to haul the big cache home) — a player commits a real army, not
          // a coin-flip suicide stack. Below the bar the driver keeps recruiting toward the popCap.
          if (!outcome.attackerWins) continue
          if (outcome.attackerLossFrac > FORTRESS_DRIVE_MAX_LOSS) continue
          if (armyCarry(applyLosses(strike, outcome.attackerLossFrac)) <= 0) continue
          sendAttack(v, state.world, state.battleLog, f.id, strike, mods, 'fortress')
          break
        }
      }
    }

    simulate(state, dt)
  }
  return state.stats.fortressesRazed
}

// --- M8 challenge (WYZWANIA — constrained run for a permanent reward) run -----------------------
//
// A SEPARATE run from every measurement above, mirroring the prestige/era rationale: STARTING a
// challenge RESETS the run (one fresh constrained capital + a per-challenge world, tech/log cleared —
// like an ascend) while PRESERVING the meta accounts (prestige/era/dynasty) and lifetime stats. Folding
// it into the primary or meta runs would zero out the cumulative progression those targets measure AND
// apply a penalty multiplier they are not measured under. Here the bot plays the SAME {@link step} under
// the active CONSTRAINT, and once the current-run goal is met {@link checkChallengeCompletion} (called
// each step exactly as the engine's tick does) records the completion permanently and grants the reward.
// The dedicated run picks a challenge whose goal is reachable under its constraint — a PRODUCTION goal,
// which the attack/defense/pop penalties never touch — so the bot's normal economy build-up clears it.

/** Which challenge the dedicated run drives — the first PRODUCTION-goal one (reachable under any
 * economy-neutral constraint), data-driven so a catalogue edit never strands the run. */
function challengeDriveId(): string {
  const c = CHALLENGES.find((c) => c.goal.kind === 'production')
  return c ? c.id : CHALLENGE_IDS[0]
}

/** What a challenge run yields: the final state, sampled invariants, and the challenge tally. */
interface ChallengeRun {
  state: GameState
  invariants: InvariantResult[]
  metrics: ChallengeRunStats
}

/**
 * Run a fresh state forward WITH a challenge active until its goal completes. STARTS the
 * {@link challengeDriveId} challenge (RESETS the run to a fresh constrained capital — meta accounts
 * preserved), then plays the SAME {@link step} loop under the constraint, calling
 * {@link checkChallengeCompletion} each step (mirroring tick.ts) and STOPPING the moment a completion
 * fires (the dedicated run's job is to prove the goal is reachable under the constraint, not to grind on).
 * Samples the hard invariants periodically + at the end (incl. a challenge round-trip on the live
 * record), then MEASURES whether the earned reward folds into a FRESH post-completion run. Returns the
 * completed map + that proof. Deterministic: the only RNG is the seeded per-challenge world.
 */
function runChallenge(seed: string, ticks: number = CHALLENGE_TICKS): ChallengeRun {
  const dt = TARGETS.tickSeconds
  const state = createInitialState(seed, 0)
  const scratch = emptyUnitCounts()
  const invariants: InvariantResult[] = []
  const id = challengeDriveId()

  // START the challenge — RESETS the run to a fresh constrained capital (meta accounts preserved).
  startChallenge(state, id)

  let completedTick: number | null = null
  let prevTotal = totalResources(state)
  let actedInWindow = 0

  for (let i = 0; i < ticks; i++) {
    // The engine's tick ALREADY calls checkChallengeCompletion once per sub-step inside step(),
    // so by the time step() returns a goal met this step has cleared activeId and banked the
    // reward. Detect that here via the activeId transition (active before -> null after) rather
    // than a redundant second call (which would always see activeId already null and never fire).
    const wasActive = state.challenge.activeId !== null
    const { built, recruited, attacked, founded, tech } = step(state, dt, scratch, i)
    actedInWindow += built + recruited + attacked + founded + tech
    if (wasActive && state.challenge.activeId === null && completedTick === null) {
      completedTick = i
    }

    if ((i + 1) % SAMPLE_EVERY === 0) {
      const phase = `chal t${i + 1}`
      invariants.push(...tag(runInvariants(state), phase))
      invariants.push(...tag([checkArmyConsistency(state)], phase))
      invariants.push(...tag([checkWorldConsistency(state)], phase))
      invariants.push(...tag([checkVillagePlacement(state)], phase))
      invariants.push(...tag([checkRoundTrip(state)], phase))
      invariants.push(...tag([checkNoSoftlock(state, prevTotal, actedInWindow > 0)], phase))
      prevTotal = totalResources(state)
      actedInWindow = 0
    }

    // STOP once the goal completes — the run has proven reachability under the constraint.
    if (completedTick !== null) break
  }

  // Final invariants (mirrors the other runs' final phase): the post-completion state stays valid +
  // playable, and the { activeId, completed } record round-trips through the v19 save.
  invariants.push(...tag(runInvariants(state), 'chalfinal'))
  invariants.push(...tag([checkArmyConsistency(state)], 'chalfinal'))
  invariants.push(...tag([checkWorldConsistency(state)], 'chalfinal'))
  // Whole-run no-softlock (mirrors runPrestige's pfinal): the run made progress iff it completed its
  // challenge, so it never stalled overall (the per-window samples above carry the real acted signal).
  invariants.push(...tag([checkNoSoftlock(state, totalResources(state), completedTick !== null)], 'chalfinal'))
  invariants.push(...tag([checkChallengeRoundTrip(state)], 'chalfinal'))

  const completedMap = { ...state.challenge.completed }
  let completed = 0
  for (const cid of CHALLENGE_IDS) if ((completedMap[cid] ?? 0) >= 1) completed += 1

  // rewardActive: the earned reward must fold into a FRESH post-completion run — a fresh capital
  // carrying only the completed map must have a strictly raised effectiveMods axis vs a no-challenge
  // baseline (the constraint is off, so the bag folded in is the reward alone).
  const base = createInitialState(seed, 0)
  const baseMods = effectiveMods(base)
  const post = createInitialState(seed, 0)
  post.challenge.completed = { ...completedMap }
  const postMods = effectiveMods(post)
  const rewardActive =
    completed > 0 &&
    (RESOURCE_IDS.some((r) => postMods.productionMult[r] > baseMods.productionMult[r]) ||
      postMods.storageMult > baseMods.storageMult ||
      postMods.popMult > baseMods.popMult ||
      postMods.attackMult > baseMods.attackMult ||
      postMods.defenseMult > baseMods.defenseMult ||
      postMods.lootMult > baseMods.lootMult)

  // Bare-named HARD invariant: the dedicated run must COMPLETE its (reachable) challenge within budget.
  invariants.push({
    name: 'challenge-completed',
    ok: completed >= 1,
    detail:
      completed >= 1
        ? `completed ${id} at tick ${completedTick} (completed map: ${JSON.stringify(completedMap)}, reward active: ${rewardActive})`
        : `dedicated run did not complete challenge ${id} within ${ticks} ticks`,
  })

  return { state, invariants, metrics: { completed, completedMap, rewardActive } }
}

// --- M9 market (RYNEK — merchant transport between own villages) run ----------------------------
//
// A SEPARATE run from every measurement above, mirroring the fortress/challenge rationale: transport
// is a PLAYER-INITIATED action (like sendAttack) that never runs in the tick and never folds into
// effectiveMods, so a run that never transports is BYTE-IDENTICAL to pre-M9 — the main + meta runs
// never transport, so their 17 core + meta targets stay measured exactly as before. The main-run bot
// also EXCLUDES 'market' from its build candidates (see sim/bot.MAIN_BUILD_IDS), so adding the building
// to the catalogue cannot drift the main build order. This dedicated run hands a fresh seeded capital
// the PROVEN endgame economy (every building + tech at its data max — the very state the main run
// reaches), founds a second village, then dispatches merchant shipments and steps until
// advanceShipments delivers them on the fixed grid, proving the dispatch -> in-transit -> deliver
// pipeline is reachable. Pure + deterministic (transport draws NO rng).

/**
 * Step budget for the SEPARATE M9 market run. Tiny on purpose: the run only needs to dispatch a few
 * shipments and let them arrive — merchant travel time is the (short) map distance between two adjacent
 * villages × MARKET_TIME_SCALE (a handful of seconds), so the shipments resolve almost immediately and
 * the loop breaks the moment the source is drained of in-flight cargo. The generous ceiling bounds the
 * worst case (an unusually distant second village) rather than the common one.
 */
const MARKET_TICKS = 4000

/**
 * Cargo PER RESOURCE the market run loads into each shipment. Sized so {@link MARKET_SHIPMENTS} of them
 * fit SIMULTANEOUSLY inside a maxed Rynek's merchant capacity (perLevel × maxLevel) — they are all
 * dispatched up front, so the peak in-use (MARKET_SHIPMENTS × 3 × this) must stay under that cap — and
 * so each is comfortably covered by the source's full warehouse. Provisional, matching the building
 * numbers the Balance phase tunes.
 */
const MARKET_SHIP_CARGO = 4000

/** Shipments the market run dispatches up front (proves the multi-shipment capacity accounting holds). */
const MARKET_SHIPMENTS = 3

/**
 * Input the market run TRADES at the Rynek once (M9.2 wymiana): a fixed slab of wood exchanged into iron
 * AT the source village. Well within the source's stocked warehouse, so the exchange always fires; the
 * received credit (floor(input × rate), rate < 1) is always strictly less — exchange is a surplus sink,
 * never arbitrage. The MAIN-run bot NEVER exchanges (so the main + meta runs stay byte-identical to
 * pre-M9.2 bar the inert resourcesExchanged=0 counter); only this dedicated run exercises it.
 */
const MARKET_EXCHANGE_INPUT = 10000

/** What a market run yields: the final state, sampled invariants, and the transport tally. */
interface MarketRun {
  state: GameState
  invariants: InvariantResult[]
  metrics: MarketRunStats
}

/**
 * Drive a fresh seeded capital through the M9 transport loop and prove shipments deliver. Hands the
 * capital the PROVEN endgame economy (every building + tech maxed — DIRECTLY, the dedicated-run helper
 * pattern, NOT via the main bot build candidates, so the main run stays byte-identical and the market is
 * excluded there), founds a second village, maxes the destination's warehouse so deliveries never
 * overflow (transport conserves — the full cargo lands), then dispatches {@link MARKET_SHIPMENTS}
 * merchant shipments and steps until {@link import('../src/systems/market').advanceShipments} delivers
 * them on the fixed grid. Samples the hard invariants (incl. the merchant-capacity bound) at every step
 * a shipment is in flight, then a final pass, plus a bare 'shipments-delivered' proof. Records the
 * shipments delivered + total resources transported. Deterministic: transport draws NO rng.
 */
export function runMarket(seed: string, ticks: number = MARKET_TICKS): MarketRun {
  const dt = TARGETS.tickSeconds
  const state = createInitialState(seed, 0)
  const invariants: InvariantResult[] = []
  const fromId = state.villageOrder[0]
  const from = state.villages[fromId]

  // Proven economy on the source (mirrors runFortress): every building + tech at its data max, so the
  // Rynek grants its full merchant capacity and the warehouse holds the coffers we load.
  for (const id of BUILDING_IDS) from.buildings[id] = BUILDINGS[id].maxLevel
  for (const nodeId of TECH_NODE_IDS) state.tech[nodeId] = TECH_NODES[nodeId].maxLevel
  recomputeDerived(state)
  from.resources = { wood: from.storageCap, clay: from.storageCap, iron: from.storageCap }

  // Ensure >= 2 villages: found a second near the capital (a fresh dedicated run starts single-village).
  if (state.villageOrder.length < 2) {
    const spot = findFoundingSpot(state, fromId)
    if (spot === null || foundVillage(state, fromId, spot.x, spot.y) === null) {
      invariants.push({
        name: 'shipments-delivered',
        ok: false,
        detail: 'could not found a second village to transport to',
      })
      return {
        state,
        invariants,
        metrics: { shipmentsDelivered: 0, resourcesTransported: D(0), resourcesExchanged: D(0) },
      }
    }
  }
  const toId = state.villageOrder[1]
  const to = state.villages[toId]
  // Maxed warehouse on the destination so a delivery never overflows its cap (the dispatched cargo is
  // fully collected — transport conserves), then refresh derived stats after the bulk building change.
  for (const id of BUILDING_IDS) to.buildings[id] = BUILDINGS[id].maxLevel
  recomputeDerived(state)

  // Freeze raids + the global horde across the whole run so the ONLY resource movement is the transport
  // (isolates the mechanic from raid/horde attrition — exactly as runFortress freezes raids).
  for (const vid of state.villageOrder) state.villages[vid].raidTimer = ticks * dt + 1e9
  state.horde.timer = ticks * dt + 1e9

  // Dispatch the merchant shipments UP FRONT (player-initiated, like sendAttack): cargo leaves the
  // source immediately and is held in transit, occupying merchant capacity until delivered. All
  // identical, so the per-shipment cargo sum is a constant.
  const cargo = { wood: MARKET_SHIP_CARGO, clay: MARKET_SHIP_CARGO, iron: MARKET_SHIP_CARGO }
  const perShipment = D(MARKET_SHIP_CARGO).mul(RESOURCE_IDS.length)
  let sent = 0
  for (let i = 0; i < MARKET_SHIPMENTS; i++) {
    if (!sendShipment(state, fromId, toId, cargo)) break
    sent += 1
  }

  // M9.2 EXCHANGE (wymiana): the Rynek also converts a surplus of one resource into another AT THE SAME
  // village, INSTANTLY, paying the spread (received = floor(input × rate), rate < 1 — always a strict
  // loss). The MAIN run never exchanges, but this dedicated market run exercises it once on the real
  // engine: trade a fixed slab of wood into iron at the maxed Rynek (the dispatch above already drained a
  // little iron headroom so the floored credit lands rather than fully spilling) and record the gross
  // input traded away (the resourcesExchanged sink throughput, read straight off the stat the engine
  // bumps) plus what was received — proof the exchange path is reachable and strictly loses value.
  const ironBeforeExchange = from.resources.iron
  exchangeResources(state, fromId, 'wood', 'iron', MARKET_EXCHANGE_INPUT)
  const exchangeReceived = from.resources.iron.sub(ironBeforeExchange)
  const resourcesExchanged = state.stats.resourcesExchanged

  let prevTotal = totalResources(state)
  for (let i = 0; i < ticks; i++) {
    const inFlightBefore = from.shipments.length
    simulate(state, dt)
    // Sample the hard invariants (incl. the merchant-capacity bound) at every IN-FLIGHT step — cheap
    // (only a handful before the shipments arrive) and exactly the "every village every sampled step"
    // the capacity contract requires.
    if (inFlightBefore > 0) {
      const phase = `mkt t${i + 1}`
      invariants.push(...tag([checkMarketCapacity(state)], phase))
      invariants.push(...tag(runInvariants(state), phase))
      invariants.push(...tag([checkArmyConsistency(state)], phase))
      invariants.push(...tag([checkWorldConsistency(state)], phase))
      invariants.push(...tag([checkVillagePlacement(state)], phase))
      invariants.push(...tag([checkRoundTrip(state)], phase))
      invariants.push(...tag([checkNoSoftlock(state, prevTotal, true)], phase))
      prevTotal = totalResources(state)
    }
    if (from.shipments.length === 0) break
  }

  // Final pass: the post-delivery state stays valid + playable, the capacity bound still holds (now at 0
  // in use), and the whole-run no-softlock (the run made progress iff a shipment delivered).
  const shipmentsDelivered = sent - from.shipments.length
  invariants.push(...tag([checkMarketCapacity(state)], 'mktfinal'))
  invariants.push(...tag(runInvariants(state), 'mktfinal'))
  invariants.push(...tag([checkArmyConsistency(state)], 'mktfinal'))
  invariants.push(...tag([checkWorldConsistency(state)], 'mktfinal'))
  invariants.push(...tag([checkNoSoftlock(state, totalResources(state), shipmentsDelivered > 0)], 'mktfinal'))

  // Bare-named HARD invariant: the dedicated run must DELIVER at least one shipment within budget.
  invariants.push({
    name: 'shipments-delivered',
    ok: shipmentsDelivered >= 1,
    detail:
      shipmentsDelivered >= 1
        ? `delivered ${shipmentsDelivered}/${sent} shipment(s) (${perShipment.mul(shipmentsDelivered).toString()} resources transported)`
        : `dedicated run delivered no shipments within ${ticks} ticks (sent ${sent})`,
  })

  // M9.2 bare-named HARD invariant (mirrors 'shipments-delivered'): the dedicated run must EXCHANGE
  // resources, trading away a positive gross input for a strictly smaller received credit (rate < 1).
  invariants.push({
    name: 'resources-exchanged',
    ok: resourcesExchanged.gt(0) && exchangeReceived.lt(MARKET_EXCHANGE_INPUT),
    detail: resourcesExchanged.gt(0)
      ? `traded ${resourcesExchanged.toString()} wood for ${exchangeReceived.toString()} iron at the Rynek (received < input — a strict loss)`
      : `dedicated run exchanged nothing (gross input ${resourcesExchanged.toString()})`,
  })

  return {
    state,
    invariants,
    metrics: {
      shipmentsDelivered,
      // No overflow at the maxed-warehouse destination, so the delivered total is exactly the
      // dispatched cargo of the shipments that arrived.
      resourcesTransported: perShipment.mul(shipmentsDelivered),
      // M9.2: the gross input traded away at the Rynek (the lifetime stat the exchange bumped).
      resourcesExchanged,
    },
  }
}

// --- M10 cavalry (KAWALERIA — Stajnia-gated mounted units) run ----------------------------------
//
// A SEPARATE run from every measurement above, mirroring the fortress/market rationale: the cavalry is
// gated behind the Stajnia (stable), which is autoBuildable:false — so neither the in-game auto-build nor
// the MAIN-run bot ever build it (MAIN_BUILD_IDS filters it out), the cavalry never UNLOCKS in the main
// run (cheapestRecruit can never pick a gated unit), and a run that never builds the Stajnia is BYTE-
// IDENTICAL to pre-M10 (every existing balance target untouched). This dedicated run hands a fresh seeded
// capital the PROVEN endgame economy (every building + tech at its data max — the very state the main run
// reaches, which BUILDS the Stajnia along with everything else), recruits BOTH cavalry units honestly
// within the real popCap, then marches a cavalry strike force to win a barbarian-camp attack. The cavalry
// uses the EXISTING combat model (its `attack` drives offence), so no resolver change is needed. Pure +
// deterministic (combat draws only the seeded luck, frozen to worst-case for target selection).

/**
 * Step budget for the SEPARATE M10 cavalry run. Sized so a maxed capital can train the full cavalry
 * strike force (both mounts, sequential on the recruit queue — the heavy cavalry's ~430s base, shortened
 * by the maxed Stajnia + tech training bonuses) AND march it to the nearest barbarian camp and resolve
 * the attack, with headroom. The run STOPS the moment the cavalry strike wins (single pass — it measures
 * REACHABILITY, not save fidelity, which {@link checkCavalrySaveLoad} pins), so the budget bounds the
 * worst case rather than the common one.
 */
const CAVALRY_TICKS = 12000

/** Light cavalry the run trains before striking — a proper raiding stack within the maxed popCap. */
const CAVALRY_LIGHT = 20

/** Heavy cavalry the run trains before striking — the mounted hammer alongside the light raiders. */
const CAVALRY_HEAVY = 10

/** Σ owned cavalry (light + heavy) across villages — rises ONLY on training completion (dispatch keeps them owned). */
function cavalryTotal(state: GameState): number {
  let n = 0
  for (const vid of state.villageOrder) {
    const v = state.villages[vid]
    n += v.units.light_cavalry + v.units.heavy_cavalry
  }
  return n
}

/** What a cavalry run yields: the final state, sampled invariants, and the cavalry tally. */
interface CavalryRun {
  state: GameState
  invariants: InvariantResult[]
  metrics: CavalryRunStats
}

/**
 * Drive a fresh seeded capital through the M10 cavalry loop and prove the mounted pipeline is reachable.
 * Hands the capital the PROVEN endgame economy (every building + tech maxed — DIRECTLY, the dedicated-run
 * helper pattern, NOT via the main bot build candidates, so the main run stays byte-identical and the
 * Stajnia stays excluded there). Maxing the buildings BUILDS the Stajnia (autoBuildable:false — the gate
 * the main run never opens), UNLOCKING the cavalry roster. The driver then recruits BOTH cavalry units
 * toward their targets, HOLDING them home (no churn), and once the full strike force stands sends ONE
 * attack INCLUDING cavalry at the nearest barbarian camp the stack beats even at WORST luck — winning it
 * via the EXISTING combat model. Raids + the global horde are frozen so the ONLY combat is the cavalry
 * strike (isolating the mechanic from raid/horde attrition, exactly as runFortress/runMarket freeze them).
 * Samples the hard invariants periodically + at the end, plus bare 'cavalry-recruited' / 'cavalry-attack-
 * won' proofs. Records the cavalry trained + the Stajnia level reached. Deterministic.
 */
export function runCavalry(seed: string, ticks: number = CAVALRY_TICKS): CavalryRun {
  const dt = TARGETS.tickSeconds
  const state = createInitialState(seed, 0)
  const invariants: InvariantResult[] = []
  const v = state.villages[state.villageOrder[0]]

  // Proven endgame economy (mirrors runFortress/runMarket): every building + tech at its data max. This
  // BUILDS the Stajnia (which the MAIN bot/auto-build never raise — it is autoBuildable:false), UNLOCKING
  // the cavalry roster the dedicated run trains and fights. Direct set is the dedicated-run helper pattern.
  for (const id of BUILDING_IDS) v.buildings[id] = BUILDINGS[id].maxLevel
  for (const nodeId of TECH_NODE_IDS) state.tech[nodeId] = TECH_NODES[nodeId].maxLevel
  recomputeDerived(state)
  v.resources = { wood: v.storageCap, clay: v.storageCap, iron: v.storageCap }
  // Freeze raids + the global horde so the ONLY combat is the cavalry strike (isolate the mechanic).
  v.raidTimer = ticks * dt + 1e9
  state.horde.timer = ticks * dt + 1e9
  const mods = effectiveMods(state)

  const stableBuilt = v.buildings.stable // the gate the main run never opens (maxed here).

  let cavalryRecruited = 0
  // Peak per-type roster (capital): proves BOTH cavalry types were trained to their targets,
  // so the 'cavalry-recruited' invariant does not lean solely on the attack-send gate (M10 review).
  let lightPeak = 0
  let heavyPeak = 0
  let prevCav = cavalryTotal(state)
  let attackSent = false
  let attackWon = false
  let prevLog: BattleReport[] = state.battleLog.slice()
  let prevTotal = totalResources(state)
  let actedInWindow = 0

  for (let i = 0; i < ticks; i++) {
    // Train BOTH cavalry units toward their targets (held at home — no churn until the strike).
    recruitToward(v, 'light_cavalry', CAVALRY_LIGHT, mods)
    recruitToward(v, 'heavy_cavalry', CAVALRY_HEAVY, mods)

    // Once the FULL cavalry strike force stands at home and nothing is already marching, send ONE attack
    // INCLUDING both cavalry units at the nearest barbarian camp the stack beats even at WORST luck.
    if (!attackSent && v.marches.length === 0) {
      const home = stationedUnits(v)
      if (home.light_cavalry >= CAVALRY_LIGHT && home.heavy_cavalry >= CAVALRY_HEAVY) {
        const strike = zeroRoster()
        strike.light_cavalry = home.light_cavalry
        strike.heavy_cavalry = home.heavy_cavalry
        const atkWorst = armyAttackPower(strike, mods) * WORST_LUCK
        // Camps are tier-ascending in generation order, so the first beatable is the weakest/nearest.
        for (const b of state.world.barbarians) {
          const outcome = battleOutcome(atkWorst, barbarianTarget(b.level).defensePower)
          if (!outcome.attackerWins) continue
          if (armyCarry(applyLosses(strike, outcome.attackerLossFrac)) <= 0) continue
          if (sendAttack(v, state.world, state.battleLog, b.id, strike, mods)) attackSent = true
          break
        }
      }
    }

    simulate(state, dt)

    // Cavalry trained = cumulative POSITIVE roster deltas (mirrors the automation run's axemanTotal): the
    // roster rises only on training completion (a dispatch keeps the unit owned, only casualties remove it).
    const cav = cavalryTotal(state)
    if (cav > prevCav) {
      cavalryRecruited += cav - prevCav
      actedInWindow += cav - prevCav
    }
    prevCav = cav
    // Track each type's peak owned count (v.units counts away units too, so a dispatch never lowers
    // it — only casualties do, which the peak ignores).
    lightPeak = Math.max(lightPeak, v.units.light_cavalry)
    heavyPeak = Math.max(heavyPeak, v.units.heavy_cavalry)

    // Fold the rolling battle log for a WON cavalry attack (the only attacks this run sends are cavalry).
    for (const r of newBattleReports(prevLog, state.battleLog)) {
      if (r.kind === 'attack') {
        actedInWindow += 1
        if (r.won) attackWon = true
      }
    }
    prevLog = state.battleLog.slice()

    if ((i + 1) % SAMPLE_EVERY === 0) {
      const phase = `cav t${i + 1}`
      invariants.push(...tag(runInvariants(state), phase))
      invariants.push(...tag([checkArmyConsistency(state)], phase))
      invariants.push(...tag([checkWorldConsistency(state)], phase))
      invariants.push(...tag([checkVillagePlacement(state)], phase))
      invariants.push(...tag([checkRoundTrip(state)], phase))
      invariants.push(...tag([checkNoSoftlock(state, prevTotal, actedInWindow > 0)], phase))
      prevTotal = totalResources(state)
      actedInWindow = 0
    }

    // STOP once the cavalry strike has resolved with a win — reachability proven.
    if (attackWon) break
  }

  // Final pass (mirrors the other dedicated runs): the post-strike state stays valid + playable.
  invariants.push(...tag(runInvariants(state), 'cavfinal'))
  invariants.push(...tag([checkArmyConsistency(state)], 'cavfinal'))
  invariants.push(...tag([checkWorldConsistency(state)], 'cavfinal'))
  invariants.push(
    ...tag([checkNoSoftlock(state, totalResources(state), cavalryRecruited > 0 || attackWon)], 'cavfinal'),
  )

  // Bare-named HARD invariants (mirror runMarket's 'shipments-delivered'): the dedicated run must TRAIN
  // cavalry AND win a cavalry attack within budget — proof the M10 recruit + combat pipeline completes.
  const bothTypes = lightPeak >= CAVALRY_LIGHT && heavyPeak >= CAVALRY_HEAVY
  invariants.push({
    name: 'cavalry-recruited',
    ok: cavalryRecruited >= 1 && bothTypes,
    detail: bothTypes
      ? `trained ${cavalryRecruited} cavalry — BOTH types to target (light peak ${lightPeak}/${CAVALRY_LIGHT}, heavy peak ${heavyPeak}/${CAVALRY_HEAVY}) with the Stajnia at level ${stableBuilt}`
      : `cavalry not both-trained within ${ticks} ticks (light peak ${lightPeak}/${CAVALRY_LIGHT}, heavy peak ${heavyPeak}/${CAVALRY_HEAVY}, Stajnia level ${stableBuilt})`,
  })
  invariants.push({
    name: 'cavalry-attack-won',
    ok: attackWon,
    detail: attackWon
      ? `a cavalry strike force (${CAVALRY_LIGHT} light + ${CAVALRY_HEAVY} heavy) won a barbarian-camp attack`
      : `dedicated run did not win a cavalry attack within ${ticks} ticks`,
  })

  return { state, invariants, metrics: { cavalryRecruited, stableBuilt } }
}

// --- M13 world events (time-limited windfall OFFERS) dedicated run -------------------------------
//
// A SEPARATE run, the ONLY one that ever builds the Wieża strażnicza (watchtower, autoBuildable:false)
// and so the ONLY one that OPENS the world-events gate. The main + meta runs never build it (the bot /
// auto-build skip autoBuildable:false buildings — MAIN_BUILD_IDS), so advanceEvents stays a no-op there
// and a no-watchtower run is BYTE-IDENTICAL to pre-M13 (the events identity, proven by events-inert on
// the main state). This run builds the Wieża DIRECTLY (the dedicated-run helper pattern, mirroring
// runCavalry's Stajnia), arming the events clock, then CLAIMS every offer the moment it lands (claim is
// a PLAYER action, never the tick — like the market exchange / cavalry dispatch) and proves the
// spawn→claim pipeline is reachable and the bounded windfall never breaks the economy.

/**
 * Step budget for the SEPARATE M13 world-events run. Sized so the run spans several EVENT_INTERVAL
 * (1200s) spawn cycles within the budget — at TARGETS.tickSeconds (1s) per step it covers a handful of
 * offers (claimed immediately, so each re-arms the spawn clock a full interval out). Generous headroom
 * over the bare >= 1 the 'events-spawned'/'events-claimed' proofs require.
 */
const EVENTS_TICKS = 5000

/** What a world-events run yields: sampled invariants + the spawn / claim + buff tally. */
interface EventsRun {
  invariants: InvariantResult[]
  spawned: number
  claimed: number
  /** Buff offers CLAIMED (M14) — installed a timed buff (natural RNG draws + the forced guarantee). */
  buffsClaimed: number
  /** Buffs that COUNTED DOWN to expiry through the real tick (non-null -> null across a simulate step). */
  buffExpiries: number
}

/**
 * Drive a fresh seeded capital through the M13 world-events loop and prove the OFFER→CLAIM pipeline is
 * reachable and BOUNDED. Builds the Wieża strażnicza DIRECTLY to its data max (autoBuildable:false — the
 * gate the main run never opens), which UNLOCKS world events ({@link watchtowerBuilt} is now true so
 * advanceEvents runs in the tick). Freezes raids + the global horde so the ONLY thing exercised is the
 * events clock (isolate the mechanic from combat attrition — exactly as runFortress/runCavalry freeze
 * them). Each step runs the real {@link simulate} (whose tick spawns offers from the SEPARATE events RNG
 * stream), detects a fresh idle→active spawn, then CLAIMS it deterministically the moment it lands (claim
 * is a player action, never the tick). Samples the hard invariants periodically + at the end (the
 * resources-finite / non-negative / within-cap checks ARE the bounded-windfall constraint — claimEvent
 * clamps each grant to the storage cap), plus bare 'events-spawned' / 'events-claimed' proofs carrying the
 * tally. Records the offers spawned + claimed. Deterministic — the only randomness is the seeded events stream.
 */
export function runEvents(seed: string, ticks: number = EVENTS_TICKS): EventsRun {
  const dt = TARGETS.tickSeconds
  const state = createInitialState(seed, 0)
  const invariants: InvariantResult[] = []
  const v = state.villages[state.villageOrder[0]]

  // Build the Wieża DIRECTLY (dedicated-run helper pattern, mirrors runCavalry's Stajnia): the main
  // bot / auto-build never raise it (autoBuildable:false), so the main run stays byte-identical; here
  // it OPENS the events gate. A maxed warehouse via recomputeDerived keeps the windfall room realistic.
  v.buildings.watchtower = BUILDINGS.watchtower.maxLevel
  recomputeDerived(state)
  v.resources = { wood: v.storageCap, clay: v.storageCap, iron: v.storageCap }
  // Freeze raids + the global horde so the ONLY clock that matters is the events clock (isolate it).
  v.raidTimer = ticks * dt + 1e9
  state.horde.timer = ticks * dt + 1e9

  let spawned = 0
  let claimed = 0
  let buffsClaimed = 0
  let buffExpiries = 0
  let prevActive = state.events.active !== null
  let prevTotal = totalResources(state)
  let actedInWindow = 0

  for (let i = 0; i < ticks; i++) {
    // A buff in force BEFORE this step that is gone AFTER it was counted down to expiry by
    // advanceEvents inside the tick (M14) — observe the natural buff lifecycle riding the real tick.
    const buffWasActive = state.events.buff !== null
    simulate(state, dt)
    if (buffWasActive && state.events.buff === null) buffExpiries += 1

    // A fresh idle→active transition means the tick spawned exactly one new offer this step.
    const nowActive = state.events.active !== null
    if (nowActive && !prevActive) {
      spawned += 1
      actedInWindow += 1
    }
    // CLAIM the offer the instant it lands (a PLAYER action — never the tick). Claiming the same step
    // it spawns means an offer never lapses unclaimed, so claimed == spawned and each claim re-arms the
    // spawn clock a full EVENT_INTERVAL out. A windfall grant is clamped to the storage cap inside
    // claimEvent (so the sampled resources-within-cap invariant is exactly the bounded-windfall check);
    // a buff claim (M14) installs events.buff, tallied below — both kinds bump eventsResolved equally.
    if (state.events.active) {
      const offered = WORLD_EVENTS_BY_ID[state.events.active.defId]
      if (claimEvent(state)) {
        claimed += 1
        if (offered && offered.kind === 'buff') buffsClaimed += 1
      }
      prevActive = false
    } else {
      prevActive = nowActive
    }

    if ((i + 1) % SAMPLE_EVERY === 0) {
      const phase = `evt t${i + 1}`
      invariants.push(...tag(runInvariants(state), phase))
      invariants.push(...tag([checkArmyConsistency(state)], phase))
      invariants.push(...tag([checkWorldConsistency(state)], phase))
      invariants.push(...tag([checkRoundTrip(state)], phase))
      invariants.push(...tag([checkNoSoftlock(state, prevTotal, actedInWindow > 0)], phase))
      prevTotal = totalResources(state)
      actedInWindow = 0
    }
  }

  // Final pass (mirrors the other dedicated runs): the post-claim state stays valid + playable.
  invariants.push(...tag(runInvariants(state), 'evtfinal'))
  invariants.push(...tag([checkArmyConsistency(state)], 'evtfinal'))
  invariants.push(...tag([checkNoSoftlock(state, totalResources(state), claimed > 0)], 'evtfinal'))

  // Bare-named HARD invariants (mirror runCavalry's 'cavalry-recruited' / runMarket's 'shipments-
  // delivered'): the dedicated run must SPAWN at least one offer AND CLAIM every offer it spawned within
  // budget — proof the M13 offer→claim pipeline completes and the lifetime counter tracks it exactly.
  invariants.push({
    name: 'events-spawned',
    ok: spawned >= 1,
    detail:
      spawned >= 1
        ? `spawned ${spawned} world-event offer(s) through the tick (Wieża at level ${v.buildings.watchtower})`
        : `no world-event offer spawned within ${ticks} ticks (gate / clock issue)`,
  })
  invariants.push({
    name: 'events-claimed',
    ok: claimed >= 1 && claimed === spawned && state.stats.eventsResolved === claimed,
    detail:
      claimed >= 1 && claimed === spawned && state.stats.eventsResolved === claimed
        ? `claimed ${claimed}/${spawned} offer(s), each a bounded windfall clamped to the storage cap (eventsResolved=${state.stats.eventsResolved})`
        : `claimed ${claimed} of ${spawned} spawned (eventsResolved=${state.stats.eventsResolved}) — offer→claim pipeline incomplete`,
  })

  // M14 — GUARANTEED buff lifecycle through the REAL claim + tick path. The natural loop above already
  // installs buffs whenever the weighted spawn rolls one, but that draw is RNG-dependent, so the
  // observation could be vacuous for an unlucky seed. Here we FORCE one buff offer, claim it through the
  // real {@link claimEvent} (installs events.buff), then step the real {@link simulate} until
  // advanceEvents counts the buff down to expiry on the tick grid — exercising offer→claim→buff→
  // tick-countdown→expire end to end and making the 'buffs-observed' proof deterministic + non-vacuous.
  // Placed AFTER events-claimed so the forced claim's eventsResolved bump can never perturb that tally.
  const buffDef = WORLD_EVENTS.find((e): e is BuffEvent => e.kind === 'buff')
  let forcedInstalled = false
  let forcedExpired = false
  if (buffDef) {
    state.events.active = { defId: buffDef.id, ttl: EVENT_TTL, roll: 0.5 }
    if (claimEvent(state)) buffsClaimed += 1
    forcedInstalled = state.events.buff !== null && state.events.buff.defId === buffDef.id
    // Step past the buff's duration (a little headroom); the spawn timer (re-armed to EVENT_INTERVAL by
    // the claim) cannot fire a new offer in this short window, so the only buff change is its expiry.
    const limit = Math.ceil(buffDef.duration / dt) + 5
    for (let t = 0; t < limit && state.events.buff !== null; t++) {
      const was = state.events.buff !== null
      simulate(state, dt)
      if (was && state.events.buff === null) {
        forcedExpired = true
        buffExpiries += 1
      }
    }
  }

  // Bare-named HARD invariant (mirrors events-spawned/claimed): the run must INSTALL a buff via the real
  // claim path AND watch it COUNT DOWN to expiry through the real tick — proof the M14 buff lifecycle is
  // reachable through the offer pipeline. Carries the full natural+forced tally in its detail (the buff
  // metrics ride this string, mirroring how the spawn/claim tally rides events-spawned/claimed).
  const buffsObserved = buffsClaimed >= 1 && buffExpiries >= 1 && forcedInstalled && forcedExpired
  invariants.push({
    name: 'buffs-observed',
    ok: buffsObserved,
    detail: buffsObserved
      ? `claimed ${buffsClaimed} buff(s) and watched ${buffExpiries} expire on the tick grid (forced lifecycle install+expire ok)`
      : `buff lifecycle incomplete (claimed=${buffsClaimed}, expiries=${buffExpiries}, forcedInstalled=${forcedInstalled}, forcedExpired=${forcedExpired})`,
  })

  return { invariants, spawned, claimed, buffsClaimed, buffExpiries }
}

// --- M15 forge (KUŹNIA — permanent account-wide per-unit upgrades) dedicated run -----------------
//
// A SEPARATE run, the ONLY one that ever builds the Kuźnia (content/buildings.forge, autoBuildable:false)
// and so the ONLY one that opens the unit-upgrade gate. The Kuźnia is the game's FIRST per-unit-type
// modifier (the tech/prestige trees only ever grant GLOBAL attack/defense multipliers). The main + meta
// runs never build it (the bot / auto-build skip autoBuildable:false buildings — MAIN_BUILD_IDS), so the
// upgrade map state.forge stays EMPTY and a no-Kuźnia run is BYTE-IDENTICAL to pre-M15 (the forge identity,
// proven by forge-inert on the PRIMARY run's final state). This run builds the Kuźnia DIRECTLY to its data
// max (the dedicated-run helper pattern, mirroring runCavalry's Stajnia / runEvents' Wieża), which UNLOCKS
// upgrades to the full catalogue depth, then UPGRADES every upgradeable line unit (upgradeUnit — a PLAYER
// action, never the tick) and proves the upgraded army hits harder AND defends harder than the same roster
// un-upgraded. Pure + deterministic (upgrades draw NO rng).

/**
 * Step budget for the SEPARATE M15 forge run. Tiny on purpose: upgrades are INSTANT player actions, so the
 * run only needs enough passes to push every upgradeable type (one level per type per pass) to its
 * effective cap (≤ 5) — it breaks the moment a pass buys nothing. The generous ceiling bounds the worst case.
 */
const FORGE_TICKS = 50

/** What a forge run yields: sampled invariants + the upgrade / power-uplift tally. */
interface ForgeRun {
  invariants: InvariantResult[]
  upgrades: number
  attackBefore: number
  attackAfter: number
  defenseBefore: number
  defenseAfter: number
}

/**
 * Drive a fresh seeded capital through the M15 upgrade loop and prove the OPEN→UPGRADE→stronger-army
 * pipeline is reachable. Hands the capital the PROVEN endgame economy (every building maxed — which BUILDS
 * the Kuźnia to its depth cap AND a maxed warehouse so each rising-cost upgrade fits under the storage cap),
 * refills the coffers, then each pass refills + pushes every still-upgradeable line unit one level via the
 * real {@link upgradeUnit} (a player action), advancing the clock and stopping once every type is at its
 * cap. Freezes raids + the global horde so nothing perturbs the capital (isolate the mechanic — exactly as
 * runFortress/runEvents freeze them). Finally compares a fixed line-unit roster's attack AND defense WITH
 * the earned forge map vs WITHOUT it: with-forge must be strictly greater (the upgrades genuinely lift both
 * weapon and armour). Samples the hard invariants at the end + a bare 'forge-upgrades-applied' proof.
 * Deterministic — upgrades draw no rng / clock.
 */
export function runForge(seed: string, ticks: number = FORGE_TICKS): ForgeRun {
  const dt = TARGETS.tickSeconds
  const state = createInitialState(seed, 0)
  const invariants: InvariantResult[] = []
  const v = state.villages[state.villageOrder[0]]

  // Proven economy (mirrors runFortress/runMarket): every building at its data max — which raises the
  // Kuźnia to its depth cap (the main bot never builds it — autoBuildable:false) and the warehouse to its
  // max so the rising upgrade sink stays affordable WITHIN the storage cap (no resources-over-cap).
  for (const id of BUILDING_IDS) v.buildings[id] = BUILDINGS[id].maxLevel
  recomputeDerived(state)
  v.resources = { wood: v.storageCap, clay: v.storageCap, iron: v.storageCap }
  // Freeze raids + the global horde so the ONLY thing exercised is the upgrade loop (isolate it).
  v.raidTimer = ticks * dt + 1e9
  state.horde.timer = ticks * dt + 1e9

  const mods = effectiveMods(state)

  // UPGRADE every upgradeable line unit toward its live cap. One pass per tick: refill the capital from the
  // (maxed) warehouse, push each still-upgradeable type one level, then advance the clock. Bounded by the
  // per-type catalogue cap × types, so it settles well inside the budget (breaks once a pass buys nothing).
  let upgrades = 0
  for (let i = 0; i < ticks; i++) {
    let actedThisStep = 0
    for (const id of UNIT_IDS) {
      v.resources = { wood: v.storageCap, clay: v.storageCap, iron: v.storageCap }
      if (canUpgrade(state, id) && upgradeUnit(state, id)) {
        upgrades += 1
        actedThisStep += 1
      }
    }
    simulate(state, dt)
    if (actedThisStep === 0) break // every upgradeable type is at its cap — done
  }

  // POWER UPLIFT: a fixed roster of every upgradeable line unit. armyAttackPower(army, mods) takes NO forge
  // param (×1.0 — the pre-upgrade baseline); armyAttackPower(army, mods, state.forge) applies the earned
  // per-type multipliers. With ≥ 1 upgrade the with-forge figure must be strictly greater (attack AND
  // defense — one smith improves both weapon and armour).
  const army = zeroRoster()
  for (const id of UNIT_IDS) if (isUpgradeable(id)) army[id] = 50
  const attackBefore = armyAttackPower(army, mods)
  const attackAfter = armyAttackPower(army, mods, state.forge)
  const defenseBefore = armyDefensePower(army, mods)
  const defenseAfter = armyDefensePower(army, mods, state.forge)

  // Final invariants pass (mirrors the other dedicated runs): the post-upgrade state stays valid + playable,
  // round-trips, and never softlocks (it made progress iff it upgraded at least once).
  invariants.push(...tag(runInvariants(state), 'forgefinal'))
  invariants.push(...tag([checkArmyConsistency(state)], 'forgefinal'))
  invariants.push(...tag([checkRoundTrip(state)], 'forgefinal'))
  invariants.push(...tag([checkNoSoftlock(state, totalResources(state), upgrades > 0)], 'forgefinal'))

  // Bare-named HARD invariant (mirrors runEvents' 'events-spawned' / runCavalry's 'cavalry-recruited'): the
  // dedicated run must UPGRADE at least one unit level AND the upgraded roster must out-fight + out-defend
  // the same roster un-upgraded — proof the M15 upgrade pipeline completes and threads into combat power.
  const applied = upgrades >= 1 && attackAfter > attackBefore && defenseAfter > defenseBefore
  invariants.push({
    name: 'forge-upgrades-applied',
    ok: applied,
    detail: applied
      ? `upgraded ${upgrades} unit level(s) (Kuźnia L${v.buildings.forge}); roster attack ${attackBefore.toFixed(0)} -> ${attackAfter.toFixed(0)}, defense ${defenseBefore.toFixed(0)} -> ${defenseAfter.toFixed(0)} (×${(attackAfter / attackBefore).toFixed(3)})`
      : upgrades < 1
        ? `dedicated run did not upgrade any unit within ${ticks} ticks (gate / cost / cap issue)`
        : `upgrades (${upgrades}) did not raise army power: attack ${attackBefore} -> ${attackAfter}, defense ${defenseBefore} -> ${defenseAfter}`,
  })

  return { invariants, upgrades, attackBefore, attackAfter, defenseBefore, defenseAfter }
}

export function runOne(seed: string, ticks: number): RunResult {
  const dt = TARGETS.tickSeconds
  const invariants: InvariantResult[] = []

  // Primary continuous run with sampled invariants — the reference state.
  const primary = runContinuous(seed, ticks, dt, true)
  invariants.push(...primary.invariants)
  const serA = serialize(primary.state)

  // Save/load continuation: a mid-run export/import must not change the outcome.
  const splitState = runSplit(seed, ticks, dt)
  const serC = serialize(splitState)
  invariants.push({
    name: 'save-load-continuation',
    ok: serA === serC,
    detail: serA === serC ? undefined : 'split run with mid save/load diverged from continuous run',
  })

  // Determinism: a second identical run of the same seed must be byte-equal.
  const repeat = runContinuous(seed, ticks, dt, false)
  const serB = serialize(repeat.state)
  invariants.push({
    name: 'determinism',
    ok: serA === serB,
    detail: serA === serB ? undefined : 'two identical runs of the same seed diverged',
  })

  // Offline parity: one big catch-up step must equal the chunked offline path
  // (now with a live training queue, an in-flight march AND active raids — see
  // seedRecruitment) so the combat clocks are covered, not just linear production.
  invariants.push(checkOfflineDeterminism(seed, OFFLINE_CHECK_SECONDS))

  // Marches always terminate: a dispatched army resolves and clears within bounded
  // time, with finite non-negative `remaining` throughout (no stuck/looping march).
  invariants.push(checkMarchesTerminate(seed))

  // M3.1 static passive-tree invariants (catalogue + layout, state-independent): a DAG
  // with no orphans / dead perks, archetype-banded maxLevels, a complete non-overlapping
  // layout and well-formed edges. Asserted once per run (tagged 'tech').
  invariants.push(...tag(checkTechTree(), 'tech'))

  // M4.1 prestige (ascension) — a SEPARATE run so the M1–M3 targets stay measured on an
  // un-reset economy (ascend resets the run). Drives the bot through its ascensions, banks
  // and spends PP, and asserts the reset stays valid/playable, the prestige account survives
  // save/load, and the prestige loop is deterministic.
  const prestige = runPrestige(seed, PRESTIGE_TICKS, dt, true)
  invariants.push(...prestige.invariants)
  const presSerA = serialize(prestige.state)

  // Determinism: a second identical prestige run (ascensions + buys) must be byte-equal.
  const prestigeRepeat = runPrestige(seed, PRESTIGE_TICKS, dt, false)
  const presSerB = serialize(prestigeRepeat.state)
  invariants.push({
    name: 'prestige-determinism',
    ok: presSerA === presSerB,
    detail: presSerA === presSerB ? undefined : 'two identical prestige runs of the same seed diverged',
  })

  // Save-load continuation ACROSS an ascension: a mid-run export/import must not change the
  // outcome — the proof the permanent prestige account is carried losslessly by the v9 save.
  const prestigeSplit = runPrestigeSplit(seed, PRESTIGE_TICKS, dt)
  const presSerC = serialize(prestigeSplit)
  invariants.push({
    name: 'prestige-save-load-continuation',
    ok: presSerA === presSerC,
    detail:
      presSerA === presSerC
        ? undefined
        : 'split prestige run with mid save/load diverged from the continuous prestige run',
  })

  // M4.1 static prestige-tree invariants (catalogue + layout, state-independent), mirroring
  // checkTechTree: a DAG with no orphans / dead perks, archetype-banded maxLevels, a complete
  // non-overlapping layout and well-formed edges. Asserted once per run (tagged 'prestige').
  invariants.push(...tag(checkPrestigeTree(), 'prestige'))

  // M6.1 era (great reset / second meta-layer) — a SEPARATE run so the M1–M3 + prestige targets
  // stay measured on an un-reset account (newEra WIPES the whole prestige account). Drives the bot
  // through its eras (each preceded by enough ascensions that the cube-root EP yield clears the era
  // floor), banks + spends EP on the era tree, and asserts the reset stays valid/playable.
  const era = runEra(seed, ERA_TICKS, dt, true)
  invariants.push(...era.invariants)
  const eraSerA = serialize(era.state)

  // Determinism: a second identical era run must be byte-equal. This covers the FULL era loop
  // end-to-end (step + prestigeDrive + the chooseEra gate + the ERA_NODE_IDS purchase pass across
  // repeated great resets), not just the newEra primitive ({@link checkNewEraDeterminism}). Named
  // 'era-run-determinism' to stay distinct from that primitive's 'era-determinism', so both surface
  // separately in the report (mirrors 'prestige-determinism').
  const eraRepeat = runEra(seed, ERA_TICKS, dt, false)
  const eraSerB = serialize(eraRepeat.state)
  invariants.push({
    name: 'era-run-determinism',
    ok: eraSerA === eraSerB,
    detail: eraSerA === eraSerB ? undefined : 'two identical era runs of the same seed diverged',
  })

  // Save-load continuation ACROSS a Nowa Era: a mid-run export/import — crossing the GREAT RESET
  // (regenerated world + rngState, wiped prestige, banked EP) — must not change the outcome. The
  // proof the highest-risk save/load path (CLAUDE.md hard rule #3) carries the run losslessly and
  // CONTINUES identically, which the per-era post-reset snapshot round-trip cannot show. Mirrors
  // 'prestige-save-load-continuation'.
  const eraSplit = runEraSplit(seed, ERA_TICKS, dt)
  const eraSerC = serialize(eraSplit)
  invariants.push({
    name: 'era-save-load-continuation',
    ok: eraSerA === eraSerC,
    detail:
      eraSerA === eraSerC
        ? undefined
        : 'split era run with mid save/load diverged from the continuous era run',
  })

  // M6.1 static era-tree invariants (catalogue + layout, state-independent), mirroring
  // checkPrestigeTree: a DAG with no orphans / dead perks, archetype-banded maxLevels, a complete
  // non-overlapping layout and well-formed edges. Asserted once per run (tagged 'era').
  invariants.push(...tag(checkEraTree(), 'era'))

  // M6.1 newEra determinism + post-era playability (self-contained, no clock / no RNG): the great
  // reset replays byte-identically from the same seed (surviving era account + wiped prestige +
  // regenerated world + rngState all in lock-step), and a fresh post-era capital always has an
  // available progress action (the reset never softlocks).
  invariants.push(checkNewEraDeterminism(seed))
  invariants.push(checkEraNoSoftlock(seed))

  // M6.2 dynasty (great-great reset / third meta-layer) — a SEPARATE run so the M1–M6.1 + prestige +
  // era targets stay measured on un-reset accounts (newDynasty WIPES the whole era AND prestige
  // accounts). Drives the bot through ascensions + eras + dynasties (the era account, which feeds
  // dynastyScore, must accumulate before the cube-root DP yield clears the dynasty floor), banks +
  // spends DP on the dynasty tree, and asserts the reset stays valid/playable.
  const dynasty = runDynasty(seed, DYNASTY_TICKS, dt, true)
  invariants.push(...dynasty.invariants)
  const dynSerA = serialize(dynasty.state)

  // Determinism: a second identical dynasty run must be byte-equal. This covers the FULL dynasty loop
  // end-to-end (step + prestigeDrive + eraDrive + the chooseDynasty gate + the DYNASTY_NODE_IDS
  // purchase pass across the great-great reset), not just a newDynasty primitive. Named
  // 'dynasty-run-determinism' to stay distinct from any newDynasty-primitive check and to mirror
  // 'era-run-determinism'.
  const dynastyRepeat = runDynasty(seed, DYNASTY_TICKS, dt, false)
  const dynSerB = serialize(dynastyRepeat.state)
  invariants.push({
    name: 'dynasty-run-determinism',
    ok: dynSerA === dynSerB,
    detail: dynSerA === dynSerB ? undefined : 'two identical dynasty runs of the same seed diverged',
  })

  // Save-load continuation ACROSS a Nowa Dynastia: a mid-run export/import — crossing the GREAT-GREAT
  // RESET (regenerated world + rngState, wiped era + prestige, banked DP) — must not change the
  // outcome. The proof the highest-risk save/load path (CLAUDE.md hard rule #3) carries the run
  // losslessly and CONTINUES identically, which the per-dynasty post-reset snapshot round-trip cannot
  // show. Mirrors 'era-save-load-continuation'.
  const dynastySplit = runDynastySplit(seed, DYNASTY_TICKS, dt)
  const dynSerC = serialize(dynastySplit)
  invariants.push({
    name: 'dynasty-save-load-continuation',
    ok: dynSerA === dynSerC,
    detail:
      dynSerA === dynSerC
        ? undefined
        : 'split dynasty run with mid save/load diverged from the continuous dynasty run',
  })

  // M6.2 static dynasty-tree topology (catalogue, state-independent): a DAG with no orphans / dead
  // perks (the binary automation_unlock gateway counts as a real effect). Asserted once per run.
  invariants.push(checkDynastyTopology())

  // M6.2 post-dynasty playability (self-contained, no clock / no RNG): a fresh post-dynasty capital
  // always has an available progress action within a bounded idle horizon (the great-great reset
  // never softlocks).
  invariants.push(checkDynastyNoSoftlock(seed))

  // M8 challenge (WYZWANIA) — a SEPARATE constrained run so the M1–M6.2 + meta targets stay measured
  // with aggregateChallengeMods at IDENTITY (the main + meta runs never start a challenge, so their
  // effectiveMods — and thus the 17 core + prestige/era/dynasty/fortress/horde targets — is byte-
  // identical to pre-M8). Drives the bot under an active constraint until a reachable production goal
  // completes, recording the permanent reward. The run's invariants (sampled validity + a challenge
  // round-trip + the bare 'challenge-completed' proof) are folded in here.
  const challenge = runChallenge(seed, CHALLENGE_TICKS)
  invariants.push(...challenge.invariants)

  // M8 challenge proof-of-mechanic checks (self-contained, deterministic — only the seeded per-challenge
  // world): startChallenge replays byte-identically (challenge-determinism); the active constraint
  // strictly LOWERS the constrained stat (challenge-constraint); completion is one-time with no double-
  // grant (challenge-completion-once); the earned reward folds into a FRESH post-completion run
  // (challenge-reward-folds) and TWO distinct earned rewards STACK into one run (challenge-reward-stacks);
  // and a constrained run never softlocks (challenge-no-softlock). The challenge save/load round-trip is
  // exercised on a state carrying BOTH an active challenge AND a completed one (the highest-information
  // record for the v19 node).
  invariants.push(checkChallengeDeterminism(seed))
  invariants.push(checkChallengeConstraint(seed))
  invariants.push(checkChallengeCompletionOnce(seed))
  invariants.push(checkChallengeRewardFolds(seed))
  invariants.push(checkChallengeRewardStacks(seed))
  invariants.push(checkChallengeNoSoftlock(seed))
  const chalRt = createInitialState(seed, 0)
  chalRt.challenge.completed[CHALLENGE_IDS[0]] = 1
  startChallenge(chalRt, CHALLENGE_IDS[1] ?? CHALLENGE_IDS[0])
  invariants.push(checkChallengeRoundTrip(chalRt))

  // M9 market (RYNEK) — a SEPARATE merchant-transport run, the ONLY one that ever dispatches a
  // shipment. Transport is a player-initiated action (like sendAttack) that never runs in the tick and
  // never folds into effectiveMods, so a run that never transports is BYTE-IDENTICAL to pre-M9 — the
  // main + meta runs above never transport, so their 17 core + prestige/era/dynasty/fortress/horde/
  // challenge targets STILL evaluate here unchanged (the market identity the contract pins). The run's
  // invariants (sampled validity + the merchant-capacity bound + the bare 'shipments-delivered' proof)
  // are folded in here, and its metrics feed the market balance target.
  const market = runMarket(seed)
  invariants.push(...market.invariants)

  // M9 market proof-of-mechanic checks (self-contained, deterministic — transport draws NO rng):
  // transport CONSERVES the empire total and never creates resources (market-conservation); merchant
  // capacity is never exceeded with cargo in flight (market-capacity); a continuous run is byte-
  // identical to a chunked-offline run WITH a shipment in flight (market-determinism); a run with
  // resources in transit never softlocks and the cargo always arrives in bounded time
  // (market-no-softlock); and a state carrying in-flight shipments round-trips through the v20 save
  // (market-save-load).
  invariants.push(checkMarketConservation(seed))
  invariants.push(checkMarketCapacity(market.state))
  invariants.push(checkMarketDeterminism(seed, OFFLINE_CHECK_SECONDS))
  invariants.push(checkMarketNoSoftlock(seed))
  invariants.push(checkMarketSaveLoad(seed))

  // M9.2 market EXCHANGE (RYNEK wymiana) proof-of-mechanic checks (self-contained, deterministic — the
  // exchange draws NO rng / clock): an exchange STRICTLY LOSES value (received = floor(input × rate) with
  // rate < 1, so a wood→clay→wood round-trip can never net resources and the empire total never rises —
  // checkExchangeLoses); it is GATED on the Rynek (refused with no market, allowed with one —
  // checkExchangeGated); it replays byte-identically for identical inputs (checkExchangeDeterminism); and a
  // no-exchange run is BYTE-IDENTICAL to pre-M9.2 (the inert resourcesExchanged=0 counter strips back to the
  // v21 save shape and migrates forward identically — checkExchangeInert). The bot NEVER exchanges, so the
  // core + meta targets above STILL evaluate here unchanged (the exchange identity the contract pins).
  invariants.push(checkExchangeLoses(seed))
  invariants.push(checkExchangeGated(seed))
  invariants.push(checkExchangeDeterminism(seed))
  invariants.push(checkExchangeInert(seed))

  // M5.1 automation (idle routines) — a SEPARATE coverage run with the three gateways
  // unlocked and every toggle ON (the main run keeps automation OFF, so the targets above are
  // untouched). Asserts each routine demonstrably fires (auto build/recruit/attack) and that
  // the seeded scenario stays NaN/negative/over-cap/softlock-free throughout, then pairs it
  // with the offline/online byte-identity proof — the determinism the brief requires.
  const automation = runAutomationCoverage(seed, AUTOMATION_SECONDS)
  invariants.push(...automation.invariants)
  invariants.push(checkAutomationDeterminism(seed, AUTOMATION_SECONDS))

  // M5.2 wall (defensive building) + scouts (recon unit) — three deterministic proof-of-mechanic
  // checks (no bot, no RNG). The MAIN run above is untouched (the bot already builds the wall
  // there; it never recruits scouts), so the 17 balance goals stay measured on the pre-M5.2
  // path. These assert: a wall strictly mitigates raid losses vs an identical wall-less village
  // (wall-mitigates), a scout march reveals its target and returns unharmed without fighting or
  // looting (scout-reveals), and the wall + an in-flight scout march replay byte-identically
  // online vs chunked-offline (m52-determinism).
  invariants.push(checkWallMitigation(seed))
  invariants.push(checkScoutReveals(seed))
  invariants.push(checkM52Determinism(seed, OFFLINE_CHECK_SECONDS))

  // M5.3 siege (ram + catapult) — three deterministic proof-of-mechanic checks (no bot, no RNG).
  // The MAIN run above is untouched (the bot never fields siege: it is academy-gated and never
  // the cheapest recruit, and auto-attack explicitly excludes ram/catapult), so the 17 balance
  // goals stay measured on the pre-M5.3 path. These assert: a ram column cracks a camp the same
  // ramless army cannot beat — purely via the lowered effective defence (ram-cracks); a won
  // catapult attack permanently lowers the camp's level with a >= 1 clamp, while a catapult-less
  // win and a loss leave it intact (catapult-razes); and a wall-cracking + level-razing siege
  // march replays byte-identically online vs chunked-offline (m53-determinism).
  invariants.push(checkRamCracks(seed))
  invariants.push(checkCatapultRazes(seed))
  invariants.push(checkM53Determinism(seed, OFFLINE_CHECK_SECONDS))

  // M7 fortress (finite boss targets) — deterministic proof-of-mechanic checks (no bot, no RNG
  // beyond the seeded combat luck). Fortresses are an additive separate array from a separate
  // rng stream, so a no-fortress run is byte-identical to pre-M7 (the world-consistency /
  // determinism / round-trip checks above stay unchanged). These assert: the fortress world is
  // well-shaped + deterministic from the seed with the barbarian list byte-identical
  // (fortress-determinism); a (razed) fortress survives the real save/load path
  // (fortress-save-load); and a winning assault razes the boss exactly once, refuses any second
  // assault, and never strands the run (fortress-raze-once). The bot-driven fortress assaults are
  // exercised on the MAIN run above (their well-shapedness sampled via checkFortressConsistency).
  invariants.push(checkFortressDeterminism(seed))
  invariants.push(checkFortressSaveLoad(seed))
  invariants.push(checkFortressRazeOnce(seed))

  // M7.2 hordes (telegraphed, escalating capital invasion) — deterministic proof-of-mechanic
  // checks (no bot, only the seeded combat luck). Hordes are an ALWAYS-ON pressure that runs in
  // the deterministic tick sub-step. These isolate the horde primitive's own guarantees: the
  // escalation level only ever rises by +1 per resolved horde (horde-escalation); a FORCED breach
  // steals resources + garrison but razes no building and leaves the capital playable — never a
  // softlock (horde-breach-no-softlock); the single GLOBAL horde schedule survives the real
  // save/load path byte-identically (horde-save-load); a horde resolving inside the tick replays
  // byte-identically online vs chunked-offline (horde-determinism — the INTEGRATION-level proof
  // that ACTUALLY fires a horde in the window, which the 1h offline checks above never reach since
  // their horizon is below HORDE_INTERVAL); and every meta reset re-arms the horde to its
  // fresh-start schedule so a wiped capital never inherits the previous run's escalation
  // (meta-reset-clears-horde — the central balance invariant). The bot-driven hordes are exercised
  // on the MAIN run above (they resolve every sub-step against the capital).
  invariants.push(checkHordeEscalation(seed))
  invariants.push(checkHordeBreachNoSoftlock(seed))
  invariants.push(checkHordeSaveLoad(seed))
  invariants.push(checkHordeDeterminism(seed, OFFLINE_CHECK_SECONDS))
  invariants.push(checkMetaResetClearsHorde(seed))

  // M5.4 lifetime stats + achievements. The MAIN run's deterministic tick path bumps the
  // counters (combat / founding / conquest) and runs checkAchievements every sub-step, so the
  // final primary state already carries an accumulated, settled record. We assert it ACCUMULATED
  // (the combat-loop-guaranteed counters > 0), that a SENSIBLE number of achievements unlocked,
  // that the counters AGREE with the independently log-derived combat + ledger metrics (a strong
  // correctness cross-check), and that the counters + unlocks are byte-identical online vs
  // chunked-offline on a scenario that drives every path (incl. scout + siege the bot never
  // fields). Per-window stats-valid / achievements-valid were already sampled in runContinuous;
  // the cross-seed identity is covered by the whole-state determinism / save-load checks above.
  invariants.push(checkStatsAccumulated(primary.state))
  invariants.push(checkAchievementsUnlocked(primary.state, TARGETS.minAchievementsUnlocked))

  // Cross-check: the deterministic lifetime counters must AGREE with the metrics measured
  // independently (combat from the rolling battle log, expansion from the village ledger). The
  // log diff can only ever UNDERcount (collapsing identical reports — see newBattleReports), so
  // each lifetime combat counter must be >= its log-derived peer; founding/conquest are exact on
  // both sides, so those must match exactly. A mismatch means the tick-path counters and the
  // observable game disagree — a real M5.4 bug.
  const st = primary.state.stats
  const cb = primary.stats.combat
  const ledgerConquered = Math.max(0, primary.state.villageOrder.length - 1 - primary.stats.villagesFounded)
  const xc: string[] = []
  if (st.attacksWon < cb.battlesWon) xc.push(`attacksWon ${st.attacksWon} < log wins ${cb.battlesWon}`)
  if (st.attacksLost < cb.battlesLost) xc.push(`attacksLost ${st.attacksLost} < log losses ${cb.battlesLost}`)
  if (st.raidsRepelled < cb.raidsSurvived) xc.push(`raidsRepelled ${st.raidsRepelled} < log repelled ${cb.raidsSurvived}`)
  if (st.raidsLost < cb.raidsLost) xc.push(`raidsLost ${st.raidsLost} < log through ${cb.raidsLost}`)
  if (st.villagesFounded !== primary.stats.villagesFounded) {
    xc.push(`villagesFounded ${st.villagesFounded} != founded ${primary.stats.villagesFounded}`)
  }
  if (st.villagesConquered !== ledgerConquered) {
    xc.push(`villagesConquered ${st.villagesConquered} != ledger ${ledgerConquered}`)
  }
  invariants.push({
    name: 'stats-cross-check',
    ok: xc.length === 0,
    detail:
      xc.length === 0
        ? `lifetime counters agree with log+ledger (won ${st.attacksWon}>=${cb.battlesWon}, founded ${st.villagesFounded}, conquered ${st.villagesConquered})`
        : xc.join('; '),
  })

  invariants.push(checkM54Determinism(seed, OFFLINE_CHECK_SECONDS))

  // M5.5 combat luck — deterministic proof-of-mechanic checks. The MAIN run above is untouched
  // (luck is symmetric, mean 1.0, drawn only from the persisted seeded rngState, and the bot
  // keeps a worst-luck-safe loss margin, so the 17 balance goals stay measured exactly — see the
  // balance warnings). These assert: luckFactor's distribution is the contracted +/-25% band with
  // mean ~1.0 (luck-distribution); the SAME attack wins or loses depending on the roll
  // (luck-varies); the idle auto-attack NEVER loses its army to bad luck while a luck-losable army
  // is correctly refused (auto-attack-luck-safe); and the luck-driven combat replays
  // byte-identically online vs chunked-offline with rngState advancing in lock-step
  // (luck-determinism). runOne runs per seed, so the across-seed determinism clause is covered too.
  invariants.push(checkLuckDistribution(seed))
  invariants.push(checkLuckVaries(seed))
  invariants.push(checkAutoAttackLuckSafe(seed))
  invariants.push(checkLuckDeterminism(seed, OFFLINE_CHECK_SECONDS))

  // M7: SEPARATE fortress (boss-target) run — the bot-reachability proof the main run cannot give (the
  // main loop churns its population, so its standing army never accumulates into a boss-cracking stack).
  // Single pass: it measures REACHABILITY, not save fidelity (checkFortressRazeOnce / checkFortressSaveLoad
  // already pin the engine + save paths), so no determinism/split replays are needed.
  const fortressDriveRazed = runFortress(seed, FORTRESS_TICKS, dt)

  // M10 cavalry (KAWALERIA) — a SEPARATE dedicated run, the ONLY one that ever builds the Stajnia and so
  // the ONLY one that can unlock + train the cavalry. The Stajnia is autoBuildable:false, so neither the
  // main bot (MAIN_BUILD_IDS filters it) nor the in-game auto-build ever raise it, the cavalry never
  // unlocks in the main run (cheapestRecruit can't pick a gated unit), and a no-Stajnia run is BYTE-
  // IDENTICAL to pre-M10 — so the M1–M9 + meta targets above STILL evaluate here unchanged (the cavalry
  // identity the contract pins). The run's invariants (sampled validity + the bare 'cavalry-recruited' /
  // 'cavalry-attack-won' proofs) are folded in here, and its metrics feed the cavalry balance target.
  const cavalry = runCavalry(seed, CAVALRY_TICKS)
  invariants.push(...cavalry.invariants)

  // M10 cavalry proof-of-mechanic checks (self-contained, deterministic): the cavalry is GATED on the
  // Stajnia (cavalry-gated); the appended keys are INERT in a no-Stajnia run, which round-trips to a
  // byte-identical pre-M10 save shape (cavalry-inert); the cavalry's population upkeep is counted exactly
  // (cavalry-upkeep); and a roster + in-flight march carrying cavalry survives the real save/load path
  // (cavalry-save-load).
  invariants.push(checkCavalryGated(seed))
  invariants.push(checkCavalryInert(seed))
  invariants.push(checkCavalryUpkeep(seed))
  invariants.push(checkCavalrySaveLoad(seed))

  // M13 world events (time-limited windfall OFFERS) — a SEPARATE dedicated run, the ONLY one that ever
  // builds the Wieża strażnicza (autoBuildable:false) and so the ONLY one that opens the events gate. The
  // main + meta runs never build it, so advanceEvents stays a no-op there and a no-watchtower run is BYTE-
  // IDENTICAL to pre-M13 — proven directly by events-inert on the PRIMARY run's final state below (the
  // events stream untouched, combat-luck stream therefore unchanged). The dedicated run drives the
  // offer→claim pipeline and folds in its 'events-spawned' / 'events-claimed' reachability proofs.
  const events = runEvents(seed, EVENTS_TICKS)
  invariants.push(...events.invariants)

  // M13 proof-of-mechanic checks (self-contained, deterministic — events draw from a SEPARATE seeded
  // stream, never the combat-luck stream): the MAIN run left the events stream fully INERT (no spawn, no
  // RNG draw, 0 resolved — the byte-identity guarantee, events-inert); an offer spawning through the tick
  // replays byte-identically online vs chunked-offline with the events stream advancing in lock-step
  // (events-determinism); and a state carrying a pending ACTIVE offer round-trips through the v23 save
  // (events-save-load). events-inert reads the PRIMARY run's final state (mirrors checkStatsAccumulated).
  invariants.push(checkEventsInert(primary.state, seed))
  invariants.push(checkEventsDeterminism(seed, OFFLINE_CHECK_SECONDS))
  invariants.push(checkEventsSaveLoad(seed))

  // M14 timed event buffs (the first TEMPORARY modifier) — deterministic proof-of-mechanic checks
  // (no bot, no RNG): claiming a buff folds its mods into effectiveMods (buff-applies); the buff
  // counts down on the tick grid and reverts effectiveMods byte-identically on expiry
  // (buff-expires-reverts); a watchtower'd run with a live buff replays identically online vs chunked-
  // offline (buff-determinism); and a no-watchtower run keeps events.buff null with an identity buff
  // bag, so effectiveMods stays byte-identical to pre-M14 (buff-inert, reading the PRIMARY run's state).
  invariants.push(checkBuffApplies(seed))
  invariants.push(checkBuffExpiresReverts(seed))
  invariants.push(checkBuffDeterminism(seed, OFFLINE_CHECK_SECONDS))
  invariants.push(checkBuffInert(primary.state, seed))

  // M15 forge (KUŹNIA — permanent account-wide per-unit upgrades) — a SEPARATE dedicated run, the ONLY one
  // that ever builds the Kuźnia (autoBuildable:false) and so the ONLY one that opens the unit-upgrade gate.
  // The main + meta runs never build it, so state.forge stays EMPTY and the optional `forge` combat param is
  // undefined → ×1.0 → a no-Kuźnia run is BYTE-IDENTICAL to pre-M15 — proven directly by forge-inert on the
  // PRIMARY run's final state below. The dedicated run drives the upgrade pipeline and folds in its bare
  // 'forge-upgrades-applied' reachability proof (the upgraded roster out-fights + out-defends itself).
  const forge = runForge(seed, FORGE_TICKS)
  invariants.push(...forge.invariants)

  // M15 proof-of-mechanic checks (self-contained, deterministic — upgrades draw NO rng / clock): the MAIN
  // run left the forge map empty + the ×1.0 combat identity intact, and the pre-M15-stripped save migrates
  // back byte-identically (forge-inert, reading the PRIMARY run's final state — mirrors checkEventsInert);
  // each upgrade scales attack AND defense by EXACTLY unitUpgradeMult at every level (upgrade-applies); the
  // same upgrade sequence replays byte-identically (upgrade-determinism); and a state carrying a forge map
  // survives the v25 save/load path (upgrade-save-load).
  invariants.push(checkForgeInert(primary.state, seed))
  invariants.push(checkUpgradeApplies(seed))
  invariants.push(checkUpgradeDeterminism(seed))
  invariants.push(checkUpgradeSaveLoad(seed))
  // M15 ↔ meta interaction: the per-run upgrade map must clear on prestige (ascend) AND on the great reset
  // (newEra), exactly like state.tech — otherwise a fresh run keeps free permanent upgrades with a level-0 Kuźnia.
  invariants.push(checkForgeResetsOnAscend(seed))

  const metrics = collect(
    seed,
    ticks,
    ticks * dt,
    primary.state,
    primary.stats,
    prestige.stats,
    era.stats,
    dynasty.stats,
    challenge.metrics,
    market.metrics,
    automation.stats,
    fortressDriveRazed,
    cavalry.metrics,
  )
  const ok = invariants.every((r) => r.ok)
  return { metrics, invariants, ok }
}

/** Run several seeds, one RunResult each. */
export function runMany(seeds: string[], ticks: number): RunResult[] {
  return seeds.map((seed) => runOne(seed, ticks))
}
