import { describe, it, expect } from 'vitest'
import {
  createInitialState,
  recomputeDerived,
  INITIAL_UNITS,
  type GameState,
} from '../src/engine/state'
import { D } from '../src/engine/decimal'
import { BUILDINGS } from '../src/content/buildings'
import { type UnitId } from '../src/content/units'
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
 * M10 save-engine tests for the cavalry schema (v21). The full cross-version migration
 * chain lives in migration.test.ts; this file pins the four things the save engine owns
 * at v21:
 *
 *  1. v20 -> v21 MIGRATION — a pre-cavalry save (no `buildings.stable`, no `light_cavalry` /
 *     `heavy_cavalry` unit keys) backfills stable = 0 + both cavalry counts = 0 on EVERY
 *     village (and every in-flight march's roster), then validates.
 *  2. ROUND-TRIP — a v21 state with cavalry in the ROSTER and in an IN-FLIGHT march
 *     round-trips through serialize/deserialize AND exportSave/importSave, preserving the counts.
 *  3. validateState REJECTS a bad cavalry count (negative / fractional) — in the roster and in
 *     a march — and a bad stable building level.
 *  4. A fresh createInitialState carries stable 0 + cavalry 0 and round-trips byte-identically.
 */

const SEED = 'save-v20'

/** The two cavalry ids, iterated generically. */
const CAVALRY: readonly UnitId[] = ['light_cavalry', 'heavy_cavalry']

/**
 * A v20-shaped raw save (pre-cavalry). Built by serialising a real current-version state and
 * DOWNGRADING it: strip `stable` from every village's buildings, strip both cavalry keys from
 * every village's units (and every in-flight march's roster), stamp version 20. Tracking the
 * live state shape this way avoids hand-maintained field lists drifting. deserialize gives real
 * Decimal instances, exactly as a save off disk would after parsing.
 */
function rawV20(): Record<string, any> {
  const fresh = createInitialState(SEED, 4242)
  const raw = deserialize(serialize(fresh)) as unknown as Record<string, any>
  for (const id of raw.villageOrder) {
    const v = raw.villages[id]
    delete v.buildings.stable
    for (const c of CAVALRY) delete v.units[c]
    for (const m of v.marches) for (const c of CAVALRY) delete m.units[c]
  }
  raw.version = 20
  return raw
}

describe('cavalry save — v20 -> v21 migration backfill (M10)', () => {
  it('backfills stable=0 + cavalry counts=0 on every village, then validates', () => {
    const raw = rawV20()
    // Precondition: the v20 save genuinely lacks all three new keys on every village.
    for (const id of raw.villageOrder) {
      expect('stable' in raw.villages[id].buildings).toBe(false)
      for (const c of CAVALRY) expect(c in raw.villages[id].units).toBe(false)
    }

    const m = migrate(raw)
    expect(m.version).toBe(SAVE_VERSION)
    expect(m.version).toBe(24)

    for (const id of m.villageOrder) {
      expect(m.villages[id].buildings.stable).toBe(0)
      for (const c of CAVALRY) expect(m.villages[id].units[c]).toBe(0)
    }

    // And the whole migrated save validates (the new ids are covered by the BUILDING_IDS /
    // UNIT_IDS validation loops once backfilled).
    expect(validateState(m).version).toBe(SAVE_VERSION)
  })

  it('backfills the cavalry slots on an IN-FLIGHT march so the per-march UNIT_IDS check passes', () => {
    const raw = rawV20()
    // A pre-M10 march omits the cavalry keys; the migration fills them so validateState
    // (which iterates the now-longer UNIT_IDS over every march) does not reject it.
    raw.villages.v0.marches.push({
      kind: 'attack',
      targetType: 'camp',
      targetId: 'b0',
      targetLevel: 1,
      targetX: raw.villages.v0.x + 5,
      targetY: raw.villages.v0.y,
      units: { spearman: 3, swordsman: 0, axeman: 0, noble: 0, scout: 0, ram: 0, catapult: 0 },
      phase: 'outbound',
      remaining: 60,
      // Real Decimal instances: migrate() does NOT run the reviver, and validateState
      // value-checks march loot as Decimals (a { $d } DTO would be rejected).
      loot: { wood: D(0), clay: D(0), iron: D(0) },
    })

    const m = migrate(raw)
    const march = m.villages.v0.marches[0]
    for (const c of CAVALRY) expect(march.units[c]).toBe(0)
    expect(validateState(m).version).toBe(SAVE_VERSION)
  })

  it('importSave of a v20 export migrates to v21, sets the keys to 0 and validates', () => {
    const restored = importSave(exportSave(rawV20() as never))
    expect(restored.version).toBe(SAVE_VERSION)
    for (const id of restored.villageOrder) {
      expect(restored.villages[id].buildings.stable).toBe(0)
      for (const c of CAVALRY) expect(restored.villages[id].units[c]).toBe(0)
    }
  })
})

/**
 * A v21 state with cavalry standing in the ROSTER and a subset out on an IN-FLIGHT attack
 * march. The capital ('v0') has the Stajnia at level 2; 7 light + 4 heavy cavalry are owned,
 * and 3 light + 1 heavy ride out toward a camp. Built fresh per test so corruption mutations
 * never leak between cases.
 */
function cavalryState(seed = 'save-v21'): GameState {
  const s = createInitialState(seed, 1717)
  const cap = s.villages.v0
  cap.buildings.stable = 2
  recomputeDerived(s)
  cap.units.light_cavalry = 7
  cap.units.heavy_cavalry = 4
  // An in-flight attack march carrying a cavalry subset (a full UNIT_IDS roster, per the
  // March convention) toward a camp; loot empty (still outbound).
  const sent = { ...INITIAL_UNITS }
  sent.light_cavalry = 3
  sent.heavy_cavalry = 1
  cap.marches.push({
    kind: 'attack',
    targetType: 'camp',
    targetId: 'b0',
    targetLevel: 1,
    targetX: cap.x + 5,
    targetY: cap.y,
    units: sent,
    phase: 'outbound',
    remaining: 120,
    loot: { wood: D(0), clay: D(0), iron: D(0) },
  })
  return s
}

describe('cavalry save — v21 round-trip', () => {
  it('serialize/deserialize preserves cavalry counts in the roster and the in-flight march', () => {
    const s = cavalryState()
    const json = serialize(s)
    const back = deserialize(json)

    expect(back.version).toBe(SAVE_VERSION)
    expect(back.villages.v0.units.light_cavalry).toBe(7)
    expect(back.villages.v0.units.heavy_cavalry).toBe(4)
    const march = back.villages.v0.marches[0]
    expect(march.units.light_cavalry).toBe(3)
    expect(march.units.heavy_cavalry).toBe(1)

    // serialize is idempotent across the round-trip (stable key order).
    expect(serialize(back)).toBe(json)
  })

  it('exportSave/importSave preserves the roster + march cavalry byte-identically', () => {
    const s = cavalryState()
    const restored = importSave(exportSave(s))

    expect(restored.villages.v0.units.light_cavalry).toBe(7)
    expect(restored.villages.v0.units.heavy_cavalry).toBe(4)
    const march = restored.villages.v0.marches[0]
    expect(march.units.light_cavalry).toBe(3)
    expect(march.units.heavy_cavalry).toBe(1)
    // Byte-identical: derived fields were already consistent before export.
    expect(serialize(restored)).toBe(serialize(s))
  })
})

describe('cavalry save — validateState', () => {
  it('accepts a fresh state and a non-trivial cavalry state', () => {
    const fresh = createInitialState('valid', 1)
    expect(validateState(fresh)).toBe(fresh)
    const s = cavalryState()
    expect(validateState(s)).toBe(s)
  })

  it('rejects a bad cavalry count (negative / fractional) in the roster', () => {
    for (const c of CAVALRY) {
      for (const bad of [-1, 1.5]) {
        const s = cavalryState()
        s.villages.v0.units[c] = bad
        expect(() => validateState(s)).toThrow()
      }
    }
  })

  it('rejects a bad cavalry count (negative / fractional) on an in-flight march', () => {
    for (const c of CAVALRY) {
      for (const bad of [-1, 0.5]) {
        const s = cavalryState()
        s.villages.v0.marches[0].units[c] = bad
        expect(() => validateState(s)).toThrow()
      }
    }
  })

  it('rejects a bad stable building level (out of range / fractional)', () => {
    for (const level of [-1, BUILDINGS.stable.maxLevel + 1, 1.5]) {
      const s = cavalryState()
      s.villages.v0.buildings.stable = level
      expect(() => validateState(s)).toThrow()
    }
  })

  it('rejects a save MISSING the new keys entirely (the un-migrated v20 shape the backfill fixes)', () => {
    // The exact pre-migration shape v20->v21 exists to repair: a village whose buildings/roster
    // omit the new keys, or an in-flight march omitting the cavalry keys. validateState loops
    // BUILDING_IDS/UNIT_IDS over villages AND marches, so a missing key must be rejected.
    const noStable = cavalryState()
    delete (noStable.villages.v0.buildings as Record<string, number>).stable
    expect(() => validateState(noStable)).toThrow()

    for (const c of CAVALRY) {
      const noRoster = cavalryState()
      delete (noRoster.villages.v0.units as Record<string, number>)[c]
      expect(() => validateState(noRoster)).toThrow()

      const noMarch = cavalryState()
      delete (noMarch.villages.v0.marches[0].units as Record<string, number>)[c]
      expect(() => validateState(noMarch)).toThrow()
    }
  })
})

describe('cavalry save — fresh state round-trip', () => {
  it('a fresh createInitialState carries stable 0 + cavalry 0 and round-trips byte-identically', () => {
    const s = createInitialState('cav-fresh', 2026)
    expect(s.villages.v0.buildings.stable).toBe(0)
    for (const c of CAVALRY) expect(s.villages.v0.units[c]).toBe(0)

    const restored = importSave(exportSave(s))
    expect(serialize(restored)).toBe(serialize(s))
    expect(validateState(restored).version).toBe(SAVE_VERSION)
  })
})
