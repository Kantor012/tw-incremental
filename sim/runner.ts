import { createInitialState, type GameState } from '../src/engine/state'
import { simulate } from '../src/engine/tick'
import { serialize, exportSave, importSave } from '../src/engine/save'
import { build } from '../src/systems/buildings'
import { TARGETS } from './targets'
import {
  runInvariants,
  checkRoundTrip,
  checkNoSoftlock,
  checkOfflineDeterminism,
  totalResources,
  type InvariantResult,
} from './invariants'
import { chooseAction } from './bot'
import { collect, type RunMetrics, type RunStats } from './metrics'

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
 * Upper bound on purchases the bot makes in a single step. The greedy loop
 * already stops as soon as nothing is affordable; this cap just bounds the work
 * per step when a windfall (e.g. after a long idle stretch) would otherwise let
 * the bot buy a long run of cheap levels at once.
 */
const MAX_ACTIONS_PER_STEP = 8

/** Prefix invariant names with the phase that produced them, for the report. */
function tag(results: InvariantResult[], phase: string): InvariantResult[] {
  return results.map((r) => ({ ...r, name: `${phase}:${r.name}` }))
}

/**
 * One simulation step: the bot spends greedily (cheapest affordable building,
 * repeatedly, up to {@link MAX_ACTIONS_PER_STEP}) BEFORE time advances — matching
 * a player who acts at the top of a tick — then `simulate` accrues production.
 * Returns how many upgrades were bought, so the caller can track progress.
 */
function step(state: GameState, dt: number): number {
  let bought = 0
  while (bought < MAX_ACTIONS_PER_STEP) {
    const action = chooseAction(state)
    if (action === null) break
    if (!build(state, action.id)) break
    bought++
  }
  simulate(state, dt)
  return bought
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
  // Upgrades bought since the last sample — a window with purchases counts as
  // progress even if the spend left the resource sum lower than the prior sample.
  let boughtInWindow = 0
  let windowsWithProgress = 0
  let windowCount = 0

  for (let i = 0; i < ticks; i++) {
    const bought = step(state, dt)
    upgradesBought += bought
    boughtInWindow += bought

    if (withInvariants && (i + 1) % SAMPLE_EVERY === 0) {
      const phase = `t${i + 1}`
      const grew = totalResources(state).gt(prevTotal)
      invariants.push(...tag(runInvariants(state), phase))
      invariants.push(...tag([checkRoundTrip(state)], phase))
      invariants.push(...tag([checkNoSoftlock(state, prevTotal, boughtInWindow > 0)], phase))

      windowCount += 1
      if (grew || boughtInWindow > 0) windowsWithProgress += 1

      prevTotal = totalResources(state)
      boughtInWindow = 0
    }
  }

  if (withInvariants) {
    invariants.push(...tag(runInvariants(state), 'final'))
    invariants.push(...tag([checkRoundTrip(state)], 'final'))
    // Whole-run progress: any upgrade bought ever, or resources above the start.
    invariants.push(...tag([checkNoSoftlock(state, initialTotal, upgradesBought > 0)], 'final'))
  }

  return { state, invariants, stats: { upgradesBought, windowsWithProgress, windowCount } }
}

/**
 * Run to the halfway point, persist via the real export/import (base64) path,
 * then continue to `ticks`. The total step count matches a continuous run
 * regardless of parity, so any divergence is a save/load fault.
 */
function runSplit(seed: string, ticks: number, dt: number): GameState {
  const half = Math.floor(ticks / 2)
  let state = createInitialState(seed, 0)
  for (let i = 0; i < half; i++) step(state, dt)
  state = importSave(exportSave(state))
  for (let i = half; i < ticks; i++) step(state, dt)
  return state
}

/**
 * Run a single seed for `ticks` steps and assemble all invariants:
 *  - periodic + final resource/round-trip/no-softlock samples,
 *  - 'save-load-continuation': continuous run vs split-with-save run,
 *  - 'determinism': two identical continuous runs must serialize equally,
 *  - 'offline-determinism': chunked offline catch-up vs one big step.
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

  // Offline parity: one big catch-up step must equal the chunked offline path.
  invariants.push(checkOfflineDeterminism(seed, OFFLINE_CHECK_SECONDS))

  const metrics = collect(seed, ticks, ticks * dt, primary.state, primary.stats)
  const ok = invariants.every((r) => r.ok)
  return { metrics, invariants, ok }
}

/** Run several seeds, one RunResult each. */
export function runMany(seeds: string[], ticks: number): RunResult[] {
  return seeds.map((seed) => runOne(seed, ticks))
}
