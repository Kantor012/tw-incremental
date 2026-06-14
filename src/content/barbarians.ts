import { D, type Decimal } from '../engine/decimal'
import { RESOURCE_IDS, type ResourceMap } from '../engine/state'

/**
 * Barbarian camp targets — a DETERMINISTIC, data-driven generator (no engine
 * logic, no RNG). A "target" is the M1.3 PvE source of loot: the player marches
 * an army at a camp of a chosen `level`, and both the wall it must beat and the
 * loot it can haul grow geometrically with that level, so there is always a
 * harder, richer camp to graduate to as the army grows — the width-not-depth
 * progression the loop needs (no auto-generated infinite tiers; a finite ladder).
 *
 * Numbers are intentionally provisional (the Balance phase tunes the curves
 * against the harness); the SHAPE — geometric defence/loot, a Decimal economy,
 * a finite level ceiling — is the contract.
 *
 * Import discipline: imports only `Decimal` plus value `RESOURCE_IDS` / erased
 * types from state.ts. state.ts does NOT import this module, so there is no
 * initialisation cycle.
 */

export interface BarbarianTarget {
  /** The camp tier (1..{@link MAX_TARGET_LEVEL}). */
  level: number
  /** Display name (PL). */
  name: string
  /** Wall strength the attacker's power must exceed to win (plain number). */
  defensePower: number
  /** Total resources the camp holds, per resource, on Decimal (haul is carry-capped). */
  loot: ResourceMap
  /** Distance in fields — drives march time (longer for higher tiers). */
  distance: number
}

/** Highest camp tier on the ladder. New tiers are a constant bump, never auto-grown. */
export const MAX_TARGET_LEVEL = 30

/** Defence of a level-1 camp; a single Topornik (atk 40) clears it. */
const BASE_DEFENSE = 30
/** Geometric defence growth per tier. */
const DEFENSE_GROWTH = 1.32
/** Loot per resource at level 1, on Decimal. */
const BASE_LOOT = 200
/** Geometric loot growth per tier. */
const LOOT_GROWTH = 1.25
/** Fields added per tier — higher camps sit farther away. */
const DISTANCE_PER_LEVEL = 3

/** Clamp an arbitrary (possibly hand-edited) level into the valid ladder range. */
function clampLevel(level: number): number {
  if (!Number.isFinite(level)) return 1
  const i = Math.floor(level)
  if (i < 1) return 1
  if (i > MAX_TARGET_LEVEL) return MAX_TARGET_LEVEL
  return i
}

/**
 * Build the (pure, deterministic) descriptor for a camp of the given level.
 * defensePower and loot scale as `base * growth^(level-1)`; loot is the SAME
 * Decimal value per resource (built over RESOURCE_IDS for a stable key order so
 * serialization round-trips identically). Safe for any input — the level is
 * clamped to [1, MAX_TARGET_LEVEL] first.
 */
export function barbarianTarget(level: number): BarbarianTarget {
  const lvl = clampLevel(level)
  const defensePower = Math.round(BASE_DEFENSE * Math.pow(DEFENSE_GROWTH, lvl - 1))
  const lootEach: Decimal = D(BASE_LOOT).mul(D(LOOT_GROWTH).pow(lvl - 1)).floor()
  const loot = {} as ResourceMap
  for (const r of RESOURCE_IDS) loot[r] = lootEach
  return {
    level: lvl,
    name: `Obóz barbarzyńców (poz. ${lvl})`,
    defensePower,
    loot,
    distance: lvl * DISTANCE_PER_LEVEL,
  }
}

/** The full ladder of attackable levels [1..MAX_TARGET_LEVEL], for UI/sim listing. */
export function availableTargetLevels(): number[] {
  const levels: number[] = []
  for (let l = 1; l <= MAX_TARGET_LEVEL; l++) levels.push(l)
  return levels
}
