import { simulate, TICK_RATE } from './tick'
import type { GameState } from './state'

/** Maximum offline time credited on return — limit from DESIGN.md (8 hours). */
export const MAX_OFFLINE_SECONDS = 8 * 60 * 60

/**
 * Credit progress for the time elapsed since the run was last seen.
 *
 * `now` is passed in (epoch ms) rather than read from a clock so this stays
 * Node-safe and deterministic in tests. Elapsed time is capped at
 * MAX_OFFLINE_SECONDS and advanced in the SAME fixed `TICK_RATE` steps the live
 * loop uses (plus a final sub-tick remainder), so offline catch-up and online
 * play produce byte-identical state even once production becomes state-dependent
 * (M1+). `lastSeen` is advanced. Returns the number of seconds simulated.
 */
export function applyOffline(state: GameState, now: number): number {
  const elapsedMs = now - state.lastSeen
  // `!(... > 0)` also rejects NaN (e.g. a corrupt/missing lastSeen): without it
  // seconds would be NaN and a NaN dt would zero every resource.
  if (!(elapsedMs > 0)) return 0

  const seconds = Math.min(elapsedMs / 1000, MAX_OFFLINE_SECONDS)
  const fullSteps = Math.floor(seconds / TICK_RATE)
  for (let i = 0; i < fullSteps; i++) simulate(state, TICK_RATE)
  const remainder = seconds - fullSteps * TICK_RATE
  if (remainder > 0) simulate(state, remainder)

  state.lastSeen = now
  return seconds
}
