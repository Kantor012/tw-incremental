import { describe, it, expect } from 'vitest'
import { RNG } from '../src/engine/rng'

describe('RNG', () => {
  it('produces an identical sequence for the same seed', () => {
    const a = new RNG(12345)
    const b = new RNG(12345)
    for (let i = 0; i < 5; i++) {
      expect(a.next()).toBe(b.next())
    }
  })

  it('derives a stable seed from a string', () => {
    const a = RNG.fromString('tribal-wars')
    const b = RNG.fromString('tribal-wars')
    expect(a.getState()).toBe(b.getState())
    expect(a.next()).toBe(b.next())
    // Different strings should not collide on the same seed state.
    expect(RNG.fromString('tribal-wars').getState()).not.toBe(
      RNG.fromString('barbarians').getState(),
    )
  })

  it('resumes the sequence via getState/setState', () => {
    const r = new RNG(999)
    r.next()
    r.next()
    const saved = r.getState()
    const expected = [r.next(), r.next(), r.next()]

    const resumed = new RNG(0)
    resumed.setState(saved)
    expect([resumed.next(), resumed.next(), resumed.next()]).toEqual(expected)
  })

  it('keeps nextInt within [0, maxExclusive)', () => {
    const r = new RNG(7)
    for (let i = 0; i < 100; i++) {
      const v = r.nextInt(10)
      expect(Number.isInteger(v)).toBe(true)
      expect(v).toBeGreaterThanOrEqual(0)
      expect(v).toBeLessThan(10)
    }
  })

  it('honours the probability bounds of chance', () => {
    const r = new RNG(3)
    expect(r.chance(0)).toBe(false)
    expect(r.chance(1)).toBe(true)
  })
})
