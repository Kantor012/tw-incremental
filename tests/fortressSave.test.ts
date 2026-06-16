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
import { sendAttack, sendScout } from '../src/systems/marches'
import { generateWorld, fortressById } from '../src/systems/world'
import { FORTRESS_COUNT } from '../src/content/fortresses'
import { type UnitId } from '../src/content/units'

/**
 * M7 save-engine tests for the fortress schema (v17). The cross-version migration chain
 * through v16 lives in migration.test.ts; this file pins the four things the save engine
 * owns at v17:
 *
 *  1. v16 -> v17 MIGRATION — a pre-fortress save (no `world.fortresses`, no
 *     `march.targetType`, no `stats.fortressesRazed`) backfills the fortress array
 *     DETERMINISTICALLY from the seed (leaving the barbarians untouched), stamps every
 *     march `targetType: 'camp'` and seeds the trophy counter to 0, then validates.
 *  2. ROUND-TRIP — a non-trivial v17 state (a razed fortress + a fortress-target march)
 *     round-trips byte-for-byte through serialize/deserialize AND exportSave/importSave,
 *     preserving the fortress list, the `razed` flags and `march.targetType`.
 *  3. validateState REJECTS a malformed fortress (non-finite coord, bad level, non-boolean
 *     razed) and a bad `march.targetType`.
 *  4. A fresh createInitialState round-trips byte-identically with FORTRESS_COUNT fresh
 *     fortresses.
 *
 * Fortresses are referenced GENERICALLY (FORTRESS_COUNT / fortressById / iterate the array)
 * so content retuning of the level scheme cannot rot these tests.
 */

const SEED = 'save-v16'

/** A full (all UnitId present) roster snapshot. */
function army(
  spearman = 0,
  swordsman = 0,
  axeman = 0,
  noble = 0,
  scout = 0,
  ram = 0,
  catapult = 0,
): Record<UnitId, number> {
  return { spearman, swordsman, axeman, noble, scout, ram, catapult }
}

/**
 * A v16-shaped raw save (pre-fortress). Built by serialising a real current-version state
 * — with two in-flight CAMP marches (an attack + a scout) so the targetType backfill has
 * something to do — and DOWNGRADING it: strip `world.fortresses`, strip every
 * `march.targetType`, strip `stats.fortressesRazed`, stamp version 16. Tracking the live
 * roster/world shape this way avoids hand-maintained building/unit lists drifting.
 * deserialize gives real Decimal instances, exactly as a save off disk would after parsing.
 */
function rawV16(): Record<string, any> {
  const fresh = createInitialState(SEED, 4242)
  const v = fresh.villages.v0
  v.buildings.barracks = 1
  recomputeDerived(fresh)
  v.units = army(0, 0, 4, 0, 3) // axemen to attack, scouts to recon
  const campId = fresh.world.barbarians[0].id
  // Real engine-built marches (so the shapes are valid), both camp targets pre-M7.
  expect(sendAttack(v, fresh.world, fresh.battleLog, campId, army(0, 0, 2))).toBe(true)
  expect(sendScout(v, fresh.world, fresh.battleLog, campId, 1)).toBe(true)

  const raw = deserialize(serialize(fresh)) as unknown as Record<string, any>
  // Downgrade to the v16 shape.
  delete raw.world.fortresses
  for (const id of raw.villageOrder as string[]) {
    for (const m of raw.villages[id].marches) delete m.targetType
  }
  delete raw.stats.fortressesRazed
  raw.version = 16
  return raw
}

describe('fortress save — v16 -> v17 migration backfill (M7)', () => {
  it('backfills the fortress array from the seed, every march.targetType=camp and the trophy stat', () => {
    const raw = rawV16()
    // Precondition: the v16 save genuinely lacks all three new bits.
    expect('fortresses' in raw.world).toBe(false)
    expect(raw.villages.v0.marches.every((m: any) => m.targetType === undefined)).toBe(true)
    expect('fortressesRazed' in raw.stats).toBe(false)

    const m = migrate(raw)
    expect(m.version).toBe(SAVE_VERSION)
    expect(m.version).toBe(19)

    // Fortresses are regenerated DETERMINISTICALLY from the seed (own rng stream).
    expect(Array.isArray(m.world.fortresses)).toBe(true)
    expect(m.world.fortresses.length).toBe(FORTRESS_COUNT)
    expect(m.world.fortresses).toEqual(generateWorld(SEED).fortresses)
    expect(m.world.fortresses.every((f: any) => f.razed === false)).toBe(true)

    // The barbarian world is left BYTE-IDENTICAL (the backfill never touches that stream).
    expect(m.world.barbarians).toEqual(generateWorld(SEED).barbarians)

    // Every pre-M7 march is a camp attack/scout.
    for (const m2 of m.villages.v0.marches) expect(m2.targetType).toBe('camp')

    // The lifetime trophy counter starts at zero.
    expect(m.stats.fortressesRazed).toBe(0)

    // And the whole migrated save validates.
    expect(validateState(m).version).toBe(SAVE_VERSION)
  })

  it('preserves a fortress array a forward-compat v16 save already carries', () => {
    const raw = rawV16()
    raw.world.fortresses = [
      { id: 'f0', x: 10, y: 20, level: 35, name: 'Forteca (poz. 35)', razed: true },
      { id: 'f1', x: 30, y: 40, level: 40, name: 'Forteca (poz. 40)', razed: false },
    ]
    const m = migrate(raw)
    expect(m.version).toBe(SAVE_VERSION)
    // Carried verbatim (NOT regenerated from the seed), razed flag intact.
    expect(m.world.fortresses).toEqual(raw.world.fortresses)
    expect(validateState(m).version).toBe(SAVE_VERSION)
  })

  it('importSave of a v16 export migrates to v17 and validates', () => {
    const restored = importSave(exportSave(rawV16() as never))
    expect(restored.version).toBe(SAVE_VERSION)
    expect(restored.world.fortresses.length).toBe(FORTRESS_COUNT)
    expect(restored.stats.fortressesRazed).toBe(0)
    for (const m of restored.villages.v0.marches) expect(m.targetType).toBe('camp')
  })
})

/**
 * A fresh v17 state with NON-TRIVIAL fortress state: fortress 'f0' razed, and an in-flight
 * fortress-target assault aimed at the unrazed 'f1'. Built fresh per test so the corruption
 * mutations below never leak between cases.
 */
function fortressState(): GameState {
  const s = createInitialState('save-v17', 1717)
  const v = s.villages.v0
  v.buildings.barracks = 1
  recomputeDerived(s)
  fortressById(s.world, 'f0')!.razed = true
  v.units = army(0, 0, 10)
  expect(sendAttack(v, s.world, s.battleLog, 'f1', army(0, 0, 10), undefined, 'fortress')).toBe(true)
  return s
}

describe('fortress save — v17 round-trip', () => {
  it('serialize/deserialize preserves the fortress list, razed flags and march.targetType', () => {
    const state = fortressState()
    const json = serialize(state)
    const back = deserialize(json)

    expect(back.version).toBe(SAVE_VERSION)
    expect(back.world.fortresses).toEqual(state.world.fortresses)
    expect(fortressById(back.world, 'f0')!.razed).toBe(true)
    expect(fortressById(back.world, 'f1')!.razed).toBe(false)
    // The fortress-target march survived with its discriminant.
    const march = back.villages.v0.marches[0]
    expect(march.targetType).toBe('fortress')
    expect(march.targetId).toBe('f1')
    // serialize is idempotent across the round-trip (stable key order, re-tagged Decimals).
    expect(serialize(back)).toBe(json)
  })

  it('exportSave/importSave preserves the fortress state byte-identically', () => {
    const state = fortressState()
    const restored = importSave(exportSave(state))

    expect(restored.world.fortresses).toEqual(state.world.fortresses)
    expect(fortressById(restored.world, 'f0')!.razed).toBe(true)
    expect(restored.villages.v0.marches[0].targetType).toBe('fortress')
    // Byte-identical: derived fields were already consistent before export.
    expect(serialize(restored)).toBe(serialize(state))
  })
})

describe('fortress save — validateState', () => {
  it('accepts a fresh state and a non-trivial fortress state', () => {
    const fresh = createInitialState('valid', 1)
    expect(validateState(fresh)).toBe(fresh)
    const s = fortressState()
    expect(validateState(s)).toBe(s)
  })

  it('rejects a missing or non-array world.fortresses', () => {
    const missing = fortressState()
    delete (missing.world as { fortresses?: unknown }).fortresses
    expect(() => validateState(missing)).toThrow()

    const wrong = fortressState()
    ;(wrong.world as { fortresses: unknown }).fortresses = 'nope'
    expect(() => validateState(wrong)).toThrow()
  })

  it('rejects a non-finite fortress coordinate', () => {
    for (const coord of ['x', 'y'] as const) {
      const bad = fortressState()
      bad.world.fortresses[0][coord] = Number.POSITIVE_INFINITY
      expect(() => validateState(bad)).toThrow()

      const nan = fortressState()
      nan.world.fortresses[0][coord] = Number.NaN
      expect(() => validateState(nan)).toThrow()
    }
  })

  it('rejects a bad fortress level (zero, negative or non-integer)', () => {
    for (const level of [0, -1, 1.5] as const) {
      const bad = fortressState()
      bad.world.fortresses[0].level = level
      expect(() => validateState(bad)).toThrow()
    }
  })

  it('rejects a non-boolean razed flag', () => {
    const bad = fortressState()
    ;(bad.world.fortresses[0] as { razed: unknown }).razed = 'yes'
    expect(() => validateState(bad)).toThrow()
  })

  it('rejects a bad march.targetType', () => {
    const bad = fortressState()
    ;(bad.villages.v0.marches[0] as { targetType: unknown }).targetType = 'bogus'
    expect(() => validateState(bad)).toThrow()
  })

  it('rejects a malformed stats.fortressesRazed (negative / fractional / non-finite)', () => {
    // The lifetime trophy counter is a non-negative integer; a corrupt value must be
    // rejected before it can be autosaved (CLAUDE.md hard rule #3), mirroring campsRazed.
    for (const v of [-1, 1.5, NaN, Infinity, '3' as unknown as number]) {
      const bad = fortressState()
      ;(bad.stats as { fortressesRazed: unknown }).fortressesRazed = v
      expect(() => validateState(bad)).toThrow()
    }
  })
})

describe('fortress save — fresh state round-trip', () => {
  it('a fresh createInitialState round-trips byte-identically with FORTRESS_COUNT fresh fortresses', () => {
    const state = createInitialState('fort-fresh', 2026)
    expect(state.world.fortresses.length).toBe(FORTRESS_COUNT)
    expect(state.world.fortresses.every((f) => f.razed === false)).toBe(true)
    expect(state.stats.fortressesRazed).toBe(0)

    const restored = importSave(exportSave(state))
    expect(restored.world.fortresses).toEqual(state.world.fortresses)
    expect(serialize(restored)).toBe(serialize(state))
    expect(validateState(restored)).toBe(restored)
  })
})
