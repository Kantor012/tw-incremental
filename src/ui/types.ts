import type { GameStore } from '../engine/state'
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
  /** Upgrade one building level; returns true on success (spent + level++). */
  onBuild: (id: BuildingId) => boolean
  /** Queue `count` of a unit for training; returns true on success (spent + enqueued). */
  onRecruit: (id: UnitId, count: number) => boolean
  /**
   * Dispatch an army at a barbarian camp of `targetLevel`; returns true on a
   * successful send (the march is queued and the dispatched units leave the home
   * garrison until they return).
   */
  onAttack: (targetLevel: number, units: Record<UnitId, number>) => boolean
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
