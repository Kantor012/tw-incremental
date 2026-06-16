import { describe, it, expect } from 'vitest'
import {
  generateWorld,
  distance,
  barbarianById,
  targetsByDistance,
  DISTANCE_PER_LEVEL,
  WORLD_CENTER,
  WORLD_SIZE,
} from '../src/systems/world'
import { MAX_TARGET_LEVEL } from '../src/content/barbarians'
import { createVillage, type Village, type World } from '../src/engine/state'

/** A village at an arbitrary map position (only x/y are read by the geometry helpers). */
function villageAt(x: number, y: number): Village {
  return createVillage('v0', 'Stolica', x, y)
}

/** Grid key used to detect two villages occupying the same field. */
function cell(x: number, y: number): string {
  return x + ',' + y
}

describe('generateWorld — determinism', () => {
  it('is byte-for-byte identical for the same seed (coords, levels, ids, names)', () => {
    const a = generateWorld('alpha')
    const b = generateWorld('alpha')
    expect(a).toEqual(b)
    // Idempotent across repeated calls — no shared mutable module state leaks in.
    expect(generateWorld('alpha')).toEqual(a)
  })

  it('produces a different layout for a different seed', () => {
    const a = generateWorld('alpha')
    const b = generateWorld('beta')
    // Same deterministic STRUCTURE (same count/levels/ids) but the random placement
    // differs, so the coordinate-bearing arrays must not be equal.
    expect(a.barbarians.length).toBe(b.barbarians.length)
    expect(a.barbarians).not.toEqual(b.barbarians)
    const coordsA = a.barbarians.map((v) => cell(v.x, v.y))
    const coordsB = b.barbarians.map((v) => cell(v.x, v.y))
    expect(coordsA).not.toEqual(coordsB)
  })
})

describe('generateWorld — invariants', () => {
  const world = generateWorld('world-test')

  it('spawns a sane number of villages (~90–130 budget)', () => {
    expect(world.barbarians.length).toBeGreaterThanOrEqual(90)
    expect(world.barbarians.length).toBeLessThanOrEqual(130)
  })

  it('assigns stable sequential ids b0..b(n-1) in generation order', () => {
    world.barbarians.forEach((b, i) => {
      expect(b.id).toBe('b' + i)
    })
  })

  it('keeps every level an integer within [1, MAX_TARGET_LEVEL]', () => {
    for (const b of world.barbarians) {
      expect(Number.isInteger(b.level)).toBe(true)
      expect(b.level).toBeGreaterThanOrEqual(1)
      expect(b.level).toBeLessThanOrEqual(MAX_TARGET_LEVEL)
    }
  })

  it('emits levels in non-decreasing (tier-ascending) order', () => {
    for (let i = 1; i < world.barbarians.length; i++) {
      expect(world.barbarians[i].level).toBeGreaterThanOrEqual(world.barbarians[i - 1].level)
    }
  })

  it('seeds every barbarian unscouted (scouted === false) and at full loyalty (M2.4/M5.2)', () => {
    for (const b of world.barbarians) {
      expect(b.scouted).toBe(false) // hidden defence/loot until a scout reaches it
      expect(b.loyalty).toBe(100)
    }
  })

  it('places more low-tier villages than high-tier ones', () => {
    const low = world.barbarians.filter((b) => b.level === 1).length
    const high = world.barbarians.filter((b) => b.level === MAX_TARGET_LEVEL).length
    expect(low).toBeGreaterThan(high)
  })

  it('clamps every coordinate to the map [0, WORLD_SIZE] as integers', () => {
    for (const b of world.barbarians) {
      expect(Number.isInteger(b.x)).toBe(true)
      expect(Number.isInteger(b.y)).toBe(true)
      expect(b.x).toBeGreaterThanOrEqual(0)
      expect(b.x).toBeLessThanOrEqual(WORLD_SIZE)
      expect(b.y).toBeGreaterThanOrEqual(0)
      expect(b.y).toBeLessThanOrEqual(WORLD_SIZE)
    }
  })

  it('has no two villages on the same field, and none on the capital cell', () => {
    const seen = new Set<string>()
    for (const b of world.barbarians) {
      const key = cell(b.x, b.y)
      expect(seen.has(key)).toBe(false)
      seen.add(key)
    }
    expect(seen.size).toBe(world.barbarians.length)
    // The reserved capital cell at the centre must stay free.
    expect(seen.has(cell(WORLD_CENTER.x, WORLD_CENTER.y))).toBe(false)
  })
})

describe('generateWorld — radius grows with level', () => {
  const world = generateWorld('rings')

  it('sits each village in its tier ring (~level·DISTANCE_PER_LEVEL from centre)', () => {
    for (const b of world.barbarians) {
      const d = distance(WORLD_CENTER.x, WORLD_CENTER.y, b.x, b.y)
      const nominal = b.level * DISTANCE_PER_LEVEL
      // radius = nominal ± one-ring jitter (DISTANCE_PER_LEVEL); rounding + the
      // collision nudge add a small slack on top.
      expect(d).toBeGreaterThanOrEqual(Math.max(0, nominal - DISTANCE_PER_LEVEL - 2))
      expect(d).toBeLessThanOrEqual(nominal + DISTANCE_PER_LEVEL + 3)
    }
  })

  it('puts a far tier strictly farther out than a near tier (ring radius dominates jitter)', () => {
    const meanFor = (level: number): number => {
      const group = world.barbarians.filter((b) => b.level === level)
      const sum = group.reduce(
        (acc, b) => acc + distance(WORLD_CENTER.x, WORLD_CENTER.y, b.x, b.y),
        0,
      )
      return sum / group.length
    }
    // Compare tiers that are far enough apart that the 3-per-tier radius growth
    // unambiguously beats the ±3 per-village jitter.
    expect(meanFor(1)).toBeLessThan(meanFor(5))
    expect(meanFor(5)).toBeLessThan(meanFor(10))
    expect(meanFor(1)).toBeLessThan(meanFor(MAX_TARGET_LEVEL))
  })
})

describe('distance — Euclidean', () => {
  it('computes the 3-4-5 right triangle', () => {
    expect(distance(0, 0, 3, 4)).toBe(5)
  })

  it('is zero for a point to itself and symmetric', () => {
    expect(distance(200, 200, 200, 200)).toBe(0)
    expect(distance(10, 20, 40, 60)).toBe(distance(40, 60, 10, 20))
  })
})

describe('barbarianById', () => {
  const world = generateWorld('lookup')

  it('returns the matching village for a valid id', () => {
    const found = barbarianById(world, 'b3')
    expect(found).toBeDefined()
    expect(found?.id).toBe('b3')
  })

  it('returns undefined for a missing or legacy id', () => {
    expect(barbarianById(world, 'legacy')).toBeUndefined()
    expect(barbarianById(world, 'b99999')).toBeUndefined()
    expect(barbarianById(world, '')).toBeUndefined()
  })
})

describe('targetsByDistance', () => {
  const world = generateWorld('sorting')

  it('returns a sorted copy without mutating the source', () => {
    const before = world.barbarians.map((b) => b.id)
    const sorted = targetsByDistance(villageAt(WORLD_CENTER.x, WORLD_CENTER.y), world)

    // A copy, not the same array reference.
    expect(sorted).not.toBe(world.barbarians)
    expect(sorted.length).toBe(world.barbarians.length)
    // Source order is untouched.
    expect(world.barbarians.map((b) => b.id)).toEqual(before)
  })

  it('orders nearest-first by distance from the village', () => {
    const v = villageAt(WORLD_CENTER.x, WORLD_CENTER.y)
    const sorted = targetsByDistance(v, world)
    for (let i = 1; i < sorted.length; i++) {
      const prev = distance(v.x, v.y, sorted[i - 1].x, sorted[i - 1].y)
      const cur = distance(v.x, v.y, sorted[i].x, sorted[i].y)
      expect(prev).toBeLessThanOrEqual(cur)
    }
    // The nearest target is the global minimum.
    const minD = Math.min(
      ...world.barbarians.map((b) => distance(v.x, v.y, b.x, b.y)),
    )
    expect(distance(v.x, v.y, sorted[0].x, sorted[0].y)).toBe(minD)
  })

  it('re-sorts relative to the querying village (different origin → different nearest)', () => {
    // A village in the far corner should not share the centre's nearest target.
    const fromCentre = targetsByDistance(villageAt(WORLD_CENTER.x, WORLD_CENTER.y), world)
    const fromCorner = targetsByDistance(villageAt(0, 0), world)
    expect(fromCorner[0].id).not.toBe(fromCentre[0].id)
  })

  it('breaks distance ties by ascending id index (deterministic order)', () => {
    // Synthetic world: b0 and b2 are equidistant from the origin; b2 must follow b0.
    const tieWorld: World = {
      barbarians: [
        { id: 'b0', x: 10, y: 0, level: 1, name: 'a', loyalty: 100, scouted: false },
        { id: 'b1', x: 50, y: 0, level: 2, name: 'b', loyalty: 100, scouted: false },
        { id: 'b2', x: 0, y: 10, level: 3, name: 'c', loyalty: 100, scouted: false },
      ],
      fortresses: [],
    }
    const sorted = targetsByDistance(villageAt(0, 0), tieWorld)
    expect(sorted.map((b) => b.id)).toEqual(['b0', 'b2', 'b1'])
  })
})
