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
import { CHALLENGES, CHALLENGE_IDS } from '../src/content/challenges'

/**
 * M8 save-engine tests for the challenge (WYZWANIA) schema (v19). The cross-version
 * migration chain through v18 lives in migration.test.ts; this file pins the two things
 * the save engine owns at v19:
 *
 *  1. v18 -> v19 MIGRATION — a pre-challenge save (no `challenge` field) backfills the empty
 *     account `{ activeId: null, completed: {} }` and then validates, exactly like the
 *     v14->v15 era backfill. A forward-compat save that already carries a `challenge` object
 *     keeps it verbatim; a corrupt/non-object one resets to the empty account.
 *  2. ROUND-TRIP + validateState — a NON-EMPTY `state.challenge` (an active id + a completed
 *     map) round-trips byte-for-byte (serialize/deserialize AND exportSave/importSave), its
 *     active constraint folds back into the derived economy on import, and validateState
 *     accepts an in-band record while rejecting an unknown activeId, an unknown completed key
 *     and a negative / fractional completed count.
 *
 * Challenges are referenced GENERICALLY (CHALLENGE_IDS / a productionMult challenge found in
 * the catalogue), so a content rename cannot rot these tests.
 */

/**
 * A v18-shaped raw save (NO `challenge` field). Built by serialising a real current-version
 * state and DOWNGRADING it — strip `challenge`, stamp version 18 — so it always tracks the
 * live village roster/world shape (no hand-maintained lists to drift). deserialize gives real
 * Decimal instances, exactly as a save off disk would after parsing.
 */
function rawV18(): Record<string, unknown> {
  const fresh = createInitialState('save-v18', 4242)
  fresh.prestige = { points: 3, totalEarned: 5, ascensions: 1, nodes: {} }
  const raw = deserialize(serialize(fresh)) as unknown as Record<string, unknown>
  delete raw.challenge
  raw.version = 18
  return raw
}

describe('challenge save — v18 -> v19 migration backfill (M8)', () => {
  it('backfills the empty challenge account and the migrated save validates', () => {
    const raw = rawV18()
    expect('challenge' in raw).toBe(false)

    const m = migrate(raw)
    expect(m.version).toBe(SAVE_VERSION)
    // The single new top-level field: the empty challenge account.
    expect(m.challenge).toEqual({ activeId: null, completed: {} })
    // Everything else carried through untouched (the v18->v19 step touches only `challenge`/`version`).
    expect(m.prestige).toEqual({ points: 3, totalEarned: 5, ascensions: 1, nodes: {} })
    expect(validateState(m).version).toBe(SAVE_VERSION)
  })

  it('preserves a challenge record a forward-compat v18 save already carries (known ids)', () => {
    const raw = rawV18()
    raw.challenge = { activeId: CHALLENGE_IDS[0], completed: { [CHALLENGE_IDS[1]]: 2 } }

    const m = migrate(raw)
    expect(m.version).toBe(SAVE_VERSION)
    expect(m.challenge).toEqual({ activeId: CHALLENGE_IDS[0], completed: { [CHALLENGE_IDS[1]]: 2 } })
    expect(validateState(m).version).toBe(SAVE_VERSION)
  })

  it('resets a non-object challenge field to the empty account', () => {
    for (const bad of ['nope', 5, null] as const) {
      const raw = rawV18()
      raw.challenge = bad
      const m = migrate(raw)
      expect(m.version).toBe(SAVE_VERSION)
      expect(m.challenge).toEqual({ activeId: null, completed: {} })
      expect(validateState(m).version).toBe(SAVE_VERSION)
    }
  })

  it('importSave of a v18 export backfills the empty challenge account and re-derives stats', () => {
    const restored = importSave(exportSave(rawV18() as never))
    expect(restored.version).toBe(SAVE_VERSION)
    expect(restored.challenge).toEqual({ activeId: null, completed: {} })
    // The carried prestige survived the migration too.
    expect(restored.prestige).toEqual({ points: 3, totalEarned: 5, ascensions: 1, nodes: {} })
  })
})

/**
 * A fresh v19 state with a NON-EMPTY challenge record: an ACTIVE challenge (its constraint
 * folds into the derived economy via effectiveMods) plus a COMPLETED challenge (its permanent
 * reward folds in too). recomputeDerived reconciles the derived stats with both. Built fresh
 * per test so the corruption mutations below never leak between cases.
 */
function challengeState(): GameState {
  const s = createInitialState('save-v19-chal', 1919)
  s.challenge = { activeId: CHALLENGE_IDS[0], completed: { [CHALLENGE_IDS[1]]: 2 } }
  recomputeDerived(s)
  return s
}

describe('challenge save — v19 round-trip', () => {
  it("an active productionMult constraint lowers the derived economy below the no-challenge base", () => {
    // Find a challenge whose constraint actually penalises production, generically.
    const prodChal = CHALLENGES.find(
      (c) => typeof c.constraint.productionMult === 'number' && c.constraint.productionMult < 1,
    )
    expect(prodChal).toBeDefined()
    const s = createInitialState('save-v19-econ', 77)
    s.challenge.activeId = (prodChal as { id: string }).id
    recomputeDerived(s)
    const base = createInitialState('save-v19-econ', 77) // same seed, no active challenge
    expect(s.villages.v0.production.wood.lt(base.villages.v0.production.wood)).toBe(true)
  })

  it('serialize/deserialize preserves the challenge record and the constraint-folded Decimals', () => {
    const state = challengeState()
    const json = serialize(state)
    const back = deserialize(json)

    expect(back.version).toBe(SAVE_VERSION)
    expect(back.challenge).toEqual({
      activeId: CHALLENGE_IDS[0],
      completed: { [CHALLENGE_IDS[1]]: 2 },
    })
    // The constraint/reward-folded derived Decimal survives the {$d} tag exactly.
    expect(back.villages.v0.production.wood.toString()).toBe(
      state.villages.v0.production.wood.toString(),
    )
    // serialize is idempotent across the round-trip (stable key order, re-tagged).
    expect(serialize(back)).toBe(json)
  })

  it('exportSave/importSave preserves the challenge record byte-identically', () => {
    const state = challengeState()
    const restored = importSave(exportSave(state))

    expect(restored.challenge).toEqual({
      activeId: CHALLENGE_IDS[0],
      completed: { [CHALLENGE_IDS[1]]: 2 },
    })
    // importSave re-derives from the restored challenge record (constraint + reward folded),
    // so the derived stats — and hence the whole serialization — are byte-identical.
    expect(serialize(restored)).toBe(serialize(state))
  })
})

describe('challenge save — validateState', () => {
  it('accepts a fresh empty record and an in-band non-empty challenge record', () => {
    const fresh = createInitialState('chal-valid', 1)
    expect(validateState(fresh)).toBe(fresh)
    expect(fresh.challenge).toEqual({ activeId: null, completed: {} })

    const s = challengeState()
    expect(validateState(s)).toBe(s)
  })

  it('rejects a missing / non-object challenge field or a non-object completed map', () => {
    const missing = challengeState()
    delete (missing as { challenge?: unknown }).challenge
    expect(() => validateState(missing)).toThrow()

    const wrong = challengeState()
    ;(wrong as { challenge: unknown }).challenge = 'nope'
    expect(() => validateState(wrong)).toThrow()

    const badCompleted = challengeState()
    ;(badCompleted.challenge as { completed: unknown }).completed = 'nope'
    expect(() => validateState(badCompleted)).toThrow()
  })

  it('rejects an unknown activeId', () => {
    const s = challengeState()
    s.challenge.activeId = 'not_a_real_challenge'
    expect(() => validateState(s)).toThrow()
  })

  it('rejects a non-string, non-null activeId', () => {
    for (const bad of [5, {}, true]) {
      const s = challengeState()
      ;(s.challenge as { activeId: unknown }).activeId = bad
      expect(() => validateState(s)).toThrow()
    }
  })

  it('rejects an unknown completed key', () => {
    const s = challengeState()
    s.challenge.completed = { not_a_real_challenge: 1 }
    expect(() => validateState(s)).toThrow()
  })

  it('rejects a negative or fractional completed count', () => {
    const neg = challengeState()
    neg.challenge.completed = { [CHALLENGE_IDS[0]]: -1 }
    expect(() => validateState(neg)).toThrow()

    const frac = challengeState()
    frac.challenge.completed = { [CHALLENGE_IDS[0]]: 1.5 }
    expect(() => validateState(frac)).toThrow()
  })
})

describe('challenge save — fresh state round-trip', () => {
  it('a fresh createInitialState round-trips byte-identically with an empty challenge record', () => {
    const state = createInitialState('chal-fresh', 2026)
    const restored = importSave(exportSave(state))
    expect(restored.challenge).toEqual({ activeId: null, completed: {} })
    expect(serialize(restored)).toBe(serialize(state))
    expect(validateState(restored)).toBe(restored)
  })
})
