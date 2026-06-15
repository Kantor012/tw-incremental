import type { UiCtx, Panel } from '../types'
import { h } from '../dom'
import { formatNumber } from '../../engine/format'
import {
  ERA_NODES,
  ERA_NODE_IDS,
  type EraNode,
  type EraCategory,
} from '../../content/era'
import {
  eraScore,
  pendingEraPoints,
  eraPpMult,
  eraNodeLevel,
  eraNodeAvailable,
  eraNodeCost,
  canPurchaseEra,
} from '../../systems/era'
import { layoutNodes, nodeEdges } from '../../systems/techLayout'
import { buildTreeView, type TreeViewConfig } from './treeView'

/**
 * "Era" panel (M6.1) — the SECOND meta-layer, sitting ABOVE prestige/ascension.
 *
 * Two stacked regions (mirrors panels/prestige.ts, one rung higher):
 *  1. ERA summary (top): the banked era-point balance, the lifetime era count, the current
 *     whole-account prestige score ({@link eraScore}), the EP that starting a Nowa Era
 *     RIGHT NOW would bank ({@link pendingEraPoints}) and the signature prestige-point
 *     multiplier the era tree currently grants ({@link eraPpMult}, shown as "+X%"), plus the
 *     destructive "Nowa Era" action. The action is gated behind a Polish `window.confirm`
 *     that spells out the GREAT RESET: it WIPES the ENTIRE prestige account (PP, every
 *     prestige node, ascensions) and resets the run to one fresh capital, AND what SURVIVES
 *     (the era tree + EP are PERMANENT, and the lifetime stats/achievements stay) — never
 *     colour alone carries the warning, and the outcome is announced through a polite live
 *     region.
 *  2. The era CONSTELLATION (below): the same Path-of-Exile-style radial tree as "Rozwój" /
 *     "Prestiż", rendered by the GENERIC {@link buildTreeView} renderer — fed the
 *     {@link ERA_NODES} catalogue, the deterministic {@link layoutNodes} positions and
 *     {@link nodeEdges} links, and the era engine's level/availability/cost helpers. The
 *     currency here is ERA POINTS (EP), surfaced through the config's
 *     {@link TreeViewConfig.currencyEl} header instead of the tech tree's resource pool.
 *
 * Data-driven & deterministic: this module owns NO node coordinates, NO economy logic and
 * NO clock/RNG. Adding or rebalancing an era node is an edit to src/content/era.ts; the
 * layout, the effects and the EP curve all flow from the shared engine. The category hues
 * reuse existing design tokens (no hardcoded colour), so the era arms read as distinct
 * without touching the token sheet.
 *
 * Reactivity (panel contract): the DOM is built ONCE. {@link Panel.update} pokes the summary
 * numbers, the Nowa-Era button's state/label and the currency header, then delegates the
 * constellation refresh to the embedded tree view's own `update`.
 */

/** PL display name per era branch (the constellation arms). */
const CATEGORY_LABEL: Record<EraCategory, string> = {
  eternity: 'Wieczność',
  pantheon: 'Panteon',
  legacy: 'Dziedzictwo',
}

/**
 * Per-branch HUE for the constellation, as a reference to an existing design token (never a
 * raw hex — the project's "zero hardcoded colours" rule). The three era arms reuse the tech
 * tree's category tokens whose meaning lines up, so the arms stay mutually distinct on the
 * dark canvas without adding new tokens: eternity (economy/permanence) → the gold economy
 * hue, pantheon (combat might) → the red military hue, legacy (the prestige-loop
 * accelerator) → the purple plunder hue. Colour is a SECONDARY cue here too (shape/label/
 * legend carry state — WCAG 1.4.1).
 */
const CATEGORY_HUE: Record<EraCategory, string> = {
  eternity: 'var(--cat-economy)',
  pantheon: 'var(--cat-military)',
  legacy: 'var(--cat-plunder)',
}

/** A percentage label for a per-level fraction (0.05 -> "5%", 0.012 -> "1.2%"). */
function pct(frac: number): string {
  return formatNumber(frac * 100, 2) + '%'
}

/**
 * Full "±X% <subject> / poziom" effect line for the detail card. Exhaustive over the
 * {@link EraNode.effect} union: the reductions (cost/recruit/march) read with a "−" sign,
 * the multiplicative bonuses with "+", the era-only `start_resources` is a FLAT per-resource
 * head-start (not a percentage), and the signature `pp_mult` scales prestige-point gain.
 */
function effectText(node: EraNode): string {
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
    case 'pp_mult':
      return '+' + pct(e.perLevel) + ' punktów prestiżu / poziom'
  }
}

/**
 * Build the "Era" panel. Reads {@link UiCtx} for the live store, the `onNewEra` great-reset
 * commit and the `onPurchaseEra` node commit; every availability/affordability cue comes
 * straight from the shared era engine so the card can never disagree with what an action
 * actually does.
 */
export function createEraPanel(ctx: UiCtx): Panel {
  const el = h('div', 'era-panel')

  // ---- Intro note ----------------------------------------------------------
  const note = h(
    'p',
    'tech-note muted',
    'Era (wielki reset): rozpocznij Nową Erę, aby zamienić cały dorobek prestiżu na ' +
      'PERMANENTNE punkty ery (EP). EP wydajesz w trwałym drzewie poniżej — jego bonusy ' +
      'przetrwają każdą erę i łączą się z efektami drzewa rozwoju oraz prestiżu. ' +
      'Sygnaturowy bonus ery zwiększa zysk punktów prestiżu, więc każda nowa era ' +
      'przyspiesza całą pętlę prestiżu.',
  )
  note.setAttribute('role', 'note')
  el.appendChild(note)

  // ---- Era summary ---------------------------------------------------------
  const summary = h('section', 'prestige-summary')
  summary.setAttribute('aria-labelledby', 'era-summary-h')
  const summaryHead = h('h3', 'prestige-summary-h', 'Nowa Era')
  summaryHead.id = 'era-summary-h'
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
  const epVal = addStat('Punkty ery (EP)')
  const erasVal = addStat('Ery')
  const scoreVal = addStat('Wynik ery')
  const pendingVal = addStat('Do zdobycia teraz')
  const ppMultVal = addStat('Mnożnik PP')
  summary.appendChild(stats)

  const actions = h('div', 'save-actions')
  // Destructive action: starting a Nowa Era performs the GREAT RESET — it WIPES the ENTIRE
  // prestige account (PP, all prestige nodes, ascensions) and resets the run to one fresh
  // capital. It must read as consequential BEFORE the confirm, not like the benign gold
  // "Wykup" buy buttons in the constellation — so it uses the same `.btn-danger` variant +
  // var(--bad) framing the prestige/save panels use for their resets, not `.btn-primary`.
  const newEraBtn = h('button', 'btn btn-danger', 'Nowa Era')
  newEraBtn.type = 'button'
  actions.appendChild(newEraBtn)
  summary.appendChild(actions)

  const msg = h('p', 'save-msg muted')
  msg.setAttribute('role', 'status')
  msg.setAttribute('aria-live', 'polite')
  summary.appendChild(msg)

  el.appendChild(summary)

  newEraBtn.addEventListener('click', () => {
    const pending = pendingEraPoints(ctx.store.state)
    // Guarded no-op (button stays focusable via aria-disabled so its reason is read).
    if (pending <= 0) {
      msg.textContent =
        'Brak dorobku prestiżu do spieniężenia — ascenduj i rozbuduj drzewo prestiżu, ' +
        'aby zdobyć punkty ery.'
      return
    }
    const confirmed = window.confirm(
      'NOWA ERA TO WIELKI RESET.\n\n' +
        'Stracisz CAŁE KONTO PRESTIŻU: wszystkie punkty prestiżu (PP), całe drzewo ' +
        'prestiżu oraz licznik ascensji. Bieżący bieg zostanie zresetowany do jednej ' +
        'nowej stolicy, świat zostanie wygenerowany od nowa, a drzewo rozwoju ' +
        'wyczyszczone.\n\n' +
        'Zachowasz: drzewo ery i punkty ery (EP) — są PERMANENTNE — oraz dorobek życiowy ' +
        '(statystyki i osiągnięcia).\n\n' +
        'Otrzymasz teraz: ' +
        formatNumber(pending, 0) +
        ' EP.\n\nKontynuować?',
    )
    if (!confirmed) {
      msg.textContent = 'Nowa Era anulowana.'
      return
    }
    const ep = ctx.onNewEra()
    msg.textContent =
      ep > 0
        ? 'Nowa Era rozpoczęta. Zdobyto ' + formatNumber(ep, 0) + ' EP. Konto prestiżu zresetowane.'
        : 'Nowa Era nie powiodła się — brak punktów do zdobycia.'
    update()
  })

  // ---- Era currency header (EP) for the tree view -------------------------
  // A STABLE element kept up to date by update(); buildTreeView mounts it ONCE in its own
  // `.tech-pool` currency bar (it only re-swaps if a DIFFERENT element is returned), so this
  // is the era twin of the prestige-points readout. It is an inline `.tech-pool-item` chip
  // (label + value) — buildTreeView already supplies the box.
  const currencyWrap = h('div', 'tech-pool-item prestige-currency')
  currencyWrap.setAttribute('role', 'note')
  currencyWrap.setAttribute('aria-label', 'Dostępne punkty ery')
  currencyWrap.appendChild(h('span', 'tech-pool-label muted', 'Punkty Ery (EP):'))
  const currencyVal = h('span', 'num tech-pool-val', '0')
  currencyWrap.appendChild(currencyVal)

  // ---- Era constellation (generic tree view) ------------------------------
  const config: TreeViewConfig = {
    nodes: ERA_NODES,
    nodeIds: ERA_NODE_IDS,
    positions: layoutNodes(ERA_NODES, ERA_NODE_IDS),
    edges: nodeEdges(ERA_NODES, ERA_NODE_IDS),
    categoryLabel: CATEGORY_LABEL,
    categoryHue: CATEGORY_HUE,
    level: (id) => eraNodeLevel(ctx.store.state, id),
    available: (id) => eraNodeAvailable(ctx.store.state, id),
    // Affordable = buyable right now (prereqs met, not maxed, banked EP covers the cost).
    affordable: (id) => canPurchaseEra(ctx.store.state, id).ok,
    costText: (id, level) => formatNumber(eraNodeCost(id, level), 0) + ' EP',
    effectText: (id) => {
      const node = ERA_NODES[id]
      return node ? effectText(node) : ''
    },
    purchase: (id) => ctx.onPurchaseEra(id),
    currencyEl: () => currencyWrap,
  }
  const tree = buildTreeView(config)
  el.appendChild(tree.el)

  // ---- Reactivity ----------------------------------------------------------
  const update = (): void => {
    const state = ctx.store.state
    const e = state.era
    const points = e ? e.points : 0
    const eras = e ? e.eras : 0

    epVal.textContent = formatNumber(points, 0)
    erasVal.textContent = formatNumber(eras, 0)
    scoreVal.textContent = formatNumber(eraScore(state), 0)
    const pending = pendingEraPoints(state)
    pendingVal.textContent = formatNumber(pending, 0) + ' EP'
    // Signature era bonus surfaced as a "+X%" prestige-point multiplier (eraPpMult is 1 + Σ).
    ppMultVal.textContent = '+' + pct(eraPpMult(state) - 1)
    currencyVal.textContent = formatNumber(points, 0)

    const canStart = pending > 0
    newEraBtn.setAttribute('aria-disabled', canStart ? 'false' : 'true')
    newEraBtn.textContent = canStart
      ? 'Nowa Era (+' + formatNumber(pending, 0) + ' EP)'
      : 'Nowa Era'
    newEraBtn.title = canStart
      ? ''
      : 'Brak dorobku prestiżu do spieniężenia — zdobądź punkty, rozbudowując prestiż.'
    newEraBtn.setAttribute(
      'aria-label',
      canStart
        ? 'Rozpocznij Nową Erę i zdobądź ' +
            formatNumber(pending, 0) +
            ' punktów ery (resetuje całe konto prestiżu)'
        : 'Nowa Era niedostępna — brak punktów ery do zdobycia',
    )

    tree.update()
  }

  update()

  return { el, update }
}
