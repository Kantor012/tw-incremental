import type { GameState } from './state'
import { RESOURCE_IDS } from './state'
import { isFiniteDecimal } from './decimal'

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
}
