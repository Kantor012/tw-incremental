import { describe, it, expect } from 'vitest'
import { D } from '../src/engine/decimal'
import {
  createVillage,
  recomputeVillageDerived,
  NO_TECH_MODS,
  type Village,
  type TechModifiers,
} from '../src/engine/state'
import {
  buildingCost,
  build,
  canAfford,
  costReduction,
  nextCostAffordable,
  villageDefenseMult,
} from '../src/systems/buildings'
import { BUILDINGS, BUILDING_IDS } from '../src/content/buildings'

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

/** NO_TECH_MODS with selected fields overridden — a terse TechModifiers builder. */
function mods(partial: Partial<TechModifiers>): TechModifiers {
  return { ...NO_TECH_MODS, ...partial }
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

  it('tech costReduction makes the next level cheaper (and the default mods do not)', () => {
    const v = rich()
    v.buildings.hq = 0 // isolate the tech term (building factor 1)
    const base = buildingCost(v, 'sawmill')
    const cheaper = buildingCost(v, 'sawmill', mods({ costReduction: 0.5 }))
    expect(cheaper.wood.lt(base.wood)).toBe(true)
    expect(cheaper.clay.lt(base.clay)).toBe(true)
    expect(cheaper.iron.lt(base.iron)).toBe(true)
    // The discounted cost is the un-rounded formula (baseCost * growth) scaled by the
    // 0.5 factor, then ceiled — verified against the raw inputs (no double-ceil).
    const def = BUILDINGS.sawmill
    const growth = D(def.costFactor).pow(v.buildings.sawmill)
    const expected = D(def.baseCost.wood).mul(growth).mul(D(0.5)).ceil()
    expect(cheaper.wood.toString()).toBe(expected.toString())
    // Passing NO_TECH_MODS explicitly equals the no-arg call.
    expect(buildingCost(v, 'sawmill', NO_TECH_MODS).wood.toString()).toBe(base.wood.toString())
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

  it('NO_TECH_MODS leaves the pure-building factor unchanged (default == explicit)', () => {
    const v = createVillage('v0', 'Stolica')
    v.buildings.hq = 5
    expect(costReduction(v, NO_TECH_MODS).toString()).toBe(costReduction(v).toString())
  })

  it('folds the tech costReduction fraction in ADDITIVELY on the reduction side', () => {
    const v = createVillage('v0', 'Stolica')
    v.buildings.hq = 0 // isolate the tech term: building factor is exactly 1
    // reduction = (1 - 1) + 0.5 = 0.5 → multiplier 0.5.
    expect(costReduction(v, mods({ costReduction: 0.5 })).toString()).toBe('0.5')
    // a 0.2 fraction with no HQ → multiplier 0.8.
    expect(costReduction(v, mods({ costReduction: 0.2 })).toString()).toBe('0.8')
  })

  it('clamps the COMBINED building+tech reduction to 0.9 (multiplier floor 0.1)', () => {
    const v = createVillage('v0', 'Stolica')
    v.buildings.hq = BUILDINGS.hq.maxLevel // building factor floored at 0.5 → 0.5 reduction
    // 0.5 (building) + 0.8 (tech) = 1.3 reduction, clamped to 0.9 → multiplier 0.1.
    expect(costReduction(v, mods({ costReduction: 0.8 })).toString()).toBe('0.1')
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

  it('charges the tech-discounted cost when mods carry a costReduction', () => {
    const v = rich()
    v.buildings.hq = 0 // isolate the tech term
    const m = mods({ costReduction: 0.5 })
    const level = v.buildings.sawmill
    const cost = buildingCost(v, 'sawmill', m)
    const beforeWood = v.resources.wood

    // The same mods must drive the spend AND the post-build recompute.
    expect(build(v, 'sawmill', m)).toBe(true)
    expect(v.buildings.sawmill).toBe(level + 1)
    expect(v.resources.wood.toString()).toBe(beforeWood.sub(cost.wood).toString())
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

  it('threads the tech costReduction into the reported cost', () => {
    const v = rich()
    v.buildings.hq = 0 // isolate the tech term
    const base = nextCostAffordable(v, 'sawmill')
    const discounted = nextCostAffordable(v, 'sawmill', mods({ costReduction: 0.5 }))
    expect(discounted.cost.wood.lt(base.cost.wood)).toBe(true)
    expect(discounted.cost.wood.toString()).toBe(
      buildingCost(v, 'sawmill', mods({ costReduction: 0.5 })).wood.toString(),
    )
  })
})

/**
 * M2.4 — the academy (Pałac) is the conquest gate: a BINARY `noble_unlock` building
 * that lets a village train the noble (units.ts `requires: 'academy'`) and so capture
 * barbarian villages. It contributes to NO tick-derived stat, so recompute must treat
 * it as a pure no-op while the generic cost/affordability/max engine still applies.
 */
describe('academy (Pałac — noble-unlock building)', () => {
  it('catalogue: military, maxLevel 3, 15k cost, factor 1.6 and a binary noble_unlock effect', () => {
    const def = BUILDINGS.academy
    expect(def.id).toBe('academy')
    expect(def.name).toBe('Pałac')
    expect(def.category).toBe('military')
    expect(def.maxLevel).toBe(3)
    expect(def.baseCost).toEqual({ wood: 15000, clay: 15000, iron: 15000 })
    expect(def.costFactor).toBe(1.6)
    // Binary gate: the effect is exactly { kind: 'noble_unlock' } — no perLevel magnitude.
    expect(def.effect).toEqual({ kind: 'noble_unlock' })
    // A fresh village never starts with the academy (building it is a late-M2 goal).
    expect(def.initialLevel ?? 0).toBe(0)
  })

  it('appears right before the M5.2 wall in the stable BUILDING_IDS order', () => {
    // Append-only order: ... academy, wall, market (M9 appended the market after the wall).
    // The academy still sits immediately before the wall — pin that relative order so the
    // check survives further append-only growth of the trailing keys.
    const academyIdx = BUILDING_IDS.indexOf('academy')
    expect(BUILDING_IDS[academyIdx + 1]).toBe('wall')
  })

  it('recomputeVillageDerived ignores it — raising the academy changes no derived stat', () => {
    const v = createVillage('v0', 'Stolica')
    const before = {
      wood: v.production.wood.toString(),
      clay: v.production.clay.toString(),
      iron: v.production.iron.toString(),
      storage: v.storageCap.toString(),
      pop: v.popCap.toString(),
    }

    v.buildings.academy = BUILDINGS.academy.maxLevel
    recomputeVillageDerived(v)

    expect(v.production.wood.toString()).toBe(before.wood)
    expect(v.production.clay.toString()).toBe(before.clay)
    expect(v.production.iron.toString()).toBe(before.iron)
    expect(v.storageCap.toString()).toBe(before.storage)
    expect(v.popCap.toString()).toBe(before.pop)
  })

  it('uses the generic engine: cost grows with level and build() maxes out at level 3', () => {
    const v = rich()
    const atL0 = buildingCost(v, 'academy')
    v.buildings.academy = 2
    const atL2 = buildingCost(v, 'academy')
    expect(atL2.wood.gt(atL0.wood)).toBe(true)
    expect(atL2.iron.gt(atL0.iron)).toBe(true)

    // From scratch: three buys reach the ceiling, the fourth is refused.
    const v2 = rich()
    expect(build(v2, 'academy')).toBe(true) // 0 -> 1
    expect(build(v2, 'academy')).toBe(true) // 1 -> 2
    expect(build(v2, 'academy')).toBe(true) // 2 -> 3 (max)
    expect(v2.buildings.academy).toBe(BUILDINGS.academy.maxLevel)
    expect(build(v2, 'academy')).toBe(false) // already maxed — no mutation
    expect(v2.buildings.academy).toBe(BUILDINGS.academy.maxLevel)
  })
})

/**
 * M5.2 — the wall (Mur) is a defensive building: a `defense_bonus` effect that raises
 * the village's raid defence via {@link villageDefenseMult}. Like the academy it
 * contributes to NO tick-derived stat (production / storage / pop), so recompute must
 * treat it as a pure no-op while the generic cost/affordability/max engine still
 * applies; villageDefenseMult is the one consumer of its effect.
 */
describe('wall (Mur — defensive building)', () => {
  it('catalogue: military, maxLevel 10, the contract cost/factor and a defense_bonus effect', () => {
    const def = BUILDINGS.wall
    expect(def.id).toBe('wall')
    expect(def.name).toBe('Mur')
    expect(def.category).toBe('military')
    expect(def.maxLevel).toBe(10)
    expect(def.baseCost).toEqual({ wood: 120, clay: 200, iron: 60 })
    expect(def.costFactor).toBe(1.27)
    expect(def.effect).toEqual({ kind: 'defense_bonus', perLevel: 0.05 })
    // A fresh village never starts with a wall (optional defensive investment).
    expect(def.initialLevel ?? 0).toBe(0)
  })

  it('appears right before the M9 market in the stable BUILDING_IDS order (was last until M9)', () => {
    // The wall (M5.2) was the last key until M9 appended the market after it, M10 then appended
    // the stable after the market, and M13 appended the watchtower last; the wall now sits
    // fourth-to-last, still after the academy. Pins the append-only order through M13.
    expect(BUILDING_IDS[BUILDING_IDS.length - 1]).toBe('watchtower')
    expect(BUILDING_IDS[BUILDING_IDS.length - 2]).toBe('stable')
    expect(BUILDING_IDS[BUILDING_IDS.length - 3]).toBe('market')
    expect(BUILDING_IDS[BUILDING_IDS.length - 4]).toBe('wall')
  })

  it('recomputeVillageDerived ignores it — raising the wall changes no derived stat', () => {
    const v = createVillage('v0', 'Stolica')
    const before = {
      wood: v.production.wood.toString(),
      clay: v.production.clay.toString(),
      iron: v.production.iron.toString(),
      storage: v.storageCap.toString(),
      pop: v.popCap.toString(),
    }

    v.buildings.wall = BUILDINGS.wall.maxLevel
    recomputeVillageDerived(v)

    expect(v.production.wood.toString()).toBe(before.wood)
    expect(v.production.clay.toString()).toBe(before.clay)
    expect(v.production.iron.toString()).toBe(before.iron)
    expect(v.storageCap.toString()).toBe(before.storage)
    expect(v.popCap.toString()).toBe(before.pop)
  })

  it('uses the generic engine: cost grows with level and build() maxes out at level 10', () => {
    const v = rich()
    const atL0 = buildingCost(v, 'wall')
    v.buildings.wall = 5
    const atL5 = buildingCost(v, 'wall')
    expect(atL5.wood.gt(atL0.wood)).toBe(true)
    expect(atL5.clay.gt(atL0.clay)).toBe(true)

    // From scratch: ten buys reach the ceiling, the eleventh is refused.
    const v2 = rich()
    for (let i = 0; i < BUILDINGS.wall.maxLevel; i++) expect(build(v2, 'wall')).toBe(true)
    expect(v2.buildings.wall).toBe(BUILDINGS.wall.maxLevel)
    expect(build(v2, 'wall')).toBe(false) // already maxed — no mutation
    expect(v2.buildings.wall).toBe(BUILDINGS.wall.maxLevel)
  })

  describe('villageDefenseMult', () => {
    it('is exactly 1 with no wall (byte-identical to pre-M5.2 raid defence)', () => {
      const v = createVillage('v0', 'Stolica')
      expect(v.buildings.wall).toBe(0)
      expect(villageDefenseMult(v)).toBe(1)
    })

    it('rises by perLevel per wall level and is monotonic in the level', () => {
      const v = createVillage('v0', 'Stolica')
      const perLevel = (BUILDINGS.wall.effect as { perLevel: number }).perLevel
      let prev = villageDefenseMult(v)
      for (let level = 1; level <= BUILDINGS.wall.maxLevel; level++) {
        v.buildings.wall = level
        const mult = villageDefenseMult(v)
        // Each level adds exactly perLevel (the additive roll-up: 1 + level*perLevel).
        expect(mult).toBeCloseTo(1 + level * perLevel)
        expect(mult).toBeGreaterThan(prev) // strictly increasing with the level
        prev = mult
      }
      // A maxed wall is +50% at the default perLevel 0.05.
      v.buildings.wall = BUILDINGS.wall.maxLevel
      expect(villageDefenseMult(v)).toBeCloseTo(1.5)
    })

    it('multiplies an army defence figure (the value raids.ts feeds to battleOutcome)', () => {
      const v = createVillage('v0', 'Stolica')
      v.buildings.wall = 10 // +50%
      // The wall raises whatever raw defence the garrison brings — a higher figure into
      // battleOutcome means more raids repelled / smaller losses (verified end-to-end in
      // raids.test.ts). Here we pin the multiplier maths the raid path relies on.
      const rawDefence = 200
      expect(rawDefence * villageDefenseMult(v)).toBeCloseTo(300)
    })
  })
})
