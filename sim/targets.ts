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
}

export const TARGETS: BalanceTargets = {
  // M1.2 added the recruitment SINK: once buildings start maxing, surplus resources
  // are converted into units (bounded by the farm's popCap) instead of idling. This
  // extends the progress loop past the building ceiling. The genuine end-of-content
  // state is the CONTENT FRONTIER (every building maxed AND population permanently
  // full — the sink is pop-bounded, so it caps the loop rather than opening it
  // forever; the next, larger sink lands with M1.3 combat/expansion).
  //
  // The Balance phase de-inflated the warehouse (perLevel 25000 -> 3000, cap 751000 ->
  // 91000): the run is now bounded by CONTENT consumption, not by the slowest resource
  // filling an oversized cap. The content frontier (all buildings maxed, population
  // full) lands around tick ~49k for every seed. The budget intentionally runs a short
  // stretch PAST it so the harness asserts checkNoSoftlock's content-aware exemption
  // holds — at the frontier the terminal capped stall is a WARNING, not a commit
  // blocker — without wasting tens of thousands of dead post-frontier windows (which
  // would drag the no-plateau ratio down). 60k = frontier + ~22% headroom.
  maxTicks: 60000,
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
}
