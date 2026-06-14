import { Decimal, D } from './decimal'
import { RNG } from './rng'
import { SAVE_VERSION } from './save'
import { signal, type Signal } from './store'
import { BUILDINGS, BUILDING_IDS, type BuildingId } from '../content/buildings'

/**
 * The single source of truth. Everything the simulation needs lives here so it
 * can be serialized, migrated and replayed deterministically.
 *
 * M0 is a minimal-but-live vertical slice: three resources accrue over time so
 * the deployed page is visibly a running game. M1 expands this into the full
 * economy, buildings and units — all added as data, not new state shapes.
 */

export type ResourceId = 'wood' | 'clay' | 'iron'
export const RESOURCE_IDS: readonly ResourceId[] = ['wood', 'clay', 'iron']

export type ResourceMap = Record<ResourceId, Decimal>

export interface GameState {
  /** Save schema version — drives migrations. */
  version: number
  /** World/run seed (string); RNG is derived from it. */
  seed: string
  /** Serialized RNG state for deterministic continuation across save/load. */
  rngState: number
  /** Epoch ms when this run was created. */
  createdAt: number
  /** Epoch ms of the last simulated moment — basis for offline progress. */
  lastSeen: number

  resources: ResourceMap
  /**
   * Owned level per building (0..maxLevel). The authoritative economy input: all
   * the fields below are DERIVED from these levels by {@link recomputeDerived}.
   */
  buildings: Record<BuildingId, number>
  /**
   * Production per second, DERIVED from buildings and cached here so the hot tick
   * (simulate) reads a plain field instead of recomputing every step. On Decimal
   * (not number) so it can compound with tree/prestige multipliers far past 2^53.
   * Recompute after any change to `buildings`.
   */
  production: Record<ResourceId, Decimal>
  /** Shared storage cap, DERIVED from buildings (warehouse). Cached. */
  storageCap: Decimal
  /** Population cap, DERIVED from buildings (farm). Cached; unit upkeep budget. */
  popCap: Decimal
}

/** Base storage cap before any warehouse levels. Storage scales with warehouse. */
const BASE_STORAGE_CAP = D(1000)
/** Base population cap before any farm levels. */
const BASE_POP_CAP = D(10)

/**
 * Recompute every derived field (production / storageCap / popCap) from the
 * current building levels, mutating `state` in place. Pure w.r.t. I/O and the
 * single place that knows how building effects roll up — call it after ANY change
 * to `state.buildings`, and once at state creation / save import so the cached
 * fields are always consistent with the levels.
 *
 * `cost_reduction` effects are intentionally NOT applied here: they affect build
 * costs and are consumed by buildingCost (src/systems/buildings.ts), not the
 * tick. The switch is exhaustive over BuildingEffect['kind'].
 */
export function recomputeDerived(state: GameState): void {
  const production: Record<ResourceId, Decimal> = { wood: D(0), clay: D(0), iron: D(0) }
  let storageCap = BASE_STORAGE_CAP
  let popCap = BASE_POP_CAP

  for (const id of BUILDING_IDS) {
    const level = state.buildings[id]
    if (!(level > 0)) continue
    const effect = BUILDINGS[id].effect
    switch (effect.kind) {
      case 'production':
        production[effect.resource] = production[effect.resource].add(
          D(effect.perLevel).mul(level),
        )
        break
      case 'storage':
        storageCap = storageCap.add(D(effect.perLevel).mul(level))
        break
      case 'population':
        popCap = popCap.add(D(effect.perLevel).mul(level))
        break
      case 'cost_reduction':
        break // consumed by buildingCost, not a tick-derived stat
    }
  }

  state.production = production
  state.storageCap = storageCap
  state.popCap = popCap
}

/**
 * Building levels a fresh run starts with (also reused by save migration v1->v2).
 * DERIVED from each building's `initialLevel` data field so adding a building is a
 * single edit to src/content/buildings.ts — no engine change here, and migrate()
 * picks the new key up automatically because it spreads this map.
 */
export const INITIAL_BUILDINGS = Object.fromEntries(
  BUILDING_IDS.map((id) => [id, BUILDINGS[id].initialLevel ?? 0]),
) as Record<BuildingId, number>

export function createInitialState(seed: string, now: number): GameState {
  const state: GameState = {
    version: SAVE_VERSION,
    seed,
    rngState: RNG.fromString(seed).getState(),
    createdAt: now,
    lastSeen: now,
    resources: { wood: D(50), clay: D(50), iron: D(50) },
    buildings: { ...INITIAL_BUILDINGS },
    // Derived fields are filled by recomputeDerived below; seeded to zero so the
    // object has its final shape (and key order) before the recompute overwrites.
    production: { wood: D(0), clay: D(0), iron: D(0) },
    storageCap: D(0),
    popCap: D(0),
  }
  // Make production / storageCap / popCap consistent with the starting buildings.
  // With the initial level-1 economy this reproduces M0's base rates exactly.
  recomputeDerived(state)
  return state
}

/**
 * Wraps GameState with a coarse reactivity signal. The loop mutates state during
 * a tick and calls `commit()` once per frame; UI effects subscribe via `rev`.
 * Fine-grained signals are reserved for hot, independently-updating UI later.
 */
export class GameStore {
  readonly state: GameState
  readonly rev: Signal<number> = signal(0)

  constructor(state: GameState) {
    this.state = state
  }

  /** Notify subscribers that state changed (called after each tick batch). */
  commit(): void {
    this.rev.value = this.rev.value + 1
  }
}
