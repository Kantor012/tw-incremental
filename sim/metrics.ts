import { ZERO, type Decimal } from '../src/engine/decimal'
import { createInitialState, RESOURCE_IDS, type GameState } from '../src/engine/state'
import { BUILDING_IDS } from '../src/content/buildings'
import { UNIT_IDS, type UnitId } from '../src/content/units'
import { usedPopulation } from '../src/systems/recruitment'

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
  /** Final TRAINED unit count per id (state.units — completed orders only). */
  units: Record<string, number>
  /**
   * Units the bot ORDERED over the run, per id — the recruitment-sink throughput.
   * Distinct from {@link units}: an order counts here when it is placed, but only
   * lands in {@link units} once trained. Use this to assert the sink was exercised.
   */
  unitsRecruited: Record<string, number>
  /** Sum of {@link unitsRecruited} across all unit types. */
  unitsRecruitedTotal: number
  /** Population committed at run end (trained + queued), exact decimal string. */
  usedPopulation: string
  /** Population cap at run end (farm-derived), exact decimal string. */
  popCap: string
  /**
   * First SAMPLED tick at which {@link contentConsumed} held (all buildings maxed
   * AND population permanently full) — the M1.2 content frontier — or null if the
   * run never reached it within the budget. Granularity is the sample interval.
   */
  contentFrontierTick: number | null
  /**
   * Sampled windows in which progress occurred (resources grew OR a build/recruit
   * happened). Paired with {@link windowCount} for the no-plateau target.
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
  /** Units the bot ordered over the run, per id. */
  unitsRecruited: Record<UnitId, number>
  /** First sampled tick at which the content frontier held, or null. */
  contentFrontierTick: number | null
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

  const units: Record<string, number> = {}
  const unitsRecruited: Record<string, number> = {}
  let unitsRecruitedTotal = 0
  for (const id of UNIT_IDS) {
    units[id] = state.units[id]
    unitsRecruited[id] = stats.unitsRecruited[id]
    unitsRecruitedTotal += stats.unitsRecruited[id]
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
    units,
    unitsRecruited,
    unitsRecruitedTotal,
    usedPopulation: usedPopulation(state).toString(),
    popCap: state.popCap.toString(),
    contentFrontierTick: stats.contentFrontierTick,
    windowsWithProgress: stats.windowsWithProgress,
    windowCount: stats.windowCount,
  }
}
