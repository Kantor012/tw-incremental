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

  // --- M4.1 prestige (ascension meta-layer) goals (warnings) ---
  /**
   * The bot must ASCEND at least this many times over the (separate) prestige run — proof
   * the reset-for-points mechanic is reachable within a reasonable session AND repeats
   * deterministically. >= 1 is the contract floor; the bot self-limits ascensions (see
   * sim/bot.BOT_MAX_ASCENSIONS) so this never runs away. If it cannot be hit, PP_SCALE /
   * prestigeScore (systems/prestige.ts) or the ASCEND_MIN_PP heuristic need tuning.
   */
  minAscensions: number
  /**
   * The bot must BUY at least this many prestige-node levels from banked PP over the
   * prestige run — proof the prestige tree is a reachable PP sink and the purchase path is
   * exercised. Sized well below a healthy run's measured total (≈16 levels across the
   * ascension cap) so normal play passes but a PP-cost / yield regression that leaves the
   * tree mostly unbought trips a warning.
   */
  minPrestigePurchases: number
  /**
   * The permanent prestige bonus must actually FOLD INTO the economy: when the bot owns a
   * production prestige node, a fresh re-derived run's production must exceed the no-prestige
   * baseline (prestigeProductionMult > 1). True turns this into a (warning) target — the
   * confirmation the brief calls for that ascension makes future runs stronger.
   */
  requirePrestigeProductionUplift: boolean

  // --- M6.1 era (great reset / second meta-layer) goals (warnings) ---
  /**
   * The bot must start at least this many eras (great resets) over the (separate) era run —
   * proof the second meta-layer is reachable within a reasonable session AND repeats
   * deterministically. >= 1 is the contract floor; the bot self-limits eras (see
   * sim/bot.BOT_MAX_ERAS) so this never runs away. Reaching it requires the prestige loop to
   * accumulate enough account-wide progress that {@link import('../src/systems/era').pendingEraPoints}
   * (a cube root of the prestige score) clears {@link import('./bot').ERA_MIN_EP}; if it cannot be
   * hit, EP_SCALE / eraScore (systems/era.ts) or the ERA_MIN_EP heuristic need tuning.
   */
  minEras: number
  /**
   * The bot must BUY at least this many era-node levels from banked EP over the era run — proof
   * the era tree is a reachable EP sink and the purchase path is exercised. Sized at the
   * proof-of-mechanic floor; a regression that leaves the (rare) EP unspendable trips a warning.
   */
  minEraPurchases: number
  /**
   * The signature `pp_mult` era effect must actually FOLD INTO prestige-point gain: a maxed
   * pp_mult era node must raise pendingPrestigePoints for a fixed prestige score
   * (eraPpUplift > 1). True turns this into a (warning) target — the confirmation that each new
   * era accelerates the whole prestige loop.
   */
  requireEraPpUplift: boolean

  // --- M6.2 dynasty (great-great reset / third meta-layer) goals (warnings) ---
  /**
   * The bot must found at least this many dynasties (great-great resets) over the (separate)
   * dynasty run — proof the third meta-layer is reachable within a reasonable session AND repeats
   * deterministically. >= 1 is the contract floor; the bot self-limits dynasties (see
   * sim/bot.BOT_MAX_DYNASTIES) so this never runs away. Reaching it requires the era loop to
   * accumulate enough account-wide progress that {@link import('../src/systems/dynasty').pendingDynastyPoints}
   * (a cube root of the era score) clears {@link import('./bot').DYN_MIN_DP}; if it cannot be hit,
   * DP_SCALE / dynastyScore (systems/dynasty.ts) or the DYN_MIN_DP heuristic need tuning.
   */
  minDynasties: number
  /**
   * The bot must BUY at least this many dynasty-node levels from banked DP over the dynasty run —
   * proof the dynasty tree is a reachable DP sink and the purchase path is exercised. Sized at the
   * proof-of-mechanic floor; a regression that leaves the (rare) DP unspendable trips a warning.
   */
  minDynastyPurchases: number
  /**
   * The signature `ep_mult` dynasty effect must actually FOLD INTO era-point gain: a maxed ep_mult
   * dynasty node must raise pendingEraPoints for a fixed era score (dynastyEpUplift > 1). True turns
   * this into a (warning) target — the confirmation that each new dynasty accelerates the whole era loop.
   */
  requireDynastyEpUplift: boolean
  /**
   * The dynasty `automation_unlock` gateway must actually UNLOCK all three idle automations
   * account-wide: with the gateway node owned, effectiveMods(state).automations must be all true
   * (dynastyAutomationUnlocked). True turns this into a (warning) target — the confirmation that the
   * gated mechanic is live (every routine unlocked from the start, the M6.2 signature gate).
   */
  requireDynastyAutomationUnlock: boolean

  // --- M5.1 automation (idle routines) goals (HARD — see runner.runAutomationCoverage) ---
  // These are proof-of-mechanic floors for the SEPARATE automation coverage run (automation
  // ON), NOT balance-curve warnings: with the deterministic seeded scenario each routine
  // must do real work, so a regression that stops a routine firing is a genuine bug and
  // fails the run. (The main run keeps automation OFF, so the 17 balance targets above stay
  // measured on the pre-M5.1 path and are untouched by M5.1.)
  /** Building levels AUTO-BUILD must add over the coverage run (>= 1 = the routine fired). */
  minAutomationBuilt: number
  /** Units AUTO-RECRUIT must train over the coverage run (>= 1 = the routine topped up). */
  minAutomationRecruited: number
  /** Attacks AUTO-ATTACK must dispatch-and-resolve over the coverage run (>= 1). */
  minAutomationAttacked: number

  // --- M5.4 achievements goal (HARD — see runner.checkAchievementsUnlocked) ---
  /**
   * Distinct achievements the MAIN run must UNLOCK over the budget — a proof-of-mechanic floor
   * (like the automation floors), NOT one of the 17 balance goals: achievements grant no gameplay
   * bonus in v1, so they cannot move the economy/combat/expansion/tree/prestige curves. Sized well
   * below a healthy run's measured count (≈18–20 of the 30 unlock across the budget — the bot wins
   * thousands of battles, hauls loot, expands and buys deep into the tech tree), so normal play
   * passes but a broken achievement engine / catalogue (nothing unlocks) fails the run. The
   * scout / siege / prestige achievements the bot never fields are exercised separately (the M5.4
   * determinism scenario unlocks first_scout / first_razed; the prestige run unlocks the ascension
   * ones), so this floor only measures the bot's own reachable set.
   */
  minAchievementsUnlocked: number
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

  // M4.1: prestige online. A matured run should be able to ascend (reset for prestige
  // points) and spend them on the permanent, account-wide prestige tree, with the resulting
  // bonuses folding back into every future run. Measured by a SEPARATE ascension-driving run
  // (see sim/runner.runPrestige) so the M1–M3 targets above stay measured on an un-reset
  // economy. Floors sized at the proof-of-mechanic level, well below a healthy run's measured
  // values (≈4 ascensions / ≈16 prestige levels / x1.14 production uplift across all seeds),
  // so normal play passes but a PP_SCALE / cost / heuristic regression trips a warning. If
  // these cannot be hit without changing the tree, tune PP_SCALE / baseCost (systems &
  // content/prestige.ts) — see manifest notes.
  minAscensions: 1,
  minPrestigePurchases: 8,
  requirePrestigeProductionUplift: true,

  // M6.1: era online. A matured prestige loop should accumulate enough account-wide progress
  // (lifetime PP + ascensions + prestige nodes) that its CUBE-root EP yield clears the era
  // floor, letting the bot perform a Nowa Era (the great reset that WIPES the prestige account
  // but banks permanent era points) and spend EP on the era tree. Measured by a SEPARATE
  // era-driving run (see sim/runner.runEra) so the M1–M5 + prestige targets stay measured on an
  // un-reset account. Floors at the proof-of-mechanic level (>= 1 era / >= 1 era level), and the
  // pp_mult uplift confirms each era accelerates the prestige loop. If these cannot be hit
  // without changing the tree, tune EP_SCALE / eraScore (systems/era.ts) — see manifest notes.
  minEras: 1,
  minEraPurchases: 1,
  requireEraPpUplift: true,

  // M6.2: dynasty online. A matured era loop should accumulate enough account-wide progress
  // (lifetime EP + eras + era nodes) that its CUBE-root DP yield clears the dynasty floor, letting
  // the bot found a Nowa Dynastia (the great-great reset that WIPES the era AND prestige accounts
  // but banks permanent dynasty points) and spend DP on the dynasty tree. Measured by a SEPARATE
  // dynasty-driving run (see sim/runner.runDynasty) so the M1–M6.1 targets stay measured on
  // un-reset accounts. Floors at the proof-of-mechanic level (>= 1 dynasty / >= 1 dynasty level);
  // the ep_mult uplift confirms each dynasty accelerates the era loop, and the automation-unlock
  // gate confirms the M6.2 signature mechanic is live. If these cannot be hit without changing the
  // tree, tune DP_SCALE / dynastyScore (systems/dynasty.ts) — see manifest notes.
  minDynasties: 1,
  minDynastyPurchases: 1,
  requireDynastyEpUplift: true,
  requireDynastyAutomationUnlock: true,

  // M5.1: automation online. With the three gateways unlocked and every toggle ON, the
  // SEPARATE coverage run (automation OFF in the main run, so the goals above are untouched)
  // must show each idle routine doing real work over a one-hour span: auto-build raises a
  // building level, auto-recruit trains its chosen unit, and auto-attack dispatches a march
  // at the nearest beatable barbarian. Floors sit at the contract proof-of-mechanic level
  // (>= 1); a healthy run far exceeds them (the seeded capital auto-builds many levels, keeps
  // an axeman stack topped up and raids the nearby tier-1 camps continuously).
  minAutomationBuilt: 1,
  minAutomationRecruited: 1,
  minAutomationAttacked: 1,

  // M5.4: achievements online. A mature run crosses many of the 30 thresholds (economy /
  // militaria / expansion / tree). Floor sized at the proof-of-mechanic level — the 30k-tick
  // smoke run already unlocks 14 and the full budget reaches ~18–20 — so normal play passes
  // comfortably while a regression that stops anything unlocking trips the (hard) check.
  minAchievementsUnlocked: 12,

  // M3.2: tech online, WIDENED to ~180 nodes across 9 categories (economy/storage/
  // settlement + the new military/fortification/logistics/plunder/construction/training
  // combat-and-logistics branches). The global passive tree must be a reachable sink the
  // bot buys into from its surplus, now with far more breadth to buy. A matured empire buys
  // deep into the widened tree over the budget (the combat/cost/march/recruit perks feed
  // back into a faster economy, so purchases compound), so this floor is RAISED from the
  // M3.1 value of 200 to 300 — still well below a healthy run's measured total, passing
  // normal play but tripping a warning if a cost/heuristic regression leaves the widened
  // tree mostly unbought. See CHANGELOG "Balance" for the before/after.
  minTechPurchases: 300,
}
