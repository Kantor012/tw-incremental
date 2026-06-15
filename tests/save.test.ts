import { describe, it, expect } from 'vitest'
import { D } from '../src/engine/decimal'
import {
  createInitialState,
  recomputeDerived,
  INITIAL_UNITS,
  type GameState,
  type March,
  type VillageId,
} from '../src/engine/state'
import {
  serialize,
  deserialize,
  exportSave,
  importSave,
  migrate,
  validateState,
  loadFromLocal,
  SAVE_VERSION,
} from '../src/engine/save'
import { aggregateTechMods } from '../src/systems/tech'
import { effectiveMods } from '../src/systems/prestige'
import { TECH_NODES } from '../src/content/tech'
import { PRESTIGE_NODES } from '../src/content/prestige'
import { foundVillage, findFoundingSpot } from '../src/systems/villages'
import { MAX_TARGET_LEVEL } from '../src/content/barbarians'
import { WORLD_CENTER } from '../src/systems/world'

/**
 * Save-engine tests for the spatial-world schema (v6). The cross-version migration
 * chain lives in migration.test.ts and world generation in world.test.ts; this file
 * pins down the two things the save engine owns at v6:
 *
 *  1. ROUND-TRIP — serialize/deserialize (and exportSave/importSave) preserve the
 *     M2.2 additions loss-free: every village's integer map coords (x/y), the whole
 *     spatial `world` (the barbarian list), and each march's new geometry snapshot
 *     (targetId + targetX/targetY) alongside the Decimal loot.
 *  2. validateState — accepts a well-formed v6 state and rejects a corrupted world or
 *     march, so a hand-edited/forward-compat save can never boot a half-initialised
 *     state (CLAUDE.md hard rule #3).
 *
 * The v8 additions (M3.1 global passive tree) get their own section at the bottom: a
 * NON-EMPTY `state.tech` map round-trips verbatim, validateState accepts an in-band
 * map and rejects an out-of-band / unknown / non-object one, and importSave folds the
 * tech multipliers back into every village's derived stats (production = base * (1+Σ)).
 */

/** A well-formed march at a concrete barbarian target (geometry + M5.2 kind set). */
function sampleMarch(): March {
  return {
    kind: 'attack',
    targetId: 'b0',
    targetLevel: 3,
    targetX: 212,
    targetY: 188,
    units: { ...INITIAL_UNITS, axeman: 5 },
    phase: 'outbound',
    remaining: 17.5,
    loot: { wood: D(0), clay: D(0), iron: D(0) },
  }
}

/**
 * A fresh, fully-valid v6 state with NON-centre village coords (proving x/y are
 * carried, not re-derived to WORLD_CENTER) and one returning march carrying Decimal
 * loot. Built fresh per test so corruption mutations never leak between cases.
 */
function validV6(): GameState {
  const s = createInitialState('save-v6', 4242)
  s.villages.v0.x = 137
  s.villages.v0.y = 42
  s.villages.v0.marches = [
    { ...sampleMarch(), phase: 'returning', loot: { wood: D(120), clay: D(80), iron: D(15) } },
  ]
  return s
}

describe('save — v6 round-trip', () => {
  it('serialize/deserialize preserves village coords, the world and the new march fields', () => {
    const state = validV6()
    const json = serialize(state)
    const back = deserialize(json)

    expect(back.version).toBe(SAVE_VERSION)

    // Map coordinates (plain numbers, NOT derived) survive verbatim.
    expect(back.villages.v0.x).toBe(137)
    expect(back.villages.v0.y).toBe(42)

    // The spatial world is a Decimal-free bag of plain JSON -> deep-equals exactly.
    expect(back.world).toEqual(state.world)
    expect(back.world.barbarians.length).toBe(state.world.barbarians.length)
    const src = state.world.barbarians[0]
    const got = back.world.barbarians[0]
    expect(got.id).toBe(src.id)
    expect(got.x).toBe(src.x)
    expect(got.y).toBe(src.y)
    expect(got.level).toBe(src.level)
    expect(got.name).toBe(src.name)

    // New march geometry round-trips; the loot Decimals survive the {$d} tag.
    const m = back.villages.v0.marches[0]
    expect(m.targetId).toBe('b0')
    expect(m.targetLevel).toBe(3)
    expect(m.targetX).toBe(212)
    expect(m.targetY).toBe(188)
    expect(m.phase).toBe('returning')
    expect(m.remaining).toBe(17.5)
    expect(m.units).toEqual({ ...INITIAL_UNITS, axeman: 5 })
    expect(m.loot.wood.toString()).toBe('120')
    expect(m.loot.clay.toString()).toBe('80')
    expect(m.loot.iron.toString()).toBe('15')

    // serialize is idempotent across the round-trip (stable key order, re-tagged).
    expect(serialize(back)).toBe(json)
  })

  it('exportSave/importSave round-trips byte-identically (coords, world, marches)', () => {
    const state = validV6()
    const restored = importSave(exportSave(state))

    // Byte-identical: derived fields are already consistent (buildings untouched),
    // so importSave's recomputeDerived pass changes nothing.
    expect(serialize(restored)).toBe(serialize(state))
    expect(restored.villages.v0.x).toBe(137)
    expect(restored.villages.v0.y).toBe(42)
    expect(restored.world).toEqual(state.world)
    expect(restored.villages.v0.marches[0].targetId).toBe('b0')
    expect(restored.villages.v0.marches[0].targetX).toBe(212)
    expect(restored.villages.v0.marches[0].loot.wood.toString()).toBe('120')
  })

  it('a fresh state already carries coords (capital at WORLD_CENTER) and a generated world', () => {
    const state = createInitialState('fresh-v6', 5000)
    expect(state.villages.v0.x).toBe(WORLD_CENTER.x)
    expect(state.villages.v0.y).toBe(WORLD_CENTER.y)
    expect(state.world.barbarians.length).toBeGreaterThan(0)

    const back = deserialize(serialize(state))
    expect(back.villages.v0.x).toBe(WORLD_CENTER.x)
    expect(back.villages.v0.y).toBe(WORLD_CENTER.y)
    expect(back.world).toEqual(state.world)
  })
})

/**
 * Found one village at the nearest legal site around `payer` using the REAL engine
 * (deterministic spatial search + the actual spend), throwing if the geometry/cost
 * gates reject what should be a valid spot. Returns the new village id. Keeps the
 * multi-village setup honest: every extra village is genuinely founded, not hand-built.
 */
function foundAt(s: GameState, payer: VillageId): VillageId {
  const spot = findFoundingSpot(s, payer)
  if (spot === null) throw new Error('test setup: no founding spot available')
  const id = foundVillage(s, payer, spot.x, spot.y)
  if (id === null) throw new Error('test setup: foundVillage rejected a valid spot')
  return id
}

/**
 * A valid v6 state grown to THREE owned villages by founding two on top of the
 * capital through {@link foundVillage} (so villageOrder is ['v0','v1','v2'] and the
 * new entries carry the genuine createVillage footprint + map coords). The capital
 * is stocked so it can pay both escalating foundCosts; a value far beyond
 * Number.MAX_SAFE_INTEGER is parked on the second founded village to prove a
 * big-number Decimal survives the {$d} tag on a NON-capital village too. Built fresh
 * per test so nothing leaks between cases.
 */
function multiVillageState(): GameState {
  const s = createInitialState('save-multi-v6', 7777)
  s.villages.v0.resources = { wood: D(1_000_000), clay: D(1_000_000), iron: D(1_000_000) }
  foundAt(s, 'v0') // -> 'v1'
  const id2 = foundAt(s, 'v0') // -> 'v2'
  s.villages[id2].resources.wood = D('90071992547409910000')
  return s
}

describe('save — v6 multi-village round-trip (founded villages)', () => {
  it('serialize/deserialize preserves every founded village, the order bijection and Decimals', () => {
    const state = multiVillageState()

    // Setup sanity: capital + two FOUNDED villages, keyed and ordered v0,v1,v2.
    expect(state.villageOrder).toEqual(['v0', 'v1', 'v2'])
    expect(Object.keys(state.villages)).toEqual(['v0', 'v1', 'v2'])
    // The capital actually paid for both foundings (its Decimal balance dropped).
    expect(state.villages.v0.resources.wood.lt(D(1_000_000))).toBe(true)

    const json = serialize(state)
    const back = deserialize(json)

    expect(back.version).toBe(SAVE_VERSION)
    // villageOrder survives verbatim and stays a strict bijection with the map.
    expect(back.villageOrder).toEqual(['v0', 'v1', 'v2'])
    expect(Object.keys(back.villages)).toEqual(['v0', 'v1', 'v2'])

    // Both FOUNDED villages survive with their id, name and integer map coords.
    for (const id of ['v1', 'v2'] as const) {
      const src = state.villages[id]
      const got = back.villages[id]
      expect(got.id).toBe(src.id)
      expect(got.name).toBe(src.name)
      expect(got.x).toBe(src.x)
      expect(got.y).toBe(src.y)
      expect(Number.isInteger(got.x)).toBe(true)
      expect(Number.isInteger(got.y)).toBe(true)
    }
    // Names follow foundVillage's 'Wioska N' scheme (count+1 at founding time).
    expect(back.villages.v1.name).toBe('Wioska 2')
    expect(back.villages.v2.name).toBe('Wioska 3')

    // A Decimal on a NON-capital founded village survives the {$d} tag — including a
    // value beyond Number.MAX_SAFE_INTEGER (a plain JSON number could not hold it,
    // and .eq exists only on a rebuilt Decimal, so this proves the tag round-tripped).
    expect(back.villages.v2.resources.wood.eq(D('90071992547409910000'))).toBe(true)
    expect(back.villages.v2.resources.wood.toString()).toBe(
      state.villages.v2.resources.wood.toString(),
    )

    // The payer's debited remainder (a live Decimal) round-trips too.
    expect(back.villages.v0.resources.wood.toString()).toBe(
      state.villages.v0.resources.wood.toString(),
    )

    // The shared world is untouched by founding and deep-equals after the round-trip.
    expect(back.world).toEqual(state.world)

    // serialize stays idempotent with the extra villages (stable key order).
    expect(serialize(back)).toBe(json)
  })

  it('the round-tripped multi-village state still passes validateState', () => {
    const state = multiVillageState()
    const back = deserialize(serialize(state))
    // The villages/villageOrder bijection and every founded village must validate.
    expect(validateState(back)).toBe(back)
  })

  it('exportSave/importSave round-trips the founded empire byte-identically', () => {
    const state = multiVillageState()
    const restored = importSave(exportSave(state))
    // importSave's recomputeDerived pass is a no-op here (createVillage already left
    // each village's derived fields consistent), so the encodings match exactly.
    expect(serialize(restored)).toBe(serialize(state))
    expect(restored.villageOrder).toEqual(['v0', 'v1', 'v2'])
    expect(restored.villages.v2.resources.wood.eq(D('90071992547409910000'))).toBe(true)
  })
})

describe('save — validateState accepts valid v6', () => {
  it('accepts a fresh v6 state and returns the same reference', () => {
    const state = createInitialState('valid-v6', 3000)
    expect(validateState(state)).toBe(state)
  })

  it('accepts a v6 state with off-centre coords, a populated world and active marches', () => {
    const state = validV6()
    expect(validateState(state)).toBe(state)
  })

  it('rejects a broken villages/villageOrder bijection', () => {
    const state = validV6()
    // An ordered id with no matching village must be rejected (the tick would
    // otherwise reference a missing entry).
    state.villageOrder.push('v1')
    expect(() => validateState(state)).toThrow()
  })
})

describe('save — validateState rejects a corrupted world', () => {
  it('rejects a missing world', () => {
    const s = validV6()
    delete (s as { world?: unknown }).world
    expect(() => validateState(s)).toThrow()
  })

  it('rejects world.barbarians that is not an array', () => {
    const s = validV6()
    ;(s.world as { barbarians: unknown }).barbarians = 'nope'
    expect(() => validateState(s)).toThrow()
  })

  it('rejects a non-object barbarian entry', () => {
    const s = validV6()
    ;(s.world.barbarians as unknown[])[0] = 5
    expect(() => validateState(s)).toThrow()
  })

  it('rejects a barbarian with a non-string id', () => {
    const s = validV6()
    ;(s.world.barbarians[0] as { id: unknown }).id = 5
    expect(() => validateState(s)).toThrow()
  })

  it('rejects a barbarian with a non-finite coordinate', () => {
    const sx = validV6()
    sx.world.barbarians[0].x = NaN
    expect(() => validateState(sx)).toThrow()

    const sy = validV6()
    sy.world.barbarians[0].y = Infinity
    expect(() => validateState(sy)).toThrow()
  })

  it('rejects a barbarian level outside [1, MAX_TARGET_LEVEL] or non-integer', () => {
    const lo = validV6()
    lo.world.barbarians[0].level = 0
    expect(() => validateState(lo)).toThrow()

    const hi = validV6()
    hi.world.barbarians[0].level = MAX_TARGET_LEVEL + 1
    expect(() => validateState(hi)).toThrow()

    const frac = validV6()
    frac.world.barbarians[0].level = 2.5
    expect(() => validateState(frac)).toThrow()
  })

  it('rejects a barbarian with a non-string name', () => {
    const s = validV6()
    ;(s.world.barbarians[0] as { name: unknown }).name = 7
    expect(() => validateState(s)).toThrow()
  })
})

describe('save — validateState rejects a corrupted march', () => {
  it('rejects a non-string targetId', () => {
    const s = validV6()
    ;(s.villages.v0.marches[0] as { targetId: unknown }).targetId = 5
    expect(() => validateState(s)).toThrow()
  })

  it('rejects a non-finite targetX / targetY', () => {
    const sx = validV6()
    sx.villages.v0.marches[0].targetX = NaN
    expect(() => validateState(sx)).toThrow()

    const sy = validV6()
    sy.villages.v0.marches[0].targetY = Infinity
    expect(() => validateState(sy)).toThrow()
  })

  it('rejects a targetLevel outside [1, MAX_TARGET_LEVEL]', () => {
    const lo = validV6()
    lo.villages.v0.marches[0].targetLevel = 0
    expect(() => validateState(lo)).toThrow()

    const hi = validV6()
    hi.villages.v0.marches[0].targetLevel = MAX_TARGET_LEVEL + 1
    expect(() => validateState(hi)).toThrow()
  })

  it('rejects an invalid phase', () => {
    const s = validV6()
    ;(s.villages.v0.marches[0] as { phase: unknown }).phase = 'paused'
    expect(() => validateState(s)).toThrow()
  })

  it('rejects a negative-amount loot Decimal', () => {
    const s = validV6()
    s.villages.v0.marches[0].loot.wood = D(-1)
    expect(() => validateState(s)).toThrow()
  })
})

describe('save — misc', () => {
  it('migrates a v0 (pre-versioning) save up to the current version', () => {
    const migrated = migrate({ version: 0, seed: 'legacy' })
    expect(migrated.version).toBe(SAVE_VERSION)
  })

  it('returns null from loadFromLocal when localStorage is unavailable', () => {
    expect(loadFromLocal()).toBe(null)
  })
})

/**
 * A fresh v8 state with a NON-EMPTY global passive tree (M3.1): one root in each arm
 * — eco_root (production), sto_root (storage), set_root (population) — so all three
 * multiplier kinds are active. The levels are set directly and `recomputeDerived` folds
 * the tech multipliers into every village's derived stats. Roots have no prerequisites,
 * so the map is a legitimate purchase state. Built fresh per test so the corruption
 * mutations below never leak between cases.
 */
function techState(): GameState {
  const s = createInitialState('save-v8-tech', 8888)
  s.tech = { eco_root: 4, sto_root: 3, set_root: 2 }
  recomputeDerived(s)
  return s
}

describe('save — v8 tech round-trip', () => {
  it('the tech multipliers lift the derived economy above the building-only base', () => {
    const tech = techState()
    // Same seed, EMPTY tech -> the pure-building baseline to compare against.
    const base = createInitialState('save-v8-tech', 8888)
    const v = tech.villages.v0
    const b = base.villages.v0
    expect(v.production.wood.gt(b.production.wood)).toBe(true)
    expect(v.production.clay.gt(b.production.clay)).toBe(true)
    expect(v.production.iron.gt(b.production.iron)).toBe(true)
    expect(v.storageCap.gt(b.storageCap)).toBe(true)
    expect(v.popCap.gt(b.popCap)).toBe(true)
  })

  it('serialize/deserialize preserves the tech map and the tech-boosted Decimals', () => {
    const state = techState()
    const json = serialize(state)
    const back = deserialize(json)

    expect(back.version).toBe(SAVE_VERSION)
    // The sparse { nodeId: level } map round-trips verbatim (plain JSON numbers).
    expect(back.tech).toEqual({ eco_root: 4, sto_root: 3, set_root: 2 })
    // The boosted derived Decimals survive the {$d} tag exactly.
    expect(back.villages.v0.production.wood.toString()).toBe(
      state.villages.v0.production.wood.toString(),
    )
    expect(back.villages.v0.storageCap.toString()).toBe(
      state.villages.v0.storageCap.toString(),
    )
    expect(back.villages.v0.popCap.toString()).toBe(state.villages.v0.popCap.toString())
    // serialize is idempotent across the round-trip (stable key order, re-tagged).
    expect(serialize(back)).toBe(json)
  })

  it('validateState accepts an in-band tech map and the recompute stays consistent', () => {
    const state = techState()
    expect(validateState(state)).toBe(state)
    // Re-deriving from the same tech map changes nothing (already consistent), which is
    // the invariant importSave relies on.
    const wood = state.villages.v0.production.wood.toString()
    recomputeDerived(state)
    expect(state.villages.v0.production.wood.toString()).toBe(wood)
  })

  it('exportSave/importSave folds the tech multipliers back into the derived stats', () => {
    const state = techState()
    const restored = importSave(exportSave(state))

    // The tech map survives the export/import (and migrate is a no-op at the current version).
    expect(restored.tech).toEqual({ eco_root: 4, sto_root: 3, set_root: 2 })

    // importSave re-derives from restored.tech, so the folded production matches the
    // catalogue applied to the building-only baseline: production = base * (1 + Σ).
    const mods = aggregateTechMods(restored.tech)
    const baseline = createInitialState('save-v8-tech', 8888) // empty tech
    const expectedWood = baseline.villages.v0.production.wood.mul(mods.productionMult.wood)
    expect(restored.villages.v0.production.wood.toString()).toBe(expectedWood.toString())

    // Byte-identical: the derived fields were already consistent before export, so
    // importSave's recomputeDerived pass changes nothing.
    expect(serialize(restored)).toBe(serialize(state))
  })

  it("rejects a tech level outside its node's [0, maxLevel] band, a non-integer or an unknown key", () => {
    const over = techState()
    over.tech.eco_root = TECH_NODES.eco_root.maxLevel + 1
    expect(() => validateState(over)).toThrow()

    const neg = techState()
    neg.tech.eco_root = -1
    expect(() => validateState(neg)).toThrow()

    const frac = techState()
    frac.tech.eco_root = 1.5
    expect(() => validateState(frac)).toThrow()

    // Unknown keys are REJECTED (fail loudly) rather than silently ignored.
    const unknown = techState()
    ;(unknown.tech as Record<string, number>).not_a_real_node = 1
    expect(() => validateState(unknown)).toThrow()
  })

  it('rejects a missing or non-object tech field', () => {
    const missing = techState()
    delete (missing as { tech?: unknown }).tech
    expect(() => validateState(missing)).toThrow()

    const wrong = techState()
    ;(wrong as { tech: unknown }).tech = 'nope'
    expect(() => validateState(wrong)).toThrow()
  })
})

/**
 * A fresh v9 state with a NON-EMPTY PERMANENT prestige (ascension) record (M4.1): the PP
 * counters are banked (points / totalEarned / ascensions) and three purchased nodes —
 * prosperity_root (production_mult), prosperity_growth_n (pop_mult) and prosperity_core_m2
 * (storage_mult) — exercise all three economy-multiplier kinds. The levels are set directly
 * (a legitimate purchase state — all three are in-band and reachable from the prosperity
 * root) and `recomputeDerived` folds the prestige multipliers (via effectiveMods) into every
 * village's derived stats. Built fresh per test so the corruption mutations never leak.
 */
function prestigeState(): GameState {
  const s = createInitialState('save-v9-prestige', 9999)
  s.prestige = {
    points: 5,
    totalEarned: 20,
    ascensions: 2,
    nodes: { prosperity_root: 3, prosperity_growth_n: 2, prosperity_core_m2: 4 },
  }
  recomputeDerived(s)
  return s
}

describe('save — v9 prestige round-trip', () => {
  it('the prestige multipliers lift the derived economy above the building-only base', () => {
    const prestige = prestigeState()
    // Same seed, ZERO prestige -> the pure-building baseline to compare against.
    const base = createInitialState('save-v9-prestige', 9999)
    const v = prestige.villages.v0
    const b = base.villages.v0
    // production_mult (prosperity_root) lifts every resource; pop_mult / storage_mult lift caps.
    expect(v.production.wood.gt(b.production.wood)).toBe(true)
    expect(v.production.clay.gt(b.production.clay)).toBe(true)
    expect(v.production.iron.gt(b.production.iron)).toBe(true)
    expect(v.storageCap.gt(b.storageCap)).toBe(true)
    expect(v.popCap.gt(b.popCap)).toBe(true)
  })

  it('serialize/deserialize preserves the prestige record and the prestige-boosted Decimals', () => {
    const state = prestigeState()
    const json = serialize(state)
    const back = deserialize(json)

    expect(back.version).toBe(SAVE_VERSION)
    // The whole permanent record round-trips verbatim (plain JSON numbers + sparse map).
    expect(back.prestige).toEqual({
      points: 5,
      totalEarned: 20,
      ascensions: 2,
      nodes: { prosperity_root: 3, prosperity_growth_n: 2, prosperity_core_m2: 4 },
    })
    // The boosted derived Decimals survive the {$d} tag exactly.
    expect(back.villages.v0.production.wood.toString()).toBe(
      state.villages.v0.production.wood.toString(),
    )
    expect(back.villages.v0.storageCap.toString()).toBe(state.villages.v0.storageCap.toString())
    expect(back.villages.v0.popCap.toString()).toBe(state.villages.v0.popCap.toString())
    // serialize is idempotent across the round-trip (stable key order, re-tagged).
    expect(serialize(back)).toBe(json)
  })

  it('validateState accepts an in-band prestige record and the recompute stays consistent', () => {
    const state = prestigeState()
    expect(validateState(state)).toBe(state)
    // Re-deriving from the same prestige map changes nothing (already consistent), which is
    // the invariant importSave relies on.
    const wood = state.villages.v0.production.wood.toString()
    recomputeDerived(state)
    expect(state.villages.v0.production.wood.toString()).toBe(wood)
  })

  it('exportSave/importSave folds the prestige multipliers back into the derived stats', () => {
    const state = prestigeState()
    const restored = importSave(exportSave(state))

    // The whole record survives the export/import (migrate is a no-op at the current version).
    expect(restored.prestige).toEqual({
      points: 5,
      totalEarned: 20,
      ascensions: 2,
      nodes: { prosperity_root: 3, prosperity_growth_n: 2, prosperity_core_m2: 4 },
    })

    // importSave re-derives from restored.prestige (combined with the empty tech bag), so the
    // folded production matches effectiveMods applied to the building-only baseline.
    const mods = effectiveMods(restored)
    const baseline = createInitialState('save-v9-prestige', 9999) // zero prestige
    const expectedWood = baseline.villages.v0.production.wood.mul(mods.productionMult.wood)
    expect(restored.villages.v0.production.wood.toString()).toBe(expectedWood.toString())

    // Byte-identical: the derived fields were already consistent before export, so
    // importSave's recomputeDerived pass changes nothing.
    expect(serialize(restored)).toBe(serialize(state))
  })

  it('round-trips alongside a non-empty tech map (both trees fold together)', () => {
    // tech (eco_root, production) AND prestige (prosperity_root, production) both lift wood;
    // effectiveMods MULTIPLIES the two factors, and that combined fold survives import.
    const state = createInitialState('save-v9-both', 1234)
    state.tech = { eco_root: 2 }
    state.prestige = { points: 0, totalEarned: 0, ascensions: 0, nodes: { prosperity_root: 2 } }
    recomputeDerived(state)

    const restored = importSave(exportSave(state))
    expect(restored.tech).toEqual({ eco_root: 2 })
    expect(restored.prestige.nodes).toEqual({ prosperity_root: 2 })
    const mods = effectiveMods(restored)
    const baseline = createInitialState('save-v9-both', 1234) // empty tech + zero prestige
    const expectedWood = baseline.villages.v0.production.wood.mul(mods.productionMult.wood)
    expect(restored.villages.v0.production.wood.toString()).toBe(expectedWood.toString())
    expect(serialize(restored)).toBe(serialize(state))
  })

  it("rejects a prestige level outside its node's [0, maxLevel] band, a non-integer or an unknown key", () => {
    const over = prestigeState()
    over.prestige.nodes.prosperity_root = PRESTIGE_NODES.prosperity_root.maxLevel + 1
    expect(() => validateState(over)).toThrow()

    const neg = prestigeState()
    neg.prestige.nodes.prosperity_root = -1
    expect(() => validateState(neg)).toThrow()

    const frac = prestigeState()
    frac.prestige.nodes.prosperity_root = 1.5
    expect(() => validateState(frac)).toThrow()

    // Unknown keys are REJECTED (fail loudly) rather than silently ignored.
    const unknown = prestigeState()
    ;(unknown.prestige.nodes as Record<string, number>).not_a_real_node = 1
    expect(() => validateState(unknown)).toThrow()
  })

  it('rejects a missing / non-object prestige field or a non-object nodes map', () => {
    const missing = prestigeState()
    delete (missing as { prestige?: unknown }).prestige
    expect(() => validateState(missing)).toThrow()

    const wrong = prestigeState()
    ;(wrong as { prestige: unknown }).prestige = 'nope'
    expect(() => validateState(wrong)).toThrow()

    const badNodes = prestigeState()
    ;(badNodes.prestige as { nodes: unknown }).nodes = 'nope'
    expect(() => validateState(badNodes)).toThrow()
  })

  it('rejects a negative / non-finite PP counter (points / totalEarned / ascensions)', () => {
    for (const key of ['points', 'totalEarned', 'ascensions'] as const) {
      const neg = prestigeState()
      neg.prestige[key] = -1
      expect(() => validateState(neg)).toThrow()

      const nan = prestigeState()
      neg.prestige[key] = 0
      nan.prestige[key] = Number.NaN
      expect(() => validateState(nan)).toThrow()
    }
  })
})

/** A fresh state whose automation toggles + policy are set to a non-default record. */
function automationState(): GameState {
  const s = createInitialState('save-v10-automation', 4242)
  s.automation = {
    build: true,
    recruit: true,
    attack: false,
    recruitUnit: 'spearman',
    recruitTarget: 30,
  }
  return s
}

describe('save — v10 automation round-trip', () => {
  it('serialize/deserialize preserves the automation toggles + policy verbatim', () => {
    const state = automationState()
    const json = serialize(state)
    const back = deserialize(json)

    expect(back.version).toBe(SAVE_VERSION)
    expect(back.automation).toEqual({
      build: true,
      recruit: true,
      attack: false,
      recruitUnit: 'spearman',
      recruitTarget: 30,
    })
    // serialize is idempotent across the round-trip (stable key order).
    expect(serialize(back)).toBe(json)
  })

  it('exportSave/importSave round-trips the automation record', () => {
    const state = automationState()
    const restored = importSave(exportSave(state))
    expect(restored.automation).toEqual({
      build: true,
      recruit: true,
      attack: false,
      recruitUnit: 'spearman',
      recruitTarget: 30,
    })
    // automation is not derived, so importSave's recompute leaves the save byte-identical.
    expect(serialize(restored)).toBe(serialize(state))
  })

  it('validateState accepts the all-off default and a null recruitUnit', () => {
    // The fresh-state default (everything off, no unit chosen, target 0) is always valid.
    const fresh = createInitialState('save-v10-default', 1)
    expect(validateState(fresh)).toBe(fresh)
    expect(fresh.automation.recruitUnit).toBe(null)

    // A null recruitUnit alongside enabled switches is also valid (nothing gets recruited).
    const nullUnit = automationState()
    nullUnit.automation.recruitUnit = null
    expect(validateState(nullUnit)).toBe(nullUnit)
  })

  it('rejects a missing / non-object automation field', () => {
    const missing = automationState()
    delete (missing as { automation?: unknown }).automation
    expect(() => validateState(missing)).toThrow()

    for (const bad of ['nope', 5, null] as const) {
      const wrong = automationState()
      ;(wrong as { automation: unknown }).automation = bad
      expect(() => validateState(wrong)).toThrow()
    }
  })

  it('rejects a non-boolean build / recruit / attack switch', () => {
    for (const key of ['build', 'recruit', 'attack'] as const) {
      const bad = automationState()
      ;(bad.automation as unknown as Record<string, unknown>)[key] = 'yes'
      expect(() => validateState(bad)).toThrow()
    }
  })

  it('rejects an unknown recruitUnit (a non-null, non-unit id)', () => {
    const bad = automationState()
    ;(bad.automation as { recruitUnit: unknown }).recruitUnit = 'dragon'
    expect(() => validateState(bad)).toThrow()
  })

  it('rejects a negative / non-integer / non-finite recruitTarget', () => {
    const neg = automationState()
    neg.automation.recruitTarget = -1
    expect(() => validateState(neg)).toThrow()

    const frac = automationState()
    frac.automation.recruitTarget = 2.5
    expect(() => validateState(frac)).toThrow()

    const nan = automationState()
    nan.automation.recruitTarget = Number.NaN
    expect(() => validateState(nan)).toThrow()
  })
})

/**
 * A fresh v11 state exercising the M5.2 additions: a built wall + a trained scout on the
 * capital, a SCOUT march in flight (kind 'scout', scouts only, empty loot), and a
 * barbarian flipped to scouted. Built fresh per test so the corruption mutations below
 * never leak between cases.
 */
function v11State(): GameState {
  const s = createInitialState('save-v11', 5252)
  const v = s.villages.v0
  v.buildings.barracks = 1
  v.buildings.wall = 4
  v.units.scout = 6
  const target = s.world.barbarians[0]
  v.marches = [
    {
      kind: 'scout',
      targetId: target.id,
      targetLevel: target.level,
      targetX: target.x,
      targetY: target.y,
      units: { ...INITIAL_UNITS, scout: 2 },
      phase: 'outbound',
      remaining: 12,
      loot: { wood: D(0), clay: D(0), iron: D(0) },
    },
  ]
  target.scouted = true
  recomputeDerived(s)
  return s
}

describe('save — v11 wall + scout round-trip (M5.2)', () => {
  it('serialize/deserialize preserves the wall level, scout count, scout-march kind and scouted flag', () => {
    const state = v11State()
    const json = serialize(state)
    const back = deserialize(json)

    expect(back.version).toBe(SAVE_VERSION)
    expect(back.villages.v0.buildings.wall).toBe(4)
    expect(back.villages.v0.units.scout).toBe(6)
    const m = back.villages.v0.marches[0]
    expect(m.kind).toBe('scout')
    expect(m.units.scout).toBe(2)
    expect(back.world.barbarians[0].scouted).toBe(true)
    // serialize is idempotent across the round-trip (stable key order, re-tagged).
    expect(serialize(back)).toBe(json)
  })

  it('exportSave/importSave round-trips the M5.2 fields byte-identically', () => {
    const state = v11State()
    const restored = importSave(exportSave(state))
    // No migration runs at the current version and the derived fields are already
    // consistent, so importSave's recompute changes nothing.
    expect(serialize(restored)).toBe(serialize(state))
    expect(restored.villages.v0.buildings.wall).toBe(4)
    expect(restored.villages.v0.marches[0].kind).toBe('scout')
    expect(restored.world.barbarians[0].scouted).toBe(true)
  })

  it('validateState accepts a scout march and an attack march side by side with scouted barbarians', () => {
    const state = v11State()
    // Add an attack march too, so BOTH kinds validate alongside one another.
    state.villages.v0.marches.push(sampleMarch())
    expect(validateState(state)).toBe(state)
  })

  it('rejects a march with an unknown / missing kind', () => {
    const bad = v11State()
    ;(bad.villages.v0.marches[0] as { kind: unknown }).kind = 'raid'
    expect(() => validateState(bad)).toThrow()

    const missing = v11State()
    delete (missing.villages.v0.marches[0] as { kind?: unknown }).kind
    expect(() => validateState(missing)).toThrow()
  })

  it('rejects a non-boolean / missing barbarian scouted flag', () => {
    const wrong = v11State()
    ;(wrong.world.barbarians[0] as { scouted: unknown }).scouted = 'yes'
    expect(() => validateState(wrong)).toThrow()

    const missing = v11State()
    delete (missing.world.barbarians[0] as { scouted?: unknown }).scouted
    expect(() => validateState(missing)).toThrow()
  })
})

/**
 * A fresh v12 state exercising the M5.3 additions: the two siege units (ram + catapult)
 * trained on the capital AND dispatched in an in-flight attack march. M5.3 adds no new
 * building / march kind / barbarian field — siege is a per-unit role tag plus pure
 * combat/march logic — so the only thing to round-trip is the wider unit roster. Built
 * fresh per test so the corruption mutations below never leak between cases.
 */
function v12State(): GameState {
  const s = createInitialState('save-v12', 6363)
  const v = s.villages.v0
  v.buildings.barracks = 1
  v.buildings.academy = 1 // siege gates behind the academy
  v.units.axeman = 8
  v.units.ram = 7
  v.units.catapult = 3
  const target = s.world.barbarians[0]
  v.marches = [
    {
      kind: 'attack',
      targetId: target.id,
      targetLevel: target.level,
      targetX: target.x,
      targetY: target.y,
      // A siege column on the road: rams + catapults in the dispatched subset.
      units: { ...INITIAL_UNITS, axeman: 4, ram: 2, catapult: 1 },
      phase: 'outbound',
      remaining: 33,
      loot: { wood: D(0), clay: D(0), iron: D(0) },
    },
  ]
  recomputeDerived(s)
  return s
}

describe('save — v12 siege units round-trip (M5.3)', () => {
  it('serialize/deserialize preserves the ram/catapult counts (roster + march)', () => {
    const state = v12State()
    const json = serialize(state)
    const back = deserialize(json)

    expect(back.version).toBe(SAVE_VERSION)
    expect(back.villages.v0.units.ram).toBe(7)
    expect(back.villages.v0.units.catapult).toBe(3)
    const m = back.villages.v0.marches[0]
    expect(m.units.ram).toBe(2)
    expect(m.units.catapult).toBe(1)
    // serialize is idempotent across the round-trip (stable key order, re-tagged).
    expect(serialize(back)).toBe(json)
  })

  it('exportSave/importSave round-trips the siege roster byte-identically', () => {
    const state = v12State()
    const restored = importSave(exportSave(state))
    // No migration runs at the current version and the derived fields are already
    // consistent, so importSave's recompute changes nothing.
    expect(serialize(restored)).toBe(serialize(state))
    expect(restored.villages.v0.units.ram).toBe(7)
    expect(restored.villages.v0.units.catapult).toBe(3)
    expect(restored.villages.v0.marches[0].units.ram).toBe(2)
  })

  it('validateState accepts in-band siege counts and rejects a negative / fractional / missing one', () => {
    const ok = v12State()
    expect(validateState(ok)).toBe(ok)

    const neg = v12State()
    neg.villages.v0.units.ram = -1
    expect(() => validateState(neg)).toThrow()

    const frac = v12State()
    frac.villages.v0.units.catapult = 1.5
    expect(() => validateState(frac)).toThrow()

    const missing = v12State()
    delete (missing.villages.v0.units as { ram?: number }).ram
    expect(() => validateState(missing)).toThrow()

    const marchMissing = v12State()
    delete (marchMissing.villages.v0.marches[0].units as { catapult?: number }).catapult
    expect(() => validateState(marchMissing)).toThrow()
  })
})

// =====================================================================
// v14 — combat luck on battle reports (M5.5).
// =====================================================================

/**
 * A fresh state whose battle log mixes M5.5 reports (an attack + a raid each carrying a
 * `luck` roll) with a PRE-M5.5 report (no `luck` — the field is optional, so an old log
 * stays valid). Built per test so corruption mutations never leak.
 */
function luckLogState(): GameState {
  const s = createInitialState('save-luck', 9)
  const vid = s.villageOrder[0]
  s.battleLog = [
    // pre-M5.5 attack: NO luck field (an old report must round-trip and validate as-is).
    { kind: 'attack', villageId: vid, targetLevel: 2, won: true, lootSum: '120', losses: 1 },
    // M5.5 attack carrying its luck roll.
    { kind: 'attack', villageId: vid, targetLevel: 3, won: false, lootSum: '0', losses: 4, luck: 0.83 },
    // M5.5 raid carrying its luck roll.
    { kind: 'raid', villageId: vid, won: true, looted: '0', losses: 0, luck: 1.21 },
  ]
  return s
}

describe('save — v14 battle-report luck round-trip (M5.5)', () => {
  it('serialize/deserialize preserves each report luck (and the absent one stays absent)', () => {
    const state = luckLogState()
    const json = serialize(state)
    const back = deserialize(json)

    expect(back.version).toBe(SAVE_VERSION)
    expect(back.battleLog).toHaveLength(3)
    const [old, atk, raid] = back.battleLog
    if (old.kind !== 'attack' || atk.kind !== 'attack' || raid.kind !== 'raid') {
      throw new Error('unexpected report kinds')
    }
    // The old report never gained a luck field.
    expect('luck' in old).toBe(false)
    expect(old.luck).toBeUndefined()
    // The M5.5 rolls survive verbatim (plain JSON numbers).
    expect(atk.luck).toBe(0.83)
    expect(raid.luck).toBe(1.21)
    // serialize is idempotent across the round-trip.
    expect(serialize(back)).toBe(json)
  })

  it('exportSave/importSave round-trips the luck rolls byte-identically', () => {
    const state = luckLogState()
    const restored = importSave(exportSave(state))
    expect(serialize(restored)).toBe(serialize(state))
    const atk = restored.battleLog[1]
    const raid = restored.battleLog[2]
    if (atk.kind !== 'attack' || raid.kind !== 'raid') throw new Error('unexpected report kinds')
    expect(atk.luck).toBe(0.83)
    expect(raid.luck).toBe(1.21)
  })

  it('validateState accepts a present-but-finite luck and an absent one', () => {
    const ok = luckLogState()
    expect(validateState(ok)).toBe(ok)
  })

  it('validateState rejects a non-finite / zero / negative / non-number luck', () => {
    for (const bad of [NaN, Infinity, -Infinity, 0, -0.5, '1.1' as unknown as number]) {
      const s = luckLogState()
      ;(s.battleLog[1] as { luck?: unknown }).luck = bad
      expect(() => validateState(s)).toThrow()
    }
  })
})
