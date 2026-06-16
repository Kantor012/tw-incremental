import { describe, it, expect } from 'vitest'
import {
  createInitialState,
  createVillage,
  recomputeDerived,
  RESOURCE_IDS,
  type GameState,
  type Village,
  type ResourceId,
} from '../src/engine/state'
import { D, type Decimal } from '../src/engine/decimal'
import { BUILDINGS } from '../src/content/buildings'
import { simulate } from '../src/engine/tick'
import { serialize } from '../src/engine/save'
import {
  shipmentTime,
  merchantCapacityInUse,
  availableCapacity,
  canTransport,
  sendShipment,
  advanceShipments,
} from '../src/systems/market'

/**
 * Market engine tests (M9 — RYNEK / merchant transport between OWN villages).
 *
 * Covers the contract pieces:
 *  - merchantCapacity is a pure building roll-up: 0 with no market, perLevel·level after.
 *  - {@link canTransport} gates: no market, source==dest, non-existent dest, cargo over
 *    resources, cargo over available capacity, zero/negative cargo — and accepts a valid one.
 *  - {@link sendShipment} debits the source immediately and creates a Shipment with
 *    remaining = {@link shipmentTime}.
 *  - {@link advanceShipments} delivers on arrival (clamped to the destination's storage
 *    cap, overflow spilled) and removes the shipment; merchant capacity in use is released.
 *  - Transport CONSERVES total resources (sum across villages unchanged with no overflow).
 *  - A run that never transports is byte-identical to a pre-market-shaped run (the M9
 *    additions are inert).
 *
 * Resources/buildings are referenced GENERICALLY (RESOURCE_IDS, the market def's effect)
 * so a balance retune of perLevel / costs never breaks these structural assertions.
 */

/** The market's per-level carry capacity, read generically from the building data. */
const marketEffect = BUILDINGS.market.effect
const MARKET_PER_LEVEL = marketEffect.kind === 'merchant_capacity' ? marketEffect.perLevel : 0

/** A cargo record (Record<ResourceId, number>) with every resource zeroed, then patched. */
function cargo(patch: Partial<Record<ResourceId, number>> = {}): Record<ResourceId, number> {
  const c = {} as Record<ResourceId, number>
  for (const r of RESOURCE_IDS) c[r] = patch[r] ?? 0
  return c
}

/** Set every resource of `v` to `amount` (generic over RESOURCE_IDS). */
function fund(v: Village, amount: number): void {
  for (const r of RESOURCE_IDS) v.resources[r] = D(amount)
}

/** Total resources held across every village's pool (in-transit cargo NOT counted). */
function totalResources(s: GameState): Decimal {
  let t = D(0)
  for (const id of s.villageOrder) {
    for (const r of RESOURCE_IDS) t = t.add(s.villages[id].resources[r])
  }
  return t
}

/**
 * A two-village state: the capital ('v0') with the market at `marketLevel`, plus a second
 * owned village ('v1') placed at a 3-4-5 offset from the capital (a known, non-zero travel
 * distance). Derived stats are reconciled so merchantCapacity is consistent with the level.
 */
function twoVillages(seed = 'mkt', marketLevel = 1): GameState {
  const s = createInitialState(seed, 0)
  const cap = s.villages.v0
  const dest = createVillage('v1', 'Druga', cap.x + 3, cap.y + 4) // Euclidean distance 5
  s.villages.v1 = dest
  s.villageOrder.push('v1')
  cap.buildings.market = marketLevel
  recomputeDerived(s)
  return s
}

describe('market — merchant capacity is a pure building roll-up', () => {
  it('a fresh village has merchantCapacity 0 (market initialLevel 0)', () => {
    const v = createVillage('vt', 'Świeża', 0, 0)
    expect(v.buildings.market).toBe(0)
    expect(v.merchantCapacity.eq(0)).toBe(true)
  })

  it('recompute sets merchantCapacity = perLevel · level after building the market', () => {
    const s = createInitialState('cap', 0)
    for (const level of [1, 2, 5, BUILDINGS.market.maxLevel]) {
      s.villages.v0.buildings.market = level
      recomputeDerived(s)
      expect(s.villages.v0.merchantCapacity.eq(D(MARKET_PER_LEVEL).mul(level))).toBe(true)
    }
  })
})

describe('market — canTransport gating', () => {
  it('rejects when the source has no market', () => {
    const s = twoVillages('mkt', 0) // market level 0
    fund(s.villages.v0, 5000)
    const res = canTransport(s, 'v0', 'v1', cargo({ wood: 100 }))
    expect(res.ok).toBe(false)
    expect(typeof res.reason).toBe('string')
  })

  it('rejects when the destination equals the source', () => {
    const s = twoVillages()
    fund(s.villages.v0, 5000)
    const res = canTransport(s, 'v0', 'v0', cargo({ wood: 100 }))
    expect(res.ok).toBe(false)
    expect(typeof res.reason).toBe('string')
  })

  it('rejects a non-existent destination village', () => {
    const s = twoVillages()
    fund(s.villages.v0, 5000)
    const res = canTransport(s, 'v0', 'v404', cargo({ wood: 100 }))
    expect(res.ok).toBe(false)
    expect(typeof res.reason).toBe('string')
  })

  it('rejects cargo exceeding the source resources', () => {
    const s = twoVillages()
    fund(s.villages.v0, 50) // only 50 of each
    const res = canTransport(s, 'v0', 'v1', cargo({ wood: 100 }))
    expect(res.ok).toBe(false)
    expect(typeof res.reason).toBe('string')
  })

  it('rejects cargo exceeding the available merchant capacity', () => {
    const s = twoVillages()
    // Resources are NOT the binding constraint (vastly funded); only capacity is.
    fund(s.villages.v0, 1_000_000_000)
    const capNum = Number(s.villages.v0.merchantCapacity.toString())
    const res = canTransport(s, 'v0', 'v1', cargo({ wood: capNum + 1 }))
    expect(res.ok).toBe(false)
    expect(typeof res.reason).toBe('string')
  })

  it('rejects zero cargo and negative cargo', () => {
    const s = twoVillages()
    fund(s.villages.v0, 5000)
    expect(canTransport(s, 'v0', 'v1', cargo()).ok).toBe(false) // nothing to send
    expect(canTransport(s, 'v0', 'v1', cargo({ wood: -5 })).ok).toBe(false) // negative amount
  })

  it('rejects a second shipment that exceeds the REMAINING capacity after a first is in flight', () => {
    const s = twoVillages() // market level 1
    fund(s.villages.v0, 1_000_000_000) // resources never the binding constraint
    const capNum = Number(s.villages.v0.merchantCapacity.toString())
    // First shipment occupies all but 100 of the merchant capacity.
    expect(sendShipment(s, 'v0', 'v1', cargo({ wood: capNum - 100 }))).toBe(true)
    // A second shipment of 200 fits the source's resources but exceeds the 100 still free.
    const over = canTransport(s, 'v0', 'v1', cargo({ wood: 200 }))
    expect(over.ok).toBe(false)
    expect(typeof over.reason).toBe('string')
    // …but one within the remaining 100 is still accepted (capacity is the only constraint).
    expect(canTransport(s, 'v0', 'v1', cargo({ wood: 100 })).ok).toBe(true)
  })

  it('accepts a valid transport (market, distinct existing dest, cargo within both bounds)', () => {
    const s = twoVillages()
    fund(s.villages.v0, 5000)
    const res = canTransport(s, 'v0', 'v1', cargo({ wood: 100 }))
    expect(res.ok).toBe(true)
    expect(res.reason).toBeUndefined()
  })
})

describe('market — sendShipment', () => {
  it('debits the cargo from the source immediately and creates a Shipment with remaining = shipmentTime', () => {
    const s = twoVillages()
    fund(s.villages.v0, 5000)
    const from = s.villages.v0
    const to = s.villages.v1
    const beforeTotal = totalResources(s)

    const ok = sendShipment(s, 'v0', 'v1', cargo({ wood: 300, clay: 200 }))
    expect(ok).toBe(true)

    // Cargo left the source immediately (Decimal debit).
    expect(from.resources.wood.eq(D(5000).sub(300))).toBe(true)
    expect(from.resources.clay.eq(D(5000).sub(200))).toBe(true)
    expect(from.resources.iron.eq(5000)).toBe(true)

    // A single shipment, held in transit on the SOURCE.
    expect(from.shipments.length).toBe(1)
    const sh = from.shipments[0]
    expect(sh.fromVillageId).toBe('v0')
    expect(sh.toVillageId).toBe('v1')
    expect(sh.cargo.wood.eq(300)).toBe(true)
    expect(sh.cargo.clay.eq(200)).toBe(true)
    expect(sh.cargo.iron.eq(0)).toBe(true)
    expect(sh.remaining).toBe(shipmentTime(from, to))

    // The cargo is held in transit, so the pooled total drops by exactly what was sent.
    expect(totalResources(s).eq(beforeTotal.sub(500))).toBe(true)
  })

  it('is a no-op returning false when canTransport rejects', () => {
    const s = twoVillages()
    fund(s.villages.v0, 5000)
    const woodBefore = s.villages.v0.resources.wood
    const ok = sendShipment(s, 'v0', 'v0', cargo({ wood: 100 })) // dest == source
    expect(ok).toBe(false)
    expect(s.villages.v0.shipments.length).toBe(0)
    expect(s.villages.v0.resources.wood.eq(woodBefore)).toBe(true)
  })
})

describe('market — advanceShipments delivery', () => {
  it('holds the shipment until the travel time elapses, then delivers and removes it', () => {
    const s = twoVillages()
    fund(s.villages.v0, 5000)
    const from = s.villages.v0
    const to = s.villages.v1
    const woodBefore = to.resources.wood
    sendShipment(s, 'v0', 'v1', cargo({ wood: 300 }))
    const t = shipmentTime(from, to)

    // Halfway: still in flight, nothing delivered yet.
    advanceShipments(s, t / 2)
    expect(from.shipments.length).toBe(1)
    expect(from.shipments[0].remaining).toBeCloseTo(t / 2)
    expect(to.resources.wood.eq(woodBefore)).toBe(true)

    // Past arrival: delivered (added to the destination), shipment removed.
    advanceShipments(s, t / 2 + 0.001)
    expect(from.shipments.length).toBe(0)
    expect(to.resources.wood.eq(woodBefore.add(300))).toBe(true)
  })

  it('clamps delivery to the destination storage cap and spills the overflow', () => {
    const s = twoVillages()
    fund(s.villages.v0, 5000)
    const from = s.villages.v0
    const to = s.villages.v1
    const cap = to.storageCap
    // Wood is near the cap (50 of headroom); clay starts empty (ample headroom).
    to.resources.wood = cap.sub(50)
    to.resources.clay = D(0)

    sendShipment(s, 'v0', 'v1', cargo({ wood: 200, clay: 100 }))
    advanceShipments(s, shipmentTime(from, to))

    expect(from.shipments.length).toBe(0)
    // Wood: only 50 fit, the rest spilled — clamped exactly to the cap.
    expect(to.resources.wood.eq(cap)).toBe(true)
    // Clay: had headroom, delivered in full.
    expect(to.resources.clay.eq(100)).toBe(true)
  })

  it('conserves total resources across villages when no overflow occurs', () => {
    const s = twoVillages()
    fund(s.villages.v0, 2000)
    const before = totalResources(s)

    sendShipment(s, 'v0', 'v1', cargo({ wood: 300, clay: 200, iron: 100 }))
    // While in flight the pooled total is lower (cargo held in transit).
    expect(totalResources(s).lt(before)).toBe(true)

    advanceShipments(s, shipmentTime(s.villages.v0, s.villages.v1))
    // Delivered with ample headroom: nothing created, nothing spilled — total unchanged.
    expect(totalResources(s).eq(before)).toBe(true)
  })

  it('releases the merchant capacity in use on delivery', () => {
    const s = twoVillages('mkt', 1)
    fund(s.villages.v0, 5000)
    const from = s.villages.v0
    const fullCap = from.merchantCapacity

    expect(merchantCapacityInUse(from).eq(0)).toBe(true)
    expect(availableCapacity(from).eq(fullCap)).toBe(true)

    sendShipment(s, 'v0', 'v1', cargo({ wood: 300, clay: 200 })) // 500 in use
    expect(merchantCapacityInUse(from).eq(500)).toBe(true)
    expect(availableCapacity(from).eq(fullCap.sub(500))).toBe(true)

    advanceShipments(s, shipmentTime(from, s.villages.v1))
    expect(merchantCapacityInUse(from).eq(0)).toBe(true)
    expect(availableCapacity(from).eq(fullCap)).toBe(true)
  })

  it('delivers multiple shipments arriving the same step to one destination, clamped to its cap', () => {
    // Max market so two shipments comfortably fit the merchant capacity at once.
    const s = twoVillages('mkt', BUILDINGS.market.maxLevel)
    fund(s.villages.v0, 1_000_000_000)
    const from = s.villages.v0
    const dest = s.villages.v1
    // Pin a small destination cap and partially fill it so the combined delivery overflows.
    dest.storageCap = D(1000)
    for (const r of RESOURCE_IDS) dest.resources[r] = D(200)

    // Two equal-distance shipments (same from→to) therefore arrive on the SAME step.
    expect(sendShipment(s, 'v0', 'v1', cargo({ wood: 500 }))).toBe(true)
    expect(sendShipment(s, 'v0', 'v1', cargo({ wood: 500 }))).toBe(true)
    expect(from.shipments.length).toBe(2)

    advanceShipments(s, shipmentTime(from, dest)) // both resolve this step
    // Both shipments delivered + removed; wood clamped to the cap, the overflow spilled
    // (200 + 500 + 500 = 1200 → min(cap 1000)). Order-independent for one resource, but the
    // point is the simultaneous same-destination clamp resolves both, losing nothing extra.
    expect(from.shipments.length).toBe(0)
    expect(dest.resources.wood.eq(D(1000))).toBe(true)
  })
})

describe('market — identity: a no-transport run is byte-identical to a pre-market-shaped run', () => {
  /**
   * Serialize `s` with the M9-only village fields removed, reducing it to the pre-M9
   * shape (no market building key, no merchantCapacity cache, no shipments list). Two
   * runs that never transport must agree under this normalisation — proving the M9
   * additions are inert (market level 0 + empty shipments perturb nothing).
   */
  function stripM9(s: GameState): string {
    const raw = JSON.parse(serialize(s)) as {
      villageOrder: string[]
      villages: Record<string, any>
    }
    for (const id of raw.villageOrder) {
      const v = raw.villages[id]
      delete v.buildings.market
      delete v.merchantCapacity
      delete v.shipments
    }
    return JSON.stringify(raw)
  }

  it('simulate() over a no-transport run matches a state with no market building', () => {
    const seed = 'inert'
    const withMarket = createInitialState(seed, 0)

    // Pre-market twin: same seed, but with the M9 village fields stripped to the pre-M9
    // shape. shipments stays an (empty) array so advanceShipments — a no-op over [] — runs.
    const preMarket = createInitialState(seed, 0)
    for (const id of preMarket.villageOrder) {
      const v = preMarket.villages[id]
      delete (v.buildings as Record<string, number>).market
      delete (v as { merchantCapacity?: Decimal }).merchantCapacity
    }

    const dt = 300 // < raid interval (900): a pure economy run, no combat / rng draws
    simulate(withMarket, dt)
    simulate(preMarket, dt)

    // The economies are byte-identical once the inert M9 fields are normalised away.
    expect(stripM9(withMarket)).toBe(stripM9(preMarket))
    // Sanity: the run actually advanced the economy.
    expect(withMarket.villages.v0.resources.wood.gt(0)).toBe(true)
  })
})
