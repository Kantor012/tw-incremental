import { D, ZERO, type Decimal } from '../src/engine/decimal'
import {
  createInitialState,
  RESOURCE_IDS,
  type GameState,
  type Village,
  type BattleReport,
} from '../src/engine/state'
import { BUILDING_IDS } from '../src/content/buildings'
import { UNIT_IDS, type UnitId } from '../src/content/units'
import { usedPopulation } from '../src/systems/recruitment'

/** The first (capital) village — the one the bot drives. */
function firstVillage(state: GameState): Village {
  return state.villages[state.villageOrder[0]]
}

/**
 * Balance metrics captured at the end of a run. Decimals are stored as their
 * exact `.toString()` form so the report stays loss-free and JSON-friendly.
 */
export interface RunMetrics {
  seed: string
  ticks: number
  simSeconds: number
  /**
   * Final resource amounts, keyed by resource id, as exact decimal strings —
   * SUMMED across every village (the run-wide economy total). One village in M2.1.
   */
  resources: Record<string, string>
  /** How many building upgrades the bot purchased over the whole run. */
  upgradesBought: number
  /** Total production/second at run start, summed across all villages (initial levels). */
  productionStart: string
  /** Total production/second at run end (summed across villages) — vs start for growth. */
  productionEnd: string
  /** Final owned level per building for the CAPITAL (first village; levels are per-village). */
  buildings: Record<string, number>
  /** Final TRAINED unit count per id, SUMMED across villages (completed orders only). */
  units: Record<string, number>
  /**
   * Units the bot ORDERED over the run, per id — the recruitment-sink throughput.
   * Distinct from {@link units}: an order counts here when it is placed, but only
   * lands in {@link units} once trained. Use this to assert the sink was exercised.
   */
  unitsRecruited: Record<string, number>
  /** Sum of {@link unitsRecruited} across all unit types. */
  unitsRecruitedTotal: number
  /** Population committed at run end in the CAPITAL (trained + queued), exact decimal string. */
  usedPopulation: string
  /** Population cap at run end in the CAPITAL (farm-derived), exact decimal string. */
  popCap: string
  /**
   * First SAMPLED tick at which {@link contentConsumed} held (all buildings maxed
   * AND population permanently full) — the M1.2 content frontier — or null if the
   * run never reached it within the budget. Granularity is the sample interval.
   */
  contentFrontierTick: number | null
  /**
   * Sampled windows in which progress occurred (resources grew OR a
   * build/recruit/attack happened). Paired with {@link windowCount} for no-plateau.
   */
  windowsWithProgress: number
  /** Number of sampled windows (the denominator for the no-plateau ratio). */
  windowCount: number

  // --- M1.3 combat ---
  /** Attacks the bot dispatched against barbarian camps over the run. */
  attacksSent: number
  /** Resolved attacks the player WON (camp cleared). */
  battlesWon: number
  /** Resolved attacks the player LOST (army wiped at the wall). */
  battlesLost: number
  /** Total loot HAULED home from won attacks, summed across resources (exact string). */
  totalLoot: string
  /** Incoming raids REPELLED with no loss (player won the defence). */
  raidsSurvived: number
  /** Incoming raids that GOT THROUGH (stole resources / killed garrison). */
  raidsLost: number
  /** Total resources STOLEN by successful raids, summed (exact string). */
  raidStolen: string
  /** Total own units lost to combat (battle casualties + raid casualties). */
  unitsLost: number
  /** Final army head-count (Σ {@link units}) — what survived to the end. */
  finalArmyTotal: number
  /**
   * Whether the (now combat-dissolved) M1.2 content frontier was ever reached. In
   * M1.3 this MUST be false in a long run — the recruit -> attack/raid -> recruit
   * loop keeps the loop open without bound (see invariants.contentConsumed).
   */
  reachedContentFrontier: boolean
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
  /** Cumulative combat tally over the whole run (see {@link CombatStats}). */
  combat: CombatStats
}

/**
 * Running combat tally accumulated by the runner from the rolling battle log. Decimal
 * sums (loot / stolen) are live {@link Decimal} here and serialised to exact strings
 * by {@link collect}; everything else is a plain counter.
 */
export interface CombatStats {
  attacksSent: number
  battlesWon: number
  battlesLost: number
  totalLoot: Decimal
  raidsSurvived: number
  raidsLost: number
  raidStolen: Decimal
  unitsLost: number
}

/** A fresh zeroed combat tally. */
export function emptyCombatStats(): CombatStats {
  return {
    attacksSent: 0,
    battlesWon: 0,
    battlesLost: 0,
    totalLoot: ZERO,
    raidsSurvived: 0,
    raidsLost: 0,
    raidStolen: ZERO,
    unitsLost: 0,
  }
}

/** Structural equality of two battle logs (plain JSON — no Decimals in a report). */
function sameLog(a: BattleReport[], b: BattleReport[]): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

/**
 * The battle reports appended to the rolling log between two snapshots.
 *
 * The log is append-then-trim-to-20 (see marches.pushBattleReport), so once it is at
 * the cap a naive `length` delta undercounts. With dt=1 only a handful of events can
 * occur per step (raids fire at most every 600s; a march emits one report when its
 * outbound leg completes), far below the cap, so the number ADDED is small. We
 * recover it as the smallest `k` for which appending `next`'s last `k` entries to
 * `prev` and re-trimming reproduces `next` exactly. This is exact whenever the log is
 * not yet full (`k = next.length - prev.length`); on a full, trimmed log the smallest
 * `k` is the true count except in the degenerate case of an identical-entry suffix,
 * where it can undercount by a few — acceptable here since these are reporting metrics
 * / soft targets, not hard invariants (attacksSent is counted exactly elsewhere).
 */
export function newBattleReports(prev: BattleReport[], next: BattleReport[], cap = 20): BattleReport[] {
  for (let k = 0; k <= next.length; k++) {
    const added = next.slice(next.length - k)
    const combined = prev.concat(added)
    const trimmed = combined.slice(Math.max(0, combined.length - cap))
    if (sameLog(trimmed, next)) return added
  }
  return next.slice() // unreachable in practice; treat all as new
}

/** Fold one battle report into a running {@link CombatStats} tally. */
export function applyReport(c: CombatStats, r: BattleReport): void {
  if (r.kind === 'attack') {
    if (r.won) c.battlesWon += 1
    else c.battlesLost += 1
    c.totalLoot = c.totalLoot.add(D(r.lootSum))
    c.unitsLost += r.losses
  } else {
    // raid: `won` is the PLAYER's view — true = repelled (survived), false = got through.
    if (r.won) c.raidsSurvived += 1
    else {
      c.raidsLost += 1
      c.raidStolen = c.raidStolen.add(D(r.looted))
    }
    c.unitsLost += r.losses
  }
}

/** Total production/second across all resources of EVERY village (Decimal, exact). */
export function totalProduction(state: GameState): Decimal {
  let total = ZERO
  for (const vid of state.villageOrder) {
    const v = state.villages[vid]
    for (const r of RESOURCE_IDS) total = total.add(v.production[r])
  }
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
  const first = firstVillage(state)

  // Resources: SUMMED across every village — the run-wide economy total (additive).
  // With the single M2.1 village this is just the capital's pool.
  const resources: Record<string, string> = {}
  for (const id of RESOURCE_IDS) {
    let sum = ZERO
    for (const vid of state.villageOrder) sum = sum.add(state.villages[vid].resources[id])
    resources[id] = sum.toString()
  }

  // Building levels: reported for the CAPITAL (first village) — a building level is
  // per-village structural state, not additive. The bot drives this village, so its
  // levels carry the M1.1/M1.2 progression targets (e.g. barracks-built).
  const buildings: Record<string, number> = {}
  for (const id of BUILDING_IDS) {
    buildings[id] = first.buildings[id]
  }

  // Units: SUMMED across villages (the total standing army); unitsRecruited is the
  // run-level order counter the bot accumulated (it only recruits in the capital).
  const units: Record<string, number> = {}
  const unitsRecruited: Record<string, number> = {}
  let unitsRecruitedTotal = 0
  let finalArmyTotal = 0
  for (const id of UNIT_IDS) {
    let owned = 0
    for (const vid of state.villageOrder) owned += state.villages[vid].units[id]
    units[id] = owned
    finalArmyTotal += owned
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
    usedPopulation: usedPopulation(first).toString(),
    popCap: first.popCap.toString(),
    contentFrontierTick: stats.contentFrontierTick,
    windowsWithProgress: stats.windowsWithProgress,
    windowCount: stats.windowCount,

    attacksSent: stats.combat.attacksSent,
    battlesWon: stats.combat.battlesWon,
    battlesLost: stats.combat.battlesLost,
    totalLoot: stats.combat.totalLoot.toString(),
    raidsSurvived: stats.combat.raidsSurvived,
    raidsLost: stats.combat.raidsLost,
    raidStolen: stats.combat.raidStolen.toString(),
    unitsLost: stats.combat.unitsLost,
    finalArmyTotal,
    reachedContentFrontier: stats.contentFrontierTick !== null,
  }
}
