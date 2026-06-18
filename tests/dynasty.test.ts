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
  aggregateDynastyMods,
  dynastyEpMult,
  dynastyStartResourceBonus,
  dynastyScore,
  pendingDynastyPoints,
  dynastyNodeLevel,
  dynastyNodeAvailable,
  dynastyNodeCost,
  canPurchaseDynasty,
  purchaseDynasty,
  newDynasty,
  dynastyHasCycle,
  orphanDynastyNodes,
  deadDynastyNodes,
  DP_SCALE,
  DYN_ERA_WEIGHT,
} from '../src/systems/dynasty'
import { eraScore, pendingEraPoints, EP_SCALE } from '../src/systems/era'
import { effectiveMods } from '../src/systems/prestige'
import { aggregateTechMods } from '../src/systems/tech'
import { DYNASTY_NODES, DYNASTY_NODE_IDS, DYNASTY_ROOTS } from '../src/content/dynasty'
import { ERA_NODE_IDS } from '../src/content/era'
import { PRESTIGE_NODE_IDS } from '../src/content/prestige'
import { generateWorld } from '../src/systems/world'
import { exportSave, validateState } from '../src/engine/save'

/**
 * M6.2 — the THIRD meta-layer, the DYNASTY (great-great reset) above era. These tests pin the
 * contract of the data-driven engine (systems/dynasty.ts), the pure DATA catalogue
 * (content/dynasty.ts) and the dynasty layer's interplay with era + prestige:
 *  - static topology is a healthy DAG (no cycles/orphans/dead perks) with the three FIXED
 *    roots (sovereignty/apotheosis/continuum, one per category, stable effect kinds), and the
 *    binary `automation_unlock` gateway is NOT counted dead;
 *  - aggregateDynastyMods({}) IS the identity bag (automations all FALSE), so a no-dynasty
 *    save's effectiveMods is byte-identical to the pre-M6.2 (tech × prestige × era) fold; a
 *    multiplier node folds correctly;
 *  - the lone `automation_unlock` gateway is the ONLY aggregate that flips all three
 *    automation flags true — through effectiveMods AND via combine's OR over an otherwise
 *    fully-locked state;
 *  - dynastyScore / pendingDynastyPoints follow the CUBE-ROOT curve (measured from the ERA
 *    account exactly as era is measured from prestige) and are monotonic + floored; the
 *    signature dynastyEpMult rises after an ep_mult root and scales pendingEraPoints;
 *  - purchaseDynasty spends DP and re-derives every village; canPurchaseDynasty rejects
 *    unknown/maxed/locked/unaffordable with the right Polish reason;
 *  - newDynasty is the GREAT-GREAT RESET: a no-op at zero score (byte-for-byte), else it banks
 *    DP, WIPES the entire era AND prestige accounts, regenerates the run deterministically
 *    (same seed → identical world + rngState), preserves the dynasty account + lifetime stats,
 *    and applies the dynasty start_resources head-start.
 *
 * Dynasty nodes are referenced GENERICALLY — the three FIXED roots and the catalogue's own
 * data (effect.kind / perLevel / maxLevel) — never a deep cluster id, so a content rename
 * cannot rot these tests.
 */

/** The lone binary automation gateway id, found by effect kind (never a hardcoded id). */
const AUTO_ID = DYNASTY_NODE_IDS.find(
  (id) => DYNASTY_NODES[id].effect.kind === 'automation_unlock',
) as string

/** The first start_resources node id, found by effect kind. */
const START_ID = DYNASTY_NODE_IDS.find(
  (id) => DYNASTY_NODES[id].effect.kind === 'start_resources',
) as string

/** A fresh run with a huge banked DP balance so any dynasty node is affordable. */
function richDynasty(seed = 'dyn-rich'): GameState {
  const s = createInitialState(seed, 0)
  s.dynasty.points = 1_000_000
  return s
}

/**
 * A fresh run carrying enough ERA progress that a Nowa Dynastia banks a positive DP yield
 * (dynastyScore = era.totalEarned + era.eras*DYN_ERA_WEIGHT + Σ era node levels > 0), plus a
 * non-trivial prestige account to prove the great-great reset wipes BOTH layers below.
 */
function readyForDynasty(seed = 'dyn-reset'): GameState {
  const s = createInitialState(seed, 0)
  s.era = { points: 40, totalEarned: 300, eras: 5, nodes: {} }
  s.prestige = { points: 12, totalEarned: 80, ascensions: 2, nodes: {} }
  return s
}

/** Numeric value of a Decimal field (for toBeCloseTo on multiplied economy stats). */
function num(d: { toString(): string }): number {
  return Number(d.toString())
}

describe('dynasty catalogue (static topology invariants)', () => {
  it('DYNASTY_NODE_IDS mirrors the catalogue keys in source order', () => {
    expect(DYNASTY_NODE_IDS).toEqual(Object.keys(DYNASTY_NODES))
    expect(DYNASTY_NODE_IDS.length).toBeGreaterThanOrEqual(3)
  })

  it('the three FIXED roots are the no-prereq nodes, one per category, with stable effect kinds', () => {
    // The contract pins exactly these ids + effect kinds — other phases depend on them.
    expect([...DYNASTY_ROOTS].sort()).toEqual([
      'apotheosis_root',
      'continuum_root',
      'sovereignty_root',
    ])
    const fromData = DYNASTY_NODE_IDS.filter((id) => DYNASTY_NODES[id].prerequisites.length === 0)
    expect([...DYNASTY_ROOTS].sort()).toEqual(fromData.sort())
    expect(DYNASTY_NODES.sovereignty_root.prerequisites).toEqual([])
    expect(DYNASTY_NODES.apotheosis_root.prerequisites).toEqual([])
    expect(DYNASTY_NODES.continuum_root.prerequisites).toEqual([])
    expect(DYNASTY_NODES.sovereignty_root.effect.kind).toBe('ep_mult')
    expect(DYNASTY_NODES.apotheosis_root.effect.kind).toBe('attack_mult')
    expect(DYNASTY_NODES.continuum_root.effect.kind).toBe('production_mult')
    const cats = DYNASTY_ROOTS.map((id) => DYNASTY_NODES[id].category)
    expect(new Set(cats)).toEqual(new Set(['sovereignty', 'apotheosis', 'continuum']))
  })

  it('has exactly ONE automation_unlock gateway, in the sovereignty branch, maxLevel 1', () => {
    const gates = DYNASTY_NODE_IDS.filter(
      (id) => DYNASTY_NODES[id].effect.kind === 'automation_unlock',
    )
    expect(gates).toEqual([AUTO_ID])
    expect(DYNASTY_NODES[AUTO_ID].category).toBe('sovereignty')
    expect(DYNASTY_NODES[AUTO_ID].maxLevel).toBe(1)
  })

  it('is a healthy DAG: no cycles, no orphans, no dead perks (automation_unlock NOT dead)', () => {
    expect(dynastyHasCycle()).toBe(false)
    expect(orphanDynastyNodes()).toEqual([])
    expect(deadDynastyNodes()).toEqual([])
    // The binary gateway has no perLevel yet is a real effect — never flagged dead.
    expect(deadDynastyNodes()).not.toContain(AUTO_ID)
  })

  it('every prerequisite id points at a real node and every maxLevel is in 1..10', () => {
    for (const id of DYNASTY_NODE_IDS) {
      for (const pre of DYNASTY_NODES[id].prerequisites) expect(DYNASTY_NODES[pre]).toBeDefined()
      expect(DYNASTY_NODES[id].maxLevel).toBeGreaterThanOrEqual(1)
      expect(DYNASTY_NODES[id].maxLevel).toBeLessThanOrEqual(10)
      expect(DYNASTY_NODES[id].baseCost).toBeGreaterThan(0)
      expect(DYNASTY_NODES[id].costFactor).toBeGreaterThanOrEqual(1)
    }
  })
})

describe('aggregateDynastyMods', () => {
  it('is the identity bag (all 1 / 0, automations all FALSE) for an empty tree, equal to NO_TECH_MODS', () => {
    expect(aggregateDynastyMods({})).toEqual(NO_TECH_MODS)
    // The identity bag must leave automations LOCKED — only an owned gateway unlocks them.
    expect(aggregateDynastyMods({}).automations).toEqual({
      build: false,
      recruit: false,
      attack: false,
    })
  })

  it('an empty dynasty leaves effectiveMods byte-identical to the pre-M6.2 (tech × prestige × era) fold', () => {
    const s = createInitialState('dyn-identity', 0)
    s.tech = { eco_root: 3 } // a tech multiplier so the bag is non-trivial
    // With dynasty present-but-empty, combine(x, identityBag) === x, so effectiveMods is just
    // the tech bag (prestige + era are empty too) — every earlier balance target is byte-identical.
    expect(effectiveMods(s)).toEqual(aggregateTechMods(s.tech))
    // And dropping `dynasty` entirely (defensive read → {}) yields the very same result.
    const noDyn = createInitialState('dyn-identity', 0)
    noDyn.tech = { eco_root: 3 }
    delete (noDyn as { dynasty?: unknown }).dynasty
    expect(effectiveMods(noDyn)).toEqual(effectiveMods(s))
  })

  it('folds a multiplier node into a 1 + Σ factor (production_mult on every resource)', () => {
    const node = DYNASTY_NODES.continuum_root // FIXED root, production_mult
    expect(node.effect.kind).toBe('production_mult')
    const mods = aggregateDynastyMods({ continuum_root: 2 })
    const expected = 1 + (node.effect as { perLevel: number }).perLevel * 2
    expect(mods.productionMult.wood).toBeCloseTo(expected, 9)
    expect(mods.productionMult.clay).toBeCloseTo(expected, 9)
    expect(mods.productionMult.iron).toBeCloseTo(expected, 9)
    // a pure production node leaves the other axes at identity.
    expect(mods.storageMult).toBe(1)
    expect(mods.attackMult).toBe(1)
    expect(mods.automations).toEqual({ build: false, recruit: false, attack: false })
  })

  it('never folds the dynasty-only start_resources / ep_mult kinds into a multiplier', () => {
    const epId = DYNASTY_NODE_IDS.find((id) => DYNASTY_NODES[id].effect.kind === 'ep_mult')
    expect(START_ID).toBeDefined()
    expect(epId).toBeDefined()
    // Neither is a multiplier — both must leave the whole bag at identity.
    expect(aggregateDynastyMods({ [START_ID]: 3 })).toEqual(NO_TECH_MODS)
    expect(aggregateDynastyMods({ [epId as string]: 3 })).toEqual(NO_TECH_MODS)
  })

  it('ignores unknown / zeroed / non-finite keys (robust + deterministic)', () => {
    expect(
      aggregateDynastyMods({ phantom: 5, continuum_root: 0, sovereignty_root: Number.NaN }),
    ).toEqual(NO_TECH_MODS)
  })
})

describe('aggregateDynastyMods automation gateway (the GATED MECHANIC)', () => {
  it('owning the automation_unlock gateway flips ALL THREE flags true — the ONLY aggregate that can', () => {
    expect(DYNASTY_NODES[AUTO_ID].effect.kind).toBe('automation_unlock')
    const mods = aggregateDynastyMods({ [AUTO_ID]: 1 })
    expect(mods.automations).toEqual({ build: true, recruit: true, attack: true })
    // It is a pure gate — it leaves every magnitude axis at identity.
    expect(mods.productionMult).toEqual({ wood: 1, clay: 1, iron: 1 })
    expect(mods.attackMult).toBe(1)
    expect(mods.costReduction).toBe(0)
  })

  it('unlocks automations via effectiveMods on an otherwise fully-locked state (combine ORs the gate)', () => {
    // A fresh state has NO automations unlocked anywhere (tech/prestige/era bags all-false).
    const locked = createInitialState('dyn-auto', 0)
    expect(effectiveMods(locked).automations).toEqual({
      build: false,
      recruit: false,
      attack: false,
    })
    // Owning the dynasty gateway is the single account-wide source of the unlock: combine ORs
    // the all-true dynasty bag onto the all-false tech × prestige × era bag.
    locked.dynasty.nodes = { [AUTO_ID]: 1 }
    expect(effectiveMods(locked).automations).toEqual({
      build: true,
      recruit: true,
      attack: true,
    })
  })
})

describe('dynastyScore / pendingDynastyPoints (the cube-root DP curve)', () => {
  it('dynastyScore = era.totalEarned + era.eras*DYN_ERA_WEIGHT + Σ era node levels (points excluded)', () => {
    const s = createInitialState('dyn-score', 0)
    const eraId = ERA_NODE_IDS[0]
    // `points` must NOT count (only banked-lifetime era progress drives the score).
    s.era = { points: 999, totalEarned: 40, eras: 3, nodes: { [eraId]: 2 } }
    expect(dynastyScore(s)).toBe(40 + 3 * DYN_ERA_WEIGHT + 2)
  })

  it('is order-independent and defensive (missing era scores 0)', () => {
    const a = createInitialState('dyn-det', 0)
    a.era = { points: 0, totalEarned: 123, eras: 4, nodes: {} }
    const b = createInitialState('dyn-det', 0)
    b.era = { points: 0, totalEarned: 123, eras: 4, nodes: {} }
    expect(dynastyScore(a)).toBe(dynastyScore(b))
    expect(dynastyScore({} as unknown as GameState)).toBe(0)
  })

  it('equals floor(cbrt(dynastyScore) * DP_SCALE), is 0 at zero score and monotonic non-decreasing', () => {
    const s = createInitialState('dyn-curve', 0)
    s.era = { points: 0, totalEarned: 0, eras: 0, nodes: {} }
    expect(dynastyScore(s)).toBe(0)
    expect(pendingDynastyPoints(s)).toBe(0)

    // The exact cube-root formula at several scores (floor absorbs any cbrt ULP).
    for (const total of [1, 8, 27, 100, 1000]) {
      s.era.totalEarned = total
      const score = dynastyScore(s)
      expect(score).toBe(total)
      expect(pendingDynastyPoints(s)).toBe(Math.floor(Math.cbrt(score) * DP_SCALE))
    }

    // Monotonic in raw progress (never decreases as the era account grows).
    let prev = -1
    for (let total = 0; total <= 3000; total += 50) {
      s.era.totalEarned = total
      const dp = pendingDynastyPoints(s)
      expect(dp).toBeGreaterThanOrEqual(prev)
      prev = dp
    }
  })

  it('the cube root makes DP rarer than a sqrt yield at the same score', () => {
    const s = createInitialState('dyn-rarer', 0)
    s.era = { points: 0, totalEarned: 1000, eras: 0, nodes: {} }
    // cbrt(1000)=10 vs sqrt(1000)≈31 — DP is the scarce, top-most-tier currency.
    expect(pendingDynastyPoints(s)).toBeLessThan(Math.floor(Math.sqrt(dynastyScore(s))))
  })
})

describe('dynastyEpMult (the signature era-loop accelerator)', () => {
  it('is 1 with no dynasty nodes and rises after buying the ep_mult root (sovereignty_root)', () => {
    const s = richDynasty('dyn-epmult')
    expect(dynastyEpMult(s)).toBe(1)
    expect(DYNASTY_NODES.sovereignty_root.effect.kind).toBe('ep_mult')

    expect(purchaseDynasty(s, 'sovereignty_root')).toBe(true) // level 1
    const per = (DYNASTY_NODES.sovereignty_root.effect as { perLevel: number }).perLevel
    expect(dynastyEpMult(s)).toBeCloseTo(1 + per, 9)
    expect(dynastyEpMult(s)).toBeGreaterThan(1)
  })

  it('is defensive when state.dynasty is missing (folds to 1)', () => {
    expect(dynastyEpMult({} as unknown as GameState)).toBe(1)
  })

  it('scales pendingEraPoints for a fixed era score', () => {
    const s = richDynasty('dyn-epscale')
    // A sizeable, dynasty-independent era score so the multiplier visibly bites.
    s.prestige = { points: 0, totalEarned: 100_000, ascensions: 0, nodes: {} }
    const before = pendingEraPoints(s)

    expect(purchaseDynasty(s, 'sovereignty_root')).toBe(true)
    const mult = dynastyEpMult(s)
    const score = eraScore(s) // unchanged by a dynasty purchase

    const after = pendingEraPoints(s)
    expect(after).toBe(Math.floor(Math.cbrt(score) * EP_SCALE * mult))
    expect(after).toBeGreaterThan(before)
  })
})

describe('dynastyStartResourceBonus', () => {
  it('is 0 with no start_resources node and sums perLevel * level over the start_resources nodes', () => {
    const s = createInitialState('dyn-srb', 0)
    expect(dynastyStartResourceBonus(s)).toBe(0)

    expect(START_ID).toBeDefined()
    s.dynasty.nodes = { [START_ID]: 2 }
    const per = (DYNASTY_NODES[START_ID].effect as { perLevel: number }).perLevel
    expect(dynastyStartResourceBonus(s)).toBe(per * 2)
  })

  it('is defensive when state.dynasty is missing (folds to 0)', () => {
    expect(dynastyStartResourceBonus({} as unknown as GameState)).toBe(0)
  })
})

describe('dynastyNodeCost', () => {
  it('equals ceil(baseCost * costFactor^level) and is 0 for an unknown node', () => {
    const node = DYNASTY_NODES.continuum_root
    expect(dynastyNodeCost('continuum_root', 0)).toBe(Math.ceil(node.baseCost))
    expect(dynastyNodeCost('continuum_root', 1)).toBe(Math.ceil(node.baseCost * node.costFactor))
    expect(dynastyNodeCost('does_not_exist', 0)).toBe(0)
  })
})

describe('dynastyNodeAvailable', () => {
  it('a root is available, a child is locked until its prerequisite reaches level 1', () => {
    const s = richDynasty('dyn-avail')
    expect(dynastyNodeAvailable(s, 'sovereignty_root')).toBe(true)
    const child = DYNASTY_NODE_IDS.find((id) =>
      DYNASTY_NODES[id].prerequisites.includes('sovereignty_root'),
    )
    expect(child).toBeDefined()
    expect(dynastyNodeAvailable(s, child as string)).toBe(false)
    expect(purchaseDynasty(s, 'sovereignty_root')).toBe(true)
    expect(dynastyNodeAvailable(s, child as string)).toBe(true)
  })

  it('a maxed node is no longer available; an unknown node is never available', () => {
    const s = richDynasty('dyn-avail2')
    s.dynasty.nodes.sovereignty_root = DYNASTY_NODES.sovereignty_root.maxLevel
    expect(dynastyNodeAvailable(s, 'sovereignty_root')).toBe(false)
    expect(dynastyNodeAvailable(s, 'does_not_exist')).toBe(false)
  })
})

describe('canPurchaseDynasty (Polish reasons)', () => {
  it('rejects an unknown node', () => {
    const s = richDynasty()
    expect(canPurchaseDynasty(s, 'no_such_node')).toEqual({ ok: false, reason: 'Nieznany węzeł' })
  })

  it('rejects a locked node (prerequisites unmet) even when affordable', () => {
    const s = richDynasty()
    const child = DYNASTY_NODE_IDS.find((id) => DYNASTY_NODES[id].prerequisites.length > 0)
    expect(child).toBeDefined()
    expect(canPurchaseDynasty(s, child as string)).toEqual({
      ok: false,
      reason: 'Wymagania niespełnione',
    })
  })

  it('rejects a maxed node', () => {
    const s = richDynasty()
    s.dynasty.nodes.sovereignty_root = DYNASTY_NODES.sovereignty_root.maxLevel
    expect(canPurchaseDynasty(s, 'sovereignty_root')).toEqual({
      ok: false,
      reason: 'Poziom maksymalny',
    })
  })

  it('rejects when the banked DP cannot cover the cost', () => {
    const poor = createInitialState('dyn-poor', 0) // 0 DP, sovereignty_root costs >= 1
    expect(canPurchaseDynasty(poor, 'sovereignty_root')).toEqual({
      ok: false,
      reason: 'Za mało punktów dynastii',
    })
  })

  it('accepts an available, affordable, unmaxed node (no reason)', () => {
    const s = richDynasty()
    const res = canPurchaseDynasty(s, 'sovereignty_root')
    expect(res.ok).toBe(true)
    expect(res.reason).toBeUndefined()
  })
})

describe('purchaseDynasty', () => {
  it('raises the level, spends the exact DP and re-derives the economy (production_mult root)', () => {
    const s = richDynasty('dyn-buy')
    const node = DYNASTY_NODES.continuum_root
    expect(node.effect.kind).toBe('production_mult')
    const cost = dynastyNodeCost('continuum_root', 0)
    const beforePoints = s.dynasty.points
    const beforeProd = num(s.villages.v0.production.wood)

    expect(purchaseDynasty(s, 'continuum_root')).toBe(true)

    expect(dynastyNodeLevel(s, 'continuum_root')).toBe(1)
    expect(s.dynasty.points).toBe(beforePoints - cost)
    // The permanent production multiplier folds into derived stats via recomputeDerived.
    const per = (node.effect as { perLevel: number }).perLevel
    expect(num(s.villages.v0.production.wood)).toBeCloseTo(beforeProd * (1 + per), 9)
  })

  it('returns false and mutates nothing when unaffordable', () => {
    const poor = createInitialState('dyn-noop', 0) // 0 DP
    expect(purchaseDynasty(poor, 'continuum_root')).toBe(false)
    expect(dynastyNodeLevel(poor, 'continuum_root')).toBe(0)
    expect(poor.dynasty.points).toBe(0)
  })

  it('stops exactly at maxLevel', () => {
    const s = richDynasty('dyn-max')
    let bought = 0
    while (purchaseDynasty(s, 'continuum_root')) bought++
    expect(bought).toBe(DYNASTY_NODES.continuum_root.maxLevel)
    expect(dynastyNodeLevel(s, 'continuum_root')).toBe(DYNASTY_NODES.continuum_root.maxLevel)
    expect(canPurchaseDynasty(s, 'continuum_root').reason).toBe('Poziom maksymalny')
  })
})

describe('newDynasty (the great-great reset)', () => {
  it('is a no-op (returns 0, mutates nothing) at zero era score', () => {
    const s = createInitialState('dyn-zero', 0)
    // A non-trivial dynasty account so we can prove the no-op touches nothing.
    s.dynasty = { points: 11, totalEarned: 11, dynasties: 2, nodes: {} }
    expect(pendingDynastyPoints(s)).toBe(0)
    // Byte-for-byte snapshot: the dp<=0 path must mutate NOTHING — not just dynasty / era /
    // prestige / villageOrder, but world, rngState, tech and the clock fields (createdAt /
    // lastSeen) too. A single serialize() comparison covers them all.
    const before = exportSave(s)
    expect(newDynasty(s)).toBe(0)
    expect(exportSave(s)).toBe(before)
  })

  it('banks DP, WIPES the entire era AND prestige accounts, preserves the dynasty account + lifetime stats', () => {
    const s = readyForDynasty('dyn-bank')
    const eraId = ERA_NODE_IDS[0]
    const prestigeId = PRESTIGE_NODE_IDS[0]
    // A pre-existing era + prestige state (both must be WIPED) and a pre-existing dynasty
    // balance + lifetime stats that must SURVIVE the great-great reset. BOTH lower trees carry
    // a POPULATED nodes map so the reset genuinely has to clear them — an implementation that
    // zeroed the counters but left a stale node behind would fail the toEqual below.
    s.era = { points: 40, totalEarned: 300, eras: 5, nodes: { [eraId]: 1 } }
    s.prestige = { points: 12, totalEarned: 80, ascensions: 2, nodes: { [prestigeId]: 1 } }
    s.dynasty = { points: 3, totalEarned: 3, dynasties: 1, nodes: {} }
    s.stats.attacksWon = 9
    // M15: a non-empty Kuźnia upgrade map that the great-great reset must WIPE (a per-run sink — a
    // fresh dynasty must not keep free permanent ×mult upgrades behind a rebuilt level-0 Kuźnia).
    s.forge = { axeman: 2, spearman: 1 }
    // The base seed + clock fields are part of the "what SURVIVES" contract: newDynasty takes
    // no clock and keeps the run reproducible, so these must be byte-identical afterwards.
    const seedBefore = s.seed
    const createdAtBefore = s.createdAt
    const lastSeenBefore = s.lastSeen
    const pending = pendingDynastyPoints(s)
    expect(pending).toBeGreaterThan(0)

    const dp = newDynasty(s)

    // Banked: returns the pending DP and credits points / totalEarned / dynasties on top.
    expect(dp).toBe(pending)
    expect(s.dynasty.points).toBe(3 + dp)
    expect(s.dynasty.totalEarned).toBe(3 + dp)
    expect(s.dynasty.dynasties).toBe(2)

    // BOTH lower meta-accounts are wiped back to their zero state.
    expect(s.era).toEqual({ points: 0, totalEarned: 0, eras: 0, nodes: {} })
    expect(s.prestige).toEqual({ points: 0, totalEarned: 0, ascensions: 0, nodes: {} })

    // Lifetime stats survive (the career record is permanent).
    expect(s.stats.attacksWon).toBe(9)

    // The base seed + clock fields are untouched (the "no clock" reproducibility guarantee).
    expect(s.seed).toBe(seedBefore)
    expect(s.createdAt).toBe(createdAtBefore)
    expect(s.lastSeen).toBe(lastSeenBefore)

    // The run is reset: one fresh capital, cleared tech + battle log, a regenerated world.
    expect(s.villageOrder).toEqual(['v0'])
    expect(Object.keys(s.villages)).toEqual(['v0'])
    expect(s.villages.v0.name).toBe('Stolica')
    expect(s.tech).toEqual({})
    expect(s.forge).toEqual({}) // M15: the per-run Kuźnia upgrade map is cleared like tech
    expect(s.battleLog).toEqual([])
    expect(s.world.barbarians.length).toBeGreaterThan(0)

    // The reset state is fully valid and immediately playable (no softlock / corruption).
    expect(validateState(s)).toBe(s)
  })

  it('regenerates the world deterministically from the per-dynasty seed (seed:dynN)', () => {
    const a = readyForDynasty('dyn-deterministic')
    const b = readyForDynasty('dyn-deterministic')
    newDynasty(a)
    newDynasty(b)
    // Same base seed → byte-identical regenerated world + rng stream (no clock/random).
    expect(a.world).toEqual(b.world)
    expect(a.rngState).toBe(b.rngState)
    // The world + rng are exactly those derived from `seed + ':dyn' + dynasties` (dynasties now 1).
    expect(a.world).toEqual(generateWorld('dyn-deterministic:dyn1'))
    expect(a.rngState).toBe(RNG.fromString('dyn-deterministic:dyn1').getState())
  })

  it('applies the permanent dynasty start_resources head-start to the new capital', () => {
    const s = readyForDynasty('dyn-supply')
    expect(START_ID).toBeDefined()
    // The dynasty nodes SURVIVE the reset, so the head-start is read from them.
    s.dynasty.nodes = { [START_ID]: 1 }
    const bonus = dynastyStartResourceBonus(s)
    expect(bonus).toBeGreaterThan(0)

    expect(newDynasty(s)).toBeGreaterThan(0)

    // A fresh capital starts at 50 of each; the dynasty head-start adds the bonus on top.
    for (const r of RESOURCE_IDS) {
      expect(s.villages.v0.resources[r].toString()).toBe(String(50 + bonus))
    }
    // The surviving dynasty node is intact and the state is valid.
    expect(dynastyNodeLevel(s, START_ID)).toBe(1)
    expect(validateState(s)).toBe(s)
  })

  it('can be performed repeatedly, each great-great reset staying valid', () => {
    const s = readyForDynasty('dyn-loop')
    for (let i = 1; i <= 3; i++) {
      // Re-arm an era score before each dynasty (the previous reset wiped it to 0).
      s.era = { points: 0, totalEarned: 300, eras: 5, nodes: {} }
      const dp = newDynasty(s)
      expect(dp).toBeGreaterThan(0)
      expect(s.dynasty.dynasties).toBe(i)
      expect(s.era).toEqual({ points: 0, totalEarned: 0, eras: 0, nodes: {} })
      expect(s.prestige).toEqual({ points: 0, totalEarned: 0, ascensions: 0, nodes: {} })
      expect(validateState(s)).toBe(s)
    }
    // Lifetime DP total is the running sum; never less than the current balance.
    expect(s.dynasty.totalEarned).toBeGreaterThanOrEqual(s.dynasty.points)
  })

  it('re-seeds the world-events schedule from the per-dynasty seed (M13 — no stale offer survives)', () => {
    const s = readyForDynasty('dyn-events')
    // A stale ACTIVE offer + advanced events stream that MUST NOT leak across the great-great reset.
    s.events = { rngState: 555111777, timer: 3, active: { defId: 'dary_lasu', ttl: 12, roll: 0.2 }, buff: null }

    newDynasty(s)

    expect(s.events.active).toBeNull()
    expect(s.events.timer).toBe(EVENT_INTERVAL)
    // Reproducible from THIS dynasty's own seed (dynasties === 1), mirroring the combat re-seed.
    expect(s.events.rngState).toBe(RNG.fromString('dyn-events:dyn1' + '::events').getState())
  })
})
