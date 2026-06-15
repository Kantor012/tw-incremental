import { describe, it, expect } from 'vitest'
import { D } from '../src/engine/decimal'
import {
  createInitialState,
  createVillage,
  type GameState,
  type VillageId,
} from '../src/engine/state'
import {
  FOUND_BASE_COST,
  FOUND_COST_GROWTH,
  FOUND_MIN_SPACING,
  FOUND_MAX_RANGE,
  playerVillageCount,
  foundCost,
  isCellOccupied,
  canFound,
  foundVillage,
  findFoundingSpot,
} from '../src/systems/villages'
import { WORLD_CENTER, distance } from '../src/systems/world'

/**
 * M2.3 — founding new owned villages. These tests pin the pure founding engine in
 * src/systems/villages.ts: the escalating {@link foundCost}, the geometry/affordability
 * gates of {@link canFound}, the single mutation in {@link foundVillage}, the
 * deterministic spatial search of {@link findFoundingSpot} and the bare
 * {@link isCellOccupied} tile test.
 *
 * The capital ('v0') starts at {@link WORLD_CENTER}. To make geometry deterministic
 * and free of the seed-generated barbarian sprinkle, {@link freshState} clears
 * `world.barbarians` and stocks the capital so affordability never masks a geometry
 * assertion; tests that exercise barbarian spacing / cell occupancy add their own
 * barbarians explicitly, and the can't-afford test empties the treasury.
 */

const CAP = WORLD_CENTER // { x: 200, y: 200 }

/** A controlled state: capital at the centre, NO barbarians, a deep treasury. */
function freshState(seed = 'found-test'): GameState {
  const s = createInitialState(seed, 0)
  s.world.barbarians = [] // controlled geometry: ignore the generated world
  s.villages.v0.resources = { wood: D(1_000_000), clay: D(1_000_000), iron: D(1_000_000) }
  return s
}

/** Append a fully-formed owned village at (x, y) (bypasses cost — test scaffolding only). */
function addVillage(s: GameState, id: VillageId, x: number, y: number): void {
  s.villages[id] = createVillage(id, id, x, y)
  s.villageOrder.push(id)
}

/** Append a barbarian village at (x, y). */
function addBarb(s: GameState, id: string, x: number, y: number): void {
  s.world.barbarians.push({ id, x, y, level: 1, name: id, loyalty: 100, scouted: false })
}

describe('playerVillageCount', () => {
  it('counts the keys of state.villages', () => {
    const s = freshState()
    expect(playerVillageCount(s)).toBe(1) // just the capital
    addVillage(s, 'v1', 210, 200)
    expect(playerVillageCount(s)).toBe(2)
    addVillage(s, 'v2', 200, 210)
    expect(playerVillageCount(s)).toBe(3)
  })
})

describe('foundCost — escalates with the number of villages owned', () => {
  it('the first extra village costs exactly FOUND_BASE_COST', () => {
    const s = freshState()
    const c = foundCost(s) // count === 1 → growth exponent 0
    expect(c.wood.toString()).toBe(String(FOUND_BASE_COST.wood)) // '3000'
    expect(c.clay.toString()).toBe(String(FOUND_BASE_COST.clay)) // '3000'
    expect(c.iron.toString()).toBe(String(FOUND_BASE_COST.iron)) // '2000'
  })

  it('scales by FOUND_COST_GROWTH per village already owned (exact for low counts)', () => {
    const s = freshState()
    addVillage(s, 'v1', 210, 200) // now 2 owned
    const c2 = foundCost(s)
    // base * 1.6^1
    expect(c2.wood.toString()).toBe('4800')
    expect(c2.clay.toString()).toBe('4800')
    expect(c2.iron.toString()).toBe('3200')

    addVillage(s, 'v2', 200, 210) // now 3 owned
    const c3 = foundCost(s)
    // base * 1.6^2
    expect(c3.wood.toString()).toBe('7680')
    expect(c3.clay.toString()).toBe('7680')
    expect(c3.iron.toString()).toBe('5120')
  })

  it('is strictly increasing as more villages are owned', () => {
    const s = freshState()
    const c1 = foundCost(s)
    addVillage(s, 'v1', 210, 200)
    const c2 = foundCost(s)
    addVillage(s, 'v2', 200, 210)
    const c3 = foundCost(s)
    addVillage(s, 'v3', 220, 200)
    const c4 = foundCost(s)
    expect(c2.wood.gt(c1.wood)).toBe(true)
    expect(c3.wood.gt(c2.wood)).toBe(true)
    expect(c4.wood.gt(c3.wood)).toBe(true)
    expect(c2.iron.gt(c1.iron)).toBe(true)
    expect(c4.iron.gt(c3.iron)).toBe(true)
    // Constant is what the formula expects.
    expect(FOUND_COST_GROWTH).toBe(1.6)
  })
})

describe('isCellOccupied', () => {
  it('detects an owned village (the capital) by exact coordinates', () => {
    const s = freshState()
    expect(isCellOccupied(s, CAP.x, CAP.y)).toBe(true)
    expect(isCellOccupied(s, CAP.x + 10, CAP.y)).toBe(false)
  })

  it('detects a freshly added owned village', () => {
    const s = freshState()
    addVillage(s, 'v1', 215, 205)
    expect(isCellOccupied(s, 215, 205)).toBe(true)
  })

  it('detects a barbarian village', () => {
    const s = freshState()
    addBarb(s, 'b0', 60, 60)
    expect(isCellOccupied(s, 60, 60)).toBe(true)
    expect(isCellOccupied(s, 61, 60)).toBe(false)
  })
})

describe('canFound', () => {
  it('accepts a valid, affordable site within range', () => {
    const s = freshState()
    const res = canFound(s, 'v0', CAP.x + 10, CAP.y) // distance 10 ∈ [4, 30]
    expect(res.ok).toBe(true)
    expect(res.reason).toBeUndefined()
  })

  it('rejects when the paying village does not exist', () => {
    const s = freshState()
    const res = canFound(s, 'does-not-exist', CAP.x + 10, CAP.y)
    expect(res.ok).toBe(false)
    expect(res.reason).toBe('Wioska płacąca nie istnieje')
  })

  it('rejects a non-integer or off-map target', () => {
    const s = freshState()
    expect(canFound(s, 'v0', CAP.x + 10.5, CAP.y)).toMatchObject({
      ok: false,
      reason: 'Pole poza mapą',
    })
    expect(canFound(s, 'v0', -1, CAP.y)).toMatchObject({ ok: false, reason: 'Pole poza mapą' })
    expect(canFound(s, 'v0', 401, CAP.y)).toMatchObject({ ok: false, reason: 'Pole poza mapą' })
  })

  it('rejects an occupied tile (the capital cell)', () => {
    const s = freshState()
    const res = canFound(s, 'v0', CAP.x, CAP.y)
    expect(res.ok).toBe(false)
    expect(res.reason).toBe('Pole jest zajęte')
  })

  it('rejects a site closer than FOUND_MIN_SPACING to another owned village', () => {
    const s = freshState()
    const res = canFound(s, 'v0', CAP.x + 2, CAP.y) // distance 2 < 4
    expect(res.ok).toBe(false)
    expect(res.reason).toBe('Za blisko innej wioski')
  })

  it('rejects a site closer than FOUND_MIN_SPACING to a barbarian village', () => {
    const s = freshState()
    addBarb(s, 'b0', CAP.x + 12, CAP.y) // far from capital, near the target
    const res = canFound(s, 'v0', CAP.x + 10, CAP.y) // 10 from capital, 2 from barbarian
    expect(res.ok).toBe(false)
    expect(res.reason).toBe('Za blisko wioski barbarzyńskiej')
  })

  it('rejects a site farther than FOUND_MAX_RANGE from every owned village', () => {
    const s = freshState()
    const res = canFound(s, 'v0', CAP.x + FOUND_MAX_RANGE + 10, CAP.y) // distance 40 > 30
    expect(res.ok).toBe(false)
    expect(res.reason).toBe('Za daleko od twoich wiosek')
  })

  it('accepts the exact FOUND_MIN_SPACING and FOUND_MAX_RANGE boundaries', () => {
    const s = freshState()
    expect(canFound(s, 'v0', CAP.x + FOUND_MIN_SPACING, CAP.y).ok).toBe(true) // distance 4
    expect(canFound(s, 'v0', CAP.x + FOUND_MAX_RANGE, CAP.y).ok).toBe(true) // distance 30
  })

  it('rejects when geometry is fine but the payer cannot afford the cost', () => {
    const s = freshState()
    s.villages.v0.resources = { wood: D(0), clay: D(0), iron: D(0) }
    const res = canFound(s, 'v0', CAP.x + 10, CAP.y)
    expect(res.ok).toBe(false)
    expect(res.reason).toBe('Brak surowców')
  })
})

describe('foundVillage', () => {
  it('spends the cost, appends a positioned village and returns its id', () => {
    const s = freshState()
    const cost = foundCost(s) // { 3000, 3000, 2000 }
    const id = foundVillage(s, 'v0', CAP.x + 10, CAP.y)

    expect(id).toBe('v1') // first free id after the capital
    expect(s.villageOrder).toContain('v1')
    expect(s.villageOrder.length).toBe(2)

    const v = s.villages[id as VillageId]
    expect(v).toBeDefined()
    expect(v.x).toBe(CAP.x + 10)
    expect(v.y).toBe(CAP.y)
    expect(v.name).toBe('Wioska 2') // count was 1 → 'Wioska ' + 2

    // Payer charged exactly the founding cost.
    const r = s.villages.v0.resources
    expect(r.wood.toString()).toBe(D(1_000_000).sub(cost.wood).toString()) // 997000
    expect(r.clay.toString()).toBe(D(1_000_000).sub(cost.clay).toString()) // 997000
    expect(r.iron.toString()).toBe(D(1_000_000).sub(cost.iron).toString()) // 998000
  })

  it('returns null and mutates nothing when the site is invalid', () => {
    const s = freshState()
    const woodBefore = s.villages.v0.resources.wood.toString()
    const id = foundVillage(s, 'v0', CAP.x, CAP.y) // occupied (capital cell)
    expect(id).toBeNull()
    expect(s.villageOrder.length).toBe(1)
    expect(Object.keys(s.villages).length).toBe(1)
    expect(s.villages.v0.resources.wood.toString()).toBe(woodBefore) // untouched
  })

  it('returns null and mutates nothing when the payer cannot afford it', () => {
    const s = freshState()
    s.villages.v0.resources = { wood: D(10), clay: D(10), iron: D(10) }
    const id = foundVillage(s, 'v0', CAP.x + 10, CAP.y)
    expect(id).toBeNull()
    expect(s.villageOrder.length).toBe(1)
    expect(s.villages.v0.resources.wood.toString()).toBe('10') // not spent
  })

  it('assigns escalating ids as the empire grows', () => {
    const s = freshState()
    const a = foundVillage(s, 'v0', CAP.x + 5, CAP.y)
    const b = foundVillage(s, 'v0', CAP.x - 5, CAP.y)
    expect(a).toBe('v1')
    expect(b).toBe('v2')
    expect(s.villageOrder).toEqual(['v0', 'v1', 'v2'])
  })
})

describe('findFoundingSpot', () => {
  it('returns null when the anchor village does not exist', () => {
    const s = freshState()
    expect(findFoundingSpot(s, 'nope')).toBeNull()
  })

  it('is deterministic: repeated calls yield the identical spot', () => {
    const s = freshState()
    const a = findFoundingSpot(s, 'v0')
    const b = findFoundingSpot(s, 'v0')
    expect(a).not.toBeNull()
    expect(a).toEqual(b)
  })

  it('returns a free, geometrically valid tile at the nearest legal ring', () => {
    const s = freshState()
    const spot = findFoundingSpot(s, 'v0')
    expect(spot).not.toBeNull()
    const { x, y } = spot as { x: number; y: number }

    // Free and accepted by the real gate (treasury is stocked, so geometry is the
    // only thing canFound can object to here).
    expect(isCellOccupied(s, x, y)).toBe(false)
    expect(canFound(s, 'v0', x, y).ok).toBe(true)

    // Nearest-first search lands on the minimum legal spacing ring.
    const d = distance(x, y, CAP.x, CAP.y)
    expect(d).toBeGreaterThanOrEqual(FOUND_MIN_SPACING)
    expect(d).toBeLessThanOrEqual(FOUND_MAX_RANGE)
    expect(d).toBeCloseTo(FOUND_MIN_SPACING, 10)
  })

  it('skips tiles too close to a barbarian and still returns a valid spot', () => {
    const s = freshState()
    // Block the would-be nearest ring tile with a barbarian.
    addBarb(s, 'b0', CAP.x - FOUND_MIN_SPACING, CAP.y)
    const spot = findFoundingSpot(s, 'v0')
    expect(spot).not.toBeNull()
    const { x, y } = spot as { x: number; y: number }

    expect(isCellOccupied(s, x, y)).toBe(false)
    expect(canFound(s, 'v0', x, y).ok).toBe(true)
    // Honours spacing from the barbarian, not just the capital.
    for (const b of s.world.barbarians) {
      expect(distance(x, y, b.x, b.y)).toBeGreaterThanOrEqual(FOUND_MIN_SPACING)
    }
  })

  it('feeds a spot that foundVillage actually accepts (engine round-trip)', () => {
    const s = freshState()
    const spot = findFoundingSpot(s, 'v0')
    expect(spot).not.toBeNull()
    const { x, y } = spot as { x: number; y: number }
    const id = foundVillage(s, 'v0', x, y)
    expect(id).toBe('v1')
    expect(s.villages[id as VillageId].x).toBe(x)
    expect(s.villages[id as VillageId].y).toBe(y)
  })
})
