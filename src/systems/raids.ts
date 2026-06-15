import { ZERO, type Decimal } from '../engine/decimal'
import {
  RESOURCE_IDS,
  INITIAL_BUILDINGS,
  RAID_BASE_INTERVAL,
  NO_TECH_MODS,
  type Village,
  type BattleReport,
  type TechModifiers,
  type Stats,
} from '../engine/state'
import { BUILDING_IDS } from '../content/buildings'
import { UNIT_IDS } from '../content/units'
import { battleOutcome, armyDefensePower, applyLosses, luckFactor } from './combat'
import { villageDefenseMult } from './buildings'
import { stationedUnits, pushBattleReport } from './marches'
import type { RNG } from '../engine/rng'

/** Raid report variant of {@link BattleReport}, narrowed so `luck` is settable. */
type RaidReport = Extract<BattleReport, { kind: 'raid' }>

/**
 * Raid engine — incoming barbarian attacks the player must DEFEND (M1.3). The
 * mirror of marches.ts: instead of the player attacking a camp, a barb host
 * attacks a village on a timer. DETERMINISTIC: the only mutating entry point is
 * {@link advanceRaids}, advanced on the SAME fixed tick grid as everything else
 * (simulate feeds it uniform sub-steps). The only randomness is combat LUCK
 * (M5.5) — one {@link luckFactor} draw per resolved raid, taken from the per-subStep
 * `rng` the tick seeds from the persisted `rngState`; because the draw count and
 * order are fixed by the tick grid, online / offline / sim stay byte-identical.
 *
 * Since M2.1 raids are PER-VILLAGE: every function takes the {@link Village} it
 * acts on, and the GLOBAL battle log is threaded in explicitly (`log`) so each
 * report can be tagged with the village it came from ({@link BattleReport.villageId}).
 * The tick advances each village in {@link GameState.villageOrder}, so resolution
 * order — and therefore the log — stays deterministic across many villages.
 *
 * Design intent (and the reason this is safe to run unattended in the sim): a raid
 * is resolved with the shared {@link battleOutcome} and scales with that village's
 * progress (its buildings + a sub-weighted share of its army). A raid that
 * out-powers the home garrison succeeds and the garrison takes losses; a garrison
 * strong enough to out-defend it repels it with zero losses. Because the threat
 * grows with the village, a PASSIVE economy that never goes on the offensive will
 * face steady attrition on its home stack — that is the intended unit SINK that
 * keeps the recruit→lose→recruit loop turning without a content frontier. The army
 * component is weighted below 1 so investing heavily in defence is always a viable
 * answer, and sending the army out on a march (those units stop counting as
 * {@link stationedUnits}) deliberately leaves the village exposed — the risk side
 * of raiding. Losses and theft can never drive resources negative or units below
 * zero. Exact defensibility (how big a garrison repels which tier) is a Balance knob.
 */

/** Flat raid power floor. */
const RAID_BASE = 10
/** Raid power added per total owned building level (a coarse progress proxy). */
const RAID_PER_BUILDING_LEVEL = 3
/**
 * Fraction of the village's TOTAL army defence that the raid matches. Below 1 on
 * purpose: the army term alone can never out-scale a home garrison fielded at full
 * defence weight, so growing the garrison is always a winning response (the fixed
 * building term still sets the bar a small stack must clear).
 */
const RAID_PER_ARMY = 0.4
/** Fraction of each resource stolen when a raid succeeds. */
const RAID_LOOT_FRAC = 0.2

/** Sum of all building levels in a village — the structural part of the proxy. */
function buildingLevelSum(v: Village): number {
  let sum = 0
  for (const id of BUILDING_IDS) sum += v.buildings[id]
  return sum
}

/**
 * Strength of an incoming raid, scaling with the village's progress: a flat base,
 * the total building level, and a sub-unit-weighted share of the village's whole
 * army (so raids stay relevant as the army grows without ever out-scaling a home
 * garrison). Uses the full owned roster (`v.units`) as the army proxy — the threat
 * is sized to the village, while the defence that meets it is only what's stationed
 * at home.
 */
export function raidPower(v: Village): number {
  return (
    RAID_BASE +
    RAID_PER_BUILDING_LEVEL * buildingLevelSum(v) +
    RAID_PER_ARMY * armyDefensePower(v.units)
  )
}

/**
 * Whether the village is "worth raiding" yet. A fresh hamlet (starting buildings,
 * no units, no marches) is left alone — so the timer is frozen and a brand-new
 * game (and the storage-cap unit test, which runs on exactly that state) never
 * sees a raid. The moment the player builds anything, recruits a unit, or sends a
 * march, raids begin counting down.
 */
function raidsActive(v: Village): boolean {
  if (v.marches.length > 0) return true
  for (const id of UNIT_IDS) if (v.units[id] > 0) return true
  let initSum = 0
  for (const id of BUILDING_IDS) initSum += INITIAL_BUILDINGS[id]
  return buildingLevelSum(v) > initSum
}

/**
 * Resolve one raid against the village's current home garrison. Deterministic.
 *
 * `mods` are the aggregated tech multipliers: ONLY the player's home defence is
 * scaled by them (`armyDefensePower(home, mods)` — the `mods.defenseMult` from the
 * fortification branch), so buying defence perks directly hardens the garrison
 * against raids. The incoming raid's strength ({@link raidPower}) is left on the
 * NO_TECH_MODS default on purpose: its army term is a coarse village-progress proxy,
 * not the player's defence, and scaling it by `defenseMult` too would cancel the
 * very bonus the player paid for. Default {@link NO_TECH_MODS} (1) reproduces the
 * pre-M3.2 outcome byte-for-byte for any caller that does not thread tech.
 *
 * M5.2: the home defence is additionally multiplied by {@link villageDefenseMult}, the
 * village's WALL shield (1 = no wall). The wall is a building, not tech, so it stacks
 * with `mods.defenseMult`: a higher wall means a bigger defence figure into
 * {@link battleOutcome}, i.e. more raids repelled and smaller losses on the ones that
 * still land. A wall-less village has mult 1, so this is byte-identical to pre-M5.2.
 *
 * M5.5 LUCK: when an `rng` is threaded in (the per-subStep instance seeded from the
 * persisted `rngState`), the RAIDER's power is multiplied by one {@link luckFactor}
 * draw — a symmetric +/-{@link COMBAT_LUCK} roll (mean 1.0) — BEFORE {@link battleOutcome}
 * (which itself stays RNG-free). The draw happens EXACTLY ONCE here, and `resolveRaid`
 * is called exactly once per fired raid, so the number and order of draws is invariant
 * to how `dt` is chopped — the property that keeps `rngState` (and every outcome) byte
 * identical online / offline / chunked / in the sim. The roll is recorded on the report
 * (`luck`). Callers that pass NO rng (unit tests / per-tier probes that don't exercise
 * luck) take `luck = 1` and emit a report WITHOUT the field — pre-M5.5 byte-for-byte.
 */
function resolveRaid(
  v: Village,
  log: BattleReport[],
  mods: TechModifiers = NO_TECH_MODS,
  stats?: Stats,
  rng?: RNG,
): void {
  // One luck draw per resolved raid (see docstring). Absent rng → no draw, luck = 1.
  const luck = rng !== undefined ? luckFactor(rng) : undefined
  const power = raidPower(v) * (luck ?? 1)
  const home = stationedUnits(v)
  // attacker = the raid (luck-scaled); defender = the home garrison hardened by tech
  // (defenseMult) AND the village wall (villageDefenseMult).
  const outcome = battleOutcome(power, armyDefensePower(home, mods) * villageDefenseMult(v))

  if (!outcome.attackerWins) {
    // Repelled: no losses, nothing stolen (the raiders break on the wall).
    if (stats !== undefined) stats.raidsRepelled += 1 // M5.4: lifetime counter
    const report: RaidReport = { kind: 'raid', villageId: v.id, won: true, looted: '0', losses: 0 }
    if (luck !== undefined) report.luck = luck
    pushBattleReport(log, report)
    return
  }

  // The raid broke through (M5.4 lifetime counter).
  if (stats !== undefined) stats.raidsLost += 1

  // Raid succeeds: the garrison takes losses and a slice of resources is hauled off.
  const survivors = applyLosses(home, outcome.defenderLossFrac)
  let losses = 0
  for (const id of UNIT_IDS) {
    const lost = home[id] - survivors[id]
    if (lost > 0) {
      v.units[id] -= lost
      if (v.units[id] < 0) v.units[id] = 0
      losses += lost
    }
  }

  let looted: Decimal = ZERO
  for (const id of RESOURCE_IDS) {
    let steal = v.resources[id].mul(RAID_LOOT_FRAC).floor()
    if (steal.gt(v.resources[id])) steal = v.resources[id] // never negative
    v.resources[id] = v.resources[id].sub(steal)
    looted = looted.add(steal)
  }

  const report: RaidReport = {
    kind: 'raid',
    villageId: v.id,
    won: false,
    looted: looted.toString(),
    losses,
  }
  if (luck !== undefined) report.luck = luck
  pushBattleReport(log, report)
}

/**
 * Advance the village's raid clock by `dtSeconds`, firing a raid each time it
 * elapses. Frozen (no-op) while the village is not yet {@link raidsActive}.
 * Re-arms to {@link RAID_BASE_INTERVAL} after each raid, and a single large `dt`
 * (long offline catch-up) resolves every raid that fell within the window in order.
 * Reports land on the shared global `log`, tagged with this village. Deterministic
 * and Node-safe.
 *
 * `mods` are the aggregated tech multipliers (M3.2), threaded straight into each
 * {@link resolveRaid} so the player's home defence enjoys the fortification bonus.
 * The tick computes them once per sub-step and passes them in; they default to
 * {@link NO_TECH_MODS} (1) so a caller without tech (or a pre-M3.2 call site)
 * resolves raids exactly as before.
 *
 * `stats` (M5.4, OPTIONAL) is the mutable lifetime-counter record threaded in by the
 * tick (`state.stats`). Each resolved raid bumps it on this deterministic path —
 * `raidsRepelled` when the garrison holds, `raidsLost` when it breaks — so the
 * counters grow identically online / offline / sim and never from the UI. Callers
 * that don't track stats (tests, the per-tier sim probe) leave it undefined and get
 * the exact pre-M5.4 behaviour.
 *
 * `rng` (M5.5, OPTIONAL) is the per-subStep RNG instance the tick seeds from the
 * persisted `rngState` and threads into BOTH advanceMarches and advanceRaids (the
 * SAME instance, in `villageOrder`), so combat LUCK draws come from one deterministic
 * stream. It is passed straight to {@link resolveRaid}, which draws EXACTLY ONCE per
 * fired raid — never for a frozen (inactive) village, so the draw count tracks the
 * number of raids that actually resolve in the window and stays invariant to the `dt`
 * split. Omitting it (tests / probes) keeps the pre-M5.5 luck-free resolution.
 */
export function advanceRaids(
  v: Village,
  log: BattleReport[],
  dtSeconds: number,
  mods: TechModifiers = NO_TECH_MODS,
  stats?: Stats,
  rng?: RNG,
): void {
  if (!(dtSeconds > 0)) return
  if (!raidsActive(v)) return
  let dt = dtSeconds
  while (dt > 0) {
    if (v.raidTimer > dt) {
      v.raidTimer -= dt
      break
    }
    dt -= v.raidTimer
    v.raidTimer = 0
    resolveRaid(v, log, mods, stats, rng)
    v.raidTimer = RAID_BASE_INTERVAL
  }
}
