import type { GameStore, VillageId } from '../engine/state'
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
   * Found a new owned village at map field `(x, y)`, paid from `payerVillageId`.
   * Returns the new village's id on success (cost spent, village added, committed +
   * persisted), or `null` when founding was rejected (geometry/affordability — the
   * panel checks `canFound`/`foundCost` from systems/villages directly for cues).
   */
  onFound: (payerVillageId: VillageId, x: number, y: number) => VillageId | null
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
