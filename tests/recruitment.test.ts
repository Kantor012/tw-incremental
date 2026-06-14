import { describe, it, expect } from 'vitest'
import { D, type Decimal } from '../src/engine/decimal'
import {
  createInitialState,
  recomputeVillageDerived,
  type GameState,
  type Village,
} from '../src/engine/state'
import {
  barracksUnlocked,
  recruitSpeedMult,
  usedPopulation,
  freePopulation,
  recruitCost,
  canRecruit,
  recruit,
  advanceRecruitment,
} from '../src/systems/recruitment'
import { build } from '../src/systems/buildings'
import { simulate } from '../src/engine/tick'
import { serialize } from '../src/engine/save'
import { UNITS } from '../src/content/units'

/**
 * Since M2.1 recruitment operates per-VILLAGE: every function takes a {@link Village}
 * (its resources / buildings / units / recruitQueue / popCap), never the whole
 * GameState. These single-village tests work the capital (`v0`) directly via
 * {@link cap}; the few state-level primitives ({@link simulate}, {@link serialize})
 * still take the GameState, so tests that touch both keep a reference to each.
 */

/** The capital village (`v0`) — the lone village in these single-village tests. */
function cap(state: GameState): Village {
  return state.villages.v0
}

/**
 * A state whose capital has the barracks already at level 1 (recruitment unlocked)
 * and effectively unlimited resources, so affordability never gates the recruitment
 * assertions. Setting the level directly + recomputing is exactly what `build` does,
 * minus the cost — it keeps these tests decoupled from the barracks price.
 */
function armed(seed = 'rec'): GameState {
  const state = createInitialState(seed, 0)
  const v = cap(state)
  v.resources = { wood: D(1e6), clay: D(1e6), iron: D(1e6) }
  v.buildings.barracks = 1
  recomputeVillageDerived(v)
  return state
}

/** Per-unit training time at the village's current barracks level (the snapshot). */
function perUnit(v: Village, unitId: 'spearman' | 'swordsman' | 'axeman'): number {
  return UNITS[unitId].recruitSeconds * recruitSpeedMult(v)
}

describe('recruitment gate (canRecruit / recruit)', () => {
  it('refuses to recruit without a barracks, with a reason, and recruit() is a no-op', () => {
    const state = createInitialState('locked', 0)
    const v = cap(state)
    v.resources = { wood: D(1e6), clay: D(1e6), iron: D(1e6) }

    expect(barracksUnlocked(v)).toBe(false)
    const verdict = canRecruit(v, 'spearman', 1)
    expect(verdict.ok).toBe(false)
    expect(verdict.reason).toMatch(/koszar/i)

    const before = serialize(state)
    expect(recruit(v, 'spearman', 1)).toBe(false)
    expect(serialize(state)).toBe(before) // nothing spent, nothing queued
    expect(v.recruitQueue.length).toBe(0)
  })

  it('rejects a non-positive or non-integer count', () => {
    const v = cap(armed())
    expect(canRecruit(v, 'spearman', 0).ok).toBe(false)
    expect(canRecruit(v, 'spearman', -3).ok).toBe(false)
    expect(canRecruit(v, 'spearman', 1.5).ok).toBe(false)
  })

  it('after building the barracks, recruit() spends resources and enqueues a snapshotted order', () => {
    const state = createInitialState('build', 0)
    const v = cap(state)
    v.resources = { wood: D(1e6), clay: D(1e6), iron: D(1e6) }

    // Build the real barracks (level 0 -> 1): the actual in-game unlock path.
    expect(build(v, 'barracks')).toBe(true)
    expect(barracksUnlocked(v)).toBe(true)

    const wood = v.resources.wood
    const clay = v.resources.clay
    const iron = v.resources.iron

    const cost = recruitCost('spearman', 2)
    expect(cost.wood.toString()).toBe('100') // 50 * 2
    expect(cost.clay.toString()).toBe('60') //  30 * 2
    expect(cost.iron.toString()).toBe('20') //  10 * 2

    expect(recruit(v, 'spearman', 2)).toBe(true)

    // Exact resource debit on Decimal.
    expect(v.resources.wood.toString()).toBe(wood.sub(cost.wood).toString())
    expect(v.resources.clay.toString()).toBe(clay.sub(cost.clay).toString())
    expect(v.resources.iron.toString()).toBe(iron.sub(cost.iron).toString())

    // One queued order, snapshotted: remaining starts at perUnitSeconds.
    expect(v.recruitQueue.length).toBe(1)
    const order = v.recruitQueue[0]
    expect(order.unitId).toBe('spearman')
    expect(order.count).toBe(2)
    expect(order.remaining).toBe(order.perUnitSeconds)
    expect(order.perUnitSeconds).toBeCloseTo(80 * 0.95) // 80s base * barracks-lvl-1 speed
    // No unit minted yet — training has not advanced.
    expect(v.units.spearman).toBe(0)
  })
})

describe('advanceRecruitment (the per-tick clock)', () => {
  it('mints a unit once its training time elapses and re-arms for the next', () => {
    const v = cap(armed())
    recruit(v, 'spearman', 2)
    const per = v.recruitQueue[0].perUnitSeconds

    // Halfway through the first unit: nothing minted, remaining banked.
    advanceRecruitment(v, per * 0.5)
    expect(v.units.spearman).toBe(0)
    expect(v.recruitQueue[0].count).toBe(2)
    expect(v.recruitQueue[0].remaining).toBeCloseTo(per * 0.5)

    // Enough budget to finish both: first unit's leftover half + the full second.
    advanceRecruitment(v, per * 2)
    expect(v.units.spearman).toBe(2)
    expect(v.recruitQueue.length).toBe(0)
  })

  it('finishes many queued units across one large dt (offline catch-up)', () => {
    const v = cap(armed())
    recruit(v, 'spearman', 5)
    const per = v.recruitQueue[0].perUnitSeconds

    // A single huge dt (long offline) completes the whole order in one call.
    advanceRecruitment(v, per * 100)
    expect(v.units.spearman).toBe(5)
    expect(v.recruitQueue.length).toBe(0)
  })

  it('spills leftover dt from a finished order into the following order', () => {
    const v = cap(armed())
    recruit(v, 'spearman', 1)
    recruit(v, 'swordsman', 1)
    const perSpear = v.recruitQueue[0].perUnitSeconds
    const perSword = v.recruitQueue[1].perUnitSeconds

    // Exactly enough to finish the spearman plus the swordsman: the budget left
    // after the first order must carry into the second within the same call.
    advanceRecruitment(v, perSpear + perSword)
    expect(v.units.spearman).toBe(1)
    expect(v.units.swordsman).toBe(1)
    expect(v.recruitQueue.length).toBe(0)
  })

  it('is a no-op for dt <= 0', () => {
    const state = armed()
    const v = cap(state)
    recruit(v, 'spearman', 1)
    const before = serialize(state)
    advanceRecruitment(v, 0)
    advanceRecruitment(v, -10)
    expect(serialize(state)).toBe(before)
  })

  it('simulate() drives training off the same clock', () => {
    const state = armed()
    const v = cap(state)
    recruit(v, 'spearman', 1)
    const per = v.recruitQueue[0].perUnitSeconds

    simulate(state, per * 2)
    expect(v.units.spearman).toBe(1)
    expect(v.recruitQueue.length).toBe(0)
  })
})

describe('population budget', () => {
  it('counts queued units toward used population and blocks over-commit', () => {
    const v = cap(armed())
    // Tighten the cap to exactly one slot (recompute would reset it, so set after).
    v.popCap = D(1)

    expect(usedPopulation(v).toString()).toBe('0')
    expect(freePopulation(v).toString()).toBe('1')

    // Two at once exceeds the single free slot.
    const tooMany = canRecruit(v, 'spearman', 2)
    expect(tooMany.ok).toBe(false)
    expect(tooMany.reason).toMatch(/populac/i)

    // One fits; queuing it fills the only slot (queued counts as used).
    expect(canRecruit(v, 'spearman', 1).ok).toBe(true)
    expect(recruit(v, 'spearman', 1)).toBe(true)
    expect(usedPopulation(v).toString()).toBe('1')
    expect((freePopulation(v) as Decimal).toString()).toBe('0')

    // No room left, even though resources are plentiful.
    expect(canRecruit(v, 'spearman', 1).ok).toBe(false)
    expect(recruit(v, 'spearman', 1)).toBe(false)
  })

  it('freePopulation never goes negative', () => {
    const v = cap(armed())
    v.units.spearman = 999 // over any sane cap
    expect(freePopulation(v).toString()).toBe('0')
  })
})

describe('recruit_speed (barracks upgrades)', () => {
  it('recruitSpeedMult shrinks with barracks level and floors at 0.25', () => {
    const v = cap(armed())
    expect(recruitSpeedMult(v)).toBeCloseTo(0.95) // level 1: 0.95^1
    v.buildings.barracks = 2
    expect(recruitSpeedMult(v)).toBeCloseTo(0.9025) // level 2: 0.95^2
    expect(recruitSpeedMult(v)).toBeLessThan(0.95)

    // Far past any real level the multiplier is clamped to the hard floor.
    v.buildings.barracks = 100
    expect(recruitSpeedMult(v)).toBe(0.25)
  })

  it('upgrading the barracks speeds up NEW orders while the in-flight order keeps its snapshot', () => {
    const v = cap(armed())
    recruit(v, 'spearman', 1)
    const snapshot = v.recruitQueue[0].perUnitSeconds
    expect(snapshot).toBeCloseTo(perUnit(v, 'spearman')) // taken at level 1

    // Upgrade the barracks: the queued order must NOT retroactively change.
    v.buildings.barracks = 2
    recomputeVillageDerived(v)
    expect(v.recruitQueue[0].perUnitSeconds).toBe(snapshot)

    // A fresh order trains faster at the new level.
    recruit(v, 'spearman', 1)
    const fresh = v.recruitQueue[1].perUnitSeconds
    expect(fresh).toBeCloseTo(80 * 0.9025)
    expect(fresh).toBeLessThan(snapshot)
  })
})

describe('determinism', () => {
  it('two identical states under the same simulate sequence serialize equally', () => {
    const a = armed('det')
    const b = armed('det')
    expect(serialize(a)).toBe(serialize(b)) // identical starting points

    const va = cap(a)
    const vb = cap(b)
    recruit(va, 'spearman', 3)
    recruit(vb, 'spearman', 3)

    // A mixed sequence of step sizes (small ticks + big offline-style jumps).
    for (const dt of [5, 13.37, 100, 0.05, 250]) {
      simulate(a, dt)
      simulate(b, dt)
    }

    expect(serialize(a)).toBe(serialize(b))
    // Sanity: recruitment actually progressed (so equality is meaningful).
    expect(va.units.spearman).toBe(3)
    expect(va.recruitQueue.length).toBe(0)
  })
})
