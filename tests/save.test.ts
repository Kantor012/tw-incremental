import { describe, it, expect } from 'vitest'
import { D } from '../src/engine/decimal'
import {
  createInitialState,
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
 */

/** A well-formed v6 march at a concrete barbarian target (new geometry fields set). */
function sampleMarch(): March {
  return {
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
