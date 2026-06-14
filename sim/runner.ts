import {
  createInitialState,
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
import type { UnitId } from '../src/content/units'
import { TARGETS } from './targets'
import {
  runInvariants,
  checkArmyConsistency,
  checkWorldConsistency,
  checkVillagePlacement,
  checkRoundTrip,
  checkNoSoftlock,
  checkOfflineDeterminism,
  checkMarchesTerminate,
  contentConsumed,
  totalResources,
  type InvariantResult,
} from './invariants'
import { chooseAction, chooseFounding } from './bot'
import {
  collect,
  emptyCombatStats,
  newBattleReports,
  applyReport,
  type CombatStats,
  type RunMetrics,
  type RunStats,
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

/** What one {@link step} did: building upgrades bought, units ordered, attacks sent, villages founded. */
interface StepResult {
  built: number
  recruited: number
  attacked: number
  founded: number
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
function step(state: GameState, dt: number, recruited: Record<UnitId, number>): StepResult {
  let built = 0
  let rec = 0
  let attacked = 0
  let founded = 0
  let actions = 0
  const v = state.villages[state.villageOrder[0]]
  while (actions < MAX_ACTIONS_PER_STEP) {
    const action = chooseAction(v, state.world)
    if (action === null) break
    if (action.kind === 'build') {
      if (!build(v, action.id)) break
      built++
    } else if (action.kind === 'recruit') {
      if (!recruit(v, action.unitId, action.count)) break
      recruited[action.unitId] += action.count
      rec += action.count
    } else if (action.kind === 'attack') {
      // attack: dispatch the home army at a CONCRETE barbarian village on the world
      // map (loot source + unit sink); travel time is the Euclidean distance to it.
      if (!sendAttack(v, state.world, state.battleLog, action.targetId, action.units)) break
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

  simulate(state, dt)
  return { built, recruited: rec, attacked, founded }
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
    const { built, recruited, attacked, founded } = step(state, dt, unitsRecruited)
    upgradesBought += built
    totalRecruited += recruited
    villagesFounded += founded
    actedInWindow += built + recruited + attacked + founded
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
  for (let i = 0; i < half; i++) step(state, dt, scratch)
  state = importSave(exportSave(state))
  for (let i = half; i < ticks; i++) step(state, dt, scratch)
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

  const metrics = collect(seed, ticks, ticks * dt, primary.state, primary.stats)
  const ok = invariants.every((r) => r.ok)
  return { metrics, invariants, ok }
}

/** Run several seeds, one RunResult each. */
export function runMany(seeds: string[], ticks: number): RunResult[] {
  return seeds.map((seed) => runOne(seed, ticks))
}
