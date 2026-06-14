import { describe, it, expect } from 'vitest'
import { D, Decimal } from '../src/engine/decimal'
import {
  createInitialState,
  INITIAL_BUILDINGS,
  INITIAL_UNITS,
  recomputeDerived,
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
import { BUILDING_IDS } from '../src/content/buildings'
import { UNIT_IDS } from '../src/content/units'

/**
 * A raw v1 save: the pre-buildings shape. It has flat production / storageCap but
 * no `buildings` and no `popCap` — exactly the fields the v1->v2 migration adds.
 * Decimals are real Decimal instances, as they would be after `deserialize`.
 */
function rawV1() {
  return {
    version: 1,
    seed: 'legacy',
    rngState: 12345,
    createdAt: 1000,
    lastSeen: 2000,
    resources: { wood: D(100), clay: D(200), iron: D(300) },
    production: { wood: D(1), clay: D(0.8), iron: D(0.5) },
    storageCap: D(1000),
  }
}

describe('migration v1 -> current', () => {
  it('migrate() chains v1->v2->v3: seeds buildings, popCap, units and the queue', () => {
    const migrated = migrate(rawV1())

    expect(migrated.version).toBe(3)
    expect(migrated.version).toBe(SAVE_VERSION)
    expect(migrated.buildings).toEqual(INITIAL_BUILDINGS)
    expect(migrated.popCap instanceof Decimal).toBe(true)
    expect(migrated.popCap.toString()).toBe('0')
    // v2->v3 fields added by the chained migration.
    expect(migrated.units).toEqual(INITIAL_UNITS)
    expect(migrated.recruitQueue).toEqual([])
    // Pre-existing fields are carried through untouched.
    expect(migrated.seed).toBe('legacy')
    expect(migrated.resources.wood.toString()).toBe('100')
  })

  it('a migrated v1 save passes validateState', () => {
    const validated = validateState(migrate(rawV1()))
    expect(validated.version).toBe(SAVE_VERSION)
    for (const id of BUILDING_IDS) {
      expect(validated.buildings[id]).toBe(INITIAL_BUILDINGS[id])
    }
  })

  it('importSave of a v1 export re-derives production/cap from buildings', () => {
    // Encode the raw v1 object exactly as exportSave would (tagged Decimals).
    const b64 = exportSave(rawV1() as never)
    const state = importSave(b64)

    expect(state.version).toBe(SAVE_VERSION)
    expect(state.buildings).toEqual(INITIAL_BUILDINGS)

    // recomputeDerived ran on import: cached fields match the level-1 buildings,
    // NOT the stale flat values baked into the v1 save.
    expect(state.production.wood.toString()).toBe('1')
    expect(state.production.clay.toString()).toBe('0.8')
    expect(state.production.iron.toString()).toBe('0.5')
    expect(state.storageCap.toString()).toBe('4000') // 1000 + 3000 (warehouse lvl 1)
    expect(state.popCap.toString()).toBe('22') // 10 + 12 (farm lvl 1)

    // Independently recomputing the imported state changes nothing — it was already
    // consistent — which is the invariant importSave guarantees.
    const cap = state.storageCap.toString()
    recomputeDerived(state)
    expect(state.storageCap.toString()).toBe(cap)
  })
})

/**
 * A raw v2 save: the pre-units shape. Full buildings economy and popCap, but no
 * `units`, no `recruitQueue`, and — being from before the barracks existed — no
 * `barracks` key in `buildings`. Exactly what the v2->v3 migration must backfill.
 */
function rawV2() {
  return {
    version: 2,
    seed: 'v2',
    rngState: 999,
    createdAt: 1000,
    lastSeen: 2000,
    resources: { wood: D(10), clay: D(20), iron: D(30) },
    production: { wood: D(1), clay: D(0.8), iron: D(0.5) },
    storageCap: D(26000),
    popCap: D(22),
    buildings: { hq: 1, sawmill: 1, clay_pit: 1, iron_mine: 1, warehouse: 1, farm: 1 },
  }
}

describe('migration v2 -> v3', () => {
  it('seeds empty units, an empty queue and the new barracks building', () => {
    const m = migrate(rawV2())

    expect(m.version).toBe(SAVE_VERSION)
    expect(m.units).toEqual(INITIAL_UNITS)
    expect(m.recruitQueue).toEqual([])
    // Pre-existing levels preserved; the new building seeded at its initial level.
    expect(m.buildings.sawmill).toBe(1)
    expect(m.buildings.barracks).toBe(0)
  })

  it('a migrated v2 save passes validateState', () => {
    const v = validateState(migrate(rawV2()))
    expect(v.version).toBe(SAVE_VERSION)
    for (const id of UNIT_IDS) expect(v.units[id]).toBe(0)
    expect(Array.isArray(v.recruitQueue)).toBe(true)
  })
})

describe('save v2 round-trip', () => {
  it('serialize(deserialize(serialize(s))) === serialize(s) for a fresh v2 state', () => {
    const state = createInitialState('rt', 5000)
    const json = serialize(state)
    expect(serialize(deserialize(json))).toBe(json)
  })

  it('preserves building levels across export/import', () => {
    const state = createInitialState('levels', 7000)
    state.buildings.sawmill = 7
    state.buildings.warehouse = 3
    recomputeDerived(state)

    const restored = importSave(exportSave(state))
    expect(restored.buildings.sawmill).toBe(7)
    expect(restored.buildings.warehouse).toBe(3)
    expect(serialize(restored)).toBe(serialize(state))
  })

  it('faithfully round-trips a v3 save with owned units and a non-empty queue', () => {
    const state = createInitialState('army', 9000)
    state.buildings.barracks = 2
    recomputeDerived(state)
    // Trained roster + an in-flight training order (snapshotted per-unit time).
    state.units.spearman = 3
    state.units.axeman = 1
    state.recruitQueue = [
      { unitId: 'spearman', count: 2, remaining: 40, perUnitSeconds: 76 },
      { unitId: 'swordsman', count: 1, remaining: 110, perUnitSeconds: 110 },
    ]

    // validateState accepts the populated units + queue (no throw).
    expect(validateState(state).version).toBe(SAVE_VERSION)

    const restored = importSave(exportSave(state))
    expect(restored.units).toEqual(state.units)
    expect(restored.recruitQueue).toEqual(state.recruitQueue)
    // Plain-number queue/units carry no Decimal tags, so the bytes match exactly.
    expect(serialize(restored)).toBe(serialize(state))
  })
})
