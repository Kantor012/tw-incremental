import { describe, it, expect } from 'vitest'
import { D } from '../src/engine/decimal'
import { createInitialState, recomputeDerived, type GameState } from '../src/engine/state'
import { type UnitId } from '../src/content/units'
import {
  sendAttack,
  canAttack,
  advanceMarches,
  stationedUnits,
  marchTime,
} from '../src/systems/marches'
import { simulate } from '../src/engine/tick'
import { applyOffline } from '../src/engine/offline'
import { serialize } from '../src/engine/save'

/** A full (all UnitId present) roster snapshot. */
function army(spearman = 0, swordsman = 0, axeman = 0): Record<UnitId, number> {
  return { spearman, swordsman, axeman }
}

/**
 * A state with the barracks unlocked (attacks allowed) and modest resources. Sets
 * the level directly + recomputes (exactly what `build` does, minus the cost) so
 * these tests stay decoupled from the barracks price.
 */
function armed(seed = 'm'): GameState {
  const s = createInitialState(seed, 0)
  s.resources = { wood: D(50), clay: D(50), iron: D(50) }
  s.buildings.barracks = 1
  recomputeDerived(s)
  return s
}

/** Owned head-count of `id`, reconstructed as home + everything away on marches. */
function homePlusAway(s: GameState, id: UnitId): number {
  let away = 0
  for (const m of s.marches) away += m.units[id]
  return stationedUnits(s)[id] + away
}

describe('sendAttack / canAttack', () => {
  it('records a march without debiting state.units, removing the army from home', () => {
    const s = armed()
    s.units = army(0, 0, 5)

    expect(sendAttack(s, 1, army(0, 0, 5))).toBe(true)
    expect(s.marches.length).toBe(1)

    const m = s.marches[0]
    expect(m.phase).toBe('outbound')
    expect(m.targetLevel).toBe(1)
    expect(m.units).toEqual(army(0, 0, 5))
    // Units remain owned (population stays honest) but are no longer at home.
    expect(s.units.axeman).toBe(5)
    expect(stationedUnits(s).axeman).toBe(0)
    // Travel time = distance(3) * slowest speed(axeman 18) * scale(1) = 54s.
    expect(m.remaining).toBe(54)
    expect(marchTime(s, 1, army(0, 0, 5))).toBe(54)
  })

  it('gates on barracks, home availability, a non-empty army and a valid level', () => {
    const locked = createInitialState('locked', 0)
    locked.units = army(0, 0, 5)
    expect(canAttack(locked, 1, army(0, 0, 1)).ok).toBe(false) // no barracks

    const s = armed()
    s.units = army(0, 0, 2)
    expect(canAttack(s, 1, army(0, 0, 5)).ok).toBe(false) // more than at home
    expect(canAttack(s, 1, army(0, 0, 0)).ok).toBe(false) // empty army
    expect(canAttack(s, 99, army(0, 0, 1)).ok).toBe(false) // level out of range
    expect(canAttack(s, 1, army(0, 0, 1)).ok).toBe(true)

    // sendAttack mirrors canAttack: a rejected dispatch creates no march.
    expect(sendAttack(s, 1, army(0, 0, 5))).toBe(false)
    expect(s.marches.length).toBe(0)
  })
})

describe('advanceMarches — full attack cycle', () => {
  it('resolves the battle on arrival, then hauls clamped loot home', () => {
    const s = armed()
    s.units = army(0, 0, 5)
    sendAttack(s, 1, army(0, 0, 5))
    const t = marchTime(s, 1, army(0, 0, 5)) // 54

    // Outbound completes → battle resolves; casualties leave state.units at once.
    advanceMarches(s, t)
    expect(s.units.axeman).toBe(4) // 5 axemen vs lvl-1 wall: ~1 lost
    const m = s.marches[0]
    expect(m.phase).toBe('returning')
    expect(s.resources.wood.toString()).toBe('50') // loot stashed, not yet delivered
    expect(s.battleLog.length).toBe(1)
    expect(s.battleLog[0]).toMatchObject({ kind: 'attack', targetLevel: 1, won: true })
    // Conservation: home + away still equals the owned roster.
    expect(homePlusAway(s, 'axeman')).toBe(s.units.axeman)

    // Return completes → loot delivered (50 + 13 each), march dropped.
    advanceMarches(s, t)
    expect(s.marches.length).toBe(0)
    expect(s.resources.wood.toString()).toBe('63')
    expect(s.resources.clay.toString()).toBe('63')
    expect(s.resources.iron.toString()).toBe('63')
    expect(s.units.axeman).toBe(4)
  })

  it('a lost battle drops the march with no return and applies the full wipe', () => {
    const s = armed()
    s.units = army(1, 0, 0) // 1 spearman (atk 10) vs lvl-1 wall (def 30) → loss
    sendAttack(s, 1, army(1, 0, 0))
    const t = marchTime(s, 1, army(1, 0, 0)) // spearman speed 18 → 54

    advanceMarches(s, t)
    expect(s.marches.length).toBe(0) // dropped, nothing returns
    expect(s.units.spearman).toBe(0) // annihilated
    expect(s.battleLog[0]).toMatchObject({
      kind: 'attack',
      won: false,
      lootSum: '0',
      losses: 1,
    })
    expect(s.resources.wood.toString()).toBe('50') // nothing looted
  })

  it('clamps delivered loot to the storage cap (overflow spilled)', () => {
    const s = armed()
    s.units = army(0, 0, 5)
    s.resources = { wood: s.storageCap, clay: s.storageCap, iron: s.storageCap }
    sendAttack(s, 1, army(0, 0, 5))
    const t = marchTime(s, 1, army(0, 0, 5))

    advanceMarches(s, t) // battle
    advanceMarches(s, t) // return + deliver
    expect(s.resources.wood.toString()).toBe(s.storageCap.toString())
    expect(s.resources.wood.lte(s.storageCap)).toBe(true)
  })
})

describe('determinism — an in-flight march replays identically', () => {
  it('one big simulate() equals the chunked offline path with an active march', () => {
    const withMarch = (seed: string): GameState => {
      const s = armed(seed)
      s.units = army(0, 0, 6)
      sendAttack(s, 1, army(0, 0, 6))
      return s
    }

    const seconds = 200 // > full cycle (out 54 + return 54), < raid interval (600)
    const big = withMarch('det')
    simulate(big, seconds)
    big.lastSeen = seconds * 1000 // mirror applyOffline's bookkeeping

    const chunked = withMarch('det')
    applyOffline(chunked, seconds * 1000) // lastSeen starts at 0

    expect(serialize(big)).toBe(serialize(chunked))
    // Sanity: the march actually resolved and returned within the span.
    expect(big.marches.length).toBe(0)
    expect(big.units.axeman).toBeGreaterThan(0)
    expect(big.units.axeman).toBeLessThan(6)
  })
})
