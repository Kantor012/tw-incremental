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
  sendScout,
  canScout,
} from '../src/systems/marches'
import { barbarianById } from '../src/systems/world'
import { armyAttackPower, ramDefenseFactor, luckFactor } from '../src/systems/combat'
import { barbarianTarget } from '../src/content/barbarians'
import { simulate } from '../src/engine/tick'
import { applyOffline } from '../src/engine/offline'
import { serialize } from '../src/engine/save'
import { RNG } from '../src/engine/rng'

/** First RNG seed (>=1) whose first luck draw satisfies `pred` — for deterministic luck cases. */
function findSeed(pred: (luck: number) => boolean): number {
  for (let s = 1; s < 200000; s++) {
    if (pred(luckFactor(new RNG(s)))) return s
  }
  throw new Error('no seed produced the requested luck')
}

/** A full (all UnitId present) roster snapshot. */
function army(
  spearman = 0,
  swordsman = 0,
  axeman = 0,
  noble = 0,
  scout = 0,
  ram = 0,
  catapult = 0,
): Record<UnitId, number> {
  return { spearman, swordsman, axeman, noble, scout, ram, catapult }
}

/** A barbarian village descriptor at a chosen tier and map position (full loyalty, unscouted). */
function barb(id: string, level: number, x: number, y: number): BarbarianVillage {
  return { id, x, y, level, name: `Wioska barbarzyńska (poz. ${level})`, loyalty: 100, scouted: false }
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
  s.world = { fortresses: [], barbarians:[barb('b0', 1, v.x + 3, v.y)] }
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

  it('a scout march replays identically online vs chunked offline (reveal included)', () => {
    const withScout = (seed: string): GameState => {
      const s = armed(seed)
      const v = s.villages.v0
      v.units = army(0, 0, 0, 0, 4)
      sendScout(v, s.world, s.battleLog, 'b0', 4)
      return s
    }

    const seconds = 200 // > full scout cycle (out 27 + return 27), < raid interval (900)
    const big = withScout('scout-det')
    simulate(big, seconds)
    big.lastSeen = seconds * 1000 // mirror applyOffline's bookkeeping

    const chunked = withScout('scout-det')
    applyOffline(chunked, seconds * 1000) // lastSeen starts at 0

    // The serialized state INCLUDES the world (target.scouted), so byte-equality proves
    // the reveal happened at the same deterministic moment online and offline.
    expect(serialize(big)).toBe(serialize(chunked))
    expect(big.world.barbarians.find((b) => b.id === 'b0')!.scouted).toBe(true)
    expect(big.villages.v0.marches.length).toBe(0)
    expect(big.villages.v0.units.scout).toBe(4) // every scout came home
  })
})

describe('scout marches (M5.2) — canScout / sendScout', () => {
  it('sendScout records a scout march (kind scout, scouts only, empty loot) without debiting units', () => {
    const s = armed()
    const v = s.villages.v0
    v.units = army(0, 0, 0, 0, 4) // 4 scouts at home
    const target = barbarianById(s.world, 'b0')!

    expect(sendScout(v, s.world, s.battleLog, 'b0', 3)).toBe(true)
    expect(v.marches.length).toBe(1)

    const m = v.marches[0]
    expect(m.kind).toBe('scout')
    expect(m.phase).toBe('outbound')
    expect(m.targetId).toBe('b0')
    expect(m.targetLevel).toBe(1)
    expect(m.targetX).toBe(target.x)
    expect(m.targetY).toBe(target.y)
    // Only scouts are dispatched; the loot map is empty (recon hauls nothing).
    expect(m.units).toEqual(army(0, 0, 0, 0, 3))
    expect(m.loot.wood.toString()).toBe('0')
    expect(m.loot.clay.toString()).toBe('0')
    expect(m.loot.iron.toString()).toBe('0')
    // Units stay owned (population honest); the 3 dispatched are no longer at home.
    expect(v.units.scout).toBe(4)
    expect(stationedUnits(v).scout).toBe(1)
    // Travel time = distance(3) * scout speed(9) * scale(1) = 27s (the fastest unit).
    expect(m.remaining).toBe(27)
    expect(marchTime(v, target, army(0, 0, 0, 0, 3))).toBe(27)
    // Dispatch logs nothing.
    expect(s.battleLog.length).toBe(0)
  })

  it('canScout gates on a real target and enough scouts at home', () => {
    const s = armed()
    const v = s.villages.v0
    v.units = army(0, 0, 0, 0, 2)
    expect(canScout(v, s.world, 'b0', 2).ok).toBe(true)
    expect(canScout(v, s.world, 'b0', 3).ok).toBe(false) // more than at home
    expect(canScout(v, s.world, 'b0', 0).ok).toBe(false) // must pick a positive count
    expect(canScout(v, s.world, 'b0', 1.5).ok).toBe(false) // non-integer
    expect(canScout(v, s.world, 'nope', 1).ok).toBe(false) // unknown target id
    // A village with no scouts at all cannot scout.
    const empty = armed()
    expect(canScout(empty.villages.v0, empty.world, 'b0', 1).ok).toBe(false)
  })

  it('sendScout mirrors canScout: a rejected dispatch creates no march', () => {
    const s = armed()
    const v = s.villages.v0
    v.units = army(0, 0, 0, 0, 1)
    expect(sendScout(v, s.world, s.battleLog, 'b0', 5)).toBe(false) // more than at home
    expect(sendScout(v, s.world, s.battleLog, 'nope', 1)).toBe(false) // unknown target
    expect(v.marches.length).toBe(0)
  })

  it('a scout deducts scouts at home but not the combat roster (a parallel attack still fields its army)', () => {
    // Sending scouts must not strand the fighting army: the two draw from separate
    // pools (scouts vs axemen), each tracked through stationedUnits.
    const s = armed()
    const v = s.villages.v0
    v.units = army(0, 0, 5, 0, 3) // 5 axemen + 3 scouts
    expect(sendScout(v, s.world, s.battleLog, 'b0', 3)).toBe(true)
    expect(stationedUnits(v).scout).toBe(0)
    expect(stationedUnits(v).axeman).toBe(5) // the strike force is untouched
    expect(canAttack(v, barbarianById(s.world, 'b0')!, army(0, 0, 5)).ok).toBe(true)
  })
})

describe('advanceMarches — scout cycle (M5.2)', () => {
  it('reveals the target on arrival, then brings every scout home unharmed (no battle/loot/loyalty hit)', () => {
    const s = armed()
    const v = s.villages.v0
    v.units = army(0, 0, 0, 0, 3)
    const target = barbarianById(s.world, 'b0')!
    expect(target.scouted).toBe(false) // hidden until reconned
    const loyaltyBefore = target.loyalty

    sendScout(v, s.world, s.battleLog, 'b0', 3)
    const t = marchTime(v, target, army(0, 0, 0, 0, 3)) // 27

    // Outbound completes → the camp is REVEALED, the march turns around, NOTHING fights.
    const eventsOut = advanceMarches(v, s.world, s.battleLog, t)
    expect(eventsOut).toEqual([]) // a scout never queues a conquest event
    expect(target.scouted).toBe(true) // revealed (the false→true flip)
    expect(target.loyalty).toBe(loyaltyBefore) // recon never touches loyalty
    expect(v.marches[0].phase).toBe('returning')
    expect(v.marches[0].kind).toBe('scout')
    expect(s.battleLog.length).toBe(0) // no battle report for a scout
    expect(v.units.scout).toBe(3) // none lost — scouts don't fight
    expect(v.resources.wood.toString()).toBe('50') // nothing looted

    // Return completes → march dropped; scouts (never removed from v.units) are home.
    const eventsBack = advanceMarches(v, s.world, s.battleLog, t)
    expect(eventsBack).toEqual([])
    expect(v.marches.length).toBe(0)
    expect(v.units.scout).toBe(3) // all 3 returned
    expect(stationedUnits(v).scout).toBe(3)
    expect(s.battleLog.length).toBe(0)
    expect(v.resources.wood.toString()).toBe('50') // still no loot delivered
  })

  it('a whole out-and-back scout cycle resolves within one large dt', () => {
    const s = armed()
    const v = s.villages.v0
    v.units = army(0, 0, 0, 0, 2)
    const target = barbarianById(s.world, 'b0')!
    sendScout(v, s.world, s.battleLog, 'b0', 2)
    // One big step (> out 27 + return 27) reveals AND brings the scouts home.
    advanceMarches(v, s.world, s.battleLog, 1000)
    expect(target.scouted).toBe(true)
    expect(v.marches.length).toBe(0)
    expect(v.units.scout).toBe(2)
    expect(s.battleLog.length).toBe(0)
  })

  it('a scout aimed at an already-removed target still returns home (no reveal, no crash)', () => {
    // The camp may be gone by the time the scout arrives (captured earlier, or a stale
    // id). The scout simply finds nothing to reveal and heads home — no battle/loot.
    const s = armed()
    const v = s.villages.v0
    v.units = army(0, 0, 0, 0, 2)
    sendScout(v, s.world, s.battleLog, 'b0', 2)
    // Remove the target mid-flight.
    s.world = { fortresses: [], barbarians:[] }
    advanceMarches(v, s.world, s.battleLog, 1000)
    expect(v.marches.length).toBe(0)
    expect(v.units.scout).toBe(2) // all scouts safely home
    expect(s.battleLog.length).toBe(0)
  })
})

describe('advanceMarches — ram role (M5.3 siege)', () => {
  it('rams crack a camp an equal-power ramless army loses to (effective defence cut)', () => {
    const L = 9 // a high wall the bare combat power cannot clear unaided
    const D = barbarianTarget(L).defensePower
    const ramless = army(0, 0, 6) // 6 axemen
    const rammed = army(0, 0, 2, 0, 0, 20) // 2 axemen + 20 rams — SAME raw attack power
    // The ONLY difference between the two stacks is the ram column, not the raw power.
    expect(armyAttackPower(rammed)).toBe(armyAttackPower(ramless))
    // Tuning guard: the shared power LOSES to the full wall but BEATS the ram-cut wall —
    // so the verdict difference can only come from ramDefenseFactor.
    expect(armyAttackPower(ramless)).toBeLessThan(D)
    expect(armyAttackPower(rammed)).toBeGreaterThan(D * ramDefenseFactor(rammed))

    // Ramless attack → loss (the camp's full wall stands).
    const lose = armed('ram-lose')
    const lv = lose.villages.v0
    lose.world = { fortresses: [], barbarians:[barb('b0', L, lv.x + 3, lv.y)] }
    lv.units = ramless
    sendAttack(lv, lose.world, lose.battleLog, 'b0', ramless)
    advanceMarches(lv, lose.world, lose.battleLog, 1000)
    expect(lose.battleLog[0]).toMatchObject({ kind: 'attack', won: false })

    // Same-power attack WITH rams → win: the rams cut the wall below the army's power.
    const win = armed('ram-win')
    const wv = win.villages.v0
    win.world = { fortresses: [], barbarians:[barb('b0', L, wv.x + 3, wv.y)] }
    wv.units = rammed
    sendAttack(wv, win.world, win.battleLog, 'b0', rammed)
    advanceMarches(wv, win.world, win.battleLog, 1000)
    expect(win.battleLog[0]).toMatchObject({ kind: 'attack', won: true })
    // Rams never raze: the cracked camp keeps its level (that is the catapult's job).
    expect(barbarianById(win.world, 'b0')!.level).toBe(L)
  })
})

describe('advanceMarches — catapult role (M5.3 siege)', () => {
  it('a won attack with catapults permanently lowers the camp level (snapshot tier intact)', () => {
    const L = 5
    const s = armed('cata-win')
    const v = s.villages.v0
    s.world = { fortresses: [], barbarians:[barb('b0', L, v.x + 3, v.y)] }
    v.units = army(0, 0, 10, 0, 0, 0, 5) // 10 axemen (the win) + 5 catapults (one level razed)
    sendAttack(v, s.world, s.battleLog, 'b0', army(0, 0, 10, 0, 0, 0, 5))
    advanceMarches(v, s.world, s.battleLog, 1000)
    expect(s.battleLog[0]).toMatchObject({ kind: 'attack', won: true })
    // 5 catapults → floor(5/5)=1 level razed: the LIVE camp drops 5 → 4.
    expect(barbarianById(s.world, 'b0')!.level).toBe(L - 1)
    // The SNAPSHOT tier (this battle's loot/losses) is untouched — the report still
    // reads the tier captured at dispatch, not the just-lowered live level.
    expect(s.battleLog[0]).toMatchObject({ targetLevel: L })
  })

  it('never razes a camp below level 1 (clamp)', () => {
    const s = armed('cata-clamp') // b0 is a level-1 camp
    const v = s.villages.v0
    expect(barbarianById(s.world, 'b0')!.level).toBe(1)
    v.units = army(0, 0, 10, 0, 0, 0, 15) // 15 catapults → 3 levels (capped), but level floors at 1
    sendAttack(v, s.world, s.battleLog, 'b0', army(0, 0, 10, 0, 0, 0, 15))
    advanceMarches(v, s.world, s.battleLog, 1000)
    expect(s.battleLog[0]).toMatchObject({ won: true })
    expect(barbarianById(s.world, 'b0')!.level).toBe(1) // max(1, 1 - 3) = 1
  })

  it('an attack WITHOUT catapults leaves the camp level unchanged', () => {
    const L = 5
    const s = armed('cata-none')
    const v = s.villages.v0
    s.world = { fortresses: [], barbarians:[barb('b0', L, v.x + 3, v.y)] }
    v.units = army(0, 0, 10) // wins, but no siege → no razing
    sendAttack(v, s.world, s.battleLog, 'b0', army(0, 0, 10))
    advanceMarches(v, s.world, s.battleLog, 1000)
    expect(s.battleLog[0]).toMatchObject({ won: true })
    expect(barbarianById(s.world, 'b0')!.level).toBe(L)
  })

  it('a LOST attack with catapults does NOT lower the camp level', () => {
    const L = 9
    const s = armed('cata-loss')
    const v = s.villages.v0
    s.world = { fortresses: [], barbarians:[barb('b0', L, v.x + 3, v.y)] }
    v.units = army(1, 0, 0, 0, 0, 0, 5) // far too weak to win, even with the catapults
    sendAttack(v, s.world, s.battleLog, 'b0', army(1, 0, 0, 0, 0, 0, 5))
    advanceMarches(v, s.world, s.battleLog, 1000)
    expect(s.battleLog[0]).toMatchObject({ won: false })
    expect(barbarianById(s.world, 'b0')!.level).toBe(L) // razing only happens on a win
  })
})

describe('determinism — a siege march replays identically (M5.3)', () => {
  it('one big simulate() equals the chunked offline path with rams + catapults in flight', () => {
    const withSiege = (seed: string): GameState => {
      const s = armed(seed)
      const v = s.villages.v0
      s.world = { fortresses: [], barbarians:[barb('b0', 5, v.x + 3, v.y)] }
      v.units = army(0, 0, 10, 0, 0, 4, 5) // axemen + rams + catapults
      sendAttack(v, s.world, s.battleLog, 'b0', army(0, 0, 10, 0, 0, 4, 5))
      return s
    }

    const seconds = 300 // > full cycle (out 90 + return 90), < raid interval (900)
    const big = withSiege('siege-det')
    simulate(big, seconds)
    big.lastSeen = seconds * 1000 // mirror applyOffline's bookkeeping

    const chunked = withSiege('siege-det')
    applyOffline(chunked, seconds * 1000) // lastSeen starts at 0

    // The serialized state INCLUDES the world (barb.level), so byte-equality proves the
    // catapult razing happened at the same deterministic moment online and offline.
    expect(serialize(big)).toBe(serialize(chunked))
    expect(big.world.barbarians.find((b) => b.id === 'b0')!.level).toBe(4) // 5 catapults → -1
    expect(big.villages.v0.marches.length).toBe(0)
  })
})

// --- combat LUCK through a resolved attack (M5.5) ----------------------------------

describe('advanceMarches — combat luck (M5.5)', () => {
  // 3 spearmen (raw attack power 30) vs the lvl-1 camp (defence 30): a dead-even fight,
  // so the symmetric luck roll alone decides it — bad luck (×<1) drops the effective
  // power below 30 and loses, good luck (×>1) lifts it above 30 and wins. A clean,
  // tuning-robust knife-edge: whatever the exact roll, the SIGN of (luck − 1) is the verdict.
  // NB: a fresh `army(3)` per use — combat MUTATES the roster it resolves, so a shared
  // object would leak casualties from one case into the next.
  const pechSeed = findSeed((l) => l < 1)
  const luckySeed = findSeed((l) => l > 1)

  it('bad luck loses a fight the same army wins on good luck (seeded RNG → deterministic)', () => {
    // PECH: effective power 30 * luck(<1) < 30 → loss, army annihilated.
    const lose = armed('luck-lose')
    const lv = lose.villages.v0
    lv.units = army(3) // 3 spearmen, raw power 30
    sendAttack(lv, lose.world, lose.battleLog, 'b0', army(3))
    advanceMarches(lv, lose.world, lose.battleLog, 1000, NO_TECH_MODS, undefined, new RNG(pechSeed))
    const lossReport = lose.battleLog[0]
    if (lossReport.kind !== 'attack') throw new Error('expected an attack report')
    expect(lossReport.won).toBe(false)
    expect(lv.units.spearman).toBe(0)
    // The exact roll is recorded on the report and is < 1 (the pech that decided it).
    expect(lossReport.luck).toBe(luckFactor(new RNG(pechSeed)))
    expect(lossReport.luck!).toBeLessThan(1)

    // LUCK: effective power 30 * luck(>1) > 30 → win.
    const win = armed('luck-win')
    const wv = win.villages.v0
    wv.units = army(3) // a fresh 3-spearman roster
    sendAttack(wv, win.world, win.battleLog, 'b0', army(3))
    advanceMarches(wv, win.world, win.battleLog, 1000, NO_TECH_MODS, undefined, new RNG(luckySeed))
    const winReport = win.battleLog[0]
    if (winReport.kind !== 'attack') throw new Error('expected an attack report')
    expect(winReport.won).toBe(true)
    expect(winReport.luck).toBe(luckFactor(new RNG(luckySeed)))
    expect(winReport.luck!).toBeGreaterThan(1)
  })

  it('records the recorded luck as a finite power multiplier inside the band', () => {
    const s = armed('luck-band')
    const v = s.villages.v0
    v.units = army(0, 0, 5) // a comfortable win, so this is purely about the recorded roll
    sendAttack(v, s.world, s.battleLog, 'b0', army(0, 0, 5))
    advanceMarches(v, s.world, s.battleLog, 1000, NO_TECH_MODS, undefined, new RNG(99))
    const r = s.battleLog[0]
    if (r.kind !== 'attack') throw new Error('expected an attack report')
    expect(typeof r.luck).toBe('number')
    expect(Number.isFinite(r.luck!)).toBe(true)
    expect(r.luck!).toBeGreaterThanOrEqual(0.75)
    expect(r.luck!).toBeLessThan(1.25)
  })

  it('draws EXACTLY ONCE per resolved attack (advances the RNG by a single step)', () => {
    const s = armed('luck-once')
    const v = s.villages.v0
    v.units = army(0, 0, 5)
    sendAttack(v, s.world, s.battleLog, 'b0', army(0, 0, 5))
    const rng = new RNG(31337)
    const clone = new RNG(31337)
    advanceMarches(v, s.world, s.battleLog, 1000, NO_TECH_MODS, undefined, rng)
    clone.next() // exactly one luck draw should have happened
    expect(rng.getState()).toBe(clone.getState())
  })

  it('does NOT draw luck for a march that has not resolved its outbound leg yet', () => {
    // The draw count must track RESOLVED attacks only (dt-chunk invariance). A march
    // mid-flight (dt below its travel time) leaves the RNG untouched.
    const s = armed('luck-pending')
    const v = s.villages.v0
    v.units = army(0, 0, 5)
    sendAttack(v, s.world, s.battleLog, 'b0', army(0, 0, 5))
    const rng = new RNG(555)
    advanceMarches(v, s.world, s.battleLog, 1, NO_TECH_MODS, undefined, rng) // 1s < 54s travel
    expect(s.battleLog.length).toBe(0) // not resolved → no report…
    expect(v.marches[0].phase).toBe('outbound') // still travelling…
    expect(rng.getState()).toBe(555 >>> 0) // …and no luck drawn
  })

  it('does NOT draw luck for a scout march (recon never fights)', () => {
    const s = armed('luck-scout')
    const v = s.villages.v0
    v.units = army(0, 0, 0, 0, 3) // scouts only
    sendScout(v, s.world, s.battleLog, 'b0', 3)
    const rng = new RNG(888)
    advanceMarches(v, s.world, s.battleLog, 1000, NO_TECH_MODS, undefined, rng) // full out-and-back
    expect(barbarianById(s.world, 'b0')!.scouted).toBe(true) // recon completed…
    expect(s.battleLog.length).toBe(0) // a scout logs nothing
    expect(rng.getState()).toBe(888 >>> 0) // and draws no luck
  })

  it('without an RNG, resolution is luck-free and the report omits `luck` (pre-M5.5 byte-for-byte)', () => {
    const s = armed('luck-absent')
    const v = s.villages.v0
    v.units = army(0, 0, 5)
    sendAttack(v, s.world, s.battleLog, 'b0', army(0, 0, 5))
    advanceMarches(v, s.world, s.battleLog, 1000) // no rng arg
    const r = s.battleLog[0]
    if (r.kind !== 'attack') throw new Error('expected an attack report')
    expect(r.won).toBe(true)
    expect('luck' in r).toBe(false)
    expect(r.luck).toBeUndefined()
  })
})
