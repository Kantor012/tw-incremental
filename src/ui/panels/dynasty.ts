import type { UiCtx, Panel } from '../types'
import { h } from '../dom'
import { formatNumber } from '../../engine/format'
import {
  DYNASTY_NODES,
  DYNASTY_NODE_IDS,
  type DynastyNode,
  type DynastyCategory,
} from '../../content/dynasty'
import {
  aggregateDynastyMods,
  dynastyScore,
  pendingDynastyPoints,
  dynastyEpMult,
  dynastyNodeLevel,
  dynastyNodeAvailable,
  dynastyNodeCost,
  canPurchaseDynasty,
} from '../../systems/dynasty'
import { layoutNodes, nodeEdges } from '../../systems/techLayout'
import { buildTreeView, type TreeViewConfig } from './treeView'

/**
 * "Dynastia" panel (M6.2) — the THIRD meta-layer, sitting ABOVE era (which itself sits above
 * prestige/ascension).
 *
 * Two stacked regions (mirrors panels/era.ts, one rung higher):
 *  1. DYNASTY summary (top): the banked dynasty-point balance, the lifetime dynasty count, the
 *     current whole-account ERA score ({@link dynastyScore}), the DP that founding a Nowa
 *     Dynastia RIGHT NOW would bank ({@link pendingDynastyPoints}), the signature era-point
 *     multiplier the dynasty tree currently grants ({@link dynastyEpMult}, shown as "+X%"), and
 *     the "Automatyzacje od startu" indicator — whether the PERMANENT dynasty automation
 *     gateway has unlocked every idle routine account-wide (read from the dynasty bag in
 *     isolation via `aggregateDynastyMods(state.dynasty.nodes).automations`, NOT the combined
 *     `effectiveMods`, so a run that merely researched the tech automations cannot spoof it;
 *     carried in TEXT, never colour alone). Plus the destructive "Nowa Dynastia" action, gated
 *     behind a Polish `window.confirm` that spells out the GREAT-GREAT RESET: it WIPES the
 *     ENTIRE era account (EP, every era node, eras) AND the ENTIRE prestige account (PP, every
 *     prestige node, ascensions) and resets the run to one fresh capital, AND what SURVIVES
 *     (the dynasty tree + DP are PERMANENT, and the lifetime stats/achievements stay) — the
 *     warning is never colour alone, and the outcome is announced through a polite live region.
 *  2. The dynasty CONSTELLATION (below): the same Path-of-Exile-style radial tree as
 *     "Rozwój" / "Prestiż" / "Era", rendered by the GENERIC {@link buildTreeView} renderer —
 *     fed the {@link DYNASTY_NODES} catalogue, the deterministic {@link layoutNodes} positions
 *     and {@link nodeEdges} links, and the dynasty engine's level/availability/cost helpers.
 *     The currency here is DYNASTY POINTS (DP), surfaced through the config's
 *     {@link TreeViewConfig.currencyEl} header instead of the tech tree's resource pool.
 *
 * Data-driven & deterministic: this module owns NO node coordinates, NO economy logic and
 * NO clock/RNG. Adding or rebalancing a dynasty node is an edit to src/content/dynasty.ts; the
 * layout, the effects and the DP curve all flow from the shared engine. The category hues
 * reuse existing design tokens (no hardcoded colour), so the dynasty arms read as distinct
 * without touching the token sheet.
 *
 * Reactivity (panel contract): the DOM is built ONCE. {@link Panel.update} pokes the summary
 * numbers, the Nowa-Dynastia button's state/label, the automation indicator and the currency
 * header, then delegates the constellation refresh to the embedded tree view's own `update`.
 */

/** PL display name per dynasty branch (the constellation arms). */
const CATEGORY_LABEL: Record<DynastyCategory, string> = {
  sovereignty: 'Suwerenność',
  apotheosis: 'Apoteoza',
  continuum: 'Kontinuum',
}

/**
 * Per-branch HUE for the constellation, as a reference to an existing design token (never a
 * raw hex — the project's "zero hardcoded colours" rule). The three dynasty arms reuse the
 * tech tree's category tokens whose meaning lines up (and mirror the era panel's choices one
 * rung lower), so the arms stay mutually distinct on the dark canvas without adding new
 * tokens: continuum (economy/permanence) → the gold economy hue, apotheosis (combat might) →
 * the red military hue, sovereignty (the era-loop accelerator + automation gate) → the purple
 * plunder hue. Colour is a SECONDARY cue here too (shape/label/legend carry state — WCAG
 * 1.4.1).
 */
const CATEGORY_HUE: Record<DynastyCategory, string> = {
  sovereignty: 'var(--cat-plunder)',
  apotheosis: 'var(--cat-military)',
  continuum: 'var(--cat-economy)',
}

/** A percentage label for a per-level fraction (0.05 -> "5%", 0.012 -> "1.2%"). */
function pct(frac: number): string {
  return formatNumber(frac * 100, 2) + '%'
}

/**
 * Full "±X% <subject> / poziom" effect line for the detail card. Exhaustive over the
 * {@link DynastyNode.effect} union: the reductions (cost/recruit/march) read with a "−" sign,
 * the multiplicative bonuses with "+", the dynasty-only `start_resources` is a FLAT
 * per-resource head-start (not a percentage), the signature `ep_mult` scales era-point gain,
 * and the binary `automation_unlock` gateway is a one-off mechanic unlock (no per-level
 * magnitude).
 */
function effectText(node: DynastyNode): string {
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
    case 'ep_mult':
      return '+' + pct(e.perLevel) + ' punktów ery / poziom'
    case 'automation_unlock':
      return 'Odblokowuje automatyzacje od startu (budowa, rekrutacja, atak)'
  }
}

/**
 * True when the PERMANENT dynasty automation gateway is owned — i.e. the dynasty modifier bag
 * reports all three idle automations unlocked. We deliberately read the dynasty bag in
 * ISOLATION ({@link aggregateDynastyMods} over `state.dynasty.nodes`) rather than the combined
 * {@link effectiveMods}: the tech tree (M5.1) ALSO carries `automation_unlock` gateways, so a
 * run that merely RESEARCHED them mid-run would flip the combined flags true even though the
 * account-wide-from-start dynasty gate was never bought. The "od startu" label promises that
 * permanent gate, so the indicator must reflect the dynasty bag alone — which the M6.2 contract
 * guarantees is the only META aggregate that sets these flags (prestige + era leave them false,
 * and the dynasty bag is unaffected by tech).
 */
function automationsUnlocked(ctx: UiCtx): boolean {
  const state = ctx.store.state
  const a = aggregateDynastyMods(state.dynasty ? state.dynasty.nodes : {}).automations
  return a.build && a.recruit && a.attack
}

/**
 * Build the "Dynastia" panel. Reads {@link UiCtx} for the live store, the `onNewDynasty`
 * great-great-reset commit and the `onPurchaseDynasty` node commit; every availability/
 * affordability cue comes straight from the shared dynasty engine so the card can never
 * disagree with what an action actually does.
 */
export function createDynastyPanel(ctx: UiCtx): Panel {
  const el = h('div', 'dynasty-panel')

  // ---- Intro note ----------------------------------------------------------
  const note = h(
    'p',
    'tech-note muted',
    'Dynastia (wielki-wielki reset): załóż Nową Dynastię, aby zamienić cały dorobek ery na ' +
      'PERMANENTNE punkty dynastii (DP). DP wydajesz w trwałym drzewie poniżej — jego bonusy ' +
      'przetrwają każdą dynastię i łączą się z efektami drzew rozwoju, prestiżu oraz ery. ' +
      'Sygnaturowy bonus dynastii zwiększa zysk punktów ery, a brama administracji odblokowuje ' +
      'wszystkie automatyzacje od startu — każda nowa dynastia przyspiesza całą pętlę ery.',
  )
  note.setAttribute('role', 'note')
  el.appendChild(note)

  // ---- Dynasty summary -----------------------------------------------------
  const summary = h('section', 'prestige-summary')
  summary.setAttribute('aria-labelledby', 'dynasty-summary-h')
  const summaryHead = h('h3', 'prestige-summary-h', 'Nowa Dynastia')
  summaryHead.id = 'dynasty-summary-h'
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
  const dpVal = addStat('Punkty dynastii (DP)')
  const dynastiesVal = addStat('Dynastie')
  const scoreVal = addStat('Wynik dynastii')
  const pendingVal = addStat('Do zdobycia teraz')
  const epMultVal = addStat('Mnożnik EP')
  const autoVal = addStat('Automatyzacje od startu')
  summary.appendChild(stats)

  const actions = h('div', 'save-actions')
  // Destructive action: founding a Nowa Dynastia performs the GREAT-GREAT RESET — it WIPES the
  // ENTIRE era account (EP, all era nodes, eras) AND the ENTIRE prestige account (PP, all
  // prestige nodes, ascensions) and resets the run to one fresh capital. It must read as
  // consequential BEFORE the confirm, not like the benign DP "Wykup" buy buttons in the
  // constellation — so it uses the same `.btn-danger` variant + var(--bad) framing the
  // era/prestige/save panels use for their resets, not `.btn-primary`.
  const newDynastyBtn = h('button', 'btn btn-danger', 'Nowa Dynastia')
  newDynastyBtn.type = 'button'
  actions.appendChild(newDynastyBtn)
  summary.appendChild(actions)

  const msg = h('p', 'save-msg muted')
  msg.setAttribute('role', 'status')
  msg.setAttribute('aria-live', 'polite')
  summary.appendChild(msg)

  el.appendChild(summary)

  newDynastyBtn.addEventListener('click', () => {
    const pending = pendingDynastyPoints(ctx.store.state)
    // Guarded no-op (button stays focusable via aria-disabled so its reason is read).
    if (pending <= 0) {
      msg.textContent =
        'Brak dorobku ery do spieniężenia — rozpoczynaj ery i rozbudowuj drzewo ery, ' +
        'aby zdobyć punkty dynastii.'
      return
    }
    const confirmed = window.confirm(
      'NOWA DYNASTIA TO WIELKI-WIELKI RESET.\n\n' +
        'Stracisz CAŁE KONTO ERY: wszystkie punkty ery (EP), całe drzewo ery oraz licznik er. ' +
        'Stracisz też CAŁE KONTO PRESTIŻU: wszystkie punkty prestiżu (PP), całe drzewo ' +
        'prestiżu oraz licznik ascensji. Bieżący bieg zostanie zresetowany do jednej nowej ' +
        'stolicy, świat zostanie wygenerowany od nowa, a drzewo rozwoju wyczyszczone.\n\n' +
        'Zachowasz: drzewo dynastii i punkty dynastii (DP) — są PERMANENTNE — oraz dorobek ' +
        'życiowy (statystyki i osiągnięcia).\n\n' +
        'Otrzymasz teraz: ' +
        formatNumber(pending, 0) +
        ' DP.\n\nKontynuować?',
    )
    if (!confirmed) {
      msg.textContent = 'Nowa Dynastia anulowana.'
      return
    }
    const dp = ctx.onNewDynasty()
    msg.textContent =
      dp > 0
        ? 'Nowa Dynastia założona. Zdobyto ' +
          formatNumber(dp, 0) +
          ' DP. Konta ery i prestiżu zresetowane.'
        : 'Nowa Dynastia nie powiodła się — brak punktów do zdobycia.'
    update()
  })

  // ---- Dynasty currency header (DP) for the tree view ----------------------
  // A STABLE element kept up to date by update(); buildTreeView mounts it ONCE in its own
  // `.tech-pool` currency bar (it only re-swaps if a DIFFERENT element is returned), so this
  // is the dynasty twin of the era-points readout. It is an inline `.tech-pool-item` chip
  // (label + value) — buildTreeView already supplies the box.
  const currencyWrap = h('div', 'tech-pool-item prestige-currency')
  currencyWrap.setAttribute('role', 'note')
  currencyWrap.setAttribute('aria-label', 'Dostępne punkty dynastii')
  currencyWrap.appendChild(h('span', 'tech-pool-label muted', 'Punkty Dynastii (DP):'))
  const currencyVal = h('span', 'num tech-pool-val', '0')
  currencyWrap.appendChild(currencyVal)

  // ---- Dynasty constellation (generic tree view) --------------------------
  const config: TreeViewConfig = {
    nodes: DYNASTY_NODES,
    nodeIds: DYNASTY_NODE_IDS,
    positions: layoutNodes(DYNASTY_NODES, DYNASTY_NODE_IDS),
    edges: nodeEdges(DYNASTY_NODES, DYNASTY_NODE_IDS),
    categoryLabel: CATEGORY_LABEL,
    categoryHue: CATEGORY_HUE,
    level: (id) => dynastyNodeLevel(ctx.store.state, id),
    available: (id) => dynastyNodeAvailable(ctx.store.state, id),
    // Affordable = buyable right now (prereqs met, not maxed, banked DP covers the cost).
    affordable: (id) => canPurchaseDynasty(ctx.store.state, id).ok,
    costText: (id, level) => formatNumber(dynastyNodeCost(id, level), 0) + ' DP',
    effectText: (id) => {
      const node = DYNASTY_NODES[id]
      return node ? effectText(node) : ''
    },
    purchase: (id) => ctx.onPurchaseDynasty(id),
    currencyEl: () => currencyWrap,
  }
  const tree = buildTreeView(config)
  el.appendChild(tree.el)

  // ---- Reactivity ----------------------------------------------------------
  const update = (): void => {
    const state = ctx.store.state
    const d = state.dynasty
    const points = d ? d.points : 0
    const dynasties = d ? d.dynasties : 0

    dpVal.textContent = formatNumber(points, 0)
    dynastiesVal.textContent = formatNumber(dynasties, 0)
    scoreVal.textContent = formatNumber(dynastyScore(state), 0)
    const pending = pendingDynastyPoints(state)
    pendingVal.textContent = formatNumber(pending, 0) + ' DP'
    // Signature dynasty bonus surfaced as a "+X%" era-point multiplier (dynastyEpMult is 1 + Σ).
    epMultVal.textContent = '+' + pct(dynastyEpMult(state) - 1)
    // The automation gateway state, carried in TEXT (never colour alone — WCAG 1.4.1).
    autoVal.textContent = automationsUnlocked(ctx) ? 'Odblokowane' : 'Zablokowane'
    currencyVal.textContent = formatNumber(points, 0)

    const canStart = pending > 0
    newDynastyBtn.setAttribute('aria-disabled', canStart ? 'false' : 'true')
    newDynastyBtn.textContent = canStart
      ? 'Nowa Dynastia (+' + formatNumber(pending, 0) + ' DP)'
      : 'Nowa Dynastia'
    newDynastyBtn.title = canStart
      ? ''
      : 'Brak dorobku ery do spieniężenia — zdobądź punkty, rozbudowując erę.'
    newDynastyBtn.setAttribute(
      'aria-label',
      canStart
        ? 'Załóż Nową Dynastię i zdobądź ' +
            formatNumber(pending, 0) +
            ' punktów dynastii (resetuje całe konto ery i prestiżu)'
        : 'Nowa Dynastia niedostępna — brak punktów dynastii do zdobycia',
    )

    tree.update()
  }

  update()

  return { el, update }
}
