import { describe, it, expect } from 'vitest'
import { D } from '../src/engine/decimal'
import {
  createInitialState,
  recomputeDerived,
  NO_TECH_MODS,
  type GameState,
  type Village,
  type BarbarianVillage,
  type TechModifiers,
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
function army(spearman = 0, swordsman = 0, axeman = 0, noble = 0): Record<UnitId, number> {
  return { spearman, swordsman, axeman, noble }
}

/** A barbarian village descriptor at a chosen tier and map position (full loyalty). */
function barb(id: string, level: number, x: number, y: number): BarbarianVillage {
  return { id, x, y, level, name: `Wioska barbarzyńska (poz. ${level})`, loyalty: 100 }
}

/** NO_TECH_MODS with selected fields overridden — a terse TechModifiers builder. */
function mods(partial: Partial<TechModifiers>): TechModifiers {
  return { ...NO_TECH_MODS, ...partial }
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
    advanceMarches(v, s.world, s.battleLog, t)
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
    advanceMarches(v, s.world, s.battleLog, t)
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

    advanceMarches(v, s.world, s.battleLog, t)
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

    advanceMarches(v, s.world, s.battleLog, t) // battle
    advanceMarches(v, s.world, s.battleLog, t) // return + deliver
    expect(v.resources.wood.toString()).toBe(v.storageCap.toString())
    expect(v.resources.wood.lte(v.storageCap)).toBe(true)
  })
})

describe('tech mods (M3.2) — logistics / plunder / military through a march', () => {
  it('marchTime is shortened by mods.marchSpeedFrac (and frac 0 is the base)', () => {
    const s = armed()
    const v = s.villages.v0
    v.units = army(0, 0, 5)
    const target = barbarianById(s.world, 'b0')!
    const base = marchTime(v, target, army(0, 0, 5)) // distance 3 * axeman speed 18 = 54
    expect(base).toBe(54)
    expect(marchTime(v, target, army(0, 0, 5), mods({ marchSpeedFrac: 0 }))).toBe(base)
    expect(marchTime(v, target, army(0, 0, 5), mods({ marchSpeedFrac: 0.25 }))).toBeCloseTo(54 * 0.75)
    expect(marchTime(v, target, army(0, 0, 5), mods({ marchSpeedFrac: 0.5 }))).toBeCloseTo(27)
  })

  it('sendAttack snapshots a shortened outbound remaining when march speed is bought', () => {
    const s = armed()
    const v = s.villages.v0
    v.units = army(0, 0, 5)
    expect(sendAttack(v, s.world, s.battleLog, 'b0', army(0, 0, 5), mods({ marchSpeedFrac: 0.5 }))).toBe(
      true,
    )
    // 54 base * (1 - 0.5) = 27.
    expect(v.marches[0].remaining).toBeCloseTo(27)
  })

  it('loot scales with mods.lootMult, capped at the camp total', () => {
    // Haul a full attack cycle and read the delivered loot for a given lootMult.
    // attackMult stays 1 so survivors (and therefore raw carry) are identical across runs.
    function deliveredWood(lootMult: number): string {
      const s = armed()
      const v = s.villages.v0
      v.units = army(0, 0, 5)
      const target = barbarianById(s.world, 'b0')!
      const m = mods({ lootMult })
      sendAttack(v, s.world, s.battleLog, 'b0', army(0, 0, 5), m)
      const t = marchTime(v, target, army(0, 0, 5), m) // 54 (marchSpeedFrac 0)
      advanceMarches(v, s.world, s.battleLog, t, m) // battle resolves
      advanceMarches(v, s.world, s.battleLog, t, m) // return + deliver
      return v.resources.wood.toString()
    }
    // Baseline (lootMult 1): 4 surviving axemen carry 40, split over a 600-total camp →
    // floor(40 * 200/600) = 13 each, delivered onto the starting 50 → 63 (pins the M3.1 number).
    expect(deliveredWood(1)).toBe('63')
    // lootMult 2: carry 80 → floor(80 * 200/600) = 26 → 76 delivered (strictly more).
    expect(deliveredWood(2)).toBe('76')
    // A huge multiplier is capped at what the camp actually holds (200/resource) → 250.
    expect(deliveredWood(100)).toBe('250')
  })

  it('mods.attackMult can turn a losing attack into a win with survivors (full cycle)', () => {
    // 3 spearmen (attack 30) vs a lvl-1 wall (def 30): a tie → loss without tech.
    const lose = armed()
    const lv = lose.villages.v0
    lv.units = army(3, 0, 0)
    const target = barbarianById(lose.world, 'b0')!
    const t = marchTime(lv, target, army(3, 0, 0)) // spearman speed 18, distance 3 → 54
    sendAttack(lv, lose.world, lose.battleLog, 'b0', army(3, 0, 0))
    advanceMarches(lv, lose.world, lose.battleLog, t) // no mods → loss
    expect(lose.battleLog[0]).toMatchObject({ kind: 'attack', won: false })
    expect(lv.units.spearman).toBe(0) // annihilated

    // Same attack with a strong military multiplier wins it and brings survivors home.
    const win = armed()
    const wv = win.villages.v0
    wv.units = army(3, 0, 0)
    const m = mods({ attackMult: 5 }) // 30 * 5 = 150 >> 30
    sendAttack(wv, win.world, win.battleLog, 'b0', army(3, 0, 0), m)
    advanceMarches(wv, win.world, win.battleLog, t, m) // battle: win
    expect(win.battleLog[0]).toMatchObject({ kind: 'attack', won: true })
    // (30/150)^1.5 ≈ 0.089 loss → floor(3 * 0.911) = 2 survivors.
    expect(wv.units.spearman).toBe(2)
    expect(wv.marches[0].phase).toBe('returning')
  })

  it('NO_TECH_MODS on advanceMarches reproduces the bare resolution', () => {
    const tech = armed()
    const bare = armed()
    for (const s of [tech, bare]) {
      s.villages.v0.units = army(0, 0, 5)
      sendAttack(s.villages.v0, s.world, s.battleLog, 'b0', army(0, 0, 5))
    }
    const t = 54
    advanceMarches(tech.villages.v0, tech.world, tech.battleLog, t, NO_TECH_MODS)
    advanceMarches(tech.villages.v0, tech.world, tech.battleLog, t, NO_TECH_MODS)
    advanceMarches(bare.villages.v0, bare.world, bare.battleLog, t)
    advanceMarches(bare.villages.v0, bare.world, bare.battleLog, t)
    expect(tech.villages.v0.resources.wood.toString()).toBe(
      bare.villages.v0.resources.wood.toString(),
    )
    expect(tech.villages.v0.units.axeman).toBe(bare.villages.v0.units.axeman)
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
