import { describe, it, expect } from 'vitest'
import { createInitialState } from '../src/engine/state'
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

describe('save', () => {
  it('round-trips serialize/deserialize preserving Decimals and fields (v5)', () => {
    const state = createInitialState('test-seed', 1000)
    const json = serialize(state)
    const back = deserialize(json)

    // Global header round-trips.
    expect(back.version).toBe(state.version)
    expect(back.seed).toBe(state.seed)
    expect(back.rngState).toBe(state.rngState)
    expect(back.createdAt).toBe(state.createdAt)
    expect(back.lastSeen).toBe(state.lastSeen)

    // The multi-village structure round-trips: same ordering and the exact same set
    // of village keys, in correspondence with villageOrder.
    expect(back.villageOrder).toEqual(state.villageOrder)
    expect(Object.keys(back.villages)).toEqual(Object.keys(state.villages))
    expect(back.villageOrder).toEqual(['v0'])

    // Nested Decimals inside each village survive the JSON tag/round-trip loss-free.
    for (const id of state.villageOrder) {
      const v = state.villages[id]
      const r = back.villages[id]
      expect(r.id).toBe(v.id)
      expect(r.name).toBe(v.name)

      expect(r.resources.wood.toString()).toBe(v.resources.wood.toString())
      expect(r.resources.clay.toString()).toBe(v.resources.clay.toString())
      expect(r.resources.iron.toString()).toBe(v.resources.iron.toString())

      expect(r.production.wood.toString()).toBe(v.production.wood.toString())
      expect(r.production.clay.toString()).toBe(v.production.clay.toString())
      expect(r.production.iron.toString()).toBe(v.production.iron.toString())

      expect(r.storageCap.toString()).toBe(v.storageCap.toString())
      expect(r.popCap.toString()).toBe(v.popCap.toString())

      expect(r.buildings).toEqual(v.buildings)
      expect(r.units).toEqual(v.units)
      expect(r.recruitQueue).toEqual(v.recruitQueue)
      expect(r.marches).toEqual(v.marches)
      expect(r.raidTimer).toBe(v.raidTimer)
    }

    expect(back.battleLog).toEqual(state.battleLog)

    // serialize must be idempotent across a round-trip.
    expect(serialize(back)).toBe(json)
  })

  it('round-trips exportSave/importSave equal to serialize', () => {
    const state = createInitialState('export-seed', 2000)
    const restored = importSave(exportSave(state))
    expect(serialize(restored)).toBe(serialize(state))
  })

  it('validateState accepts a fresh v5 state and returns it', () => {
    const state = createInitialState('valid-seed', 3000)
    expect(validateState(state)).toBe(state)
  })

  it('validateState rejects a broken villages/villageOrder bijection', () => {
    const state = createInitialState('bijection-seed', 3500)
    // An ordered id with no matching village must be rejected (the tick would
    // otherwise reference a missing entry).
    state.villageOrder.push('v1')
    expect(() => validateState(state)).toThrow()
  })

  it('migrates a v0 save up to the current version', () => {
    const migrated = migrate({ version: 0, seed: 'legacy' })
    expect(migrated.version).toBe(SAVE_VERSION)
  })

  it('migrates a v4 single-village save into the v5 multi-village shape', () => {
    // Build a v4-shaped raw save by flattening a fresh capital's economy to the top
    // level (exactly where v4 kept the nine per-village fields), with a legacy global
    // battle report that carries no villageId yet.
    const seed = createInitialState('migrate-seed', 100)
    const cap = seed.villages.v0
    const v4: any = {
      version: 4,
      seed: 'migrate-seed',
      rngState: seed.rngState,
      createdAt: 100,
      lastSeen: 100,
      resources: cap.resources,
      production: cap.production,
      storageCap: cap.storageCap,
      popCap: cap.popCap,
      buildings: cap.buildings,
      units: cap.units,
      recruitQueue: cap.recruitQueue,
      marches: cap.marches,
      raidTimer: cap.raidTimer,
      battleLog: [{ kind: 'raid', won: true, looted: '123', losses: 0 }],
    }

    const migrated = validateState(migrate(v4))
    expect(migrated.version).toBe(SAVE_VERSION)
    expect(migrated.villageOrder).toEqual(['v0'])
    expect(Object.keys(migrated.villages)).toEqual(['v0'])

    const v0 = migrated.villages.v0
    expect(v0.id).toBe('v0')
    expect(v0.name).toBe('Stolica')
    // The economy (including nested Decimals) is carried over verbatim.
    expect(v0.resources.wood.toString()).toBe(cap.resources.wood.toString())
    expect(v0.storageCap.toString()).toBe(cap.storageCap.toString())
    expect(v0.buildings).toEqual(cap.buildings)

    // The global battle log gains the villageId stamp.
    expect(migrated.battleLog[0].villageId).toBe('v0')
  })

  it('returns null from loadFromLocal when localStorage is unavailable', () => {
    expect(loadFromLocal()).toBe(null)
  })
})
