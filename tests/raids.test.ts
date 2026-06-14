import { describe, it, expect } from 'vitest'
import { D } from '../src/engine/decimal'
import { createInitialState, RAID_BASE_INTERVAL, type GameState } from '../src/engine/state'
import { advanceRaids, raidPower } from '../src/systems/raids'
import { armyDefensePower } from '../src/systems/combat'
import { BUILDING_IDS } from '../src/content/buildings'
import { type UnitId } from '../src/content/units'
import { simulate } from '../src/engine/tick'
import { applyOffline } from '../src/engine/offline'
import { serialize } from '../src/engine/save'

/** A full (all UnitId present) roster snapshot. */
function army(spearman = 0, swordsman = 0, axeman = 0): Record<UnitId, number> {
  return { spearman, swordsman, axeman }
}

/** A grown village (initial buildings) with a stocked treasury — raids are active. */
function village(seed = 'r'): GameState {
  const s = createInitialState(seed, 0)
  s.resources = { wood: D(100), clay: D(100), iron: D(100) }
  return s
}

describe('raidPower', () => {
  it('scales with the flat base, building levels and a fraction of army defence', () => {
    const s = village()
    s.units = army(10, 0, 0)
    let buildingSum = 0
    for (const id of BUILDING_IDS) buildingSum += s.buildings[id]
    expect(raidPower(s)).toBeCloseTo(10 + 3 * buildingSum + 0.4 * armyDefensePower(s.units))
  })
})

describe('advanceRaids', () => {
  it('a strong garrison repels the raid with no losses, then re-arms the timer', () => {
    const s = village()
    s.units = army(10, 0, 0) // defence 150 ≫ raid power 88 → repelled
    advanceRaids(s, RAID_BASE_INTERVAL)

    expect(s.battleLog.length).toBe(1)
    expect(s.battleLog[0]).toMatchObject({ kind: 'raid', won: true, looted: '0', losses: 0 })
    expect(s.units.spearman).toBe(10) // untouched
    expect(s.resources.wood.toString()).toBe('100') // nothing stolen
    expect(s.raidTimer).toBe(RAID_BASE_INTERVAL) // re-armed
  })

  it('a weak garrison loses units and 20% of each resource', () => {
    const s = village()
    s.units = army(1, 0, 0) // defence 15 < raid power 34 → raid succeeds
    advanceRaids(s, RAID_BASE_INTERVAL)

    const r = s.battleLog[0]
    expect(r.kind).toBe('raid')
    expect(r.won).toBe(false) // raid succeeded (from the player's view: lost)
    expect(r.losses).toBeGreaterThan(0)
    expect(s.units.spearman).toBe(0) // garrison wiped
    expect(s.resources.wood.toString()).toBe('80') // floor(100 * 0.2) stolen
    expect(s.resources.clay.toString()).toBe('80')
    expect(s.resources.iron.toString()).toBe('80')
    expect(s.raidTimer).toBe(RAID_BASE_INTERVAL)
  })

  it('never drives resources below zero, even when the pool is tiny', () => {
    const s = village()
    s.units = army(1, 0, 0) // weak: the raid will succeed
    s.resources = { wood: D(4), clay: D(0), iron: D(2) }
    advanceRaids(s, RAID_BASE_INTERVAL)

    // floor(4*.2)=0, floor(0)=0, floor(2*.2)=0 → nothing stolen, none negative.
    expect(s.resources.wood.gte(0)).toBe(true)
    expect(s.resources.clay.gte(0)).toBe(true)
    expect(s.resources.iron.gte(0)).toBe(true)
  })

  it('a fresh hamlet is not yet worth raiding (timer frozen, no raid)', () => {
    const s = createInitialState('fresh', 0)
    advanceRaids(s, 100_000)
    expect(s.battleLog.length).toBe(0)
    expect(s.raidTimer).toBe(RAID_BASE_INTERVAL)
  })

  it('resolves every raid that falls within one large dt (offline catch-up)', () => {
    const s = village()
    s.units = army(10, 0, 0) // strong: repels each, garrison persists across raids
    advanceRaids(s, RAID_BASE_INTERVAL * 3)

    expect(s.battleLog.length).toBe(3)
    for (const r of s.battleLog) expect(r).toMatchObject({ kind: 'raid', won: true })
    expect(s.units.spearman).toBe(10)
    expect(s.raidTimer).toBe(RAID_BASE_INTERVAL)
  })
})

describe('determinism — raids replay identically', () => {
  it('one big simulate() equals the chunked offline path with raids firing', () => {
    const raidState = (seed: string): GameState => {
      const s = village(seed)
      s.units = army(3, 0, 2) // defence 65 ≥ raid power 54 → repelled, garrison persists
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
