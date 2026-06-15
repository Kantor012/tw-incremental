import {
  createVillage,
  nextVillageId,
  recomputeDerived,
  type GameState,
  type World,
  type VillageId,
  type BattleReport,
} from '../engine/state'
import type { UnitId } from '../content/units'
import { barbarianById } from './world'

/**
 * Conquest engine (M2.4) — the loyalty → capture pipeline.
 *
 * A barbarian village is taken not in one blow but by ATTRITION of its loyalty: a
 * won attack carrying a surviving {@link UnitId} `'noble'` (Szlachcic) knocks the
 * target's {@link import('../engine/state').BarbarianVillage.loyalty} down by
 * {@link LOYALTY_NOBLE_HIT} per survivor; the loyalty regenerates slowly between
 * raids ({@link LOYALTY_REGEN_PER_SEC}); drive it to <= 0 and the camp flips into a
 * player village in place. The loyalty arithmetic on a won march lives in
 * marches.ts (which owns the battle result); this module owns the three knobs, the
 * world-wide regeneration step and the one IRREVERSIBLE state mutation —
 * {@link applyConquest} — so capture happens in exactly one place, called once per
 * sub-step by the tick AFTER every village's marches have resolved.
 *
 * Pure & Node-safe: no DOM, no clock, no RNG. Determinism comes from the caller's
 * fixed ordering (tick.ts): all marches resolve first, collected conquest events
 * apply in array order, then loyalty regenerates exactly once for the sub-step.
 *
 * Import discipline (cycle-safe): imports `createVillage` / `nextVillageId` (values)
 * and erased types from state.ts, and `barbarianById` from world.ts. Neither state.ts
 * nor world.ts imports this module, so no initialisation cycle is formed. marches.ts
 * and tick.ts import FROM here.
 */

/**
 * A capture earned within one sub-step: the surviving-noble attack dispatched from
 * `attackerVillageId` drove barbarian `barbId`'s loyalty to <= 0. {@link advanceMarches}
 * RETURNS these rather than capturing inline — minting a player village must not resize
 * `villages` / `villageOrder` under the tick's village iterator — and tick.ts applies each
 * via {@link applyConquest} after every village has advanced. Declared here (the module that
 * owns the conquest pipeline) and imported by marches.ts, which produces the events.
 */
export type ConquestEvent = { barbId: string; attackerVillageId: VillageId }

/** Full loyalty — the value a barbarian village starts at and regenerates toward (hardest to take). */
export const LOYALTY_MAX = 100

/**
 * Loyalty removed per SURVIVING noble in a won attack. With the default ({@link LOYALTY_MAX}
 * / this = 4) a single-noble army needs ~4 clean wins to capture a full-loyalty camp;
 * regeneration between raids pushes the real count a little higher. Balance knob.
 */
export const LOYALTY_NOBLE_HIT = 25

/**
 * Loyalty regained per second by EVERY surviving barbarian village (applied once per
 * sub-step via {@link advanceWorldLoyalty}). Deliberately slow so a stalled siege
 * loses ground but a steady stream of noble attacks still converges. Balance knob.
 */
export const LOYALTY_REGEN_PER_SEC = 0.02

/**
 * How many nobles sit in a roster (subset or full). Reads the `'noble'` count
 * defensively (a partial roster from an old save may lack the key) so callers in
 * marches.ts can count survivors without assuming a complete record.
 */
export function nobleCount(units: Record<UnitId, number>): number {
  return units.noble ?? 0
}

/**
 * Regenerate loyalty for every barbarian village by {@link LOYALTY_REGEN_PER_SEC} · dt,
 * clamped up to {@link LOYALTY_MAX}. Called ONCE per sub-step (not per village) so the
 * regeneration rate is independent of how many player villages exist — keeping balance
 * and replay deterministic. Captured villages are already removed from `world.barbarians`
 * by {@link applyConquest} before this runs, so they never regenerate.
 */
export function advanceWorldLoyalty(world: World, dt: number): void {
  for (const b of world.barbarians) {
    b.loyalty = Math.min(LOYALTY_MAX, b.loyalty + LOYALTY_REGEN_PER_SEC * dt)
  }
}

/**
 * Capture the barbarian village `barbId`, turning it into a player village at the same
 * map coordinates, and append a `'conquer'` report crediting the attacking village.
 *
 * GUARD: if no barbarian with `barbId` exists (already captured earlier in this same
 * sub-step, e.g. two armies both drove it to <= 0), returns `null` and mutates nothing
 * — the second event is a harmless no-op. Otherwise it: removes the camp from
 * `world.barbarians`; mints a fresh player village via {@link createVillage} (default
 * starting footprint) at the camp's (x, y); registers it in `villages` and
 * `villageOrder`; logs the conquest; and returns the new village id.
 *
 * @returns the new player {@link VillageId}, or `null` if `barbId` no longer exists.
 */
export function applyConquest(
  state: GameState,
  barbId: string,
  attackerVillageId: VillageId,
): VillageId | null {
  const barb = barbarianById(state.world, barbId)
  // Guard against double-capture within a single sub-step (idempotent on a stale id).
  if (barb === undefined) return null

  // Drop the camp from the world FIRST so any later event for the same id no-ops above.
  state.world.barbarians = state.world.barbarians.filter((b) => b.id !== barbId)

  const newVillageId = nextVillageId(state)
  // Deterministic, readable label from the new id's numeric suffix (names need not be unique).
  const n = Number.parseInt(newVillageId.slice(1), 10)
  const name = 'Zdobyta wioska ' + (Number.isFinite(n) ? n : newVillageId)

  const village = createVillage(newVillageId, name, barb.x, barb.y)
  state.villages[newVillageId] = village
  state.villageOrder.push(newVillageId)

  const report: BattleReport = {
    kind: 'conquer',
    villageId: attackerVillageId,
    targetName: barb.name,
    newVillageId,
  }
  state.battleLog.push(report)

  // Reconcile derived fields ACROSS the empire so the captured village inherits
  // the current global tech multipliers (createVillage rolls it up with
  // NO_TECH_MODS only).
  recomputeDerived(state)

  return newVillageId
}
