/**
 * Deterministic seeded PRNG (mulberry32). The whole game is reproducible from a
 * seed — combat, world generation and tests all draw from this. The internal
 * state is a single uint32 so it serializes cleanly into the save.
 */
export class RNG {
  private s: number

  constructor(seed: number) {
    this.s = seed >>> 0
  }

  /** Derive a stable numeric seed from an arbitrary string (FNV-1a). */
  static fromString(str: string): RNG {
    let h = 2166136261 >>> 0
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i)
      h = Math.imul(h, 16777619)
    }
    return new RNG(h >>> 0)
  }

  /** Next float in [0, 1). */
  next(): number {
    this.s = (this.s + 0x6d2b79f5) >>> 0
    let t = this.s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }

  /** Integer in [0, maxExclusive). */
  nextInt(maxExclusive: number): number {
    return Math.floor(this.next() * maxExclusive)
  }

  /** Float in [min, max). */
  range(min: number, max: number): number {
    return min + this.next() * (max - min)
  }

  /** Integer in [min, maxInclusive]. */
  intRange(min: number, maxInclusive: number): number {
    return min + Math.floor(this.next() * (maxInclusive - min + 1))
  }

  /** True with probability p. */
  chance(p: number): boolean {
    return this.next() < p
  }

  /** Pick a random element. */
  pick<T>(arr: readonly T[]): T {
    return arr[this.nextInt(arr.length)] as T
  }

  /** Current internal state — persist this in the save for determinism. */
  getState(): number {
    return this.s >>> 0
  }

  setState(state: number): void {
    this.s = state >>> 0
  }
}
