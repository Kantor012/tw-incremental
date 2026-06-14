import { describe, it, expect } from 'vitest'
import { simulate } from '../src/engine/tick'
import { createInitialState, type GameState, type Village } from '../src/engine/state'
import { serialize } from '../src/engine/save'

/**
 * Since M2.1 the economy is per-village: production / resources / storageCap live on
 * each {@link Village}, not on {@link GameState}. A fresh run still has exactly one
 * village (the capital), so these tests read the first village in `villageOrder` —
 * the same one createInitialState seeds as `v0` ("Stolica") — and assert the old M0
 * behaviour now holds per-village. The tick iterates `villageOrder` in a fixed order,
 * so the determinism/linearity guarantees these tests pin are unchanged.
 */
function capital(state: GameState): Village {
  return state.villages[state.villageOrder[0]]
}

describe('simulate', () => {
  it('accrues production * dt for each resource (per village)', () => {
    const state = createInitialState('sim', 0)
    simulate(state, 10)
    const v = capital(state)
    // wood 50 + 1*10, clay 50 + 0.8*10, iron 50 + 0.5*10
    expect(v.resources.wood.toString()).toBe('60')
    expect(v.resources.clay.toString()).toBe('58')
    expect(v.resources.iron.toString()).toBe('55')
  })

  it('clamps resources to the storage cap', () => {
    const state = createInitialState('sim', 0)
    const v = capital(state)
    // Advance far enough that the fastest resource (wood) overshoots the cap.
    simulate(state, v.storageCap.toNumber() * 2)
    expect(v.resources.wood.toString()).toBe(v.storageCap.toString())
    expect(v.resources.wood.lte(v.storageCap)).toBe(true)
    expect(v.resources.clay.lte(v.storageCap)).toBe(true)
    expect(v.resources.iron.lte(v.storageCap)).toBe(true)
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

  it('production stays linear in dt across the per-village tick grid', () => {
    // One big span and the same span split into chunks must land on the same totals
    // for the capital — production summed over the fixed grid equals rate*dt exactly
    // on Decimal, and the village is iterated in a fixed `villageOrder` slot.
    const whole = createInitialState('lin', 0)
    const split = createInitialState('lin', 0)
    simulate(whole, 30)
    simulate(split, 7)
    simulate(split, 11)
    simulate(split, 12)
    expect(serialize(split)).toBe(serialize(whole))
    expect(capital(whole).resources.wood.toString()).toBe('80') // 50 + 1*30
  })
})
