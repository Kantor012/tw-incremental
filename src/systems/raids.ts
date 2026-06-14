import { ZERO, type Decimal } from '../engine/decimal'
import {
  RESOURCE_IDS,
  INITIAL_BUILDINGS,
  RAID_BASE_INTERVAL,
  type GameState,
} from '../engine/state'
import { BUILDING_IDS } from '../content/buildings'
import { UNIT_IDS } from '../content/units'
import { battleOutcome, armyDefensePower, applyLosses } from './combat'
import { stationedUnits, pushBattleReport } from './marches'

/**
 * Raid engine — incoming barbarian attacks the player must DEFEND (M1.3). The
 * mirror of marches.ts: instead of the player attacking a camp, a barb host
 * attacks the village on a timer. Deterministic and RNG-free; the only mutating
 * entry point is {@link advanceRaids}, advanced on the SAME fixed tick grid as
 * everything else (simulate feeds it uniform sub-steps) so online / offline / sim
 * stay byte-identical.
 *
 * Design intent (and the reason this is safe to run unattended in the sim): a raid
 * is resolved with the shared {@link battleOutcome} and scales with player progress
 * (empire size + a sub-weighted share of the army). A raid that out-powers the home
 * garrison succeeds and the garrison takes losses; a garrison strong enough to
 * out-defend it repels it with zero losses. Because the threat grows with the
 * empire, a PASSIVE economy that never goes on the offensive will face steady
 * attrition on its home stack — that is the intended unit SINK that keeps the
 * recruit→lose→recruit loop turning without a content frontier. The army component
 * is weighted below 1 so investing heavily in defence is always a viable answer,
 * and sending your army out on a march (those units stop counting as
 * {@link stationedUnits}) deliberately leaves you exposed — the risk side of
 * raiding. Losses and theft can never drive resources negative or units below zero.
 * Exact defensibility (how big a garrison repels which tier) is a Balance knob.
 */

/** Flat raid power floor. */
const RAID_BASE = 10
/** Raid power added per total owned building level (a coarse progress proxy). */
const RAID_PER_BUILDING_LEVEL = 3
/**
 * Fraction of the player's TOTAL army defence that the raid matches. Below 1 on
 * purpose: the army term alone can never out-scale a home garrison fielded at full
 * defence weight, so growing the garrison is always a winning response (the fixed
 * building term still sets the bar a small stack must clear).
 */
const RAID_PER_ARMY = 0.4
/** Fraction of each resource stolen when a raid succeeds. */
const RAID_LOOT_FRAC = 0.2

/** Sum of all building levels — the structural part of the progress proxy. */
function buildingLevelSum(state: GameState): number {
  let sum = 0
  for (const id of BUILDING_IDS) sum += state.buildings[id]
  return sum
}

/**
 * Strength of an incoming raid, scaling with player progress: a flat base, the
 * total building level, and a sub-unit-weighted share of the player's whole army
 * (so raids stay relevant as the army grows without ever out-scaling a home
 * garrison). Uses the full owned roster (`state.units`) as the army proxy — the
 * threat is sized to the empire, while the defence that meets it is only what's
 * stationed at home.
 */
export function raidPower(state: GameState): number {
  return (
    RAID_BASE +
    RAID_PER_BUILDING_LEVEL * buildingLevelSum(state) +
    RAID_PER_ARMY * armyDefensePower(state.units)
  )
}

/**
 * Whether the village is "worth raiding" yet. A fresh hamlet (starting buildings,
 * no units, no marches) is left alone — so the timer is frozen and a brand-new
 * game (and the storage-cap unit test, which runs on exactly that state) never
 * sees a raid. The moment the player builds anything, recruits a unit, or sends a
 * march, raids begin counting down.
 */
function raidsActive(state: GameState): boolean {
  if (state.marches.length > 0) return true
  for (const id of UNIT_IDS) if (state.units[id] > 0) return true
  let initSum = 0
  for (const id of BUILDING_IDS) initSum += INITIAL_BUILDINGS[id]
  return buildingLevelSum(state) > initSum
}

/** Resolve one raid against the current home garrison. Deterministic. */
function resolveRaid(state: GameState): void {
  const power = raidPower(state)
  const home = stationedUnits(state)
  const outcome = battleOutcome(power, armyDefensePower(home)) // attacker = the raid

  if (!outcome.attackerWins) {
    // Repelled: no losses, nothing stolen (the raiders break on the wall).
    pushBattleReport(state, { kind: 'raid', won: true, looted: '0', losses: 0 })
    return
  }

  // Raid succeeds: the garrison takes losses and a slice of resources is hauled off.
  const survivors = applyLosses(home, outcome.defenderLossFrac)
  let losses = 0
  for (const id of UNIT_IDS) {
    const lost = home[id] - survivors[id]
    if (lost > 0) {
      state.units[id] -= lost
      if (state.units[id] < 0) state.units[id] = 0
      losses += lost
    }
  }

  let looted: Decimal = ZERO
  for (const id of RESOURCE_IDS) {
    let steal = state.resources[id].mul(RAID_LOOT_FRAC).floor()
    if (steal.gt(state.resources[id])) steal = state.resources[id] // never negative
    state.resources[id] = state.resources[id].sub(steal)
    looted = looted.add(steal)
  }

  pushBattleReport(state, { kind: 'raid', won: false, looted: looted.toString(), losses })
}

/**
 * Advance the raid clock by `dtSeconds`, firing a raid each time it elapses. Frozen
 * (no-op) while the village is not yet {@link raidsActive}. Re-arms to
 * {@link RAID_BASE_INTERVAL} after each raid, and a single large `dt` (long offline
 * catch-up) resolves every raid that fell within the window in order. Deterministic
 * and Node-safe.
 */
export function advanceRaids(state: GameState, dtSeconds: number): void {
  if (!(dtSeconds > 0)) return
  if (!raidsActive(state)) return
  let dt = dtSeconds
  while (dt > 0) {
    if (state.raidTimer > dt) {
      state.raidTimer -= dt
      break
    }
    dt -= state.raidTimer
    state.raidTimer = 0
    resolveRaid(state)
    state.raidTimer = RAID_BASE_INTERVAL
  }
}
