import { describe, it, expect } from 'vitest'
import { D } from '../src/engine/decimal'
import {
  createInitialState,
  recomputeDerived,
  INITIAL_BUILDINGS,
  RAID_BASE_INTERVAL,
  type GameState,
} from '../src/engine/state'
import { advanceRaids, raidPower } from '../src/systems/raids'
import { armyDefensePower } from '../src/systems/combat'
import { villageDefenseMult } from '../src/systems/buildings'
import { BUILDING_IDS } from '../src/content/buildings'
import { type UnitId } from '../src/content/units'
import { simulate } from '../src/engine/tick'
import { applyOffline } from '../src/engine/offline'
import { serialize } from '../src/engine/save'

/** A full (all UnitId present) roster snapshot. */
function army(
  spearman = 0,
  swordsman = 0,
  axeman = 0,
  noble = 0,
  scout = 0,
): Record<UnitId, number> {
  return { spearman, swordsman, axeman, noble, scout }
}

/**
 * A state whose capital ('v0', "Stolica") has its starting buildings and a stocked
 * treasury — raids are active. Since M2.1 the economy lives per-village, so we mutate
 * `s.villages.v0`; the raid system takes that {@link Village} and the GLOBAL
 * `s.battleLog` explicitly, and every report it pushes is tagged with the village.
 */
function village(seed = 'r'): GameState {
  const s = createInitialState(seed, 0)
  s.villages.v0.resources = { wood: D(100), clay: D(100), iron: D(100) }
  return s
}

describe('raidPower', () => {
  it('scales with the flat base, building levels and a fraction of army defence', () => {
    const s = village()
    const v = s.villages.v0
    v.units = army(10, 0, 0)
    let buildingSum = 0
    for (const id of BUILDING_IDS) buildingSum += v.buildings[id]
    expect(raidPower(v)).toBeCloseTo(10 + 3 * buildingSum + 0.4 * armyDefensePower(v.units))
  })
})

describe('advanceRaids', () => {
  it('a strong garrison repels the raid with no losses, then re-arms the timer', () => {
    const s = village()
    const v = s.villages.v0
    v.units = army(10, 0, 0) // defence 150 ≫ raid power 88 → repelled
    advanceRaids(v, s.battleLog, RAID_BASE_INTERVAL)

    expect(s.battleLog.length).toBe(1)
    expect(s.battleLog[0]).toMatchObject({
      kind: 'raid',
      villageId: 'v0',
      won: true,
      looted: '0',
      losses: 0,
    })
    expect(v.units.spearman).toBe(10) // untouched
    expect(v.resources.wood.toString()).toBe('100') // nothing stolen
    expect(v.raidTimer).toBe(RAID_BASE_INTERVAL) // re-armed
  })

  it('a weak garrison loses units and 20% of each resource', () => {
    const s = village()
    const v = s.villages.v0
    v.units = army(1, 0, 0) // defence 15 < raid power 34 → raid succeeds
    advanceRaids(v, s.battleLog, RAID_BASE_INTERVAL)

    const r = s.battleLog[0]
    // Narrow off the discriminant so won/losses (absent on the M2.4 'conquer' variant)
    // are accessible — and the test fails loudly if a non-raid report ever lands here.
    if (r.kind !== 'raid') throw new Error(`expected a raid report, got ${r.kind}`)
    expect(r.villageId).toBe('v0') // tagged with the originating village
    expect(r.won).toBe(false) // raid succeeded (from the player's view: lost)
    expect(r.losses).toBeGreaterThan(0)
    expect(v.units.spearman).toBe(0) // garrison wiped
    expect(v.resources.wood.toString()).toBe('80') // floor(100 * 0.2) stolen
    expect(v.resources.clay.toString()).toBe('80')
    expect(v.resources.iron.toString()).toBe('80')
    expect(v.raidTimer).toBe(RAID_BASE_INTERVAL)
  })

  it('never drives resources below zero, even when the pool is tiny', () => {
    const s = village()
    const v = s.villages.v0
    v.units = army(1, 0, 0) // weak: the raid will succeed
    v.resources = { wood: D(4), clay: D(0), iron: D(2) }
    advanceRaids(v, s.battleLog, RAID_BASE_INTERVAL)

    // floor(4*.2)=0, floor(0)=0, floor(2*.2)=0 → nothing stolen, none negative.
    expect(v.resources.wood.gte(0)).toBe(true)
    expect(v.resources.clay.gte(0)).toBe(true)
    expect(v.resources.iron.gte(0)).toBe(true)
  })

  it('a fresh hamlet is not yet worth raiding (timer frozen, no raid)', () => {
    const s = createInitialState('fresh', 0)
    const v = s.villages.v0
    advanceRaids(v, s.battleLog, 100_000)
    expect(s.battleLog.length).toBe(0)
    expect(v.raidTimer).toBe(RAID_BASE_INTERVAL)
  })

  it('resolves every raid that falls within one large dt (offline catch-up)', () => {
    const s = village()
    const v = s.villages.v0
    v.units = army(10, 0, 0) // strong: repels each, garrison persists across raids
    advanceRaids(v, s.battleLog, RAID_BASE_INTERVAL * 3)

    expect(s.battleLog.length).toBe(3)
    for (const r of s.battleLog) expect(r).toMatchObject({ kind: 'raid', villageId: 'v0', won: true })
    expect(v.units.spearman).toBe(10)
    expect(v.raidTimer).toBe(RAID_BASE_INTERVAL)
  })
})

describe('determinism — raids replay identically', () => {
  it('one big simulate() equals the chunked offline path with raids firing', () => {
    const raidState = (seed: string): GameState => {
      const s = village(seed)
      s.villages.v0.units = army(3, 0, 2) // defence 65 ≥ raid power 54 → repelled, garrison persists
      return s
    }

    const seconds = 1300 // covers raids at 600 and 1200
    const big = raidState('det')
    simulate(big, seconds)
    big.lastSeen = seconds * 1000

    const chunked = raidState('det')
    applyOffline(chunked, seconds * 1000)

    expect(serialize(big)).toBe(serialize(chunked))
    // Sanity: raids actually fired (so the equality is meaningful).
    expect(big.battleLog.length).toBeGreaterThan(0)
  })
})

/**
 * M5.2 — the WALL hardens a village's raid defence (defense_bonus building effect,
 * consumed via villageDefenseMult in raids.ts). These cases isolate the wall's effect
 * from the raidPower building-level coupling: each pair of villages carries the SAME
 * total building level (so raidPower is identical) and the SAME garrison, differing
 * ONLY in whether those extra levels are the wall (a defence multiplier) or a neutral
 * economy building (no defence). With raidPower and the raw garrison held equal, any
 * difference in the raid's outcome is attributable to the wall alone.
 */
describe('wall (Mur) — raid mitigation (M5.2)', () => {
  /**
   * A fresh village with a 5-spearman garrison (raw defence 75) and a controlled
   * building map: the INITIAL footprint plus `wallLevel` on the wall AND `fillerLevel`
   * on a NON-defensive economy building (iron_mine). Callers pick the two so the TOTAL
   * building level — hence raidPower — matches across a walled / un-walled pair.
   */
  function walledVillage(wallLevel: number, fillerLevel: number): GameState {
    const s = village()
    const v = s.villages.v0
    v.units = army(5) // 5 spearmen → armyDefensePower 75
    v.buildings = { ...INITIAL_BUILDINGS, wall: wallLevel, iron_mine: 1 + fillerLevel }
    recomputeDerived(s)
    return s
  }

  it('villageDefenseMult is 1 with no wall and rises +perLevel per wall level', () => {
    const none = walledVillage(0, 0)
    expect(villageDefenseMult(none.villages.v0)).toBe(1)
    const some = walledVillage(4, 0)
    // +0.05 per level (BUILDINGS.wall.effect.perLevel) → 1 + 4*0.05 = 1.2.
    expect(villageDefenseMult(some.villages.v0)).toBeCloseTo(1.2)
    const maxed = walledVillage(10, 0)
    expect(villageDefenseMult(maxed.villages.v0)).toBeCloseTo(1.5)
  })

  it('a walled village REPELS a raid that wipes the same un-walled garrison (losses with wall < without)', () => {
    // Both villages: garrison defence 75, identical building total (16) ⇒ raidPower 88.
    //  - walled (wall 10): defence 75 * 1.5 = 112.5 ≥ 88 → repelled, zero losses.
    //  - un-walled (iron_mine +10 instead): defence 75 < 88 → raid succeeds, garrison wiped.
    const walled = walledVillage(10, 0)
    const unwalled = walledVillage(0, 10)

    // raidPower is identical (the wall and the filler add the same building level).
    expect(raidPower(walled.villages.v0)).toBe(raidPower(unwalled.villages.v0))

    advanceRaids(walled.villages.v0, walled.battleLog, RAID_BASE_INTERVAL)
    advanceRaids(unwalled.villages.v0, unwalled.battleLog, RAID_BASE_INTERVAL)

    const wReport = walled.battleLog[0]
    const uReport = unwalled.battleLog[0]
    if (wReport.kind !== 'raid' || uReport.kind !== 'raid') throw new Error('expected raid reports')

    // The wall turns a full wipe into a clean repel — strictly fewer losses.
    expect(wReport.won).toBe(true) // repelled (player's view: won)
    expect(wReport.losses).toBe(0)
    expect(walled.villages.v0.units.spearman).toBe(5) // garrison intact
    expect(walled.villages.v0.resources.wood.toString()).toBe('100') // nothing stolen

    expect(uReport.won).toBe(false) // raid succeeded
    expect(uReport.losses).toBe(5)
    expect(unwalled.villages.v0.units.spearman).toBe(0) // garrison wiped
    expect(unwalled.villages.v0.resources.wood.toString()).toBe('80') // 20% stolen

    // The contract claim, stated directly: losses WITH the wall < losses WITHOUT it.
    expect(wReport.losses).toBeLessThan(uReport.losses)
  })

  it('a wall-less village resolves raids byte-identically to pre-M5.2 (mult 1 is a no-op)', () => {
    // villageDefenseMult is exactly 1 with no wall, so the defence fed to battleOutcome
    // is unchanged — the existing weak-garrison case still loses the same way.
    const s = village()
    const v = s.villages.v0
    v.units = army(1, 0, 0) // defence 15 < raid power 34 → succeeds (as before the wall)
    expect(villageDefenseMult(v)).toBe(1)
    advanceRaids(v, s.battleLog, RAID_BASE_INTERVAL)
    const r = s.battleLog[0]
    if (r.kind !== 'raid') throw new Error('expected a raid report')
    expect(r.won).toBe(false)
    expect(v.units.spearman).toBe(0)
    expect(v.resources.wood.toString()).toBe('80')
  })
})
