import { describe, it, expect } from 'vitest'
import { D, Decimal } from '../src/engine/decimal'
import {
  createInitialState,
  INITIAL_BUILDINGS,
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

describe('migration v1 -> v2', () => {
  it('migrate() stamps version 2 and seeds buildings + popCap', () => {
    const migrated = migrate(rawV1())

    expect(migrated.version).toBe(2)
    expect(migrated.version).toBe(SAVE_VERSION)
    expect(migrated.buildings).toEqual(INITIAL_BUILDINGS)
    expect(migrated.popCap instanceof Decimal).toBe(true)
    expect(migrated.popCap.toString()).toBe('0')
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
    expect(state.storageCap.toString()).toBe('26000') // 1000 + 25000 (warehouse lvl 1)
    expect(state.popCap.toString()).toBe('22') // 10 + 12 (farm lvl 1)

    // Independently recomputing the imported state changes nothing — it was already
    // consistent — which is the invariant importSave guarantees.
    const cap = state.storageCap.toString()
    recomputeDerived(state)
    expect(state.storageCap.toString()).toBe(cap)
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
})
