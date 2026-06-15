import { RESOURCE_IDS, type ResourceId } from '../../engine/state'
import { formatNumber } from '../../engine/format'
import {
  TECH_NODES,
  TECH_NODE_IDS,
  type TechNode,
  type TechEffect,
  type TechCategory,
} from '../../content/tech'
import {
  nodeLevel,
  prerequisitesMet,
  techCost,
  globalResources,
  canPurchaseTech,
} from '../../systems/tech'
import { layoutTree, techEdges } from '../../systems/techLayout'
import type { UiCtx, Panel } from '../types'
import { h, resourceIcon, RESOURCE_NAMES } from '../dom'
import { buildTreeView, type TreeViewConfig } from './treeView'

/**
 * "Rozwój" panel (M3.1 → M4.2) — the global, account-wide PASSIVE TREE rendered as a
 * Path-of-Exile-style radial CONSTELLATION.
 *
 * As of M4.2 this is a THIN adapter over the generic constellation renderer
 * {@link buildTreeView} (panels/treeView.ts): the camera (pan/zoom/wheel/pinch/fit/zoom
 * buttons/ResizeObserver), keyboard navigation (arrow-key cone stepping, Enter/Space,
 * roving tabindex), the legend, the category quick-jump bar, the selection ring and the
 * detail card all live ONCE in the renderer. This module supplies only the TECH-SPECIFIC
 * configuration — the node/edge topology + deterministic layout, the per-category labels
 * and hues, the live state/affordability callbacks, the resource-cost breakdown, the
 * effect text and the GLOBAL resource pool the tree is bought from. Before M4.2 this file
 * carried its own full copy of the renderer; that copy is now deleted, so the tech tree
 * and the prestige tree (panels/prestige.ts) cannot drift apart.
 *
 * What the tech tree adds on top of the generic view:
 *  - the GLOBAL resource pool header (the currency tech is paid in), supplied opaquely
 *    via {@link TreeViewConfig.currencyEl} as a STABLE element the renderer mounts once;
 *  - a PER-RESOURCE next-level cost breakdown ({@link TreeViewConfig.costItems}: one
 *    icon+name+amount chip per resource, with a per-resource shortfall cue against the
 *    pool) instead of a single cost string;
 *  - affordability = the pool covers EVERY resource of the next level.
 *
 * Performance: {@link globalResources} (a sum over every village × resource) is computed
 * ONCE per update — inside {@link TreeViewConfig.currencyEl}, which the renderer calls
 * first on every refresh — and cached, so the per-node affordability cue stays O(nodes)
 * rather than O(nodes × villages).
 *
 * Determinism: a pure VIEW. Positions/edges are derived from the static topology
 * ({@link layoutTree} / {@link techEdges}) and the live `state.tech` levels; it owns no
 * clock and no RNG. Reactivity follows the panel contract: build once, then `update()`
 * pokes the renderer (which pokes the viewBox, per-node state and the detail card).
 */

/** PL display name per category (matches the constellation arms). */
const CATEGORY_LABEL: Record<TechCategory, string> = {
  economy: 'Gospodarka',
  storage: 'Magazyny',
  settlement: 'Osadnictwo',
  military: 'Militaria',
  fortification: 'Fortyfikacje',
  logistics: 'Logistyka',
  plunder: 'Grabież',
  construction: 'Budownictwo',
  training: 'Szkolenie',
}

/**
 * Per-category HUE, as a reference to a design token defined in tokens.css (never a raw
 * hex here). The renderer sets it as the `--cat` custom property on each node, edge and
 * arm label, so an arm has a stable spatial IDENTITY (colour + named label) independent
 * of a node's STATE fill (WCAG 1.4.1: colour is a SECONDARY cue layered on top of shape,
 * label and legend, never the only one).
 */
const CATEGORY_HUE: Record<TechCategory, string> = {
  economy: 'var(--cat-economy)',
  storage: 'var(--cat-storage)',
  settlement: 'var(--cat-settlement)',
  military: 'var(--cat-military)',
  fortification: 'var(--cat-fortification)',
  logistics: 'var(--cat-logistics)',
  plunder: 'var(--cat-plunder)',
  construction: 'var(--cat-construction)',
  training: 'var(--cat-training)',
}

/** A percentage label for a per-level fraction (0.03 -> "3%", 0.012 -> "1.2%"). */
function pct(frac: number): string {
  return formatNumber(frac * 100, 2) + '%'
}

/**
 * True for effects that REDUCE an underlying time/cost (cost/recruit/march). These read
 * with a "−" sign and shrink the value, unlike the additive "+X%" multipliers — so the
 * detail card never claims a reduction is a gain.
 */
function isReduction(effect: TechEffect): boolean {
  return (
    effect.kind === 'cost_reduction' ||
    effect.kind === 'recruit_speed' ||
    effect.kind === 'march_speed'
  )
}

/** What the node's effect *targets*, in PL (the subject of the per-level bonus). */
function effectSubject(node: TechNode): string {
  const effect = node.effect
  switch (effect.kind) {
    case 'production_mult':
      return effect.resource
        ? 'produkcji: ' + RESOURCE_NAMES[effect.resource].toLowerCase()
        : 'produkcji wszystkich surowców'
    case 'storage_mult':
      return 'pojemności magazynu'
    case 'pop_mult':
      return 'limitu populacji'
    case 'cost_reduction':
      return 'kosztu budowy'
    case 'recruit_speed':
      return 'czasu rekrutacji'
    case 'march_speed':
      return 'czasu marszu'
    case 'attack_mult':
      return 'siły ataku armii'
    case 'defense_mult':
      return 'siły obrony armii'
    case 'loot_mult':
      return 'wielkości łupu'
  }
}

/** The leading sign for an effect: "−" for a reduction, "+" for an additive bonus. */
function effectSign(effect: TechEffect): string {
  return isReduction(effect) ? '−' : '+'
}

/** Full "±X% <subject> / poziom" line for the detail card + node aria-label. */
function effectText(node: TechNode): string {
  return effectSign(node.effect) + pct(node.effect.perLevel) + ' ' + effectSubject(node) + ' / poziom'
}

/**
 * Build the "Rozwój" constellation panel by feeding the TECH-SPECIFIC config into the
 * generic {@link buildTreeView} renderer. Reads {@link UiCtx} for the live store and the
 * `onPurchaseTech` commit; every affordability/availability cue comes straight from the
 * shared engine helpers (prerequisitesMet / techCost / globalResources) so what the card
 * shows can never disagree with what a purchase actually does.
 */
export function createTechPanel(ctx: UiCtx): Panel {
  // ---- Global resource pool (the currency tech is bought from) -------------
  // A STABLE element built once and kept up to date by refreshPool(); buildTreeView
  // mounts it into its own currency bar and only re-swaps if a DIFFERENT element is
  // returned (which never happens here), so this is the tree's resource-pool header.
  const pool = h('div', 'tech-pool')
  pool.setAttribute('role', 'note')
  pool.setAttribute('aria-label', 'Wspólna pula surowców wszystkich wiosek')
  pool.appendChild(h('span', 'tech-pool-label muted', 'Wspólna pula:'))
  const poolVals = {} as Record<ResourceId, HTMLElement>
  for (const r of RESOURCE_IDS) {
    const item = h('span', 'tech-pool-item')
    const iconWrap = h('span', 'res-icon-wrap')
    iconWrap.appendChild(resourceIcon(r))
    const val = h('span', 'num tech-pool-val')
    item.appendChild(iconWrap)
    item.appendChild(val)
    item.title = RESOURCE_NAMES[r]
    pool.appendChild(item)
    poolVals[r] = val
  }

  // Cached GLOBAL pool, refreshed at the TOP of every renderer update() via currencyEl
  // (buildTreeView calls currencyEl first on each refresh — build, every poke and the
  // internal post-purchase update). Computing globalResources ONCE per update and caching
  // it keeps the per-node affordability cue O(nodes), never O(nodes × villages): a node is
  // affordable when its next-level cost is covered by this snapshot. The frequently
  // changing pool drives both the header values and the per-resource cost shortfalls.
  let poolRes = globalResources(ctx.store.state)
  const refreshPool = (): void => {
    poolRes = globalResources(ctx.store.state)
    for (const r of RESOURCE_IDS) poolVals[r].textContent = formatNumber(poolRes[r])
  }

  // ---- Tech-specific constellation config ---------------------------------
  const config: TreeViewConfig = {
    nodes: TECH_NODES,
    nodeIds: TECH_NODE_IDS,
    positions: layoutTree(),
    edges: techEdges(),
    categoryLabel: CATEGORY_LABEL,
    categoryHue: CATEGORY_HUE,
    // Tech-specific intro framing: this tree is GLOBAL (account-wide) and bought from the
    // SHARED resource pool of every village — information the generic note omits.
    noteText:
      'Drzewo rozwoju (globalne, na całe konto). Przeciągnij, aby przesunąć, kółkiem lub ' +
      'przyciskami przybliż. Kliknij węzeł, aby zobaczyć jego efekt i koszt — węzły kupujesz ' +
      'ze WSPÓLNEJ puli surowców wszystkich wiosek. Strzałkami przechodzisz między węzłami, ' +
      'Enter wybiera.',
    level: (id) => nodeLevel(ctx.store.state, id),
    // Available = prerequisites met (the renderer only consults this for a not-yet-owned,
    // not-maxed node, so this matches the old stateOf 'available' vs 'locked' split 1:1).
    available: (id) => prerequisitesMet(ctx.store.state, id),
    // Affordable = the cached GLOBAL pool covers EVERY resource of the next level.
    affordable: (id) => {
      const cost = techCost(id, nodeLevel(ctx.store.state, id))
      for (const r of RESOURCE_IDS) {
        if (poolRes[r].lt(cost[r])) return false
      }
      return true
    },
    // Concise fallback (the per-resource costItems below always takes priority for tech).
    costText: (id, level) => {
      const cost = techCost(id, level)
      return RESOURCE_IDS.map((r) => formatNumber(cost[r])).join(' / ')
    },
    // PER-RESOURCE next-level cost: one icon+name+amount chip per resource; `short` flags
    // a shortfall against the cached pool (the renderer renders it as colour PLUS a text
    // title — never colour alone). icon is an opaque Node the renderer just mounts.
    costItems: (id, level) => {
      const cost = techCost(id, level)
      return RESOURCE_IDS.map((r) => ({
        icon: resourceIcon(r),
        label: RESOURCE_NAMES[r],
        value: formatNumber(cost[r]),
        short: poolRes[r].lt(cost[r]),
      }))
    },
    effectText: (id) => {
      const node = TECH_NODES[id]
      return node ? effectText(node) : ''
    },
    // CURRENT cumulative bonus for the detail card: the per-level effect × owned level
    // (e.g. "Obecny łączny bonus: +9%"), or a not-yet-bought note for an unowned node.
    bonusText: (id) => {
      const node = TECH_NODES[id]
      if (!node) return ''
      const lvl = nodeLevel(ctx.store.state, id)
      return lvl > 0
        ? 'Obecny łączny bonus: ' + effectSign(node.effect) + pct(node.effect.perLevel * lvl)
        : 'Jeszcze nie wykupiony.'
    },
    purchase: (id) => ctx.onPurchaseTech(id),
    // Route the engine's own rejection reason ('Poziom maksymalny' / 'Wymagania
    // niespełnione' / 'Za mało surowców') to the buy-button tooltip + aria-live status, so
    // what a screen-reader hears matches canPurchaseTech 1:1.
    reason: (id) => canPurchaseTech(ctx.store.state, id).reason,
    // Refresh the cached pool + header values, then hand back the STABLE element. The
    // renderer calls this first on every update, so affordability/cost reads below always
    // see the current pool regardless of whether the refresh was triggered by the host or
    // by the renderer's own post-purchase update.
    currencyEl: () => {
      refreshPool()
      return pool
    },
  }

  const tree = buildTreeView(config)

  // Panel contract: build once (done above), then poke. tree.update() refreshes the pool
  // (via currencyEl) and the whole constellation; the host calls this on each store rev.
  const update = (): void => {
    tree.update()
  }

  return { el: tree.el, update }
}
