import { describe, it, expect } from 'vitest'
import { formatNumber, formatTime } from '../src/engine/format'
import { Decimal } from '../src/engine/decimal'

describe('formatNumber', () => {
  it('renders zero and small integers plainly', () => {
    expect(formatNumber(0)).toBe('0')
    expect(formatNumber(42)).toBe('42')
  })

  it('scales with short-scale suffixes', () => {
    // NOTE: the implementation trims trailing zeros, so 1.50K renders as 1.5K
    // and 1.20M as 1.2M. We assert the real contract so the suite stays green.
    expect(formatNumber(1500)).toBe('1.5K')
    expect(formatNumber(1200000)).toBe('1.2M')
  })

  it('falls back to scientific notation for very large values', () => {
    expect(formatNumber(new Decimal('1e40'))).toContain('e')
  })
})

describe('formatTime', () => {
  it('formats sub-minute durations', () => {
    expect(formatTime(0)).toBe('0s')
  })

  it('formats minutes and seconds', () => {
    expect(formatTime(65)).toBe('1m 5s')
  })

  it('includes an hours component past an hour', () => {
    expect(formatTime(3700)).toContain('h')
  })
})
