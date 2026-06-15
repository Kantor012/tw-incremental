import { describe, it, expect } from 'vitest'
import {
  battleOutcome,
  armyAttackPower,
  armyDefensePower,
  armyCarry,
  applyLosses,
} from '../src/systems/combat'
import { NO_TECH_MODS, type TechModifiers } from '../src/engine/state'
import { UNITS, UNIT_IDS, type UnitId } from '../src/content/units'

/** A full (all UnitId present) roster — combat fns take a complete record. */
function army(
  spearman = 0,
  swordsman = 0,
  axeman = 0,
  noble = 0,
  scout = 0,
): Record<UnitId, number> {
  return { spearman, swordsman, axeman, noble, scout }
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
})
