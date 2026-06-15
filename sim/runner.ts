import {
  createInitialState,
  recomputeDerived,
  INITIAL_UNITS,
  type GameState,
  type BattleReport,
} from '../src/engine/state'
import { simulate } from '../src/engine/tick'
import { serialize, exportSave, importSave } from '../src/engine/save'
import { build } from '../src/systems/buildings'
import { recruit } from '../src/systems/recruitment'
import { sendAttack } from '../src/systems/marches'
import { foundVillage } from '../src/systems/villages'
import { purchaseTech } from '../src/systems/tech'
import {
  effectiveMods,
  ascend,
  purchasePrestige,
  startResourceBonus,
  prestigeNodeLevel,
} from '../src/systems/prestige'
import { PRESTIGE_NODE_IDS } from '../src/content/prestige'
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
  checkTechTree,
  checkTechState,
  checkPrestigeTree,
  checkPrestigeState,
  checkAscendValid,
  contentConsumed,
  totalResources,
  type InvariantResult,
} from './invariants'
import {
  chooseAction,
  chooseFounding,
  chooseConquest,
  chooseTech,
  chooseAscend,
  choosePrestige,
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
      invariants.push(...tag([checkVillagePlacement(state)], phase))
      invariants.push(...tag([checkLoyalty(state)], phase))
      invariants.push(...tag([checkTechState(state)], phase))
      invariants.push(...tag([checkRoundTrip(state)], phase))
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
    invariants.push(...tag([checkVillagePlacement(state)], 'final'))
    invariants.push(...tag([checkLoyalty(state)], 'final'))
    invariants.push(...tag([checkTechState(state)], 'final'))
    invariants.push(...tag([checkRoundTrip(state)], 'final'))
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

/**
 * Run a single seed for `ticks` steps and assemble all invariants:
 *  - periodic + final resource/army-consistency/world-consistency/round-trip/no-softlock samples,
 *  - 'save-load-continuation': continuous run vs split-with-save run,
 *  - 'determinism': two identical continuous runs must serialize equally,
 *  - 'offline-determinism': chunked offline catch-up vs one big step (combat-armed),
 *  - 'marches-terminate': a dispatched army always resolves within bounded time.
 */
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

  const metrics = collect(seed, ticks, ticks * dt, primary.state, primary.stats, prestige.stats)
  const ok = invariants.every((r) => r.ok)
  return { metrics, invariants, ok }
}

/** Run several seeds, one RunResult each. */
export function runMany(seeds: string[], ticks: number): RunResult[] {
  return seeds.map((seed) => runOne(seed, ticks))
}
