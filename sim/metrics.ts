import { ZERO, type Decimal } from '../src/engine/decimal'
import { createInitialState, RESOURCE_IDS, type GameState } from '../src/engine/state'
import { BUILDING_IDS } from '../src/content/buildings'

/**
 * Balance metrics captured at the end of a run. Decimals are stored as their
 * exact `.toString()` form so the report stays loss-free and JSON-friendly.
 */
export interface RunMetrics {
  seed: string
  ticks: number
  simSeconds: number
  /** Final resource amounts, keyed by resource id, as exact decimal strings. */
  resources: Record<string, string>
  /** How many building upgrades the bot purchased over the whole run. */
  upgradesBought: number
  /** Total production/second at run start (all buildings at their initial level). */
  productionStart: string
  /** Total production/second at run end — compare to start for the growth target. */
  productionEnd: string
  /** Final owned level per building (source-of-truth economy input). */
  buildings: Record<string, number>
  /**
   * Sampled windows in which progress occurred (resources grew OR an upgrade was
   * bought). Paired with {@link windowCount} for the no-plateau target.
   */
  windowsWithProgress: number
  /** Number of sampled windows (the denominator for the no-plateau ratio). */
  windowCount: number
}

/** Per-run counters the runner threads into {@link collect}. */
export interface RunStats {
  upgradesBought: number
  windowsWithProgress: number
  windowCount: number
}

/** Total production/second across all resources (Decimal, exact). */
export function totalProduction(state: GameState): Decimal {
  let total = ZERO
  for (const id of RESOURCE_IDS) total = total.add(state.production[id])
  return total
}

/** Snapshot the final state plus run counters into a JSON-friendly metrics record. */
export function collect(
  seed: string,
  ticks: number,
  simSeconds: number,
  state: GameState,
  stats: RunStats,
): RunMetrics {
  const resources: Record<string, string> = {}
  for (const id of RESOURCE_IDS) {
    resources[id] = state.resources[id].toString()
  }

  const buildings: Record<string, number> = {}
  for (const id of BUILDING_IDS) {
    buildings[id] = state.buildings[id]
  }

  // Start production is the initial economy (all buildings at INITIAL_BUILDINGS);
  // a fresh state reproduces it deterministically without retaining run history.
  const start = createInitialState(seed, 0)

  return {
    seed,
    ticks,
    simSeconds,
    resources,
    upgradesBought: stats.upgradesBought,
    productionStart: totalProduction(start).toString(),
    productionEnd: totalProduction(state).toString(),
    buildings,
    windowsWithProgress: stats.windowsWithProgress,
    windowCount: stats.windowCount,
  }
}
