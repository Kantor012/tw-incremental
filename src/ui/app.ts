import type { UiCtx } from './types'
import { buildShell, type TabSpec } from './layout'
import { createBuildingsPanel } from './panels/buildings'
import { createArmyPanel } from './panels/army'
import { createCampaignPanel } from './panels/campaign'
import { createReportsPanel } from './panels/reports'
import { createSavePanel } from './panels/save'

/**
 * Composition root for the UI. The dashboard layout (sticky HUD + tabs) lives in
 * layout.ts; the individual screens live in panels/*. This file only declares the
 * tab roster and hands it to {@link buildShell} — adding/reordering a screen is a
 * one-line edit here, never a change to the shell or the other panels.
 *
 * Re-exports the public UI types so callers (e.g. main.ts) have a single import
 * surface for the context contract.
 */
export type { UiCtx, Panel } from './types'

/** The dashboard's tab roster (order = display order; first is the default tab). */
const TABS: TabSpec[] = [
  { id: 'buildings', label: 'Budynki', create: createBuildingsPanel },
  { id: 'army', label: 'Wojsko', create: createArmyPanel },
  { id: 'raids', label: 'Wyprawy', create: createCampaignPanel },
  { id: 'reports', label: 'Raporty', create: createReportsPanel },
  { id: 'save', label: 'Zapis', create: createSavePanel },
]

/**
 * Mount the application UI into `root`. Builds the dashboard shell once and lets
 * it own all live updates (HUD always, active panel per frame).
 */
export function mountApp(root: HTMLElement, ctx: UiCtx): void {
  root.appendChild(buildShell(ctx, TABS))
}
