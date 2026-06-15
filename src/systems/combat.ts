import { UNITS, UNIT_IDS, type UnitId } from '../content/units'
import { NO_TECH_MODS, type TechModifiers } from '../engine/state'
import { RNG } from '../engine/rng'

/**
 * Combat resolution — DETERMINISTIC (M1.3, luck added M5.5).
 *
 * A TW-style power model: the side with more power wins and (almost) wipes the
 * loser; the winner's casualties scale super-linearly with how close the fight
 * was, so a crushing victory is nearly bloodless while a narrow one is costly.
 * {@link battleOutcome} itself stays PURE and RNG-FREE — the only RNG combat
 * input is LUCK ({@link luckFactor}), a +/-{@link COMBAT_LUCK} symmetric roll
 * the callers apply to the ATTACKER's power BEFORE handing the final figures to
 * battleOutcome. Because every luck draw comes from the deterministic, persisted
 * `rngState` advanced on the fixed tick grid (see tick.ts), marches and raids
 * still replay byte-identically online / offline / in the sim harness.
 *
 * Import discipline: depends only on the units catalogue (a pure data leaf) and
 * the RNG class (a leaf with no imports), so this module can never take part in
 * an initialisation cycle. The systems that own state mutation (marches.ts,
 * raids.ts) call into here; nothing here reaches back into them.
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

/**
 * Combat LUCK band (M5.5) — the symmetric, TW-flavoured +/-25% variance applied
 * to the ATTACKER's power on every resolved engagement. A balance knob: tuning
 * this changes how swingy combat feels without touching {@link battleOutcome}.
 */
export const COMBAT_LUCK = 0.25
/** Worst-case luck multiplier (1 - {@link COMBAT_LUCK}); the auto-attacker plans for this. */
export const WORST_LUCK = 1 - COMBAT_LUCK
/** Best-case luck multiplier (1 + {@link COMBAT_LUCK}); used to spot a CERTAIN loss in forecasts. */
export const BEST_LUCK = 1 + COMBAT_LUCK

/**
 * Draw one luck multiplier for a single resolved engagement (M5.5).
 *
 * Returns a uniform sample in [{@link WORST_LUCK}, {@link BEST_LUCK}] =
 * [1-COMBAT_LUCK, 1+COMBAT_LUCK], i.e. mean 1.0 — symmetric, so over many fights
 * luck nets out and the 17 balance targets hold. Callers multiply the ATTACKER's
 * power by this BEFORE {@link battleOutcome}; battleOutcome stays RNG-free.
 *
 * DETERMINISM: draws from the passed {@link RNG} (the per-subStep instance seeded
 * from the persisted `rngState`). Call EXACTLY ONCE per resolved attack/raid — not
 * for scouts or unresolved (still-travelling) marches — so the count and order of
 * draws is invariant to how `dt` is chopped, which is what keeps `rngState` (and
 * thus every outcome) identical online / offline / chunked / in the sim.
 */
export function luckFactor(rng: RNG): number {
  return rng.range(WORST_LUCK, BEST_LUCK)
}

/**
 * Total offensive power of an army: (Σ count * UnitDef.attack) * mods.attackMult.
 *
 * `mods.attackMult` is the aggregated tech "military" multiplier (>= 1; 1 = no
 * bonus, the {@link NO_TECH_MODS} default). It scales the raw power total, so the
 * same army hits harder once attack perks are bought — applied uniformly across
 * unit types, which keeps {@link battleOutcome} unchanged (it only ever sees the
 * final power figure). Still pure / deterministic: no clock, no RNG.
 */
export function armyAttackPower(
  units: Record<UnitId, number>,
  mods: TechModifiers = NO_TECH_MODS,
): number {
  let power = 0
  for (const id of UNIT_IDS) power += (units[id] ?? 0) * UNITS[id].attack
  return power * mods.attackMult
}

/**
 * Total defensive power of an army vs infantry: (Σ count * UnitDef.defInfantry) *
 * mods.defenseMult.
 *
 * M1.3 enemies (barbarians and raiders) are all infantry, so the infantry profile
 * is the right one for both the player garrison's defence and a barb camp's wall.
 * `mods.defenseMult` is the aggregated tech "fortification" multiplier (>= 1;
 * default {@link NO_TECH_MODS} = 1). It scales the raw defence total uniformly,
 * leaving {@link battleOutcome} untouched. Pure / deterministic.
 */
export function armyDefensePower(
  units: Record<UnitId, number>,
  mods: TechModifiers = NO_TECH_MODS,
): number {
  let power = 0
  for (const id of UNIT_IDS) power += (units[id] ?? 0) * UNITS[id].defInfantry
  return power * mods.defenseMult
}

/**
 * Siege tuning (M5.3) — the two siege roles expressed as exported constants so
 * the march engine (marches.advanceMarches), the campaign forecast (campaign.ts)
 * and the tests all read the SAME numbers. One source of truth keeps the battle
 * the player is shown identical to the one the engine resolves.
 */
/** Effective-defence reduction one Taran contributes (multiplicative, per ram). */
export const RAM_DEF_RED = 0.02
/** Floor on the ram defence factor — rams can never cut more than (1 - this). */
export const RAM_DEF_MIN = 0.4
/** Catapults needed to raze ONE level off a beaten camp (step size). */
export const CATA_PER_LEVEL = 5
/** Hard cap on levels razed by a single won attack (upper limit). */
export const CATA_MAX_LEVELS = 3

/**
 * Multiplicative factor applied to the TARGET's defence when this army fights
 * (M5.3 ram role). Each Taran shaves {@link RAM_DEF_RED} off the camp's wall,
 * clamped to the band [{@link RAM_DEF_MIN}, 1]: zero rams → 1 (no change), and
 * even a huge siege train can never drop defence below RAM_DEF_MIN. The result is
 * a pure multiplier (1 = full defence, 0.4 = -60%), so callers just do
 * `defensePower * ramDefenseFactor(units)`. Deterministic — no clock, no RNG.
 */
export function ramDefenseFactor(units: Record<UnitId, number>): number {
  const ramCount = units.ram ?? 0
  const factor = 1 - ramCount * RAM_DEF_RED
  if (factor < RAM_DEF_MIN) return RAM_DEF_MIN
  if (factor > 1) return 1
  return factor
}

/**
 * Whole number of camp LEVELS a won attack's catapults raze (M5.3 catapult role).
 * Steps up by one for every {@link CATA_PER_LEVEL} catapults — `floor(count /
 * CATA_PER_LEVEL)` — and is capped at {@link CATA_MAX_LEVELS} so a single attack
 * can never flatten a high camp in one blow. Returns 0 with no catapults. The
 * caller (marches.advanceMarches) applies this only on a win and clamps the
 * camp's level to >= 1 (a camp is never razed out of existence). Pure / integral.
 */
export function catapultLevelDamage(units: Record<UnitId, number>): number {
  const catapultCount = units.catapult ?? 0
  const levels = Math.floor(catapultCount / CATA_PER_LEVEL)
  if (levels < 0) return 0
  if (levels > CATA_MAX_LEVELS) return CATA_MAX_LEVELS
  return levels
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
