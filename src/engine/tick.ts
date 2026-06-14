import type { GameState } from './state'
import { RESOURCE_IDS } from './state'
import { isFiniteDecimal } from './decimal'
import { advanceRecruitment } from '../systems/recruitment'
import { advanceMarches } from '../systems/marches'
import { advanceRaids } from '../systems/raids'

/**
 * Fixed simulation step shared by the live loop and offline catch-up: 20 ticks
 * per second. Kept here (the low-level sim module) so loop.ts and offline.ts can
 * advance in identical steps without importing the browser-only loop.
 */
export const TICK_RATE = 1 / 20

/**
 * One fixed sub-step of length `dt` (TICK_RATE, or a final sub-tick remainder):
 * production → recruitment → marches → raids, in that fixed order.
 *
 * EVERYTHING advances here, not just the step-sensitive subsystems, because combat
 * (marches deliver loot, raids steal resources) now READS AND WRITES the same
 * resource pool that production fills and the storage cap clamps. Once two systems
 * touch resources, the order in which production and combat interleave across a span
 * affects the clamped result — so production can no longer be a single up-front
 * `rate*dt` step (that would let a big `simulate(N)` clamp differently from N small
 * online steps). Sub-stepping production on the SAME grid as combat makes every span
 * decompose into one identical ordered list of sub-steps regardless of how `dt` is
 * sliced, which is exactly what keeps online / offline / sim byte-identical. (Linear
 * production summed over the grid still equals `rate*dt` exactly on Decimal — the
 * existing production tests hold.)
 */
function subStep(state: GameState, dt: number): void {
  for (const id of RESOURCE_IDS) {
    const rate = state.production[id]
    // A corrupt non-finite production rate must not poison resources.
    if (!isFiniteDecimal(rate)) continue
    let next = state.resources[id].add(rate.mul(dt))
    if (next.gt(state.storageCap)) next = state.storageCap
    state.resources[id] = next
  }
  // Each is a no-op when its subsystem is idle (empty queue / no marches / village
  // not yet worth raiding), so the steady state stays cheap.
  advanceRecruitment(state, dt)
  advanceMarches(state, dt)
  advanceRaids(state, dt)
}

/**
 * Advance the whole simulation by `dtSeconds` of game time, mutating `state`.
 *
 * Pure (no I/O, no DOM, no clock reads, no RNG) and Node-safe so the same code path
 * runs in the browser loop, offline catch-up and the headless sim harness. The span
 * is decomposed onto the fixed TICK_RATE grid (floor(dt/TICK_RATE) whole sub-steps +
 * one remainder) and {@link subStep} runs production, recruitment, marches and raids
 * together each sub-step. Because applyOffline drives the SAME grid (it calls
 * simulate(TICK_RATE) repeatedly), `simulate(big)` and the chunked offline path
 * resolve to an identical ordered list of sub-steps — the guarantee the offline /
 * combat determinism invariants assert.
 */
export function simulate(state: GameState, dtSeconds: number): void {
  // Reject zero, negative AND NaN (NaN <= 0 is false, and Decimal.add(NaN) === 0,
  // so a NaN dt would silently wipe every resource — see offline boot path).
  if (!(dtSeconds > 0)) return

  const fullSteps = Math.floor(dtSeconds / TICK_RATE)
  for (let i = 0; i < fullSteps; i++) subStep(state, TICK_RATE)
  const remainder = dtSeconds - fullSteps * TICK_RATE
  if (remainder > 0) subStep(state, remainder)
}
