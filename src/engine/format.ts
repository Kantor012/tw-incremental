import { Decimal, isFiniteDecimal, type DecimalSource } from './decimal'

/**
 * Number formatting lives in one place. Short-scale suffixes for human-readable
 * magnitudes, falling back to scientific notation for very large values.
 */

const SUFFIXES = ['', 'K', 'M', 'B', 'T', 'Qa', 'Qi', 'Sx', 'Sp', 'Oc', 'No', 'Dc']

function toDecimal(value: DecimalSource): Decimal {
  return value instanceof Decimal ? value : new Decimal(value)
}

/** Strip trailing zeros (and a dangling decimal point) from a fixed string. */
function trim(s: string): string {
  if (!s.includes('.')) return s
  return s.replace(/0+$/, '').replace(/\.$/, '')
}

/**
 * Format a Decimal/number for display.
 * - < 1000: plain (integers without decimals, fractions with up to `decimals`)
 * - up to 1e36: scaled with a short-scale suffix (1.50K, 120.00M, ...)
 * - beyond: scientific (1.23e42)
 */
export function formatNumber(value: DecimalSource, decimals = 2): string {
  const d = toDecimal(value)
  if (!isFiniteDecimal(d)) return d.lt(0) ? '-∞' : '∞'
  if (d.eq(0)) return '0'

  const neg = d.lt(0)
  const abs = d.abs()
  const sign = neg ? '-' : ''
  const e = abs.exponent

  if (e < 3) {
    const n = abs.toNumber()
    return sign + (Number.isInteger(n) ? n.toString() : trim(n.toFixed(decimals)))
  }

  const tier = Math.floor(e / 3)
  if (tier < SUFFIXES.length) {
    const scaled = abs.mantissa * Math.pow(10, e - tier * 3)
    return sign + trim(scaled.toFixed(decimals)) + SUFFIXES[tier]
  }

  return sign + trim(abs.mantissa.toFixed(decimals)) + 'e' + e
}

/** Integer-only variant (no fractional part). */
export function formatInt(value: DecimalSource): string {
  return formatNumber(value, 0)
}

/** Per-second rate, e.g. "1.50/s". */
export function formatRate(value: DecimalSource, decimals = 2): string {
  return formatNumber(value, decimals) + '/s'
}

/** Human-readable duration from seconds. */
export function formatTime(totalSeconds: number): string {
  if (!Number.isFinite(totalSeconds) || totalSeconds < 0) return '—'
  const sec = Math.floor(totalSeconds % 60)
  const min = Math.floor((totalSeconds / 60) % 60)
  const hrs = Math.floor((totalSeconds / 3600) % 24)
  const days = Math.floor(totalSeconds / 86400)
  if (days > 0) return `${days}d ${hrs}h ${min}m`
  if (hrs > 0) return `${hrs}h ${min}m ${sec}s`
  if (min > 0) return `${min}m ${sec}s`
  return `${sec}s`
}
