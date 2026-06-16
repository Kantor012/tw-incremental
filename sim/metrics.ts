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
import { TECH_NODE_IDS } from '../src/content/tech'
import { ACHIEVEMENT_IDS } from '../src/content/achievements'
import { usedPopulation } from '../src/systems/recruitment'
import { aggregateTechMods, nodeLevel } from '../src/systems/tech'

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

  // --- M3.1 tech (global passive tree) ---
  /**
   * Successful tech-node level purchases the bot made over the run (one per accepted
   * {@link import('./bot').chooseTech} → purchaseTech). The tech-nodes-purchased balance
   * target wants this above a floor — proof the bot exercised the purchase path and the
   * tree is a reachable resource sink.
   */
  techPurchases: number
  /** Distinct nodes owned at level >= 1 at run end (breadth bought across the tree). */
  techNodesOwned: number
  /** Σ owned levels across the tree at run end (cross-check for {@link techPurchases}). */
  techLevelsOwned: number
  /**
   * Total production/second at run end with EVERY tech multiplier stripped — the pure
   * building economy that the same buildings/villages would yield with no tree. Paired
   * with {@link productionEnd}: when tech was bought, productionEnd MUST exceed this, i.e.
   * the economic multipliers actually fold into the simulation (the tech-uplift target).
   */
  productionBaseNoTech: string
  /**
   * Effective production uplift from tech at run end: productionEnd / productionBaseNoTech
   * (1 when no tech is owned). > 1 confirms the tree's multipliers are live.
   */
  techProductionMult: number

  // --- M4.1 prestige (ascension meta-layer) ---
  // Measured by a SEPARATE, ascension-driving run (see runner.runPrestigeContinuous) so
  // the economy/combat/tech/expansion metrics above stay measured on an un-reset run.
  /** Ascensions the bot performed over the prestige run (the prestige loop fired N times). */
  ascensions: number
  /** First tick at which the bot ascended in the prestige run, or null if it never did. */
  firstAscendTick: number | null
  /** Prestige points still banked at the end of the prestige run. */
  prestigePointsBanked: number
  /** Lifetime prestige points earned across every ascension (PERMANENT total). */
  prestigeTotalEarned: number
  /** Successful prestige-node level purchases over the prestige run (one per choosePrestige). */
  prestigePurchases: number
  /** Distinct prestige nodes owned at level >= 1 at the end of the prestige run. */
  prestigeNodesOwned: number
  /** Σ owned prestige-node levels at the end of the prestige run. */
  prestigeLevelsOwned: number
  /**
   * BONUS CONFIRMATION: production uplift the SURVIVING prestige nodes give a fresh run —
   * totalProduction(fresh capital + final prestige nodes, re-derived) / totalProduction(a
   * no-prestige fresh capital). > 1 proves the permanent prestige multipliers actually fold
   * into recomputeDerived (the economy), i.e. an ascension makes every future run stronger.
   */
  prestigeProductionMult: number
  /**
   * BONUS CONFIRMATION (the other prestige-only kind): the per-resource head-start the
   * surviving prestige nodes grant a fresh capital at ascension (Σ start_resources·level).
   * > 0 proves the start-resource bonus is live; 0 just means the bot bought no supply node.
   */
  prestigeStartResourceBonus: number

  // --- M6.1 era (great reset / second meta-layer) ---
  // Measured by a SEPARATE run (see runner.runEra) that drives BOTH ascensions and eras so
  // prestige progress accumulates and CONVERTS to eras — kept apart from the main + prestige
  // runs, which never start an era (newEra WIPES the whole prestige account), so those metrics
  // stay measured on an un-reset account.
  /** Eras the bot started (great resets) over the era run — the era loop fired N times. */
  eras: number
  /** Successful era-node level purchases over the era run (one per accepted purchaseEra). */
  eraPurchases: number
  /** Distinct era nodes owned at level >= 1 at the end of the era run. */
  eraNodesOwned: number
  /** Σ owned era-node levels at the end of the era run. */
  eraLevelsOwned: number
  /**
   * BONUS CONFIRMATION: the signature `pp_mult` era effect actually FOLDS INTO prestige-point
   * gain. The ratio pendingPrestigePoints(with a maxed pp_mult era node) / pendingPrestigePoints
   * (none), measured on a FIXED prestige score — independent of whether the bot's greedy
   * source-order buy reached the pp_mult node this run. > 1 proves each new era accelerates the
   * whole prestige loop (the era's reason to exist).
   */
  eraPpUplift: number

  // --- M6.2 dynasty (great-great reset / third meta-layer) ---
  // Measured by a SEPARATE run (see runner.runDynasty) that drives ascensions AND eras AND
  // dynasties so era progress accumulates and CONVERTS to a dynasty — kept apart from the main +
  // prestige + era runs, which never found a dynasty (newDynasty WIPES the whole era AND prestige
  // accounts), so those metrics stay measured on un-reset accounts.
  /** Dynasties the bot founded (great-great resets) over the dynasty run — the loop fired N times. */
  dynasties: number
  /** Successful dynasty-node level purchases over the dynasty run (one per accepted purchaseDynasty). */
  dynastyPurchases: number
  /** Distinct dynasty nodes owned at level >= 1 at the end of the dynasty run. */
  dynastyNodesOwned: number
  /** Σ owned dynasty-node levels at the end of the dynasty run. */
  dynastyLevelsOwned: number
  /**
   * BONUS CONFIRMATION: the signature `ep_mult` dynasty effect actually FOLDS INTO era-point gain.
   * The ratio pendingEraPoints(with a maxed ep_mult dynasty node) / pendingEraPoints(none), measured
   * on a FIXED prestige (era) score — independent of whether the bot's greedy source-order buy
   * reached the ep_mult node this run. > 1 proves each new dynasty accelerates the whole era loop
   * (the dynasty's reason to exist; mirrors {@link eraPpUplift}).
   */
  dynastyEpUplift: number
  /**
   * GATED MECHANIC: whether the dynasty `automation_unlock` gateway unlocks ALL THREE idle
   * automations account-wide — measured as `effectiveMods(fresh + the gateway node).automations`
   * all true. The dynasty bag is the ONLY aggregate that can flip the automation flags on, so true
   * proves the gate is live (every routine unlocked from the start once a dynasty owns it).
   */
  dynastyAutomationUnlocked: boolean

  // --- M8 challenge (WYZWANIA — constrained run for a permanent reward) ---
  // Measured by a SEPARATE run (see runner.runChallenge) that STARTS a challenge whose goal is
  // reachable under its constraint and drives the economy until checkChallengeCompletion fires —
  // kept apart from the main + meta runs, which never start a challenge (so aggregateChallengeMods
  // folds to identity there and their 17 core + meta targets stay byte-identical to pre-M8).
  /** Distinct challenges COMPLETED over the dedicated challenge run (Σ ids with completed >= 1). */
  challengesCompleted: number
  /**
   * GATED REWARD: whether a COMPLETED challenge's permanent reward actually raised effectiveMods on a
   * FRESH post-completion run — measured as some multiplicative axis of `effectiveMods(fresh + the
   * completed map)` strictly exceeding the no-challenge baseline. true proves the one-time reward folds
   * into every future run forever (the challenge's reason to exist; mirrors {@link dynastyAutomationUnlocked}
   * as the feature's signature gated effect).
   */
  challengeRewardActive: boolean

  // --- M9 market (RYNEK — merchant transport between own villages) ---
  // Measured by a SEPARATE run (see runner.runMarket) that builds a market, founds a second
  // village and dispatches merchant shipments — kept apart from the main + meta runs, which never
  // transport (transport is a player-initiated action that never runs in the tick and never folds
  // into effectiveMods), so a run that never transports is BYTE-IDENTICAL to pre-M9 and the 17 core
  // + meta targets stay untouched.
  /** Shipments DELIVERED over the dedicated market run (dispatched from one village, arrived at another). */
  shipmentsDelivered: number
  /** Total resources moved by the delivered shipments over the run — exact decimal string (transport throughput). */
  resourcesTransported: string

  // --- M10 cavalry (KAWALERIA — Stajnia-gated mounted units) ---
  // Measured by a SEPARATE run (see runner.runCavalry) that builds the Stajnia (excluded from the main
  // bot/auto-build set), recruits BOTH cavalry units and wins a cavalry attack — kept apart from the main
  // + meta runs, which never build the Stajnia (so the cavalry never unlocks there and a no-Stajnia run is
  // BYTE-IDENTICAL to pre-M10).
  /** Cavalry (light + heavy) EVER trained in the dedicated cavalry run — the recruitment-sink throughput. */
  cavalryRecruited: number
  /** Max Stajnia level reached in the dedicated cavalry run (the gate the main run never opens). */
  stableBuilt: number

  // --- M5.1 automation (idle routines) ---
  // Measured by a SEPARATE coverage run (see runner.runAutomationCoverage) with the three
  // automation gateways unlocked and every toggle ON — kept apart from the MAIN run, which
  // leaves automation OFF so the 17 balance goals stay measured on the pre-M5.1 game path.
  /** Building levels the AUTO-BUILD routine added over the coverage run (proof it fired). */
  automationBuilt: number
  /** Units the AUTO-RECRUIT routine trained over the coverage run (training completions). */
  automationRecruited: number
  /** Attacks the AUTO-ATTACK routine dispatched-and-resolved over the coverage run. */
  automationAttacked: number

  // --- M7 fortress (boss-target) reachability ---
  /**
   * Fortresses razed in the SEPARATE fortress-driving run (see runner.runFortress) — the bot-
   * reachability proof for the M7 boss target. Measured apart from the MAIN run on purpose: the main
   * loop CHURNS its population (recruit -> march -> attrition), so its standing army never accumulates
   * into a boss-cracking stack and {@link lifetime}.fortressesRazed stays 0 there; the dedicated run
   * instead amasses a real all-in army + the full siege train on the proven endgame economy and razes
   * the nearest far-ring fortress. The fortresses-razed balance target reads THIS, not the main run.
   */
  fortressDriveRazed: number

  // --- M7.2 hordes (telegraphed, escalating capital invasion) ---
  /**
   * Hordes REPELLED over the MAIN run — the capital's defence held the escalating
   * invasion. Read straight off the lifetime {@link import('../src/engine/state').Stats}
   * (state.stats.hordesRepelled, bumped only on the deterministic tick path, so identical
   * online/offline/sim). Mirrors {@link raidsSurvived} but for the telegraphed capital
   * horde rather than the silent per-village raid drip; the hordes-repelled balance target
   * reads THIS — a normally-progressing run should repel at least one.
   */
  hordesRepelled: number
  /** Hordes that BREACHED the capital over the MAIN run (state.stats.hordesBreached). Mirrors {@link raidsLost}. */
  hordesBreached: number
  /**
   * The horde escalation level at run end (state.horde.level). It rises by 1 after EVERY
   * horde — repelled or breached — so this is both the TOTAL hordes the run faced
   * (= hordesRepelled + hordesBreached) and the peak difficulty reached. Cross-checks the
   * two counters above.
   */
  hordeMaxLevel: number

  // --- M5.4 lifetime stats + achievements ---
  /**
   * The permanent lifetime {@link import('../src/engine/state').Stats} counters at the END of the
   * MAIN run, read straight off the final state — bumped only on the deterministic tick path, so
   * identical online/offline/sim. `lootHauled` is the Decimal lifetime haul as its exact string.
   */
  lifetime: LifetimeStatsMetrics
  /** Distinct achievements unlocked at the end of the MAIN run (Σ keys of state.achievements). */
  achievementsUnlocked: number
  /** Total achievements in the catalogue ({@link ACHIEVEMENT_IDS}.length) — the denominator. */
  achievementsTotal: number
}

/**
 * The lifetime {@link import('../src/engine/state').Stats} record flattened for the JSON report:
 * the eight integer counters as-is plus the Decimal `lootHauled` serialised to its exact string.
 */
export interface LifetimeStatsMetrics {
  attacksWon: number
  attacksLost: number
  /** Lifetime resources delivered home from marches — exact decimal string. */
  lootHauled: string
  raidsRepelled: number
  raidsLost: number
  campsRazed: number
  /** Lifetime FORTRESSES razed (M7) — the boss-target trophy counter, mirrors {@link campsRazed}. */
  fortressesRazed: number
  scoutsReturned: number
  villagesFounded: number
  villagesConquered: number
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
  /** Successful tech-node level purchases over the run (M3.1). */
  techPurchases: number
}

/**
 * Prestige (M4.1) counters from the SEPARATE ascension-driving run (see
 * runner.runPrestigeContinuous). Kept apart from {@link RunStats} because it is produced
 * by a different run than the economy/combat metrics — the main run never ascends, so its
 * targets stay measured on an un-reset economy. {@link collect} folds these straight into
 * the matching {@link RunMetrics} prestige fields.
 */
export interface PrestigeRunStats {
  /** Ascensions performed over the prestige run. */
  ascensions: number
  /** First tick the bot ascended, or null. */
  firstAscendTick: number | null
  /** Prestige points still banked at run end. */
  pointsBanked: number
  /** Lifetime prestige points earned (permanent total). */
  totalEarned: number
  /** Successful prestige-node level purchases over the run. */
  purchases: number
  /** Distinct prestige nodes owned at level >= 1 at run end. */
  nodesOwned: number
  /** Σ owned prestige-node levels at run end. */
  levelsOwned: number
  /** Production uplift the surviving prestige nodes give a fresh re-derived run (bonus proof). */
  productionMult: number
  /** Per-resource start-resource head-start the surviving prestige nodes grant (bonus proof). */
  startResourceBonus: number
}

/**
 * Era (M6.1) counters from the SEPARATE era-driving run (see runner.runEra). Kept apart from
 * {@link RunStats} / {@link PrestigeRunStats} because it is produced by a different run — the
 * only one that ever starts a Nowa Era (newEra WIPES the prestige account), so the main +
 * prestige targets stay measured on an un-reset account. {@link collect} folds these straight
 * into the matching {@link RunMetrics} era fields.
 */
export interface EraRunStats {
  /** Eras started (great resets) over the run. */
  eras: number
  /** Successful era-node level purchases over the run. */
  purchases: number
  /** Distinct era nodes owned at level >= 1 at run end. */
  nodesOwned: number
  /** Σ owned era-node levels at run end. */
  levelsOwned: number
  /** pp_mult uplift on prestige-point gain at a fixed prestige score (bonus proof; > 1 = live). */
  ppUplift: number
}

/**
 * Dynasty (M6.2) counters from the SEPARATE dynasty-driving run (see runner.runDynasty). Kept
 * apart from {@link RunStats} / {@link PrestigeRunStats} / {@link EraRunStats} because it is
 * produced by a different run — the only one that ever founds a Nowa Dynastia (newDynasty WIPES
 * the era AND prestige accounts), so the main + prestige + era targets stay measured on un-reset
 * accounts. {@link collect} folds these straight into the matching {@link RunMetrics} dynasty fields.
 */
export interface DynastyRunStats {
  /** Dynasties founded (great-great resets) over the run. */
  dynasties: number
  /** Successful dynasty-node level purchases over the run. */
  purchases: number
  /** Distinct dynasty nodes owned at level >= 1 at run end. */
  nodesOwned: number
  /** Σ owned dynasty-node levels at run end. */
  levelsOwned: number
  /** ep_mult uplift on era-point gain at a fixed era score (bonus proof; > 1 = live). */
  epUplift: number
  /** Whether the automation_unlock gateway flips all three automations on (gated mechanic; true = live). */
  automationUnlocked: boolean
}

/**
 * Challenge (M8 — WYZWANIA) counters from the SEPARATE challenge-driving run (see
 * runner.runChallenge). Kept apart from {@link RunStats} / the meta run stats because it is produced
 * by a different run — the only one that ever STARTS a challenge (which RESETS the run under a
 * constraint), so the main + meta targets stay measured with aggregateChallengeMods at identity (byte-
 * identical to pre-M8). {@link collect} folds these straight into the matching {@link RunMetrics}
 * challenge fields. Mirrors {@link EraRunStats}.
 */
export interface ChallengeRunStats {
  /** Distinct challenges completed over the run (Σ ids with completed >= 1). */
  completed: number
  /** The completed map at run end (challenge id -> times finished). */
  completedMap: Record<string, number>
  /** Whether a completed reward raised effectiveMods on a fresh post-completion run (gated proof). */
  rewardActive: boolean
}

/**
 * Market (M9 — RYNEK) counters from the SEPARATE merchant-transport run (see runner.runMarket).
 * Kept apart from {@link RunStats} / the meta run stats because it is produced by a different run —
 * the only one that ever DISPATCHES a merchant shipment (transport is a player-initiated action that
 * never runs in the tick and never folds into effectiveMods), so the main + meta targets stay
 * measured BYTE-IDENTICAL to pre-M9 (a run that never transports is unchanged). {@link collect} folds
 * these straight into the matching {@link RunMetrics} market fields. Mirrors {@link ChallengeRunStats}.
 */
export interface MarketRunStats {
  /** Shipments DELIVERED over the run (dispatched from one village, arrived at another). */
  shipmentsDelivered: number
  /** Total resources moved by the delivered shipments (Decimal, exact) — the transport throughput. */
  resourcesTransported: Decimal
}

/**
 * Cavalry (M10 — KAWALERIA) counters from the SEPARATE cavalry-driving run (see runner.runCavalry).
 * Kept apart from {@link RunStats} / the meta run stats because it is produced by a different run — the
 * only one that ever BUILDS the Stajnia (autoBuildable:false, so the main bot/auto-build never raise it)
 * and thus the only one that can UNLOCK and train the cavalry. A run that never builds the Stajnia is
 * BYTE-IDENTICAL to pre-M10 (the cavalry gate stays shut, so the main + meta runs' 17 core + meta targets
 * are untouched). {@link collect} folds these straight into the matching {@link RunMetrics} cavalry
 * fields. Mirrors {@link MarketRunStats} (a dedicated-run reachability tally).
 */
export interface CavalryRunStats {
  /** Cavalry (light + heavy) EVER trained over the dedicated run — the recruitment-sink throughput. */
  cavalryRecruited: number
  /** Max Stajnia level reached over the dedicated run (the gate the main run never opens). */
  stableBuilt: number
}

/**
 * Automation (M5.1) counters from the SEPARATE coverage run (see
 * runner.runAutomationCoverage). Kept apart from {@link RunStats} because it is produced by
 * a different run (automation ON) than the main economy/combat metrics (automation OFF), so
 * the 17 balance goals stay measured on the pre-M5.1 game path. {@link collect} folds these
 * straight into the matching {@link RunMetrics} automation fields.
 */
export interface AutomationRunStats {
  /** Building levels the auto-build routine added over the run. */
  built: number
  /** Units the auto-recruit routine trained over the run (training completions). */
  recruited: number
  /** Attacks the auto-attack routine dispatched-and-resolved over the run. */
  attacked: number
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
  } else if (r.kind === 'horde') {
    // horde (M7.2): the telegraphed capital invasion is counted from the AUTHORITATIVE
    // lifetime stats (state.stats.hordesRepelled / hordesBreached, read by collect off the
    // final state) rather than this trimmed rolling log, so we intentionally do not tally it
    // here. Handling the kind explicitly also stops the old catch-all `else` from miscounting
    // a horde report as a conquest.
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
  prestige: PrestigeRunStats,
  era: EraRunStats,
  dynasty: DynastyRunStats,
  challenge: ChallengeRunStats,
  market: MarketRunStats,
  automation: AutomationRunStats,
  fortressDriveRazed: number,
  cavalry: CavalryRunStats,
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

  // M3.1 tech roll-up. Breadth (distinct nodes >= 1) and depth (Σ levels) of the tree
  // bought, plus the no-tech production baseline: production[r] = buildingProd[r] ×
  // productionMult[r], so dividing by the multiplier recovers the pure building economy
  // — its sum vs productionEnd is the effective uplift that proves the tree is live.
  const mods = aggregateTechMods(state.tech)
  let techNodesOwned = 0
  let techLevelsOwned = 0
  for (const id of TECH_NODE_IDS) {
    const lvl = nodeLevel(state, id)
    if (lvl > 0) {
      techNodesOwned += 1
      techLevelsOwned += lvl
    }
  }
  const prodEnd = totalProduction(state)
  let prodBase = ZERO
  for (const vid of state.villageOrder) {
    const v = state.villages[vid]
    for (const r of RESOURCE_IDS) prodBase = prodBase.add(v.production[r].div(mods.productionMult[r]))
  }
  const techProductionMult = prodBase.gt(0) ? prodEnd.div(prodBase).toNumber() : 1

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

    techPurchases: stats.techPurchases,
    techNodesOwned,
    techLevelsOwned,
    productionBaseNoTech: prodBase.toString(),
    techProductionMult,

    ascensions: prestige.ascensions,
    firstAscendTick: prestige.firstAscendTick,
    prestigePointsBanked: prestige.pointsBanked,
    prestigeTotalEarned: prestige.totalEarned,
    prestigePurchases: prestige.purchases,
    prestigeNodesOwned: prestige.nodesOwned,
    prestigeLevelsOwned: prestige.levelsOwned,
    prestigeProductionMult: prestige.productionMult,
    prestigeStartResourceBonus: prestige.startResourceBonus,

    eras: era.eras,
    eraPurchases: era.purchases,
    eraNodesOwned: era.nodesOwned,
    eraLevelsOwned: era.levelsOwned,
    eraPpUplift: era.ppUplift,

    dynasties: dynasty.dynasties,
    dynastyPurchases: dynasty.purchases,
    dynastyNodesOwned: dynasty.nodesOwned,
    dynastyLevelsOwned: dynasty.levelsOwned,
    dynastyEpUplift: dynasty.epUplift,
    dynastyAutomationUnlocked: dynasty.automationUnlocked,

    challengesCompleted: challenge.completed,
    challengeRewardActive: challenge.rewardActive,

    // M9: the dedicated market run's transport throughput (resourcesTransported → exact string).
    shipmentsDelivered: market.shipmentsDelivered,
    resourcesTransported: market.resourcesTransported.toString(),

    // M10: the dedicated cavalry run's recruitment-sink throughput + the Stajnia level it reached.
    cavalryRecruited: cavalry.cavalryRecruited,
    stableBuilt: cavalry.stableBuilt,

    automationBuilt: automation.built,
    automationRecruited: automation.recruited,
    automationAttacked: automation.attacked,

    // M7: fortresses razed by the dedicated boss-target run (bot reachability).
    fortressDriveRazed,

    // M7.2: the telegraphed capital horde tally — read straight off the final MAIN-run state
    // (lifetime counters bumped only on the deterministic tick path + the live escalation level).
    hordesRepelled: state.stats.hordesRepelled,
    hordesBreached: state.stats.hordesBreached,
    hordeMaxLevel: state.horde.level,

    // M5.4: snapshot the final lifetime counters + the achievement unlock tally straight off
    // the state (both bumped only on the deterministic tick path). lootHauled → exact string.
    lifetime: {
      attacksWon: state.stats.attacksWon,
      attacksLost: state.stats.attacksLost,
      lootHauled: state.stats.lootHauled.toString(),
      raidsRepelled: state.stats.raidsRepelled,
      raidsLost: state.stats.raidsLost,
      campsRazed: state.stats.campsRazed,
      fortressesRazed: state.stats.fortressesRazed,
      scoutsReturned: state.stats.scoutsReturned,
      villagesFounded: state.stats.villagesFounded,
      villagesConquered: state.stats.villagesConquered,
    },
    achievementsUnlocked: Object.keys(state.achievements).length,
    achievementsTotal: ACHIEVEMENT_IDS.length,
  }
}
