import type { TechModifiers } from '../engine/state'

/**
 * Paladin catalogue — PURE DATA + pure functions (M16 PALADYN).
 *
 * The FIRST hero that grows DIRECTLY from the PvE loop: the paladin earns XP from WON
 * attacks, levels up, and radiates a scaling AURA (a global attack+defence multiplier),
 * plus the game's FIRST player-activated ABILITY on a cooldown. None of it touches RNG —
 * the paladin (XP, levels, aura, cooldown) is PURELY DETERMINISTIC.
 *
 * Import discipline: this module imports ONLY the erased `TechModifiers` TYPE from
 * state.ts (no runtime value), so it is a pure data leaf — systems/paladin.ts and
 * save.ts can import these constants/functions without forming an initialisation cycle
 * (mirrors content/forge.ts).
 *
 * Numbers are intentionally provisional (the Balance phase / sim tunes the curves); the
 * SHAPE — a FINITE level ceiling (CLAUDE.md: never infinite depth), a moderate aura per
 * level, a strong-but-brief cooldown ability — is the contract.
 */

/**
 * Highest paladin level on the ladder (CLAUDE.md tree rule: a perk's depth is a finite
 * 1..10; the paladin is a single scaling node, so it caps at the top of that band).
 */
export const MAX_PALADIN_LEVEL = 10

/**
 * XP-curve knobs. {@link xpForLevel} is `round(XP_BASE * level^XP_EXP)` — a cumulative,
 * quadratic threshold so each level costs progressively more wins. Provisional knobs kept
 * named so the curve can be retuned without touching the formula.
 */
export const XP_BASE = 120
export const XP_EXP = 2

/**
 * CUMULATIVE XP required to REACH `level`: `round(XP_BASE * level^XP_EXP)`. Level 0 -> 0
 * (the start), strictly rising for level >= 1, always a finite non-negative integer. Pure
 * and deterministic (no RNG, no clock). Used by {@link import('../systems/paladin').gainPaladinXp}
 * to decide each promotion (xp >= xpForLevel(level + 1)).
 */
export function xpForLevel(level: number): number {
  if (!(level > 0)) return 0 // level 0 (and defensively any <= 0 / NaN) needs no XP
  return Math.round(XP_BASE * Math.pow(level, XP_EXP))
}

/**
 * Aura magnitude per paladin level: +3% to BOTH attack and defence per level (a MODERATE
 * multiplier per CLAUDE.md's 4–6 maxLevel band spirit — a maxed paladin is +30% atk/def).
 * Provisional — the Balance phase tunes it.
 */
export const AURA_PER_LEVEL = 0.03

/**
 * The paladin AURA multiplier at `level`: `1 + level * AURA_PER_LEVEL`, applied to attack
 * AND defence by one factor. Level 0 -> EXACTLY 1.0 (the identity), which is what keeps
 * paladinMods byte-identical to NO_TECH_MODS when the paladin has not yet levelled. Pure,
 * RNG-free.
 */
export function paladinAuraMult(level: number): number {
  if (!(level > 0)) return 1 // identity at level 0 (and defensively for any <= 0 / NaN)
  return 1 + level * AURA_PER_LEVEL
}

/**
 * Coefficient on sqrt(defence) for battle XP. The scaling is SUBLINEAR on purpose: camp
 * defence grows GEOMETRICALLY with tier (barbarians.ts: ~30 × 1.32^tier → ~5.9k at L20, ~23k
 * at L25, ~94k at L30), while the WHOLE level ladder costs only xpForLevel(10)=12000 XP. A
 * linear "XP = defence" reward let a SINGLE win on a mid/high camp max the paladin outright,
 * collapsing the M16 "fight → stronger paladin → fight" loop to one battle. Taking sqrt of the
 * defence keeps "harder target = more XP" while staying far behind the geometric wall, so every
 * tier needs MANY wins (k=8 → ~116 XP for a L8 camp, ~613 for L20, ~2136 for L29) — restoring
 * the self-reinforcing grind that is the heart of this milestone. Provisional knob.
 */
export const XP_PER_SQRT_DEFENSE = 8

/**
 * XP granted for a WON battle, SUBLINEAR in the DEFEATED target's defence power: `round(k *
 * sqrt(defence))` (see {@link XP_PER_SQRT_DEFENSE} for why sqrt, not linear). Pure,
 * deterministic, bounded to a finite non-negative integer (at least 1 for any positive win, so
 * even a trivial camp trains the paladin a little). Sized (with {@link xpForLevel}) so a
 * dedicated battle loop promotes the paladin several levels over MANY wins, not one.
 */
export function xpFromBattle(enemyDefensePower: number): number {
  if (!(enemyDefensePower > 0)) return 0
  return Math.max(1, Math.round(XP_PER_SQRT_DEFENSE * Math.sqrt(enemyDefensePower)))
}

/**
 * The paladin's ACTIVE ability (M16) — the game's FIRST player-triggered, cooldown-gated
 * buff. The player clicks "Użyj"; for {@link durationSecs} the paladin lends a strong
 * ATTACK surge ({@link mods}), then the ability is locked for {@link cooldownSecs}.
 *
 * `mods` is a {@link TechModifiers} Partial that uses ONLY the IN-FLIGHT combat axes (read
 * from the threaded mods bag at the moment of use): attack/defence/loot multipliers and the
 * march-speed fraction. It deliberately avoids the production/storage/pop axes, which are
 * CACHED in each village's derived fields (recomputeDerived) and so would need a recompute
 * to apply/revert — the in-flight axes revert cleanly the instant {@link import('../systems/paladin').advancePaladin}
 * clears the ability (the tick re-aggregates the mods bag on its expiry signal).
 *
 * `minLevel` gates activation: the paladin must have reached at least this level.
 */
export interface PaladinAbility {
  id: string
  name: string
  /** Short description (PL) for the UI. */
  desc: string
  /** How long the buff lasts once activated, in seconds. */
  durationSecs: number
  /** How long the ability is locked after use, in seconds (>> duration). */
  cooldownSecs: number
  /** Minimum paladin level required to activate. */
  minLevel: number
  /** The in-flight modifier bag the ability overlays while active. */
  mods: Partial<TechModifiers>
}

export const PALADIN_ABILITY: PaladinAbility = {
  id: 'paladin_charge',
  name: 'Szarża paladyna',
  desc: 'Paladyn prowadzi szarżę: +50% siły ataku wojsk przez krótki czas.',
  // A short, strong window (60s of +50% attack) on a long cooldown (10 min): a deliberate
  // burst the player times for a hard target, not a passive always-on bonus.
  durationSecs: 60,
  cooldownSecs: 600,
  // Available from the first level — the paladin can charge as soon as it exists.
  minLevel: 1,
  // ONLY the in-flight attack axis (×1.5). It MULTIPLIES onto the aura while active.
  mods: { attackMult: 1.5 },
}
