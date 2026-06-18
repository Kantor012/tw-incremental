import { describe, it, expect } from 'vitest'
import {
  createInitialState,
  createVillage,
  recomputeDerived,
  RESOURCE_IDS,
  type GameState,
} from '../src/engine/state'
import { D, Decimal } from '../src/engine/decimal'
import { BUILDINGS } from '../src/content/buildings'
import {
  serialize,
  deserialize,
  exportSave,
  importSave,
  migrate,
  validateState,
  SAVE_VERSION,
} from '../src/engine/save'
import { sendShipment, shipmentTime } from '../src/systems/market'

/**
 * M9 save-engine tests for the market schema (v20). The full cross-version migration
 * chain lives in migration.test.ts; this file pins the four things the save engine owns
 * at v20:
 *
 *  1. v19 -> v20 MIGRATION — a pre-market save (no `buildings.market`, no `shipments`)
 *     backfills `buildings.market = 0` and `shipments = []` on EVERY village, then validates.
 *  2. ROUND-TRIP — a v20 state with a shipment IN FLIGHT round-trips through
 *     serialize/deserialize AND exportSave/importSave, preserving the cargo Decimals + remaining.
 *  3. validateState REJECTS a malformed shipment (unknown from/to village id, negative
 *     remaining, negative/NaN cargo) and a bad market level.
 *  4. A fresh createInitialState carries market 0 + empty shipments and round-trips byte-identically.
 */

const SEED = 'save-v19'

/**
 * A v19-shaped raw save (pre-market). Built by serialising a real current-version state and
 * DOWNGRADING it: strip `market` from every village's buildings, strip every `shipments`
 * list (and the derived `merchantCapacity`, which a pre-M9 save never carried), stamp version
 * 19. Tracking the live state shape this way avoids hand-maintained field lists drifting.
 * deserialize gives real Decimal instances, exactly as a save off disk would after parsing.
 */
function rawV19(): Record<string, any> {
  const fresh = createInitialState(SEED, 4242)
  const raw = deserialize(serialize(fresh)) as unknown as Record<string, any>
  for (const id of raw.villageOrder) {
    const v = raw.villages[id]
    delete v.buildings.market
    delete v.shipments
    delete v.merchantCapacity
  }
  raw.version = 19
  return raw
}

describe('market save — v19 -> v20 migration backfill (M9)', () => {
  it('backfills buildings.market=0 + shipments=[] on every village, then validates', () => {
    const raw = rawV19()
    // Precondition: the v19 save genuinely lacks both new bits on every village.
    for (const id of raw.villageOrder) {
      expect('market' in raw.villages[id].buildings).toBe(false)
      expect('shipments' in raw.villages[id]).toBe(false)
    }

    const m = migrate(raw)
    expect(m.version).toBe(SAVE_VERSION)
    expect(m.version).toBe(25)

    for (const id of m.villageOrder) {
      expect(m.villages[id].buildings.market).toBe(0)
      expect(m.villages[id].shipments).toEqual([])
    }

    // And the whole migrated save validates (merchantCapacity is derived — recomputed on load).
    expect(validateState(m).version).toBe(SAVE_VERSION)
  })

  it('preserves a shipments array a forward-compat v19 save already carries', () => {
    const raw = rawV19()
    raw.villages.v0.shipments = [] // already present (empty) — kept verbatim, not reset
    const m = migrate(raw)
    expect(m.version).toBe(SAVE_VERSION)
    expect(m.villages.v0.shipments).toEqual([])
    expect(validateState(m).version).toBe(SAVE_VERSION)
  })

  it('importSave of a v19 export migrates to v20, sets merchantCapacity and validates', () => {
    const restored = importSave(exportSave(rawV19() as never))
    expect(restored.version).toBe(SAVE_VERSION)
    for (const id of restored.villageOrder) {
      expect(restored.villages[id].buildings.market).toBe(0)
      expect(restored.villages[id].shipments).toEqual([])
      // merchantCapacity is recomputed on load — 0 with no market (byte-identical to pre-M9).
      expect(restored.villages[id].merchantCapacity.eq(0)).toBe(true)
    }
  })
})

/**
 * A v20 state with a shipment IN FLIGHT. The capital ('v0') has the market at level 2 and a
 * second village ('v1') at a 3-4-5 offset; a 1000-wood + 500-clay cargo is dispatched (debited
 * from v0, held in transit). Built fresh per test so corruption mutations never leak between cases.
 */
function shipState(seed = 'save-v20'): GameState {
  const s = createInitialState(seed, 1717)
  const cap = s.villages.v0
  const dest = createVillage('v1', 'Druga', cap.x + 3, cap.y + 4) // Euclidean distance 5
  s.villages.v1 = dest
  s.villageOrder.push('v1')
  cap.buildings.market = 2
  recomputeDerived(s)
  cap.resources.wood = D(5000)
  cap.resources.clay = D(5000)
  const ok = sendShipment(s, 'v0', 'v1', { wood: 1000, clay: 500, iron: 0 })
  if (!ok) throw new Error('test setup: sendShipment should succeed')
  return s
}

describe('market save — v20 round-trip', () => {
  it('serialize/deserialize preserves an in-flight shipment (cargo Decimals + remaining)', () => {
    const s = shipState()
    const json = serialize(s)
    const back = deserialize(json)

    expect(back.version).toBe(SAVE_VERSION)
    const sh = back.villages.v0.shipments
    expect(sh.length).toBe(1)
    expect(sh[0].fromVillageId).toBe('v0')
    expect(sh[0].toVillageId).toBe('v1')
    expect(sh[0].cargo.wood.eq(1000)).toBe(true)
    expect(sh[0].cargo.clay.eq(500)).toBe(true)
    expect(sh[0].cargo.iron.eq(0)).toBe(true)
    expect(sh[0].remaining).toBe(shipmentTime(s.villages.v0, s.villages.v1))

    // serialize is idempotent across the round-trip (stable key order).
    expect(serialize(back)).toBe(json)
  })

  it('exportSave/importSave preserves the in-flight shipment byte-identically', () => {
    const s = shipState()
    const restored = importSave(exportSave(s))

    const sh = restored.villages.v0.shipments
    expect(sh.length).toBe(1)
    expect(sh[0].cargo.wood.eq(1000)).toBe(true)
    expect(sh[0].cargo.clay.eq(500)).toBe(true)
    expect(sh[0].remaining).toBe(s.villages.v0.shipments[0].remaining)
    // Byte-identical: derived fields (incl. merchantCapacity) were already consistent before export.
    expect(serialize(restored)).toBe(serialize(s))
  })
})

describe('market save — validateState', () => {
  it('accepts a fresh state and a non-trivial shipment state', () => {
    const fresh = createInitialState('valid', 1)
    expect(validateState(fresh)).toBe(fresh)
    const s = shipState()
    expect(validateState(s)).toBe(s)
  })

  it('rejects a shipment with an unknown from/to village id', () => {
    const badTo = shipState()
    badTo.villages.v0.shipments[0].toVillageId = 'v404'
    expect(() => validateState(badTo)).toThrow()

    const badFrom = shipState()
    badFrom.villages.v0.shipments[0].fromVillageId = 'nope'
    expect(() => validateState(badFrom)).toThrow()
  })

  it('rejects a shipment with a bad remaining (negative / NaN / Infinity)', () => {
    for (const remaining of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const bad = shipState()
      bad.villages.v0.shipments[0].remaining = remaining
      expect(() => validateState(bad)).toThrow()
    }
  })

  it('rejects a shipment with negative or NaN cargo on any resource', () => {
    for (const r of RESOURCE_IDS) {
      for (const amount of [D(-1), D(Number.NaN)]) {
        const bad = shipState()
        bad.villages.v0.shipments[0].cargo[r] = amount
        expect(() => validateState(bad)).toThrow()
      }
    }
  })

  it('rejects a bad market building level (out of range / fractional)', () => {
    for (const level of [-1, BUILDINGS.market.maxLevel + 1, 1.5]) {
      const bad = shipState()
      bad.villages.v0.buildings.market = level
      expect(() => validateState(bad)).toThrow()
    }
  })
})

describe('market save — fresh state round-trip', () => {
  it('a fresh createInitialState carries market 0 + empty shipments and round-trips byte-identically', () => {
    const s = createInitialState('market-fresh', 2026)
    expect(s.villages.v0.buildings.market).toBe(0)
    expect(s.villages.v0.shipments).toEqual([])
    expect(s.villages.v0.merchantCapacity.eq(0)).toBe(true)

    const restored = importSave(exportSave(s))
    expect(serialize(restored)).toBe(serialize(s))
    expect(validateState(restored).version).toBe(SAVE_VERSION)
  })
})

/**
 * M9.2 save-engine tests for the EXCHANGE counter (v22). The exchange action adds exactly one new
 * piece of state — the lifetime `stats.resourcesExchanged` Decimal — so the save engine owns:
 *
 *  1. v21 -> v22 MIGRATION — a pre-exchange save (no `stats.resourcesExchanged`) backfills it to
 *     Decimal 0, then validates.
 *  2. ROUND-TRIP — a NON-ZERO `resourcesExchanged` survives exportSave/importSave (the `{ $d }`
 *     Decimal wire shape, like lootHauled).
 *  3. validateState REJECTS a bad `resourcesExchanged` (negative / NaN / non-Decimal).
 *  4. A fresh createInitialState carries `resourcesExchanged` 0 and round-trips byte-identically.
 */

/**
 * A v21-shaped raw save (pre-exchange). Built like {@link rawV19}: serialise a real current-version
 * state, deserialise to real Decimals, then DOWNGRADE by deleting the v22-only `stats.resourcesExchanged`
 * counter and stamping version 21 (a v21 save already carries market + shipments, added back at v20).
 */
function rawV21(): Record<string, any> {
  const fresh = createInitialState(SEED, 4242)
  const raw = deserialize(serialize(fresh)) as unknown as Record<string, any>
  delete raw.stats.resourcesExchanged
  raw.version = 21
  return raw
}

describe('market save — v21 -> v22 migration backfill (M9.2 exchange counter)', () => {
  it('backfills stats.resourcesExchanged = Decimal 0 on a v21 save, then validates', () => {
    const raw = rawV21()
    // Precondition: the v21 save genuinely lacks the new counter.
    expect('resourcesExchanged' in raw.stats).toBe(false)

    const m = migrate(raw)
    expect(m.version).toBe(SAVE_VERSION)
    expect(m.version).toBe(25)
    // Backfilled as a REAL Decimal zero (round-trips via the `{ $d }` wire shape, like lootHauled).
    expect(m.stats.resourcesExchanged instanceof Decimal).toBe(true)
    expect(m.stats.resourcesExchanged.eq(0)).toBe(true)

    // And the whole migrated save validates.
    expect(validateState(m).version).toBe(SAVE_VERSION)
  })

  it('keeps a Decimal resourcesExchanged a forward-compat v21 save already carries', () => {
    const raw = rawV21()
    raw.stats.resourcesExchanged = D(777) // already present — kept verbatim, not reset to 0
    const m = migrate(raw)
    expect(m.version).toBe(SAVE_VERSION)
    expect(m.stats.resourcesExchanged.eq(777)).toBe(true)
    expect(validateState(m).version).toBe(SAVE_VERSION)
  })
})

describe('market save — resourcesExchanged round-trip + validation', () => {
  it('exportSave/importSave preserves a NON-ZERO resourcesExchanged byte-identically', () => {
    const s = createInitialState('x-roundtrip', 99)
    s.stats.resourcesExchanged = D(123456789)
    const restored = importSave(exportSave(s))
    expect(restored.stats.resourcesExchanged.eq(123456789)).toBe(true)
    expect(serialize(restored)).toBe(serialize(s))
  })

  it('rejects a bad resourcesExchanged (negative / NaN / Infinity)', () => {
    for (const amount of [D(-1), D(Number.NaN), D(Number.POSITIVE_INFINITY)]) {
      const bad = createInitialState('x-bad', 7)
      bad.stats.resourcesExchanged = amount
      expect(() => validateState(bad)).toThrow()
    }
  })

  it('rejects a non-Decimal resourcesExchanged', () => {
    const bad = createInitialState('x-nondecimal', 8)
    ;(bad.stats as { resourcesExchanged: unknown }).resourcesExchanged = 5 // plain number, not Decimal
    expect(() => validateState(bad)).toThrow()
  })

  it('a fresh createInitialState carries resourcesExchanged 0 and round-trips byte-identically', () => {
    const s = createInitialState('x-fresh', 2026)
    expect(s.stats.resourcesExchanged.eq(0)).toBe(true)
    const restored = importSave(exportSave(s))
    expect(serialize(restored)).toBe(serialize(s))
    expect(validateState(restored).version).toBe(SAVE_VERSION)
  })
})
