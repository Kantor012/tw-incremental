import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { runMany, runOne, type RunResult } from './runner'
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

/**
 * Argv flag that flips this same entry file into WORKER mode: `… --worker <seed> <ticks>`
 * runs exactly one seed and writes its {@link RunResult} as a single JSON blob to stdout
 * (nothing else), so the parent can {@link JSON.parse} it back. {@link RunResult} is
 * JSON-safe — metrics serialise every Decimal to its exact string, invariants are plain
 * `{name, ok, detail}` — so a worker's result round-trips byte-exactly through the pipe.
 */
const WORKER_FLAG = '--worker'

/**
 * Run ONE seed in a child process and resolve its parsed {@link RunResult}. Each seed is a
 * fully independent, deterministic run (its own fresh state, RNG seeded from the string), so
 * fanning them across processes changes NOTHING about the output — it only spends the machine's
 * cores instead of one. The child is launched the same way tsx launches this file
 * (`node --import tsx <thisFile> --worker <seed> <ticks>`) so the worker loads TS identically;
 * its stderr is inherited so any failure surfaces, and a non-zero exit / unparseable stdout
 * rejects (handled by {@link runSeeds}' sequential fallback).
 */
function runSeedChild(seed: string, ticks: number): Promise<RunResult> {
  return new Promise<RunResult>((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ['--import', 'tsx', fileURLToPath(import.meta.url), WORKER_FLAG, seed, String(ticks)],
      { stdio: ['ignore', 'pipe', 'inherit'] },
    )
    let out = ''
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (d) => (out += d))
    child.on('error', reject)
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`seed ${seed} worker exited with code ${code}`))
        return
      }
      try {
        resolve(JSON.parse(out) as RunResult)
      } catch (e) {
        reject(new Error(`seed ${seed} worker produced no parseable result (${String(e)})`))
      }
    })
    process.stderr.write(`  [sim] spawned seed ${seed} (ticks=${ticks})\n`)
  })
}

/**
 * Run every seed, fanned out one-process-per-seed so the harness uses all cores (the seeds are
 * independent + deterministic, so the parallel result equals the old sequential {@link runMany}
 * exactly — same seeds, same order). Results are collected in SEED order regardless of which
 * child finishes first, and a per-seed `done` line goes to stderr so a long run is visibly
 * progressing instead of looking hung. If spawning fails for any seed (odd environment, no
 * fork), it falls back to the in-process sequential path so the harness always produces a
 * report.
 */
async function runSeeds(seeds: string[], ticks: number): Promise<RunResult[]> {
  try {
    return await Promise.all(
      seeds.map(async (seed) => {
        const r = await runSeedChild(seed, ticks)
        process.stderr.write(`  [sim] seed ${seed} done (${r.ok ? 'ok' : 'FAIL'})\n`)
        return r
      }),
    )
  } catch (err) {
    process.stderr.write(
      `  [sim] parallel run failed (${String(err)}); falling back to sequential.\n`,
    )
    return runMany(seeds, ticks)
  }
}

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
    {
      // M7: the bot must raze at least minFortressesRazed fortresses in the dedicated boss-target run
      // (runner.runFortress). Measured apart from the MAIN run because the main loop churns its
      // population, so its standing army never amasses into a boss-cracking stack (lifetime.fortressesRazed
      // stays 0 there); the dedicated run amasses a real all-in army + full siege train on the proven
      // endgame economy and razes the nearest far-ring fortress.
      name: 'fortresses-razed',
      ok: m.fortressDriveRazed >= TARGETS.minFortressesRazed,
      detail: `razed ${m.fortressDriveRazed} fortress(es) in the dedicated siege run (target >= ${TARGETS.minFortressesRazed})`,
    },
    {
      // M7.2: a NORMALLY-PROGRESSING bot must REPEL at least minHordesRepelled hordes over the MAIN
      // run — the telegraphed, escalating capital invasion is an ALWAYS-ON pressure (it touches
      // every run), so its defence must scale with progress like a raid's. Mirrors raids-resolved
      // but for the high-stakes capital horde. This is added ALONGSIDE the 17 core +
      // prestige/era/dynasty/fortress targets above (all of which STILL evaluate here): hordes are
      // a new pressure but must not break the existing goals — see the per-seed report below.
      name: 'hordes-repelled',
      ok: m.hordesRepelled >= TARGETS.minHordesRepelled,
      detail: `repelled ${m.hordesRepelled} / breached ${m.hordesBreached} hordes (max level ${m.hordeMaxLevel}; target repelled >= ${TARGETS.minHordesRepelled})`,
    },
    {
      name: 'tech-nodes-purchased',
      ok: m.techPurchases >= TARGETS.minTechPurchases,
      detail: `bought ${m.techPurchases} tech levels (${m.techNodesOwned} nodes, ${m.techLevelsOwned} levels; target >= ${TARGETS.minTechPurchases})`,
    },
    {
      // Confirms the tree's economic multipliers actually fold into the simulation:
      // when any tech is owned, end production must exceed the same buildings' no-tech base.
      name: 'tech-production-uplift',
      ok: m.techPurchases === 0 || m.techProductionMult > 1,
      detail:
        m.techPurchases === 0
          ? 'no tech bought — uplift n/a'
          : `production x${m.techProductionMult.toFixed(3)} over no-tech base (${m.productionBaseNoTech} -> ${m.productionEnd})`,
    },
    {
      // M4.1: the bot must ascend at least minAscensions times in the separate prestige run.
      name: 'ascensions',
      ok: m.ascensions >= TARGETS.minAscensions,
      detail: `ascended ${m.ascensions}x (first ~tick ${m.firstAscendTick ?? 'n/a'}, target >= ${TARGETS.minAscensions})`,
    },
    {
      // M4.1: the bot must buy at least minPrestigePurchases prestige-node levels from PP.
      name: 'prestige-nodes-purchased',
      ok: m.prestigePurchases >= TARGETS.minPrestigePurchases,
      detail: `bought ${m.prestigePurchases} prestige levels (${m.prestigeNodesOwned} nodes, ${m.prestigeLevelsOwned} levels; target >= ${TARGETS.minPrestigePurchases})`,
    },
    {
      // M4.1: confirms the permanent prestige multipliers fold into a fresh run's economy.
      name: 'prestige-production-uplift',
      ok: !TARGETS.requirePrestigeProductionUplift || m.prestigeProductionMult > 1,
      detail:
        m.prestigeNodesOwned === 0
          ? 'no prestige nodes owned — uplift n/a'
          : `production x${m.prestigeProductionMult.toFixed(3)} over no-prestige base (+${m.prestigeStartResourceBonus}/res start bonus)`,
    },
    {
      // M6.1: the bot must start at least minEras eras in the separate era run.
      name: 'eras-started',
      ok: m.eras >= TARGETS.minEras,
      detail: `started ${m.eras} era(s) (target >= ${TARGETS.minEras})`,
    },
    {
      // M6.1: the bot must buy at least minEraPurchases era-node levels from banked EP.
      name: 'era-nodes-purchased',
      ok: m.eraPurchases >= TARGETS.minEraPurchases,
      detail: `bought ${m.eraPurchases} era levels (${m.eraNodesOwned} nodes, ${m.eraLevelsOwned} levels; target >= ${TARGETS.minEraPurchases})`,
    },
    {
      // M6.1: confirms the signature pp_mult era effect lifts prestige-point gain.
      name: 'era-pp-uplift',
      ok: !TARGETS.requireEraPpUplift || m.eraPpUplift > 1,
      detail: `pp gain x${m.eraPpUplift.toFixed(3)} with a maxed pp_mult era node (fixed prestige score)`,
    },
    {
      // M6.2: the bot must found at least minDynasties dynasties in the separate dynasty run.
      name: 'dynasties-founded',
      ok: m.dynasties >= TARGETS.minDynasties,
      detail: `founded ${m.dynasties} dynasty/dynasties (target >= ${TARGETS.minDynasties})`,
    },
    {
      // M6.2: the bot must buy at least minDynastyPurchases dynasty-node levels from banked DP.
      name: 'dynasty-nodes-purchased',
      ok: m.dynastyPurchases >= TARGETS.minDynastyPurchases,
      detail: `bought ${m.dynastyPurchases} dynasty levels (${m.dynastyNodesOwned} nodes, ${m.dynastyLevelsOwned} levels; target >= ${TARGETS.minDynastyPurchases})`,
    },
    {
      // M6.2: confirms the signature ep_mult dynasty effect lifts era-point gain.
      name: 'dynasty-ep-uplift',
      ok: !TARGETS.requireDynastyEpUplift || m.dynastyEpUplift > 1,
      detail: `ep gain x${m.dynastyEpUplift.toFixed(3)} with a maxed ep_mult dynasty node (fixed era score)`,
    },
    {
      // M6.2: confirms the automation_unlock gateway turns on all three idle automations.
      name: 'dynasty-automation-unlock',
      ok: !TARGETS.requireDynastyAutomationUnlock || m.dynastyAutomationUnlocked,
      detail: m.dynastyAutomationUnlocked
        ? 'automations unlocked account-wide by the dynasty gateway (build + recruit + attack)'
        : 'dynasty automation_unlock gateway did NOT unlock all three automations',
    },
    {
      // M8: the bot must COMPLETE at least minChallengesCompleted challenges in the separate
      // challenge run. Added ALONGSIDE the 17 core + prestige/era/dynasty/fortress/horde targets
      // above (all of which STILL evaluate here, unchanged): a challenge folds to identity in the
      // main + meta runs, so those targets stay byte-identical to pre-M8 — see the per-seed report.
      name: 'challenges-completed',
      ok: m.challengesCompleted >= TARGETS.minChallengesCompleted,
      detail: `completed ${m.challengesCompleted} challenge(s) in the dedicated run (reward active: ${m.challengeRewardActive}; target >= ${TARGETS.minChallengesCompleted})`,
    },
    {
      // M9: the bot must DELIVER at least minShipmentsDelivered merchant shipments in the separate
      // market run. Added ALONGSIDE the 17 core + prestige/era/dynasty/fortress/horde/challenge targets
      // above (all of which STILL evaluate here, unchanged): transport is a player-initiated action the
      // main + meta runs never take and which folds into nothing, so those targets stay BYTE-IDENTICAL
      // to pre-M9 (the market-identity the contract pins) — see the per-seed report below.
      name: 'shipments-delivered',
      ok: m.shipmentsDelivered >= TARGETS.minShipmentsDelivered,
      detail: `delivered ${m.shipmentsDelivered} shipment(s) carrying ${m.resourcesTransported} resources in the dedicated market run (target >= ${TARGETS.minShipmentsDelivered})`,
    },
    {
      // M9.2: the bot must TRADE at least minResourcesExchanged gross input via market exchange in the
      // separate market run. Added ALONGSIDE the core + prestige/era/dynasty/fortress/horde/challenge/
      // market/cavalry targets above (all of which STILL evaluate here, unchanged): exchange is a
      // player-initiated action the main + meta runs never take and which folds into nothing, so those
      // targets stay BYTE-IDENTICAL to pre-M9.2 (the exchange identity the contract pins) — see the
      // per-seed report below.
      name: 'resources-exchanged',
      ok: D(m.resourcesExchanged).gte(TARGETS.minResourcesExchanged),
      detail: `traded ${m.resourcesExchanged} resources via market exchange in the dedicated run (target >= ${TARGETS.minResourcesExchanged})`,
    },
    {
      // M10: the bot must TRAIN at least minCavalryRecruited cavalry in the separate cavalry run. Added
      // ALONGSIDE the 17 core + prestige/era/dynasty/fortress/horde/challenge/market targets above (all of
      // which STILL evaluate here, unchanged): the cavalry is Stajnia-gated and the Stajnia is
      // autoBuildable:false, so the main + meta runs never build it, never unlock the cavalry, and stay
      // BYTE-IDENTICAL to pre-M10 (the cavalry identity the contract pins) — see the per-seed report below.
      name: 'cavalry-recruited',
      ok: m.cavalryRecruited >= TARGETS.minCavalryRecruited,
      detail: `trained ${m.cavalryRecruited} cavalry (Stajnia lvl ${m.stableBuilt}) in the dedicated run (target >= ${TARGETS.minCavalryRecruited})`,
    },
  ]
}

async function main(): Promise<void> {
  const ticks = TARGETS.maxTicks
  process.stderr.write(`  [sim] running ${SEEDS.length} seeds in parallel (ticks/run=${ticks})…\n`)
  const results = await runSeeds(SEEDS, ticks)

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

  // --- Hordes per seed (M7.2 telegraphed, escalating capital invasion) ---
  console.log('--- Hordes (end) ---')
  console.log('seed     | repelled | breached | max level (= total faced)')
  for (const r of results) {
    const m = r.metrics
    console.log(
      `${m.seed.padEnd(8)} | ${String(m.hordesRepelled).padStart(8)} | ${String(m.hordesBreached).padStart(8)} | ` +
        `${String(m.hordeMaxLevel).padStart(9)}`,
    )
  }
  console.log('')

  // --- M7.2 horde coverage (HARD proof-of-mechanic; reads the run's invariants) ---
  console.log('--- M7.2 hordes (coverage) ---')
  const m72Names = ['horde-escalation', 'horde-breach-no-softlock', 'horde-save-load']
  for (const r of results) {
    const line = m72Names
      .map((name) => {
        const inv = r.invariants.find((i) => i.name === name)
        const mark = inv ? (inv.ok ? 'ok' : 'FAIL') : 'n/a'
        return `${name}=${mark}`
      })
      .join('  ')
    console.log(`${r.metrics.seed.padEnd(8)} | ${line}`)
    // Surface each detail so a passing escalation / breach / save-load check is visible, not just the count.
    for (const name of m72Names) {
      const inv = r.invariants.find((i) => i.name === name)
      if (inv?.detail) console.log(`      ${inv.ok ? 'ok  ' : 'FAIL'} ${name} — ${inv.detail}`)
    }
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

  // --- Tech per seed (M3.1 global passive tree) ---
  console.log('--- Tech (end) ---')
  console.log('seed     | levels bought | nodes owned | total levels | production uplift (no-tech -> with-tech)')
  for (const r of results) {
    const m = r.metrics
    const uplift =
      m.techPurchases === 0
        ? 'n/a (none bought)'
        : `x${m.techProductionMult.toFixed(3)} (${m.productionBaseNoTech} -> ${m.productionEnd})`
    console.log(
      `${m.seed.padEnd(8)} | ${String(m.techPurchases).padStart(13)} | ${String(m.techNodesOwned).padStart(11)} | ` +
        `${String(m.techLevelsOwned).padStart(12)} | ${uplift}`,
    )
  }
  console.log('')

  // --- Prestige per seed (M4.1 ascension meta-layer; separate ascension-driving run) ---
  console.log('--- Prestige (end) ---')
  console.log(
    'seed     | ascensions (first tick) | PP banked / earned | levels bought | nodes owned | production uplift | start bonus',
  )
  for (const r of results) {
    const m = r.metrics
    console.log(
      `${m.seed.padEnd(8)} | ${String(m.ascensions).padStart(10)} (${m.firstAscendTick ?? 'n/a'}) | ` +
        `${m.prestigePointsBanked} / ${m.prestigeTotalEarned} | ${String(m.prestigePurchases).padStart(13)} | ` +
        `${String(m.prestigeNodesOwned).padStart(11)} | x${m.prestigeProductionMult.toFixed(3)} | +${m.prestigeStartResourceBonus}/res`,
    )
  }
  console.log('')

  // --- Era per seed (M6.1 second meta-layer; separate era-driving run) ---
  console.log('--- Era (end) ---')
  console.log('seed     | eras started | levels bought | nodes owned | total levels | pp-gain uplift')
  for (const r of results) {
    const m = r.metrics
    console.log(
      `${m.seed.padEnd(8)} | ${String(m.eras).padStart(12)} | ${String(m.eraPurchases).padStart(13)} | ` +
        `${String(m.eraNodesOwned).padStart(11)} | ${String(m.eraLevelsOwned).padStart(12)} | x${m.eraPpUplift.toFixed(3)}`,
    )
  }
  console.log('')

  // --- Dynasty per seed (M6.2 third meta-layer; separate dynasty-driving run) ---
  console.log('--- Dynasty (end) ---')
  console.log('seed     | dynasties founded | levels bought | nodes owned | total levels | ep-gain uplift | automations from start')
  for (const r of results) {
    const m = r.metrics
    console.log(
      `${m.seed.padEnd(8)} | ${String(m.dynasties).padStart(17)} | ${String(m.dynastyPurchases).padStart(13)} | ` +
        `${String(m.dynastyNodesOwned).padStart(11)} | ${String(m.dynastyLevelsOwned).padStart(12)} | x${m.dynastyEpUplift.toFixed(3)} | ` +
        `${m.dynastyAutomationUnlocked ? 'unlocked' : 'locked'}`,
    )
  }
  console.log('')

  // --- Challenge per seed (M8 WYZWANIA; SEPARATE challenge-driving run) ---
  console.log('--- Challenge (end) ---')
  console.log('seed     | challenges completed | reward folds into a fresh run')
  for (const r of results) {
    const m = r.metrics
    console.log(
      `${m.seed.padEnd(8)} | ${String(m.challengesCompleted).padStart(20)} | ${m.challengeRewardActive ? 'yes' : 'no'}`,
    )
  }
  console.log('')

  // --- M8 challenge coverage (HARD proof-of-mechanic; reads the run's invariants) ---
  console.log('--- M8 challenge (coverage) ---')
  const m8Names = [
    'challenge-completed',
    'challenge-determinism',
    'challenge-constraint',
    'challenge-completion-once',
    'challenge-reward-folds',
    'challenge-reward-stacks',
    'challenge-no-softlock',
    'challenge-round-trip',
  ]
  for (const r of results) {
    const line = m8Names
      .map((name) => {
        const inv = r.invariants.find((i) => i.name === name)
        const mark = inv ? (inv.ok ? 'ok' : 'FAIL') : 'n/a'
        return `${name}=${mark}`
      })
      .join('  ')
    console.log(`${r.metrics.seed.padEnd(8)} | ${line}`)
    // Surface each detail so a passing completion / determinism / constraint / reward check is visible.
    for (const name of m8Names) {
      const inv = r.invariants.find((i) => i.name === name)
      if (inv?.detail) console.log(`      ${inv.ok ? 'ok  ' : 'FAIL'} ${name} — ${inv.detail}`)
    }
  }
  console.log('')

  // --- Market per seed (M9 RYNEK transport + M9.2 wymiana; SEPARATE market-driving run) ---
  console.log('--- Market (end) ---')
  console.log('seed     | shipments delivered | resources transported | resources exchanged')
  for (const r of results) {
    const m = r.metrics
    console.log(
      `${m.seed.padEnd(8)} | ${String(m.shipmentsDelivered).padStart(19)} | ${m.resourcesTransported.padStart(21)} | ${m.resourcesExchanged}`,
    )
  }
  console.log('')

  // --- M9 market coverage (HARD proof-of-mechanic; reads the run's invariants) ---
  console.log('--- M9 market: RYNEK transport + M9.2 wymiana (coverage) ---')
  const m9Names = [
    'shipments-delivered',
    'market-conservation',
    'market-capacity',
    'market-determinism',
    'market-no-softlock',
    'market-save-load',
    'resources-exchanged',
    'exchange-loses',
    'exchange-gated',
    'exchange-determinism',
    'exchange-inert',
  ]
  for (const r of results) {
    const line = m9Names
      .map((name) => {
        const inv = r.invariants.find((i) => i.name === name)
        const mark = inv ? (inv.ok ? 'ok' : 'FAIL') : 'n/a'
        return `${name}=${mark}`
      })
      .join('  ')
    console.log(`${r.metrics.seed.padEnd(8)} | ${line}`)
    // Surface each detail so a passing conservation / capacity / determinism / round-trip check is visible.
    for (const name of m9Names) {
      const inv = r.invariants.find((i) => i.name === name)
      if (inv?.detail) console.log(`      ${inv.ok ? 'ok  ' : 'FAIL'} ${name} — ${inv.detail}`)
    }
  }
  console.log('')

  // --- Cavalry per seed (M10 KAWALERIA; SEPARATE Stajnia-gated cavalry run) ---
  console.log('--- Cavalry (end) ---')
  console.log('seed     | cavalry trained | Stajnia level reached')
  for (const r of results) {
    const m = r.metrics
    console.log(
      `${m.seed.padEnd(8)} | ${String(m.cavalryRecruited).padStart(15)} | ${String(m.stableBuilt).padStart(21)}`,
    )
  }
  console.log('')

  // --- M10 cavalry coverage (HARD proof-of-mechanic; reads the run's invariants) ---
  console.log('--- M10 cavalry: KAWALERIA (coverage) ---')
  const m10Names = [
    'cavalry-recruited',
    'cavalry-attack-won',
    'cavalry-gated',
    'cavalry-inert',
    'cavalry-upkeep',
    'cavalry-save-load',
  ]
  for (const r of results) {
    const line = m10Names
      .map((name) => {
        const inv = r.invariants.find((i) => i.name === name)
        const mark = inv ? (inv.ok ? 'ok' : 'FAIL') : 'n/a'
        return `${name}=${mark}`
      })
      .join('  ')
    console.log(`${r.metrics.seed.padEnd(8)} | ${line}`)
    // Surface each detail so a passing gate / inertness / upkeep / save-load check is visible.
    for (const name of m10Names) {
      const inv = r.invariants.find((i) => i.name === name)
      if (inv?.detail) console.log(`      ${inv.ok ? 'ok  ' : 'FAIL'} ${name} — ${inv.detail}`)
    }
  }
  console.log('')

  // --- Automation per seed (M5.1 idle routines; SEPARATE coverage run, automation ON) ---
  console.log('--- Automation (idle routines, separate coverage run) ---')
  console.log('seed     | auto-built (levels) | auto-recruited (units) | auto-attacked (resolved)')
  for (const r of results) {
    const m = r.metrics
    console.log(
      `${m.seed.padEnd(8)} | ${String(m.automationBuilt).padStart(19)} | ` +
        `${String(m.automationRecruited).padStart(22)} | ${String(m.automationAttacked).padStart(24)}`,
    )
  }
  console.log('')

  // --- M5.2 wall + scouts coverage (HARD proof-of-mechanic; reads the run's invariants) ---
  console.log('--- M5.2 wall + scouts (coverage) ---')
  const m52Names = ['wall-mitigates', 'scout-reveals', 'm52-determinism']
  for (const r of results) {
    const line = m52Names
      .map((name) => {
        const inv = r.invariants.find((i) => i.name === name)
        const mark = inv ? (inv.ok ? 'ok' : 'FAIL') : 'n/a'
        return `${name}=${mark}`
      })
      .join('  ')
    console.log(`${r.metrics.seed.padEnd(8)} | ${line}`)
    // Surface the detail of each so a passing wall/scout check is visible, not just the count.
    for (const name of m52Names) {
      const inv = r.invariants.find((i) => i.name === name)
      if (inv?.detail) console.log(`      ${inv.ok ? 'ok  ' : 'FAIL'} ${name} — ${inv.detail}`)
    }
  }
  console.log('')

  // --- M5.3 siege (ram + catapult) coverage (HARD proof-of-mechanic; reads the run's invariants) ---
  console.log('--- M5.3 siege: ram + catapult (coverage) ---')
  const m53Names = ['ram-cracks', 'catapult-razes', 'm53-determinism']
  for (const r of results) {
    const line = m53Names
      .map((name) => {
        const inv = r.invariants.find((i) => i.name === name)
        const mark = inv ? (inv.ok ? 'ok' : 'FAIL') : 'n/a'
        return `${name}=${mark}`
      })
      .join('  ')
    console.log(`${r.metrics.seed.padEnd(8)} | ${line}`)
    // Surface the detail of each so a passing ram/catapult check is visible, not just the count.
    for (const name of m53Names) {
      const inv = r.invariants.find((i) => i.name === name)
      if (inv?.detail) console.log(`      ${inv.ok ? 'ok  ' : 'FAIL'} ${name} — ${inv.detail}`)
    }
  }
  console.log('')

  // --- M5.4 lifetime stats + achievements (end of the MAIN run) ---
  console.log('--- Lifetime stats & achievements (end) ---')
  console.log(
    'seed     | attacks (won/lost) | loot hauled | raids (rep/lost) | razed (camps/forts) | scouts | founded/conq | achievements',
  )
  for (const r of results) {
    const m = r.metrics
    const lt = m.lifetime
    console.log(
      `${m.seed.padEnd(8)} | ${String(lt.attacksWon)}/${lt.attacksLost} | ${lt.lootHauled} | ` +
        `${lt.raidsRepelled}/${lt.raidsLost} | ${String(lt.campsRazed)}/${String(lt.fortressesRazed).padStart(5)} | ${String(lt.scoutsReturned).padStart(6)} | ` +
        `${lt.villagesFounded}/${lt.villagesConquered} | ${m.achievementsUnlocked}/${m.achievementsTotal}`,
    )
  }
  console.log('')

  // --- M5.4 stats + achievements coverage (HARD proof-of-mechanic; reads the run's invariants) ---
  console.log('--- M5.4 stats + achievements (coverage) ---')
  const m54Names = ['stats-accumulated', 'stats-cross-check', 'achievements-unlocked', 'm54-determinism']
  for (const r of results) {
    const line = m54Names
      .map((name) => {
        const inv = r.invariants.find((i) => i.name === name)
        const mark = inv ? (inv.ok ? 'ok' : 'FAIL') : 'n/a'
        return `${name}=${mark}`
      })
      .join('  ')
    console.log(`${r.metrics.seed.padEnd(8)} | ${line}`)
    // Surface each detail so a passing accumulation / determinism check is visible, not just the count.
    for (const name of m54Names) {
      const inv = r.invariants.find((i) => i.name === name)
      if (inv?.detail) console.log(`      ${inv.ok ? 'ok  ' : 'FAIL'} ${name} — ${inv.detail}`)
    }
  }
  console.log('')

  // --- M5.5 combat luck coverage (HARD proof-of-mechanic; reads the run's invariants) ---
  console.log('--- M5.5 combat luck (coverage) ---')
  const m55Names = ['luck-distribution', 'luck-varies', 'auto-attack-luck-safe', 'luck-determinism']
  for (const r of results) {
    const line = m55Names
      .map((name) => {
        const inv = r.invariants.find((i) => i.name === name)
        const mark = inv ? (inv.ok ? 'ok' : 'FAIL') : 'n/a'
        return `${name}=${mark}`
      })
      .join('  ')
    console.log(`${r.metrics.seed.padEnd(8)} | ${line}`)
    // Surface each detail so a passing distribution / variance / safety / determinism check is visible.
    for (const name of m55Names) {
      const inv = r.invariants.find((i) => i.name === name)
      if (inv?.detail) console.log(`      ${inv.ok ? 'ok  ' : 'FAIL'} ${name} — ${inv.detail}`)
    }
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

// Entry: WORKER mode runs a single seed and emits its RunResult as JSON for the parent to
// collect; otherwise this is the PARENT, which fans the seeds out and prints the full report.
const workerIdx = process.argv.indexOf(WORKER_FLAG)
if (workerIdx !== -1) {
  const seed = process.argv[workerIdx + 1]
  const ticks = Number(process.argv[workerIdx + 2])
  // Single JSON blob to stdout, nothing else — the parent JSON.parses exactly this.
  process.stdout.write(JSON.stringify(runOne(seed, ticks)))
} else {
  // Surface async failures (a child rejection that escaped the fallback) with a non-zero exit
  // rather than an unhandled-rejection warning, so CI / the pre-commit gate still blocks.
  main().catch((err) => {
    console.error(`RESULT: FAIL — sim harness crashed: ${String(err)}`)
    process.exit(1)
  })
}
