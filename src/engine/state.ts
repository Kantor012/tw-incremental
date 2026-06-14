import { Decimal, D } from './decimal'
import { RNG } from './rng'
import { SAVE_VERSION } from './save'
import { signal, type Signal } from './store'

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
   * Base production per second. On Decimal (not number) so it can compound with
   * building/tree/prestige multipliers far past 2^53 without losing precision
   * (M0: flat; M1: derived from buildings).
   */
  production: Record<ResourceId, Decimal>
  /** Shared storage cap (M0: single number; M1: per-resource warehouse). */
  storageCap: Decimal
}

export function createInitialState(seed: string, now: number): GameState {
  return {
    version: SAVE_VERSION,
    seed,
    rngState: RNG.fromString(seed).getState(),
    createdAt: now,
    lastSeen: now,
    resources: { wood: D(50), clay: D(50), iron: D(50) },
    production: { wood: D(1), clay: D(0.8), iron: D(0.5) },
    // Cap sits well above what the harness budget (20000 ticks) can accrue, so
    // passive M0 progress never stalls at the cap (a softlock). M1 turns this
    // into per-resource warehouses with spend sinks.
    storageCap: D(100000),
  }
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
