import { describe, it, expect } from 'vitest'
import { RNG } from '../src/engine/rng'
import {
  createInitialState,
  NO_TECH_MODS,
  RESOURCE_IDS,
  EVENT_INTERVAL,
  type GameState,
} from '../src/engine/state'
import {
  aggregateEraMods,
  eraPpMult,
  eraStartResourceBonus,
  eraScore,
  pendingEraPoints,
  eraNodeLevel,
  eraNodeAvailable,
  eraNodeCost,
  canPurchaseEra,
  purchaseEra,
  newEra,
  eraHasCycle,
  orphanEraNodes,
  deadEraNodes,
  EP_SCALE,
  ERA_ASC_WEIGHT,
} from '../src/systems/era'
import {
  effectiveMods,
  pendingPrestigePoints,
  prestigeScore,
  PP_SCALE,
} from '../src/systems/prestige'
import { aggregateTechMods } from '../src/systems/tech'
import { ERA_NODES, ERA_NODE_IDS, ERA_ROOTS } from '../src/content/era'
import { PRESTIGE_NODE_IDS } from '../src/content/prestige'
import { generateWorld } from '../src/systems/world'
import { exportSave, validateState } from '../src/engine/save'

/**
 * M6.1 — the SECOND meta-layer, the ERA (great reset) above prestige/ascension. These
 * tests pin the contract of the data-driven engine (systems/era.ts), the pure DATA
 * catalogue (content/era.ts) and the era layer's interplay with prestige:
 *  - static topology is a healthy DAG (no cycles/orphans/dead perks) with the three FIXED
 *    roots (eternity/pantheon/legacy, one per category, stable effect kinds);
 *  - aggregateEraMods({}) IS the identity bag, so a no-era save's effectiveMods is byte-
 *    identical to the pre-M6.1 (tech × prestige) fold; a multiplier node folds correctly;
 *  - eraScore / pendingEraPoints follow the CUBE-ROOT curve (rarer than PP's sqrt) and are
 *    monotonic + floored; the signature eraPpMult rises after a pp_mult root and scales
 *    pendingPrestigePoints;
 *  - purchaseEra spends EP, bumps the level and re-derives every village; canPurchaseEra
 *    rejects unknown/maxed/locked/unaffordable with the right Polish reason;
 *  - newEra is the GREAT RESET: a no-op at zero score, else it banks EP, WIPES the entire
 *    prestige account, regenerates the run deterministically (same seed → identical world +
 *    rngState), preserves the era account + lifetime stats, and applies the era
 *    start_resources head-start — always leaving a VALID, playable state.
 *
 * Era nodes are referenced GENERICALLY — the three FIXED roots and the catalogue's own
 * data (effect.kind / perLevel / maxLevel) — never a deep cluster id, so a content rename
 * cannot rot these tests.
 */

/** A fresh run with a huge banked EP balance so any era node is affordable. */
function richEra(seed = 'era-rich'): GameState {
  const s = createInitialState(seed, 0)
  s.era.points = 1_000_000
  return s
}

/**
 * A fresh run carrying enough prestige progress that a Nowa Era banks a positive EP yield
 * (eraScore = totalEarned + ascensions*ERA_ASC_WEIGHT + Σ prestige node levels > 0).
 */
function readyForEra(seed = 'era-reset'): GameState {
  const s = createInitialState(seed, 0)
  s.prestige = { points: 40, totalEarned: 300, ascensions: 5, nodes: {} }
  return s
}

/** Numeric value of a Decimal field (for toBeCloseTo on multiplied economy stats). */
function num(d: { toString(): string }): number {
  return Number(d.toString())
}

describe('era catalogue (static topology invariants)', () => {
  it('ERA_NODE_IDS mirrors the catalogue keys in source order', () => {
    expect(ERA_NODE_IDS).toEqual(Object.keys(ERA_NODES))
    expect(ERA_NODE_IDS.length).toBeGreaterThanOrEqual(3)
  })

  it('the three FIXED roots are the no-prereq nodes, one per category, with stable effect kinds', () => {
    // The contract pins exactly these ids + effect kinds — other phases depend on them.
    expect([...ERA_ROOTS].sort()).toEqual(['eternity_root', 'legacy_root', 'pantheon_root'])
    const fromData = ERA_NODE_IDS.filter((id) => ERA_NODES[id].prerequisites.length === 0)
    expect([...ERA_ROOTS].sort()).toEqual(fromData.sort())
    expect(ERA_NODES.eternity_root.prerequisites).toEqual([])
    expect(ERA_NODES.pantheon_root.prerequisites).toEqual([])
    expect(ERA_NODES.legacy_root.prerequisites).toEqual([])
    expect(ERA_NODES.eternity_root.effect.kind).toBe('production_mult')
    expect(ERA_NODES.pantheon_root.effect.kind).toBe('attack_mult')
    expect(ERA_NODES.legacy_root.effect.kind).toBe('pp_mult')
    const cats = ERA_ROOTS.map((id) => ERA_NODES[id].category)
    expect(new Set(cats)).toEqual(new Set(['eternity', 'pantheon', 'legacy']))
  })

  it('is a healthy DAG: no cycles, no orphans, no dead perks (every perLevel > 0)', () => {
    expect(eraHasCycle()).toBe(false)
    expect(orphanEraNodes()).toEqual([])
    expect(deadEraNodes()).toEqual([])
    for (const id of ERA_NODE_IDS) expect(ERA_NODES[id].effect.perLevel).toBeGreaterThan(0)
  })

  it('every prerequisite id points at a real node and every maxLevel is in 1..10', () => {
    for (const id of ERA_NODE_IDS) {
      for (const pre of ERA_NODES[id].prerequisites) expect(ERA_NODES[pre]).toBeDefined()
      expect(ERA_NODES[id].maxLevel).toBeGreaterThanOrEqual(1)
      expect(ERA_NODES[id].maxLevel).toBeLessThanOrEqual(10)
      expect(ERA_NODES[id].baseCost).toBeGreaterThan(0)
      expect(ERA_NODES[id].costFactor).toBeGreaterThanOrEqual(1)
    }
  })
})

describe('aggregateEraMods', () => {
  it('is the identity bag (all 1 / 0) for an empty tree, equal to NO_TECH_MODS', () => {
    expect(aggregateEraMods({})).toEqual(NO_TECH_MODS)
  })

  it('an empty era leaves effectiveMods byte-identical to the pre-M6.1 (tech × prestige) fold', () => {
    const s = createInitialState('era-identity', 0)
    s.tech = { eco_root: 3 } // a tech multiplier so the bag is non-trivial
    // With era present-but-empty, combine(x, identityBag) === x, so effectiveMods is just
    // the tech bag (prestige is empty too) — the M1-M5 balance targets stay byte-identical.
    expect(effectiveMods(s)).toEqual(aggregateTechMods(s.tech))
    // And dropping `era` entirely (defensive read → {}) yields the very same result.
    const noEra = createInitialState('era-identity', 0)
    noEra.tech = { eco_root: 3 }
    delete (noEra as { era?: unknown }).era
    expect(effectiveMods(noEra)).toEqual(effectiveMods(s))
  })

  it('folds a multiplier node into a 1 + Σ factor (production_mult on every resource)', () => {
    const node = ERA_NODES.eternity_root // FIXED root, production_mult
    expect(node.effect.kind).toBe('production_mult')
    const mods = aggregateEraMods({ eternity_root: 2 })
    const expected = 1 + node.effect.perLevel * 2
    expect(mods.productionMult.wood).toBeCloseTo(expected, 9)
    expect(mods.productionMult.clay).toBeCloseTo(expected, 9)
    expect(mods.productionMult.iron).toBeCloseTo(expected, 9)
    // a pure production node leaves the other axes at identity.
    expect(mods.storageMult).toBe(1)
    expect(mods.attackMult).toBe(1)
  })

  it('never folds the era-only start_resources / pp_mult kinds into a multiplier', () => {
    const startId = ERA_NODE_IDS.find((id) => ERA_NODES[id].effect.kind === 'start_resources')
    const ppId = ERA_NODE_IDS.find((id) => ERA_NODES[id].effect.kind === 'pp_mult')
    expect(startId).toBeDefined()
    expect(ppId).toBeDefined()
    // Neither is a multiplier — both must leave the whole bag at identity.
    expect(aggregateEraMods({ [startId as string]: 3 })).toEqual(NO_TECH_MODS)
    expect(aggregateEraMods({ [ppId as string]: 3 })).toEqual(NO_TECH_MODS)
  })

  it('ignores unknown / zeroed / non-finite keys (robust + deterministic)', () => {
    expect(
      aggregateEraMods({ phantom: 5, eternity_root: 0, legacy_root: Number.NaN }),
    ).toEqual(NO_TECH_MODS)
  })
})

describe('eraScore / pendingEraPoints (the cube-root EP curve)', () => {
  it('eraScore = totalEarned + ascensions*ERA_ASC_WEIGHT + Σ prestige node levels (points excluded)', () => {
    const s = createInitialState('era-score', 0)
    const baseId = PRESTIGE_NODE_IDS[0]
    // `points` must NOT count (only banked-lifetime progress drives the score).
    s.prestige = { points: 999, totalEarned: 40, ascensions: 3, nodes: { [baseId]: 2 } }
    expect(eraScore(s)).toBe(40 + 3 * ERA_ASC_WEIGHT + 2)
  })

  it('is order-independent and defensive (missing prestige scores 0)', () => {
    const a = createInitialState('era-det', 0)
    a.prestige = { points: 0, totalEarned: 123, ascensions: 4, nodes: {} }
    const b = createInitialState('era-det', 0)
    b.prestige = { points: 0, totalEarned: 123, ascensions: 4, nodes: {} }
    expect(eraScore(a)).toBe(eraScore(b))
    expect(eraScore({} as unknown as GameState)).toBe(0)
  })

  it('equals floor(cbrt(eraScore) * EP_SCALE), is 0 at zero score and monotonic non-decreasing', () => {
    const s = createInitialState('era-curve', 0)
    s.prestige = { points: 0, totalEarned: 0, ascensions: 0, nodes: {} }
    expect(eraScore(s)).toBe(0)
    expect(pendingEraPoints(s)).toBe(0)

    // The exact cube-root formula at several scores (floor absorbs any cbrt ULP).
    for (const total of [1, 8, 27, 100, 1000]) {
      s.prestige.totalEarned = total
      const score = eraScore(s)
      expect(score).toBe(total)
      expect(pendingEraPoints(s)).toBe(Math.floor(Math.cbrt(score) * EP_SCALE))
    }

    // Monotonic in raw progress (never decreases as the prestige account grows).
    let prev = -1
    for (let total = 0; total <= 3000; total += 50) {
      s.prestige.totalEarned = total
      const ep = pendingEraPoints(s)
      expect(ep).toBeGreaterThanOrEqual(prev)
      prev = ep
    }
  })

  it('the cube root makes EP rarer than the prestige sqrt at the same score', () => {
    const s = createInitialState('era-rarer', 0)
    s.prestige = { points: 0, totalEarned: 1000, ascensions: 0, nodes: {} }
    // cbrt(1000)=10 vs sqrt(1000)≈31 — EP is the scarce, top-tier currency.
    expect(pendingEraPoints(s)).toBeLessThan(Math.floor(Math.sqrt(eraScore(s))))
  })
})

describe('eraPpMult (the signature prestige-loop accelerator)', () => {
  it('is 1 with no era nodes and rises after buying a pp_mult root (legacy_root)', () => {
    const s = richEra('era-ppmult')
    expect(eraPpMult(s)).toBe(1)
    expect(ERA_NODES.legacy_root.effect.kind).toBe('pp_mult')

    expect(purchaseEra(s, 'legacy_root')).toBe(true) // level 1
    expect(eraPpMult(s)).toBeCloseTo(1 + ERA_NODES.legacy_root.effect.perLevel, 9)
    expect(eraPpMult(s)).toBeGreaterThan(1)
  })

  it('is defensive when state.era is missing (folds to 1)', () => {
    expect(eraPpMult({} as unknown as GameState)).toBe(1)
  })

  it('scales pendingPrestigePoints for a fixed prestige score', () => {
    const s = richEra('era-ppscale')
    // A sizeable, era-independent prestige score so the multiplier visibly bites.
    s.villages.v0.buildings.sawmill = 100
    const before = pendingPrestigePoints(s)

    expect(purchaseEra(s, 'legacy_root')).toBe(true)
    const mult = eraPpMult(s)
    const score = prestigeScore(s) // unchanged by an era purchase
    const after = pendingPrestigePoints(s)

    expect(after).toBe(Math.floor(Math.sqrt(score) * PP_SCALE * mult))
    expect(after).toBeGreaterThan(before)
  })
})

describe('eraStartResourceBonus', () => {
  it('is 0 with no start_resources node and sums perLevel * level over the start_resources nodes', () => {
    const s = createInitialState('era-srb', 0)
    expect(eraStartResourceBonus(s)).toBe(0)

    const startId = ERA_NODE_IDS.find((id) => ERA_NODES[id].effect.kind === 'start_resources')
    expect(startId).toBeDefined()
    s.era.nodes = { [startId as string]: 2 }
    expect(eraStartResourceBonus(s)).toBe(ERA_NODES[startId as string].effect.perLevel * 2)
  })

  it('is defensive when state.era is missing (folds to 0)', () => {
    expect(eraStartResourceBonus({} as unknown as GameState)).toBe(0)
  })
})

describe('eraNodeCost', () => {
  it('equals ceil(baseCost * costFactor^level) and is 0 for an unknown node', () => {
    const node = ERA_NODES.eternity_root
    expect(eraNodeCost('eternity_root', 0)).toBe(Math.ceil(node.baseCost))
    expect(eraNodeCost('eternity_root', 1)).toBe(Math.ceil(node.baseCost * node.costFactor))
    expect(eraNodeCost('does_not_exist', 0)).toBe(0)
  })
})

describe('eraNodeAvailable', () => {
  it('a root is available, a child is locked until its prerequisite reaches level 1', () => {
    const s = richEra('era-avail')
    expect(eraNodeAvailable(s, 'eternity_root')).toBe(true)
    const child = ERA_NODE_IDS.find((id) => ERA_NODES[id].prerequisites.includes('eternity_root'))
    expect(child).toBeDefined()
    expect(eraNodeAvailable(s, child as string)).toBe(false)
    expect(purchaseEra(s, 'eternity_root')).toBe(true)
    expect(eraNodeAvailable(s, child as string)).toBe(true)
  })

  it('a maxed node is no longer available; an unknown node is never available', () => {
    const s = richEra('era-avail2')
    s.era.nodes.eternity_root = ERA_NODES.eternity_root.maxLevel
    expect(eraNodeAvailable(s, 'eternity_root')).toBe(false)
    expect(eraNodeAvailable(s, 'does_not_exist')).toBe(false)
  })
})

describe('canPurchaseEra (Polish reasons)', () => {
  it('rejects an unknown node', () => {
    const s = richEra()
    expect(canPurchaseEra(s, 'no_such_node')).toEqual({ ok: false, reason: 'Nieznany węzeł' })
  })

  it('rejects a locked node (prerequisites unmet) even when affordable', () => {
    const s = richEra()
    const child = ERA_NODE_IDS.find((id) => ERA_NODES[id].prerequisites.length > 0)
    expect(child).toBeDefined()
    expect(canPurchaseEra(s, child as string)).toEqual({
      ok: false,
      reason: 'Wymagania niespełnione',
    })
  })

  it('rejects a maxed node', () => {
    const s = richEra()
    s.era.nodes.eternity_root = ERA_NODES.eternity_root.maxLevel
    expect(canPurchaseEra(s, 'eternity_root')).toEqual({ ok: false, reason: 'Poziom maksymalny' })
  })

  it('rejects when the banked EP cannot cover the cost', () => {
    const poor = createInitialState('era-poor', 0) // 0 EP, eternity_root costs >= 1
    expect(canPurchaseEra(poor, 'eternity_root')).toEqual({
      ok: false,
      reason: 'Za mało punktów ery',
    })
  })

  it('accepts an available, affordable, unmaxed node (no reason)', () => {
    const s = richEra()
    const res = canPurchaseEra(s, 'eternity_root')
    expect(res.ok).toBe(true)
    expect(res.reason).toBeUndefined()
  })
})

describe('purchaseEra', () => {
  it('raises the level, spends the exact EP and re-derives the economy (production_mult root)', () => {
    const s = richEra('era-buy')
    const node = ERA_NODES.eternity_root
    expect(node.effect.kind).toBe('production_mult')
    const cost = eraNodeCost('eternity_root', 0)
    const beforePoints = s.era.points
    const beforeProd = num(s.villages.v0.production.wood)

    expect(purchaseEra(s, 'eternity_root')).toBe(true)

    expect(eraNodeLevel(s, 'eternity_root')).toBe(1)
    expect(s.era.points).toBe(beforePoints - cost)
    // The permanent production multiplier folds into derived stats via recomputeDerived.
    expect(num(s.villages.v0.production.wood)).toBeCloseTo(beforeProd * (1 + node.effect.perLevel), 9)
  })

  it('returns false and mutates nothing when unaffordable', () => {
    const poor = createInitialState('era-noop', 0) // 0 EP
    expect(purchaseEra(poor, 'eternity_root')).toBe(false)
    expect(eraNodeLevel(poor, 'eternity_root')).toBe(0)
    expect(poor.era.points).toBe(0)
  })

  it('stops exactly at maxLevel', () => {
    const s = richEra('era-max')
    let bought = 0
    while (purchaseEra(s, 'eternity_root')) bought++
    expect(bought).toBe(ERA_NODES.eternity_root.maxLevel)
    expect(eraNodeLevel(s, 'eternity_root')).toBe(ERA_NODES.eternity_root.maxLevel)
    expect(canPurchaseEra(s, 'eternity_root').reason).toBe('Poziom maksymalny')
  })
})

describe('newEra (the great reset)', () => {
  it('is a no-op (returns 0, mutates nothing) at zero prestige score', () => {
    const s = createInitialState('era-zero', 0)
    // A non-trivial era account so we can prove the no-op touches nothing.
    s.era = { points: 11, totalEarned: 11, eras: 2, nodes: {} }
    expect(pendingEraPoints(s)).toBe(0)
    // Byte-for-byte snapshot: the ep<=0 path must mutate NOTHING — not just era /
    // villageOrder, but world, rngState, prestige, tech and the clock fields (createdAt /
    // lastSeen, the "no clock" promise) too. A single serialize() comparison covers them all.
    const before = exportSave(s)
    expect(newEra(s)).toBe(0)
    expect(exportSave(s)).toBe(before)
  })

  it('banks EP, WIPES the entire prestige account, and preserves the era account + lifetime stats', () => {
    const s = readyForEra('era-bank')
    // A pre-existing era balance + lifetime stats that must SURVIVE the reset.
    s.era = { points: 3, totalEarned: 3, eras: 1, nodes: {} }
    s.stats.attacksWon = 9
    const pending = pendingEraPoints(s)
    expect(pending).toBeGreaterThan(0)

    const ep = newEra(s)

    // Banked: returns the pending EP and credits points / totalEarned / eras on top.
    expect(ep).toBe(pending)
    expect(s.era.points).toBe(3 + ep)
    expect(s.era.totalEarned).toBe(3 + ep)
    expect(s.era.eras).toBe(2)

    // The ENTIRE prestige account is wiped back to its zero state.
    expect(s.prestige).toEqual({ points: 0, totalEarned: 0, ascensions: 0, nodes: {} })

    // Lifetime stats survive (the career record is permanent).
    expect(s.stats.attacksWon).toBe(9)

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

  it('regenerates the world deterministically from the per-era seed (seed:eraN)', () => {
    const a = readyForEra('era-deterministic')
    const b = readyForEra('era-deterministic')
    newEra(a)
    newEra(b)
    // Same base seed → byte-identical regenerated world + rng stream (no clock/random).
    expect(a.world).toEqual(b.world)
    expect(a.rngState).toBe(b.rngState)
    // The world + rng are exactly those derived from `seed + ':era' + eras` (eras now 1).
    expect(a.world).toEqual(generateWorld('era-deterministic:era1'))
    expect(a.rngState).toBe(RNG.fromString('era-deterministic:era1').getState())
  })

  it('applies the permanent era start_resources head-start to the new capital', () => {
    const s = readyForEra('era-supply')
    const startId = ERA_NODE_IDS.find((id) => ERA_NODES[id].effect.kind === 'start_resources')
    expect(startId).toBeDefined()
    // The era nodes SURVIVE the reset, so the head-start is read from them.
    s.era.nodes = { [startId as string]: 1 }
    const bonus = eraStartResourceBonus(s)
    expect(bonus).toBeGreaterThan(0)

    expect(newEra(s)).toBeGreaterThan(0)

    // A fresh capital starts at 50 of each; the era head-start adds the bonus on top.
    for (const r of RESOURCE_IDS) {
      expect(s.villages.v0.resources[r].toString()).toBe(String(50 + bonus))
    }
    // The surviving era node is intact and the state is valid.
    expect(eraNodeLevel(s, startId as string)).toBe(1)
    expect(validateState(s)).toBe(s)
  })

  it('can be performed repeatedly, each great reset staying valid', () => {
    const s = readyForEra('era-loop')
    for (let i = 1; i <= 3; i++) {
      // Re-arm a prestige score before each era (the previous reset wiped it to 0).
      s.prestige = { points: 0, totalEarned: 300, ascensions: 5, nodes: {} }
      const ep = newEra(s)
      expect(ep).toBeGreaterThan(0)
      expect(s.era.eras).toBe(i)
      expect(s.prestige).toEqual({ points: 0, totalEarned: 0, ascensions: 0, nodes: {} })
      expect(validateState(s)).toBe(s)
    }
    // Lifetime EP total is the running sum; never less than the current balance.
    expect(s.era.totalEarned).toBeGreaterThanOrEqual(s.era.points)
  })

  it('re-seeds the world-events schedule from the per-era seed (M13 — no stale offer survives)', () => {
    const s = readyForEra('era-events')
    // A stale ACTIVE offer + advanced events stream that MUST NOT leak across the great reset.
    s.events = { rngState: 987654321, timer: 11, active: { defId: 'zyla_zelaza', ttl: 99, roll: 0.7 }, buff: null }

    newEra(s)

    expect(s.events.active).toBeNull()
    expect(s.events.timer).toBe(EVENT_INTERVAL)
    // Reproducible from THIS era's own seed (eras === 1), mirroring the combat-stream re-seed.
    expect(s.events.rngState).toBe(RNG.fromString('era-events:era1' + '::events').getState())
  })
})
