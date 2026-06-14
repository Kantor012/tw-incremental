import { runMany, type RunResult } from './runner'
import { TARGETS } from './targets'
import { D } from '../src/engine/decimal'

/**
 * Sim harness CLI — `tsx sim/index.ts`.
 *
 * Runs several seeds for the budgeted number of ticks, prints a concise report
 * (invariant PASS/FAIL with details, metrics vs targets, deepest progress) and
 * exits non-zero if ANY invariant failed so CI / a pre-commit gate can block.
 * Node-safe: no DOM, only console + process.
 */
const SEEDS = ['alpha', 'beta', 'gamma']

function failures(r: RunResult): RunResult['invariants'] {
  return r.invariants.filter((i) => !i.ok)
}

function main(): void {
  const ticks = TARGETS.maxTicks
  const results = runMany(SEEDS, ticks)

  console.log('=== TW Incremental — sim harness ===')
  console.log(
    `seeds: ${SEEDS.join(', ')}   ticks/run: ${ticks}   tickSeconds: ${TARGETS.tickSeconds}`,
  )
  console.log('')

  // --- Invariants ---
  console.log('--- Invariants ---')
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

  // --- Metrics vs targets ---
  console.log('--- Metrics vs targets ---')
  console.log(
    `target: maxTicks=${TARGETS.maxTicks}  tickSeconds=${TARGETS.tickSeconds}  ` +
      `simSeconds budget=${TARGETS.maxTicks * TARGETS.tickSeconds}`,
  )
  console.log('seed     | ticks  | simSeconds | resources')
  for (const r of results) {
    const m = r.metrics
    const res = Object.entries(m.resources)
      .map(([k, v]) => `${k}=${v}`)
      .join(' ')
    console.log(
      `${m.seed.padEnd(8)} | ${String(m.ticks).padStart(6)} | ` +
        `${String(m.simSeconds).padStart(10)} | ${res}`,
    )
  }
  console.log('')

  // --- Deepest progress (M0: total accumulated resources) ---
  let deepest = D(0)
  let deepestSeed = '-'
  for (const r of results) {
    let total = D(0)
    for (const v of Object.values(r.metrics.resources)) total = total.add(D(v))
    if (total.gt(deepest)) {
      deepest = total
      deepestSeed = r.metrics.seed
    }
  }
  console.log('--- Deepest progress ---')
  console.log(`max total resources: ${deepest.toString()} (seed ${deepestSeed})`)
  console.log('')

  if (anyFail) {
    console.error('RESULT: FAIL — invariants violated; do NOT commit. Fix data curves / engine.')
    process.exit(1)
  }
  console.log('RESULT: PASS — all invariants ok.')
  process.exit(0)
}

main()
