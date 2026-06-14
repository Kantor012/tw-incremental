import { describe, it, expect } from 'vitest'
import { createInitialState } from '../src/engine/state'
import {
  serialize,
  deserialize,
  exportSave,
  importSave,
  migrate,
  loadFromLocal,
  SAVE_VERSION,
} from '../src/engine/save'

describe('save', () => {
  it('round-trips serialize/deserialize preserving Decimals and fields', () => {
    const state = createInitialState('test-seed', 1000)
    const json = serialize(state)
    const back = deserialize(json)

    expect(back.resources.wood.toString()).toBe(state.resources.wood.toString())
    expect(back.resources.clay.toString()).toBe(state.resources.clay.toString())
    expect(back.resources.iron.toString()).toBe(state.resources.iron.toString())
    expect(back.storageCap.toString()).toBe(state.storageCap.toString())

    expect(back.version).toBe(state.version)
    expect(back.seed).toBe(state.seed)
    expect(back.rngState).toBe(state.rngState)
    expect(back.createdAt).toBe(state.createdAt)
    expect(back.lastSeen).toBe(state.lastSeen)
    expect(back.production).toEqual(state.production)

    // serialize must be idempotent across a round-trip.
    expect(serialize(back)).toBe(json)
  })

  it('round-trips exportSave/importSave equal to serialize', () => {
    const state = createInitialState('export-seed', 2000)
    const restored = importSave(exportSave(state))
    expect(serialize(restored)).toBe(serialize(state))
  })

  it('migrates a v0 save up to the current version', () => {
    const migrated = migrate({ version: 0, seed: 'legacy' })
    expect(migrated.version).toBe(SAVE_VERSION)
  })

  it('returns null from loadFromLocal when localStorage is unavailable', () => {
    expect(loadFromLocal()).toBe(null)
  })
})
