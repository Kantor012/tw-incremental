import { describe, it, expect } from 'vitest'
import { D } from '../src/engine/decimal'
import {
  createInitialState,
  recomputeDerived,
  INITIAL_BUILDINGS,
  HORDE_INTERVAL,
  NO_TECH_MODS,
  type GameState,
} from '../src/engine/state'
import { advanceHorde, hordePower, hordeForecast } from '../src/systems/hordes'
import {
  HORDE_BASE,
  HORDE_PER_BUILDING_LEVEL,
  HORDE_PER_ARMY,
  HORDE_GROWTH,
  HORDE_BREACH_RESOURCE_FRAC,
  HORDE_BREACH_ARMY_FRAC,
  hordeEscalation,
} from '../src/content/hordes'
import { armyDefensePower, luckFactor, WORST_LUCK, BEST_LUCK } from '../src/systems/combat'
import { villageDefenseMult } from '../src/systems/buildings'
import { BUILDING_IDS } from '../src/content/buildings'
import { UNITS, type UnitId } from '../src/content/units'
import { checkAchievements, achievementUnlocked } from '../src/systems/achievements'
import { serialize } from '../src/engine/save'
import { RNG } from '../src/engine/rng'

/**
 * M7.2 horde-engine tests (systems/hordes.ts) — the active-defence counterpart to the
 * silent raid drip. These MIRROR tests/raids.ts in spirit: the telegraphed, escalating,
 * high-stakes invasion of the CAPITAL is advanced on the deterministic tick grid, draws
 * EXACTLY ONE combat-luck value per RESOLVED horde, and resolves byte-identically however
 * `dt` is sliced. Capitals are constructed against the LIVE formulas (hordePower +
 * armyDefensePower × villageDefenseMult), with each band assertion proved by the same
 * inequalities hordeForecast uses — so a balance retune surfaces loudly instead of silently
 * testing the wrong scenario.
 */

/** A full (all UnitId present) roster snapshot. */
function army(
  spearman = 0,
  swordsman = 0,
  axeman = 0,
  noble = 0,
  scout = 0,
  ram = 0,
  catapult = 0,
): Record<UnitId, number> {
  return { spearman, swordsman, axeman, noble, scout, ram, catapult }
}

/**
 * A state whose capital ('v0', "Stolica") has its starting buildings and a stocked
 * treasury — the horde schedule lives on the GLOBAL `s.horde`, not the village. Tests set
 * `s.horde.timer` / `s.villages.v0.units` to stage a specific resolution.
 */
function capital(seed = 'h'): GameState {
  const s = createInitialState(seed, 0)
  s.villages.v0.resources = { wood: D(1000), clay: D(1000), iron: D(1000) }
  return s
}

/**
 * A CAPITAL strong enough to repel the hordes it faces over a short window even on the
 * luckiest roll: 500 swordsmen behind a maxed wall. Used by the offline-catch-up and
 * dt-chunk-invariance cases, where the garrison must persist intact across several hordes.
 */
function strongCapital(seed: string): GameState {
  const s = createInitialState(seed, 0)
  const v = s.villages.v0
  v.resources = { wood: D(100000), clay: D(100000), iron: D(100000) }
  v.units = army(0, 500)
  v.buildings = { ...INITIAL_BUILDINGS, wall: 10 }
  recomputeDerived(s)
  return s
}

/** Sum of the capital's building levels — the structural part of the horde progress proxy. */
function buildingSum(s: GameState): number {
  let sum = 0
  for (const id of BUILDING_IDS) sum += s.villages.v0.buildings[id]
  return sum
}

/** The capital's effective horde defence (garrison × the wall shield) at NO_TECH_MODS. */
function capitalDefence(s: GameState): number {
  return armyDefensePower(s.villages.v0.units) * villageDefenseMult(s.villages.v0)
}

describe('hordePower — escalation', () => {
  it('escalates ONLY the structural threat geometrically — the army term is level-flat', () => {
    const s = capital()
    // With NO garrison the whole power IS the structural threat, so it escalates by exactly
    // HORDE_GROWTH per level (the per-building + flat base × growth^level).
    s.villages.v0.units = army() // 0 garrison
    s.horde.level = 0
    const p0 = hordePower(s)
    s.horde.level = 1
    const p1 = hordePower(s)
    s.horde.level = 5
    const p5 = hordePower(s)

    expect(p1).toBeGreaterThan(p0)
    expect(p5).toBeGreaterThan(p1)
    expect(p1 / p0).toBeCloseTo(HORDE_GROWTH)
    expect(p5 / p0).toBeCloseTo(Math.pow(HORDE_GROWTH, 5))

    // The PLAYER's army term is NOT escalated: adding the SAME garrison adds the SAME flat
    // increment (HORDE_PER_ARMY × armyDefense) at EVERY level. This is the fix for the
    // net-negative-lever bug — a growing garrison must never raise the incoming faster than it
    // raises the capital's own defence as the level climbs.
    const garrison = army(0, 50)
    const armyDef = armyDefensePower(garrison)
    for (const level of [0, 1, 5, 12]) {
      s.horde.level = level
      s.villages.v0.units = army() // structural-only
      const withoutArmy = hordePower(s)
      s.villages.v0.units = garrison
      const withArmy = hordePower(s)
      expect(withArmy - withoutArmy).toBeCloseTo(HORDE_PER_ARMY * armyDef)
    }
  })

  it('hordeEscalation is 1 at level 0 and floors a negative level to the base threat', () => {
    expect(hordeEscalation(0)).toBe(1)
    expect(hordeEscalation(-4)).toBe(1)
    expect(hordeEscalation(2)).toBeCloseTo(HORDE_GROWTH * HORDE_GROWTH)
  })
})

describe('advanceHorde', () => {
  it('counts the timer down without resolving while dt < timer', () => {
    const s = capital()
    s.villages.v0.units = army(0, 100)
    s.horde.timer = 200
    advanceHorde(s, s.battleLog, 50)

    expect(s.horde.timer).toBe(150)
    expect(s.horde.level).toBe(0)
    expect(s.battleLog.length).toBe(0)
  })

  it('a strong capital REPELS at timer 0: no loss, stats++, level++, timer re-armed, won horde report', () => {
    const s = capital()
    const v = s.villages.v0
    v.units = army(0, 100) // 100 swordsmen → defence 5000 ≫ incoming
    s.horde.timer = 5
    const stats = s.stats
    // Precondition: defence beats the incoming horde even on its luckiest roll → certain repel.
    expect(capitalDefence(s)).toBeGreaterThanOrEqual(hordePower(s) * BEST_LUCK)

    advanceHorde(s, s.battleLog, 5, NO_TECH_MODS, stats, new RNG(99))

    expect(s.battleLog.length).toBe(1)
    const r = s.battleLog[0]
    // Narrow off the discriminant so won/looted/losses are accessible — and the test fails
    // loudly if a non-horde report ever lands here.
    if (r.kind !== 'horde') throw new Error(`expected a horde report, got ${r.kind}`)
    expect(r.villageId).toBe('v0')
    expect(r.won).toBe(true) // repelled (player's view: won)
    expect(r.looted).toBe('0') // nothing stolen on a repel
    expect(r.losses).toBe(0)
    expect(typeof r.luck).toBe('number')
    expect(r.luck!).toBe(luckFactor(new RNG(99))) // the single draw per resolved horde

    // Nothing lost.
    expect(v.units.swordsman).toBe(100)
    expect(v.resources.wood.toString()).toBe('1000')

    // Counters bumped, escalation advanced, timer re-armed.
    expect(stats.hordesRepelled).toBe(1)
    expect(stats.hordesBreached).toBe(0)
    expect(s.horde.level).toBe(1)
    expect(s.horde.timer).toBe(HORDE_INTERVAL)
  })

  it('a weak capital is BREACHED: loses a fraction of each resource + garrison, stats++, no building razed', () => {
    const s = capital()
    const v = s.villages.v0
    v.units = army(0, 0, 10) // 10 axemen → defence 100 < incoming
    v.resources = { wood: D(1000), clay: D(1000), iron: D(1000) }
    const buildingsBefore = { ...v.buildings }
    const stats = s.stats
    s.horde.timer = 5
    // Precondition: even the weakest (player-luckiest) horde still breaks through → certain breach.
    expect(capitalDefence(s)).toBeLessThan(hordePower(s) * WORST_LUCK)

    advanceHorde(s, s.battleLog, 5, NO_TECH_MODS, stats, new RNG(7))

    expect(s.battleLog.length).toBe(1)
    const r = s.battleLog[0]
    if (r.kind !== 'horde') throw new Error(`expected a horde report, got ${r.kind}`)
    expect(r.villageId).toBe('v0')
    expect(r.won).toBe(false) // breached (player's view: lost)

    // A large slice of EACH resource hauled off (floored, never negative — recoverable).
    const stolen = Math.floor(1000 * HORDE_BREACH_RESOURCE_FRAC)
    expect(v.resources.wood.toString()).toBe(String(1000 - stolen))
    expect(v.resources.clay.toString()).toBe(String(1000 - stolen))
    expect(v.resources.iron.toString()).toBe(String(1000 - stolen))
    expect(r.looted).toBe(String(stolen * 3)) // total across the three pools

    // A chunk of the garrison falls (floored per type).
    const lost = Math.floor(10 * HORDE_BREACH_ARMY_FRAC)
    expect(v.units.axeman).toBe(10 - lost)
    expect(r.losses).toBe(lost)

    // Counters bumped, escalation advanced, timer re-armed.
    expect(stats.hordesBreached).toBe(1)
    expect(stats.hordesRepelled).toBe(0)
    expect(s.horde.level).toBe(1)
    expect(s.horde.timer).toBe(HORDE_INTERVAL)

    // NO building destroyed and the economy survives (no softlock — always recoverable).
    expect(v.buildings).toEqual(buildingsBefore)
    expect(v.resources.wood.gt(0)).toBe(true)
    expect(v.units.axeman).toBeGreaterThanOrEqual(0)
    expect(v.production.wood.gt(0)).toBe(true)
  })

  it('never drives a resource or a unit count below zero on a breach of a tiny pool', () => {
    const s = capital()
    const v = s.villages.v0
    v.units = army(0, 0, 1) // weak: the horde breaks through
    v.resources = { wood: D(3), clay: D(0), iron: D(1) }
    s.horde.timer = 5
    advanceHorde(s, s.battleLog, 5, NO_TECH_MODS, s.stats)

    // floor(3*frac), floor(0), floor(1*frac) can only ever remove a non-negative slice.
    expect(v.resources.wood.gte(0)).toBe(true)
    expect(v.resources.clay.gte(0)).toBe(true)
    expect(v.resources.iron.gte(0)).toBe(true)
    expect(v.units.axeman).toBeGreaterThanOrEqual(0)
  })

  it('resolves every horde that falls within one large dt (offline catch-up)', () => {
    const s = strongCapital('offline')
    advanceHorde(s, s.battleLog, HORDE_INTERVAL * 3, NO_TECH_MODS, s.stats, new RNG(5))

    expect(s.battleLog.length).toBe(3)
    for (const r of s.battleLog) expect(r).toMatchObject({ kind: 'horde', won: true })
    expect(s.stats.hordesRepelled).toBe(3)
    expect(s.horde.level).toBe(3)
    expect(s.horde.timer).toBe(HORDE_INTERVAL)
  })
})

describe('determinism — advanceHorde is dt-chunk invariant', () => {
  it('one big dt resolves identically to the same dt split into chunks (state incl. rngState)', () => {
    const total = HORDE_INTERVAL * 3

    // One-shot: the whole span in a single advanceHorde call.
    const one = strongCapital('det')
    const rngOne = new RNG(31337)
    advanceHorde(one, one.battleLog, total, NO_TECH_MODS, one.stats, rngOne)

    // Chunked: the SAME span fed in awkward 1000s slices (no slice aligns with a resolution),
    // through a fresh RNG seeded identically. The crux: the number + order of luck draws must
    // track the hordes that RESOLVE, never how `dt` was sliced.
    const many = strongCapital('det')
    const rngMany = new RNG(31337)
    let remaining = total
    const chunk = 1000
    while (remaining > 0) {
      const step = remaining < chunk ? remaining : chunk
      advanceHorde(many, many.battleLog, step, NO_TECH_MODS, many.stats, rngMany)
      remaining -= step
    }

    // Identical resulting state...
    expect(serialize(many)).toBe(serialize(one))
    // ...including the luck-stream position (the determinism guarantee).
    expect(rngMany.getState()).toBe(rngOne.getState())
    expect(many.stats).toEqual(one.stats)

    // Sanity: hordes actually resolved (so the equality is meaningful).
    expect(one.battleLog.length).toBe(3)
    expect(one.battleLog.every((r) => r.kind === 'horde' && r.won)).toBe(true)
  })
})

describe('hordeForecast — the 3-state defence outlook', () => {
  it('a strong capital reads as a certain defence (pewna obrona)', () => {
    const s = capital()
    s.villages.v0.buildings = { ...INITIAL_BUILDINGS, wall: 10 }
    s.villages.v0.units = army(0, 1000)
    recomputeDerived(s)
    // Holds even against the strongest (lucky) horde.
    expect(capitalDefence(s)).toBeGreaterThanOrEqual(hordePower(s) * BEST_LUCK)

    const fc = hordeForecast(s)
    expect(fc.kind).toBe('defended')
    expect(fc.cls).toBe('forecast-win')
    expect(fc.text).toContain('pewna obrona')
  })

  it('a weak capital reads as a certain breach (pewna porażka)', () => {
    const s = capital()
    s.villages.v0.units = army(0, 0, 1) // a single axeman → defence 10
    // Breaches even against the weakest (unlucky) horde.
    expect(capitalDefence(s)).toBeLessThan(hordePower(s) * WORST_LUCK)

    const fc = hordeForecast(s)
    expect(fc.kind).toBe('doomed')
    expect(fc.cls).toBe('forecast-lose')
    expect(fc.text).toContain('pewna porażka')
  })

  it('a marginal capital reads as a luck-dependent defence (ryzykowna)', () => {
    const s = capital()
    // Size the garrison so defence ≈ incoming (ratio ~1) → squarely in the luck-dependent
    // band. defence = baseFlat / (1 - HORDE_PER_ARMY) solves hordePower(level 0) = defence.
    const baseFlat = HORDE_BASE + HORDE_PER_BUILDING_LEVEL * buildingSum(s)
    const count = Math.round(baseFlat / (1 - HORDE_PER_ARMY) / UNITS.swordsman.defInfantry)
    s.villages.v0.units = army(0, count)

    const incoming = hordePower(s)
    const defence = capitalDefence(s)
    // Genuinely in between — neither a certain win nor a certain loss.
    expect(defence).toBeLessThan(incoming * BEST_LUCK)
    expect(defence).toBeGreaterThanOrEqual(incoming * WORST_LUCK)

    const fc = hordeForecast(s)
    expect(fc.kind).toBe('risky')
    expect(fc.cls).toBe('') // luck-dependent → neutral tint, the WORD carries the meaning
    expect(fc.text).toContain('ryzykowna')
  })
})

describe('horde achievements', () => {
  it('first_horde unlocks at the first repel, horde_bulwark at five', () => {
    const s = capital()
    expect(achievementUnlocked(s, 'first_horde')).toBe(false)
    checkAchievements(s)
    expect(achievementUnlocked(s, 'first_horde')).toBe(false) // nothing repelled yet

    s.stats.hordesRepelled = 1
    checkAchievements(s)
    expect(achievementUnlocked(s, 'first_horde')).toBe(true)
    expect(achievementUnlocked(s, 'horde_bulwark')).toBe(false)

    s.stats.hordesRepelled = 5
    checkAchievements(s)
    expect(achievementUnlocked(s, 'horde_bulwark')).toBe(true)
  })

  it('horde_veteran unlocks once the escalation level reaches its threshold', () => {
    const s = capital()
    s.horde.level = 9
    checkAchievements(s)
    expect(achievementUnlocked(s, 'horde_veteran')).toBe(false)

    s.horde.level = 10
    checkAchievements(s)
    expect(achievementUnlocked(s, 'horde_veteran')).toBe(true)
  })
})
