import { RESOURCE_IDS, type GameState } from '../src/engine/state'

/**
 * Balance metrics captured at the end of a run. Decimals are stored as their
 * exact `.toString()` form so the report stays loss-free and JSON-friendly.
 * M1+ will extend this with milestone timings and production-curve samples.
 */
export interface RunMetrics {
  seed: string
  ticks: number
  simSeconds: number
  /** Final resource amounts, keyed by resource id, as exact decimal strings. */
  resources: Record<string, string>
}

/** Snapshot the final state into a JSON-friendly metrics record. */
export function collect(
  seed: string,
  ticks: number,
  simSeconds: number,
  state: GameState,
): RunMetrics {
  const resources: Record<string, string> = {}
  for (const id of RESOURCE_IDS) {
    resources[id] = state.resources[id].toString()
  }
  return { seed, ticks, simSeconds, resources }
}
