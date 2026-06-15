/**
 * Balance targets for the headless harness.
 *
 * These are *versioned* design goals: any change here is a deliberate balance
 * decision and MUST be recorded in CHANGELOG.md (section "Balance", with the
 * before/after values). The harness reports measured metrics against these so
 * regressions are visible at a glance.
 *
 * Severity split (see sim/index.ts):
 *  - HARD invariants (no NaN, non-negative, within cap, round-trip, determinism,
 *    offline-determinism, save-load-continuation, NO-SOFTLOCK) fail the run and
 *    exit non-zero — a commit blocker. NO-SOFTLOCK is now content-aware: a stall is
 *    a hard fail only BEFORE the content frontier (see contentConsumed); hitting the
 *    frontier itself is reported as a warning, not a failure.
 *  - The numeric goals below (minUpgradesByEnd, productionGrowthMin,
 *    plateauWindowFraction, and the M1.2 recruitment goals) are *balance warnings*:
 *    they surface in the report as PASS/FAIL but do NOT change the exit code. They
 *    flag curves that need tuning, not broken code.
 */
export interface BalanceTargets {
  /**
   * Number of fixed steps each run advances (the time-compression budget). Sized so
   * the bot drives deep into the M1 content: building the barracks, exercising the
   * recruitment sink, and (curves permitting) approaching the content frontier
   * where every building is maxed and population is full.
   */
  maxTicks: number
  /** Game-seconds advanced per step. */
  tickSeconds: number

  // --- M1.1 economy goals (warnings) ---
  /** A healthy run should let the bot buy at least this many upgrades. */
  minUpgradesByEnd: number
  /** End-of-run total production must be at least this multiple of the start. */
  productionGrowthMin: number
  /**
   * Fraction of sampled windows that must show progress (resources grew OR a
   * build/recruit happened). Above this the economy keeps moving; below it the run
   * has plateaued and the cost/effect curves need attention.
   */
  plateauWindowFraction: number

  // --- M1.2 recruitment goals (warnings) ---
  /** The bot must build the barracks (recruitment gate) to at least this level. */
  minBarracksLevel: number
  /** The bot must ORDER at least this many units over a run (the sink is real). */
  minUnitsRecruited: number
  /**
   * End-of-run population utilisation (usedPopulation / popCap) must reach at least
   * this fraction — i.e. recruitment meaningfully consumes the population budget
   * rather than leaving the farm idle.
   */
  minPopulationUtil: number

  // --- M1.3 combat goals (warnings) ---
  /** The bot must WIN at least this many attacks on barbarian camps (loot source). */
  minBattlesWon: number
  /** Total loot hauled home from attacks must be at least this (the source is real). */
  minLootHauled: number
  /**
   * At least this many incoming raids must be RESOLVED over the run (survived or
   * not) — proof the raid defence system actually ran and was exercised.
   */
  minRaidsResolved: number
  /**
   * The combat-dissolved M1.2 content frontier must NOT be reached: the
   * recruit -> attack/raid -> recruit loop keeps the loop open without bound, so a
   * long run should never hit "all maxed + population permanently full". When true,
   * a run that reports a frontier tick FAILS this (warning) target.
   */
  requireNoContentFrontier: boolean

  // --- M2.3 expansion goal (warning) ---
  /**
   * The bot must FOUND at least this many new villages over a run — proof the
   * expansion mechanic is reachable and the cost curve lets a maturing capital pay
   * for it. >= 1 confirms multi-village play actually happens within the budget.
   */
  minVillagesFounded: number

  // --- M2.4 conquest goal (warning) ---
  /**
   * The bot must CONQUER at least this many barbarian villages over a run — proof the
   * loyalty -> capture pipeline (build the Pałac, train nobles, march them in until a
   * camp's loyalty hits 0) is reachable within the budget. >= 1 confirms the conquest
   * mechanic actually completes; if it cannot be hit without starving the M1/M2.3
   * targets, the academy/noble cost or the LOYALTY_NOBLE_HIT/REGEN knobs need tuning
   * (those live outside the harness — see manifest notes).
   */
  minVillagesConquered: number

  // --- M3.1 tech (global passive tree) goal (warning) ---
  /**
   * The bot must BUY at least this many tech-node levels from the global pool over a run
   * — proof the passive tree (M3.1) is a reachable resource sink and the purchase path is
   * exercised. The bot spends only genuine surplus on tech (see sim/bot.chooseTech), so a
   * healthy run buys steadily once the empire matures; if this cannot be hit without
   * starving the M1/M2 targets the node costs (content/tech.ts) need tuning.
   */
  minTechPurchases: number
}

export const TARGETS: BalanceTargets = {
  // M1.3 closed the loop with COMBAT: the recruitment sink is no longer pop-bounded
  // because incoming raids continuously kill home units (freeing population) and
  // outgoing attacks both take casualties (a unit sink) and haul LOOT (a resource
  // source). The recruit -> attack/raid -> recruit loop is therefore self-propelling
  // and the M1.2 content frontier (all buildings maxed + population permanently full)
  // is DISSOLVED — it can never latch, because population is always being freed.
  //
  // The budget is deliberately large (and well past the ~49k tick where M1.2 would
  // have frontier'd) so the harness DEMONSTRATES the loop stays open: across 120k
  // ticks the bot keeps winning battles, hauling loot and surviving raids with no
  // content frontier ever reported. (Linear production over the fixed grid is exact
  // on Decimal, so the longer span costs runtime only, not balance fidelity.)
  maxTicks: 120000,
  tickSeconds: 1,

  // M1.1: data-driven buildings online. The greedy bot should sustain a steady
  // stream of purchases and grow production several-fold across a run.
  minUpgradesByEnd: 15,
  productionGrowthMin: 3,
  plateauWindowFraction: 0.5,

  // M1.2: recruitment online. The bot must unlock the barracks, exercise the unit
  // sink, and put a sensible share of its population budget to work.
  minBarracksLevel: 1,
  minUnitsRecruited: 10,
  minPopulationUtil: 0.5,

  // M1.3: combat online. The bot must win real battles, haul loot, weather raids,
  // and keep the loop open with NO content frontier across the whole long budget.
  // Floors raised from the placeholder >=1 to real regression guards, sized well
  // below the measured healthy run (≈1811 wins / ≈554k loot / 133 raids over the
  // 120k budget) so normal play passes but a curve regression — attacks that stop
  // winning, or loot that no longer pays for the ~30% attrition a march costs —
  // trips a warning. See CHANGELOG "Balance" for the before/after.
  minBattlesWon: 500,
  minLootHauled: 300000,
  minRaidsResolved: 40,
  requireNoContentFrontier: true,

  // M2.3: expansion online. A maturing capital should be able to fund at least one
  // new village within the budget without starving the economy/combat targets above
  // (the bot founds only from IDLE surplus — see sim/bot.chooseFounding). Sized at the
  // minimum proof-of-mechanic; a healthy run founds a handful before the geometric
  // cost outgrows the warehouse cap.
  minVillagesFounded: 1,

  // M2.4: conquest online. A mature capital should be able to build the Pałac, train a
  // strike force of nobles and march them into a barbarian camp until its loyalty hits
  // 0 — flipping it to a player village — at least once within the budget. Sized at the
  // minimum proof-of-mechanic (the bot self-limits conquests so founding keeps room
  // under the village cap — see sim/bot.chooseConquest).
  minVillagesConquered: 1,

  // M3.1: tech online. The global passive tree must be a reachable sink the bot buys
  // into from its surplus. A matured empire buys the ENTIRE starter tree over the budget
  // (measured 507 levels = every one of the 72 nodes maxed; production uplift ≈ x5 over
  // the no-tech base), so this floor sits well below that — passing normal play but
  // tripping a warning if a cost/heuristic regression leaves the tree mostly unbought.
  // (The starter tree fully maxing by end-game is expected for M3.1; M3.2 adds breadth.)
  // See CHANGELOG "Balance" for the before/after.
  minTechPurchases: 200,
}
