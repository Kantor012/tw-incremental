import { describe, it, expect } from 'vitest'
import { D } from '../src/engine/decimal'
import { createInitialState, recomputeDerived } from '../src/engine/state'
import {
  buildingCost,
  build,
  canAfford,
  costReduction,
  nextCostAffordable,
} from '../src/systems/buildings'
import { BUILDINGS } from '../src/content/buildings'

/** Give a state effectively unlimited resources so affordability never gates a test. */
function rich() {
  const state = createInitialState('rich', 0)
  state.resources = { wood: D(1e9), clay: D(1e9), iron: D(1e9) }
  return state
}

describe('buildingCost', () => {
  it('grows with the building level (geometric costFactor)', () => {
    const state = createInitialState('cost', 0)
    const atLevel1 = buildingCost(state, 'sawmill')
    state.buildings.sawmill = 5
    const atLevel5 = buildingCost(state, 'sawmill')

    expect(atLevel5.wood.gt(atLevel1.wood)).toBe(true)
    expect(atLevel5.clay.gt(atLevel1.clay)).toBe(true)
    expect(atLevel5.iron.gt(atLevel1.iron)).toBe(true)
  })

  it('is reduced by raising HQ (cost after HQ upgrade < base cost)', () => {
    const state = createInitialState('hq', 0)
    // Sawmill level fixed; only the HQ-driven cost_reduction changes.
    state.buildings.hq = 1
    const baseCost = buildingCost(state, 'sawmill')
    state.buildings.hq = 10
    const reducedCost = buildingCost(state, 'sawmill')

    expect(reducedCost.wood.lt(baseCost.wood)).toBe(true)
    expect(reducedCost.clay.lt(baseCost.clay)).toBe(true)
    expect(reducedCost.iron.lt(baseCost.iron)).toBe(true)
  })
})

describe('costReduction', () => {
  it('is 1 with no HQ levels and shrinks as HQ grows', () => {
    const state = createInitialState('red', 0)
    state.buildings.hq = 0
    expect(costReduction(state).toString()).toBe('1')
    state.buildings.hq = 5
    expect(costReduction(state).lt(D(1))).toBe(true)
  })

  it('never drops below the 0.5 floor however high HQ goes', () => {
    const state = createInitialState('floor', 0)
    state.buildings.hq = BUILDINGS.hq.maxLevel // 0.96^20 ~= 0.44, below the floor
    expect(costReduction(state).toString()).toBe('0.5')
  })
})

describe('canAfford', () => {
  it('is true with enough resources and false when short on any one', () => {
    const state = createInitialState('afford', 0)
    state.resources = { wood: D(1e9), clay: D(1e9), iron: D(1e9) }
    const cost = buildingCost(state, 'sawmill')
    expect(canAfford(state, cost)).toBe(true)
    state.resources.iron = D(0)
    expect(canAfford(state, cost)).toBe(false)
  })
})

describe('build', () => {
  it('spends the exact cost and increments the level when affordable', () => {
    const state = rich()
    const beforeWood = state.resources.wood
    const beforeClay = state.resources.clay
    const beforeIron = state.resources.iron
    const level = state.buildings.sawmill
    const cost = buildingCost(state, 'sawmill') // cost for the current level

    const ok = build(state, 'sawmill')

    expect(ok).toBe(true)
    expect(state.buildings.sawmill).toBe(level + 1)
    expect(state.resources.wood.toString()).toBe(beforeWood.sub(cost.wood).toString())
    expect(state.resources.clay.toString()).toBe(beforeClay.sub(cost.clay).toString())
    expect(state.resources.iron.toString()).toBe(beforeIron.sub(cost.iron).toString())
  })

  it('returns false and mutates nothing when the cost is unaffordable', () => {
    const state = createInitialState('poor', 0)
    state.resources = { wood: D(0), clay: D(0), iron: D(0) }
    const level = state.buildings.sawmill

    expect(build(state, 'sawmill')).toBe(false)
    expect(state.buildings.sawmill).toBe(level)
    expect(state.resources.wood.toString()).toBe('0')
  })

  it('returns false and mutates nothing when the building is maxed', () => {
    const state = rich()
    const max = BUILDINGS.sawmill.maxLevel
    state.buildings.sawmill = max
    const wood = state.resources.wood

    expect(build(state, 'sawmill')).toBe(false)
    expect(state.buildings.sawmill).toBe(max)
    expect(state.resources.wood.toString()).toBe(wood.toString())
  })
})

describe('recomputeDerived', () => {
  it('raises production when the matching economy building grows', () => {
    const state = createInitialState('prod', 0)
    const before = state.production.wood // sawmill lvl 1 -> 1/s
    state.buildings.sawmill += 1
    recomputeDerived(state)

    expect(state.production.wood.gt(before)).toBe(true)
    expect(state.production.wood.toString()).toBe('2') // perLevel 1 * level 2
  })

  it('raises storageCap when the warehouse grows', () => {
    const state = createInitialState('store', 0)
    const before = state.storageCap // 1000 base + 3000 (lvl 1)
    state.buildings.warehouse += 1
    recomputeDerived(state)

    expect(state.storageCap.gt(before)).toBe(true)
    expect(state.storageCap.toString()).toBe('7000') // 1000 + 2 * 3000
  })

  it('raises popCap when the farm grows', () => {
    const state = createInitialState('pop', 0)
    const before = state.popCap // 10 base + 12 (lvl 1)
    state.buildings.farm += 1
    recomputeDerived(state)

    expect(state.popCap.gt(before)).toBe(true)
    expect(state.popCap.toString()).toBe('34') // 10 + 2 * 12
  })
})

describe('nextCostAffordable', () => {
  it('reports affordability and the maxed flag', () => {
    const state = rich()
    const info = nextCostAffordable(state, 'sawmill')
    expect(info.maxed).toBe(false)
    expect(info.affordable).toBe(true)
    expect(info.cost.wood.toString()).toBe(buildingCost(state, 'sawmill').wood.toString())

    state.buildings.sawmill = BUILDINGS.sawmill.maxLevel
    const maxedInfo = nextCostAffordable(state, 'sawmill')
    expect(maxedInfo.maxed).toBe(true)
    expect(maxedInfo.affordable).toBe(false)
  })
})
