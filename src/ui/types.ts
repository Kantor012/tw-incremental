import type { AutomationSettings, GameStore, VillageId, ResourceId } from '../engine/state'
import type { Signal } from '../engine/store'
import type { GameBus } from '../engine/eventbus'
import type { BuildingId } from '../content/buildings'
import type { UnitId } from '../content/units'

/**
 * Shared UI contract. Both the dashboard shell (layout.ts) and every panel
 * (panels/*.ts) depend ONLY on these two types — never on each other — so the
 * panels can be authored independently and in parallel.
 */

/**
 * Everything a panel needs from the host application. Structurally identical to
 * the object main.ts already passes to {@link mountApp}, so wiring is unchanged:
 * the reactive store + bus for reading state, the intent callbacks for mutating
 * it (each returns `true` on success), and the boot metadata for the footer.
 *
 * Callback convention (unchanged from the engine): handlers spend resources,
 * mutate state, `store.commit()` and persist on success, returning whether the
 * action was applied. A panel reads the latest verdict (canBuild/canRecruit/
 * canAttack) itself to drive disabled/affordability cues — the callbacks are the
 * commit, not the validation.
 */
export interface UiCtx {
  /** Reactive single-source-of-truth store. Read `store.state`; subscribe via `store.rev`. */
  store: GameStore
  /** Typed pub/sub bus for cross-system signals (save/load/tick/...). */
  bus: GameBus
  /**
   * Currently selected village. The village selector (layout.ts) WRITES it; panels
   * and the HUD READ the active village as
   * `store.state.villages[activeVillageId.value]`. A signal so a selection change
   * re-renders the active tab without rebuilding the shell.
   */
  activeVillageId: Signal<VillageId>
  /** Upgrade one building level in `villageId`; returns true on success (spent + level++). */
  onBuild: (villageId: VillageId, id: BuildingId) => boolean
  /** Queue `count` of a unit for training in `villageId`; returns true on success (spent + enqueued). */
  onRecruit: (villageId: VillageId, id: UnitId, count: number) => boolean
  /**
   * Dispatch an army from `villageId` at the barbarian village `targetId` (an id
   * from `store.state.world.barbarians`); returns true on a successful send (the
   * march is queued and the dispatched units leave the home garrison until they
   * return).
   */
  onAttack: (villageId: VillageId, targetId: string, units: Record<UnitId, number>) => boolean
  /**
   * Dispatch an army from `villageId` to ASSAULT the fortress `fortressId` (M7; an id from
   * `store.state.world.fortresses`); returns true on a successful send (an `attack` march
   * with `targetType: 'fortress'` is queued and the dispatched units leave the home garrison
   * until they return). On a won assault the fortress is RAZED for good (one-time) and the
   * big loot cache is hauled home (carry-capped like any attack); a razed/missing fortress is
   * rejected. Mirrors {@link onAttack} but for a fortress target — the panel reads
   * `canAttackFortress` (systems/marches) itself for the disabled cue; this callback is the
   * commit, not the validation.
   */
  onAssaultFortress: (
    villageId: VillageId,
    fortressId: string,
    units: Record<UnitId, number>,
  ) => boolean
  /**
   * Send `scoutCount` scouts from `villageId` to RECON the barbarian village `targetId`
   * (an id from `store.state.world.barbarians`); returns true on a successful send (a
   * `scout` march is queued and the scouts leave the home garrison until they return).
   * On arrival the target's defence/loot is REVEALED (`BarbarianVillage.scouted` flips
   * true); the scouts fight nothing, take no loot and return unharmed (M5.2). The map/
   * campaign panel reads `canScout` (systems/marches) itself for the disabled cue — this
   * callback is the commit, not the validation.
   */
  onScout: (villageId: VillageId, targetId: string, scoutCount: number) => boolean
  /**
   * Found a new owned village at map field `(x, y)`, paid from `payerVillageId`.
   * Returns the new village's id on success (cost spent, village added, committed +
   * persisted), or `null` when founding was rejected (geometry/affordability — the
   * panel checks `canFound`/`foundCost` from systems/villages directly for cues).
   */
  onFound: (payerVillageId: VillageId, x: number, y: number) => VillageId | null
  /**
   * Dispatch a MERCHANT shipment (M9 rynek) carrying `cargo` (wood/clay/iron amounts) from
   * `fromVillageId` to another OWNED village `toVillageId`; returns true on a successful send.
   * On success the cargo LEAVES the source immediately (debited and held in transit, occupying
   * the source's merchant capacity) and is delivered to the destination on arrival (clamped to
   * its storage cap, overflow spilled). Transport CONSERVES resources — it never creates any —
   * and is benign/reversible, so no confirmation is needed. The market panel reads
   * `canTransport` (systems/market) itself for the disabled/affordability cue; this callback is
   * the commit, not the validation. Mirrors {@link onAttack} / {@link onFound}.
   */
  onTransport: (
    fromVillageId: VillageId,
    toVillageId: VillageId,
    cargo: Record<ResourceId, number>,
  ) => boolean
  /**
   * Exchange (M9.2 rynek) `amount` of `fromRes` into `toRes` AT the SAME village `villageId`,
   * INSTANTLY, at the market; returns true on a successful exchange. On success the input is
   * DEBITED and the floored received amount of the other resource is CREDITED (clamped to the
   * storage cap, overflow spilled). The exchange pays a SPREAD — the rate is ALWAYS < 1, so you
   * receive LESS value than you put in — so it can NEVER create net resources; it is a benign
   * convenience / surplus sink, so no confirmation is needed. The market panel reads
   * `canExchange` (systems/market) itself for the disabled cue; this callback is the commit, not
   * the validation. Mirrors {@link onTransport} but for an at-village resource conversion.
   */
  onExchange: (
    villageId: VillageId,
    fromRes: ResourceId,
    toRes: ResourceId,
    amount: number,
  ) => boolean
  /**
   * CLAIM the active world-event offer (M13) — grant the bounded resource windfall to the
   * CAPITAL and clear the offer; returns true on success, false when there is no live offer (or
   * no watchtower). On success the windfall is credited (each resource clamped to the storage
   * cap, overflow spilled), the lifetime `eventsResolved` counter bumped and the change committed
   * + persisted. A benign, one-way gain (never spends, never destabilises), so no confirmation is
   * needed. The events panel reads `store.state.events.active` itself for the disabled cue; this
   * callback is the commit, not the validation. Mirrors {@link onExchange} (a player-initiated,
   * commit-on-success action).
   */
  onClaimEvent: () => boolean
  /**
   * Purchase the NEXT level of the global tech node `nodeId`, paid from the GLOBAL
   * resource pool (summed across all villages); returns true on success (cost spent,
   * `state.tech[nodeId]` incremented, derived multipliers recomputed, committed +
   * persisted). The tech panel reads `canPurchaseTech` (systems/tech) itself for the
   * disabled/affordability cue — this callback is the commit, not the validation.
   */
  onPurchaseTech: (nodeId: string) => boolean
  /**
   * ASCEND (M4.1): bank the pending prestige points and RESET the run (villages →
   * a fresh capital, world regenerated from the seed, tech/battle log cleared, start
   * bonuses applied). Returns the number of PP awarded — `0` when ascending was a
   * no-op (no pending points). On a positive result the new run is already committed +
   * persisted. The panel confirms the destructive reset with the player itself; this
   * callback is the commit, not the prompt. The PERMANENT prestige tree + banked
   * points survive.
   */
  onAscend: () => number
  /**
   * Purchase the NEXT level of the prestige node `nodeId`, paid from banked PRESTIGE
   * POINTS; returns true on success (PP spent, `state.prestige.nodes[nodeId]`
   * incremented, derived multipliers recomputed, committed + persisted). The prestige
   * panel reads `canPurchasePrestige` (systems/prestige) itself for the disabled/
   * affordability cue — this callback is the commit, not the validation.
   */
  onPurchasePrestige: (nodeId: string) => boolean
  /**
   * NOWA ERA (M6.1): bank the pending ERA POINTS and perform the GREAT RESET — WIPE the
   * ENTIRE prestige account (PP, all prestige nodes, ascensions) and reset the run to a
   * fresh capital (world regenerated from a per-era seed, tech/battle log cleared, era
   * start bonuses applied). Returns the number of EP awarded — `0` when starting an era
   * was a no-op (no pending points). On a positive result the new era is already committed
   * + persisted. The panel confirms the destructive reset with the player itself; this
   * callback is the commit, not the prompt. The PERMANENT era tree + banked EP and the
   * lifetime stats/achievements survive.
   */
  onNewEra: () => number
  /**
   * Purchase the NEXT level of the era node `nodeId`, paid from banked ERA POINTS;
   * returns true on success (EP spent, `state.era.nodes[nodeId]` incremented, derived
   * multipliers recomputed, committed + persisted). The era panel reads `canPurchaseEra`
   * (systems/era) itself for the disabled/affordability cue — this callback is the commit,
   * not the validation.
   */
  onPurchaseEra: (nodeId: string) => boolean
  /**
   * NOWA DYNASTIA (M6.2): bank the pending DYNASTY POINTS and perform the GREAT-GREAT RESET —
   * WIPE the ENTIRE era account (EP, all era nodes, eras) AND the ENTIRE prestige account (PP,
   * all prestige nodes, ascensions) and reset the run to a fresh capital (world regenerated
   * from a per-dynasty seed, tech/battle log cleared, dynasty start bonuses applied). Returns
   * the number of DP awarded — `0` when founding a dynasty was a no-op (no pending points). On
   * a positive result the new dynasty is already committed + persisted. The panel confirms the
   * destructive reset with the player itself; this callback is the commit, not the prompt. The
   * PERMANENT dynasty tree + banked DP and the lifetime stats/achievements survive.
   */
  onNewDynasty: () => number
  /**
   * Purchase the NEXT level of the dynasty node `nodeId`, paid from banked DYNASTY POINTS;
   * returns true on success (DP spent, `state.dynasty.nodes[nodeId]` incremented, derived
   * multipliers recomputed, committed + persisted). The dynasty panel reads
   * `canPurchaseDynasty` (systems/dynasty) itself for the disabled/affordability cue — this
   * callback is the commit, not the validation.
   */
  onPurchaseDynasty: (nodeId: string) => boolean
  /**
   * ROZPOCZNIJ WYZWANIE (M8): start the challenge `id` — RESET the run (villages → a fresh
   * capital, world regenerated from a per-challenge seed, tech/battle log cleared, horde
   * re-armed) and turn its CONSTRAINT penalty on. The META accounts (prestige/era/dynasty)
   * and the lifetime stats/achievements are PRESERVED (a challenge does NOT bank or wipe
   * them). Returns true on a successful start (no challenge already active and the id is
   * known) — false otherwise. On true the new run is already committed + persisted. The panel
   * confirms the destructive reset with the player itself; this callback is the commit, not
   * the prompt. Mirrors {@link onAscend} (a run reset), but for a constrained challenge run.
   */
  onStartChallenge: (id: string) => boolean
  /**
   * PORZUĆ WYZWANIE (M8): end the active challenge with NO reward — clear its constraint and
   * let the run continue unconstrained (no reset). A no-op when no challenge is active. On
   * return the change is already committed + persisted.
   */
  onAbandonChallenge: () => void
  /**
   * Patch the idle automation toggles / policy (M5.1): merge `patch` into
   * `store.state.automation`, then commit + persist (no recompute — the automation
   * state is read directly by the tick, not folded into derived stats). The
   * automation panel calls this when a switch is toggled or the auto-recruit
   * unit/target changes; it reads `effectiveMods(state).automations` itself to drive
   * the locked/disabled cue. A partial patch so a single control can update one field.
   */
  onSetAutomation: (patch: Partial<AutomationSettings>) => void
  /** Serialize the current run to a save code string. */
  onExport: () => string
  /** Load a save code; returns true when it parsed and was applied. */
  onImport: (s: string) => boolean
  /** Wipe local storage and restart the run. */
  onReset: () => void
  /** App version string (footer). */
  version: string
  /** Seconds of credited offline progress at boot (footer; 0 when none). */
  offlineSeconds: number
}

/**
 * A self-contained dashboard panel.
 *
 * - `el`     is the panel's root element; the shell inserts it into a tabpanel
 *            container. The panel builds this DOM ONCE in its `create*Panel`
 *            factory and caches element references internally.
 * - `update` pokes those cached references from the current `store.state`. The
 *            shell calls it on every store revision WHILE the panel is the active
 *            tab, and once immediately when the panel becomes active — never
 *            while it is hidden. It must NOT rebuild the DOM tree per frame; it
 *            only writes textContent / styles / attributes onto existing nodes.
 */
export interface Panel {
  el: HTMLElement
  update(): void
}
