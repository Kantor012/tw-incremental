import { describe, it, expect } from 'vitest'
import {
  createInitialState,
  EVENT_INTERVAL,
  EVENT_TTL,
  NO_TECH_MODS,
  type GameState,
} from '../src/engine/state'
import {
  advanceEvents,
  claimEvent,
  watchtowerBuilt,
  aggregateEventBuffMods,
} from '../src/systems/events'
import { effectiveMods } from '../src/systems/prestige'
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
import { simulate } from '../src/engine/tick'
import { applyOffline } from '../src/engine/offline'

/**
 * M14 timed-buff tests (content/events.ts buff defs + systems/events.ts buff plumbing + the
 * v23->v24 save step + the effectiveMods fold).
 *
 * A buff is the game's FIRST temporary modifier (every tree/building mod is permanent). The
 * mechanic shares the M13 offer/claim plumbing but resolves to a single timed slot
 * (`events.buff`) that folds into effectiveMods only while it lasts and reverts the instant
 * advanceEvents counts it to zero. These tests prove the contracts the design leans on:
 *  (1) the catalogue is BOUNDED and touches ONLY the in-flight axes (attack/loot/march) v1
 *      promises (so a buff never perturbs a cached derived stat without a recomputeDerived);
 *  (2) aggregateEventBuffMods is the IDENTITY bag with no watchtower / no buff / a non-buff id
 *      (the byte-identity gate) and overlays the def's mods otherwise;
 *  (3) claimEvent installs a single replaceable slot; advanceEvents burns it down on the tick
 *      grid INDEPENDENTLY of the offer clock and signals expiry; a no-watchtower call is inert;
 *  (4) effectiveMods reflects the buff and reverts byte-identically on expiry;
 *  (5) the v23->v24 migration backfills the idle default and a live buff survives the
 *      serialize/deserialize + export/import round-trips; and
 *  (6) a buff burns down identically online (one big simulate) and offline (chunked grid).
 */

/** The three in-flight axes a v1 buff is allowed to touch (the cached axes are off-limits). */
const IN_FLIGHT_AXES = ['attackMult', 'lootMult', 'marchSpeedFrac'] as const

/** A fresh capital with a built watchtower (the gate ON). */
function capitalWithTower(seed = 'buff'): GameState {
  const s = createInitialState(seed, 0)
  s.villages.v0.buildings.watchtower = 1
  return s
}

describe('buff catalogue — bounded, in-flight-only, well-formed', () => {
  it('has at least 3 buff defs, each with a positive weight and a matching by-id entry', () => {
    const buffs = WORLD_EVENTS.filter((d) => d.kind === 'buff')
    expect(buffs.length).toBeGreaterThanOrEqual(3)
    for (const def of buffs) {
      expect(typeof def.id).toBe('string')
      expect(def.weight).toBeGreaterThan(0)
      expect(WORLD_EVENTS_BY_ID[def.id]).toBe(def)
    }
  })

  it('every buff has a finite, strictly positive duration', () => {
    for (const def of WORLD_EVENTS) {
      if (def.kind !== 'buff') continue
      expect(Number.isFinite(def.duration)).toBe(true)
      expect(def.duration).toBeGreaterThan(0)
    }
  })

  it('every buff touches ONLY the in-flight axes (attack/loot/march), never a cached one', () => {
    const allowed = new Set<string>(IN_FLIGHT_AXES)
    for (const def of WORLD_EVENTS) {
      if (def.kind !== 'buff') continue
      const keys = Object.keys(def.mods)
      expect(keys.length).toBeGreaterThan(0) // a buff must actually do something
      for (const k of keys) {
        // v1 forbids production/storage/pop/cost/recruit/defense/automations: those are CACHED
        // in derived fields and would need a recomputeDerived on start/expiry (a later iteration).
        expect(allowed.has(k)).toBe(true)
      }
    }
  })

  it('the catalogue carries the three designed buffs with the contracted magnitudes', () => {
    const piesn = WORLD_EVENTS_BY_ID['piesn_wojenna']
    const lowcy = WORLD_EVENTS_BY_ID['lowcy_lupow']
    const marsz = WORLD_EVENTS_BY_ID['forsowny_marsz']
    if (piesn.kind !== 'buff' || lowcy.kind !== 'buff' || marsz.kind !== 'buff') {
      throw new Error('test fixture: the three M14 buffs must be kind:buff')
    }
    expect(piesn.mods).toEqual({ attackMult: 1.6 })
    expect(lowcy.mods).toEqual({ lootMult: 1.6 })
    expect(marsz.mods).toEqual({ marchSpeedFrac: 0.35 })
  })
})

describe('aggregateEventBuffMods — identity gate + overlay', () => {
  it('returns a FRESH identity bag (no aliasing of NO_TECH_MODS) with no watchtower', () => {
    const s = createInitialState('no-tower', 0)
    expect(watchtowerBuilt(s)).toBe(false)
    const bag = aggregateEventBuffMods(s)
    expect(bag).toEqual(NO_TECH_MODS)
    // Mutating the result must never bleed into the shared constant or a later call.
    bag.attackMult = 99
    bag.productionMult.wood = 99
    bag.automations.build = true
    expect(NO_TECH_MODS.attackMult).toBe(1)
    expect(NO_TECH_MODS.productionMult.wood).toBe(1)
    expect(NO_TECH_MODS.automations.build).toBe(false)
    expect(aggregateEventBuffMods(s)).toEqual(NO_TECH_MODS)
  })

  it('is identity with a watchtower but no active buff', () => {
    const s = capitalWithTower()
    expect(s.events.buff).toBeNull()
    expect(aggregateEventBuffMods(s)).toEqual(NO_TECH_MODS)
  })

  it('overlays each in-flight buff onto an otherwise-identity bag', () => {
    const cases: Array<[string, Partial<typeof NO_TECH_MODS>]> = [
      ['piesn_wojenna', { attackMult: 1.6 }],
      ['lowcy_lupow', { lootMult: 1.6 }],
      ['forsowny_marsz', { marchSpeedFrac: 0.35 }],
    ]
    for (const [defId, expected] of cases) {
      const s = capitalWithTower()
      s.events.buff = { defId, remaining: 120 }
      const bag = aggregateEventBuffMods(s)
      expect(bag).toEqual({ ...NO_TECH_MODS, ...expected })
    }
  })

  it('is identity WITHOUT a watchtower even when a buff is somehow set (the gate)', () => {
    const s = createInitialState('gate', 0)
    s.events.buff = { defId: 'piesn_wojenna', remaining: 120 } // impossible in normal play
    expect(watchtowerBuilt(s)).toBe(false)
    expect(aggregateEventBuffMods(s)).toEqual(NO_TECH_MODS)
  })

  it('is identity for an unknown id or a WINDFALL id masquerading as a buff (defensive)', () => {
    const unknown = capitalWithTower()
    unknown.events.buff = { defId: 'does_not_exist', remaining: 120 }
    expect(aggregateEventBuffMods(unknown)).toEqual(NO_TECH_MODS)

    const windfallAsBuff = capitalWithTower()
    windfallAsBuff.events.buff = { defId: 'karawana', remaining: 120 } // karawana is a windfall
    expect(WORLD_EVENTS_BY_ID['karawana'].kind).toBe('windfall')
    expect(aggregateEventBuffMods(windfallAsBuff)).toEqual(NO_TECH_MODS)
  })
})

describe('claimEvent — installs a single, replaceable timed buff', () => {
  it('claiming a buff offer sets the slot, bumps the counter and clears/re-arms the offer', () => {
    const s = capitalWithTower()
    const woodBefore = s.villages.v0.resources.wood.toString()
    s.events.active = { defId: 'piesn_wojenna', ttl: EVENT_TTL, roll: 0.5 }

    expect(claimEvent(s)).toBe(true)

    const piesn = WORLD_EVENTS_BY_ID['piesn_wojenna']
    if (piesn.kind !== 'buff') throw new Error('fixture: piesn_wojenna must be a buff')
    expect(s.events.buff).toEqual({ defId: 'piesn_wojenna', remaining: piesn.duration })
    expect(s.stats.eventsResolved).toBe(1)
    expect(s.events.active).toBeNull()
    expect(s.events.timer).toBe(EVENT_INTERVAL)
    // A buff is NOT a resource grant — the capital treasury is untouched (unlike a windfall).
    expect(s.villages.v0.resources.wood.toString()).toBe(woodBefore)
  })

  it('a NEW buff REPLACES any one still running (single slot), bumping the counter again', () => {
    const s = capitalWithTower()
    s.events.buff = { defId: 'lowcy_lupow', remaining: 42 } // an older buff mid-flight
    s.events.active = { defId: 'piesn_wojenna', ttl: EVENT_TTL, roll: 0.5 }

    expect(claimEvent(s)).toBe(true)

    const piesn = WORLD_EVENTS_BY_ID['piesn_wojenna']
    if (piesn.kind !== 'buff') throw new Error('fixture: piesn_wojenna must be a buff')
    expect(s.events.buff).toEqual({ defId: 'piesn_wojenna', remaining: piesn.duration })
    expect(s.stats.eventsResolved).toBe(1)
  })
})

describe('advanceEvents — burns the buff down on the tick grid', () => {
  it('decrements remaining and returns false while the buff is still alive', () => {
    const s = capitalWithTower()
    s.events.buff = { defId: 'piesn_wojenna', remaining: 100 }
    expect(advanceEvents(s, 30)).toBe(false)
    expect(s.events.buff).toEqual({ defId: 'piesn_wojenna', remaining: 70 })
  })

  it('clears the slot and returns TRUE (the re-aggregation signal) on expiry', () => {
    const s = capitalWithTower()
    s.events.buff = { defId: 'piesn_wojenna', remaining: 70 }
    expect(advanceEvents(s, 100)).toBe(true) // overshoots to <= 0
    expect(s.events.buff).toBeNull()
    // And once cleared a further advance neither reports an expiry nor revives it.
    expect(advanceEvents(s, 10)).toBe(false)
    expect(s.events.buff).toBeNull()
  })

  it('the buff ticks even while an OFFER is active (decrement before the active early-return)', () => {
    const s = capitalWithTower()
    s.events.active = { defId: 'karawana', ttl: EVENT_TTL, roll: 0.5 }
    s.events.buff = { defId: 'piesn_wojenna', remaining: 50 }

    // An unclaimed offer freezes the SPAWN timer (M13) but must NEVER freeze the buff.
    expect(advanceEvents(s, 20)).toBe(false)
    expect(s.events.buff?.remaining).toBe(30)
    expect(s.events.active?.ttl).toBe(EVENT_TTL - 20) // the offer still counts down too
    expect(s.events.timer).toBe(EVENT_INTERVAL) // spawn clock frozen by the active offer

    // The buff still expires under an active offer, and signals it.
    expect(advanceEvents(s, 30)).toBe(true)
    expect(s.events.buff).toBeNull()
    expect(s.events.active).not.toBeNull() // the offer is untouched by the buff expiry
  })

  it('is a no-op on the buff without a watchtower (the gate freezes everything)', () => {
    const s = createInitialState('no-tower', 0)
    s.events.buff = { defId: 'piesn_wojenna', remaining: 100 } // impossible in normal play
    expect(advanceEvents(s, 50)).toBe(false)
    expect(s.events.buff).toEqual({ defId: 'piesn_wojenna', remaining: 100 }) // untouched
  })
})

describe('effectiveMods — reflects the buff and reverts byte-identically on expiry', () => {
  const cases: Array<[string, 'attackMult' | 'lootMult' | 'marchSpeedFrac']> = [
    ['piesn_wojenna', 'attackMult'],
    ['lowcy_lupow', 'lootMult'],
    ['forsowny_marsz', 'marchSpeedFrac'],
  ]

  for (const [defId, axis] of cases) {
    it(`${defId} lifts ${axis} while active and the bag reverts exactly when it expires`, () => {
      const s = capitalWithTower()
      const before = effectiveMods(s)

      s.events.buff = { defId, remaining: 100 }
      const during = effectiveMods(s)
      if (axis === 'marchSpeedFrac') {
        // A fraction ADDS: 0 -> 0.35.
        expect(during.marchSpeedFrac).toBeGreaterThan(before.marchSpeedFrac)
      } else {
        // A multiplier MULTIPLIES: 1 -> 1.6.
        expect(during[axis]).toBeGreaterThan(before[axis])
      }

      // Burn it down past its life; the bag must come back identical to the pre-buff bag.
      expect(advanceEvents(s, 100)).toBe(true)
      expect(s.events.buff).toBeNull()
      expect(effectiveMods(s)).toEqual(before)
    })
  }

  it('the attack buff scales the base attackMult by exactly the catalogue factor (1 -> 1.6)', () => {
    const s = capitalWithTower()
    const base = effectiveMods(s).attackMult
    s.events.buff = { defId: 'piesn_wojenna', remaining: 100 }
    expect(effectiveMods(s).attackMult).toBeCloseTo(base * 1.6, 10)
  })
})

/**
 * A v23-shaped raw save (pre-buff). Built by serialising a real current-version state and
 * DOWNGRADING it: drop the new `events.buff` slot and stamp version 23. Tracking the live
 * shape this way keeps the fixture from drifting.
 */
function rawV23(seed = 'buff-v23'): Record<string, any> {
  const fresh = createInitialState(seed, 4242)
  const raw = deserialize(serialize(fresh)) as unknown as Record<string, any>
  delete raw.events.buff
  raw.version = 23
  return raw
}

describe('buff save — v23 -> v24 migration backfill', () => {
  it('backfills events.buff:null on a v23 save that lacks it, then validates', () => {
    const raw = rawV23()
    expect('buff' in raw.events).toBe(false) // precondition: genuinely a pre-buff save

    const m = migrate(raw)
    expect(m.version).toBe(24)
    expect(m.version).toBe(SAVE_VERSION)
    expect(m.events.buff).toBeNull()
    expect(validateState(m).version).toBe(SAVE_VERSION)
  })

  it('preserves a valid buff a forward-compat v23 save already carries', () => {
    const raw = rawV23()
    raw.events.buff = { defId: 'lowcy_lupow', remaining: 120 }
    const m = migrate(raw)
    expect(m.events.buff).toEqual({ defId: 'lowcy_lupow', remaining: 120 })
    expect(validateState(m).version).toBe(SAVE_VERSION)
  })

  it('resets a non-object (string) buff to null during migration', () => {
    const raw = rawV23()
    raw.events.buff = 'corrupt'
    expect(migrate(raw).events.buff).toBeNull()
  })

  it('keeps a malformed buff OBJECT through migration but validateState rejects it', () => {
    // A windfall id as a buff is an OBJECT, so the migration keeps it (it vets shape, not
    // semantics); validateState is the gate that rejects defId not naming a kind:buff def.
    const raw = rawV23()
    raw.events.buff = { defId: 'karawana', remaining: 5 }
    const m = migrate(raw)
    expect(m.events.buff).toEqual({ defId: 'karawana', remaining: 5 })
    expect(() => validateState(m)).toThrow(/buff defId/)
  })

  it('rejects a buff with a negative / non-finite remaining', () => {
    const negative = rawV23()
    negative.events.buff = { defId: 'piesn_wojenna', remaining: -1 }
    expect(() => validateState(migrate(negative))).toThrow(/buff remaining/)

    const nan = rawV23()
    nan.events.buff = { defId: 'piesn_wojenna', remaining: Number.NaN }
    expect(() => validateState(migrate(nan))).toThrow(/buff remaining/)
  })
})

/**
 * A current-version state carrying a LIVE buff (and a live offer): a built watchtower, an
 * active offer mid-TTL, a buff mid-countdown, an advanced events RNG stream and a non-zero
 * lifetime counter. Built fresh per test so mutations never leak.
 */
function liveBuffState(seed = 'buff-rt'): GameState {
  const s = createInitialState(seed, 1717)
  s.villages.v0.buildings.watchtower = 2
  s.events = {
    rngState: 555111,
    timer: EVENT_INTERVAL,
    active: { defId: 'zyla_zelaza', ttl: 88, roll: 0.31 },
    buff: { defId: 'forsowny_marsz', remaining: 173 },
  }
  s.stats.eventsResolved = 7
  return s
}

describe('buff save — round-trip with a live buff', () => {
  it('serialize/deserialize preserves the buff slot and validates', () => {
    const s = liveBuffState()
    const json = serialize(s)
    const back = deserialize(json)

    expect(back.version).toBe(SAVE_VERSION)
    expect(back.events).toEqual(s.events)
    expect(back.events.buff).toEqual({ defId: 'forsowny_marsz', remaining: 173 })
    expect(serialize(back)).toBe(json) // idempotent round-trip
    expect(validateState(back)).toBe(back)
  })

  it('exportSave/importSave preserves the live buff byte-identically', () => {
    const s = liveBuffState()
    const restored = importSave(exportSave(s))
    expect(restored.events).toEqual(s.events)
    expect(restored.stats.eventsResolved).toBe(7)
    expect(serialize(restored)).toBe(serialize(s))
  })
})

describe('buff determinism + inertness', () => {
  it('a buff burns down identically online (one big simulate) and offline (chunked grid)', () => {
    const make = (): GameState => {
      const s = capitalWithTower('buff-det')
      s.lastSeen = 0
      // A buff mid-flight that EXPIRES inside the simulated span (250s < 400s), exercising the
      // expiry re-aggregation signal on both paths. 400 < EVENT_INTERVAL so no offer spawns and
      // the events RNG stream stays untouched, keeping the comparison about the buff itself.
      s.events.buff = { defId: 'piesn_wojenna', remaining: 250 }
      return s
    }
    const online = make()
    simulate(online, 400) // one big span, decomposed onto the grid internally
    online.lastSeen = 400 * 1000 // mirror applyOffline's lastSeen bookkeeping

    const offline = make()
    applyOffline(offline, 400 * 1000) // drives simulate(TICK_RATE) repeatedly

    expect(serialize(online)).toBe(serialize(offline))
    expect(online.events.buff).toBeNull() // expired on both paths
    expect(online.rngState).toBe(offline.rngState) // combat stream untouched, identical
  })

  it('a run WITHOUT a watchtower never grows a buff and folds to the identity bag (inert)', () => {
    const s = createInitialState('buff-inert', 0)
    s.lastSeen = 0
    const baseline = effectiveMods(s)
    simulate(s, EVENT_INTERVAL * 3) // long enough that, with a tower, buffs could spawn/claim
    expect(s.events.buff).toBeNull()
    expect(aggregateEventBuffMods(s)).toEqual(NO_TECH_MODS)
    expect(effectiveMods(s)).toEqual(baseline)
  })
})
