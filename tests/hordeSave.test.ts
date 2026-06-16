import { describe, it, expect } from 'vitest'
import { createInitialState, HORDE_INTERVAL, type GameState } from '../src/engine/state'
import {
  serialize,
  deserialize,
  exportSave,
  importSave,
  migrate,
  validateState,
  SAVE_VERSION,
} from '../src/engine/save'

/**
 * M7.2 save-engine tests for the horde schema (v18). The cross-version migration chain
 * through v17 lives in migration.test.ts; this file pins the four things the save engine
 * owns at v18:
 *
 *  1. v17 -> v18 MIGRATION — a pre-horde save (no `horde`, no `stats.hordesRepelled`,
 *     no `stats.hordesBreached`) backfills `horde: { timer: HORDE_INTERVAL, level: 0 }`
 *     (the first horde a full interval out, escalation reset) and seeds both trophy
 *     counters to 0, then validates.
 *  2. ROUND-TRIP — a non-trivial v18 state (an armed/escalated horde clock + two horde
 *     battle reports) round-trips byte-for-byte through serialize/deserialize AND
 *     exportSave/importSave, preserving `state.horde` and the two horde stats.
 *  3. validateState REJECTS a malformed horde (negative/NaN timer, fractional/negative
 *     level, missing/non-object horde) and malformed horde stats.
 *  4. A fresh createInitialState carries an armed horde clock and round-trips byte-identically.
 */

const SEED = 'save-v17'

/**
 * A v17-shaped raw save (pre-horde). Built by serialising a real current-version state and
 * DOWNGRADING it: strip `horde`, strip the two horde stats, stamp version 17. Tracking the
 * live state shape this way avoids hand-maintained field lists drifting. deserialize gives
 * real Decimal instances, exactly as a save off disk would after parsing.
 */
function rawV17(): Record<string, any> {
  const fresh = createInitialState(SEED, 4242)
  const raw = deserialize(serialize(fresh)) as unknown as Record<string, any>
  // Downgrade to the v17 shape.
  delete raw.horde
  delete raw.stats.hordesRepelled
  delete raw.stats.hordesBreached
  raw.version = 17
  return raw
}

describe('horde save — v17 -> v18 migration backfill (M7.2)', () => {
  it('backfills horde {timer:HORDE_INTERVAL, level:0} and the two horde stats, then validates', () => {
    const raw = rawV17()
    // Precondition: the v17 save genuinely lacks all three new bits.
    expect('horde' in raw).toBe(false)
    expect('hordesRepelled' in raw.stats).toBe(false)
    expect('hordesBreached' in raw.stats).toBe(false)

    const m = migrate(raw)
    expect(m.version).toBe(SAVE_VERSION)
    expect(m.version).toBe(20)

    // The horde clock starts a full interval out with escalation reset.
    expect(m.horde).toEqual({ timer: HORDE_INTERVAL, level: 0 })
    // The lifetime trophy counters start at zero (no recoverable trace on an old save).
    expect(m.stats.hordesRepelled).toBe(0)
    expect(m.stats.hordesBreached).toBe(0)

    // And the whole migrated save validates.
    expect(validateState(m).version).toBe(SAVE_VERSION)
  })

  it('preserves a horde a forward-compat v17 save already carries', () => {
    const raw = rawV17()
    raw.horde = { timer: 5000, level: 3 }
    const m = migrate(raw)
    expect(m.version).toBe(SAVE_VERSION)
    expect(m.horde).toEqual({ timer: 5000, level: 3 }) // carried verbatim, not reset
    expect(validateState(m).version).toBe(SAVE_VERSION)
  })

  it('importSave of a v17 export migrates to v18 and validates', () => {
    const restored = importSave(exportSave(rawV17() as never))
    expect(restored.version).toBe(SAVE_VERSION)
    expect(restored.horde).toEqual({ timer: HORDE_INTERVAL, level: 0 })
    expect(restored.stats.hordesRepelled).toBe(0)
    expect(restored.stats.hordesBreached).toBe(0)
  })
})

/**
 * A v18 state with NON-TRIVIAL horde state: an armed, escalated clock, non-zero trophy
 * counters and two horde battle reports (a repel + a breach). Built fresh per test so the
 * corruption mutations below never leak between cases.
 */
function hordeState(): GameState {
  const s = createInitialState('save-v18', 1717)
  s.horde = { timer: 7777, level: 4 }
  s.stats.hordesRepelled = 6
  s.stats.hordesBreached = 2
  s.battleLog.push(
    { kind: 'horde', villageId: 'v0', won: true, looted: '0', losses: 0, luck: 1.1 },
    { kind: 'horde', villageId: 'v0', won: false, looted: '480', losses: 3 },
  )
  return s
}

describe('horde save — v18 round-trip', () => {
  it('serialize/deserialize preserves state.horde, the horde stats and the horde reports', () => {
    const s = hordeState()
    const json = serialize(s)
    const back = deserialize(json)

    expect(back.version).toBe(SAVE_VERSION)
    expect(back.horde).toEqual({ timer: 7777, level: 4 })
    expect(back.stats.hordesRepelled).toBe(6)
    expect(back.stats.hordesBreached).toBe(2)

    const reports = back.battleLog.filter((r) => r.kind === 'horde')
    expect(reports.length).toBe(2)
    expect(reports[0]).toMatchObject({ kind: 'horde', won: true, looted: '0', losses: 0, luck: 1.1 })
    expect(reports[1]).toMatchObject({ kind: 'horde', won: false, looted: '480', losses: 3 })

    // serialize is idempotent across the round-trip (stable key order).
    expect(serialize(back)).toBe(json)
  })

  it('exportSave/importSave preserves the horde state byte-identically', () => {
    const s = hordeState()
    const restored = importSave(exportSave(s))

    expect(restored.horde).toEqual(s.horde)
    expect(restored.stats.hordesRepelled).toBe(6)
    expect(restored.stats.hordesBreached).toBe(2)
    // Byte-identical: derived fields were already consistent before export.
    expect(serialize(restored)).toBe(serialize(s))
  })
})

describe('horde save — validateState', () => {
  it('accepts a fresh state and a non-trivial horde state', () => {
    const fresh = createInitialState('valid', 1)
    expect(validateState(fresh)).toBe(fresh)
    const s = hordeState()
    expect(validateState(s)).toBe(s)
  })

  it('rejects a missing or non-object horde', () => {
    const missing = hordeState()
    delete (missing as { horde?: unknown }).horde
    expect(() => validateState(missing)).toThrow()

    const wrong = hordeState()
    ;(wrong as { horde: unknown }).horde = 'nope'
    expect(() => validateState(wrong)).toThrow()
  })

  it('rejects a bad horde timer (negative / NaN / Infinity)', () => {
    for (const timer of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const bad = hordeState()
      bad.horde.timer = timer
      expect(() => validateState(bad)).toThrow()
    }
  })

  it('rejects a bad horde level (negative / fractional / non-finite)', () => {
    for (const level of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      const bad = hordeState()
      bad.horde.level = level
      expect(() => validateState(bad)).toThrow()
    }
  })

  it('rejects malformed horde stats (negative / fractional / non-finite / non-number)', () => {
    for (const key of ['hordesRepelled', 'hordesBreached'] as const) {
      for (const value of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, '3' as unknown as number]) {
        const bad = hordeState()
        ;(bad.stats as unknown as Record<string, unknown>)[key] = value
        expect(() => validateState(bad)).toThrow()
      }
    }
  })
})

describe('horde save — fresh state round-trip', () => {
  it('a fresh createInitialState carries an armed horde clock and round-trips byte-identically', () => {
    const s = createInitialState('horde-fresh', 2026)
    expect(s.horde).toEqual({ timer: HORDE_INTERVAL, level: 0 })
    expect(s.stats.hordesRepelled).toBe(0)
    expect(s.stats.hordesBreached).toBe(0)

    const restored = importSave(exportSave(s))
    expect(restored.horde).toEqual(s.horde)
    expect(serialize(restored)).toBe(serialize(s))
    expect(validateState(restored)).toBe(restored)
  })
})
