import { Decimal, D } from './decimal'
import { RNG } from './rng'
import { SAVE_VERSION } from './save'
import { signal, type Signal } from './store'
import { BUILDINGS, BUILDING_IDS, type BuildingId } from '../content/buildings'
import { UNIT_IDS, type UnitId } from '../content/units'
import { generateWorld, WORLD_CENTER } from '../systems/world'
// VALUE import that closes a 2-way edge with systems/tech.ts (which imports
// recomputeDerived + the types below back from here). It is SAFE from an
// initialisation cycle because `aggregateTechMods` is referenced ONLY inside the
// body of `recomputeDerived` (never at module top level), so by the time it is
// actually called both modules are fully evaluated regardless of load order.
import { aggregateTechMods } from '../systems/tech'

/**
 * The single source of truth. Everything the simulation needs lives here so it
 * can be serialized, migrated and replayed deterministically.
 *
 * Since M2.1 the run is multi-village: each {@link Village} owns its own economy
 * (the nine per-village fields below), and {@link GameState} holds the map of
 * villages plus a stable {@link GameState.villageOrder} that fixes iteration and
 * display order. New villages are added as data via {@link createVillage} — no new
 * state shapes. The battle log stays GLOBAL (one rolling feed across all
 * villages); every report carries the {@link BattleReport.villageId} it came from.
 */

export type ResourceId = 'wood' | 'clay' | 'iron'
export const RESOURCE_IDS: readonly ResourceId[] = ['wood', 'clay', 'iron']

export type ResourceMap = Record<ResourceId, Decimal>

/** Stable per-village identifier (`'v0'`, `'v1'`, …). See {@link nextVillageId}. */
export type VillageId = string

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
 * CONVENTION (documented once, used everywhere): `village.units` holds ALL living
 * owned units of that village — both at home AND currently away on a march. A
 * march's `units` is the dispatched subset (still counted in `village.units`, so
 * population/upkeep stays honest and a march can never let you over-recruit).
 * "Units at home" is therefore a DERIVED quantity:
 * `stationedUnits = village.units − Σ march.units` (see marches.ts). Casualties are
 * subtracted from `village.units` at the moment they occur (battle resolution / a
 * lost raid), never on dispatch. `units` counts are plain integers (like the
 * roster); `loot` is on Decimal (the economy rule).
 */
export interface March {
  /**
   * Id of the targeted {@link BarbarianVillage} (`'b0'`, `'b1'`, …). `'legacy'` for
   * marches carried over by the v5→v6 save migration, which predates map coordinates
   * (their geometry is reconstructed into targetX/targetY from the old distance).
   */
  targetId: string
  /**
   * SNAPSHOT of the target's camp tier at dispatch — the single input combat resolution
   * and loot read (via barbarianTarget), frozen so a world regenerated/edited later can
   * never retroactively change a march already in flight.
   */
  targetLevel: number
  /** SNAPSHOT of the target's map x at dispatch — drives the return-leg travel time and the drawn march line. */
  targetX: number
  /** SNAPSHOT of the target's map y at dispatch. */
  targetY: number
  /** The dispatched army, by unit id (a subset of the owned roster). */
  units: Record<UnitId, number>
  /** `outbound` = travelling to the target; `returning` = hauling loot home. */
  phase: 'outbound' | 'returning'
  /** Seconds left until the current phase completes (advanced on the tick grid). */
  remaining: number
  /** Loot picked up at the target, delivered on a successful return. On Decimal. */
  loot: ResourceMap
}

/**
 * One entry in the rolling battle log (last ~20 events). Plain JSON only — loot is
 * pre-summed to a decimal STRING, never a live Decimal — so the log serializes and
 * round-trips without any Decimal tagging. `won` is always from the PLAYER's point
 * of view; `losses` is the total number of own units lost in the event; `villageId`
 * records WHICH village the report belongs to (the log is global since M2.1).
 */
export type BattleReport =
  | {
      kind: 'attack'
      villageId: VillageId
      targetLevel: number
      won: boolean
      lootSum: string
      losses: number
      /**
       * Conquest PROGRESS recorded on a WON attack whose army still carried a
       * surviving noble (M2.4): `loyaltyHit` is how much loyalty this strike actually
       * removed from the target (clamped — it never drives loyalty below 0), and
       * `loyaltyAfter` is the target's loyalty AFTER the hit. Both ABSENT on losses, on
       * noble-free attacks, and on every report from a pre-M2.4 save — hence OPTIONAL:
       * their absence simply means "no conquest progress on this strike", so no save
       * migration is needed (the v7 schema makes them optional and the v6→v7 migration
       * leaves old, pre-noble attack reports without them). Plain finite numbers in the
       * loyalty band [0, 100], never Decimal — the log stays Decimal-free JSON.
       */
      loyaltyHit?: number
      loyaltyAfter?: number
    }
  | { kind: 'raid'; villageId: VillageId; won: boolean; looted: string; losses: number }
  | {
      /**
       * A barbarian village was CONQUERED (M2.4): a won attack carrying a surviving
       * noble drove the target's loyalty to <= 0, so it became a player village.
       */
      kind: 'conquer'
      /** The attacking village that delivered the final loyalty hit. */
      villageId: VillageId
      /** Display name of the barbarian village that was taken. */
      targetName: string
      /** Id of the brand-new player village created in its place. */
      newVillageId: VillageId
    }

/**
 * Base seconds between incoming barbarian raids. Owned here (not in raids.ts) so
 * createVillage and the save migration can seed `raidTimer` without importing a
 * system module (which would form a cycle); raids.ts imports this constant the
 * other way for re-arming. Generous (15 min) so a fresh village has breathing room
 * and the recruitment unit tests — which simulate well under this span — never see
 * a raid perturb their unit counts. Balance knob (the raid "interwał"): tuned up
 * from 600s so raids read as a periodic threat rather than a relentless tax that
 * leaves the standing army no room to accumulate — see CHANGELOG "Balance".
 */
export const RAID_BASE_INTERVAL = 900

/**
 * One village: a self-contained economy. Holds exactly the nine fields every
 * RNG-free system reads/writes (resources, production, storageCap, popCap,
 * buildings, units, recruitQueue, marches, raidTimer) plus an id and a display
 * name. Systems take a `Village` (not the whole `GameState`); the global battle
 * log is threaded in explicitly where combat needs it.
 */
export interface Village {
  /** Stable id (`'v0'`, `'v1'`, …); matches the key under {@link GameState.villages}. */
  id: VillageId
  /** Human-facing display name (the capital starts as "Stolica"). */
  name: string

  /** Integer map x coordinate (field). The capital sits at {@link WORLD_CENTER}. Not derived. */
  x: number
  /** Integer map y coordinate (field). Not derived. */
  y: number

  resources: ResourceMap
  /**
   * Production per second, DERIVED from buildings and cached here so the hot tick
   * (simulate) reads a plain field instead of recomputing every step. On Decimal
   * (not number) so it can compound with tree/prestige multipliers far past 2^53.
   * Recompute after any change to `buildings`.
   */
  production: Record<ResourceId, Decimal>
  /** Storage cap, DERIVED from buildings (warehouse). Cached. */
  storageCap: Decimal
  /** Population cap, DERIVED from buildings (farm). Cached; unit upkeep budget. */
  popCap: Decimal
  /**
   * Owned level per building (0..maxLevel). The authoritative economy input:
   * production / storageCap / popCap are DERIVED from these levels by
   * {@link recomputeVillageDerived}.
   */
  buildings: Record<BuildingId, number>
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
   * "village.units = all owned" convention.
   */
  marches: March[]
  /**
   * Seconds until the next incoming raid. Counts down only while the village is
   * "worth raiding" (it has grown past its starting footprint — see raids.ts), so
   * a brand-new hamlet is left alone. Re-armed to {@link RAID_BASE_INTERVAL} after
   * each raid resolves.
   */
  raidTimer: number
}

/**
 * One barbarian village on the world map (M2.2). A purely SPATIAL descriptor — its
 * id, map coordinates, camp tier and display name. The STATIC combat numbers
 * (defence, loot) are NOT stored: they are derived on demand from `level` via
 * {@link barbarianTarget} (the single source of those curves), so the world stays a
 * compact, Decimal-free bag of plain numbers/strings that serializes trivially. The
 * one MUTABLE field is `loyalty` (M2.4 conquest). Generated deterministically from
 * the seed by `generateWorld` (systems/world.ts).
 */
export interface BarbarianVillage {
  /** Stable id (`'b0'`, `'b1'`, …) — what a {@link March.targetId} points at. */
  id: string
  /** Integer map x coordinate (field), in [0, WORLD_SIZE]. */
  x: number
  /** Integer map y coordinate (field), in [0, WORLD_SIZE]. */
  y: number
  /** Camp tier (1..MAX_TARGET_LEVEL) — drives defence/loot via barbarianTarget(level). */
  level: number
  /** Display name (PL). */
  name: string
  /**
   * Conquest loyalty in [0, 100] (M2.4). Starts full (100 = hardest to take). A won
   * attack carrying a surviving noble subtracts from it (conquest.ts); it slowly
   * regenerates each sub-step. When it reaches <= 0 the village is conquered. MUTABLE
   * world state (unlike the derived combat numbers), so it serializes and migrates.
   */
  loyalty: number
}

/**
 * The spatial world: the deterministic, seed-generated set of barbarian villages
 * the player can march at. Ordered (stable index = id suffix) so iteration/render
 * is reproducible. Holds only plain JSON (no Decimal), so it serializes verbatim.
 */
export interface World {
  barbarians: BarbarianVillage[]
}

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

  /** Every owned village, keyed by id. Each entry's `id` equals its key. */
  villages: Record<VillageId, Village>
  /**
   * Stable iteration + display order of village ids. Always non-empty and in
   * exact correspondence with the keys of `villages`. The tick iterates this
   * order so multi-village simulation stays deterministic.
   */
  villageOrder: VillageId[]
  /**
   * The spatial world (barbarian villages on the map). Deterministically generated
   * from {@link GameState.seed} at run creation (and reconstructed by the save
   * migration), so it is reproducible and survives round-trips.
   */
  world: World
  /**
   * GLOBAL rolling log of the last ~20 battles (attacks + raids) across ALL
   * villages, newest last. Each report carries the village it came from via
   * {@link BattleReport.villageId}.
   */
  battleLog: BattleReport[]
  /**
   * GLOBAL passive tree (M3.1): purchased level per node id (absent key = level 0).
   * The single account-wide tech state — its economic effects are TRANSIENT
   * multipliers recomputed from this map by {@link aggregateTechMods} and folded
   * into every village's derived stats in {@link recomputeDerived}; no derived tech
   * field is ever stored on the state (only this raw `{ id: level }` map serializes).
   */
  tech: Record<string, number>
}

/**
 * Global, account-wide tech multipliers — the TRANSIENT roll-up of the passive
 * tree's effects, recomputed from {@link GameState.tech} by `aggregateTechMods`
 * (systems/tech.ts) and threaded into the systems that consume them. Never stored on
 * the state — derived on demand and discarded after each use.
 *
 * The ECONOMY fields (M3.1) are plain `number` factors where `1` means "no bonus" and
 * are folded by {@link recomputeVillageDerived}: `productionMult[r]` scales resource
 * `r`'s production, `storageMult` the storage cap, `popMult` the population cap.
 *
 * The M3.2 fields are threaded into the combat/logistics/cost systems (NOT into
 * recomputeVillageDerived). Two shapes:
 *  - FRACTIONS in [0, cap] subtracted from a time/cost (0 = no bonus):
 *    `costReduction` (off build cost, cap 0.8), `recruitSpeedFrac` (off recruit time,
 *    cap 0.75), `marchSpeedFrac` (off march time, cap 0.75).
 *  - MULTIPLIERS >= 1 (1 = no bonus): `attackMult`, `defenseMult`, `lootMult`.
 */
export interface TechModifiers {
  productionMult: Record<ResourceId, number>
  storageMult: number
  popMult: number
  /** Fraction off building cost, clamped 0..0.8 (consumed by systems/buildings.ts). */
  costReduction: number
  /** Fraction off recruitment time, clamped 0..0.75 (consumed by systems/recruitment.ts). */
  recruitSpeedFrac: number
  /** Fraction off march time, clamped 0..0.75 (consumed by systems/marches.ts). */
  marchSpeedFrac: number
  /** Army attack power multiplier, >= 1 (consumed by systems/combat.ts). */
  attackMult: number
  /** Army defence power multiplier, >= 1 (consumed by systems/combat.ts). */
  defenseMult: number
  /** Loot haul multiplier, >= 1 (consumed by systems/marches.ts). */
  lootMult: number
}

/** Identity tech multipliers (no bonus): economy/combat factors 1, fractional
 * reductions 0. The default for any consumer that runs before/without tech
 * (createVillage, plain build, the sim). */
export const NO_TECH_MODS: TechModifiers = {
  productionMult: { wood: 1, clay: 1, iron: 1 },
  storageMult: 1,
  popMult: 1,
  costReduction: 0,
  recruitSpeedFrac: 0,
  marchSpeedFrac: 0,
  attackMult: 1,
  defenseMult: 1,
  lootMult: 1,
}

/** Base storage cap before any warehouse levels. Storage scales with warehouse. */
const BASE_STORAGE_CAP = D(1000)
/** Base population cap before any farm levels. */
const BASE_POP_CAP = D(10)

/**
 * Recompute one village's derived fields (production / storageCap / popCap) from
 * its current building levels, mutating `v` in place. The single place that knows
 * how building effects roll up — call it after ANY change to `v.buildings`, and
 * once at village creation / save import so the cached fields are always
 * consistent with the levels.
 *
 * `cost_reduction` effects are intentionally NOT applied here: they affect build
 * costs and are consumed by buildingCost (src/systems/buildings.ts), not the
 * tick. The switch is exhaustive over BuildingEffect['kind'].
 *
 * `mods` are the GLOBAL tech multipliers (M3.1), applied AFTER the per-building
 * roll-up: production[r] *= mods.productionMult[r], storageCap *= mods.storageMult,
 * popCap *= mods.popMult. They default to {@link NO_TECH_MODS} (all 1), so a village
 * with no tech — or a caller that does not thread tech (createVillage, the sim) —
 * reproduces the pure building economy byte-for-byte. `recomputeDerived` computes the
 * real `mods` once and passes them to every village.
 */
export function recomputeVillageDerived(v: Village, mods: TechModifiers = NO_TECH_MODS): void {
  const production: Record<ResourceId, Decimal> = { wood: D(0), clay: D(0), iron: D(0) }
  let storageCap = BASE_STORAGE_CAP
  let popCap = BASE_POP_CAP

  for (const id of BUILDING_IDS) {
    const level = v.buildings[id]
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
      case 'noble_unlock':
        break // binary gate consumed by recruitment (unitUnlocked), not a tick-derived stat
    }
  }

  // Fold in the GLOBAL tech multipliers (M3.1). On Decimal (.mul) so the bonuses
  // compound with the economy past 2^53; with NO_TECH_MODS every factor is 1, a no-op.
  for (const r of RESOURCE_IDS) {
    production[r] = production[r].mul(mods.productionMult[r])
  }
  storageCap = storageCap.mul(mods.storageMult)
  popCap = popCap.mul(mods.popMult)

  v.production = production
  v.storageCap = storageCap
  v.popCap = popCap
}

/**
 * Recompute the derived fields of EVERY village, in {@link GameState.villageOrder}.
 * Name kept (save.ts imports it) — call it after a bulk change or at save import so
 * all cached fields are consistent with the building levels they derive from.
 */
export function recomputeDerived(state: GameState): void {
  // Compute the GLOBAL tech multipliers once and apply them to every village. This is
  // the ONLY call site of aggregateTechMods inside state.ts and it lives in the
  // function body (not module top level), which is what keeps the systems/tech.ts
  // value import free of an initialisation cycle (see the import note above).
  const mods = aggregateTechMods(state.tech)
  for (const id of state.villageOrder) recomputeVillageDerived(state.villages[id], mods)
}

/**
 * Building levels a fresh village starts with (also reused by save migration).
 * DERIVED from each building's `initialLevel` data field so adding a building is a
 * single edit to src/content/buildings.ts — no engine change here, and migrate()
 * picks the new key up automatically because it spreads this map.
 */
export const INITIAL_BUILDINGS = Object.fromEntries(
  BUILDING_IDS.map((id) => [id, BUILDINGS[id].initialLevel ?? 0]),
) as Record<BuildingId, number>

/**
 * Unit roster a fresh village starts with: every unit at 0. DERIVED from UNIT_IDS
 * so adding a unit is a single edit to src/content/units.ts (no engine change
 * here), and the save migration reuses this map to seed the field on old saves.
 */
export const INITIAL_UNITS = Object.fromEntries(
  UNIT_IDS.map((id) => [id, 0]),
) as Record<UnitId, number>

/**
 * Build a fresh, empty village with the starting building/unit footprint, the
 * starter resource pool and an armed raid clock. Derived fields are reconciled
 * with the starting buildings before returning (so production / storageCap /
 * popCap are immediately consistent).
 */
export function createVillage(id: VillageId, name: string, x = 0, y = 0): Village {
  const v: Village = {
    id,
    name,
    x,
    y,
    resources: { wood: D(50), clay: D(50), iron: D(50) },
    // Derived fields are filled by recomputeVillageDerived below; seeded to zero so
    // the object has its final shape (and key order) before the recompute overwrites.
    production: { wood: D(0), clay: D(0), iron: D(0) },
    storageCap: D(0),
    popCap: D(0),
    buildings: { ...INITIAL_BUILDINGS },
    units: { ...INITIAL_UNITS },
    recruitQueue: [],
    marches: [],
    raidTimer: RAID_BASE_INTERVAL,
  }
  // Make production / storageCap / popCap consistent with the starting buildings.
  // With the initial level-1 economy this reproduces M0's base rates exactly.
  recomputeVillageDerived(v)
  return v
}

export function createInitialState(seed: string, now: number): GameState {
  // Capital starts at the world centre; the barbarian world is generated from the
  // same seed on its OWN RNG stream (see generateWorld), so it never perturbs the
  // run's rngState — both stay reproducible.
  const capital = createVillage('v0', 'Stolica', WORLD_CENTER.x, WORLD_CENTER.y)
  return {
    version: SAVE_VERSION,
    seed,
    rngState: RNG.fromString(seed).getState(),
    createdAt: now,
    lastSeen: now,
    villages: { v0: capital },
    villageOrder: ['v0'],
    world: generateWorld(seed),
    battleLog: [],
    tech: {},
  }
}

/**
 * First unused village id of the form `'v'+N` (lowest N with no entry in
 * `villages`). Used when founding/capturing a village (M2.3) so ids stay stable
 * and never collide with an existing one.
 */
export function nextVillageId(state: GameState): VillageId {
  let n = 0
  while (state.villages['v' + n] !== undefined) n++
  return 'v' + n
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
