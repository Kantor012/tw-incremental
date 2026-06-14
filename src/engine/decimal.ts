import Decimal from 'break_infinity.js'

/**
 * Single place that owns the big-number type. The whole economy runs on Decimal,
 * never on plain `number`, so values can grow far past Number.MAX_SAFE_INTEGER.
 */
export { Decimal }
export type DecimalSource = Decimal | number | string

/** Convenience constructor. `D()` === 0. */
export const D = (x: DecimalSource = 0): Decimal => new Decimal(x)

export const ZERO = new Decimal(0)
export const ONE = new Decimal(1)

/** break_infinity's magnitude ceiling: Infinity is stored as exponent 9e15. */
const EXP_LIMIT = 9e15

/** True when a Decimal is a usable finite value (no NaN / Infinity). */
export function isFiniteDecimal(d: Decimal): boolean {
  // break_infinity represents Infinity as { mantissa: 1, exponent: 9e15 } — both
  // are finite numbers, so we must also reject the magnitude ceiling explicitly.
  return (
    Number.isFinite(d.mantissa) &&
    Number.isFinite(d.exponent) &&
    Math.abs(d.exponent) < EXP_LIMIT
  )
}
