import type { GameState } from '../engine/state'
import type { UnitId } from '../content/units'
import { catalogMaxUpgrade, isUpgradeable, upgradeCost } from '../content/forge'

/**
 * Forge system (M15 KUŹNIA) — the engine side of PERMANENT, account-wide unit upgrades.
 *
 * The Kuźnia building (content/buildings.forge, autoBuildable:false) is the GATE: once
 * any village has one, upgrades unlock, and the HIGHEST Kuźnia level across the empire is
 * the DEPTH CAP on how far each type's track can be pushed. Upgrade levels live in
 * {@link GameState.forge} (a sparse `{ unitId: level }` map); their combat effect is
 * derived on demand at resolution by content/forge.unitUpgradeMult (threaded into
 * armyAttackPower / armyDefensePower), never stored.
 *
 * {@link upgradeUnit} is a PLAYER ACTION (like market exchange / claimEvent): it is called
 * from the UI callback, NOT from the tick, draws no rng and reads no clock. With no Kuźnia
 * every gate below is false (the map stays empty), so a no-Kuźnia run is BYTE-IDENTICAL to
 * pre-M15.
 *
 * Import discipline: depends only on the GameState type and the forge data leaf
 * (content/forge → content/units), so it can never take part in an initialisation cycle.
 */

/** Whether ANY village has a Kuźnia at level >= 1 — the unlock gate for all upgrades. */
export function forgeBuilt(state: GameState): boolean {
  for (const id of state.villageOrder) {
    if ((state.villages[id]?.buildings.forge ?? 0) >= 1) return true
  }
  return false
}

/**
 * The MAX Kuźnia level across all villages — the live DEPTH CAP on unit upgrades. 0 when no
 * Kuźnia stands. The deepest Kuźnia in the empire dictates how far every type can be pushed
 * (one account-wide upgrade track, gated by your best smithy).
 */
export function forgeLevel(state: GameState): number {
  let max = 0
  for (const id of state.villageOrder) {
    const lvl = state.villages[id]?.buildings.forge ?? 0
    if (lvl > max) max = lvl
  }
  return max
}

/** Current upgrade level of `unitId` (account-wide), 0 when never upgraded. */
export function unitUpgradeLevel(state: GameState, unitId: UnitId): number {
  return state.forge[unitId] ?? 0
}

/**
 * The reachable upgrade ceiling for `unitId` RIGHT NOW: `min(catalogue cap, Kuźnia level)`.
 * The catalogue cap (content/forge.catalogMaxUpgrade) bounds the track's depth; the live
 * Kuźnia level gates how much of it you have unlocked. A non-upgradeable unit has catalogue
 * cap 0, so its effective max is always 0.
 */
export function effectiveMaxUpgrade(state: GameState, unitId: UnitId): number {
  return Math.min(catalogMaxUpgrade(unitId), forgeLevel(state))
}

/**
 * Whether `unitId` can be upgraded one more level right now. Gates (in order): a Kuźnia is
 * built, the unit is upgradeable, its current level is below the effective max, and the
 * CAPITAL (villageOrder[0]) can afford the next-level cost. Pure read — the UI uses it for
 * the disabled cue; {@link upgradeUnit} is the commit, not the validation.
 */
export function canUpgrade(state: GameState, unitId: UnitId): boolean {
  if (!forgeBuilt(state)) return false
  if (!isUpgradeable(unitId)) return false
  const level = unitUpgradeLevel(state, unitId)
  if (level >= effectiveMaxUpgrade(state, unitId)) return false
  const capital = state.villages[state.villageOrder[0]]
  if (capital === undefined) return false
  const cost = upgradeCost(unitId, level)
  if (capital.resources.wood.lt(cost.wood)) return false
  if (capital.resources.clay.lt(cost.clay)) return false
  if (capital.resources.iron.lt(cost.iron)) return false
  return true
}

/**
 * PLAYER ACTION (M15): buy ONE upgrade level for `unitId`, paid from the CAPITAL. No-op
 * returning false when {@link canUpgrade} rejects (no Kuźnia / not upgradeable / at cap /
 * unaffordable); otherwise DEBITS the next-level cost from the capital's resources (Decimal,
 * never driving a pool negative — canUpgrade guaranteed coverage), bumps the account-wide
 * level in {@link GameState.forge}, increments the lifetime `stats.unitsUpgraded` counter,
 * and returns true. Deterministic — draws no rng, reads no clock (called from the UI, not
 * the tick). No derived stat changes (the upgrade multiplier is read on demand at combat
 * resolution), so no recompute is needed.
 */
export function upgradeUnit(state: GameState, unitId: UnitId): boolean {
  if (!canUpgrade(state, unitId)) return false
  const capital = state.villages[state.villageOrder[0]]
  if (capital === undefined) return false
  const level = unitUpgradeLevel(state, unitId)
  const cost = upgradeCost(unitId, level)
  capital.resources.wood = capital.resources.wood.sub(cost.wood)
  capital.resources.clay = capital.resources.clay.sub(cost.clay)
  capital.resources.iron = capital.resources.iron.sub(cost.iron)
  state.forge[unitId] = level + 1
  state.stats.unitsUpgraded += 1
  return true
}
