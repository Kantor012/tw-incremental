import { describe, it, expect } from 'vitest'
import { simulate } from '../src/engine/tick'
import { createInitialState } from '../src/engine/state'
import { serialize } from '../src/engine/save'

describe('simulate', () => {
  it('accrues production * dt for each resource', () => {
    const state = createInitialState('sim', 0)
    simulate(state, 10)
    // wood 50 + 1*10, clay 50 + 0.8*10, iron 50 + 0.5*10
    expect(state.resources.wood.toString()).toBe('60')
    expect(state.resources.clay.toString()).toBe('58')
    expect(state.resources.iron.toString()).toBe('55')
  })

  it('clamps resources to the storage cap', () => {
    const state = createInitialState('sim', 0)
    // Advance far enough that the fastest resource (wood) overshoots the cap.
    simulate(state, state.storageCap.toNumber() * 2)
    expect(state.resources.wood.toString()).toBe(state.storageCap.toString())
    expect(state.resources.wood.lte(state.storageCap)).toBe(true)
    expect(state.resources.clay.lte(state.storageCap)).toBe(true)
    expect(state.resources.iron.lte(state.storageCap)).toBe(true)
  })

  it('does nothing when dtSeconds <= 0', () => {
    const state = createInitialState('sim', 0)
    const before = serialize(state)
    simulate(state, 0)
    simulate(state, -5)
    expect(serialize(state)).toBe(before)
  })

  it('is deterministic for identical states and dt', () => {
    const a = createInitialState('seed', 1000)
    const b = createInitialState('seed', 1000)
    simulate(a, 42)
    simulate(b, 42)
    expect(serialize(a)).toBe(serialize(b))
  })
})
