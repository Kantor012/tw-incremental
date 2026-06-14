import { describe, it, expect } from 'vitest'
import { D } from '../src/engine/decimal'
import {
  createInitialState,
  recomputeDerived,
  type GameState,
  type Village,
  type BarbarianVillage,
} from '../src/engine/state'
import { type UnitId } from '../src/content/units'
import {
  sendAttack,
  canAttack,
  advanceMarches,
  stationedUnits,
  marchTime,
} from '../src/systems/marches'
import { barbarianById } from '../src/systems/world'
import { simulate } from '../src/engine/tick'
import { applyOffline } from '../src/engine/offline'
import { serialize } from '../src/engine/save'

/** A full (all UnitId present) roster snapshot. */
function army(spearman = 0, swordsman = 0, axeman = 0): Record<UnitId, number> {
  return { spearman, swordsman, axeman }
}

/** A barbarian village descriptor at a chosen tier and map position. */
function barb(id: string, level: number, x: number, y: number): BarbarianVillage {
  return { id, x, y, level, name: `Wioska barbarzyńska (poz. ${level})` }
}

/**
 * A state whose capital ('v0', "Stolica") has the barracks unlocked (attacks
 * allowed) and modest resources. Sets the level directly on the village + recomputes
 * (exactly what `build` does, minus the cost) so these tests stay decoupled from the
 * barracks price.
 *
 * Since M2.2 attacks target a CONCRETE barbarian village on the world map and travel
 * time comes from the Euclidean source→target distance. We REPLACE the seed-generated
 * world with a controlled one holding a single level-1 camp ('b0') placed exactly 3
 * fields east of the capital — distance 3, the legacy `barbarianTarget(1).distance` —
 * so marchTime reproduces the old 54s timing and every loot/casualty number these
 * tests pin stays unchanged. The economy lives per-village, so we mutate
 * `s.villages.v0`; the systems under test take that {@link Village} plus the
 * {@link World} (for target lookup) and the GLOBAL `s.battleLog` explicitly.
 */
function armed(seed = 'm'): GameState {
  const s = createInitialState(seed, 0)
  const v = s.villages.v0
  v.resources = { wood: D(50), clay: D(50), iron: D(50) }
  v.buildings.barracks = 1
  // Controlled world: one level-1 camp at distance 3 from the capital (at v.x,v.y =
  // WORLD_CENTER), so marchTime(v, b0, units) = 3 * slowest-speed * scale.
  s.world = { barbarians: [barb('b0', 1, v.x + 3, v.y)] }
  recomputeDerived(s)
  return s
}

/** Owned head-count of `id`, reconstructed as home + everything away on marches. */
function homePlusAway(v: Village, id: UnitId): number {
  let away = 0
  for (const m of v.marches) away += m.units[id]
  return stationedUnits(v)[id] + away
}

describe('sendAttack / canAttack', () => {
  it('records a march without debiting village.units, removing the army from home', () => {
    const s = armed()
    const v = s.villages.v0
    v.units = army(0, 0, 5)
    const target = barbarianById(s.world, 'b0')!

    expect(sendAttack(v, s.world, s.battleLog, 'b0', army(0, 0, 5))).toBe(true)
    expect(v.marches.length).toBe(1)

    const m = v.marches[0]
    expect(m.phase).toBe('outbound')
    expect(m.targetId).toBe('b0')
    expect(m.targetLevel).toBe(1)
    // Map coordinates are snapshotted at dispatch (drive the return leg + drawn line).
    expect(m.targetX).toBe(target.x)
    expect(m.targetY).toBe(target.y)
    expect(m.units).toEqual(army(0, 0, 5))
    // Units remain owned (population stays honest) but are no longer at home.
    expect(v.units.axeman).toBe(5)
    expect(stationedUnits(v).axeman).toBe(0)
    // Travel time = distance(3) * slowest speed(axeman 18) * scale(1) = 54s.
    expect(m.remaining).toBe(54)
    expect(marchTime(v, target, army(0, 0, 5))).toBe(54)
  })

  it('gates on barracks, home availability, a non-empty army and a valid target', () => {
    const locked = createInitialState('locked', 0)
    const lv = locked.villages.v0
    lv.units = army(0, 0, 5)
    const lockedTarget = barb('b0', 1, lv.x + 3, lv.y)
    expect(canAttack(lv, lockedTarget, army(0, 0, 1)).ok).toBe(false) // no barracks

    const s = armed()
    const v = s.villages.v0
    v.units = army(0, 0, 2)
    const target = barbarianById(s.world, 'b0')!
    expect(canAttack(v, target, army(0, 0, 5)).ok).toBe(false) // more than at home
    expect(canAttack(v, target, army(0, 0, 0)).ok).toBe(false) // empty army
    // A camp with an out-of-range tier is rejected as an invalid target.
    expect(canAttack(v, barb('bx', 99, v.x + 3, v.y), army(0, 0, 1)).ok).toBe(false)
    expect(canAttack(v, target, army(0, 0, 1)).ok).toBe(true)

    // sendAttack mirrors canAttack: a rejected dispatch creates no march.
    expect(sendAttack(v, s.world, s.battleLog, 'b0', army(0, 0, 5))).toBe(false)
    expect(v.marches.length).toBe(0)
    // An unknown target id is a no-op too (e.g. a stale id after a world regen).
    expect(sendAttack(v, s.world, s.battleLog, 'nope', army(0, 0, 1))).toBe(false)
    expect(v.marches.length).toBe(0)
  })
})

describe('advanceMarches — full attack cycle', () => {
  it('resolves the battle on arrival, then hauls clamped loot home', () => {
    const s = armed()
    const v = s.villages.v0
    v.units = army(0, 0, 5)
    const target = barbarianById(s.world, 'b0')!
    sendAttack(v, s.world, s.battleLog, 'b0', army(0, 0, 5))
    const t = marchTime(v, target, army(0, 0, 5)) // 54

    // Outbound completes → battle resolves; casualties leave village.units at once.
    advanceMarches(v, s.battleLog, t)
    expect(v.units.axeman).toBe(4) // 5 axemen vs lvl-1 wall: ~1 lost
    const m = v.marches[0]
    expect(m.phase).toBe('returning')
    expect(v.resources.wood.toString()).toBe('50') // loot stashed, not yet delivered
    expect(s.battleLog.length).toBe(1)
    // The global log tags each report with the originating village.
    expect(s.battleLog[0]).toMatchObject({
      kind: 'attack',
      villageId: 'v0',
      targetLevel: 1,
      won: true,
    })
    // Conservation: home + away still equals the owned roster.
    expect(homePlusAway(v, 'axeman')).toBe(v.units.axeman)

    // Return completes → loot delivered (50 + 13 each), march dropped.
    advanceMarches(v, s.battleLog, t)
    expect(v.marches.length).toBe(0)
    expect(v.resources.wood.toString()).toBe('63')
    expect(v.resources.clay.toString()).toBe('63')
    expect(v.resources.iron.toString()).toBe('63')
    expect(v.units.axeman).toBe(4)
  })

  it('a lost battle drops the march with no return and applies the full wipe', () => {
    const s = armed()
    const v = s.villages.v0
    v.units = army(1, 0, 0) // 1 spearman (atk 10) vs lvl-1 wall (def 30) → loss
    const target = barbarianById(s.world, 'b0')!
    sendAttack(v, s.world, s.battleLog, 'b0', army(1, 0, 0))
    const t = marchTime(v, target, army(1, 0, 0)) // spearman speed 18 → 54

    advanceMarches(v, s.battleLog, t)
    expect(v.marches.length).toBe(0) // dropped, nothing returns
    expect(v.units.spearman).toBe(0) // annihilated
    expect(s.battleLog[0]).toMatchObject({
      kind: 'attack',
      villageId: 'v0',
      won: false,
      lootSum: '0',
      losses: 1,
    })
    expect(v.resources.wood.toString()).toBe('50') // nothing looted
  })

  it('clamps delivered loot to the storage cap (overflow spilled)', () => {
    const s = armed()
    const v = s.villages.v0
    v.units = army(0, 0, 5)
    v.resources = { wood: v.storageCap, clay: v.storageCap, iron: v.storageCap }
    const target = barbarianById(s.world, 'b0')!
    sendAttack(v, s.world, s.battleLog, 'b0', army(0, 0, 5))
    const t = marchTime(v, target, army(0, 0, 5))

    advanceMarches(v, s.battleLog, t) // battle
    advanceMarches(v, s.battleLog, t) // return + deliver
    expect(v.resources.wood.toString()).toBe(v.storageCap.toString())
    expect(v.resources.wood.lte(v.storageCap)).toBe(true)
  })
})

describe('determinism — an in-flight march replays identically', () => {
  it('one big simulate() equals the chunked offline path with an active march', () => {
    const withMarch = (seed: string): GameState => {
      const s = armed(seed)
      const v = s.villages.v0
      v.units = army(0, 0, 6)
      sendAttack(v, s.world, s.battleLog, 'b0', army(0, 0, 6))
      return s
    }

    const seconds = 200 // > full cycle (out 54 + return 54), < raid interval (900)
    const big = withMarch('det')
    simulate(big, seconds)
    big.lastSeen = seconds * 1000 // mirror applyOffline's bookkeeping

    const chunked = withMarch('det')
    applyOffline(chunked, seconds * 1000) // lastSeen starts at 0

    expect(serialize(big)).toBe(serialize(chunked))
    // Sanity: the march actually resolved and returned within the span.
    const bv = big.villages.v0
    expect(bv.marches.length).toBe(0)
    expect(bv.units.axeman).toBeGreaterThan(0)
    expect(bv.units.axeman).toBeLessThan(6)
  })
})
