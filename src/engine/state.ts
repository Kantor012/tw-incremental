import { Decimal, D } from './decimal'
import { RNG } from './rng'
import { SAVE_VERSION } from './save'
import { signal, type Signal } from './store'
import { BUILDINGS, BUILDING_IDS, type BuildingId } from '../content/buildings'
import { UNIT_IDS, type UnitId } from '../content/units'
import { generateWorld, WORLD_CENTER } from '../systems/world'
// VALUE import that closes a 2-way edge with systems/prestige.ts (which imports
// recomputeDerived + the types below back from here). It is SAFE from an
// initialisation cycle because `effectiveMods` is referenced ONLY inside the body of
// `recomputeDerived` (never at module top level), so by the time it is actually
// called both modules are fully evaluated regardless of load order. `effectiveMods`
// itself folds the tech bag (systems/tech) with the prestige bag, so this single
// import is the one place derived stats pick up BOTH trees (M4.1).
import { effectiveMods } from '../systems/prestige'

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
 * What a {@link March} is FOR (M5.2). Two deterministic kinds share the same mover
 * (advanceMarches) and travel maths but resolve differently on arrival:
 *  - `attack` — the classic PvE strike: resolves a battle, takes casualties and loot,
 *    and (with a surviving noble) erodes loyalty / conquers.
 *  - `scout`  — pure RECON: on arrival it flips the target's {@link BarbarianVillage.scouted}
 *    flag true (revealing its defence/loot in the UI), never fights, never loots, and
 *    every scout returns home unharmed.
 * Marches carried over by the v10→v11 save migration default to `'attack'` (the only
 * kind that existed before M5.2).
 */
export type MarchKind = 'attack' | 'scout'

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
   * What this march is for (M5.2): an `attack` (battle + loot + conquest) or a `scout`
   * (pure recon — reveals the target, never fights/loots, always returns). The v10→v11
   * save migration backfills `'attack'` on every pre-M5.2 march. See {@link MarchKind}.
   */
  kind: MarchKind
  /**
   * What KIND of target {@link targetId} points at (M7): `'camp'` = an entry in
   * {@link World.barbarians} (the classic grindable camp — resolves via barbarianTarget,
   * supports loot/conquest/scouting/siege razing), `'fortress'` = an entry in
   * {@link World.fortresses} (a one-time boss — resolves via fortressTarget, delivers a
   * big loot cache and razes the fortress on a win; never conquered, never scouted).
   * Snapshotted at dispatch so the resolution path is fixed for an army already in
   * flight. The v16->v17 save migration backfills `'camp'` on every pre-M7 march (all
   * existing marches are camp attacks/scouts). Scout marches are always `'camp'`.
   */
  targetType: 'camp' | 'fortress'
  /**
   * Id of the targeted {@link BarbarianVillage} (`'b0'`, `'b1'`, …) when
   * {@link targetType} is `'camp'`, or the targeted {@link Fortress} (`'f0'`, `'f1'`, …)
   * when it is `'fortress'`. `'legacy'` for marches carried over by the v5→v6 save
   * migration, which predates map coordinates (their geometry is reconstructed into
   * targetX/targetY from the old distance).
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
 * One MERCHANT transport in transit between two OWNED villages (M9 rynek). Defined
 * inline here (not in market.ts) so the state shape — the single serialized source of
 * truth — has no runtime dependency on a system module: market.ts imports this TYPE
 * back, and state.ts imports nothing from market.ts, so there is no initialisation
 * cycle (mirrors the {@link March} discipline exactly).
 *
 * CONVENTION (documented once, used everywhere): a shipment is dispatched FROM a
 * village (it lives on {@link Village.shipments}) and its `cargo` is DEDUCTED from that
 * village's resources at dispatch — the resources leave the source immediately and are
 * held IN TRANSIT, occupying the source's merchant capacity until delivered. Transport
 * CONSERVES resources: nothing is created; on arrival the cargo is added to the
 * destination, clamped to its storage cap (overflow spilled, mirroring deliverLoot).
 * `cargo` is on Decimal (the economy rule); `remaining` is a plain number of seconds
 * (like {@link March.remaining}), advanced on the SAME fixed tick grid so online /
 * offline / sim stay byte-identical.
 */
export interface Shipment {
  /** Source village id (the dispatcher; this shipment lives on its {@link Village.shipments}). */
  fromVillageId: VillageId
  /** Destination village id (a DIFFERENT existing own village; cargo is delivered here on arrival). */
  toVillageId: VillageId
  /** Resources IN TRANSIT, already debited from the source at dispatch. On Decimal. */
  cargo: ResourceMap
  /** Seconds left until arrival (advanced on the tick grid; delivered when it reaches 0). */
  remaining: number
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
       * The luck roll that decided THIS engagement (M5.5): a finite multiplier in
       * [1-COMBAT_LUCK, 1+COMBAT_LUCK] (mean 1.0) applied to the attacker's power
       * before resolution — e.g. `1.12` = +12% lucky, `0.83` = pech. OPTIONAL so
       * pre-M5.5 reports (which never recorded it) stay valid with no save
       * transform; absence simply means "luck unknown for this old report". A plain
       * finite number, never Decimal — the log stays Decimal-free JSON.
       */
      luck?: number
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
  | {
      kind: 'raid'
      villageId: VillageId
      won: boolean
      looted: string
      losses: number
      /**
       * The luck roll that decided this raid (M5.5): a finite multiplier in
       * [1-COMBAT_LUCK, 1+COMBAT_LUCK] (mean 1.0) applied to the RAIDER's power
       * before resolution. OPTIONAL — pre-M5.5 raid reports stay valid without it.
       */
      luck?: number
    }
  | {
      /**
       * A HORDE resolution against the capital (M7.2) — the telegraphed, escalating,
       * high-stakes invasion. Shares the raid combat fields exactly (`won` from the
       * PLAYER's POV, `looted` the pre-summed string stolen on a breach — `'0'` on a
       * repel — `losses` the garrison units lost, and the OPTIONAL `luck` roll applied
       * to the HORDE's incoming power), so the log/save path treats it like a raid; only
       * the discriminant differs. The horde's escalation level lives on {@link HordeState},
       * not the report, so the report stays the same shape as a raid.
       */
      kind: 'horde'
      villageId: VillageId
      won: boolean
      looted: string
      losses: number
      /**
       * The luck roll that decided this horde (M7.2): a finite multiplier in
       * [1-COMBAT_LUCK, 1+COMBAT_LUCK] (mean 1.0) applied to the HORDE's incoming power
       * before resolution. OPTIONAL — a luck-free resolution (tests) omits it.
       */
      luck?: number
    }
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
 * Base seconds between incoming HORDES (M7.2) — the telegraphed, escalating capital
 * invasion. Owned here (not in hordes.ts), exactly like {@link RAID_BASE_INTERVAL}, so
 * createInitialState, the save migration and the content/UI can seed/re-arm the horde
 * clock without importing a system module (which would form a cycle); systems/hordes.ts
 * imports this constant the other way for re-arming. Deliberately MUCH longer than the
 * raid interval (16×): a horde is a rare, big, high-stakes event rather than the silent
 * raid drip, and starting the clock a full interval out (createInitialState seeds
 * `timer: HORDE_INTERVAL`) keeps the early game — and every short-span test — untouched
 * by hordes. Balance knob: tuned together with hordePower so a normally-progressing
 * capital REPELS the escalating hordes it faces over a run (see content/hordes.ts).
 */
export const HORDE_INTERVAL = 14400

/**
 * World-events schedule timing (M13). {@link EVENT_INTERVAL} is the seconds between OFFERS;
 * {@link EVENT_TTL} is how long an unclaimed offer stays on the table before it lapses. Owned
 * here (not in systems/events.ts) — exactly like {@link RAID_BASE_INTERVAL} / {@link HORDE_INTERVAL}
 * — so createInitialState and the save migration can seed/re-arm the event clock without importing
 * a system module (which would form a cycle); systems/events.ts imports them the other way. v1 keeps
 * a FIXED interval (no per-level frequency scaling), so the watchtower's description must not promise
 * faster events.
 */
export const EVENT_INTERVAL = 1200
export const EVENT_TTL = 300

/**
 * The single GLOBAL horde schedule (M7.2) — one telegraphed, escalating invasion of the
 * CAPITAL ({@link GameState.villageOrder}[0]), the active-defence counterpart to the
 * silent per-village raid drip. Unlike raids (a per-village timer), there is ONE horde
 * clock for the whole run, on {@link GameState.horde}.
 */
export interface HordeState {
  /** Seconds until the next horde lands. Counts down on the tick; re-armed to {@link HORDE_INTERVAL} after each. */
  timer: number
  /** Escalation counter: rises by 1 after EVERY horde (repelled or breached); hordePower grows with it. Starts 0. */
  level: number
}

/**
 * One ACTIVE world-event offer (M13) — the time-limited windfall currently on the table,
 * waiting for the player to CLAIM it before {@link ttl} runs out. `defId` indexes the
 * WORLD_EVENTS catalogue (content/events.ts); `roll` is the deterministic [0,1) scalar drawn
 * from the events RNG stream at spawn that sizes the grant; `ttl` counts down on the tick and
 * lapses the unclaimed offer at <= 0. Plain numbers (ttl seconds, roll a unit scalar) — the
 * grant amounts are computed on claim (on Decimal), so the offer itself stays Decimal-free and
 * serializes trivially.
 */
export interface ActiveEvent {
  defId: string
  ttl: number
  roll: number
}

/**
 * One ACTIVE timed buff (M14) — the global TEMPORARY modifier currently in force after the player
 * claimed a `kind: 'buff'` world event. `defId` indexes the WORLD_EVENTS catalogue
 * (content/events.ts) to recover the buff's {@link TechModifiers} bag; `remaining` is the seconds
 * left until it expires, counted down on the SAME fixed tick grid as the offer clock. A SINGLE
 * slot ({@link EventState.buff}): claiming a new buff REPLACES any active one. Plain number
 * (seconds) — the modifier amounts live in the catalogue, so the buff state itself stays
 * Decimal-free and serializes trivially. This is the FIRST temporary modifier in the game (all
 * tree/building mods are PERMANENT); it folds into effectiveMods via aggregateEventBuffMods only
 * while it lasts, and reverts byte-identically on expiry (no recomputeDerived — v1 buffs touch
 * only the in-flight axes, see content/events.ts).
 */
export interface ActiveBuff {
  defId: string
  remaining: number
}

/**
 * The single GLOBAL world-events schedule (M13) — one offer clock for the whole run, gated by
 * the manually-built WATCHTOWER (the `watchtower` building, autoBuildable:false). Draws from its
 * OWN seeded RNG stream ({@link rngState}, seeded from `seed + '::events'`) so it NEVER touches
 * the combat-luck stream ({@link GameState.rngState}): with no watchtower {@link advanceEvents}
 * is a pure no-op (timer/rng frozen, active stays null) and the main run + combat stream stay
 * byte-identical to pre-M13. `timer` counts down to the next offer (re-armed to
 * {@link EVENT_INTERVAL}); while an offer is `active` the timer is frozen.
 */
export interface EventState {
  /** SEPARATE RNG stream state (never the combat stream) — only advanced at offer spawn. */
  rngState: number
  /** Seconds until the next offer; re-armed to {@link EVENT_INTERVAL}. Frozen while {@link active} is set. */
  timer: number
  /** The offer currently on the table, or null when idle. */
  active: ActiveEvent | null
  /**
   * The ACTIVE timed buff (M14), or null when none is in force. A SINGLE slot — claiming a buff
   * offer REPLACES any active one. Counted down by {@link advanceEvents} on the tick grid
   * INDEPENDENTLY of the offer clock, and folded into effectiveMods via aggregateEventBuffMods
   * only while set. With no watchtower it is always null (the gate), so the run stays
   * byte-identical to pre-M14. See {@link ActiveBuff}.
   */
  buff: ActiveBuff | null
}

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
   * Merchant CARRY capacity, DERIVED from the market building (M9 rynek) and cached
   * here like storageCap/popCap. On Decimal so it compounds with the economy. The
   * transport system (systems/market.ts) reads it to bound in-flight shipments
   * (capacity in use = Σ cargo of {@link shipments}); it folds into NO production /
   * storage / pop / combat stat, so a village with no market has merchantCapacity 0
   * and is byte-identical to pre-M9. Recompute after any change to `buildings`.
   */
  merchantCapacity: Decimal
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
   * Merchant transports dispatched FROM this village (M9 rynek). Each {@link Shipment}'s
   * cargo was debited from this village's resources at dispatch and is held in transit,
   * occupying this village's {@link merchantCapacity} until delivered to its destination.
   * Advanced on the SAME fixed tick grid as marches/recruitment (see tick.ts /
   * advanceShipments) so transport timing is identical online / offline / sim. Empty by
   * default, so a run that never transports is byte-identical to pre-M9.
   */
  shipments: Shipment[]
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
  /**
   * Whether the player has SCOUTED this camp (M5.2). Starts `false`: until a scout
   * march reaches the camp and returns, the UI shows its defence/loot as `?`. A
   * returning `scout` march (see {@link MarchKind}) flips it `true`, revealing the
   * real numbers. MUTABLE world state, so it serializes; `generateWorld` seeds it
   * `false` for fresh barbarians and the v10→v11 save migration backfills `false`.
   */
  scouted: boolean
}

/**
 * One FORTRESS on the world map (M7) — a FINITE, high-value boss target, sharply
 * distinct from the grindable barbarian camps. Mirrors {@link BarbarianVillage}'s
 * spatial shape (id, map coordinates, level, display name) but carries a one-shot
 * `razed` flag INSTEAD of `loyalty`/`scouted`: a fortress is never conquered (no
 * loyalty), never scouted (no fog — its defence/loot are always revealed), and can
 * be assaulted only ONCE — a victorious assault sets `razed = true` permanently for
 * the run, and a razed fortress can never be attacked again. The STATIC combat
 * numbers (a much higher defence, a much bigger loot cache) are NOT stored: they are
 * derived on demand from `level` via {@link import('../content/fortresses').fortressTarget}
 * (the single source of those curves), so the world stays a compact, Decimal-free bag
 * of plain numbers/strings. Generated deterministically from the seed by
 * `generateWorld` (systems/world.ts), on a SEPARATE rng stream from the barbarians.
 */
export interface Fortress {
  /** Stable id (`'f0'`, `'f1'`, …) — what a {@link March.targetId} points at when targetType is `'fortress'`. */
  id: string
  /** Integer map x coordinate (field), in [0, WORLD_SIZE]. */
  x: number
  /** Integer map y coordinate (field), in [0, WORLD_SIZE]. */
  y: number
  /** Fortress tier — drives defence/loot via fortressTarget(level). Placed at FAR rings (high level). */
  level: number
  /** Display name (PL). */
  name: string
  /**
   * Whether this fortress has been RAZED (M7). Starts `false`. A won assault flips it
   * `true` PERMANENTLY for the run — a razed fortress is removed from play (not
   * grindable, not conquerable, never attacked again). MUTABLE world state, so it
   * serializes and migrates; `generateWorld` seeds it `false` for fresh fortresses and
   * the v16->v17 save migration backfills the whole `fortresses` array from the seed.
   */
  razed: boolean
}

/**
 * The spatial world: the deterministic, seed-generated set of barbarian villages
 * the player can march at, plus the FINITE set of {@link Fortress} boss targets
 * (M7). Both lists are ordered (stable index = id suffix) so iteration/render is
 * reproducible. Holds only plain JSON (no Decimal), so it serializes verbatim.
 */
export interface World {
  barbarians: BarbarianVillage[]
  /**
   * The FINITE set of fortresses (M7) — high-value, one-time boss targets placed at
   * far rings beyond every camp tier, drawn from a SEPARATE rng stream so the
   * barbarian list stays byte-identical. Regenerated fresh by every world reset
   * (ascension / era / dynasty), giving each run a repeatable set to clear.
   */
  fortresses: Fortress[]
}

/**
 * The PERMANENT prestige (ascension) account state (M4.1). Survives every run reset
 * (`ascend`): you bank {@link points} by ascending and spend them in the prestige
 * tree, whose purchased levels live in {@link nodes}. The economic effect of those
 * nodes is TRANSIENT (rolled up by `aggregatePrestigeMods` and combined with the tech
 * bag by `effectiveMods`); only this raw account state serializes.
 */
export interface PrestigeState {
  /** Unspent prestige points (PP) available to buy nodes. Plain finite number >= 0. */
  points: number
  /** Lifetime PP ever earned across all ascensions (monotonic; stats/UI). >= 0. */
  totalEarned: number
  /** Number of ascensions performed so far (run resets). >= 0. */
  ascensions: number
  /**
   * Purchased level per prestige node id (absent key = level 0). The single
   * permanent prestige-tree state — its effects are recomputed from this map by
   * `aggregatePrestigeMods` and never stored derived (mirrors {@link GameState.tech}).
   */
  nodes: Record<string, number>
}

/**
 * The PERMANENT era account state (M6.1) — the SECOND meta-layer, sitting ABOVE
 * prestige. Survives every era reset (`newEra`, the great reset): you bank
 * {@link points} (EP) by starting a Nowa Era — which WIPES the whole prestige
 * account and the run — and spend them in the era tree, whose purchased levels live
 * in {@link nodes}. The economic effect of those nodes is TRANSIENT (rolled up by
 * `aggregateEraMods` and combined onto the tech × prestige bag by `effectiveMods`),
 * plus the signature `pp_mult` that multiplies prestige-point gain; only this raw
 * account state serializes. Mirrors {@link PrestigeState} exactly.
 */
export interface EraState {
  /** Unspent era points (EP) available to buy nodes. Plain finite number >= 0. */
  points: number
  /** Lifetime EP ever earned across all eras (monotonic; stats/UI). >= 0. */
  totalEarned: number
  /** Number of eras started so far (great resets). >= 0. */
  eras: number
  /**
   * Purchased level per era node id (absent key = level 0). The single permanent
   * era-tree state — its effects are recomputed from this map by `aggregateEraMods`
   * and never stored derived (mirrors {@link GameState.tech} / {@link PrestigeState.nodes}).
   */
  nodes: Record<string, number>
}

/**
 * The PERMANENT dynasty account state (M6.2) — the THIRD meta-layer, sitting ABOVE
 * era. Survives every great-great reset (`newDynasty`): you bank {@link points} (DP)
 * by founding a Nowa Dynastia — which WIPES the whole era account AND the whole
 * prestige account and resets the run — and spend them in the dynasty tree, whose
 * purchased levels live in {@link nodes}. The economic effect of those nodes is
 * TRANSIENT (rolled up by `aggregateDynastyMods` and combined onto the tech × prestige
 * × era bag by `effectiveMods`), plus the signature `ep_mult` that multiplies era-point
 * gain and the binary `automation_unlock` gate that unlocks all idle automations
 * account-wide from the start; only this raw account state serializes. Mirrors
 * {@link EraState} exactly.
 */
export interface DynastyState {
  /** Unspent dynasty points (DP) available to buy nodes. Plain finite number >= 0. */
  points: number
  /** Lifetime DP ever earned across all dynasties (monotonic; stats/UI). >= 0. */
  totalEarned: number
  /** Number of dynasties founded so far (great-great resets). >= 0. */
  dynasties: number
  /**
   * Purchased level per dynasty node id (absent key = level 0). The single permanent
   * dynasty-tree state — its effects are recomputed from this map by
   * `aggregateDynastyMods` and never stored derived (mirrors {@link EraState.nodes}).
   */
  nodes: Record<string, number>
}

/**
 * CHALLENGE (WYZWANIE) account state (M8) — the run-modifier layer that plugs into the
 * SAME `combine` fold as the three meta-trees. A challenge is a CONSTRAINED run for a
 * ONE-TIME permanent reward: starting one RESETS the run (fresh capital/world from a
 * deterministic seed, tech/log cleared — like an ascend) and turns on a CONSTRAINT
 * multiplier bag, while the meta accounts (prestige/era/dynasty) and the lifetime
 * stats/achievements are PRESERVED. Completing the goal records it permanently and grants
 * a bonus multiplier bag that folds into `effectiveMods` FOREVER.
 *
 * Only the raw account state serializes here; both the active constraint and every
 * completed reward are TRANSIENT multipliers re-derived from this record by
 * `aggregateChallengeMods` (systems/challenges.ts) and COMBINED onto the tech × prestige ×
 * era × dynasty bag by `effectiveMods`. An EMPTY record (no active challenge, none
 * completed) folds to the identity bag, so a no-challenge save is byte-identical to
 * pre-M8. Mirrors {@link PrestigeState} / {@link EraState} in spirit (a permanent account
 * the run never wipes).
 */
export interface ChallengeState {
  /** The currently running challenge id, or `null` when no challenge is active. */
  activeId: string | null
  /**
   * Times each challenge has been COMPLETED (absent key = never; monotonic, >= 1 once
   * done). The permanent reward of any id with `completed[id] >= 1` folds into
   * `effectiveMods` forever (surviving every reset). A sparse map, like the meta-tree
   * `nodes` maps.
   */
  completed: Record<string, number>
}

/**
 * The three routines the idle layer can run for the player (M5.1). Each is
 * UNLOCKED via the tech tree (a binary `automation_unlock` gateway) and then TOGGLED
 * on by the player; both must be true for the routine to fire in the deterministic
 * sub-step. See {@link AutomationSettings} (the toggles + policy) and
 * {@link TechModifiers.automations} (which routines are unlocked).
 */
export type AutomationKind = 'build' | 'recruit' | 'attack'

/**
 * The player's automation toggles + policy (M5.1), serialized on {@link GameState}.
 *
 * `build` / `recruit` / `attack` are the user ON/OFF switches (a routine only runs
 * when its switch is on AND it is unlocked in the tree — see
 * {@link TechModifiers.automations}). Default OFF, so a run with no automation is
 * byte-identical to pre-M5.1 play (the 17 balance goals are untouched).
 *
 * AUTO-BUILD and AUTO-ATTACK have FIXED, deterministic policies (cheapest affordable
 * building; nearest beatable barbarian, never nobles) and need no extra fields.
 * AUTO-RECRUIT carries its policy here: keep `recruitUnit` topped up to `recruitTarget`
 * units (counting both the standing roster and what is already in the recruit queue).
 * `recruitUnit` is `null` until the player picks one (then nothing is recruited).
 */
export interface AutomationSettings {
  /** User switch for auto-build (cheapest affordable building). */
  build: boolean
  /** User switch for auto-recruit (top up `recruitUnit` to `recruitTarget`). */
  recruit: boolean
  /** User switch for auto-attack (nearest beatable barbarian, never nobles). */
  attack: boolean
  /** Unit auto-recruit maintains; `null` = no unit chosen yet (nothing recruited). */
  recruitUnit: UnitId | null
  /** Target standing count for `recruitUnit`; finite integer >= 0. */
  recruitTarget: number
}

/**
 * Permanent, account-wide LIFETIME counters (M5.4). These accumulate over the whole
 * run's life and are NEVER reset (an ascension preserves them — `ascend` leaves
 * `stats`/`achievements` untouched), so they read as a true career record.
 *
 * They hold ONLY the quantities that cannot be re-derived from the rest of the
 * state at any later moment (a battle won, loot delivered, a camp razed are EVENTS
 * that leave no standing trace). Everything else an achievement might test —
 * current village count, summed building/tech levels, `prestige.ascensions` /
 * `totalEarned`, etc. — is computed on the fly from {@link GameState} and is NOT
 * mirrored here. They are bumped ONLY on the DETERMINISTIC tick/systems path (never
 * from the UI/eventbus), so they grow byte-identically online, offline and in the
 * sim. `lootHauled` is on Decimal (the economy rule) because the lifetime haul grows
 * far past 2^53; every other counter is a plain non-negative integer.
 */
export interface Stats {
  /** Attacks that resolved as a player WIN (bumped on battle resolution). */
  attacksWon: number
  /** Attacks that resolved as a player LOSS. */
  attacksLost: number
  /** Lifetime resources actually DELIVERED home from marches (summed on return). On Decimal. */
  lootHauled: Decimal
  /** Lifetime resources spent on market exchanges (the gross input traded away). On Decimal, like lootHauled. */
  resourcesExchanged: Decimal
  /** Incoming barbarian raids REPELLED (defence held). */
  raidsRepelled: number
  /** Incoming barbarian raids that broke through (defence lost). */
  raidsLost: number
  /** Hordes REPELLED (the capital's defence held the escalating invasion). M7.2. */
  hordesRepelled: number
  /** Hordes that BREACHED the capital (defence lost — resources + garrison taken). M7.2. */
  hordesBreached: number
  /** Barbarian camp levels knocked down by catapults (>= 1 level removed counts one). */
  campsRazed: number
  /** Fortresses RAZED across the run's life (M7; bumped once per won fortress assault). */
  fortressesRazed: number
  /** World-event offers CLAIMED across the run's life (M13; bumped once per claimEvent). */
  eventsResolved: number
  /** Scout marches that completed and returned home. */
  scoutsReturned: number
  /** New villages FOUNDED by the player. */
  villagesFounded: number
  /** Barbarian villages CONQUERED into the empire. */
  villagesConquered: number
  /** Unit-type upgrades bought at the Kuźnia across the run's life (M15; bumped once per upgradeUnit). */
  unitsUpgraded: number
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
   * The single GLOBAL horde schedule (M7.2) — the telegraphed, escalating invasion of
   * the CAPITAL ({@link villageOrder}[0]). One clock + escalation counter for the whole
   * run (unlike the per-village raid timer), advanced by `advanceHorde` on the
   * deterministic tick. See {@link HordeState}.
   */
  horde: HordeState
  /**
   * The single GLOBAL world-events schedule (M13) — the time-limited windfall OFFERS, gated by
   * the manually-built watchtower. Draws from its OWN seeded RNG stream (never the combat
   * stream), so with no watchtower {@link advanceEvents} is a pure no-op and the run stays
   * byte-identical to pre-M13. See {@link EventState}.
   */
  events: EventState
  /**
   * GLOBAL passive tree (M3.1): purchased level per node id (absent key = level 0).
   * The single account-wide tech state — its economic effects are TRANSIENT
   * multipliers recomputed from this map by {@link aggregateTechMods} and folded
   * into every village's derived stats in {@link recomputeDerived}; no derived tech
   * field is ever stored on the state (only this raw `{ id: level }` map serializes).
   */
  tech: Record<string, number>
  /**
   * PERMANENT prestige (ascension) account state (M4.1) — banked points, lifetime
   * totals, ascension count and the purchased prestige-tree levels. SURVIVES every
   * run reset; its node effects combine with tech via `effectiveMods`. See
   * {@link PrestigeState}.
   */
  prestige: PrestigeState
  /**
   * PERMANENT era account state (M6.1) — the SECOND meta-layer above prestige:
   * banked era points (EP), lifetime totals, era count and the purchased era-tree
   * levels. SURVIVES every era reset (`newEra`, which itself WIPES the prestige
   * account and the run); its node effects combine onto the tech × prestige bag via
   * `effectiveMods`, and its signature `pp_mult` multiplies prestige-point gain. See
   * {@link EraState}.
   */
  era: EraState
  /**
   * PERMANENT dynasty account state (M6.2) — the THIRD meta-layer above era: banked
   * dynasty points (DP), lifetime totals, dynasty count and the purchased dynasty-tree
   * levels. SURVIVES every great-great reset (`newDynasty`, which itself WIPES the era
   * AND prestige accounts and the run); its node effects combine onto the tech × prestige
   * × era bag via `effectiveMods`, its signature `ep_mult` multiplies era-point gain, and
   * its `automation_unlock` gateway unlocks all idle automations account-wide from the
   * start. See {@link DynastyState}.
   */
  dynasty: DynastyState
  /**
   * CHALLENGE (WYZWANIE) account state (M8) — the active run constraint (if any) plus the
   * permanent map of completed challenges. SURVIVES every reset; its constraint + reward
   * effects combine onto the tech × prestige × era × dynasty bag via `effectiveMods`. An
   * empty record folds to identity, so a no-challenge save is byte-identical to pre-M8. See
   * {@link ChallengeState}.
   */
  challenge: ChallengeState
  /**
   * Idle automation toggles + policy (M5.1). The routines themselves are gated by
   * the tech tree (see {@link TechModifiers.automations}); this is the player's
   * ON/OFF state and the auto-recruit policy. All OFF by default, so a run with no
   * automation reproduces pre-M5.1 play exactly. Read each sub-step by
   * `runAutomation` (systems/automation.ts); not a derived field — it serializes.
   */
  automation: AutomationSettings
  /**
   * Permanent LIFETIME counters (M5.4) — the cumulative career record that survives
   * every ascension. Bumped ONLY on the deterministic tick/systems path so it is
   * identical online/offline/sim. Holds only what cannot be re-derived from the rest
   * of the state (won/lost battles, delivered loot, razed camps, …). See {@link Stats}.
   */
  stats: Stats
  /**
   * Unlocked ACHIEVEMENTS (M5.4): a sparse map `achievementId -> unlock marker` (absent
   * key = still locked). The marker is a DETERMINISTIC integer (never a clock — no Date),
   * written once by `checkAchievements` (systems/achievements.ts) on the tick path when
   * an achievement's pure condition over ({@link GameState}, {@link Stats}) first holds,
   * and never cleared. Achievements are a pure DISTINCTION in v1 (no gameplay bonus), so
   * none of the 17 balance goals move. Keys are drawn from `ACHIEVEMENT_IDS`
   * (content/achievements.ts).
   */
  achievements: Record<string, number>
  /**
   * PERMANENT, ACCOUNT-WIDE unit upgrades (M15 KUŹNIA): the purchased upgrade LEVEL per
   * unit type (absent key = level 0). The FIRST per-unit-type modifier in the game — the
   * trees only grant GLOBAL attack/defence multipliers. Read at COMBAT RESOLUTION (threaded
   * into armyAttackPower / armyDefensePower via the optional `forge` param) to lift a type's
   * attack AND defence by {@link import('../content/forge').unitUpgradeMult}. A sparse map,
   * written ONLY by systems/forge.upgradeUnit (a player action, never the tick) for the
   * upgradeable line units; its multipliers are derived on demand and never stored. With no
   * Kuźnia it stays EMPTY ({}), so the optional forge param is undefined → ×1.0 → the run is
   * BYTE-IDENTICAL to pre-M15. Keys are drawn from the upgradeable subset of UNIT_IDS (see
   * content/forge.FORGE_UPGRADES).
   */
  forge: Partial<Record<UnitId, number>>
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
  /**
   * Which idle automations are UNLOCKED (M5.1). Set by `aggregateTechMods` from any
   * `automation_unlock` tech node at level >= 1, OR-combined across the tech and
   * prestige bags by `combine` (systems/prestige.ts). A routine fires in the tick
   * only when BOTH its flag here is true AND the player's switch
   * ({@link GameState.automation}) is on. All `false` in {@link NO_TECH_MODS}, so with
   * no tech nothing is unlocked. Booleans (a gate), unlike the numeric modifiers above.
   */
  automations: { build: boolean; recruit: boolean; attack: boolean }
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
  automations: { build: false, recruit: false, attack: false },
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
  // M9: base 0 merchant capacity — a village with no market grants none, keeping it
  // byte-identical to pre-M9. Accumulated from the market building below.
  let merchantCapacity = D(0)

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
      case 'defense_bonus':
        break // M5.2 wall: consumed by villageDefenseMult (raids), not a tick-derived stat
      case 'merchant_capacity':
        merchantCapacity = merchantCapacity.add(D(effect.perLevel).mul(level))
        break // M9 market: a tick-derived/cached stat (Village.merchantCapacity)
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
  // M9: merchant capacity is a pure building roll-up (NOT scaled by tech mods — it is not
  // a production/storage/pop axis), so it is set straight from the accumulator. With no
  // market it is 0, leaving the village byte-identical to pre-M9.
  v.merchantCapacity = merchantCapacity
}

/**
 * Recompute the derived fields of EVERY village, in {@link GameState.villageOrder}.
 * Name kept (save.ts imports it) — call it after a bulk change or at save import so
 * all cached fields are consistent with the building levels they derive from.
 */
export function recomputeDerived(state: GameState): void {
  // Compute the GLOBAL effective multipliers once (tech bag COMBINED with the prestige
  // bag — see systems/prestige.ts `effectiveMods`) and apply them to every village.
  // This is the ONLY call site of effectiveMods inside state.ts and it lives in the
  // function body (not module top level), which is what keeps the systems/prestige.ts
  // value import free of an initialisation cycle (see the import note above).
  const mods = effectiveMods(state)
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
    // M9: seeded to 0 so the object has its final shape (and key order) before the
    // recompute below overwrites it. With market initialLevel 0 a fresh village keeps
    // merchantCapacity 0 (byte-identical to pre-M9).
    merchantCapacity: D(0),
    buildings: { ...INITIAL_BUILDINGS },
    units: { ...INITIAL_UNITS },
    recruitQueue: [],
    marches: [],
    // M9: no transports in flight for a fresh village.
    shipments: [],
    raidTimer: RAID_BASE_INTERVAL,
  }
  // Make production / storageCap / popCap consistent with the starting buildings.
  // With the initial level-1 economy this reproduces M0's base rates exactly.
  recomputeVillageDerived(v)
  return v
}

/**
 * A fresh lifetime-stats record: every counter zero, `lootHauled` a Decimal zero
 * (the economy rule). Used by {@link createInitialState} and reused by the save
 * migration to backfill the field on a pre-M5.4 save.
 */
export function createInitialStats(): Stats {
  return {
    attacksWon: 0,
    attacksLost: 0,
    lootHauled: D(0),
    resourcesExchanged: D(0),
    raidsRepelled: 0,
    raidsLost: 0,
    hordesRepelled: 0,
    hordesBreached: 0,
    campsRazed: 0,
    fortressesRazed: 0,
    eventsResolved: 0,
    scoutsReturned: 0,
    villagesFounded: 0,
    villagesConquered: 0,
    unitsUpgraded: 0,
  }
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
    horde: { timer: HORDE_INTERVAL, level: 0 },
    // World events (M13) draw from a SEPARATE seeded RNG stream (seed + '::events'), exactly
    // like world-gen uses its own stream — so they never perturb the combat-luck `rngState`.
    // The clock starts a full interval out and idle (active null), and with no watchtower
    // advanceEvents never touches any of this, keeping the run byte-identical to pre-M13.
    events: {
      rngState: RNG.fromString(seed + '::events').getState(),
      timer: EVENT_INTERVAL,
      active: null,
      // M14: no timed buff in force at run start (and never any until a watchtower stands).
      buff: null,
    },
    tech: {},
    prestige: { points: 0, totalEarned: 0, ascensions: 0, nodes: {} },
    era: { points: 0, totalEarned: 0, eras: 0, nodes: {} },
    dynasty: { points: 0, totalEarned: 0, dynasties: 0, nodes: {} },
    challenge: { activeId: null, completed: {} },
    automation: { build: false, recruit: false, attack: false, recruitUnit: null, recruitTarget: 0 },
    stats: createInitialStats(),
    achievements: {},
    // M15: no unit upgrades at run start (and none until a Kuźnia is built). An empty map
    // means the optional `forge` combat param is undefined → ×1.0 → byte-identical to pre-M15.
    forge: {},
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
