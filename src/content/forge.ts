/**
 * Forge catalogue — PURE DATA + pure multipliers (M15 KUŹNIA).
 *
 * The FIRST per-unit-type modifier in the game: the passive/prestige trees only ever
 * grant GLOBAL attack/defense multipliers, while the Kuźnia (a building) unlocks
 * PERMANENT, account-wide upgrades of CONCRETE unit types — one shared multiplier that
 * lifts a type's attack AND defence (the smith improves both weapon and armour).
 *
 * Import discipline: this module imports ONLY the units catalogue (a pure data leaf —
 * the `UnitId` type plus the `UNITS` cost table). It never imports the engine or the
 * combat system, so combat.ts can import `unitUpgradeMult` from here without forming an
 * initialisation cycle (combat → content/forge → content/units, all leaves).
 *
 * Costs are plain `number` (small fixed catalogue data); the live economy turns them
 * into Decimal at spend time (systems/forge.ts), exactly like the building/unit costs —
 * the "economy on Decimal" rule covers resource amounts/production, not authored
 * constants.
 */

import { UNITS, type UnitId } from './units'

/**
 * Bonus per upgrade LEVEL: +8% to both attack and defence of the upgraded unit type.
 * A STRONG-ish per-level multiplier (in the CLAUDE.md 2–3 maxLevel band's spirit), but
 * capped in depth by {@link FORGE_UPGRADES}.maxUpgrade and further by the live Kuźnia
 * level (systems/forge.effectiveMaxUpgrade), so the total per-type bonus stays bounded.
 * Provisional — the Balance phase tunes it against the harness.
 */
export const PER_LEVEL = 0.08

/**
 * Cost scaling for an upgrade: the next level costs the unit's BASE per-resource cost
 * × {@link FORGE_COST_BASE} × {@link FORGE_COST_GROWTH} ^ currentLevel — i.e. a rising
 * sink that scales with how strong the unit already is (an expensive unit is dearer to
 * upgrade). Provisional knobs (Balance only warns), kept as named constants so the curve
 * can be retuned without touching {@link upgradeCost}.
 */
export const FORGE_COST_BASE = 30
export const FORGE_COST_GROWTH = 1.7

/** Per-upgradeable-unit forge data: how deep its upgrade track goes (catalogue cap). */
export interface ForgeUpgradeDef {
  /**
   * Catalogue depth cap for this unit's upgrades (1..10 in CLAUDE.md spirit). The LIVE
   * cap is `min(maxUpgrade, forgeLevel)` (systems/forge.effectiveMaxUpgrade), so the
   * Kuźnia level gates how much of this track you can actually reach.
   */
  maxUpgrade: number
}

/**
 * Which unit types are UPGRADEABLE (data-driven, CLAUDE.md hard rule #5) and how deep.
 * Only the LINE COMBAT units — the infantry triad plus the cavalry pair — qualify; the
 * UTILITY / SIEGE units (scout / noble / ram / catapult) are deliberately EXCLUDED (a
 * forge sharpens weapons and armour, not recon range or a battering ram). A unit absent
 * from this map is not upgradeable ({@link isUpgradeable} returns false).
 */
export const FORGE_UPGRADES: Partial<Record<UnitId, ForgeUpgradeDef>> = {
  spearman: { maxUpgrade: 5 },
  swordsman: { maxUpgrade: 5 },
  axeman: { maxUpgrade: 5 },
  light_cavalry: { maxUpgrade: 5 },
  heavy_cavalry: { maxUpgrade: 5 },
}

/** Whether `unitId` can be upgraded at the Kuźnia (present in {@link FORGE_UPGRADES}). */
export function isUpgradeable(unitId: UnitId): boolean {
  return FORGE_UPGRADES[unitId] !== undefined
}

/**
 * Catalogue depth cap for `unitId` (0 for a non-upgradeable unit). The single source of
 * the per-type ceiling — read by systems/forge.effectiveMaxUpgrade (clamped further by the
 * live Kuźnia level) and by the save validation (a stored forge level may not exceed it).
 */
export function catalogMaxUpgrade(unitId: UnitId): number {
  return FORGE_UPGRADES[unitId]?.maxUpgrade ?? 0
}

/**
 * The combat multiplier a unit type at upgrade `level` fights with: `1 + level × PER_LEVEL`.
 * PURE and RNG-free. Level 0 (the default for every untouched type, and the only state a
 * no-Kuźnia run ever has) returns EXACTLY 1.0 — the identity — which is what keeps
 * armyAttackPower/armyDefensePower BYTE-IDENTICAL when no forge is threaded in (×1.0 is a
 * no-op on every finite value). The same multiplier lifts attack AND defence (one smith,
 * both weapon and armour).
 */
export function unitUpgradeMult(level: number): number {
  if (!(level > 0)) return 1 // identity for level 0 (and defensively for any <=0 / NaN)
  return 1 + level * PER_LEVEL
}

/**
 * Resource cost to raise `unitId` from `currentLevel` to `currentLevel + 1`: the unit's
 * BASE per-resource cost scaled by {@link FORGE_COST_BASE} × {@link FORGE_COST_GROWTH} ^
 * currentLevel, ceiled to whole resources. A rising sink (each level dearer than the
 * last). Plain numbers (catalogue data); systems/forge spends them as Decimal from the
 * capital. Provisional — Balance only warns on the curve.
 */
export function upgradeCost(
  unitId: UnitId,
  currentLevel: number,
): { wood: number; clay: number; iron: number } {
  const base = UNITS[unitId].cost
  const factor = FORGE_COST_BASE * Math.pow(FORGE_COST_GROWTH, currentLevel)
  return {
    wood: Math.ceil(base.wood * factor),
    clay: Math.ceil(base.clay * factor),
    iron: Math.ceil(base.iron * factor),
  }
}
