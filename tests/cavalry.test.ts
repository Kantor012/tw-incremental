import { describe, it, expect } from 'vitest'
import { D, type Decimal } from '../src/engine/decimal'
import {
  createInitialState,
  recomputeVillageDerived,
  INITIAL_BUILDINGS,
  INITIAL_UNITS,
  RESOURCE_IDS,
  type GameState,
  type Village,
} from '../src/engine/state'
import {
  unitUnlocked,
  canRecruit,
  recruit,
  recruitCost,
  freePopulation,
} from '../src/systems/recruitment'
import { build } from '../src/systems/buildings'
import { armyAttackPower, armyDefensePower } from '../src/systems/combat'
import { simulate } from '../src/engine/tick'
import { serialize, deserialize } from '../src/engine/save'
import { BUILDING_IDS, BUILDINGS } from '../src/content/buildings'
import { UNIT_IDS, UNITS, type UnitId } from '../src/content/units'

/**
 * M10 — KAWALERIA. The two cavalry units (`light_cavalry`, `heavy_cavalry`) are gated
 * behind the new Stajnia (`stable`). These tests stay GENERIC: they read costs / pops /
 * combat stats from the {@link UNITS} catalogue rather than hard-coding the provisional
 * numbers the Balance phase tunes, so they assert the SHAPE (append-only ids, gating,
 * spend/pop debit, combat contribution, inertness) and not a transient balance value.
 *
 * The whole point of M10's identity rule is that the Stajnia is `autoBuildable:false`, so
 * the cavalry it gates never unlocks in the MAIN run — a no-Stajnia run is byte-identical to
 * pre-M10. The last block proves exactly that against a key-stripped twin.
 */

/** The two cavalry ids, iterated generically so a test never special-cases one. */
const CAVALRY: readonly UnitId[] = ['light_cavalry', 'heavy_cavalry']

/** The capital village (`v0`) — the lone village in these single-village tests. */
function cap(state: GameState): Village {
  return state.villages.v0
}

/**
 * A state whose capital has BOTH the barracks and the Stajnia at level 1 (so the
 * infantry triad AND the cavalry are unlocked) with effectively unlimited resources and
 * population, so neither affordability nor popCap gates the recruitment assertions.
 * Setting the levels directly + recomputing mirrors what `build` does, minus the cost.
 */
function armedStable(seed = 'cav'): GameState {
  const state = createInitialState(seed, 0)
  const v = cap(state)
  v.resources = { wood: D(1e6), clay: D(1e6), iron: D(1e6) }
  v.buildings.barracks = 1
  v.buildings.stable = 1
  recomputeVillageDerived(v)
  v.popCap = D(1000) // headroom for the pop-heavy cavalry (set AFTER recompute resets it)
  return state
}

/** A full (all UnitId present) roster from the zero seed, with selected overrides applied. */
function roster(overrides: Partial<Record<UnitId, number>> = {}): Record<UnitId, number> {
  return { ...INITIAL_UNITS, ...overrides }
}

describe('cavalry catalogue (append-only ids)', () => {
  it('appends the two cavalry ids after catapult, as the LAST two units', () => {
    const cat = UNIT_IDS.indexOf('catapult')
    expect(cat).toBeGreaterThanOrEqual(0)
    expect(UNIT_IDS[cat + 1]).toBe('light_cavalry')
    expect(UNIT_IDS[cat + 2]).toBe('heavy_cavalry')
    expect(UNIT_IDS[UNIT_IDS.length - 2]).toBe('light_cavalry')
    expect(UNIT_IDS[UNIT_IDS.length - 1]).toBe('heavy_cavalry')
  })

  it('appends stable directly after market (M13 later appended the watchtower last)', () => {
    const mkt = BUILDING_IDS.indexOf('market')
    expect(mkt).toBeGreaterThanOrEqual(0)
    expect(BUILDING_IDS[mkt + 1]).toBe('stable')
    // Stable was the last building at M10; M13 appended the watchtower after it (append-only).
    expect(BUILDING_IDS[BUILDING_IDS.length - 2]).toBe('stable')
    expect(BUILDING_IDS[BUILDING_IDS.length - 1]).toBe('watchtower')
  })

  it('the cavalry require the Stajnia, which is excluded from auto-build (MAIN-run identity)', () => {
    for (const c of CAVALRY) expect(UNITS[c].requires).toBe('stable')
    // autoBuildable:false keeps the bot / in-game auto-build off the Stajnia, so the
    // cavalry never unlocks in the main run — the byte-identity rule rests on this flag.
    expect(BUILDINGS.stable.autoBuildable).toBe(false)
  })

  it('INITIAL_* seed the new ids at level / count 0', () => {
    expect(INITIAL_BUILDINGS.stable).toBe(0)
    for (const c of CAVALRY) expect(INITIAL_UNITS[c]).toBe(0)
  })
})

describe('fresh village carries the new ids inert', () => {
  it('a fresh capital has stable 0 + cavalry 0', () => {
    const v = cap(createInitialState('fresh', 0))
    expect(v.buildings.stable).toBe(0)
    for (const c of CAVALRY) expect(v.units[c]).toBe(0)
  })

  it('the Stajnia effect is INERT for derived stats (recruit_speed is consumed by recruitment)', () => {
    const v = cap(createInitialState('fresh', 0))
    const beforeProd = RESOURCE_IDS.map((r) => v.production[r].toString())
    const beforeStorage = v.storageCap.toString()
    const beforePop = v.popCap.toString()

    // Building the Stajnia must change NO tick-derived stat — exactly like the barracks,
    // whose recruit_speed is also a recompute no-op.
    v.buildings.stable = 5
    recomputeVillageDerived(v)

    RESOURCE_IDS.forEach((r, i) => expect(v.production[r].toString()).toBe(beforeProd[i]))
    expect(v.storageCap.toString()).toBe(beforeStorage)
    expect(v.popCap.toString()).toBe(beforePop)
  })
})

describe('cavalry unlock gating (unitUnlocked / canRecruit)', () => {
  it('cavalry is LOCKED without a Stajnia (reason names it) and recruit() is a no-op', () => {
    const state = createInitialState('locked', 0)
    const v = cap(state)
    v.resources = { wood: D(1e6), clay: D(1e6), iron: D(1e6) }
    v.popCap = D(1000)

    for (const c of CAVALRY) {
      expect(unitUnlocked(v, c)).toBe(false)
      const verdict = canRecruit(v, c, 1)
      expect(verdict.ok).toBe(false)
      expect(verdict.reason).toMatch(/stajni/i) // the unlock building is surfaced by name

      const before = serialize(state)
      expect(recruit(v, c, 1)).toBe(false)
      expect(serialize(state)).toBe(before) // nothing spent, nothing queued
      expect(v.recruitQueue.length).toBe(0)
      expect(v.units[c]).toBe(0)
    }
  })

  it('a barracks alone never unlocks the cavalry — only the Stajnia does', () => {
    const state = createInitialState('barracks-only', 0)
    const v = cap(state)
    v.resources = { wood: D(1e6), clay: D(1e6), iron: D(1e6) }
    v.popCap = D(1000)
    v.buildings.barracks = 10 // a tall barracks, still no stable
    recomputeVillageDerived(v)
    for (const c of CAVALRY) expect(unitUnlocked(v, c)).toBe(false)

    // The Stajnia is the gate; building it to level 1 unlocks every cavalry unit.
    v.buildings.stable = 1
    recomputeVillageDerived(v)
    for (const c of CAVALRY) {
      expect(unitUnlocked(v, c)).toBe(true)
      expect(canRecruit(v, c, 1).ok).toBe(true)
    }
  })
})

describe('recruiting cavalry (spend + population)', () => {
  it('debits the EXACT catalogue cost and cuts free population by pop*count', () => {
    for (const c of CAVALRY) {
      const state = armedStable()
      const v = cap(state)
      const count = 2

      const cost = recruitCost(c, count)
      // Cost is generically the catalogue per-unit cost times count (provisional-number proof).
      expect(cost.wood.toString()).toBe(D(UNITS[c].cost.wood).mul(count).toString())
      expect(cost.clay.toString()).toBe(D(UNITS[c].cost.clay).mul(count).toString())
      expect(cost.iron.toString()).toBe(D(UNITS[c].cost.iron).mul(count).toString())

      const wood = v.resources.wood
      const clay = v.resources.clay
      const iron = v.resources.iron
      const freeBefore = freePopulation(v)

      expect(recruit(v, c, count)).toBe(true)

      // Exact resource debit on Decimal.
      expect(v.resources.wood.toString()).toBe(wood.sub(cost.wood).toString())
      expect(v.resources.clay.toString()).toBe(clay.sub(cost.clay).toString())
      expect(v.resources.iron.toString()).toBe(iron.sub(cost.iron).toString())

      // Queued units count toward used population immediately, so free pop drops by pop*count.
      const freeDelta = (freeBefore as Decimal).sub(freePopulation(v))
      expect(freeDelta.toString()).toBe(D(UNITS[c].pop * count).toString())

      // One queued order; no unit minted yet (training has not advanced).
      expect(v.recruitQueue.length).toBe(1)
      expect(v.recruitQueue[0].unitId).toBe(c)
      expect(v.units[c]).toBe(0)
    }
  })
})

describe('cavalry combat contribution', () => {
  it('adds its attack to offence and its defInfantry to defence (army gets stronger)', () => {
    for (const c of CAVALRY) {
      const base = roster({ spearman: 10 })
      const withCav = roster({ spearman: 10 })
      withCav[c] = 4

      // Offence rises by exactly count * UnitDef.attack (the existing combat model).
      expect(armyAttackPower(withCav) - armyAttackPower(base)).toBeCloseTo(4 * UNITS[c].attack)
      // Defence rises by exactly count * UnitDef.defInfantry (defCavalry stays dormant).
      expect(armyDefensePower(withCav) - armyDefensePower(base)).toBeCloseTo(
        4 * UNITS[c].defInfantry,
      )

      // Both cavalry have attack > 0 and defInfantry > 0, so an army with them is stronger.
      expect(armyAttackPower(withCav)).toBeGreaterThan(armyAttackPower(base))
      expect(armyDefensePower(withCav)).toBeGreaterThan(armyDefensePower(base))
    }
  })
})

/**
 * Strip the M10 additions (stable building key + the two cavalry unit keys) from EVERY
 * village's buildings/units and from every in-flight march's unit roster, mutating in
 * place. Used to compare a real (key-bearing) run against the pre-M10-shaped twin.
 */
function stripCavalry(s: GameState): GameState {
  for (const id of s.villageOrder) {
    const v = s.villages[id] as unknown as {
      buildings: Record<string, number>
      units: Record<string, number>
      marches: { units: Record<string, number> }[]
    }
    delete v.buildings.stable
    for (const c of CAVALRY) delete v.units[c]
    for (const m of v.marches) for (const c of CAVALRY) delete m.units[c]
  }
  return s
}

/** Serialize a state with the M10 keys stripped out (round-trips through deserialize). */
function stripSerialized(json: string): string {
  return serialize(stripCavalry(deserialize(json)))
}

describe('no-Stajnia identity (the additions are inert)', () => {
  it('a no-Stajnia run serializes identically to the SAME run with the cavalry/stable keys stripped', () => {
    const SEED = 'identity'
    const full = createInitialState(SEED, 0) // carries stable:0 + cavalry:0 (M10 shape)
    const stripped = stripCavalry(createInitialState(SEED, 0)) // pre-M10 shape (keys removed)

    // Drive an identical, deterministic sequence on both: the same economy, the same build,
    // the same recruitment, the same mixed-step simulate grid. Neither ever touches the
    // Stajnia (so the cavalry never unlocks), which is the whole MAIN-run discipline.
    //
    // NOTE: the engine reads the roster/building maps through `?? 0` / `if (> 0)` guards in
    // the paths this run exercises (recompute, recruitSpeedMult, usedPopulation, the combat
    // power roll-ups, stationedUnits) — so a present-zero key and an absent key are
    // indistinguishable there: the inert additions never perturb any other field. The ONE
    // place that does NOT guard is raids/hordes `buildingLevelSum` (a bare Σ v.buildings[id]
    // over BUILDING_IDS), which the live engine only ever calls on a FULL, validated state
    // (no missing key). To keep the strip twin sound we keep both clocks dormant (a short
    // span, far under RAID_BASE_INTERVAL / HORDE_INTERVAL — no raid/horde resolves) and seed
    // a STATIONED garrison, so `raidsActive` short-circuits at its unit check before ever
    // touching `buildingLevelSum`.
    for (const state of [full, stripped]) {
      const v = cap(state)
      v.resources = { wood: D(1e6), clay: D(1e6), iron: D(1e6) }
      v.units.spearman = 10 // stationed garrison (present on both → raidsActive matches from t=0)
      expect(build(v, 'barracks')).toBe(true)
      recruit(v, 'spearman', 5)
    }
    for (const dt of [5, 13.37, 100, 250]) {
      simulate(full, dt)
      simulate(stripped, dt)
    }

    // The run with the inert keys, once those keys are stripped, is byte-identical to the
    // run that never had them — proof the additions never perturb any other state.
    expect(stripSerialized(serialize(full))).toBe(serialize(stripped))

    // Sanity: the run actually progressed, full still carries the inert keys at 0, and the
    // stripped twin genuinely lacks them.
    expect(cap(full).units.spearman).toBeGreaterThan(0)
    for (const c of CAVALRY) expect(cap(full).units[c]).toBe(0)
    // The Stajnia was never built — assert it directly (not just via the unconditional strip), so
    // an accidental build would FAIL here instead of being silently masked by stripCavalry (M10 review).
    expect(cap(full).buildings.stable).toBe(0)
    expect('stable' in cap(full).buildings).toBe(true)
    expect('stable' in cap(stripped).buildings).toBe(false)
  })
})
