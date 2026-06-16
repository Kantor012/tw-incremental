import { D, type Decimal } from '../engine/decimal'
import { RESOURCE_IDS, type ResourceMap } from '../engine/state'

/**
 * Fortress targets (M7) — a DETERMINISTIC, data-driven generator (no engine logic,
 * no RNG), the boss-tier sibling of content/barbarians.ts. A fortress is a FINITE,
 * one-time high-value target: the player marches a REAL army (with siege) at it, and
 * a victorious assault razes it for good and hauls home a big loot cache. Distinct
 * from the grindable camps, fortresses sit at FAR rings, carry a MUCH higher wall and
 * a MUCH richer (one-shot) cache, and there are only {@link FORTRESS_COUNT} of them.
 *
 * The shape MIRRORS {@link import('./barbarians').barbarianTarget} EXACTLY — a plain
 * `number` defence, a Decimal `loot` map keyed over RESOURCE_IDS, a `distance` in
 * fields — so the march/combat path resolves a fortress through the identical maths;
 * only the curves (base/growth/boss multipliers) are bigger, so a fortress genuinely
 * needs an army a same-power camp would not. Numbers are intentionally provisional
 * (the Balance phase tunes them against the harness); the SHAPE is the contract.
 *
 * Import discipline: imports only `Decimal` plus value `RESOURCE_IDS` / erased types
 * from state.ts. state.ts does NOT import this module, so there is no initialisation
 * cycle (mirrors content/barbarians.ts exactly).
 */

export interface FortressTarget {
  /** The fortress tier (a high, far-ring level). */
  level: number
  /** Display name (PL). */
  name: string
  /** Wall strength the attacker's power must exceed to win (plain number) — a true boss. */
  defensePower: number
  /** One-time loot cache the fortress holds, per resource, on Decimal (haul is carry-capped). */
  loot: ResourceMap
  /** Distance in fields — drives march time (far, since fortress levels sit beyond the camps). */
  distance: number
}

/** How many fortresses exist per world — a small FINITE constant (width, not depth). */
export const FORTRESS_COUNT = 4

/** Tier of the nearest (weakest) fortress — already beyond the camp ladder (MAX_TARGET_LEVEL = 30). */
const FORTRESS_BASE_LEVEL = 35
/** Tier step between successive fortresses (each ring farther + stronger than the last). */
const FORTRESS_LEVEL_STEP = 5

/**
 * The per-index fortress tier scheme — `FORTRESS_COUNT` rising levels starting at
 * {@link FORTRESS_BASE_LEVEL}, one step apart. Derived (not hand-listed) so changing
 * the count/spacing is a single constant edit. world.ts places fortress `i` on the
 * ring for `FORTRESS_LEVELS[i]`, far beyond every camp tier.
 */
export const FORTRESS_LEVELS: readonly number[] = Array.from(
  { length: FORTRESS_COUNT },
  (_, i) => FORTRESS_BASE_LEVEL + i * FORTRESS_LEVEL_STEP,
)

/** Base defence of a level-1 fortress wall (before the boss multiplier). Mirrors barbarians' base. */
const BASE_DEFENSE = 30
/**
 * Geometric defence growth per tier. Deliberately GENTLER than a camp's 1.32: a fortress sits at a
 * FAR tier (>= {@link FORTRESS_BASE_LEVEL} = 35, beyond the level-30 camp ceiling), so at the camp's
 * own exponent its wall would balloon to ~1.5M — uncrackable by ANY single village, whose troop
 * budget is hard-capped by the farm's popCap (~1.5k). The softer exponent keeps the nearest fortress a
 * true SIEGE target — a wall far above the early/mid camps the player grinds, and uncrackable WITHOUT
 * the full ram train (see {@link DEFENSE_BOSS_MULT} / the harness fortress run) — while staying within
 * reach of a maxed capital that commits its WHOLE population to one all-in assault. The farther
 * fortresses (40/45/50) still scale past a single capital, so razing them stays a multi-village /
 * prestige goal.
 */
const DEFENSE_GROWTH = 1.21
/**
 * Boss multiplier on the fortress wall — a fortress is far harder than a same-tier camp (the
 * fortressTarget-vs-barbarianTarget contract). With the gentler {@link DEFENSE_GROWTH} this still
 * lands the nearest (level-35) wall in the top-camp range, and high enough that the assault is
 * impossible without the siege train's defence reduction ({@link import('../systems/combat').ramDefenseFactor}).
 */
const DEFENSE_BOSS_MULT = 4
/** Loot per resource at level 1, on Decimal (before the cache multiplier). Mirrors barbarians' base. */
const BASE_LOOT = 200
/** Geometric loot growth per tier (same exponent base as a camp). */
const LOOT_GROWTH = 1.25
/** Cache multiplier on the fortress haul — a one-time prize, far richer than a camp's loot. */
const LOOT_CACHE_MULT = 8
/** Fields added per tier — fortresses sit far out (mirrors barbarians' DISTANCE_PER_LEVEL). */
const DISTANCE_PER_LEVEL = 3

/** Clamp an arbitrary (possibly hand-edited) level to a sane positive integer tier. */
function clampLevel(level: number): number {
  if (!Number.isFinite(level)) return FORTRESS_BASE_LEVEL
  const i = Math.floor(level)
  if (i < 1) return 1
  return i
}

/**
 * Build the (pure, deterministic) descriptor for a fortress of the given level.
 * defensePower and loot scale as `base * growth^(level-1)` — IDENTICALLY to
 * {@link import('./barbarians').barbarianTarget} — then multiplied by the boss / cache
 * factors so a fortress is a true siege target with a big one-time prize. loot is the
 * SAME Decimal per resource, built over RESOURCE_IDS for a stable key order so
 * serialization round-trips identically. Safe for any input (level is clamped first).
 */
export function fortressTarget(level: number): FortressTarget {
  const lvl = clampLevel(level)
  const defensePower = Math.round(
    BASE_DEFENSE * Math.pow(DEFENSE_GROWTH, lvl - 1) * DEFENSE_BOSS_MULT,
  )
  const lootEach: Decimal = D(BASE_LOOT)
    .mul(D(LOOT_GROWTH).pow(lvl - 1))
    .mul(LOOT_CACHE_MULT)
    .floor()
  const loot = {} as ResourceMap
  for (const r of RESOURCE_IDS) loot[r] = lootEach
  return {
    level: lvl,
    name: fortressName(lvl),
    defensePower,
    loot,
    distance: lvl * DISTANCE_PER_LEVEL,
  }
}

/** Display name (PL) for a fortress of the given level, e.g. "Forteca (poz. 35)". */
export function fortressName(level: number): string {
  return `Forteca (poz. ${clampLevel(level)})`
}
