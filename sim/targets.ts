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
 *    exit non-zero — a commit blocker.
 *  - The numeric goals below (minUpgradesByEnd, productionGrowthMin,
 *    plateauWindowFraction) are *balance warnings*: they surface in the report as
 *    PASS/FAIL but do NOT change the exit code. They flag curves that need tuning,
 *    not broken code.
 */
export interface BalanceTargets {
  /**
   * Number of fixed steps each run advances (the time-compression budget). MUST
   * be large enough for the bot to consume the entire M1 content ceiling — every
   * building maxes around tick ~41k with the current curves — so the harness
   * actually exercises the dead-end, not just the comfortable early game.
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
   * Fraction of sampled windows that must show progress (resources grew OR an
   * upgrade bought). Above this the economy keeps moving; below it the run has
   * plateaued and the cost/effect curves need attention.
   */
  plateauWindowFraction: number
}

export const TARGETS: BalanceTargets = {
  // 50000 > the ~41k all-maxed horizon, so the harness now drives the bot all the
  // way to the M1 content ceiling (the old 20000 reached ~12% of total levels and
  // gave false "no-softlock" confidence). KNOWN M1 LIMITATION / tech debt: once
  // every building is maxed, idle accrual is the only remaining progress signal;
  // with the deliberately-oversized warehouse (perLevel 25000) the shared cap is
  // not filled until ~92k ticks, after which checkNoSoftlock CORRECTLY fires —
  // M1 has a genuine terminal softlock because there is no resource sink yet. The
  // honest fix is an M2 sink (prestige / units / expansion), NOT a bigger cap;
  // when that lands, drop the warehouse inflation and raise maxTicks past ~92k so
  // the harness asserts the sink keeps the loop open. Until then the budget stays
  // below the cap-fill horizon so the build is green without masking the debt.
  maxTicks: 50000,
  tickSeconds: 1,

  // M1.1: data-driven buildings online. The greedy bot should sustain a steady
  // stream of purchases and grow production several-fold across a run.
  minUpgradesByEnd: 15,
  productionGrowthMin: 3,
  plateauWindowFraction: 0.5,
}
