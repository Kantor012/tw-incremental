import { describe, it, expect } from 'vitest'
import {
  battleOutcome,
  armyAttackPower,
  armyDefensePower,
  armyCarry,
  applyLosses,
  ramDefenseFactor,
  catapultLevelDamage,
  RAM_DEF_RED,
  RAM_DEF_MIN,
  CATA_PER_LEVEL,
  CATA_MAX_LEVELS,
  COMBAT_LUCK,
  WORST_LUCK,
  BEST_LUCK,
  luckFactor,
} from '../src/systems/combat'
import { NO_TECH_MODS, type TechModifiers } from '../src/engine/state'
import { UNITS, UNIT_IDS, type UnitId } from '../src/content/units'
import { RNG } from '../src/engine/rng'

/** A full (all UnitId present) roster — combat fns take a complete record. */
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

/** NO_TECH_MODS with selected fields overridden — a terse way to build a TechModifiers. */
function mods(partial: Partial<TechModifiers>): TechModifiers {
  return { ...NO_TECH_MODS, ...partial }
}

describe('battleOutcome', () => {
  it('stronger attacker wins with partial losses, defender wiped', () => {
    const o = battleOutcome(200, 30)
    expect(o.attackerWins).toBe(true)
    expect(o.defenderLossFrac).toBe(1)
    // attacker loss = (def/atk)^1.5 — the closer the fight, the bloodier the win.
    expect(o.attackerLossFrac).toBeCloseTo(Math.pow(30 / 200, 1.5))
    expect(o.attackerLossFrac).toBeGreaterThan(0)
    expect(o.attackerLossFrac).toBeLessThan(1)
  })

  it('weaker attacker is annihilated, defender takes proportional losses', () => {
    const o = battleOutcome(30, 200)
    expect(o.attackerWins).toBe(false)
    expect(o.attackerLossFrac).toBe(1)
    expect(o.defenderLossFrac).toBeCloseTo(Math.pow(30 / 200, 1.5))
  })

  it('a tie counts as a loss for the attacker (def must be strictly exceeded)', () => {
    const o = battleOutcome(50, 50)
    expect(o.attackerWins).toBe(false)
    expect(o.attackerLossFrac).toBe(1)
    expect(o.defenderLossFrac).toBe(1) // (50/50)^1.5 = 1
  })

  it('attacker with zero power loses and inflicts no losses', () => {
    const o = battleOutcome(0, 100)
    expect(o.attackerWins).toBe(false)
    expect(o.attackerLossFrac).toBe(1)
    expect(o.defenderLossFrac).toBe(0)
  })

  it('against zero defence the attacker wins unscathed', () => {
    const o = battleOutcome(100, 0)
    expect(o.attackerWins).toBe(true)
    expect(o.attackerLossFrac).toBe(0)
    expect(o.defenderLossFrac).toBe(1)
  })

  it('zero vs zero is a loss with no losses on either side', () => {
    const o = battleOutcome(0, 0)
    expect(o.attackerWins).toBe(false)
    expect(o.attackerLossFrac).toBe(1)
    expect(o.defenderLossFrac).toBe(0)
  })
})

describe('army power roll-ups', () => {
  it('armyAttackPower sums count * attack over the roster', () => {
    expect(armyAttackPower(army(2, 1, 3))).toBe(
      2 * UNITS.spearman.attack + 1 * UNITS.swordsman.attack + 3 * UNITS.axeman.attack,
    )
    expect(armyAttackPower(army())).toBe(0)
  })

  it('armyDefensePower sums count * defInfantry over the roster', () => {
    expect(armyDefensePower(army(2, 1, 3))).toBe(
      2 * UNITS.spearman.defInfantry +
        1 * UNITS.swordsman.defInfantry +
        3 * UNITS.axeman.defInfantry,
    )
    expect(armyDefensePower(army())).toBe(0)
  })

  it('armyCarry sums count * carry over the roster', () => {
    expect(armyCarry(army(2, 1, 3))).toBe(
      2 * UNITS.spearman.carry + 1 * UNITS.swordsman.carry + 3 * UNITS.axeman.carry,
    )
    expect(armyCarry(army())).toBe(0)
  })

  it('a scout-only army has no attack power and no carry (recon never fights/loots, M5.2)', () => {
    // A stack of pure scouts (army(...,scout)) brings 0 attack and 0 carry, so it can
    // never win a battle (battleOutcome needs power strictly > defence) nor haul loot —
    // the combat-side guarantee behind "scouts reveal, never fight, never loot".
    const scouts = army(0, 0, 0, 0, 20)
    expect(armyAttackPower(scouts)).toBe(0)
    expect(armyCarry(scouts)).toBe(0)
    // Adding scouts to a real army changes neither its attack power nor its carry.
    const force = army(0, 0, 5)
    expect(armyAttackPower(army(0, 0, 5, 0, 20))).toBe(armyAttackPower(force))
    expect(armyCarry(army(0, 0, 5, 0, 20))).toBe(armyCarry(force))
  })
})

describe('army power roll-ups with tech mods (M3.2)', () => {
  it('NO_TECH_MODS reproduces the bare attack / defence totals', () => {
    const a = army(2, 1, 3)
    expect(armyAttackPower(a, NO_TECH_MODS)).toBe(armyAttackPower(a))
    expect(armyDefensePower(a, NO_TECH_MODS)).toBe(armyDefensePower(a))
  })

  it('armyAttackPower scales by mods.attackMult, leaving defence/carry alone', () => {
    const a = army(2, 1, 3)
    const base = armyAttackPower(a)
    expect(armyAttackPower(a, mods({ attackMult: 1.5 }))).toBeCloseTo(base * 1.5)
    expect(armyAttackPower(a, mods({ attackMult: 2 }))).toBeCloseTo(base * 2)
    // defenseMult must NOT touch the attack roll-up.
    expect(armyAttackPower(a, mods({ defenseMult: 3 }))).toBe(base)
  })

  it('armyDefensePower scales by mods.defenseMult, leaving attack alone', () => {
    const a = army(2, 1, 3)
    const base = armyDefensePower(a)
    expect(armyDefensePower(a, mods({ defenseMult: 1.5 }))).toBeCloseTo(base * 1.5)
    // attackMult must NOT touch the defence roll-up.
    expect(armyDefensePower(a, mods({ attackMult: 3 }))).toBe(base)
  })

  it('a multiplier on an empty army is still zero', () => {
    expect(armyAttackPower(army(), mods({ attackMult: 5 }))).toBe(0)
    expect(armyDefensePower(army(), mods({ defenseMult: 5 }))).toBe(0)
  })

  it('the multiplier can flip a battle from a loss to a win', () => {
    // 3 spearmen (attack 30) vs a wall of 30 → a tie counts as a loss…
    const a = army(3, 0, 0)
    expect(armyAttackPower(a)).toBe(30)
    expect(battleOutcome(armyAttackPower(a), 30).attackerWins).toBe(false)
    // …but a +20% attack multiplier (36 > 30) wins it.
    expect(battleOutcome(armyAttackPower(a, mods({ attackMult: 1.2 })), 30).attackerWins).toBe(true)
  })
})

describe('applyLosses', () => {
  it('floors survivors per unit type and returns a fresh complete record', () => {
    const input = army(10, 5, 3)
    const out = applyLosses(input, 0.5)
    // floor(10*.5)=5, floor(5*.5)=2, floor(3*.5)=1
    expect(out).toEqual(army(5, 2, 1))
    // input is never mutated.
    expect(input).toEqual(army(10, 5, 3))
    // every UnitId is present in the result (a fresh full record).
    expect(Object.keys(out).sort()).toEqual([...UNIT_IDS].sort())
  })

  it('lossFrac 0 keeps the army intact; lossFrac 1 wipes it', () => {
    expect(applyLosses(army(7, 4, 2), 0)).toEqual(army(7, 4, 2))
    expect(applyLosses(army(7, 4, 2), 1)).toEqual(army(0, 0, 0))
  })

  it('survives the siege roster: rams/catapults attrit per type like any unit', () => {
    // army(spear, sword, axe, noble, scout, ram, catapult)
    const out = applyLosses(army(0, 0, 0, 0, 0, 10, 6), 0.5)
    expect(out.ram).toBe(5) // floor(10 * .5)
    expect(out.catapult).toBe(3) // floor(6 * .5)
    expect(Object.keys(out).sort()).toEqual([...UNIT_IDS].sort())
  })
})

// --- ram role: ramDefenseFactor (M5.3) --------------------------------------------

describe('ramDefenseFactor (M5.3)', () => {
  it('is 1 (no change) with no rams, regardless of other units', () => {
    expect(ramDefenseFactor(army())).toBe(1)
    // A huge non-siege army still leaves the wall untouched.
    expect(ramDefenseFactor(army(100, 100, 100, 5, 50))).toBe(1)
  })

  it('drops by RAM_DEF_RED per ram (the exact multiplicative cut)', () => {
    expect(ramDefenseFactor(army(0, 0, 0, 0, 0, 1))).toBeCloseTo(1 - RAM_DEF_RED)
    expect(ramDefenseFactor(army(0, 0, 0, 0, 0, 5))).toBeCloseTo(1 - 5 * RAM_DEF_RED)
    expect(ramDefenseFactor(army(0, 0, 0, 0, 0, 10))).toBeCloseTo(1 - 10 * RAM_DEF_RED)
  })

  it('decreases monotonically with more rams until it hits the floor', () => {
    let prev = ramDefenseFactor(army(0, 0, 0, 0, 0, 1))
    for (let rams = 2; rams <= 28; rams++) {
      const f = ramDefenseFactor(army(0, 0, 0, 0, 0, rams))
      expect(f).toBeLessThan(prev)
      expect(f).toBeGreaterThanOrEqual(RAM_DEF_MIN)
      prev = f
    }
  })

  it('is clamped to RAM_DEF_MIN — even a vast siege train cannot cut more', () => {
    // 1 - RAM_DEF_RED*ram <= RAM_DEF_MIN once ram >= (1-MIN)/RED; beyond that it pins.
    const atFloor = Math.ceil((1 - RAM_DEF_MIN) / RAM_DEF_RED)
    expect(ramDefenseFactor(army(0, 0, 0, 0, 0, atFloor))).toBeCloseTo(RAM_DEF_MIN)
    expect(ramDefenseFactor(army(0, 0, 0, 0, 0, atFloor + 50))).toBe(RAM_DEF_MIN)
    expect(ramDefenseFactor(army(0, 0, 0, 0, 0, 100000))).toBe(RAM_DEF_MIN)
    // Never below the floor.
    expect(ramDefenseFactor(army(0, 0, 0, 0, 0, 1e9))).toBeGreaterThanOrEqual(RAM_DEF_MIN)
  })

  it('a ram column flips a verdict purely by cutting the wall (same attack power)', () => {
    // The ram's cut is the ONLY difference: its own (puny) attack is already in `power`,
    // so this isolates the defence reduction. Tuning-robust — reads the real functions.
    const stack = army(0, 0, 2, 0, 0, 20) // 2 axemen + 20 rams
    const power = armyAttackPower(stack)
    const factor = ramDefenseFactor(stack)
    expect(factor).toBeCloseTo(1 - 20 * RAM_DEF_RED)
    // A wall strictly above the raw power → an unaided loss…
    const wall = power + 1
    expect(battleOutcome(power, wall).attackerWins).toBe(false)
    // …yet the SAME power beats the ram-cut wall (effDef = wall * factor < power).
    expect(wall * factor).toBeLessThan(power)
    expect(battleOutcome(power, wall * factor).attackerWins).toBe(true)
  })
})

// --- catapult role: catapultLevelDamage (M5.3) ------------------------------------

describe('catapultLevelDamage (M5.3)', () => {
  it('is 0 with no catapults (and ignores every other unit type)', () => {
    expect(catapultLevelDamage(army())).toBe(0)
    expect(catapultLevelDamage(army(100, 100, 100, 5, 50, 30))).toBe(0)
  })

  it('returns 0 below the CATA_PER_LEVEL threshold', () => {
    for (let c = 1; c < CATA_PER_LEVEL; c++) {
      expect(catapultLevelDamage(army(0, 0, 0, 0, 0, 0, c))).toBe(0)
    }
  })

  it('steps up by one level for every CATA_PER_LEVEL catapults (floor)', () => {
    expect(catapultLevelDamage(army(0, 0, 0, 0, 0, 0, CATA_PER_LEVEL))).toBe(1)
    expect(catapultLevelDamage(army(0, 0, 0, 0, 0, 0, CATA_PER_LEVEL + 1))).toBe(1)
    expect(catapultLevelDamage(army(0, 0, 0, 0, 0, 0, 2 * CATA_PER_LEVEL))).toBe(2)
    expect(catapultLevelDamage(army(0, 0, 0, 0, 0, 0, CATA_MAX_LEVELS * CATA_PER_LEVEL))).toBe(
      CATA_MAX_LEVELS,
    )
  })

  it('is capped at CATA_MAX_LEVELS no matter how many catapults', () => {
    expect(catapultLevelDamage(army(0, 0, 0, 0, 0, 0, (CATA_MAX_LEVELS + 5) * CATA_PER_LEVEL))).toBe(
      CATA_MAX_LEVELS,
    )
    expect(catapultLevelDamage(army(0, 0, 0, 0, 0, 0, 100000))).toBe(CATA_MAX_LEVELS)
  })

  it('always returns a whole, non-negative number of levels', () => {
    for (const c of [0, 1, 5, 7, 13, 99, 1000]) {
      const dmg = catapultLevelDamage(army(0, 0, 0, 0, 0, 0, c))
      expect(Number.isInteger(dmg)).toBe(true)
      expect(dmg).toBeGreaterThanOrEqual(0)
      expect(dmg).toBeLessThanOrEqual(CATA_MAX_LEVELS)
    }
  })
})

// --- combat LUCK: luckFactor + the WORST/BEST band (M5.5) --------------------------

describe('combat luck constants (M5.5)', () => {
  it('pins the +/-25% band: COMBAT_LUCK 0.25, WORST 0.75, BEST 1.25', () => {
    // Balance knob (COMBAT_LUCK) and the two derived planning constants are fixed and
    // symmetric around the mean 1.0 — the property the 17 balance goals rest on.
    expect(COMBAT_LUCK).toBe(0.25)
    expect(WORST_LUCK).toBe(1 - COMBAT_LUCK)
    expect(BEST_LUCK).toBe(1 + COMBAT_LUCK)
    expect(WORST_LUCK).toBe(0.75)
    expect(BEST_LUCK).toBe(1.25)
    // The band is symmetric: WORST and BEST are equidistant from 1.0.
    expect(1 - WORST_LUCK).toBeCloseTo(BEST_LUCK - 1)
  })
})

describe('luckFactor (M5.5)', () => {
  it('always lands inside [WORST_LUCK, BEST_LUCK) for any RNG state', () => {
    // Sample many independent streams: every draw must sit in the band — never below
    // worst luck (the floor the auto-attacker plans against) nor at/above best.
    for (let seed = 1; seed <= 5000; seed++) {
      const l = luckFactor(new RNG(seed))
      expect(l).toBeGreaterThanOrEqual(WORST_LUCK)
      expect(l).toBeLessThan(BEST_LUCK)
    }
  })

  it('averages ~1.0 over many draws (a symmetric, balance-neutral roll)', () => {
    // The whole point: luck is mean-1.0 so it adds variance without shifting the
    // economy's expected output. 50k draws from one stream pin the mean tightly.
    const rng = new RNG(123456)
    let sum = 0
    const n = 50000
    for (let i = 0; i < n; i++) sum += luckFactor(rng)
    expect(sum / n).toBeCloseTo(1.0, 2)
  })

  it('is deterministic: the same seed yields the same luck sequence', () => {
    const a = new RNG(42)
    const b = new RNG(42)
    for (let i = 0; i < 20; i++) expect(luckFactor(a)).toBe(luckFactor(b))
  })

  it('draws exactly once per call (advances the RNG by a single next())', () => {
    // The "exactly one draw per resolved engagement" invariant rests on luckFactor
    // consuming precisely one RNG step — so the draw count is invariant to dt chunking.
    const rng = new RNG(7)
    const clone = new RNG(7)
    luckFactor(rng)
    clone.next()
    expect(rng.getState()).toBe(clone.getState())
  })

  it('equals rng.range(1 - COMBAT_LUCK, 1 + COMBAT_LUCK) on the same stream', () => {
    // The contract spelled the band two ways (WORST/BEST vs 1±COMBAT_LUCK); they must
    // be identical, so a future retune of COMBAT_LUCK keeps a single source of truth.
    const a = new RNG(2024)
    const b = new RNG(2024)
    for (let i = 0; i < 10; i++) {
      expect(luckFactor(a)).toBe(b.range(1 - COMBAT_LUCK, 1 + COMBAT_LUCK))
    }
  })
})
