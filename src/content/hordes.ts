/**
 * Horde tuning + escalation curve (M7.2) — PURE DATA and PURE FORMULAS (no engine
 * logic, no clock, no RNG, no state mutation). The data leaf behind the telegraphed,
 * escalating, high-stakes invasion of the CAPITAL, the active-defence counterpart to
 * the silent raid drip (content/barbarians.ts is to marches what this is to hordes).
 *
 * The strength formula {@link hordePower} MIRRORS systems/raids' `raidPower` — a flat
 * base, a per-building-level term and a sub-weighted share of the army — but is BIGGER
 * (a horde is a real threat, not a drip) and ESCALATES geometrically with the horde
 * LEVEL, so each horde is harder than the last. It is expressed over PLAIN NUMBERS (the
 * capital's progress as `buildingLevelSum` + `armyDefense`, both read by the caller in
 * systems/hordes.ts) so this module stays a pure leaf: like content/era.ts it imports
 * NOTHING, adds no runtime edge and can never form an initialisation cycle. systems/
 * hordes.ts does the Village reads (buildings/units → the two numbers) and feeds them in,
 * exactly as raids.ts owns `raidPower(Village)` while content/barbarians owns the curves.
 *
 * Numbers are intentionally provisional (the Balance phase tunes them against the
 * harness so a NORMALLY-PROGRESSING capital REPELS the hordes it faces over a run — a
 * manageable tax, not a wipe); the SHAPE is the contract.
 */

/** Flat horde power floor — 4× the raid base (RAID_BASE = 10): a horde out-weighs a raid from the start. */
export const HORDE_BASE = 40
/**
 * Horde power added per total owned building level of the capital (a coarse progress
 * proxy). 2× the raid's per-building term so the horde scales with the empire faster.
 */
export const HORDE_PER_BUILDING_LEVEL = 6
/**
 * Fraction of the capital's TOTAL army defence the horde matches. Below 1 on purpose
 * (like the raid's 0.4, but higher) AND — crucially — NOT escalated by the horde level
 * (see {@link hordePower}): the army term is a flat 0.6× of the garrison, while the
 * capital's own defence weighs that same garrison at `defenseMult × villageDefenseMult`
 * (>= 1, rising with the wall + tech). Because 0.6 < 1 <= that weight at every level, the
 * army term can NEVER out-scale the capital's own garrison — so recruiting more troops
 * (plus the wall + tech) is ALWAYS a winning answer however high the escalation climbs.
 * Were the army term escalated too (as it once was), a high-level horde would raise its
 * own incoming faster than the garrison raises the defence, flipping the garrison into a
 * net-negative lever above ~level 5 — the bug this split fixes.
 */
export const HORDE_PER_ARMY = 0.6
/**
 * Geometric escalation per horde LEVEL, applied ONLY to the STRUCTURAL threat (the flat
 * base + the per-building-level term) in {@link hordePower}, never to the player's own
 * army term: the structural part is multiplied by HORDE_GROWTH^level, so level 0 is the
 * base threat and each subsequent horde's structural threat is {@link HORDE_GROWTH}× the
 * last at the same capital progress. Kept gentle (and HORDE_INTERVAL kept long) so the
 * handful of hordes a run faces stay within a normally-progressing capital's reach.
 */
export const HORDE_GROWTH = 1.12

/**
 * Fraction of EACH capital resource stolen on a BREACH (M7.2). Far above the raid's
 * RAID_LOOT_FRAC (0.2) — a breached horde costs much more than a lost raid — but always
 * a slice of the current pool (never negative), so it is recoverable: production refills
 * it and no building is ever destroyed (no softlock).
 */
export const HORDE_BREACH_RESOURCE_FRAC = 0.4
/**
 * Fraction of EACH unit type of the capital garrison lost on a BREACH (M7.2). A heavy
 * but recoverable blow — the recruit loop rebuilds the stack — and floored per type so
 * counts stay integral and never go below zero (no softlock).
 */
export const HORDE_BREACH_ARMY_FRAC = 0.3

/**
 * The geometric escalation multiplier for a horde at the given level: HORDE_GROWTH^level
 * (level 0 → 1, i.e. the un-escalated base threat). Clamped at level 0 so a negative
 * (corrupt) level can never shrink the threat below its base. Pure / deterministic.
 */
export function hordeEscalation(level: number): number {
  return Math.pow(HORDE_GROWTH, level > 0 ? level : 0)
}

/**
 * Strength of an incoming horde — a function of the horde LEVEL and the CAPITAL's
 * progress (its summed building levels + its army defence), mirroring `raidPower` but
 * bigger and level-escalated. `buildingLevelSum` and `armyDefense` are plain numbers the
 * caller (systems/hordes.ts) derives from the capital Village, keeping this module a pure
 * leaf. Returns a plain number (like raidPower) the resolution compares against the
 * capital's defence. Pure / deterministic: no clock, no RNG, no allocation.
 *
 * The escalation multiplies ONLY the STRUCTURAL threat (the flat base + the per-building
 * term), NOT the player's own army term: incoming = (HORDE_BASE + per-building) × growth^level
 * + HORDE_PER_ARMY × armyDefense. This keeps the garrison a winning lever at EVERY level —
 * the capital's defence weighs the same garrison at `defenseMult × villageDefenseMult` (>= 1),
 * always above the flat 0.6 the army term costs here, so recruiting + wall + tech always
 * out-paces the threat (see {@link HORDE_PER_ARMY}). Escalating the army term too (the old
 * curve) flipped the garrison net-negative above ~level 5 — recruiting then RAISED the
 * incoming faster than the defence — which this split fixes.
 */
export function hordePower(level: number, buildingLevelSum: number, armyDefense: number): number {
  const structural = (HORDE_BASE + HORDE_PER_BUILDING_LEVEL * buildingLevelSum) * hordeEscalation(level)
  return structural + HORDE_PER_ARMY * armyDefense
}
