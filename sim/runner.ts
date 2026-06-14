import { createInitialState, type GameState } from '../src/engine/state'
import { simulate } from '../src/engine/tick'
import { serialize, exportSave, importSave } from '../src/engine/save'
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
import { collect, type RunMetrics } from './metrics'

/**
 * Headless simulation runner. Drives the same `simulate` step the browser loop
 * uses, consults the bot heuristic, samples invariants periodically, and proves
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

/** Prefix invariant names with the phase that produced them, for the report. */
function tag(results: InvariantResult[], phase: string): InvariantResult[] {
  return results.map((r) => ({ ...r, name: `${phase}:${r.name}` }))
}

/**
 * One simulation step: consult the bot, apply its action, then advance time.
 * In M0 the bot always returns null so this is just `simulate`; the branch is
 * the M1 hook where a chosen purchase will mutate `state` before the tick.
 */
function step(state: GameState, dt: number): void {
  const action = chooseAction(state)
  if (action) {
    // M1: apply the purchase (building / unit / perk) to `state` here.
  }
  simulate(state, dt)
}

/**
 * Run a fresh state forward for `ticks` steps. When `withInvariants` is set,
 * samples the hard invariants every SAMPLE_EVERY steps plus once at the end.
 */
function runContinuous(
  seed: string,
  ticks: number,
  dt: number,
  withInvariants: boolean,
): { state: GameState; invariants: InvariantResult[] } {
  const state = createInitialState(seed, 0)
  const invariants: InvariantResult[] = []
  // `prevTotal` tracks the previous sample (per-window progress); `initialTotal`
  // anchors the final, run-wide progress check so it stays meaningful even when
  // `ticks` lands exactly on a sample boundary (no tail window).
  const initialTotal = totalResources(state)
  let prevTotal = initialTotal

  for (let i = 0; i < ticks; i++) {
    step(state, dt)
    if (withInvariants && (i + 1) % SAMPLE_EVERY === 0) {
      const phase = `t${i + 1}`
      invariants.push(...tag(runInvariants(state), phase))
      invariants.push(...tag([checkRoundTrip(state)], phase))
      invariants.push(...tag([checkNoSoftlock(state, prevTotal)], phase))
      prevTotal = totalResources(state)
    }
  }

  if (withInvariants) {
    invariants.push(...tag(runInvariants(state), 'final'))
    invariants.push(...tag([checkRoundTrip(state)], 'final'))
    invariants.push(...tag([checkNoSoftlock(state, initialTotal)], 'final'))
  }

  return { state, invariants }
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
 *  - periodic + final resource/round-trip samples,
 *  - 'save-load-continuation': continuous run vs split-with-save run,
 *  - 'determinism': two identical continuous runs must serialize equally.
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

  const metrics = collect(seed, ticks, ticks * dt, primary.state)
  const ok = invariants.every((r) => r.ok)
  return { metrics, invariants, ok }
}

/** Run several seeds, one RunResult each. */
export function runMany(seeds: string[], ticks: number): RunResult[] {
  return seeds.map((seed) => runOne(seed, ticks))
}
