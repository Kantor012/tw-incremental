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
  /**
   * How many NEW villages the bot founded over the run (M2.3 expansion). 0 means the
   * founding mechanic never fired; the villages-founded balance target wants >= 1.
   */
  villagesFounded: number
  /**
   * How many barbarian villages the bot CONQUERED over the run (M2.4 conquest). Derived
   * from the village ledger — `villagesOwned - 1 (capital) - villagesFounded` — so it is
   * exact regardless of battle-log trimming. 0 means the loyalty -> capture pipeline
   * never completed; the villages-conquered balance target wants >= 1.
   */
  villagesConquered: number
  /** Player villages owned at run end (capital + founded + conquered). */
  villagesOwned: number
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
  /** New villages founded over the run (M2.3). */
  villagesFounded: number
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
  /**
   * Conquest reports (`kind:'conquer'`) seen in the rolling log (M2.4). A cross-check
   * for the authoritative {@link RunMetrics.villagesConquered} (which is derived from the
   * village ledger and never undercounts on a trimmed log).
   */
  conquests: number
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
    conquests: 0,
  }
}

/** Structural equality of two single battle reports (plain JSON — no Decimals). */
function sameReport(a: BattleReport, b: BattleReport): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

/**
 * The battle reports appended to the rolling log between two snapshots.
 *
 * The log only ever GROWS at the back and is TRIMMED at the front (marches.
 * pushBattleReport appends then drops the oldest past the cap; conquest.applyConquest
 * appends a 'conquer' report too), so `next` always shares a contiguous segment with the
 * TAIL of `prev`, and everything in `next` after that overlap is new. We recover the new
 * entries by finding the LARGEST overlap — the longest prefix of `next` equal to an
 * equally-long suffix of `prev` — and returning `next` after it.
 *
 * Largest-overlap = fewest-new, the conservative reading when repeated identical reports
 * make the join ambiguous (it can only ever UNDERcount by collapsing a run of identical
 * entries — fine for soft reporting metrics; attacksSent is counted exactly elsewhere).
 * This is robust to `prev` exceeding the cap (an untrimmed conquest push) — the case
 * where the old "append next's suffix to prev and re-trim" reconstruction fell through to
 * its treat-everything-as-new fallback and wildly OVER-counted after each capture.
 */
export function newBattleReports(prev: BattleReport[], next: BattleReport[]): BattleReport[] {
  const maxOverlap = Math.min(prev.length, next.length)
  for (let o = maxOverlap; o >= 0; o--) {
    let match = true
    for (let i = 0; i < o; i++) {
      if (!sameReport(prev[prev.length - o + i], next[i])) {
        match = false
        break
      }
    }
    if (match) return next.slice(o)
  }
  return next.slice() // no overlap at all — everything is new
}

/** Fold one battle report into a running {@link CombatStats} tally. */
export function applyReport(c: CombatStats, r: BattleReport): void {
  if (r.kind === 'attack') {
    if (r.won) c.battlesWon += 1
    else c.battlesLost += 1
    c.totalLoot = c.totalLoot.add(D(r.lootSum))
    c.unitsLost += r.losses
  } else if (r.kind === 'raid') {
    // raid: `won` is the PLAYER's view — true = repelled (survived), false = got through.
    if (r.won) c.raidsSurvived += 1
    else {
      c.raidsLost += 1
      c.raidStolen = c.raidStolen.add(D(r.looted))
    }
    c.unitsLost += r.losses
  } else {
    // conquer (M2.4): a won attack carrying a surviving noble flipped a barbarian
    // village to the player. No won/losses/loot fields — it is a capture event.
    c.conquests += 1
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
    villagesFounded: stats.villagesFounded,
    // Conquered = owned − capital − founded. Exact from the ledger (no log dependency).
    villagesConquered: Math.max(0, state.villageOrder.length - 1 - stats.villagesFounded),
    villagesOwned: state.villageOrder.length,
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
