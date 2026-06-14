import type { GameState } from './state'
import { RESOURCE_IDS } from './state'
import { isFiniteDecimal } from './decimal'
import { advanceRecruitment } from '../systems/recruitment'

/**
 * Fixed simulation step shared by the live loop and offline catch-up: 20 ticks
 * per second. Kept here (the low-level sim module) so loop.ts and offline.ts can
 * advance in identical steps without importing the browser-only loop.
 */
export const TICK_RATE = 1 / 20

/**
 * Advance the economy by `dtSeconds` of game time, mutating `state` in place.
 *
 * Pure (no I/O, no DOM, no clock reads) and Node-safe so the same code path
 * runs in the browser loop, offline catch-up and the headless sim harness.
 * Resources accrue at their per-second production rate and are clamped to the
 * shared storage cap so they never exceed it.
 *
 * After production, in-flight unit training advances. Production is linear, so a
 * single `dt` step is exact. Recruitment is NOT linear (iterative float
 * subtraction with integer completion boundaries), so feeding it a raw `dt` would
 * make the result depend on the caller's step granularity — the live loop / offline
 * step at TICK_RATE while the sim harness uses a coarser dt, and the two would
 * diverge by up to one unit per in-flight order. To keep online / offline / sim
 * byte-identical, recruitment is advanced on the SAME fixed TICK_RATE grid the
 * offline catch-up uses (floor(dt/TICK_RATE) whole steps + one remainder), so
 * `simulate(big)` equals the chunked offline path regardless of how `dt` is sliced.
 */
export function simulate(state: GameState, dtSeconds: number): void {
  // Reject zero, negative AND NaN (NaN <= 0 is false, and Decimal.add(NaN) === 0,
  // so a NaN dt would silently wipe every resource — see offline boot path).
  if (!(dtSeconds > 0)) return

  for (const id of RESOURCE_IDS) {
    const rate = state.production[id]
    // A corrupt non-finite production rate must not poison resources.
    if (!isFiniteDecimal(rate)) continue
    const gain = rate.mul(dtSeconds)
    let next = state.resources[id].add(gain)
    if (next.gt(state.storageCap)) next = state.storageCap
    state.resources[id] = next
  }

  // Advance training on the fixed TICK_RATE grid, mirroring applyOffline's
  // decomposition exactly so the recruitment timeline is a pure function of elapsed
  // game time, not of the caller's `dt` size. Each call is a no-op when the queue is
  // empty. (advanceRecruitment itself still tolerates any dt when called directly.)
  const fullSteps = Math.floor(dtSeconds / TICK_RATE)
  for (let i = 0; i < fullSteps; i++) advanceRecruitment(state, TICK_RATE)
  const remainder = dtSeconds - fullSteps * TICK_RATE
  if (remainder > 0) advanceRecruitment(state, remainder)
}
