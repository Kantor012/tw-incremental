import { runMany, type RunResult } from './runner'
import { TARGETS } from './targets'
import { D } from '../src/engine/decimal'
import { BUILDING_IDS } from '../src/content/buildings'
import { UNIT_IDS } from '../src/content/units'

/**
 * Sim harness CLI — `tsx sim/index.ts`.
 *
 * Runs several seeds for the budgeted number of ticks and prints a concise
 * report: hard-invariant PASS/FAIL (incl. army-consistency, world-consistency,
 * no-softlock, marches-terminate), per-seed progression (upgrades, production, buildings),
 * recruitment/population, the M1.3 combat loop (attacks won/lost, loot hauled,
 * raids repelled/through, units lost, final army) and the M1.1/M1.2/M1.3 balance
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

  const popCap = D(m.popCap)
  const popUtil = popCap.gt(0) ? D(m.usedPopulation).div(popCap).toNumber() : 0
  const barracks = m.buildings.barracks ?? 0

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
    {
      name: 'barracks-built',
      ok: barracks >= TARGETS.minBarracksLevel,
      detail: `barracks lvl ${barracks} (target >= ${TARGETS.minBarracksLevel})`,
    },
    {
      name: 'units-recruited',
      ok: m.unitsRecruitedTotal >= TARGETS.minUnitsRecruited,
      detail: `ordered ${m.unitsRecruitedTotal} units (target >= ${TARGETS.minUnitsRecruited})`,
    },
    {
      name: 'population-util',
      ok: popUtil >= TARGETS.minPopulationUtil,
      detail: `${m.usedPopulation}/${m.popCap} pop used (${(popUtil * 100).toFixed(0)}%, target >= ${(TARGETS.minPopulationUtil * 100).toFixed(0)}%)`,
    },
    {
      name: 'battles-won',
      ok: m.battlesWon >= TARGETS.minBattlesWon,
      detail: `won ${m.battlesWon} / lost ${m.battlesLost} attacks (target won >= ${TARGETS.minBattlesWon})`,
    },
    {
      name: 'loot-hauled',
      ok: D(m.totalLoot).gte(TARGETS.minLootHauled),
      detail: `hauled ${m.totalLoot} from attacks (target >= ${TARGETS.minLootHauled})`,
    },
    {
      name: 'raids-resolved',
      ok: m.raidsSurvived + m.raidsLost >= TARGETS.minRaidsResolved,
      detail: `${m.raidsSurvived} repelled / ${m.raidsLost} got through (target resolved >= ${TARGETS.minRaidsResolved})`,
    },
    {
      name: 'no-content-frontier',
      ok: !TARGETS.requireNoContentFrontier || !m.reachedContentFrontier,
      detail: m.reachedContentFrontier
        ? `frontier reached at tick ~${m.contentFrontierTick} (combat should keep the loop open!)`
        : 'frontier never reached — combat keeps the loop self-propelling',
    },
    {
      name: 'villages-founded',
      ok: m.villagesFounded >= TARGETS.minVillagesFounded,
      detail: `founded ${m.villagesFounded} (own ${m.villagesOwned}, target founded >= ${TARGETS.minVillagesFounded})`,
    },
    {
      name: 'villages-conquered',
      ok: m.villagesConquered >= TARGETS.minVillagesConquered,
      detail: `conquered ${m.villagesConquered} (own ${m.villagesOwned}, target conquered >= ${TARGETS.minVillagesConquered})`,
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

  // --- Recruitment & population per seed (M1.2 sink) ---
  console.log('--- Recruitment & population (end) ---')
  console.log('seed     | ordered (by type / total) | trained units | population | content-frontier')
  for (const r of results) {
    const m = r.metrics
    const ordered = UNIT_IDS.map((id) => `${id}=${m.unitsRecruited[id]}`).join(' ')
    const trained = UNIT_IDS.map((id) => `${id}=${m.units[id]}`).join(' ')
    const frontier =
      m.contentFrontierTick === null
        ? 'not reached (sink keeps loop open within budget)'
        : `tick ~${m.contentFrontierTick}`
    console.log(
      `${m.seed.padEnd(8)} | ${ordered} (tot ${m.unitsRecruitedTotal}) | ${trained} | ` +
        `${m.usedPopulation}/${m.popCap} | ${frontier}`,
    )
  }
  console.log('')

  // --- Combat per seed (M1.3 loop: attacks + raids) ---
  console.log('--- Combat (end) ---')
  console.log(
    'seed     | attacks (won/lost) | loot hauled | raids (repelled/through) | stolen | units lost | final army',
  )
  for (const r of results) {
    const m = r.metrics
    console.log(
      `${m.seed.padEnd(8)} | ${m.attacksSent} (${m.battlesWon}/${m.battlesLost}) | ${m.totalLoot} | ` +
        `${m.raidsSurvived}/${m.raidsLost} | ${m.raidStolen} | ${m.unitsLost} | ${m.finalArmyTotal}`,
    )
  }
  console.log('')

  // --- Expansion per seed (M2.3 founding + M2.4 conquest) ---
  console.log('--- Expansion (end) ---')
  console.log('seed     | villages founded | villages conquered | villages owned')
  for (const r of results) {
    const m = r.metrics
    console.log(
      `${m.seed.padEnd(8)} | ${String(m.villagesFounded).padStart(16)} | ` +
        `${String(m.villagesConquered).padStart(18)} | ${m.villagesOwned}`,
    )
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

  // --- Content frontier (warning, not a failure) ---
  // M1.3 DISSOLVED the M1.2 frontier: combat is a perpetual unit sink (raid + battle
  // casualties free population) and loot source, so the recruit -> attack/raid ->
  // recruit loop never latches into "all maxed + population permanently full". A
  // frontier here would mean combat failed to keep the loop open — we surface it as a
  // warning (it does not affect the exit code; the no-content-frontier balance target
  // tracks it too).
  const frontierSeeds = results.filter((r) => r.metrics.contentFrontierTick !== null)
  console.log('--- Content frontier (warning) ---')
  if (frontierSeeds.length === 0) {
    console.log(
      'none reached within the budget — the M1.3 combat loop keeps progress self-propelling for all seeds.',
    )
  } else {
    for (const r of frontierSeeds) {
      console.log(
        `WARN seed=${r.metrics.seed} hit the content frontier at tick ~${r.metrics.contentFrontierTick} ` +
          '(all buildings maxed, population full) — combat should have kept the loop open; check raid/loot balance.',
      )
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
