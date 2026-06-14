import { Decimal, D } from './decimal'
import { RNG } from './rng'
import { SAVE_VERSION } from './save'
import { signal, type Signal } from './store'
import { BUILDINGS, BUILDING_IDS, type BuildingId } from '../content/buildings'
import { UNIT_IDS, type UnitId } from '../content/units'

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

/**
 * One queued training order. `count` units of `unitId` remain; `remaining` is the
 * seconds left until the NEXT unit pops; `perUnitSeconds` is a SNAPSHOT of the
 * per-unit training time taken when the order was placed — so later barracks
 * upgrades never retroactively speed up (or, via float drift, perturb) an order in
 * flight, which keeps offline/online replay deterministic. Plain numbers (counts /
 * seconds), not Decimal: unit counts are bounded by popCap, and the "economy on
 * Decimal" rule covers resource amounts/production, not training timers.
 */
export interface RecruitOrder {
  unitId: UnitId
  count: number
  remaining: number
  perUnitSeconds: number
}

/**
 * One army in transit to / from a barbarian camp (M1.3). Defined inline here (not
 * in marches.ts) so the state shape — the single serialized source of truth — has
 * no runtime dependency on a system module: marches.ts imports this TYPE back, and
 * state.ts imports nothing from marches.ts, so there is no initialisation cycle.
 *
 * CONVENTION (documented once, used everywhere): `state.units` holds ALL living
 * owned units — both at home AND currently away on a march. A march's `units` is
 * the dispatched subset (still counted in `state.units`, so population/upkeep stays
 * honest and a march can never let you over-recruit). "Units at home" is therefore
 * a DERIVED quantity: `stationedUnits = state.units − Σ march.units` (see
 * marches.ts). Casualties are subtracted from `state.units` at the moment they
 * occur (battle resolution / a lost raid), never on dispatch. `units` counts are
 * plain integers (like the roster); `loot` is on Decimal (the economy rule).
 */
export interface March {
  /** Barbarian camp tier this army is attacking. */
  targetLevel: number
  /** The dispatched army, by unit id (a subset of the owned roster). */
  units: Record<UnitId, number>
  /** `outbound` = travelling to the camp; `returning` = hauling loot home. */
  phase: 'outbound' | 'returning'
  /** Seconds left until the current phase completes (advanced on the tick grid). */
  remaining: number
  /** Loot picked up at the camp, delivered on a successful return. On Decimal. */
  loot: ResourceMap
}

/**
 * One entry in the rolling battle log (last ~20 events). Plain JSON only — loot is
 * pre-summed to a decimal STRING, never a live Decimal — so the log serializes and
 * round-trips without any Decimal tagging. `won` is always from the PLAYER's point
 * of view; `losses` is the total number of own units lost in the event.
 */
export type BattleReport =
  | { kind: 'attack'; targetLevel: number; won: boolean; lootSum: string; losses: number }
  | { kind: 'raid'; won: boolean; looted: string; losses: number }

/**
 * Base seconds between incoming barbarian raids. Owned here (not in raids.ts) so
 * createInitialState and the save migration can seed `raidTimer` without importing
 * a system module (which would form a cycle); raids.ts imports this constant the
 * other way for re-arming. Generous (15 min) so a fresh village has breathing room
 * and the recruitment unit tests — which simulate well under this span — never see
 * a raid perturb their unit counts. Balance knob (the raid "interwał"): tuned up
 * from 600s so raids read as a periodic threat rather than a relentless tax that
 * leaves the standing army no room to accumulate — see CHANGELOG "Balance".
 */
export const RAID_BASE_INTERVAL = 900

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

  /**
   * Trained, idle units by id. Plain integer counts (bounded by popCap), not
   * Decimal — see {@link RecruitOrder}. The authoritative roster: a unit becomes a
   * count here only once its training order completes.
   */
  units: Record<UnitId, number>
  /**
   * FIFO training queue. The head order trains first; {@link RecruitOrder.count}
   * and `remaining` are advanced by the recruitment system every tick (online and
   * offline alike), so an order popping mid-tick is byte-identical across replays.
   */
  recruitQueue: RecruitOrder[]

  /**
   * Armies currently in transit (outbound to a camp or returning with loot).
   * Advanced on the SAME fixed tick grid as recruitment (see tick.ts) so combat
   * timing is identical online / offline / in the sim. See {@link March} for the
   * "state.units = all owned" convention.
   */
  marches: March[]
  /** Rolling log of the last ~20 battles (attacks + raids), newest last. */
  battleLog: BattleReport[]
  /**
   * Seconds until the next incoming raid. Counts down only while the village is
   * "worth raiding" (it has grown past its starting footprint — see raids.ts), so
   * a brand-new hamlet is left alone. Re-armed to {@link RAID_BASE_INTERVAL} after
   * each raid resolves.
   */
  raidTimer: number
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
      case 'recruit_speed':
        break // consumed by recruitSpeedMult (recruitment), not a tick-derived stat
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

/**
 * Unit roster a fresh run starts with: every unit at 0. DERIVED from UNIT_IDS so
 * adding a unit is a single edit to src/content/units.ts (no engine change here),
 * and the save migration reuses this map to seed the field on old saves.
 */
export const INITIAL_UNITS = Object.fromEntries(
  UNIT_IDS.map((id) => [id, 0]),
) as Record<UnitId, number>

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
    units: { ...INITIAL_UNITS },
    recruitQueue: [],
    marches: [],
    battleLog: [],
    raidTimer: RAID_BASE_INTERVAL,
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
