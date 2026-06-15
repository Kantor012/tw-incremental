import { describe, it, expect } from 'vitest'
import { D } from '../src/engine/decimal'
import {
  createInitialState,
  createVillage,
  NO_TECH_MODS,
  type GameState,
} from '../src/engine/state'
import {
  nodeLevel,
  techCost,
  aggregateTechMods,
  prerequisitesMet,
  nodeAvailable,
  globalResources,
  canPurchaseTech,
  purchaseTech,
  techHasCycle,
  orphanNodes,
  deadPerkNodes,
} from '../src/systems/tech'
import { TECH_NODES, TECH_NODE_IDS, TECH_ROOTS } from '../src/content/tech'
import { layoutTree, techEdges } from '../src/systems/techLayout'

/**
 * M3.1 — global, account-wide passive tech tree. These tests pin the contract of the
 * data-driven engine (systems/tech.ts), the pure DATA catalogue (content/tech.ts) and
 * the deterministic radial layout (systems/techLayout.ts):
 *  - static topology is a healthy DAG (no cycles, no orphans, no dead perks, sane bands);
 *  - costs grow geometrically with level;
 *  - prerequisites gate availability (locked until prereq >= 1);
 *  - aggregateTechMods folds the right multipliers;
 *  - purchaseTech spends from the GLOBAL (all-village) pool, bumps the level and
 *    re-derives every village so the economic multipliers actually bite;
 *  - canPurchaseTech rejects unknown / maxed / locked / unaffordable;
 *  - layoutTree places every node without gross overlap.
 *
 * The economy is on Decimal, but TechModifiers fields are plain numbers; float
 * comparisons use toBeCloseTo, exact Decimal results compare via toString().
 */

/** A fresh run with the capital given effectively unlimited resources. */
function richState(): GameState {
  const s = createInitialState('tech-test', 0)
  s.villages.v0.resources = { wood: D(1e9), clay: D(1e9), iron: D(1e9) }
  return s
}

/** Numeric value of a Decimal field (for toBeCloseTo on multiplied economy stats). */
function num(d: { toString(): string }): number {
  return Number(d.toString())
}

describe('tech catalogue (static topology invariants)', () => {
  it('TECH_NODE_IDS mirrors the catalogue keys in source order', () => {
    expect(TECH_NODE_IDS).toEqual(Object.keys(TECH_NODES))
    expect(TECH_NODE_IDS.length).toBeGreaterThanOrEqual(50)
  })

  it('the prerequisite graph is an acyclic DAG', () => {
    expect(techHasCycle()).toBe(false)
  })

  it('every node is reachable from a root (no orphans)', () => {
    expect(orphanNodes()).toEqual([])
  })

  it('every node has a real effect (no dead perks, perLevel > 0)', () => {
    expect(deadPerkNodes()).toEqual([])
    for (const id of TECH_NODE_IDS) {
      expect(TECH_NODES[id].effect.perLevel).toBeGreaterThan(0)
    }
  })

  it('every maxLevel is in 1..10 and matches its archetype band', () => {
    for (const id of TECH_NODE_IDS) {
      const n = TECH_NODES[id]
      expect(n.maxLevel).toBeGreaterThanOrEqual(1)
      expect(n.maxLevel).toBeLessThanOrEqual(10)
      if (n.archetype === 'gateway') expect(n.maxLevel).toBe(1)
      else if (n.archetype === 'notable') {
        expect(n.maxLevel).toBeGreaterThanOrEqual(2)
        expect(n.maxLevel).toBeLessThanOrEqual(3)
      } else {
        expect(n.maxLevel).toBeGreaterThanOrEqual(7)
        expect(n.maxLevel).toBeLessThanOrEqual(10)
      }
    }
  })

  it('TECH_ROOTS are exactly the no-prerequisite nodes, one per category', () => {
    for (const id of TECH_ROOTS) {
      expect(TECH_NODES[id].prerequisites).toEqual([])
    }
    const fromData = TECH_NODE_IDS.filter((id) => TECH_NODES[id].prerequisites.length === 0)
    expect([...TECH_ROOTS].sort()).toEqual(fromData.sort())
    const cats = new Set(TECH_ROOTS.map((id) => TECH_NODES[id].category))
    expect(cats).toEqual(new Set(['economy', 'storage', 'settlement']))
  })

  it('every prerequisite id points at a real node', () => {
    for (const id of TECH_NODE_IDS) {
      for (const pre of TECH_NODES[id].prerequisites) {
        expect(TECH_NODES[pre]).toBeDefined()
      }
    }
  })
})

describe('nodeLevel', () => {
  it('is 0 for an unbought node and reads the stored level otherwise', () => {
    const s = richState()
    expect(nodeLevel(s, 'eco_root')).toBe(0)
    s.tech.eco_root = 3
    expect(nodeLevel(s, 'eco_root')).toBe(3)
  })

  it('treats a non-positive / non-finite stored value as 0', () => {
    const s = richState()
    s.tech.eco_root = 0
    expect(nodeLevel(s, 'eco_root')).toBe(0)
    s.tech.eco_root = -2
    expect(nodeLevel(s, 'eco_root')).toBe(0)
    s.tech.eco_root = Number.NaN
    expect(nodeLevel(s, 'eco_root')).toBe(0)
  })
})

describe('techCost', () => {
  it('grows geometrically with the owned level', () => {
    const at0 = techCost('eco_root', 0)
    const at1 = techCost('eco_root', 1)
    const at5 = techCost('eco_root', 5)
    expect(at1.wood.gt(at0.wood)).toBe(true)
    expect(at5.wood.gt(at1.wood)).toBe(true)
    expect(at5.iron.gt(at1.iron)).toBe(true)
  })

  it('equals ceil(baseCost * costFactor^level), rounded up', () => {
    // eco_root: baseCost 120/120/120, costFactor 1.28.
    expect(techCost('eco_root', 0).wood.toString()).toBe('120')
    expect(techCost('eco_root', 1).wood.toString()).toBe('154') // ceil(120 * 1.28) = ceil(153.6)
    expect(techCost('eco_root', 1).clay.toString()).toBe('154')
    expect(techCost('eco_root', 1).iron.toString()).toBe('154')
  })
})

describe('prerequisitesMet / nodeAvailable', () => {
  it('a root has its prerequisites met and is available from the start', () => {
    const s = richState()
    expect(prerequisitesMet(s, 'eco_root')).toBe(true)
    expect(nodeAvailable(s, 'eco_root')).toBe(true)
  })

  it('a child is locked until its prerequisite reaches level 1', () => {
    const s = richState()
    expect(prerequisitesMet(s, 'eco_core_n')).toBe(false)
    expect(nodeAvailable(s, 'eco_core_n')).toBe(false)
    s.tech.eco_root = 1
    expect(prerequisitesMet(s, 'eco_core_n')).toBe(true)
    expect(nodeAvailable(s, 'eco_core_n')).toBe(true)
  })

  it('a maxed node is no longer available even with prerequisites met', () => {
    const s = richState()
    s.tech.eco_root = TECH_NODES.eco_root.maxLevel
    expect(prerequisitesMet(s, 'eco_root')).toBe(true)
    expect(nodeAvailable(s, 'eco_root')).toBe(false)
  })

  it('an unknown node is never available', () => {
    const s = richState()
    expect(prerequisitesMet(s, 'does_not_exist')).toBe(false)
    expect(nodeAvailable(s, 'does_not_exist')).toBe(false)
  })
})

describe('aggregateTechMods', () => {
  it('is the identity (all 1) for an empty tree', () => {
    expect(aggregateTechMods({})).toEqual(NO_TECH_MODS)
  })

  it('folds an all-resource production_mult into every resource', () => {
    const mods = aggregateTechMods({ eco_root: 2 }) // perLevel 0.02, applies to all
    expect(mods.productionMult.wood).toBeCloseTo(1.04, 9)
    expect(mods.productionMult.clay).toBeCloseTo(1.04, 9)
    expect(mods.productionMult.iron).toBeCloseTo(1.04, 9)
    expect(mods.storageMult).toBe(1)
    expect(mods.popMult).toBe(1)
  })

  it('stacks a per-resource production_mult on top of the all-resource one', () => {
    // eco_root (+0.02 all) + eco_wood_n (+0.08 wood) => wood 1.10, clay/iron 1.02.
    const mods = aggregateTechMods({ eco_root: 1, eco_wood_n: 1 })
    expect(mods.productionMult.wood).toBeCloseTo(1.1, 9)
    expect(mods.productionMult.clay).toBeCloseTo(1.02, 9)
    expect(mods.productionMult.iron).toBeCloseTo(1.02, 9)
  })

  it('folds storage_mult (and ignores it for production/pop)', () => {
    const mods = aggregateTechMods({ sto_root: 3, sto_core_n: 1 }) // 0.02*3 + 0.07
    expect(mods.storageMult).toBeCloseTo(1.13, 9)
    expect(mods.productionMult.wood).toBe(1)
    expect(mods.popMult).toBe(1)
  })

  it('folds pop_mult', () => {
    const mods = aggregateTechMods({ set_root: 2 }) // 0.02 * 2
    expect(mods.popMult).toBeCloseTo(1.04, 9)
    expect(mods.storageMult).toBe(1)
  })

  it('ignores unknown / zeroed keys (robust + deterministic)', () => {
    expect(aggregateTechMods({ phantom: 5, eco_root: 0 })).toEqual(NO_TECH_MODS)
  })
})

describe('globalResources', () => {
  it('sums each resource across every village', () => {
    const s = createInitialState('tech-pool', 0)
    s.villages.v0.resources = { wood: D(40), clay: D(50), iron: D(60) }
    const v1 = createVillage('v1', 'Druga', 10, 10)
    v1.resources = { wood: D(100), clay: D(100), iron: D(100) }
    s.villages.v1 = v1
    s.villageOrder.push('v1')

    const pool = globalResources(s)
    expect(pool.wood.toString()).toBe('140')
    expect(pool.clay.toString()).toBe('150')
    expect(pool.iron.toString()).toBe('160')
  })
})

describe('canPurchaseTech', () => {
  it('rejects an unknown node', () => {
    const s = richState()
    const res = canPurchaseTech(s, 'no_such_node')
    expect(res.ok).toBe(false)
    expect(res.reason).toBe('Nieznany węzeł')
  })

  it('rejects a locked node (prerequisites unmet) even when affordable', () => {
    const s = richState() // plenty of resources, but eco_root not yet owned
    const res = canPurchaseTech(s, 'eco_core_n')
    expect(res.ok).toBe(false)
    expect(res.reason).toBe('Wymagania niespełnione')
  })

  it('rejects a maxed node', () => {
    const s = richState()
    s.tech.eco_root = TECH_NODES.eco_root.maxLevel
    const res = canPurchaseTech(s, 'eco_root')
    expect(res.ok).toBe(false)
    expect(res.reason).toBe('Poziom maksymalny')
  })

  it('rejects when the global pool cannot cover the cost', () => {
    const s = createInitialState('tech-poor', 0) // capital starts with 50/50/50; eco_root costs 120
    const res = canPurchaseTech(s, 'eco_root')
    expect(res.ok).toBe(false)
    expect(res.reason).toBe('Za mało surowców')
  })

  it('accepts an available, affordable, unmaxed node (no reason)', () => {
    const s = richState()
    const res = canPurchaseTech(s, 'eco_root')
    expect(res.ok).toBe(true)
    expect(res.reason).toBeUndefined()
  })
})

describe('purchaseTech', () => {
  it('raises the level, spends the exact cost, and re-derives production', () => {
    const s = richState()
    const cost = techCost('eco_root', 0)
    const beforeWood = s.villages.v0.resources.wood
    const beforeProd = s.villages.v0.production.wood // base sawmill output (no tech)

    const ok = purchaseTech(s, 'eco_root')

    expect(ok).toBe(true)
    expect(s.tech.eco_root).toBe(1)
    expect(s.villages.v0.resources.wood.toString()).toBe(beforeWood.sub(cost.wood).toString())
    // production_mult +0.02 (all resources) folded by recomputeDerived.
    expect(s.villages.v0.production.wood.gt(beforeProd)).toBe(true)
    expect(num(s.villages.v0.production.wood)).toBeCloseTo(num(beforeProd) * 1.02, 9)
  })

  it('raises the storage cap after a storage_mult purchase', () => {
    const s = richState()
    const before = s.villages.v0.storageCap
    expect(purchaseTech(s, 'sto_root')).toBe(true)
    expect(s.villages.v0.storageCap.gt(before)).toBe(true)
    expect(num(s.villages.v0.storageCap)).toBeCloseTo(num(before) * 1.02, 6)
  })

  it('raises the population cap after a pop_mult purchase', () => {
    const s = richState()
    const before = s.villages.v0.popCap
    expect(purchaseTech(s, 'set_root')).toBe(true)
    expect(s.villages.v0.popCap.gt(before)).toBe(true)
    expect(num(s.villages.v0.popCap)).toBeCloseTo(num(before) * 1.02, 9)
  })

  it('draws greedily from the GLOBAL pool across villages and applies mods to ALL of them', () => {
    const s = createInitialState('tech-greedy', 0)
    const v1 = createVillage('v1', 'Druga', 10, 10)
    s.villages.v1 = v1
    s.villageOrder.push('v1')
    // 100 + 100 = 200 of each; eco_root costs 120 — drains v0 fully, then 20 from v1.
    s.villages.v0.resources = { wood: D(100), clay: D(100), iron: D(100) }
    v1.resources = { wood: D(100), clay: D(100), iron: D(100) }
    const prod0Before = s.villages.v0.production.wood
    const prod1Before = v1.production.wood

    expect(purchaseTech(s, 'eco_root')).toBe(true)

    expect(s.tech.eco_root).toBe(1)
    expect(s.villages.v0.resources.wood.toString()).toBe('0')
    expect(s.villages.v1.resources.wood.toString()).toBe('80')
    expect(s.villages.v0.resources.iron.toString()).toBe('0')
    expect(s.villages.v1.resources.iron.toString()).toBe('80')
    // Tech multipliers are GLOBAL — both villages' production rose.
    expect(s.villages.v0.production.wood.gt(prod0Before)).toBe(true)
    expect(s.villages.v1.production.wood.gt(prod1Before)).toBe(true)
  })

  it('returns false and mutates nothing when unaffordable', () => {
    const s = createInitialState('tech-noop', 0) // 50/50/50, eco_root costs 120
    const before = {
      wood: s.villages.v0.resources.wood.toString(),
      clay: s.villages.v0.resources.clay.toString(),
      iron: s.villages.v0.resources.iron.toString(),
    }
    expect(purchaseTech(s, 'eco_root')).toBe(false)
    expect(nodeLevel(s, 'eco_root')).toBe(0)
    expect(s.villages.v0.resources.wood.toString()).toBe(before.wood)
    expect(s.villages.v0.resources.clay.toString()).toBe(before.clay)
    expect(s.villages.v0.resources.iron.toString()).toBe(before.iron)
  })

  it('returns false for a locked node and leaves the tree untouched', () => {
    const s = richState()
    expect(purchaseTech(s, 'eco_core_n')).toBe(false)
    expect(nodeLevel(s, 'eco_core_n')).toBe(0)
  })

  it('unlocks a child node once its prerequisite is bought', () => {
    const s = richState()
    expect(nodeAvailable(s, 'eco_core_n')).toBe(false)
    expect(purchaseTech(s, 'eco_root')).toBe(true)
    expect(nodeAvailable(s, 'eco_core_n')).toBe(true)
    expect(purchaseTech(s, 'eco_core_n')).toBe(true)
    expect(nodeLevel(s, 'eco_core_n')).toBe(1)
  })

  it('stops exactly at maxLevel', () => {
    const s = richState()
    let bought = 0
    while (purchaseTech(s, 'eco_root')) bought++
    expect(bought).toBe(TECH_NODES.eco_root.maxLevel)
    expect(nodeLevel(s, 'eco_root')).toBe(TECH_NODES.eco_root.maxLevel)
    expect(canPurchaseTech(s, 'eco_root').reason).toBe('Poziom maksymalny')
  })
})

describe('techLayout', () => {
  it('places every node at a finite position', () => {
    const pos = layoutTree()
    expect(Object.keys(pos).length).toBe(TECH_NODE_IDS.length)
    for (const id of TECH_NODE_IDS) {
      const p = pos[id]
      expect(p).toBeDefined()
      expect(Number.isFinite(p.x)).toBe(true)
      expect(Number.isFinite(p.y)).toBe(true)
    }
  })

  it('keeps nodes apart (no gross overlap)', () => {
    const pos = layoutTree()
    let minDist = Infinity
    for (let i = 0; i < TECH_NODE_IDS.length; i++) {
      for (let j = i + 1; j < TECH_NODE_IDS.length; j++) {
        const a = pos[TECH_NODE_IDS[i]]
        const b = pos[TECH_NODE_IDS[j]]
        minDist = Math.min(minDist, Math.hypot(a.x - b.x, a.y - b.y))
      }
    }
    expect(minDist).toBeGreaterThan(40)
  })

  it('emits one edge per (prerequisite -> node) pair', () => {
    const edges = techEdges()
    let expected = 0
    for (const id of TECH_NODE_IDS) expected += TECH_NODES[id].prerequisites.length
    expect(edges.length).toBe(expected)
    for (const e of edges) {
      expect(TECH_NODES[e.from]).toBeDefined()
      expect(TECH_NODES[e.to]).toBeDefined()
      expect(TECH_NODES[e.to].prerequisites).toContain(e.from)
    }
  })
})
