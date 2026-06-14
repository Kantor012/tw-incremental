import { UNITS, UNIT_IDS, type UnitId } from '../content/units'

/**
 * Combat resolution — PURE, DETERMINISTIC, RNG-FREE (M1.3).
 *
 * A TW-style power model: the side with more power wins and (almost) wipes the
 * loser; the winner's casualties scale super-linearly with how close the fight
 * was, so a crushing victory is nearly bloodless while a narrow one is costly.
 * Morale / luck (the only RNG combat inputs) arrive in M5 — until then the same
 * inputs always yield the same outcome, which is what makes marches and raids
 * replay byte-identically online / offline / in the sim harness.
 *
 * Import discipline: depends only on the units catalogue (a pure data leaf), so
 * this module can never take part in an initialisation cycle. The systems that
 * own state mutation (marches.ts, raids.ts) call into here; nothing here reaches
 * back into them.
 */

/** The result of one engagement, expressed as loss FRACTIONS (0..1) per side. */
export interface BattleOutcome {
  /** True when the attacker's power strictly exceeds the defender's. */
  attackerWins: boolean
  /** Fraction of the attacking army lost (0 = unscathed, 1 = annihilated). */
  attackerLossFrac: number
  /** Fraction of the defending army lost. */
  defenderLossFrac: number
}

/**
 * Resolve a single engagement from raw power totals.
 *
 *  - atkPower > defPower → attacker wins; defender is wiped (lossFrac 1) and the
 *    attacker loses `(defPower/atkPower)^1.5` — the closer the match, the bloodier
 *    the win; a one-sided steamroll is nearly free.
 *  - otherwise (incl. a tie, and atkPower <= 0) → attacker loses; the attacking
 *    army is wiped and the defender loses `(atkPower/defPower)^1.5` (0 when the
 *    attacker brought no power at all).
 *
 * The exponent 1.5 is the TW-flavoured "small power gaps still cost real losses"
 * curve. No RNG, no clock, no allocation beyond the returned record.
 */
export function battleOutcome(atkPower: number, defPower: number): BattleOutcome {
  if (atkPower > defPower) {
    return {
      attackerWins: true,
      attackerLossFrac: defPower > 0 ? Math.pow(defPower / atkPower, 1.5) : 0,
      defenderLossFrac: 1,
    }
  }
  return {
    attackerWins: false,
    attackerLossFrac: 1,
    defenderLossFrac: atkPower > 0 ? Math.pow(atkPower / defPower, 1.5) : 0,
  }
}

/** Total offensive power of an army: Σ count * UnitDef.attack. */
export function armyAttackPower(units: Record<UnitId, number>): number {
  let power = 0
  for (const id of UNIT_IDS) power += (units[id] ?? 0) * UNITS[id].attack
  return power
}

/**
 * Total defensive power of an army vs infantry: Σ count * UnitDef.defInfantry.
 * M1.3 enemies (barbarians and raiders) are all infantry, so the infantry profile
 * is the right one for both the player garrison's defence and a barb camp's wall.
 */
export function armyDefensePower(units: Record<UnitId, number>): number {
  let power = 0
  for (const id of UNIT_IDS) power += (units[id] ?? 0) * UNITS[id].defInfantry
  return power
}

/** Total haul capacity of an army: Σ count * UnitDef.carry. */
export function armyCarry(units: Record<UnitId, number>): number {
  let carry = 0
  for (const id of UNIT_IDS) carry += (units[id] ?? 0) * UNITS[id].carry
  return carry
}

/**
 * Apply a loss fraction to every unit type, flooring survivors so counts stay
 * integral. Returns a FRESH, complete record (every UnitId present) — never
 * mutates the input — so callers can diff input vs output to count casualties.
 */
export function applyLosses(
  units: Record<UnitId, number>,
  lossFrac: number,
): Record<UnitId, number> {
  const survivors = {} as Record<UnitId, number>
  for (const id of UNIT_IDS) {
    survivors[id] = Math.floor((units[id] ?? 0) * (1 - lossFrac))
  }
  return survivors
}
