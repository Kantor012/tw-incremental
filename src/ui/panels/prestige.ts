import type { UiCtx, Panel } from '../types'
import { h } from '../dom'
import { formatNumber } from '../../engine/format'
import {
  PRESTIGE_NODES,
  PRESTIGE_NODE_IDS,
  type PrestigeNode,
  type PrestigeCategory,
} from '../../content/prestige'
import {
  prestigeScore,
  pendingPrestigePoints,
  prestigeNodeLevel,
  prestigeNodeAvailable,
  prestigeNodeCost,
  canPurchasePrestige,
} from '../../systems/prestige'
import { layoutNodes, nodeEdges } from '../../systems/techLayout'
import { buildTreeView, type TreeViewConfig } from './treeView'

/**
 * "Prestiż" panel (M4.1) — the PERMANENT, account-wide ascension layer.
 *
 * Two stacked regions:
 *  1. ASCENSION summary (top): the banked prestige-point balance, the lifetime
 *     ascension count, the current run's progress score and the PP that ascending
 *     RIGHT NOW would bank ({@link pendingPrestigePoints}), plus the destructive
 *     "Ascenduj" action. The action is gated behind a Polish `window.confirm` that
 *     spells out the reset (the run is wiped to a single fresh capital, the world is
 *     regenerated, tech + battle log are cleared) AND what survives (the prestige
 *     points and the whole prestige tree are PERMANENT) — never colour alone carries
 *     the warning, and the outcome is announced through a polite live region.
 *  2. The prestige CONSTELLATION (below): the same Path-of-Exile-style radial tree as
 *     "Rozwój", rendered by the GENERIC {@link buildTreeView} renderer — fed the
 *     {@link PRESTIGE_NODES} catalogue, the deterministic {@link layoutNodes} positions
 *     and {@link nodeEdges} links, and the prestige engine's level/availability/cost
 *     helpers. The currency here is PRESTIGE POINTS (PP), surfaced through the config's
 *     {@link TreeViewConfig.currencyEl} header instead of the tech tree's resource pool.
 *
 * Data-driven & deterministic: this module owns NO node coordinates, NO economy logic
 * and NO clock/RNG. Adding or rebalancing a prestige node is an edit to
 * src/content/prestige.ts; the layout, the effects and the PP curve all flow from the
 * shared engine. The category hues reuse existing design tokens (no hardcoded colour),
 * so the prestige arms read as distinct without touching the token sheet.
 *
 * Reactivity (panel contract): the DOM is built ONCE. {@link Panel.update} pokes the
 * summary numbers, the ascend button's state/label and the currency header, then
 * delegates the constellation refresh to the embedded tree view's own `update`.
 */

/** PL display name per prestige branch (the constellation arms). */
const CATEGORY_LABEL: Record<PrestigeCategory, string> = {
  might: 'Potęga',
  prosperity: 'Dobrobyt',
  dominion: 'Dominacja',
}

/**
 * Per-branch HUE for the constellation, as a reference to an existing design token
 * (never a raw hex — the project's "zero hardcoded colours" rule). The three prestige
 * arms reuse the tech tree's category tokens whose meaning lines up, so the arms stay
 * mutually distinct on the dark canvas without adding new tokens: combat → the red
 * military hue, economy → the gold economy hue, expansion/plunder → the purple plunder
 * hue. Colour is a SECONDARY cue here too (shape/label/legend carry state — WCAG 1.4.1).
 */
const CATEGORY_HUE: Record<PrestigeCategory, string> = {
  might: 'var(--cat-military)',
  prosperity: 'var(--cat-economy)',
  dominion: 'var(--cat-plunder)',
}

/** A percentage label for a per-level fraction (0.05 -> "5%", 0.012 -> "1.2%"). */
function pct(frac: number): string {
  return formatNumber(frac * 100, 2) + '%'
}

/**
 * Full "±X% <subject> / poziom" effect line for the detail card. Exhaustive over the
 * {@link PrestigeNode.effect} union: the reductions (cost/recruit/march) read with a
 * "−" sign, the multiplicative bonuses with "+", and the prestige-only `start_resources`
 * is a FLAT per-resource head-start (not a percentage).
 */
function effectText(node: PrestigeNode): string {
  const e = node.effect
  switch (e.kind) {
    case 'production_mult':
      return '+' + pct(e.perLevel) + ' produkcji wszystkich surowców / poziom'
    case 'storage_mult':
      return '+' + pct(e.perLevel) + ' pojemności magazynu / poziom'
    case 'pop_mult':
      return '+' + pct(e.perLevel) + ' limitu populacji / poziom'
    case 'cost_reduction':
      return '−' + pct(e.perLevel) + ' kosztu budowy / poziom'
    case 'recruit_speed':
      return '−' + pct(e.perLevel) + ' czasu rekrutacji / poziom'
    case 'march_speed':
      return '−' + pct(e.perLevel) + ' czasu marszu / poziom'
    case 'attack_mult':
      return '+' + pct(e.perLevel) + ' siły ataku armii / poziom'
    case 'defense_mult':
      return '+' + pct(e.perLevel) + ' siły obrony armii / poziom'
    case 'loot_mult':
      return '+' + pct(e.perLevel) + ' wielkości łupu / poziom'
    case 'start_resources':
      return '+' + formatNumber(e.perLevel, 0) + ' startowych surowców (każdy surowiec) / poziom'
  }
}

/**
 * Build the "Prestiż" panel. Reads {@link UiCtx} for the live store, the
 * `onAscend` reset commit and the `onPurchasePrestige` node commit; every
 * availability/affordability cue comes straight from the shared prestige engine so the
 * card can never disagree with what an action actually does.
 */
export function createPrestigePanel(ctx: UiCtx): Panel {
  const el = h('div', 'prestige-panel')

  // ---- Intro note ----------------------------------------------------------
  const note = h(
    'p',
    'tech-note muted',
    'Prestiż (ascensja): zresetuj bieg, aby zamienić osiągnięty postęp na PERMANENTNE ' +
      'punkty prestiżu (PP). PP wydajesz w trwałym drzewie poniżej — jego bonusy ' +
      'przetrwają każdy reset i łączą się z efektami drzewa rozwoju.',
  )
  note.setAttribute('role', 'note')
  el.appendChild(note)

  // ---- Ascension summary ---------------------------------------------------
  const summary = h('section', 'prestige-summary')
  summary.setAttribute('aria-labelledby', 'prestige-summary-h')
  const summaryHead = h('h3', 'prestige-summary-h', 'Ascensja')
  summaryHead.id = 'prestige-summary-h'
  summary.appendChild(summaryHead)

  // Reuse the shared .building-stats/.stat chrome so the summary matches every tab.
  const stats = h('div', 'building-stats')
  const addStat = (label: string): HTMLElement => {
    const wrap = h('div', 'stat')
    wrap.appendChild(h('span', 'stat-label muted', label))
    const val = h('span', 'stat-val num', '—')
    wrap.appendChild(val)
    stats.appendChild(wrap)
    return val
  }
  const ppVal = addStat('Punkty prestiżu (PP)')
  const ascVal = addStat('Ascensje')
  const scoreVal = addStat('Wynik biegu')
  const pendingVal = addStat('Do zdobycia teraz')
  summary.appendChild(stats)

  const actions = h('div', 'save-actions')
  // Destructive action: ascending WIPES the run (all villages → one fresh capital,
  // the whole tech tree, every banked resource; the world regenerates). It must read
  // as consequential BEFORE the confirm, not like the benign gold "Wykup" buy buttons
  // in the constellation — so it uses the same `.btn-danger` variant + var(--bad)
  // framing the save panel uses for "Resetuj grę" (base.css), not `.btn-primary`.
  const ascendBtn = h('button', 'btn btn-danger', 'Ascenduj')
  ascendBtn.type = 'button'
  actions.appendChild(ascendBtn)
  summary.appendChild(actions)

  const msg = h('p', 'save-msg muted')
  msg.setAttribute('role', 'status')
  msg.setAttribute('aria-live', 'polite')
  summary.appendChild(msg)

  el.appendChild(summary)

  ascendBtn.addEventListener('click', () => {
    const pending = pendingPrestigePoints(ctx.store.state)
    // Guarded no-op (button stays focusable via aria-disabled so its reason is read).
    if (pending <= 0) {
      msg.textContent =
        'Brak postępu do spieniężenia — rozbuduj wioski i drzewo rozwoju, ' +
        'aby zdobyć punkty prestiżu.'
      return
    }
    const confirmed = window.confirm(
      'ASCENSJA ZRESETUJE BIEŻĄCY BIEG.\n\n' +
        'Stracisz: wszystkie wioski (zostanie jedna nowa stolica), całe drzewo rozwoju ' +
        'oraz bieżące surowce; świat zostanie wygenerowany od nowa.\n\n' +
        'Zachowasz: punkty prestiżu i całe drzewo prestiżu — jego bonusy są PERMANENTNE.\n\n' +
        'Otrzymasz teraz: ' +
        formatNumber(pending, 0) +
        ' PP.\n\nKontynuować?',
    )
    if (!confirmed) {
      msg.textContent = 'Ascensja anulowana.'
      return
    }
    const pp = ctx.onAscend()
    msg.textContent =
      pp > 0
        ? 'Ascensja zakończona. Zdobyto ' + formatNumber(pp, 0) + ' PP. Nowy bieg rozpoczęty.'
        : 'Ascensja nie powiodła się — brak punktów do zdobycia.'
    update()
  })

  // ---- Prestige currency header (PP) for the tree view --------------------
  // A STABLE element kept up to date by update(); buildTreeView mounts it ONCE in its
  // own `.tech-pool` currency bar (it only re-swaps if a DIFFERENT element is returned),
  // so this is the prestige twin of the tech tree's resource pool. It is an inline
  // `.tech-pool-item` chip (label + value) — buildTreeView already supplies the box.
  const currencyWrap = h('div', 'tech-pool-item prestige-currency')
  currencyWrap.setAttribute('role', 'note')
  currencyWrap.setAttribute('aria-label', 'Dostępne punkty prestiżu')
  currencyWrap.appendChild(h('span', 'tech-pool-label muted', 'Punkty prestiżu:'))
  const currencyVal = h('span', 'num tech-pool-val', '0')
  currencyWrap.appendChild(currencyVal)

  // ---- Prestige constellation (generic tree view) -------------------------
  const config: TreeViewConfig = {
    nodes: PRESTIGE_NODES,
    nodeIds: PRESTIGE_NODE_IDS,
    positions: layoutNodes(PRESTIGE_NODES, PRESTIGE_NODE_IDS),
    edges: nodeEdges(PRESTIGE_NODES, PRESTIGE_NODE_IDS),
    categoryLabel: CATEGORY_LABEL,
    categoryHue: CATEGORY_HUE,
    level: (id) => prestigeNodeLevel(ctx.store.state, id),
    available: (id) => prestigeNodeAvailable(ctx.store.state, id),
    // Affordable = buyable right now (prereqs met, not maxed, banked PP covers the cost).
    affordable: (id) => canPurchasePrestige(ctx.store.state, id).ok,
    costText: (id, level) => formatNumber(prestigeNodeCost(id, level), 0) + ' PP',
    effectText: (id) => {
      const node = PRESTIGE_NODES[id]
      return node ? effectText(node) : ''
    },
    purchase: (id) => ctx.onPurchasePrestige(id),
    currencyEl: () => currencyWrap,
  }
  const tree = buildTreeView(config)
  el.appendChild(tree.el)

  // ---- Reactivity ----------------------------------------------------------
  const update = (): void => {
    const state = ctx.store.state
    const p = state.prestige
    const points = p ? p.points : 0
    const ascensions = p ? p.ascensions : 0

    ppVal.textContent = formatNumber(points, 0)
    ascVal.textContent = formatNumber(ascensions, 0)
    scoreVal.textContent = formatNumber(prestigeScore(state), 0)
    const pending = pendingPrestigePoints(state)
    pendingVal.textContent = formatNumber(pending, 0) + ' PP'
    currencyVal.textContent = formatNumber(points, 0)

    const canAscend = pending > 0
    ascendBtn.setAttribute('aria-disabled', canAscend ? 'false' : 'true')
    ascendBtn.textContent = canAscend
      ? 'Ascenduj (+' + formatNumber(pending, 0) + ' PP)'
      : 'Ascenduj'
    ascendBtn.title = canAscend
      ? ''
      : 'Brak postępu do spieniężenia — zdobądź punkty, rozbudowując bieg.'
    ascendBtn.setAttribute(
      'aria-label',
      canAscend
        ? 'Ascenduj i zdobądź ' + formatNumber(pending, 0) + ' punktów prestiżu (resetuje bieg)'
        : 'Ascensja niedostępna — brak punktów prestiżu do zdobycia',
    )

    tree.update()
  }

  update()

  return { el, update }
}
