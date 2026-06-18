import { describe, it, expect } from 'vitest'
import { D } from '../src/engine/decimal'
import {
  createInitialState,
  createVillage,
  NO_TECH_MODS,
  type GameState,
  type TechModifiers,
} from '../src/engine/state'
import { UNITS, UNIT_IDS, type UnitId } from '../src/content/units'
import {
  PER_LEVEL,
  FORGE_COST_BASE,
  FORGE_COST_GROWTH,
  FORGE_UPGRADES,
  isUpgradeable,
  catalogMaxUpgrade,
  unitUpgradeMult,
  upgradeCost,
} from '../src/content/forge'
import {
  forgeBuilt,
  forgeLevel,
  unitUpgradeLevel,
  effectiveMaxUpgrade,
  canUpgrade,
  upgradeUnit,
} from '../src/systems/forge'
import { armyAttackPower, armyDefensePower } from '../src/systems/combat'
import {
  serialize,
  deserialize,
  exportSave,
  importSave,
  migrate,
  validateState,
  SAVE_VERSION,
} from '../src/engine/save'

/**
 * M15 KUŹNIA tests (content/forge.ts + systems/forge.ts + the combat threading + the v24->v25 save
 * step). The mechanic is the FIRST per-unit-type modifier: a built Kuźnia unlocks PERMANENT,
 * account-wide upgrades of the line-combat types. These prove the two contracts the design leans on:
 * (1) the optional `forge` combat param is the IDENTITY when absent/empty (a no-Kuźnia run is
 * byte-identical to pre-M15), and (2) an upgrade lifts attack AND defence by EXACTLY
 * unitUpgradeMult per upgraded type — gated/capped by the player's deepest Kuźnia and paid from the
 * capital. Plus the schema discipline: the v24->v25 migration backfills the empty map + the new
 * counter, validateState rejects an unknown/out-of-range forge level, and a state carrying upgrades
 * survives serialize/deserialize and export/import round-trips intact.
 */

/** The exactly-upgradeable roster: the infantry triad + the cavalry pair (line combat only). */
const UPGRADEABLE: readonly UnitId[] = [
  'spearman',
  'swordsman',
  'axeman',
  'light_cavalry',
  'heavy_cavalry',
]
/** The deliberately-excluded utility / siege units. */
const NOT_UPGRADEABLE: readonly UnitId[] = ['noble', 'scout', 'ram', 'catapult']

/** A full (every UnitId present) roster — the combat fns take a complete record. */
function army(partial: Partial<Record<UnitId, number>> = {}): Record<UnitId, number> {
  const r = {} as Record<UnitId, number>
  for (const id of UNIT_IDS) r[id] = partial[id] ?? 0
  return r
}

/** NO_TECH_MODS with selected fields overridden — a terse way to build a TechModifiers. */
function mods(partial: Partial<TechModifiers>): TechModifiers {
  return { ...NO_TECH_MODS, ...partial }
}

/** A fresh capital with a Kuźnia at `level` and a deliberately over-stocked treasury. */
function capitalWithForge(level = 5, seed = 'forge'): GameState {
  const s = createInitialState(seed, 0)
  s.villages.v0.buildings.forge = level
  s.villages.v0.resources = { wood: D(1_000_000), clay: D(1_000_000), iron: D(1_000_000) }
  return s
}

describe('forge catalogue — only line combat is upgradeable, pure multiplier, rising cost', () => {
  it('exactly the infantry triad + cavalry pair are upgradeable; utility/siege are excluded', () => {
    for (const id of UNIT_IDS) {
      expect(isUpgradeable(id)).toBe(UPGRADEABLE.includes(id))
    }
    for (const id of UPGRADEABLE) {
      expect(isUpgradeable(id)).toBe(true)
      // catalogue depth cap is the documented ~5 (within the CLAUDE.md 1..10 band).
      expect(catalogMaxUpgrade(id)).toBe(5)
      expect(FORGE_UPGRADES[id]).toBeDefined()
    }
    for (const id of NOT_UPGRADEABLE) {
      expect(isUpgradeable(id)).toBe(false)
      // a non-upgradeable unit has catalogue cap 0 (so it can never carry an upgrade).
      expect(catalogMaxUpgrade(id)).toBe(0)
      expect(FORGE_UPGRADES[id]).toBeUndefined()
    }
  })

  it('unitUpgradeMult is pure: level 0 is EXACTLY 1.0 (identity), each level adds PER_LEVEL', () => {
    // Level 0 — and any <=0 / NaN defensively — is the identity, which is what keeps the optional
    // forge combat param a no-op (×1.0) when absent.
    expect(unitUpgradeMult(0)).toBe(1)
    expect(unitUpgradeMult(-1)).toBe(1)
    expect(unitUpgradeMult(Number.NaN)).toBe(1)
    for (let lvl = 1; lvl <= 10; lvl++) {
      expect(unitUpgradeMult(lvl)).toBeCloseTo(1 + lvl * PER_LEVEL, 12)
    }
    // PER_LEVEL is the documented +8% / level.
    expect(PER_LEVEL).toBeCloseTo(0.08, 12)
  })

  it('upgradeCost follows base × FORGE_COST_BASE × growth^level and rises every level', () => {
    // Concrete pin for the cheapest unit at level 0: {50,30,10} × 30.
    expect(upgradeCost('spearman', 0)).toEqual({ wood: 1500, clay: 900, iron: 300 })

    for (const id of UPGRADEABLE) {
      const base = UNITS[id].cost
      for (let lvl = 0; lvl <= 4; lvl++) {
        const factor = FORGE_COST_BASE * Math.pow(FORGE_COST_GROWTH, lvl)
        expect(upgradeCost(id, lvl)).toEqual({
          wood: Math.ceil(base.wood * factor),
          clay: Math.ceil(base.clay * factor),
          iron: Math.ceil(base.iron * factor),
        })
        // Rising sink: each next level is dearer in every resource (growth > 1).
        const next = upgradeCost(id, lvl + 1)
        const cur = upgradeCost(id, lvl)
        expect(next.wood).toBeGreaterThan(cur.wood)
        expect(next.clay).toBeGreaterThan(cur.clay)
        expect(next.iron).toBeGreaterThan(cur.iron)
      }
    }
  })
})

describe('systems/forge — gate, depth cap and the upgrade levels', () => {
  it('forgeBuilt / forgeLevel are false/0 on a fresh state', () => {
    const s = createInitialState('fresh', 0)
    expect(forgeBuilt(s)).toBe(false)
    expect(forgeLevel(s)).toBe(0)
    for (const id of UNIT_IDS) expect(unitUpgradeLevel(s, id)).toBe(0)
  })

  it('forgeLevel is the MAX Kuźnia level across all villages', () => {
    const s = createInitialState('multi', 0)
    s.villages.v0.buildings.forge = 2
    const v1 = createVillage('v1', 'Wioska', 10, 10)
    v1.buildings.forge = 4
    s.villages.v1 = v1
    s.villageOrder.push('v1')

    expect(forgeBuilt(s)).toBe(true)
    expect(forgeLevel(s)).toBe(4) // the deepest smithy in the empire is the cap
  })

  it('effectiveMaxUpgrade is min(catalogue cap, Kuźnia level); 0 for non-upgradeable', () => {
    const s = createInitialState('cap', 0)
    s.villages.v0.buildings.forge = 3
    expect(effectiveMaxUpgrade(s, 'spearman')).toBe(3) // min(5, 3)
    s.villages.v0.buildings.forge = 5
    expect(effectiveMaxUpgrade(s, 'spearman')).toBe(5) // min(5, 5)
    s.villages.v0.buildings.forge = 10
    expect(effectiveMaxUpgrade(s, 'spearman')).toBe(5) // catalogue cap binds (min(5, 10))
    // a non-upgradeable unit is always 0, however deep the Kuźnia.
    expect(effectiveMaxUpgrade(s, 'scout')).toBe(0)
  })

  it('canUpgrade gates on Kuźnia, upgradeability, cap and capital affordability', () => {
    // No Kuźnia -> always false.
    const noForge = createInitialState('noforge', 0)
    expect(canUpgrade(noForge, 'spearman')).toBe(false)

    const s = capitalWithForge(1)
    // Upgradeable + affordable + below the (forge-1) cap.
    expect(canUpgrade(s, 'spearman')).toBe(true)
    // Non-upgradeable unit -> false even with a Kuźnia and resources.
    expect(canUpgrade(s, 'scout')).toBe(false)

    // Affordability boundary: exactly the cost is enough; one short is not.
    const cost = upgradeCost('spearman', 0)
    s.villages.v0.resources = { wood: D(cost.wood), clay: D(cost.clay), iron: D(cost.iron) }
    expect(canUpgrade(s, 'spearman')).toBe(true)
    s.villages.v0.resources = { wood: D(cost.wood - 1), clay: D(cost.clay), iron: D(cost.iron) }
    expect(canUpgrade(s, 'spearman')).toBe(false)
  })

  it('upgradeUnit debits the capital, bumps the level + the lifetime counter, returns true', () => {
    const s = capitalWithForge(5)
    const cost = upgradeCost('spearman', 0)
    const wood0 = s.villages.v0.resources.wood

    expect(upgradeUnit(s, 'spearman')).toBe(true)

    // Cost is drawn from the capital (villageOrder[0]).
    expect(s.villages.v0.resources.wood.toString()).toBe(wood0.sub(cost.wood).toString())
    expect(s.villages.v0.resources.clay.toString()).toBe(D(1_000_000).sub(cost.clay).toString())
    expect(s.villages.v0.resources.iron.toString()).toBe(D(1_000_000).sub(cost.iron).toString())
    // Account-wide level + lifetime counter both advance by one.
    expect(s.forge.spearman).toBe(1)
    expect(unitUpgradeLevel(s, 'spearman')).toBe(1)
    expect(s.stats.unitsUpgraded).toBe(1)
  })

  it('upgradeUnit is capped by the Kuźnia level (depth cap), then a no-op', () => {
    const s = capitalWithForge(2) // forgeLevel 2 -> effectiveMax(spearman) = min(5,2) = 2
    expect(upgradeUnit(s, 'spearman')).toBe(true) // -> 1
    expect(upgradeUnit(s, 'spearman')).toBe(true) // -> 2 (at the cap)
    expect(s.forge.spearman).toBe(2)
    expect(s.stats.unitsUpgraded).toBe(2)

    // At the cap: no-op (false), no further debit, counter frozen.
    const snap = serialize(s)
    expect(upgradeUnit(s, 'spearman')).toBe(false)
    expect(s.forge.spearman).toBe(2)
    expect(s.stats.unitsUpgraded).toBe(2)
    expect(serialize(s)).toBe(snap) // truly untouched
  })

  it('upgradeUnit reaches the catalogue cap (5) with a deep Kuźnia, then stops', () => {
    const s = capitalWithForge(10) // forge maxed; catalogue cap (5) binds
    for (let i = 0; i < 5; i++) expect(upgradeUnit(s, 'spearman')).toBe(true)
    expect(s.forge.spearman).toBe(5)
    expect(upgradeUnit(s, 'spearman')).toBe(false) // catalogue ceiling
    expect(s.forge.spearman).toBe(5)
  })

  it('upgradeUnit is a no-op (false) without a Kuźnia and when the capital cannot pay', () => {
    // No Kuźnia.
    const noForge = createInitialState('noforge', 0)
    noForge.villages.v0.resources = { wood: D(1e9), clay: D(1e9), iron: D(1e9) }
    const before = serialize(noForge)
    expect(upgradeUnit(noForge, 'spearman')).toBe(false)
    expect(noForge.stats.unitsUpgraded).toBe(0)
    expect(noForge.forge.spearman).toBeUndefined()
    expect(serialize(noForge)).toBe(before)

    // Kuźnia but a broke capital.
    const broke = capitalWithForge(5)
    broke.villages.v0.resources = { wood: D(0), clay: D(0), iron: D(0) }
    expect(upgradeUnit(broke, 'spearman')).toBe(false)
    expect(broke.stats.unitsUpgraded).toBe(0)
    expect(broke.forge.spearman).toBeUndefined()
  })

  it('upgradeUnit refuses a non-upgradeable unit even with a Kuźnia and resources', () => {
    const s = capitalWithForge(5)
    expect(upgradeUnit(s, 'scout')).toBe(false)
    expect(s.forge.scout).toBeUndefined()
    expect(s.stats.unitsUpgraded).toBe(0)
  })

  it('the same seed + same upgrades is byte-identical (deterministic, RNG-free)', () => {
    const run = (): GameState => {
      const s = capitalWithForge(5, 'det')
      upgradeUnit(s, 'spearman')
      upgradeUnit(s, 'spearman')
      upgradeUnit(s, 'axeman')
      return s
    }
    expect(serialize(run())).toBe(serialize(run()))
  })
})

describe('combat threading — identity without forge, exact multiplier with it', () => {
  const a = army({ spearman: 10, axeman: 5, light_cavalry: 3, scout: 4 })

  it('armyAttackPower/armyDefensePower are BYTE-IDENTICAL without forge (undefined / {} / zeros)', () => {
    const atk = armyAttackPower(a, NO_TECH_MODS)
    expect(armyAttackPower(a, NO_TECH_MODS, undefined)).toBe(atk)
    expect(armyAttackPower(a, NO_TECH_MODS, {})).toBe(atk)
    expect(armyAttackPower(a, NO_TECH_MODS, { spearman: 0, axeman: 0 })).toBe(atk)

    const def = armyDefensePower(a, NO_TECH_MODS)
    expect(armyDefensePower(a, NO_TECH_MODS, undefined)).toBe(def)
    expect(armyDefensePower(a, NO_TECH_MODS, {})).toBe(def)
    expect(armyDefensePower(a, NO_TECH_MODS, { spearman: 0, light_cavalry: 0 })).toBe(def)
  })

  it('a uniform army scales attack AND defence by exactly unitUpgradeMult(level)', () => {
    const sp = army({ spearman: 10 })
    const baseAtk = armyAttackPower(sp, NO_TECH_MODS)
    const baseDef = armyDefensePower(sp, NO_TECH_MODS)
    for (let lvl = 0; lvl <= 5; lvl++) {
      // Single-type army: every contribution carries the same ×mult, so the total scales exactly
      // (the same arithmetic 100×mult on both sides — exact equality, not just close).
      expect(armyAttackPower(sp, NO_TECH_MODS, { spearman: lvl })).toBe(baseAtk * unitUpgradeMult(lvl))
      expect(armyDefensePower(sp, NO_TECH_MODS, { spearman: lvl })).toBe(baseDef * unitUpgradeMult(lvl))
    }
  })

  it('a mixed army lifts ONLY the upgraded type by its multiplier', () => {
    const baseAtk = armyAttackPower(a, NO_TECH_MODS)
    const got = armyAttackPower(a, NO_TECH_MODS, { spearman: 2 })
    const spearContrib = 10 * UNITS.spearman.attack
    const delta = spearContrib * (unitUpgradeMult(2) - 1)
    expect(got).toBeCloseTo(baseAtk + delta, 6)
    expect(got).toBeGreaterThan(baseAtk)
  })

  it('the tech mods multiplier still applies multiplicatively on top of the forge bonus', () => {
    const sp = army({ spearman: 10 })
    const m = mods({ defenseMult: 2, attackMult: 3 })
    expect(armyAttackPower(sp, m, { spearman: 3 })).toBeCloseTo(
      armyAttackPower(sp, m) * unitUpgradeMult(3),
      6,
    )
    expect(armyDefensePower(sp, m, { spearman: 3 })).toBeCloseTo(
      armyDefensePower(sp, m) * unitUpgradeMult(3),
      6,
    )
  })

  it('after a real upgradeUnit, armyAttackPower with state.forge rises by exactly the multiplier', () => {
    const s = capitalWithForge(5)
    upgradeUnit(s, 'spearman')
    upgradeUnit(s, 'spearman') // spearman at level 2
    const sp = army({ spearman: 10 })
    const base = armyAttackPower(sp, NO_TECH_MODS)
    const upgraded = armyAttackPower(sp, NO_TECH_MODS, s.forge)
    expect(upgraded).toBe(base * unitUpgradeMult(2))
    expect(upgraded).toBeGreaterThan(base)
  })
})

/**
 * A v24-shaped raw save (pre-forge). Built by serialising a real current-version state and
 * DOWNGRADING it: drop the `forge` map, the `stats.unitsUpgraded` counter and the `forge` building
 * key off every village, then stamp version 24. Tracking the live state shape this way keeps the
 * fixture from drifting; deserialize hands back real Decimals.
 */
function rawV24(seed = 'forge-v24'): Record<string, any> {
  const fresh = createInitialState(seed, 4242)
  const raw = deserialize(serialize(fresh)) as unknown as Record<string, any>
  delete raw.forge
  delete raw.stats.unitsUpgraded
  for (const id of raw.villageOrder) {
    delete raw.villages[id].buildings.forge
  }
  raw.version = 24
  return raw
}

describe('forge save — v24 -> v25 migration backfill (M15)', () => {
  it('backfills forge {}, unitsUpgraded 0 and forge:0 on every village, then validates', () => {
    const raw = rawV24()
    // Precondition: the v24 save genuinely lacks all three new bits.
    expect('forge' in raw).toBe(false)
    expect('unitsUpgraded' in raw.stats).toBe(false)
    expect('forge' in raw.villages.v0.buildings).toBe(false)

    const m = migrate(raw)
    expect(m.version).toBe(26)
    expect(m.version).toBe(SAVE_VERSION)

    expect(m.forge).toEqual({}) // empty upgrade map
    expect(m.stats.unitsUpgraded).toBe(0) // lifetime counter starts at zero
    expect(m.villages.v0.buildings.forge).toBe(0) // new building backfilled to 0

    // And the whole migrated save validates.
    expect(validateState(m).version).toBe(SAVE_VERSION)
  })

  it('preserves a forge map + counter a forward-compat v24 save already carries', () => {
    const raw = rawV24()
    raw.forge = { spearman: 3, axeman: 1 }
    raw.stats.unitsUpgraded = 7

    const m = migrate(raw)
    expect(m.forge).toEqual({ spearman: 3, axeman: 1 }) // kept verbatim, not reset
    expect(m.stats.unitsUpgraded).toBe(7)
    expect(validateState(m).version).toBe(SAVE_VERSION)
  })

  it('importSave of a v24 export migrates to v25 and validates', () => {
    const restored = importSave(exportSave(rawV24() as never))
    expect(restored.version).toBe(SAVE_VERSION)
    expect(restored.forge).toEqual({})
    expect(restored.stats.unitsUpgraded).toBe(0)
    expect(restored.villages.v0.buildings.forge).toBe(0)
  })
})

describe('forge save — validateState rejects a corrupt forge map', () => {
  it('rejects an unknown forge key', () => {
    const s = createInitialState('bad', 0) as unknown as Record<string, any>
    s.forge = { not_a_unit: 1 }
    expect(() => validateState(s)).toThrow(/forge/)
  })

  it('rejects a level above the catalogue cap', () => {
    const s = createInitialState('bad', 0) as unknown as Record<string, any>
    s.forge = { spearman: 6 } // catalogue cap is 5
    expect(() => validateState(s)).toThrow(/forge/)
  })

  it('rejects any non-zero level on a non-upgradeable unit (catalogue cap 0)', () => {
    const s = createInitialState('bad', 0) as unknown as Record<string, any>
    s.forge = { scout: 1 }
    expect(() => validateState(s)).toThrow(/forge/)
  })

  it('rejects a negative or fractional level', () => {
    const neg = createInitialState('neg', 0) as unknown as Record<string, any>
    neg.forge = { spearman: -1 }
    expect(() => validateState(neg)).toThrow(/forge/)

    const frac = createInitialState('frac', 0) as unknown as Record<string, any>
    frac.forge = { spearman: 1.5 }
    expect(() => validateState(frac)).toThrow(/forge/)
  })

  it('accepts a well-formed forge map (every level within [0, catalogue cap])', () => {
    const s = createInitialState('ok', 0)
    s.forge = { spearman: 5, axeman: 3, light_cavalry: 1 }
    expect(validateState(s)).toBe(s)
  })
})

/**
 * A v25 state carrying real upgrades: a built Kuźnia, a populated forge map and a non-zero lifetime
 * counter. Built fresh per test so mutations never leak between cases.
 */
function upgradedState(seed = 'forge-rt'): GameState {
  const s = createInitialState(seed, 1717)
  s.villages.v0.buildings.forge = 5
  s.forge = { spearman: 2, axeman: 1, heavy_cavalry: 4 }
  s.stats.unitsUpgraded = 7
  return s
}

describe('forge save — v25 round-trip with upgrades', () => {
  it('serialize/deserialize preserves the forge map, building level and the counter', () => {
    const s = upgradedState()
    const json = serialize(s)
    const back = deserialize(json)

    expect(back.version).toBe(SAVE_VERSION)
    expect(back.forge).toEqual(s.forge)
    expect(back.villages.v0.buildings.forge).toBe(5)
    expect(back.stats.unitsUpgraded).toBe(7)
    // serialize is idempotent across the round-trip (stable key order).
    expect(serialize(back)).toBe(json)
  })

  it('exportSave/importSave preserves the upgrades byte-identically and validates', () => {
    const s = upgradedState()
    const restored = importSave(exportSave(s))

    expect(restored.forge).toEqual(s.forge)
    expect(restored.stats.unitsUpgraded).toBe(7)
    // Byte-identical: the Kuźnia's recruit_speed is not a serialized derived field.
    expect(serialize(restored)).toBe(serialize(s))
    expect(validateState(restored)).toBe(restored)
  })
})
