import { runMany, type RunResult } from './runner'
import { TARGETS } from './targets'
import { D } from '../src/engine/decimal'
import { BUILDING_IDS } from '../src/content/buildings'

/**
 * Sim harness CLI — `tsx sim/index.ts`.
 *
 * Runs several seeds for the budgeted number of ticks and prints a concise
 * report: hard-invariant PASS/FAIL (incl. no-softlock), per-seed progression
 * (upgrades bought, production growth, building levels) and the M1.1 balance
 * targets as PASS/FAIL *warnings*.
 *
 * Exit code: non-zero iff any HARD invariant failed, so CI / a pre-commit gate
 * can block. Balance targets never change the exit code — they only warn that the
 * cost/effect curves drifted from the design goals. Node-safe: console + process.
 */
const SEEDS = ['alpha', 'beta', 'gamma']

function failures(r: RunResult): RunResult['invariants'] {
  return r.invariants.filter((i) => !i.ok)
}

/** Evaluate the (soft) balance targets for one run's metrics. */
interface TargetCheck {
  name: string
  ok: boolean
  detail: string
}

function evalTargets(r: RunResult): TargetCheck[] {
  const m = r.metrics
  const start = D(m.productionStart)
  const end = D(m.productionEnd)
  const growthOk = end.gte(start.mul(TARGETS.productionGrowthMin))
  const growthX = start.gt(0) ? end.div(start).toNumber() : Infinity
  const ratio = m.windowCount > 0 ? m.windowsWithProgress / m.windowCount : 1

  return [
    {
      name: 'min-upgrades',
      ok: m.upgradesBought >= TARGETS.minUpgradesByEnd,
      detail: `bought ${m.upgradesBought} (target >= ${TARGETS.minUpgradesByEnd})`,
    },
    {
      name: 'production-growth',
      ok: growthOk,
      detail: `${start.toString()} -> ${end.toString()} (x${growthX.toFixed(2)}, target >= x${TARGETS.productionGrowthMin})`,
    },
    {
      name: 'no-plateau',
      ok: ratio >= TARGETS.plateauWindowFraction,
      detail: `${m.windowsWithProgress}/${m.windowCount} windows progressed (${(ratio * 100).toFixed(0)}%, target >= ${(TARGETS.plateauWindowFraction * 100).toFixed(0)}%)`,
    },
  ]
}

function main(): void {
  const ticks = TARGETS.maxTicks
  const results = runMany(SEEDS, ticks)

  console.log('=== TW Incremental — sim harness ===')
  console.log(
    `seeds: ${SEEDS.join(', ')}   ticks/run: ${ticks}   tickSeconds: ${TARGETS.tickSeconds}`,
  )
  console.log('')

  // --- Hard invariants (drive the exit code) ---
  console.log('--- Invariants (hard) ---')
  let anyFail = false
  for (const r of results) {
    const fails = failures(r)
    const total = r.invariants.length
    const status = fails.length === 0 ? 'PASS' : 'FAIL'
    console.log(`[${status}] seed=${r.metrics.seed}   ${total - fails.length}/${total} checks ok`)
    for (const f of fails) {
      anyFail = true
      console.log(`      FAIL ${f.name}${f.detail ? ` — ${f.detail}` : ''}`)
    }
  }
  console.log('')

  // --- Progression per seed ---
  console.log('--- Progression ---')
  console.log('seed     | upgrades | production start -> end | resources')
  for (const r of results) {
    const m = r.metrics
    const res = Object.entries(m.resources)
      .map(([k, v]) => `${k}=${v}`)
      .join(' ')
    console.log(
      `${m.seed.padEnd(8)} | ${String(m.upgradesBought).padStart(8)} | ` +
        `${m.productionStart} -> ${m.productionEnd} | ${res}`,
    )
  }
  console.log('')

  // --- Building levels per seed ---
  console.log('--- Building levels (end) ---')
  for (const r of results) {
    const m = r.metrics
    const lvls = BUILDING_IDS.map((id) => `${id}=${m.buildings[id]}`).join(' ')
    console.log(`${m.seed.padEnd(8)} | ${lvls}`)
  }
  console.log('')

  // --- Balance targets (warnings only — do NOT affect the exit code) ---
  console.log('--- Balance targets (warnings) ---')
  for (const r of results) {
    const checks = evalTargets(r)
    const passed = checks.filter((c) => c.ok).length
    console.log(`seed=${r.metrics.seed}   ${passed}/${checks.length} targets met`)
    for (const c of checks) {
      const mark = c.ok ? 'ok  ' : 'WARN'
      console.log(`      ${mark} ${c.name} — ${c.detail}`)
    }
  }
  console.log('')

  if (anyFail) {
    console.error('RESULT: FAIL — hard invariants violated; do NOT commit. Fix engine / data curves.')
    process.exit(1)
  }
  console.log('RESULT: PASS — all hard invariants ok (see balance warnings above for tuning).')
  process.exit(0)
}

main()
