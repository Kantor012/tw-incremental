import { describe, it, expect } from 'vitest'
import { D } from '../src/engine/decimal'
import { createVillage, recomputeVillageDerived, type Village } from '../src/engine/state'
import {
  buildingCost,
  build,
  canAfford,
  costReduction,
  nextCostAffordable,
} from '../src/systems/buildings'
import { BUILDINGS } from '../src/content/buildings'

/**
 * Since M2.1 the building engine is scoped to one {@link Village} (each village owns
 * its economy). These tests therefore exercise a single fresh capital village; the
 * mechanics — cost growth, HQ cost reduction, affordability, purchase, derived-stat
 * recompute — are unchanged from the pre-multi-village build.
 */

/** A fresh village given effectively unlimited resources so affordability never gates a test. */
function rich(): Village {
  const v = createVillage('v0', 'Stolica')
  v.resources = { wood: D(1e9), clay: D(1e9), iron: D(1e9) }
  return v
}

describe('buildingCost', () => {
  it('grows with the building level (geometric costFactor)', () => {
    const v = createVillage('v0', 'Stolica')
    const atLevel1 = buildingCost(v, 'sawmill')
    v.buildings.sawmill = 5
    const atLevel5 = buildingCost(v, 'sawmill')

    expect(atLevel5.wood.gt(atLevel1.wood)).toBe(true)
    expect(atLevel5.clay.gt(atLevel1.clay)).toBe(true)
    expect(atLevel5.iron.gt(atLevel1.iron)).toBe(true)
  })

  it('is reduced by raising HQ (cost after HQ upgrade < base cost)', () => {
    const v = createVillage('v0', 'Stolica')
    // Sawmill level fixed; only the HQ-driven cost_reduction changes.
    v.buildings.hq = 1
    const baseCost = buildingCost(v, 'sawmill')
    v.buildings.hq = 10
    const reducedCost = buildingCost(v, 'sawmill')

    expect(reducedCost.wood.lt(baseCost.wood)).toBe(true)
    expect(reducedCost.clay.lt(baseCost.clay)).toBe(true)
    expect(reducedCost.iron.lt(baseCost.iron)).toBe(true)
  })
})

describe('costReduction', () => {
  it('is 1 with no HQ levels and shrinks as HQ grows', () => {
    const v = createVillage('v0', 'Stolica')
    v.buildings.hq = 0
    expect(costReduction(v).toString()).toBe('1')
    v.buildings.hq = 5
    expect(costReduction(v).lt(D(1))).toBe(true)
  })

  it('never drops below the 0.5 floor however high HQ goes', () => {
    const v = createVillage('v0', 'Stolica')
    v.buildings.hq = BUILDINGS.hq.maxLevel // 0.96^20 ~= 0.44, below the floor
    expect(costReduction(v).toString()).toBe('0.5')
  })
})

describe('canAfford', () => {
  it('is true with enough resources and false when short on any one', () => {
    const v = createVillage('v0', 'Stolica')
    v.resources = { wood: D(1e9), clay: D(1e9), iron: D(1e9) }
    const cost = buildingCost(v, 'sawmill')
    expect(canAfford(v, cost)).toBe(true)
    v.resources.iron = D(0)
    expect(canAfford(v, cost)).toBe(false)
  })
})

describe('build', () => {
  it('spends the exact cost and increments the level when affordable', () => {
    const v = rich()
    const beforeWood = v.resources.wood
    const beforeClay = v.resources.clay
    const beforeIron = v.resources.iron
    const level = v.buildings.sawmill
    const cost = buildingCost(v, 'sawmill') // cost for the current level

    const ok = build(v, 'sawmill')

    expect(ok).toBe(true)
    expect(v.buildings.sawmill).toBe(level + 1)
    expect(v.resources.wood.toString()).toBe(beforeWood.sub(cost.wood).toString())
    expect(v.resources.clay.toString()).toBe(beforeClay.sub(cost.clay).toString())
    expect(v.resources.iron.toString()).toBe(beforeIron.sub(cost.iron).toString())
  })

  it('returns false and mutates nothing when the cost is unaffordable', () => {
    const v = createVillage('v0', 'Stolica')
    v.resources = { wood: D(0), clay: D(0), iron: D(0) }
    const level = v.buildings.sawmill

    expect(build(v, 'sawmill')).toBe(false)
    expect(v.buildings.sawmill).toBe(level)
    expect(v.resources.wood.toString()).toBe('0')
  })

  it('returns false and mutates nothing when the building is maxed', () => {
    const v = rich()
    const max = BUILDINGS.sawmill.maxLevel
    v.buildings.sawmill = max
    const wood = v.resources.wood

    expect(build(v, 'sawmill')).toBe(false)
    expect(v.buildings.sawmill).toBe(max)
    expect(v.resources.wood.toString()).toBe(wood.toString())
  })
})

describe('recomputeVillageDerived', () => {
  it('raises production when the matching economy building grows', () => {
    const v = createVillage('v0', 'Stolica')
    const before = v.production.wood // sawmill lvl 1 -> 1/s
    v.buildings.sawmill += 1
    recomputeVillageDerived(v)

    expect(v.production.wood.gt(before)).toBe(true)
    expect(v.production.wood.toString()).toBe('2') // perLevel 1 * level 2
  })

  it('raises storageCap when the warehouse grows', () => {
    const v = createVillage('v0', 'Stolica')
    const before = v.storageCap // 1000 base + 3000 (lvl 1)
    v.buildings.warehouse += 1
    recomputeVillageDerived(v)

    expect(v.storageCap.gt(before)).toBe(true)
    expect(v.storageCap.toString()).toBe('7000') // 1000 + 2 * 3000
  })

  it('raises popCap when the farm grows', () => {
    const v = createVillage('v0', 'Stolica')
    const before = v.popCap // 10 base + 12 (lvl 1)
    v.buildings.farm += 1
    recomputeVillageDerived(v)

    expect(v.popCap.gt(before)).toBe(true)
    expect(v.popCap.toString()).toBe('34') // 10 + 2 * 12
  })
})

describe('nextCostAffordable', () => {
  it('reports affordability and the maxed flag', () => {
    const v = rich()
    const info = nextCostAffordable(v, 'sawmill')
    expect(info.maxed).toBe(false)
    expect(info.affordable).toBe(true)
    expect(info.cost.wood.toString()).toBe(buildingCost(v, 'sawmill').wood.toString())

    v.buildings.sawmill = BUILDINGS.sawmill.maxLevel
    const maxedInfo = nextCostAffordable(v, 'sawmill')
    expect(maxedInfo.maxed).toBe(true)
    expect(maxedInfo.affordable).toBe(false)
  })
})
