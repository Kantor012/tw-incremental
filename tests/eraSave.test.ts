import { describe, it, expect } from 'vitest'
import {
  createInitialState,
  recomputeDerived,
  type GameState,
} from '../src/engine/state'
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
import { ERA_NODES, ERA_NODE_IDS } from '../src/content/era'

/**
 * M6.1 save-engine tests for the era (great-reset) schema (v15). The cross-version
 * migration chain through v14 lives in migration.test.ts; this file pins the two things
 * the save engine owns at v15:
 *
 *  1. v14 -> v15 MIGRATION — a pre-era save (no `era` field) backfills the zero record
 *     `{ points:0, totalEarned:0, eras:0, nodes:{} }` and then validates, exactly like the
 *     v8->v9 prestige backfill. A forward-compat save that already carries an `era` object
 *     keeps it verbatim; a corrupt/non-object one resets to the zero record.
 *  2. ROUND-TRIP + validateState — a NON-EMPTY `state.era` round-trips byte-for-byte
 *     (serialize/deserialize AND exportSave/importSave), its multipliers fold back into the
 *     derived economy on import, and validateState accepts an in-band record while rejecting
 *     a negative counter, an unknown node id or an out-of-[0,maxLevel] level.
 *
 * Era nodes are referenced GENERICALLY (the FIXED root ids + ERA_NODE_IDS), so a content
 * rename of a deep cluster id cannot rot these tests.
 */

/**
 * A v14-shaped raw save (NO `era` field). Built by serialising a real current-version state
 * and DOWNGRADING it — strip `era`, stamp version 14 — so it always tracks the live village
 * roster/world shape (no hand-maintained building/unit lists to drift). deserialize gives
 * real Decimal instances, exactly as a save off disk would after parsing.
 */
function rawV14(): Record<string, unknown> {
  const fresh = createInitialState('save-v14', 4242)
  fresh.prestige = { points: 3, totalEarned: 5, ascensions: 1, nodes: {} }
  const raw = deserialize(serialize(fresh)) as unknown as Record<string, unknown>
  delete raw.era
  raw.version = 14
  return raw
}

describe('era save — v14 -> v15 migration backfill (M6.1)', () => {
  it('backfills the zero era record and the migrated save validates', () => {
    const raw = rawV14()
    expect('era' in raw).toBe(false)

    const m = migrate(raw)
    expect(m.version).toBe(SAVE_VERSION)
    // The single new top-level field: the zero permanent era (great-reset) record.
    expect(m.era).toEqual({ points: 0, totalEarned: 0, eras: 0, nodes: {} })
    // Everything else carried through untouched (the v14->v15 step touches only `era`/`version`).
    expect(m.prestige).toEqual({ points: 3, totalEarned: 5, ascensions: 1, nodes: {} })
    expect(validateState(m).version).toBe(SAVE_VERSION)
  })

  it('preserves an era record a forward-compat v14 save already carries (known node ids)', () => {
    const knownId = ERA_NODE_IDS[0]
    expect(typeof knownId).toBe('string')
    const raw = rawV14()
    raw.era = { points: 7, totalEarned: 12, eras: 2, nodes: { [knownId]: 1 } }

    const m = migrate(raw)
    expect(m.version).toBe(SAVE_VERSION)
    expect(m.era).toEqual({ points: 7, totalEarned: 12, eras: 2, nodes: { [knownId]: 1 } })
    // In-band counters + a level-1 KNOWN node id, so the carried record still validates.
    expect(validateState(m).version).toBe(SAVE_VERSION)
  })

  it('resets a non-object era field to the zero record', () => {
    for (const bad of ['nope', 5, null] as const) {
      const raw = rawV14()
      raw.era = bad
      const m = migrate(raw)
      expect(m.version).toBe(SAVE_VERSION)
      expect(m.era).toEqual({ points: 0, totalEarned: 0, eras: 0, nodes: {} })
      expect(validateState(m).version).toBe(SAVE_VERSION)
    }
  })

  it('importSave of a v14 export backfills the zero era record and re-derives stats', () => {
    const restored = importSave(exportSave(rawV14() as never))
    expect(restored.version).toBe(SAVE_VERSION)
    expect(restored.era).toEqual({ points: 0, totalEarned: 0, eras: 0, nodes: {} })
    // The carried prestige survived the migration too.
    expect(restored.prestige).toEqual({ points: 3, totalEarned: 5, ascensions: 1, nodes: {} })
  })
})

/**
 * A fresh v15 state with a NON-EMPTY era record: banked EP counters and two FIXED-root
 * purchases — eternity_root (production_mult, lifts the economy) and legacy_root (pp_mult,
 * scales PP gain but not the derived stats). The levels are set directly (a legitimate
 * purchase state — both roots have no prerequisites and are in-band) and recomputeDerived
 * folds the era multipliers (via effectiveMods) into every village's derived stats. Built
 * fresh per test so the corruption mutations below never leak between cases.
 */
function eraState(): GameState {
  const s = createInitialState('save-v15-era', 1515)
  s.era = {
    points: 9,
    totalEarned: 30,
    eras: 2,
    nodes: { eternity_root: 3, legacy_root: 2 },
  }
  recomputeDerived(s)
  return s
}

describe('era save — v15 round-trip', () => {
  it('the era multipliers lift the derived economy above the building-only base', () => {
    const era = eraState()
    // Same seed, ZERO era -> the pure-building baseline to compare against.
    const base = createInitialState('save-v15-era', 1515)
    expect(era.villages.v0.production.wood.gt(base.villages.v0.production.wood)).toBe(true)
  })

  it('serialize/deserialize preserves the era record and the era-boosted Decimals', () => {
    const state = eraState()
    const json = serialize(state)
    const back = deserialize(json)

    expect(back.version).toBe(SAVE_VERSION)
    expect(back.era).toEqual({
      points: 9,
      totalEarned: 30,
      eras: 2,
      nodes: { eternity_root: 3, legacy_root: 2 },
    })
    // The boosted derived Decimal survives the {$d} tag exactly.
    expect(back.villages.v0.production.wood.toString()).toBe(
      state.villages.v0.production.wood.toString(),
    )
    // serialize is idempotent across the round-trip (stable key order, re-tagged).
    expect(serialize(back)).toBe(json)
  })

  it('exportSave/importSave folds the era multipliers back into the derived stats byte-identically', () => {
    const state = eraState()
    const restored = importSave(exportSave(state))

    expect(restored.era).toEqual({
      points: 9,
      totalEarned: 30,
      eras: 2,
      nodes: { eternity_root: 3, legacy_root: 2 },
    })
    // importSave re-derives from restored.era (combined with the empty tech/prestige bags),
    // so the folded production matches effectiveMods applied to the building-only baseline.
    const mods = effectiveMods(restored)
    const baseline = createInitialState('save-v15-era', 1515) // zero era
    const expectedWood = baseline.villages.v0.production.wood.mul(mods.productionMult.wood)
    expect(restored.villages.v0.production.wood.toString()).toBe(expectedWood.toString())
    // Byte-identical: derived fields were already consistent before export.
    expect(serialize(restored)).toBe(serialize(state))
  })

  it('round-trips alongside a non-empty tech + prestige (all three trees fold together)', () => {
    const state = createInitialState('save-v15-all', 3030)
    state.tech = { eco_root: 2 } // production
    state.prestige = { points: 0, totalEarned: 0, ascensions: 0, nodes: {} }
    state.era = { points: 0, totalEarned: 0, eras: 0, nodes: { eternity_root: 2 } } // production
    recomputeDerived(state)

    const restored = importSave(exportSave(state))
    expect(restored.tech).toEqual({ eco_root: 2 })
    expect(restored.era.nodes).toEqual({ eternity_root: 2 })
    const mods = effectiveMods(restored)
    const baseline = createInitialState('save-v15-all', 3030) // empty everywhere
    const expectedWood = baseline.villages.v0.production.wood.mul(mods.productionMult.wood)
    expect(restored.villages.v0.production.wood.toString()).toBe(expectedWood.toString())
    expect(serialize(restored)).toBe(serialize(state))
  })
})

describe('era save — validateState', () => {
  it('accepts a fresh zero record and an in-band non-empty era record', () => {
    const fresh = createInitialState('era-valid', 1)
    expect(validateState(fresh)).toBe(fresh)
    expect(fresh.era).toEqual({ points: 0, totalEarned: 0, eras: 0, nodes: {} })

    const s = eraState()
    expect(validateState(s)).toBe(s)
  })

  it('rejects a missing / non-object era field or a non-object nodes map', () => {
    const missing = eraState()
    delete (missing as { era?: unknown }).era
    expect(() => validateState(missing)).toThrow()

    const wrong = eraState()
    ;(wrong as { era: unknown }).era = 'nope'
    expect(() => validateState(wrong)).toThrow()

    const badNodes = eraState()
    ;(badNodes.era as { nodes: unknown }).nodes = 'nope'
    expect(() => validateState(badNodes)).toThrow()
  })

  it('rejects a negative / non-finite EP counter (points / totalEarned / eras)', () => {
    for (const key of ['points', 'totalEarned', 'eras'] as const) {
      const neg = eraState()
      neg.era[key] = -1
      expect(() => validateState(neg)).toThrow()

      const nan = eraState()
      nan.era[key] = Number.NaN
      expect(() => validateState(nan)).toThrow()
    }
  })

  it("rejects an era level outside its node's [0, maxLevel] band, a non-integer or an unknown key", () => {
    const over = eraState()
    over.era.nodes.eternity_root = ERA_NODES.eternity_root.maxLevel + 1
    expect(() => validateState(over)).toThrow()

    const neg = eraState()
    neg.era.nodes.eternity_root = -1
    expect(() => validateState(neg)).toThrow()

    const frac = eraState()
    frac.era.nodes.eternity_root = 1.5
    expect(() => validateState(frac)).toThrow()

    // Unknown keys are REJECTED (fail loudly) rather than silently ignored.
    const unknown = eraState()
    ;(unknown.era.nodes as Record<string, number>).not_a_real_node = 1
    expect(() => validateState(unknown)).toThrow()
  })
})

describe('era save — fresh state round-trip', () => {
  it('a fresh createInitialState round-trips byte-identically with a zero era record', () => {
    const state = createInitialState('era-fresh', 2026)
    const restored = importSave(exportSave(state))
    expect(restored.era).toEqual({ points: 0, totalEarned: 0, eras: 0, nodes: {} })
    expect(serialize(restored)).toBe(serialize(state))
    expect(validateState(restored)).toBe(restored)
  })
})
