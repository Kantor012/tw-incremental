/**
 * Balance targets for the headless harness.
 *
 * These are *versioned* design goals: any change here is a deliberate balance
 * decision and MUST be recorded in CHANGELOG.md (section "Balance", with the
 * before/after values). The harness reports measured metrics against these so
 * regressions are visible at a glance.
 *
 * M0 keeps this intentionally tiny — only the simulation budget exists yet.
 * M1+ will grow this with milestone-time goals (first barbarian village,
 * N-th village, tree thresholds, first prestige), still as plain data.
 */
export interface BalanceTargets {
  /** Number of fixed steps each run advances (the time-compression budget). */
  maxTicks: number
  /** Game-seconds advanced per step. */
  tickSeconds: number
}

export const TARGETS: BalanceTargets = {
  maxTicks: 20000,
  tickSeconds: 1,
}
