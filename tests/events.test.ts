import { describe, it, expect } from 'vitest'
import { D, Decimal, isFiniteDecimal } from '../src/engine/decimal'
import {
  createInitialState,
  EVENT_INTERVAL,
  EVENT_TTL,
  RESOURCE_IDS,
  type GameState,
} from '../src/engine/state'
import { advanceEvents, claimEvent, watchtowerBuilt } from '../src/systems/events'
import { WORLD_EVENTS, WORLD_EVENTS_BY_ID } from '../src/content/events'
import {
  serialize,
  deserialize,
  exportSave,
  importSave,
  migrate,
  validateState,
  SAVE_VERSION,
} from '../src/engine/save'
import { RNG } from '../src/engine/rng'

/**
 * M13 world-events tests (content/events.ts + systems/events.ts + the v22->v23 save step).
 *
 * The mechanic is gated by the manually-built WATCHTOWER and draws from a SEPARATE seeded RNG
 * stream, so these prove the two contracts the design leans on: (1) every windfall is BOUNDED
 * (<= 25% of the storage cap total, each pool clamped to the cap, never NaN/negative, and
 * deterministic for a roll), and (2) advanceEvents is a pure NO-OP without a watchtower (the
 * byte-identity guarantee) and a well-behaved spawn/claim/expire clock with one. Plus the
 * schema discipline: the v22->v23 migration backfills the idle default, and a state carrying a
 * live offer survives serialize/deserialize and export/import round-trips intact.
 */

/** The total granted value summed across the three resource pools. */
function grantTotal(grant: Record<string, Decimal>): Decimal {
  let sum = D(0)
  for (const r of RESOURCE_IDS) sum = sum.add(grant[r])
  return sum
}

/** A fresh capital with a built watchtower (gate ON) and a stocked-from-empty treasury. */
function capitalWithTower(seed = 'evt'): GameState {
  const s = createInitialState(seed, 0)
  s.villages.v0.buildings.watchtower = 1
  return s
}

describe('events catalogue — bounded, non-negative, deterministic grants', () => {
  it('catalogue is well-formed: >=3 variants, positive weights, the by-id map matches', () => {
    expect(WORLD_EVENTS.length).toBeGreaterThanOrEqual(3)
    for (const def of WORLD_EVENTS) {
      expect(typeof def.id).toBe('string')
      expect(def.weight).toBeGreaterThan(0)
      expect(WORLD_EVENTS_BY_ID[def.id]).toBe(def)
    }
    // The by-id map has exactly one entry per catalogue def (no id collisions).
    expect(Object.keys(WORLD_EVENTS_BY_ID).length).toBe(WORLD_EVENTS.length)
  })

  it('every grant is bounded: total <= 25% of cap, each pool <= cap, never negative/NaN', () => {
    const cap = D(10000)
    const ceiling = cap.mul(0.25)
    // Sweep the roll range (0..just under 1) for every event.
    for (const def of WORLD_EVENTS) {
      for (const roll of [0, 0.1, 0.25, 0.5, 0.75, 0.9999]) {
        const grant = def.grant(roll, cap)
        for (const r of RESOURCE_IDS) {
          const amt = grant[r]
          expect(isFiniteDecimal(amt)).toBe(true) // never NaN / Infinity
          expect(amt.gte(0)).toBe(true) // never negative
          expect(amt.lte(cap)).toBe(true) // per-resource clamp to the cap
        }
        // The whole windfall stays under the 25% ceiling.
        expect(grantTotal(grant).lte(ceiling)).toBe(true)
      }
    }
  })

  it('grant size scales monotonically with the roll (a luckier roll never grants less)', () => {
    const cap = D(10000)
    for (const def of WORLD_EVENTS) {
      const low = grantTotal(def.grant(0, cap))
      const high = grantTotal(def.grant(0.9999, cap))
      expect(high.gte(low)).toBe(true)
      expect(high.gt(0)).toBe(true) // even the catalogue's leanest event grants something
    }
  })

  it('grant is deterministic: the same (roll, cap) yields byte-identical amounts', () => {
    const cap = D(7777)
    for (const def of WORLD_EVENTS) {
      const a = def.grant(0.42, cap)
      const b = def.grant(0.42, cap)
      for (const r of RESOURCE_IDS) {
        expect(a[r].toString()).toBe(b[r].toString())
      }
    }
  })
})

describe('advanceEvents — no watchtower is a pure no-op (the byte-identity gate)', () => {
  it('does not move the timer, draw RNG or spawn an offer, however large dt', () => {
    const s = createInitialState('inert', 0)
    expect(watchtowerBuilt(s)).toBe(false)
    const before = { ...s.events }
    const combatRngBefore = s.rngState

    advanceEvents(s, EVENT_INTERVAL * 5)

    // Events schedule frozen: timer, the separate RNG stream and `active` all untouched.
    expect(s.events.timer).toBe(before.timer)
    expect(s.events.rngState).toBe(before.rngState)
    expect(s.events.active).toBeNull()
    expect(s.stats.eventsResolved).toBe(0)
    // And the COMBAT-luck stream is never touched by the events engine.
    expect(s.rngState).toBe(combatRngBefore)
  })
})

describe('advanceEvents — with a watchtower the clock spawns and expires offers', () => {
  it('counts down without spawning while dt < timer', () => {
    const s = capitalWithTower()
    const rngBefore = s.events.rngState
    advanceEvents(s, EVENT_INTERVAL - 1)
    expect(s.events.active).toBeNull()
    expect(s.events.timer).toBe(1)
    expect(s.events.rngState).toBe(rngBefore) // no draw until an offer actually spawns
  })

  it('spawns exactly one valid offer when the timer elapses, re-arming the spawn clock', () => {
    const s = capitalWithTower()
    const rngBefore = s.events.rngState
    const combatBefore = s.rngState

    advanceEvents(s, EVENT_INTERVAL)

    const active = s.events.active
    expect(active).not.toBeNull()
    if (!active) throw new Error('expected an active offer')
    expect(Object.prototype.hasOwnProperty.call(WORLD_EVENTS_BY_ID, active.defId)).toBe(true)
    expect(active.ttl).toBe(EVENT_TTL)
    expect(active.roll).toBeGreaterThanOrEqual(0)
    expect(active.roll).toBeLessThan(1)
    // The spawn timer is re-armed a full interval out.
    expect(s.events.timer).toBe(EVENT_INTERVAL)
    // The SEPARATE events stream advanced (a weighted pick + a sizing roll); combat is untouched.
    expect(s.events.rngState).not.toBe(rngBefore)
    expect(s.rngState).toBe(combatBefore)
  })

  it('freezes the spawn timer while an offer is active and draws NO further RNG', () => {
    const s = capitalWithTower()
    advanceEvents(s, EVENT_INTERVAL) // spawn
    const rngAfterSpawn = s.events.rngState
    const offer = s.events.active
    if (!offer) throw new Error('expected an active offer')

    advanceEvents(s, 100)
    expect(s.events.active).toBe(offer) // same offer still on the table
    expect(offer.ttl).toBe(EVENT_TTL - 100) // only the TTL ticks
    expect(s.events.timer).toBe(EVENT_INTERVAL) // spawn clock frozen
    expect(s.events.rngState).toBe(rngAfterSpawn) // no draw while active
  })

  it('discards an unclaimed offer when its TTL lapses and re-arms the spawn clock', () => {
    const s = capitalWithTower()
    advanceEvents(s, EVENT_INTERVAL) // spawn
    expect(s.events.active).not.toBeNull()

    advanceEvents(s, EVENT_TTL) // exactly enough to lapse the offer
    expect(s.events.active).toBeNull()
    expect(s.events.timer).toBe(EVENT_INTERVAL)
    expect(s.stats.eventsResolved).toBe(0) // lapsing is not a resolution
  })
})

describe('claimEvent — bounded windfall to the capital', () => {
  it('grants the offer (clamped to the cap), bumps the lifetime counter and clears the offer', () => {
    const s = capitalWithTower()
    const v = s.villages.v0
    v.resources = { wood: D(0), clay: D(0), iron: D(0) }
    s.events.active = { defId: 'karawana', ttl: EVENT_TTL, roll: 0.5 }
    const expected = WORLD_EVENTS_BY_ID['karawana'].grant(0.5, v.storageCap)

    expect(claimEvent(s)).toBe(true)

    for (const r of RESOURCE_IDS) {
      const want = Decimal.min(v.storageCap, expected[r])
      expect(v.resources[r].toString()).toBe(want.toString())
    }
    expect(s.stats.eventsResolved).toBe(1)
    expect(s.events.active).toBeNull()
    expect(s.events.timer).toBe(EVENT_INTERVAL)
  })

  it('clamps each pool to the storage cap (a full warehouse never overflows)', () => {
    const s = capitalWithTower()
    const v = s.villages.v0
    v.resources = { wood: v.storageCap, clay: v.storageCap, iron: v.storageCap }
    s.events.active = { defId: 'zyla_zelaza', ttl: EVENT_TTL, roll: 0.9 }

    expect(claimEvent(s)).toBe(true)
    for (const r of RESOURCE_IDS) {
      // Already at the cap -> stays exactly at the cap (clamped, never above).
      expect(v.resources[r].toString()).toBe(v.storageCap.toString())
      expect(v.resources[r].lte(v.storageCap)).toBe(true)
    }
    expect(s.stats.eventsResolved).toBe(1)
  })

  it('returns false (no-op) when there is no active offer', () => {
    const s = capitalWithTower()
    expect(s.events.active).toBeNull()
    expect(claimEvent(s)).toBe(false)
    expect(s.stats.eventsResolved).toBe(0)
  })

  it('returns false (no-op) without a watchtower, even if an offer is somehow set', () => {
    const s = createInitialState('no-tower', 0)
    expect(watchtowerBuilt(s)).toBe(false)
    s.events.active = { defId: 'dary_lasu', ttl: EVENT_TTL, roll: 0.3 }
    const before = serialize(s)
    expect(claimEvent(s)).toBe(false)
    expect(s.stats.eventsResolved).toBe(0)
    expect(serialize(s)).toBe(before) // truly untouched
  })

  it('returns false for an unknown / corrupt defId', () => {
    const s = capitalWithTower()
    s.events.active = { defId: 'does_not_exist', ttl: EVENT_TTL, roll: 0.5 }
    expect(claimEvent(s)).toBe(false)
    expect(s.stats.eventsResolved).toBe(0)
  })
})

describe('events determinism — same seed yields the same offers and grants', () => {
  it('two identical spawn/claim runs end byte-identical (separate RNG stream is reproducible)', () => {
    const run = (): GameState => {
      const s = capitalWithTower('determinism')
      for (let i = 0; i < 4; i++) {
        advanceEvents(s, EVENT_INTERVAL) // spawn
        claimEvent(s) // resolve every offer deterministically
      }
      return s
    }
    const a = run()
    const b = run()
    expect(serialize(a)).toBe(serialize(b))
    expect(a.stats.eventsResolved).toBe(4)
    // The events stream advanced past its seed; the combat-luck stream stayed at its seed value.
    expect(a.events.rngState).not.toBe(RNG.fromString('determinism::events').getState())
    expect(a.rngState).toBe(RNG.fromString('determinism').getState())
  })

  it('the events stream is seeded independently of the combat stream', () => {
    const s = createInitialState('streams', 0)
    expect(s.events.rngState).toBe(RNG.fromString('streams::events').getState())
    expect(s.events.rngState).not.toBe(s.rngState)
  })
})

/**
 * A v22-shaped raw save (pre-events). Built by serialising a real current-version state and
 * DOWNGRADING it: drop the `events` schedule, the `stats.eventsResolved` counter and the
 * `watchtower` building key off every village, then stamp version 22. Tracking the live state
 * shape this way keeps the fixture from drifting; deserialize hands back real Decimals.
 */
function rawV22(seed = 'save-v22'): Record<string, any> {
  const fresh = createInitialState(seed, 4242)
  const raw = deserialize(serialize(fresh)) as unknown as Record<string, any>
  delete raw.events
  delete raw.stats.eventsResolved
  for (const id of raw.villageOrder) {
    delete raw.villages[id].buildings.watchtower
  }
  raw.version = 22
  return raw
}

describe('events save — v22 -> v23 migration backfill (M13)', () => {
  it('backfills the idle events schedule, eventsResolved 0 and watchtower:0, then validates', () => {
    const raw = rawV22()
    // Precondition: the v22 save genuinely lacks all three new bits.
    expect('events' in raw).toBe(false)
    expect('eventsResolved' in raw.stats).toBe(false)
    expect('watchtower' in raw.villages.v0.buildings).toBe(false)

    const m = migrate(raw)
    expect(m.version).toBe(SAVE_VERSION)
    expect(m.version).toBe(23)

    // The events clock starts idle, a full interval out, on the SEPARATE seeded stream.
    expect(m.events.active).toBeNull()
    expect(m.events.timer).toBe(EVENT_INTERVAL)
    expect(m.events.rngState).toBe(RNG.fromString('save-v22::events').getState())
    // Lifetime counter starts at zero; the new building backfills to 0.
    expect(m.stats.eventsResolved).toBe(0)
    expect(m.villages.v0.buildings.watchtower).toBe(0)

    // And the whole migrated save validates.
    expect(validateState(m).version).toBe(SAVE_VERSION)
  })

  it('preserves an events schedule a forward-compat v22 save already carries', () => {
    const raw = rawV22()
    const carried = {
      rngState: 12345,
      timer: 600,
      active: { defId: 'karawana', ttl: 200, roll: 0.5 },
    }
    raw.events = { ...carried, active: { ...carried.active } }
    const m = migrate(raw)
    expect(m.events).toEqual(carried) // carried verbatim, not reset
    expect(validateState(m).version).toBe(SAVE_VERSION)
  })

  it('importSave of a v22 export migrates to v23 and validates', () => {
    const restored = importSave(exportSave(rawV22() as never))
    expect(restored.version).toBe(SAVE_VERSION)
    expect(restored.events.active).toBeNull()
    expect(restored.events.timer).toBe(EVENT_INTERVAL)
    expect(restored.stats.eventsResolved).toBe(0)
    expect(restored.villages.v0.buildings.watchtower).toBe(0)
  })
})

/**
 * A v23 state carrying a LIVE offer: a built watchtower, an active offer mid-TTL, a re-armed
 * spawn timer, an advanced events RNG stream and a non-zero lifetime counter. Built fresh per
 * test so mutations never leak between cases.
 */
function liveOfferState(seed = 'save-v23'): GameState {
  const s = createInitialState(seed, 1717)
  s.villages.v0.buildings.watchtower = 3
  s.events = {
    rngState: 987654321,
    timer: EVENT_INTERVAL,
    active: { defId: 'zyla_zelaza', ttl: 123, roll: 0.42 },
  }
  s.stats.eventsResolved = 5
  return s
}

describe('events save — v23 round-trip with a live offer', () => {
  it('serialize/deserialize preserves the events schedule and the lifetime counter', () => {
    const s = liveOfferState()
    const json = serialize(s)
    const back = deserialize(json)

    expect(back.version).toBe(SAVE_VERSION)
    expect(back.events).toEqual(s.events)
    expect(back.stats.eventsResolved).toBe(5)
    // serialize is idempotent across the round-trip (stable key order).
    expect(serialize(back)).toBe(json)
  })

  it('exportSave/importSave preserves the live offer byte-identically', () => {
    const s = liveOfferState()
    const restored = importSave(exportSave(s))

    expect(restored.events).toEqual(s.events)
    expect(restored.stats.eventsResolved).toBe(5)
    // Byte-identical: the watchtower's defense_bonus is not a serialized derived field.
    expect(serialize(restored)).toBe(serialize(s))
    expect(validateState(restored)).toBe(restored)
  })

  it('validateState accepts a fresh state and the live-offer state', () => {
    expect(validateState(createInitialState('valid', 1)).version).toBe(SAVE_VERSION)
    const s = liveOfferState()
    expect(validateState(s)).toBe(s)
  })
})
