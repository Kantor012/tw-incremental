import { describe, it, expect } from 'vitest'
import { createInitialState, recomputeDerived, type GameState } from '../src/engine/state'
import {
  serialize,
  deserialize,
  exportSave,
  importSave,
  migrate,
  validateState,
  SAVE_VERSION,
} from '../src/engine/save'
import { effectiveMods } from '../src/systems/prestige'
import { DYNASTY_NODES, DYNASTY_NODE_IDS } from '../src/content/dynasty'

/**
 * M6.2 save-engine tests for the dynasty (great-great-reset) schema (v16). The cross-version
 * migration chain through v15 lives in migration.test.ts; this file pins the two things the
 * save engine owns at v16:
 *
 *  1. v15 -> v16 MIGRATION — a pre-dynasty save (no `dynasty` field) backfills the zero record
 *     `{ points:0, totalEarned:0, dynasties:0, nodes:{} }` and then validates, exactly like the
 *     v14->v15 era backfill. A forward-compat save that already carries a `dynasty` object keeps
 *     it verbatim; a corrupt/non-object one resets to the zero record.
 *  2. ROUND-TRIP + validateState — a NON-EMPTY `state.dynasty` round-trips byte-for-byte
 *     (serialize/deserialize AND exportSave/importSave), its multipliers fold back into the
 *     derived economy on import, and validateState accepts an in-band record while rejecting a
 *     negative counter, an unknown node id or an out-of-[0,maxLevel] level.
 *
 * Dynasty nodes are referenced GENERICALLY (the FIXED root ids + DYNASTY_NODE_IDS), so a content
 * rename of a deep cluster id cannot rot these tests.
 */

/**
 * A v15-shaped raw save (NO `dynasty` field). Built by serialising a real current-version state
 * and DOWNGRADING it — strip `dynasty`, stamp version 15 — so it always tracks the live village
 * roster/world shape (no hand-maintained building/unit lists to drift). deserialize gives real
 * Decimal instances, exactly as a save off disk would after parsing.
 */
function rawV15(): Record<string, unknown> {
  const fresh = createInitialState('save-v15', 4242)
  fresh.prestige = { points: 3, totalEarned: 5, ascensions: 1, nodes: {} }
  fresh.era = { points: 2, totalEarned: 4, eras: 1, nodes: {} }
  const raw = deserialize(serialize(fresh)) as unknown as Record<string, unknown>
  delete raw.dynasty
  raw.version = 15
  return raw
}

describe('dynasty save — v15 -> v16 migration backfill (M6.2)', () => {
  it('backfills the zero dynasty record and the migrated save validates', () => {
    const raw = rawV15()
    expect('dynasty' in raw).toBe(false)

    const m = migrate(raw)
    expect(m.version).toBe(SAVE_VERSION)
    // The single new top-level field: the zero permanent dynasty (great-great-reset) record.
    expect(m.dynasty).toEqual({ points: 0, totalEarned: 0, dynasties: 0, nodes: {} })
    // Everything else carried through untouched (the v15->v16 step touches only `dynasty`/`version`).
    expect(m.prestige).toEqual({ points: 3, totalEarned: 5, ascensions: 1, nodes: {} })
    expect(m.era).toEqual({ points: 2, totalEarned: 4, eras: 1, nodes: {} })
    expect(validateState(m).version).toBe(SAVE_VERSION)
  })

  it('preserves a dynasty record a forward-compat v15 save already carries (known node ids)', () => {
    const knownId = DYNASTY_NODE_IDS[0]
    expect(typeof knownId).toBe('string')
    const raw = rawV15()
    raw.dynasty = { points: 7, totalEarned: 12, dynasties: 2, nodes: { [knownId]: 1 } }

    const m = migrate(raw)
    expect(m.version).toBe(SAVE_VERSION)
    expect(m.dynasty).toEqual({ points: 7, totalEarned: 12, dynasties: 2, nodes: { [knownId]: 1 } })
    // In-band counters + a level-1 KNOWN node id, so the carried record still validates.
    expect(validateState(m).version).toBe(SAVE_VERSION)
  })

  it('resets a non-object dynasty field to the zero record', () => {
    for (const bad of ['nope', 5, null] as const) {
      const raw = rawV15()
      raw.dynasty = bad
      const m = migrate(raw)
      expect(m.version).toBe(SAVE_VERSION)
      expect(m.dynasty).toEqual({ points: 0, totalEarned: 0, dynasties: 0, nodes: {} })
      expect(validateState(m).version).toBe(SAVE_VERSION)
    }
  })

  it('importSave of a v15 export backfills the zero dynasty record and re-derives stats', () => {
    const restored = importSave(exportSave(rawV15() as never))
    expect(restored.version).toBe(SAVE_VERSION)
    expect(restored.dynasty).toEqual({ points: 0, totalEarned: 0, dynasties: 0, nodes: {} })
    // The carried prestige + era survived the migration too.
    expect(restored.prestige).toEqual({ points: 3, totalEarned: 5, ascensions: 1, nodes: {} })
    expect(restored.era).toEqual({ points: 2, totalEarned: 4, eras: 1, nodes: {} })
  })
})

/**
 * A fresh v16 state with a NON-EMPTY dynasty record: banked DP counters and two FIXED-root
 * purchases — continuum_root (production_mult, lifts the economy) and sovereignty_root (ep_mult,
 * scales EP gain but not the derived stats). The levels are set directly (a legitimate purchase
 * state — both roots have no prerequisites and are in-band) and recomputeDerived folds the
 * dynasty multipliers (via effectiveMods) into every village's derived stats. Built fresh per
 * test so the corruption mutations below never leak between cases.
 */
function dynastyState(): GameState {
  const s = createInitialState('save-v16-dyn', 1616)
  s.dynasty = {
    points: 9,
    totalEarned: 30,
    dynasties: 2,
    nodes: { continuum_root: 3, sovereignty_root: 2 },
  }
  recomputeDerived(s)
  return s
}

describe('dynasty save — v16 round-trip', () => {
  it('the dynasty multipliers lift the derived economy above the building-only base', () => {
    const dyn = dynastyState()
    // Same seed, ZERO dynasty -> the pure-building baseline to compare against.
    const base = createInitialState('save-v16-dyn', 1616)
    expect(dyn.villages.v0.production.wood.gt(base.villages.v0.production.wood)).toBe(true)
  })

  it('serialize/deserialize preserves the dynasty record and the dynasty-boosted Decimals', () => {
    const state = dynastyState()
    const json = serialize(state)
    const back = deserialize(json)

    expect(back.version).toBe(SAVE_VERSION)
    expect(back.dynasty).toEqual({
      points: 9,
      totalEarned: 30,
      dynasties: 2,
      nodes: { continuum_root: 3, sovereignty_root: 2 },
    })
    // The boosted derived Decimal survives the {$d} tag exactly.
    expect(back.villages.v0.production.wood.toString()).toBe(
      state.villages.v0.production.wood.toString(),
    )
    // serialize is idempotent across the round-trip (stable key order, re-tagged).
    expect(serialize(back)).toBe(json)
  })

  it('exportSave/importSave folds the dynasty multipliers back into the derived stats byte-identically', () => {
    const state = dynastyState()
    const restored = importSave(exportSave(state))

    expect(restored.dynasty).toEqual({
      points: 9,
      totalEarned: 30,
      dynasties: 2,
      nodes: { continuum_root: 3, sovereignty_root: 2 },
    })
    // importSave re-derives from restored.dynasty (combined with the empty tech/prestige/era
    // bags), so the folded production matches effectiveMods applied to the building-only baseline.
    const mods = effectiveMods(restored)
    const baseline = createInitialState('save-v16-dyn', 1616) // zero dynasty
    const expectedWood = baseline.villages.v0.production.wood.mul(mods.productionMult.wood)
    expect(restored.villages.v0.production.wood.toString()).toBe(expectedWood.toString())
    // Byte-identical: derived fields were already consistent before export.
    expect(serialize(restored)).toBe(serialize(state))
  })

  it('round-trips alongside a non-empty tech + prestige + era (all four trees fold together)', () => {
    const state = createInitialState('save-v16-all', 3030)
    state.tech = { eco_root: 2 } // production
    state.prestige = { points: 0, totalEarned: 0, ascensions: 0, nodes: {} }
    state.era = { points: 0, totalEarned: 0, eras: 0, nodes: {} }
    state.dynasty = { points: 0, totalEarned: 0, dynasties: 0, nodes: { continuum_root: 2 } } // production
    recomputeDerived(state)

    const restored = importSave(exportSave(state))
    expect(restored.tech).toEqual({ eco_root: 2 })
    expect(restored.dynasty.nodes).toEqual({ continuum_root: 2 })
    const mods = effectiveMods(restored)
    const baseline = createInitialState('save-v16-all', 3030) // empty everywhere
    const expectedWood = baseline.villages.v0.production.wood.mul(mods.productionMult.wood)
    expect(restored.villages.v0.production.wood.toString()).toBe(expectedWood.toString())
    expect(serialize(restored)).toBe(serialize(state))
  })
})

describe('dynasty save — validateState', () => {
  it('accepts a fresh zero record and an in-band non-empty dynasty record', () => {
    const fresh = createInitialState('dyn-valid', 1)
    expect(validateState(fresh)).toBe(fresh)
    expect(fresh.dynasty).toEqual({ points: 0, totalEarned: 0, dynasties: 0, nodes: {} })

    const s = dynastyState()
    expect(validateState(s)).toBe(s)
  })

  it('rejects a missing / non-object dynasty field or a non-object nodes map', () => {
    const missing = dynastyState()
    delete (missing as { dynasty?: unknown }).dynasty
    expect(() => validateState(missing)).toThrow()

    const wrong = dynastyState()
    ;(wrong as { dynasty: unknown }).dynasty = 'nope'
    expect(() => validateState(wrong)).toThrow()

    const badNodes = dynastyState()
    ;(badNodes.dynasty as { nodes: unknown }).nodes = 'nope'
    expect(() => validateState(badNodes)).toThrow()
  })

  it('rejects a negative / non-finite DP counter (points / totalEarned / dynasties)', () => {
    for (const key of ['points', 'totalEarned', 'dynasties'] as const) {
      const neg = dynastyState()
      neg.dynasty[key] = -1
      expect(() => validateState(neg)).toThrow()

      const nan = dynastyState()
      nan.dynasty[key] = Number.NaN
      expect(() => validateState(nan)).toThrow()
    }
  })

  it("rejects a dynasty level outside its node's [0, maxLevel] band, a non-integer or an unknown key", () => {
    const over = dynastyState()
    over.dynasty.nodes.continuum_root = DYNASTY_NODES.continuum_root.maxLevel + 1
    expect(() => validateState(over)).toThrow()

    const neg = dynastyState()
    neg.dynasty.nodes.continuum_root = -1
    expect(() => validateState(neg)).toThrow()

    const frac = dynastyState()
    frac.dynasty.nodes.continuum_root = 1.5
    expect(() => validateState(frac)).toThrow()

    // Unknown keys are REJECTED (fail loudly) rather than silently ignored.
    const unknown = dynastyState()
    ;(unknown.dynasty.nodes as Record<string, number>).not_a_real_node = 1
    expect(() => validateState(unknown)).toThrow()
  })
})

describe('dynasty save — fresh state round-trip', () => {
  it('a fresh createInitialState round-trips byte-identically with a zero dynasty record', () => {
    const state = createInitialState('dyn-fresh', 2026)
    const restored = importSave(exportSave(state))
    expect(restored.dynasty).toEqual({ points: 0, totalEarned: 0, dynasties: 0, nodes: {} })
    expect(serialize(restored)).toBe(serialize(state))
    expect(validateState(restored)).toBe(restored)
  })
})
