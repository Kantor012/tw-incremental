import { describe, it, expect } from 'vitest'
import { D } from '../src/engine/decimal'
import { RNG } from '../src/engine/rng'
import {
  createInitialState,
  createVillage,
  NO_TECH_MODS,
  RESOURCE_IDS,
  EVENT_INTERVAL,
  type GameState,
} from '../src/engine/state'
import {
  prestigeScore,
  pendingPrestigePoints,
  aggregatePrestigeMods,
  effectiveMods,
  startResourceBonus,
  prestigeNodeLevel,
  prestigeNodeAvailable,
  prestigeNodeCost,
  canPurchasePrestige,
  purchasePrestige,
  ascend,
  prestigeHasCycle,
  orphanPrestigeNodes,
  deadPrestigeNodes,
  PP_SCALE,
} from '../src/systems/prestige'
import { aggregateTechMods } from '../src/systems/tech'
import { PRESTIGE_NODES, PRESTIGE_NODE_IDS, PRESTIGE_ROOTS } from '../src/content/prestige'
import { layoutNodes, nodeEdges } from '../src/systems/techLayout'
import { generateWorld } from '../src/systems/world'
import { validateState } from '../src/engine/save'

/**
 * M4.1 — the PERMANENT prestige (ascension) layer. These tests pin the contract of the
 * data-driven engine (systems/prestige.ts), the pure DATA catalogue (content/prestige.ts)
 * and the prestige tree's reuse of the generic radial layout (systems/techLayout.ts):
 *  - static topology is a healthy DAG (no cycles/orphans/dead perks, sane archetype bands);
 *  - prestigeScore / pendingPrestigePoints grow with progress and follow the sqrt PP curve;
 *  - aggregatePrestigeMods folds the right (global, permanent) multipliers and skips the
 *    prestige-only start_resources kind; effectiveMods COMBINES tech × prestige (multipliers
 *    multiply, fractions add+clamp);
 *  - purchasePrestige spends PP, bumps the level and re-derives every village so the
 *    permanent multiplier bites; canPurchasePrestige rejects unknown/maxed/locked/unaffordable;
 *  - ascend banks the pending PP, resets the run deterministically (one capital, cleared
 *    tech/log, regenerated world) while the prestige ACCOUNT survives, applies the
 *    start_resources head-start, and always leaves a VALID, playable state.
 *
 * The economy is on Decimal, but TechModifiers fields are plain numbers; float comparisons
 * use toBeCloseTo, exact Decimal results compare via toString().
 */

/** A fresh run with a huge banked PP balance so any node is affordable. */
function richPrestige(): GameState {
  const s = createInitialState('prestige-test', 0)
  s.prestige.points = 1_000_000
  return s
}

/** Numeric value of a Decimal field (for toBeCloseTo on multiplied economy stats). */
function num(d: { toString(): string }): number {
  return Number(d.toString())
}

describe('prestige catalogue (static topology invariants)', () => {
  it('PRESTIGE_NODE_IDS mirrors the catalogue keys in source order', () => {
    expect(PRESTIGE_NODE_IDS).toEqual(Object.keys(PRESTIGE_NODES))
    // The contract sizes the full tree at ~24-36 nodes; pin the floor so a trim is caught.
    expect(PRESTIGE_NODE_IDS.length).toBeGreaterThanOrEqual(24)
  })

  it('spans exactly the three prestige branches', () => {
    const cats = new Set(PRESTIGE_NODE_IDS.map((id) => PRESTIGE_NODES[id].category))
    expect(cats).toEqual(new Set(['might', 'prosperity', 'dominion']))
  })

  it('the prerequisite graph is an acyclic DAG', () => {
    expect(prestigeHasCycle()).toBe(false)
  })

  it('every node is reachable from a root (no orphans)', () => {
    expect(orphanPrestigeNodes()).toEqual([])
  })

  it('every node has a real effect (no dead perks, perLevel > 0)', () => {
    expect(deadPrestigeNodes()).toEqual([])
    for (const id of PRESTIGE_NODE_IDS) {
      expect(PRESTIGE_NODES[id].effect.perLevel).toBeGreaterThan(0)
    }
  })

  it('every maxLevel is in 1..10 and matches its archetype band', () => {
    for (const id of PRESTIGE_NODE_IDS) {
      const n = PRESTIGE_NODES[id]
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

  it('PRESTIGE_ROOTS are exactly the no-prerequisite nodes, one per category', () => {
    for (const id of PRESTIGE_ROOTS) {
      expect(PRESTIGE_NODES[id].prerequisites).toEqual([])
    }
    const fromData = PRESTIGE_NODE_IDS.filter((id) => PRESTIGE_NODES[id].prerequisites.length === 0)
    expect([...PRESTIGE_ROOTS].sort()).toEqual(fromData.sort())
    const cats = PRESTIGE_ROOTS.map((id) => PRESTIGE_NODES[id].category)
    expect(new Set(cats)).toEqual(new Set(['might', 'prosperity', 'dominion']))
    // one-per-category ⇒ no duplicate categories among the roots.
    expect(cats.length).toBe(new Set(cats).size)
    expect(PRESTIGE_ROOTS.length).toBe(3)
  })

  it('every prerequisite id points at a real node', () => {
    for (const id of PRESTIGE_NODE_IDS) {
      for (const pre of PRESTIGE_NODES[id].prerequisites) {
        expect(PRESTIGE_NODES[pre]).toBeDefined()
      }
    }
  })

  it('every node has a positive PP baseCost and a costFactor >= 1', () => {
    for (const id of PRESTIGE_NODE_IDS) {
      const n = PRESTIGE_NODES[id]
      expect(n.baseCost).toBeGreaterThan(0)
      expect(n.costFactor).toBeGreaterThanOrEqual(1)
    }
  })
})

describe('prestigeNodeLevel', () => {
  it('is 0 for an unbought node and reads the stored level otherwise', () => {
    const s = richPrestige()
    expect(prestigeNodeLevel(s, 'might_root')).toBe(0)
    s.prestige.nodes.might_root = 3
    expect(prestigeNodeLevel(s, 'might_root')).toBe(3)
  })

  it('treats a non-positive / non-finite stored value as 0', () => {
    const s = richPrestige()
    s.prestige.nodes.might_root = 0
    expect(prestigeNodeLevel(s, 'might_root')).toBe(0)
    s.prestige.nodes.might_root = -2
    expect(prestigeNodeLevel(s, 'might_root')).toBe(0)
    s.prestige.nodes.might_root = Number.NaN
    expect(prestigeNodeLevel(s, 'might_root')).toBe(0)
  })
})

describe('prestigeNodeCost', () => {
  it('equals ceil(baseCost * costFactor^level), rounded up', () => {
    // might_root: baseCost 1, costFactor 1.5.
    expect(prestigeNodeCost('might_root', 0)).toBe(1) // ceil(1)
    expect(prestigeNodeCost('might_root', 1)).toBe(2) // ceil(1.5)
    expect(prestigeNodeCost('might_root', 2)).toBe(3) // ceil(2.25)
  })

  it('grows geometrically with the owned level', () => {
    const at0 = prestigeNodeCost('might_def_n', 0)
    const at1 = prestigeNodeCost('might_def_n', 1)
    const at2 = prestigeNodeCost('might_def_n', 2)
    expect(at1).toBeGreaterThan(at0)
    expect(at2).toBeGreaterThan(at1)
  })

  it('is 0 for an unknown node', () => {
    expect(prestigeNodeCost('does_not_exist', 0)).toBe(0)
  })
})

describe('prestigeNodeAvailable', () => {
  it('a root is available from the start', () => {
    const s = richPrestige()
    expect(prestigeNodeAvailable(s, 'might_root')).toBe(true)
  })

  it('a child is locked until its prerequisite reaches level 1', () => {
    const s = richPrestige()
    expect(prestigeNodeAvailable(s, 'might_core_m1')).toBe(false)
    s.prestige.nodes.might_root = 1
    expect(prestigeNodeAvailable(s, 'might_core_m1')).toBe(true)
  })

  it('a maxed node is no longer available even with prerequisites met', () => {
    const s = richPrestige()
    s.prestige.nodes.might_root = PRESTIGE_NODES.might_root.maxLevel
    expect(prestigeNodeAvailable(s, 'might_root')).toBe(false)
  })

  it('an unknown node is never available', () => {
    const s = richPrestige()
    expect(prestigeNodeAvailable(s, 'does_not_exist')).toBe(false)
  })
})

describe('aggregatePrestigeMods', () => {
  it('is the identity (all 1 / 0) for an empty tree, equal to NO_TECH_MODS', () => {
    expect(aggregatePrestigeMods({})).toEqual(NO_TECH_MODS)
  })

  it('folds an all-resource production_mult into every resource', () => {
    // prosperity_root: production_mult perLevel 0.05 → 1 + 0.05*2 = 1.10 (all resources).
    const mods = aggregatePrestigeMods({ prosperity_root: 2 })
    expect(mods.productionMult.wood).toBeCloseTo(1.1, 9)
    expect(mods.productionMult.clay).toBeCloseTo(1.1, 9)
    expect(mods.productionMult.iron).toBeCloseTo(1.1, 9)
    expect(mods.storageMult).toBe(1)
    expect(mods.popMult).toBe(1)
  })

  it('folds storage_mult and pop_mult', () => {
    expect(aggregatePrestigeMods({ prosperity_core_m2: 3 }).storageMult).toBeCloseTo(1.06, 9)
    expect(aggregatePrestigeMods({ prosperity_growth_n: 2 }).popMult).toBeCloseTo(1.16, 9)
  })

  it('folds the cost / recruit / march reductions into clamped fractions', () => {
    expect(aggregatePrestigeMods({ prosperity_craft_n: 2 }).costReduction).toBeCloseTo(0.05, 9)
    expect(aggregatePrestigeMods({ prosperity_craft_m1: 3 }).recruitSpeedFrac).toBeCloseTo(0.036, 9)
    expect(aggregatePrestigeMods({ dominion_root: 3 }).marchSpeedFrac).toBeCloseTo(0.06, 9)
  })

  it('folds attack / defense / loot into 1 + Σ multipliers', () => {
    expect(aggregatePrestigeMods({ might_root: 2 }).attackMult).toBeCloseTo(1.1, 9)
    expect(aggregatePrestigeMods({ might_def_n: 2 }).defenseMult).toBeCloseTo(1.16, 9)
    expect(aggregatePrestigeMods({ might_loot_n: 2 }).lootMult).toBeCloseTo(1.16, 9)
    // each multiplier leaves the other two at identity.
    const atk = aggregatePrestigeMods({ might_root: 2 })
    expect(atk.defenseMult).toBe(1)
    expect(atk.lootMult).toBe(1)
  })

  it('clamps the fractional reductions (cost 0.9, recruit/march 0.75)', () => {
    expect(aggregatePrestigeMods({ prosperity_craft_n: 1000 }).costReduction).toBe(0.9)
    expect(aggregatePrestigeMods({ prosperity_craft_m1: 1000 }).recruitSpeedFrac).toBe(0.75)
    expect(aggregatePrestigeMods({ dominion_root: 1000 }).marchSpeedFrac).toBe(0.75)
  })

  it('never folds the prestige-only start_resources kind into a multiplier', () => {
    // dominion_supply_n is a start_resources notable — it must not perturb any multiplier.
    expect(aggregatePrestigeMods({ dominion_supply_n: 3 })).toEqual(NO_TECH_MODS)
  })

  it('ignores unknown / zeroed / non-finite keys (robust + deterministic)', () => {
    expect(
      aggregatePrestigeMods({ phantom: 5, might_root: 0, prosperity_root: Number.NaN }),
    ).toEqual(NO_TECH_MODS)
  })
})

describe('effectiveMods (tech × prestige)', () => {
  it('is the identity for a fresh state (empty tech + empty prestige)', () => {
    expect(effectiveMods(createInitialState('eff-id', 0))).toEqual(NO_TECH_MODS)
  })

  it('MULTIPLIES the multiplier kinds across the two trees', () => {
    const s = createInitialState('eff-mul', 0)
    s.tech = { eco_root: 1 } // production_mult +0.02 → 1.02
    s.prestige.nodes = { prosperity_root: 2 } // production_mult +0.05*2 → 1.10
    const mods = effectiveMods(s)
    expect(mods.productionMult.wood).toBeCloseTo(1.02 * 1.1, 9)
    expect(mods.productionMult.clay).toBeCloseTo(1.02 * 1.1, 9)
    expect(mods.productionMult.iron).toBeCloseTo(1.02 * 1.1, 9)
  })

  it('ADDS the fractional reductions across the two trees', () => {
    const s = createInitialState('eff-add', 0)
    s.tech = { con_root: 4 } // cost_reduction 0.005*4 = 0.02
    s.prestige.nodes = { prosperity_craft_n: 2 } // cost_reduction 0.025*2 = 0.05
    expect(effectiveMods(s).costReduction).toBeCloseTo(0.07, 9)
  })

  it('re-clamps the combined fractions (cost cap 0.9) after adding both trees', () => {
    const s = createInitialState('eff-clamp', 0)
    // Each side clamps to its own cap first (tech 0.8, prestige 0.9), then combine
    // adds and re-clamps to 0.9 — never letting the two trees make builds free.
    s.tech = { con_core_n: 1000 }
    s.prestige.nodes = { prosperity_craft_n: 1000 }
    expect(effectiveMods(s).costReduction).toBe(0.9)
  })

  it('matches combine(aggregateTechMods, aggregatePrestigeMods) field for field', () => {
    const s = createInitialState('eff-combine', 0)
    s.tech = { mil_root: 2 } // attack
    s.prestige.nodes = { might_root: 2 } // attack
    const mods = effectiveMods(s)
    const expected =
      aggregateTechMods(s.tech).attackMult * aggregatePrestigeMods(s.prestige.nodes).attackMult
    expect(mods.attackMult).toBeCloseTo(expected, 9)
  })
})

describe('startResourceBonus', () => {
  it('is 0 when no start_resources node is owned (multiplier nodes contribute nothing)', () => {
    const s = createInitialState('srb-zero', 0)
    expect(startResourceBonus(s)).toBe(0)
    s.prestige.nodes = { prosperity_root: 3, might_root: 2 }
    expect(startResourceBonus(s)).toBe(0)
  })

  it('sums perLevel * level over every start_resources node', () => {
    const s = createInitialState('srb-sum', 0)
    // dominion_supply_n: 120/level, dominion_supply_m1: 25/level.
    s.prestige.nodes = { dominion_supply_n: 2, dominion_supply_m1: 3 }
    expect(startResourceBonus(s)).toBe(120 * 2 + 25 * 3)
  })
})

describe('prestigeScore', () => {
  it('is a deterministic, non-negative integer >= villageCount * 8', () => {
    const a = prestigeScore(createInitialState('score-det', 0))
    const b = prestigeScore(createInitialState('score-det', 0))
    expect(a).toBe(b)
    expect(Number.isInteger(a)).toBe(true)
    expect(a).toBeGreaterThanOrEqual(1 * 8)
  })

  it('grows with building levels and tech levels', () => {
    const s = createInitialState('score-grow', 0)
    const base = prestigeScore(s)
    s.villages.v0.buildings.sawmill += 5
    expect(prestigeScore(s)).toBe(base + 5)
    s.tech.eco_root = 3
    expect(prestigeScore(s)).toBe(base + 5 + 3)
  })

  it('rewards a new village by at least the per-village weight (8)', () => {
    const s = createInitialState('score-village', 0)
    const base = prestigeScore(s)
    const v1 = createVillage('v1', 'Druga', 10, 10)
    s.villages.v1 = v1
    s.villageOrder.push('v1')
    expect(prestigeScore(s)).toBeGreaterThanOrEqual(base + 8)
  })
})

describe('pendingPrestigePoints', () => {
  it('equals floor(sqrt(prestigeScore) * PP_SCALE)', () => {
    const s = createInitialState('pend-formula', 0)
    const expected = Math.floor(Math.sqrt(prestigeScore(s)) * PP_SCALE)
    expect(pendingPrestigePoints(s)).toBe(expected)
    expect(pendingPrestigePoints(s)).toBeGreaterThanOrEqual(0)
  })

  it('grows (weakly, sub-linearly) as the run progresses', () => {
    const s = createInitialState('pend-grow', 0)
    const before = pendingPrestigePoints(s)
    // Big jump in raw progress → strictly more PP, but the sqrt keeps it sub-linear.
    s.villages.v0.buildings.sawmill = 30
    s.villages.v0.buildings.warehouse = 30
    const after = pendingPrestigePoints(s)
    expect(after).toBeGreaterThan(before)
  })

  it('is 0 for a degenerate zero-progress state', () => {
    const empty = {
      seed: 'empty',
      villageOrder: [],
      villages: {},
      tech: {},
      prestige: { points: 0, totalEarned: 0, ascensions: 0, nodes: {} },
    } as unknown as GameState
    expect(prestigeScore(empty)).toBe(0)
    expect(pendingPrestigePoints(empty)).toBe(0)
  })
})

describe('canPurchasePrestige', () => {
  it('rejects an unknown node', () => {
    const s = richPrestige()
    const res = canPurchasePrestige(s, 'no_such_node')
    expect(res.ok).toBe(false)
    expect(res.reason).toBe('Nieznany węzeł')
  })

  it('rejects a locked node (prerequisites unmet) even when affordable', () => {
    const s = richPrestige() // plenty of PP, but might_root not yet owned
    const res = canPurchasePrestige(s, 'might_core_m1')
    expect(res.ok).toBe(false)
    expect(res.reason).toBe('Wymagania niespełnione')
  })

  it('rejects a maxed node', () => {
    const s = richPrestige()
    s.prestige.nodes.might_root = PRESTIGE_NODES.might_root.maxLevel
    const res = canPurchasePrestige(s, 'might_root')
    expect(res.ok).toBe(false)
    expect(res.reason).toBe('Poziom maksymalny')
  })

  it('rejects when the banked PP cannot cover the cost', () => {
    const s = createInitialState('prestige-poor', 0) // points start at 0
    const res = canPurchasePrestige(s, 'might_root')
    expect(res.ok).toBe(false)
    expect(res.reason).toBe('Za mało punktów prestiżu')
  })

  it('accepts an available, affordable, unmaxed node (no reason)', () => {
    const s = richPrestige()
    const res = canPurchasePrestige(s, 'might_root')
    expect(res.ok).toBe(true)
    expect(res.reason).toBeUndefined()
  })
})

describe('purchasePrestige', () => {
  it('raises the level, spends the exact PP, and re-derives production', () => {
    const s = richPrestige()
    const cost = prestigeNodeCost('prosperity_root', 0)
    const beforePoints = s.prestige.points
    const beforeProd = num(s.villages.v0.production.wood)

    const ok = purchasePrestige(s, 'prosperity_root')

    expect(ok).toBe(true)
    expect(s.prestige.nodes.prosperity_root).toBe(1)
    expect(s.prestige.points).toBe(beforePoints - cost)
    // production_mult +0.05 (all resources) folded by recomputeDerived (via effectiveMods).
    expect(s.villages.v0.production.wood.gt(D(beforeProd))).toBe(true)
    expect(num(s.villages.v0.production.wood)).toBeCloseTo(beforeProd * 1.05, 9)
  })

  it('lifts the storage and population caps after the matching purchases', () => {
    const s = richPrestige()
    purchasePrestige(s, 'prosperity_root') // unlocks the cluster children
    const beforeStorage = num(s.villages.v0.storageCap)
    const beforePop = num(s.villages.v0.popCap)

    expect(purchasePrestige(s, 'prosperity_core_m2')).toBe(true) // storage_mult +0.02
    expect(purchasePrestige(s, 'prosperity_growth_n')).toBe(true) // pop_mult +0.08
    expect(num(s.villages.v0.storageCap)).toBeCloseTo(beforeStorage * 1.02, 6)
    expect(num(s.villages.v0.popCap)).toBeCloseTo(beforePop * 1.08, 6)
  })

  it('returns false and mutates nothing when unaffordable', () => {
    const s = createInitialState('prestige-noop', 0) // 0 PP, might_root costs 1
    expect(purchasePrestige(s, 'might_root')).toBe(false)
    expect(prestigeNodeLevel(s, 'might_root')).toBe(0)
    expect(s.prestige.points).toBe(0)
  })

  it('returns false for a locked node and leaves the tree untouched', () => {
    const s = richPrestige()
    expect(purchasePrestige(s, 'might_core_m1')).toBe(false)
    expect(prestigeNodeLevel(s, 'might_core_m1')).toBe(0)
  })

  it('unlocks a child node once its prerequisite is bought', () => {
    const s = richPrestige()
    expect(prestigeNodeAvailable(s, 'might_core_m1')).toBe(false)
    expect(purchasePrestige(s, 'might_root')).toBe(true)
    expect(prestigeNodeAvailable(s, 'might_core_m1')).toBe(true)
    expect(purchasePrestige(s, 'might_core_m1')).toBe(true)
    expect(prestigeNodeLevel(s, 'might_core_m1')).toBe(1)
  })

  it('stops exactly at maxLevel', () => {
    const s = richPrestige()
    let bought = 0
    while (purchasePrestige(s, 'might_root')) bought++
    expect(bought).toBe(PRESTIGE_NODES.might_root.maxLevel)
    expect(prestigeNodeLevel(s, 'might_root')).toBe(PRESTIGE_NODES.might_root.maxLevel)
    expect(canPurchasePrestige(s, 'might_root').reason).toBe('Poziom maksymalny')
  })
})

describe('ascend', () => {
  it('is a no-op (returns 0, mutates nothing) on a zero-progress state', () => {
    const empty = {
      seed: 'empty',
      villageOrder: [],
      villages: {},
      tech: {},
      prestige: { points: 5, totalEarned: 5, ascensions: 1, nodes: {} },
    } as unknown as GameState
    expect(ascend(empty)).toBe(0)
    // Nothing was banked or reset.
    expect(empty.prestige.points).toBe(5)
    expect(empty.prestige.ascensions).toBe(1)
    expect(Object.keys(empty.villages)).toEqual([])
  })

  it('banks the pending PP and resets the run while the account survives', () => {
    const s = createInitialState('ascend-bank', 0)
    const pending = pendingPrestigePoints(s)
    expect(pending).toBeGreaterThan(0)

    const pp = ascend(s)

    // Banked: returns the pending PP and credits points / totalEarned / ascensions.
    expect(pp).toBe(pending)
    expect(s.prestige.points).toBe(pending)
    expect(s.prestige.totalEarned).toBe(pending)
    expect(s.prestige.ascensions).toBe(1)

    // The run is reset: one fresh capital, cleared tech + battle log, a regenerated world.
    expect(s.villageOrder).toEqual(['v0'])
    expect(Object.keys(s.villages)).toEqual(['v0'])
    expect(s.villages.v0.name).toBe('Stolica')
    expect(s.tech).toEqual({})
    expect(s.battleLog).toEqual([])
    expect(s.world.barbarians.length).toBeGreaterThan(0)

    // The reset state is fully valid and immediately playable (no softlock / corruption).
    expect(validateState(s)).toBe(s)
  })

  it('preserves the prestige nodes / banked points across the reset', () => {
    const s = createInitialState('ascend-preserve', 0)
    s.prestige.points = 100
    expect(purchasePrestige(s, 'prosperity_root')).toBe(true) // costs 1 → points 99
    const afterBuy = s.prestige.points // 99
    const pending = pendingPrestigePoints(s)

    ascend(s)

    // The purchased node survives the reset, and the leftover PP plus the new pending
    // are both banked (nothing about the prestige account is wiped).
    expect(s.prestige.nodes).toEqual({ prosperity_root: 1 })
    expect(s.prestige.points).toBe(afterBuy + pending)
    expect(s.prestige.ascensions).toBe(1)
  })

  it('regenerates the world deterministically from the per-ascension seed', () => {
    const a = createInitialState('ascend-det', 0)
    const b = createInitialState('ascend-det', 0)
    ascend(a)
    ascend(b)
    // Same base seed → byte-identical regenerated world + rng stream (no clock/random).
    expect(a.world).toEqual(b.world)
    expect(a.rngState).toBe(b.rngState)
    // The world is exactly the one generated from `seed + ':asc' + ascensions`.
    expect(a.world).toEqual(generateWorld('ascend-det:asc1'))
  })

  it('applies the permanent start_resources head-start to the new capital', () => {
    const s = createInitialState('ascend-supply', 0)
    s.prestige.points = 1000
    expect(purchasePrestige(s, 'dominion_root')).toBe(true) // prerequisite
    expect(purchasePrestige(s, 'dominion_supply_n')).toBe(true) // start_resources 120/level
    const bonus = startResourceBonus(s)
    expect(bonus).toBe(120)

    ascend(s)

    // A fresh capital starts at 50 of each; the prestige head-start adds the bonus on top.
    for (const r of RESOURCE_IDS) {
      expect(s.villages.v0.resources[r].toString()).toBe(String(50 + bonus))
    }
    expect(validateState(s)).toBe(s)
  })

  it('the surviving prestige multipliers lift the post-ascension starting economy', () => {
    const s = createInitialState('ascend-head', 0)
    s.prestige.points = 1000
    expect(purchasePrestige(s, 'prosperity_root')).toBe(true) // production_mult +0.05

    ascend(s)

    // After the reset the capital's buildings are the fresh footprint again, so its base
    // production equals a zero-prestige fresh capital's — but the SURVIVING prestige
    // multiplier folds back in via recomputeDerived, so production is strictly higher.
    const baseline = createInitialState('ascend-head', 0) // zero prestige, fresh footprint
    const expectedWood = baseline.villages.v0.production.wood.mul(
      effectiveMods(s).productionMult.wood,
    )
    expect(s.villages.v0.production.wood.toString()).toBe(expectedWood.toString())
    expect(s.villages.v0.production.wood.gt(baseline.villages.v0.production.wood)).toBe(true)
  })

  it('can be performed repeatedly, each reset staying valid', () => {
    const s = createInitialState('ascend-loop', 0)
    for (let i = 1; i <= 3; i++) {
      const pp = ascend(s)
      expect(pp).toBeGreaterThan(0)
      expect(s.prestige.ascensions).toBe(i)
      expect(validateState(s)).toBe(s)
      expect(s.world.barbarians.length).toBeGreaterThan(0)
    }
    // Lifetime total is the running sum; never less than the current balance.
    expect(s.prestige.totalEarned).toBeGreaterThanOrEqual(s.prestige.points)
  })

  it('re-seeds the world-events schedule from the per-ascension seed (M13 — no stale offer survives)', () => {
    const s = createInitialState('ascend-events', 0)
    // Simulate a run that had a watchtower: a stale ACTIVE offer plus an advanced events
    // RNG stream and a mid-cycle timer that MUST NOT leak across the reset.
    s.events = { rngState: 123456789, timer: 7, active: { defId: 'karawana', ttl: 42, roll: 0.5 }, buff: null }

    ascend(s)

    // The events schedule is reset to a fresh, idle clock — no stale offer, timer re-armed.
    expect(s.events.active).toBeNull()
    expect(s.events.timer).toBe(EVENT_INTERVAL)
    // ...and its RNG stream is reproducible from THIS ascension's own seed (ascensions === 1),
    // exactly like the combat stream — the events stream is no longer the lone non-reproducible
    // source of randomness after a reset.
    expect(s.events.rngState).toBe(RNG.fromString('ascend-events:asc1' + '::events').getState())
  })
})

describe('prestige tree layout (generic radial placement)', () => {
  it('places every node at a finite position', () => {
    const pos = layoutNodes(PRESTIGE_NODES, PRESTIGE_NODE_IDS)
    expect(Object.keys(pos).length).toBe(PRESTIGE_NODE_IDS.length)
    for (const id of PRESTIGE_NODE_IDS) {
      const p = pos[id]
      expect(p).toBeDefined()
      expect(Number.isFinite(p.x)).toBe(true)
      expect(Number.isFinite(p.y)).toBe(true)
    }
  })

  it('keeps nodes apart (no gross overlap)', () => {
    const pos = layoutNodes(PRESTIGE_NODES, PRESTIGE_NODE_IDS)
    let minDist = Infinity
    for (let i = 0; i < PRESTIGE_NODE_IDS.length; i++) {
      for (let j = i + 1; j < PRESTIGE_NODE_IDS.length; j++) {
        const a = pos[PRESTIGE_NODE_IDS[i]]
        const b = pos[PRESTIGE_NODE_IDS[j]]
        minDist = Math.min(minDist, Math.hypot(a.x - b.x, a.y - b.y))
      }
    }
    expect(minDist).toBeGreaterThan(40)
  })

  it('emits one edge per (prerequisite -> node) pair', () => {
    const edges = nodeEdges(PRESTIGE_NODES, PRESTIGE_NODE_IDS)
    let expected = 0
    for (const id of PRESTIGE_NODE_IDS) expected += PRESTIGE_NODES[id].prerequisites.length
    expect(edges.length).toBe(expected)
    for (const e of edges) {
      expect(PRESTIGE_NODES[e.from]).toBeDefined()
      expect(PRESTIGE_NODES[e.to]).toBeDefined()
      expect(PRESTIGE_NODES[e.to].prerequisites).toContain(e.from)
    }
  })
})
