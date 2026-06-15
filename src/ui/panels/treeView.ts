import type { NodePos } from '../../systems/techLayout'
import type { Panel } from '../types'
import { h, svg, SVG_NS } from '../dom'

/**
 * Generic Path-of-Exile-style CONSTELLATION renderer (M4.1).
 *
 * This is the reusable, data-agnostic twin of {@link createTechPanel}: it draws ANY
 * radial passive tree — the tech tree, the prestige tree, anything future — as a
 * pan/zoom SVG whose node positions and links are HANDED IN (already computed by the
 * deterministic radial layout in systems/techLayout: layoutNodes / nodeEdges) and
 * whose every state/affordance/cost/effect/commit comes from the {@link TreeViewConfig}
 * callbacks. The renderer owns ONLY geometry + behaviour; it never imports content or
 * systems modules, so the same view serves trees paid in resources (tech) or in
 * prestige points (prestige) without change.
 *
 * Parity with panels/tech.ts (the authoring reference): identical camera (viewBox
 * pan/zoom, wheel, one-finger pan past a threshold, two-finger pinch, fit/zoom
 * buttons, ResizeObserver), identical accessibility (every node is a focusable
 * role=button with arrow-key cone navigation + Enter/Space; a roving tabindex keeps
 * exactly one node tabbable; per-category role=group subgroups; an on-screen legend
 * and category quick-jump bar; state is carried by SHAPE + OUTLINE + aria text, never
 * colour alone — WCAG 1.4.1), and the same build-once / poke-on-update contract
 * (update() never rebuilds the tree; it pokes the viewBox, per-node state classes/
 * labels only when a node's state changes, the selection ring and the detail card).
 *
 * Differences from the tech panel (because this is generic):
 *  - The "currency" header is an opaque element supplied by {@link TreeViewConfig.currencyEl}
 *    (the tech pool of resources, or a prestige-points readout) — the view just mounts
 *    and refreshes it.
 *  - Cost is a single {@link TreeViewConfig.costText} string and effect a single
 *    {@link TreeViewConfig.effectText} string, so the view needs no knowledge of the
 *    effect/cost shape.
 *  - Node state derives from the supplied {@link TreeViewConfig.level} /
 *    {@link TreeViewConfig.available} / {@link TreeViewConfig.affordable} callbacks,
 *    and a purchase commits through {@link TreeViewConfig.purchase}.
 *
 * Determinism: a pure VIEW. It owns no clock and no RNG (pan/zoom are ephemeral camera
 * state, never persisted). Positions/edges are inputs; live state is read only through
 * the config callbacks.
 *
 * Styling: reuses the existing `.tech-*` design-system classes (so a tree renders with
 * the same chrome as the tech constellation with zero new CSS), plus a `tree-view`
 * root hook for any per-tree tweaks. The hard rules hold: zero external assets, all
 * markup built with createElement / createElementNS (no innerHTML with data), all
 * colour from tokens (the per-arm hue is whatever token string the caller supplies via
 * {@link TreeViewConfig.categoryHue}).
 */

/** Default viewBox aspect (h/w) used before the element has been measured. */
const DEFAULT_ASPECT = 0.62
/** Multiplicative zoom per wheel notch / button press. */
const ZOOM_STEP = 1.2
/** Pixels of pointer travel that turn a click into a pan (so a tap still selects). */
const PAN_THRESHOLD = 4
/** Target on-screen diameter (px) for a node's transparent hit area (touch). */
const HIT_TARGET_PX = 44

/** The minimal per-node shape the renderer reads (no `id` — that is the Record key). */
export interface TreeViewNode {
  name: string
  desc: string
  category: string
  archetype: string
  maxLevel: number
  prerequisites: string[]
}

/**
 * Everything {@link buildTreeView} needs to render and drive ANY constellation. The
 * topology (`nodes` / `nodeIds`), its deterministic geometry (`positions` / `edges`)
 * and its per-arm presentation (`categoryLabel` / `categoryHue`) are inputs; the live
 * state and the commit are CALLBACKS so the view stays agnostic of which tree (tech or
 * prestige) and which currency it is showing.
 */
export interface TreeViewConfig {
  /** All nodes, keyed by id (the key IS the node id; {@link TreeViewNode} carries no id). */
  nodes: Record<string, TreeViewNode>
  /** Stable id order (drives every deterministic iteration: groups, jump bar, tabbing). */
  nodeIds: readonly string[]
  /** Deterministic radial position per id (from systems/techLayout.layoutNodes). */
  positions: Record<string, NodePos>
  /** One (prerequisite → dependent) link per pair (from systems/techLayout.nodeEdges). */
  edges: Array<{ from: string; to: string }>
  /** PL display name per category key (falls back to the raw key when missing). */
  categoryLabel: Record<string, string>
  /** Hue token string per category key (e.g. 'var(--cat-might)'); falls back to muted. */
  categoryHue: Record<string, string>
  /** Current purchased level of a node (0..maxLevel). */
  level: (id: string) => number
  /** True when a node's prerequisites are met (buyable if not maxed). */
  available: (id: string) => boolean
  /** True when the player can currently afford this node's next level. */
  affordable: (id: string) => boolean
  /** Human cost string for the NEXT level (currency-specific; e.g. "12 PP"). */
  costText: (id: string, level: number) => string
  /** Human effect string (per level), for the detail card + aria-label. */
  effectText: (id: string) => string
  /** Commit the purchase of a node's next level; returns true on success. */
  purchase: (id: string) => boolean
  /** The currency header element (resource pool, prestige points …) shown atop the tree. */
  currencyEl: () => HTMLElement
}

/** The four mutually-exclusive node states (level + prerequisite derived). */
type NodeState = 'locked' | 'available' | 'owned' | 'maxed'

/** Normalised archetype (anything unrecognised renders as a 'minor' dot). */
type Archetype = 'minor' | 'notable' | 'gateway'

/** Cached handles for one rendered node. */
interface NodeRefs {
  id: string
  g: SVGGElement
  shape: SVGElement
  hit: SVGCircleElement
  pos: NodePos
  /** Visible radius in LAYOUT units (drives the hit floor + selection ring). */
  radius: number
  archetype: Archetype
  category: string
  /** Signature of the last DOM-applied state, so update() only writes on change. */
  lastKey: string
}

/** Cached handles for one rendered prerequisite link. */
interface EdgeRefs {
  line: SVGElement
  from: string
}

/** PL display name per archetype (carried in the node aria-label + detail card). */
const ARCHETYPE_LABEL: Record<Archetype, string> = {
  minor: 'drobny węzeł',
  notable: 'węzeł znaczący',
  gateway: 'brama',
}

/** PL display name per state (aria-label + legend; the non-colour state cue in text). */
const STATE_LABEL: Record<NodeState, string> = {
  locked: 'zablokowany',
  available: 'dostępny',
  owned: 'wykupiony',
  maxed: 'maksymalny',
}

/** Round to 2dp for compact, stable viewBox / geometry strings. */
function fmt2(n: number): string {
  return (Math.round(n * 100) / 100).toString()
}

/** Clamp a fraction to [0, 1] (used to map an on-screen rect into viewBox fractions). */
function clamp01(n: number): number {
  return n < 0 ? 0 : n > 1 ? 1 : n
}

/** Normalise an arbitrary archetype string into the three drawable shapes. */
function archetypeOf(raw: string): Archetype {
  return raw === 'gateway' ? 'gateway' : raw === 'notable' ? 'notable' : 'minor'
}

/** Diamond polygon points (gateway glyph) centred on (cx, cy) with "radius" r. */
function diamond(cx: number, cy: number, r: number): string {
  return `${fmt2(cx)},${fmt2(cy - r)} ${fmt2(cx + r)},${fmt2(cy)} ${fmt2(cx)},${fmt2(cy + r)} ${fmt2(cx - r)},${fmt2(cy)}`
}

/**
 * Build a constellation panel for the tree described by `config`. Returns the standard
 * {@link Panel} ({ el, update }); the host (e.g. the prestige panel) embeds `el` and
 * forwards `update()`. All affordability/availability cues come straight from the
 * config callbacks, so what the detail card shows can never disagree with what a
 * purchase actually does.
 */
export function buildTreeView(config: TreeViewConfig): Panel {
  const el = h('div', 'tech-panel tree-view')

  // Narrow-viewport probe (mirrors the CSS breakpoint). Pure VIEW state — used to
  // avoid auto-opening the detail sheet over a short mobile constellation.
  const narrowMql =
    typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia('(max-width: 639.98px)')
      : null
  const isNarrow = (): boolean => (narrowMql ? narrowMql.matches : false)

  // ---- Topology helpers (config is the single source of truth) -------------
  const nodeOf = (id: string): TreeViewNode | undefined => config.nodes[id]
  const catLabel = (c: string): string => config.categoryLabel[c] ?? c
  const catHue = (c: string): string => config.categoryHue[c] ?? 'var(--muted)'

  const positions = config.positions
  // Ids that actually got a position (defensive: layout owns every id, but never crash
  // the whole tab if one is missing — just skip it).
  const placedIds = config.nodeIds.filter((id) => positions[id] && config.nodes[id])
  // Prereq-free roots (the natural entry/anchor per arm + the first-open auto-select).
  const roots = placedIds.filter((id) => config.nodes[id].prerequisites.length === 0)

  // Categories in first-appearance order (stable arm assignment / legend / jump bar).
  const categories: string[] = []
  for (const id of placedIds) {
    const c = config.nodes[id].category
    if (!categories.includes(c)) categories.push(c)
  }

  // Per-category ANCHOR node — the camera target for the quick-jump bar and the
  // position of the on-canvas arm label. Prefer the arm's prereq-free root; fall back
  // to the first placed node of that category. Deterministic (stable nodeIds order).
  const categoryAnchor: Record<string, string> = {}
  for (const id of roots) {
    const c = config.nodes[id].category
    if (categoryAnchor[c] === undefined) categoryAnchor[c] = id
  }
  for (const id of placedIds) {
    const c = config.nodes[id].category
    if (categoryAnchor[c] === undefined) categoryAnchor[c] = id
  }

  // Bounding box of the constellation (for the initial frame + pan clamps).
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const id of placedIds) {
    const p = positions[id]
    if (p.x < minX) minX = p.x
    if (p.x > maxX) maxX = p.x
    if (p.y < minY) minY = p.y
    if (p.y > maxY) maxY = p.y
  }
  if (!Number.isFinite(minX)) {
    minX = 0
    minY = 0
    maxX = 0
    maxY = 0
  }
  const contentW = Math.max(1e-6, maxX - minX)
  const contentH = Math.max(1e-6, maxY - minY)
  const centerX = (minX + maxX) / 2
  const centerY = (minY + maxY) / 2

  // Characteristic spacing = the tightest gap between any two nodes. Node radii are
  // sized as a fraction of it so two adjacent nodes can never visually overlap,
  // independent of the layout's coordinate scale.
  let unit = Infinity
  for (let i = 0; i < placedIds.length; i++) {
    const a = positions[placedIds[i]]
    for (let j = i + 1; j < placedIds.length; j++) {
      const b = positions[placedIds[j]]
      const d = Math.hypot(a.x - b.x, a.y - b.y)
      if (d > 0 && d < unit) unit = d
    }
  }
  if (!Number.isFinite(unit) || unit <= 0) {
    unit = Math.max(contentW, contentH) / Math.max(1, placedIds.length) || 1
  }

  const radiusFor = (a: Archetype): number =>
    a === 'gateway' ? unit * 0.46 : a === 'notable' ? unit * 0.36 : unit * 0.26
  const maxRadius = unit * 0.46

  // ---- Camera bounds (ephemeral; never persisted) -------------------------
  const fitBase = Math.max(contentW, contentH) + maxRadius * 2 + unit
  const MIN_VIEW_W = Math.max(unit * 2.5, fitBase / 60)
  const MAX_VIEW_W = fitBase * 2.5
  const PAD = Math.max(unit * 4, maxRadius * 3)
  const clampViewW = (w: number): number => Math.max(MIN_VIEW_W, Math.min(MAX_VIEW_W, w))
  const clampCx = (c: number): number => Math.max(minX - PAD, Math.min(maxX + PAD, c))
  const clampCy = (c: number): number => Math.max(minY - PAD, Math.min(maxY + PAD, c))

  let viewCx = centerX
  let viewCy = centerY
  let viewW = clampViewW(
    Math.max(contentW + maxRadius * 2 + unit, (contentH + maxRadius * 2 + unit) / DEFAULT_ASPECT),
  )
  let viewH = viewW * DEFAULT_ASPECT

  // ---- Intro note + state legend ------------------------------------------
  const note = h(
    'p',
    'tech-note muted',
    'Konstelacja. Przeciągnij, aby przesunąć, kółkiem lub przyciskami przybliż. Kliknij ' +
      'węzeł, aby zobaczyć efekt i koszt. Strzałkami przechodzisz między węzłami, Enter wybiera.',
  )
  note.setAttribute('role', 'note')
  el.appendChild(note)

  const legend = h('div', 'tech-legend')
  legend.setAttribute('role', 'note')
  const addLegend = (cls: string, label: string): void => {
    const item = h('span', 'tech-legend-item')
    const sw = h('span', 'tech-legend-swatch ' + cls)
    sw.setAttribute('aria-hidden', 'true')
    item.appendChild(sw)
    item.appendChild(document.createTextNode(' ' + label))
    legend.appendChild(item)
  }
  addLegend('is-locked', 'Zablokowany (brak wymagań)')
  addLegend('is-available', 'Dostępny (można kupić)')
  addLegend('is-owned', 'Wykupiony')
  addLegend('is-maxed', 'Maksymalny')
  // Archetype shape key (the in-canvas shape language: dot / ring / diamond).
  addLegend('is-minor', 'Drobny węzeł (kropka)')
  addLegend('is-notable', 'Węzeł znaczący (pierścień)')
  addLegend('is-gateway', 'Brama (romb, większy)')
  el.appendChild(legend)

  // Category colour key — one swatch per arm, hue from the category's `--cat` token so
  // the legend and the constellation agree.
  if (categories.length > 0) {
    const catLegend = h('div', 'tech-legend tech-legend--cat')
    catLegend.setAttribute('role', 'note')
    catLegend.setAttribute('aria-label', 'Legenda kategorii (gałęzi) drzewa')
    for (const cat of categories) {
      const item = h('span', 'tech-legend-item')
      const sw = h('span', 'tech-legend-swatch is-cat')
      sw.style.setProperty('--cat', catHue(cat))
      sw.setAttribute('aria-hidden', 'true')
      item.appendChild(sw)
      item.appendChild(document.createTextNode(' ' + catLabel(cat)))
      catLegend.appendChild(item)
    }
    el.appendChild(catLegend)
  }

  // ---- Currency header (the pool / point readout tree is bought from) ------
  // Supplied opaquely by the caller. We mount it once and, on update(), swap it only
  // if the caller hands back a different element (supports both a self-updating element
  // and a fresh-per-call one).
  const currencyBar = h('div', 'tech-pool tree-currency')
  currencyBar.setAttribute('role', 'note')
  let currencyNode: HTMLElement | null = null
  const mountCurrency = (): void => {
    const next = config.currencyEl()
    if (next === currencyNode) return
    if (currencyNode && currencyNode.parentNode === currencyBar) currencyBar.removeChild(currencyNode)
    currencyBar.appendChild(next)
    currencyNode = next
  }
  mountCurrency()
  el.appendChild(currencyBar)

  // ---- Category quick-jump bar --------------------------------------------
  if (categories.length > 0) {
    const jumpBar = h('nav', 'tech-jump')
    jumpBar.setAttribute('aria-label', 'Skok do gałęzi drzewa')
    for (const cat of categories) {
      const anchor = categoryAnchor[cat]
      if (!anchor) continue
      const btn = h('button', 'btn btn-ghost tech-jump-btn')
      btn.type = 'button'
      const sw = h('span', 'tech-jump-swatch')
      sw.style.setProperty('--cat', catHue(cat))
      sw.setAttribute('aria-hidden', 'true')
      btn.appendChild(sw)
      btn.appendChild(document.createTextNode(catLabel(cat)))
      btn.setAttribute('aria-label', 'Przejdź do gałęzi: ' + catLabel(cat))
      btn.addEventListener('click', () => selectAndReveal(anchor, true))
      jumpBar.appendChild(btn)
    }
    el.appendChild(jumpBar)
  }

  // ---- Constellation viewport (SVG) + overlay controls --------------------
  const wrap = h('div', 'tech-wrap')

  const svgEl = document.createElementNS(SVG_NS, 'svg') as SVGSVGElement
  svgEl.setAttribute('class', 'tech-svg')
  svgEl.setAttribute('width', '100%')
  svgEl.setAttribute('height', '100%')
  svgEl.setAttribute('preserveAspectRatio', 'xMidYMid meet')
  svgEl.setAttribute('role', 'group')
  svgEl.setAttribute(
    'aria-label',
    'Konstelacja drzewa. Węzły są przyciskami: strzałki przechodzą między nimi, Enter ' +
      'wybiera, a panel szczegółów pozwala je wykupić.',
  )
  wrap.appendChild(svgEl)

  // Drawing layers, back-to-front: edges, nodes, arm labels, overlay (selection ring).
  const edgesGroup = document.createElementNS(SVG_NS, 'g') as SVGGElement
  edgesGroup.setAttribute('class', 'tech-edges')
  edgesGroup.setAttribute('aria-hidden', 'true')
  const nodesGroup = document.createElementNS(SVG_NS, 'g') as SVGGElement
  nodesGroup.setAttribute('class', 'tech-nodes')
  // Per-category SUBGROUPS (a11y): each arm is a role=group with its name, so a
  // screen-reader user traversing the nodes always has arm context.
  const catGroups: Record<string, SVGGElement> = {}
  for (const cat of categories) {
    const cg = document.createElementNS(SVG_NS, 'g') as SVGGElement
    cg.setAttribute('class', 'tech-cat-group')
    cg.setAttribute('role', 'group')
    cg.setAttribute('aria-label', 'Gałąź: ' + catLabel(cat))
    nodesGroup.appendChild(cg)
    catGroups[cat] = cg
  }
  // On-canvas arm labels — one named, hue-tinted <text> per arm at its anchor, pushed
  // radially outward from the hub so each sector is named on the constellation itself.
  const labelsGroup = document.createElementNS(SVG_NS, 'g') as SVGGElement
  labelsGroup.setAttribute('class', 'tech-arm-labels')
  labelsGroup.setAttribute('aria-hidden', 'true')
  for (const cat of categories) {
    const aid = categoryAnchor[cat]
    if (!aid) continue
    const p = positions[aid]
    const dx = p.x - centerX
    const dy = p.y - centerY
    const len = Math.hypot(dx, dy) || 1
    const off = unit * 1.6
    const t = svg('text', {
      x: fmt2(p.x + (dx / len) * off),
      y: fmt2(p.y + (dy / len) * off),
      class: 'tech-arm-label',
    })
    t.setAttribute('text-anchor', 'middle')
    t.setAttribute('font-size', fmt2(Math.max(unit * 0.8, 1e-3)))
    t.style.setProperty('--cat', catHue(cat))
    t.textContent = catLabel(cat)
    labelsGroup.appendChild(t)
  }
  const overlayGroup = document.createElementNS(SVG_NS, 'g') as SVGGElement
  overlayGroup.setAttribute('class', 'tech-overlay')
  overlayGroup.setAttribute('aria-hidden', 'true')

  const selRing = svg('circle', { class: 'tech-sel-ring', r: '0', fill: 'none' })
  selRing.setAttribute('vector-effect', 'non-scaling-stroke')
  selRing.style.display = 'none'
  overlayGroup.appendChild(selRing)

  svgEl.appendChild(edgesGroup)
  svgEl.appendChild(nodesGroup)
  svgEl.appendChild(labelsGroup)
  svgEl.appendChild(overlayGroup)

  const controls = h('div', 'tech-controls')
  const zoomOutBtn = h('button', 'btn btn-ghost tech-zoom-btn', '−')
  zoomOutBtn.type = 'button'
  zoomOutBtn.setAttribute('aria-label', 'Oddal drzewo')
  const zoomInBtn = h('button', 'btn btn-ghost tech-zoom-btn', '+')
  zoomInBtn.type = 'button'
  zoomInBtn.setAttribute('aria-label', 'Przybliż drzewo')
  const fitBtn = h('button', 'btn btn-ghost tech-fit-btn', 'Wycentruj')
  fitBtn.type = 'button'
  fitBtn.setAttribute('aria-label', 'Wycentruj i pokaż całe drzewo')
  controls.appendChild(zoomOutBtn)
  controls.appendChild(zoomInBtn)
  controls.appendChild(fitBtn)
  wrap.appendChild(controls)
  el.appendChild(wrap)

  // ---- Camera plumbing (mirrors the tech constellation / world map) -------
  const currentAspect = (): number => {
    const w = svgEl.clientWidth
    const hh = svgEl.clientHeight
    return w > 0 && hh > 0 ? hh / w : DEFAULT_ASPECT
  }
  const applyView = (): void => {
    viewH = viewW * currentAspect()
    const x = viewCx - viewW / 2
    const y = viewCy - viewH / 2
    svgEl.setAttribute('viewBox', `${fmt2(x)} ${fmt2(y)} ${fmt2(viewW)} ${fmt2(viewH)}`)
  }
  const zoomBy = (factor: number, fx: number, fy: number): void => {
    const aspect = currentAspect()
    const curH = viewW * aspect
    const wpx = viewCx - viewW / 2 + fx * viewW
    const wpy = viewCy - curH / 2 + fy * curH
    const newW = clampViewW(viewW * factor)
    const newH = newW * aspect
    viewCx = clampCx(wpx + newW * (0.5 - fx))
    viewCy = clampCy(wpy + newH * (0.5 - fy))
    viewW = newW
    applyView()
    updateHitRadii()
  }
  /** Frame the whole tree (and reset the pan) — the "Wycentruj" action. */
  const fitView = (): void => {
    const aspect = currentAspect()
    const padW = contentW + maxRadius * 2 + unit
    const padH = contentH + maxRadius * 2 + unit
    viewW = clampViewW(Math.max(padW, padH / aspect))
    viewCx = clampCx(centerX)
    viewCy = clampCy(centerY)
    applyView()
    updateHitRadii()
  }

  zoomInBtn.addEventListener('click', () => zoomBy(1 / ZOOM_STEP, 0.5, 0.5))
  zoomOutBtn.addEventListener('click', () => zoomBy(ZOOM_STEP, 0.5, 0.5))
  fitBtn.addEventListener('click', () => fitView())

  svgEl.addEventListener(
    'wheel',
    (e: WheelEvent) => {
      e.preventDefault()
      const rect = svgEl.getBoundingClientRect()
      if (rect.width <= 0 || rect.height <= 0) return
      const fx = (e.clientX - rect.left) / rect.width
      const fy = (e.clientY - rect.top) / rect.height
      zoomBy(e.deltaY < 0 ? 1 / ZOOM_STEP : ZOOM_STEP, fx, fy)
    },
    { passive: false },
  )

  // Pointer gestures: one finger/button = pan (capture only past the threshold so a
  // tap still selects), two fingers = pinch-zoom about their midpoint.
  const pointers = new Map<number, { x: number; y: number }>()
  let panActive = false
  let suppressClick = false
  let startClientX = 0
  let startClientY = 0
  let startCx = 0
  let startCy = 0
  let pinchActive = false
  let pinchStartDist = 1
  let pinchStartW = viewW

  const pointerList = (): { x: number; y: number }[] => Array.from(pointers.values())
  const fractionOf = (clientX: number, clientY: number): { fx: number; fy: number } => {
    const rect = svgEl.getBoundingClientRect()
    if (rect.width <= 0 || rect.height <= 0) return { fx: 0.5, fy: 0.5 }
    return { fx: (clientX - rect.left) / rect.width, fy: (clientY - rect.top) / rect.height }
  }
  const beginPanFrom = (clientX: number, clientY: number): void => {
    panActive = false
    startClientX = clientX
    startClientY = clientY
    startCx = viewCx
    startCy = viewCy
  }

  svgEl.addEventListener('pointerdown', (e: PointerEvent) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY })
    if (pointers.size === 1) {
      suppressClick = false
      beginPanFrom(e.clientX, e.clientY)
    } else if (pointers.size === 2) {
      panActive = false
      pinchActive = true
      suppressClick = true
      svgEl.classList.remove('is-panning')
      const pts = pointerList()
      pinchStartDist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y) || 1
      pinchStartW = viewW
      try {
        svgEl.setPointerCapture(e.pointerId)
      } catch {
        /* capture unsupported */
      }
    }
  })

  svgEl.addEventListener('pointermove', (e: PointerEvent) => {
    const p = pointers.get(e.pointerId)
    if (!p) return
    p.x = e.clientX
    p.y = e.clientY

    if (pinchActive && pointers.size >= 2) {
      const pts = pointerList()
      const dist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y) || 1
      const { fx, fy } = fractionOf((pts[0].x + pts[1].x) / 2, (pts[0].y + pts[1].y) / 2)
      const desiredW = clampViewW(pinchStartW * (pinchStartDist / dist))
      if (viewW !== 0) zoomBy(desiredW / viewW, fx, fy)
      return
    }

    if (pointers.size !== 1) return
    const dxpx = e.clientX - startClientX
    const dypx = e.clientY - startClientY
    if (!panActive) {
      if (Math.hypot(dxpx, dypx) <= PAN_THRESHOLD) return
      panActive = true
      svgEl.classList.add('is-panning')
      try {
        svgEl.setPointerCapture(e.pointerId)
      } catch {
        /* capture unsupported — pan still works */
      }
    }
    const rect = svgEl.getBoundingClientRect()
    if (rect.width <= 0 || rect.height <= 0) return
    viewCx = clampCx(startCx - (dxpx * viewW) / rect.width)
    viewCy = clampCy(startCy - (dypx * viewH) / rect.height)
    applyView()
  })

  const endPointer = (e: PointerEvent): void => {
    if (!pointers.has(e.pointerId)) return
    pointers.delete(e.pointerId)
    try {
      svgEl.releasePointerCapture(e.pointerId)
    } catch {
      /* nothing captured */
    }
    if (panActive) {
      suppressClick = true
      panActive = false
      svgEl.classList.remove('is-panning')
    }
    if (pinchActive && pointers.size < 2) {
      pinchActive = false
      suppressClick = true
      const rest = pointerList()[0]
      if (rest) beginPanFrom(rest.x, rest.y)
    }
  }
  svgEl.addEventListener('pointerup', endPointer)
  svgEl.addEventListener('pointercancel', endPointer)

  if (typeof ResizeObserver !== 'undefined') {
    const ro = new ResizeObserver(() => {
      applyView()
      updateHitRadii()
    })
    ro.observe(svgEl)
  }

  // ---- Selection state -----------------------------------------------------
  let selectedId: string | null = null
  const select = (id: string): void => {
    if (suppressClick) {
      suppressClick = false
      return
    }
    selectedId = id
    update()
  }

  // ---- Edges ---------------------------------------------------------------
  const edgeRefs: EdgeRefs[] = []
  for (const e of config.edges) {
    const a = positions[e.from]
    const b = positions[e.to]
    const dst = nodeOf(e.to)
    if (!a || !b || !dst) continue
    const line = svg('line', {
      x1: fmt2(a.x),
      y1: fmt2(a.y),
      x2: fmt2(b.x),
      y2: fmt2(b.y),
      class: 'tech-edge',
    })
    line.setAttribute('vector-effect', 'non-scaling-stroke')
    // Tint the link by the arm it leads INTO (the dependent node's category); the
    // unlocked emphasis is brightness/width (set in update()).
    line.style.setProperty('--cat', catHue(dst.category))
    edgesGroup.appendChild(line)
    edgeRefs.push({ line, from: e.from })
  }

  // ---- Nodes ---------------------------------------------------------------
  const nodeRefs: NodeRefs[] = []
  for (const id of placedIds) {
    const node = config.nodes[id]
    const p = positions[id]
    const arch = archetypeOf(node.archetype)
    const r = radiusFor(arch)

    const g = document.createElementNS(SVG_NS, 'g') as SVGGElement
    g.setAttribute('class', 'tech-node tech-node--' + arch)
    g.setAttribute('role', 'button')
    // Roving tabindex: only the selected / first node is tabbable (set in update()).
    g.setAttribute('tabindex', '-1')
    // Arm IDENTITY: expose the category hue as `--cat` (the state fill stays untouched).
    g.style.setProperty('--cat', catHue(node.category))

    // Transparent, screen-sized hit circle FIRST (under the glyph) so taps meet the
    // touch-target minimum without enlarging the visible glyph. Radius via updateHitRadii.
    const hit = svg('circle', {
      cx: fmt2(p.x),
      cy: fmt2(p.y),
      r: fmt2(r * 2),
      class: 'tech-node-hit',
    }) as SVGCircleElement
    hit.style.fill = 'transparent'
    hit.style.stroke = 'none'
    hit.style.pointerEvents = 'all'
    g.appendChild(hit)

    // Outer CATEGORY ring (drawn under the state glyph) so its hue peeks out as a halo.
    const catRing = svg('circle', {
      cx: fmt2(p.x),
      cy: fmt2(p.y),
      r: fmt2(r + unit * 0.12),
      class: 'tech-node-cat',
    })
    catRing.setAttribute('vector-effect', 'non-scaling-stroke')
    g.appendChild(catRing)

    // Visible glyph: diamond for a gateway (shape cue), circle otherwise.
    let shape: SVGElement
    if (arch === 'gateway') {
      shape = svg('polygon', { points: diamond(p.x, p.y, r), class: 'tech-node-shape' })
    } else {
      shape = svg('circle', {
        cx: fmt2(p.x),
        cy: fmt2(p.y),
        r: fmt2(r),
        class: 'tech-node-shape',
      })
    }
    shape.setAttribute('vector-effect', 'non-scaling-stroke')
    g.appendChild(shape)

    // A notable gets a hollow core (a ring), a second shape cue distinct from a minor.
    if (arch === 'notable') {
      const core = svg('circle', {
        cx: fmt2(p.x),
        cy: fmt2(p.y),
        r: fmt2(r * 0.42),
        class: 'tech-node-core',
      })
      core.setAttribute('vector-effect', 'non-scaling-stroke')
      g.appendChild(core)
    }

    const title = document.createElementNS(SVG_NS, 'title')
    title.textContent = node.name
    g.appendChild(title)

    g.addEventListener('click', () => select(id))
    g.addEventListener('keydown', (ev: KeyboardEvent) => {
      if (ev.key === 'Enter' || ev.key === ' ' || ev.key === 'Spacebar') {
        ev.preventDefault()
        selectAndReveal(id, false)
        return
      }
      let dx = 0
      let dy = 0
      switch (ev.key) {
        case 'ArrowRight':
          dx = 1
          break
        case 'ArrowLeft':
          dx = -1
          break
        case 'ArrowUp':
          dy = -1
          break
        case 'ArrowDown':
          dy = 1
          break
        default:
          return
      }
      ev.preventDefault()
      const next = nearestInDirection(id, dx, dy)
      if (next) selectAndReveal(next, true)
    })

    ;(catGroups[node.category] ?? nodesGroup).appendChild(g)
    nodeRefs.push({
      id,
      g,
      shape,
      hit,
      pos: p,
      radius: r,
      archetype: arch,
      category: node.category,
      lastKey: '',
    })
  }
  const refById = new Map<string, NodeRefs>()
  for (const ref of nodeRefs) refById.set(ref.id, ref)

  /** Resize each node's transparent hit circle to stay ~HIT_TARGET_PX wide on screen. */
  function updateHitRadii(): void {
    const w = svgEl.clientWidth
    if (w <= 0) return
    const worldPerPx = viewW / w
    const target = (HIT_TARGET_PX / 2) * worldPerPx
    for (const ref of nodeRefs) {
      ref.hit.setAttribute('r', fmt2(Math.max(ref.radius, Math.min(target, maxRadius * 6))))
    }
  }

  /** Move keyboard focus to a node by id (roving tabindex keeps one tabbable). */
  const focusNode = (id: string): void => {
    const ref = refById.get(id)
    if (ref) ref.g.focus()
  }
  /**
   * Pan the minimum needed so `p` sits comfortably inside the viewBox AND clears the
   * opaque detail card (WCAG 2.2 SC 2.4.11 — Focus Not Obscured).
   */
  const ensureVisible = (p: NodePos): void => {
    let fxLo = 0.075
    let fxHi = 0.925
    let fyLo = 0.075
    let fyHi = 0.925

    if (selectedId !== null) {
      const svgRect = svgEl.getBoundingClientRect()
      const cardRect = detail.getBoundingClientRect()
      if (svgRect.width > 0 && svgRect.height > 0 && cardRect.width > 0 && cardRect.height > 0) {
        const m = 0.06 // fractional gap kept between the node and the card edge
        const left = clamp01((cardRect.left - svgRect.left) / svgRect.width)
        const right = clamp01((cardRect.right - svgRect.left) / svgRect.width)
        const top = clamp01((cardRect.top - svgRect.top) / svgRect.height)
        const bottom = clamp01((cardRect.bottom - svgRect.top) / svgRect.height)
        if ((top + bottom) / 2 >= 0.5) fyHi = Math.min(fyHi, top - m)
        else fyLo = Math.max(fyLo, bottom + m)
        if (right - left < 0.85) {
          if ((left + right) / 2 < 0.5) fxLo = Math.max(fxLo, right + m)
          else fxHi = Math.min(fxHi, left - m)
        }
        if (fyHi <= fyLo) {
          fyLo = fyHi = clamp01(
            (top + bottom) / 2 >= 0.5 ? Math.max(0.05, top - m) : Math.min(0.95, bottom + m),
          )
        }
        if (fxHi <= fxLo) {
          fxLo = fxHi = clamp01(
            (left + right) / 2 < 0.5 ? Math.min(0.95, right + m) : Math.max(0.05, left - m),
          )
        }
      }
    }

    const fxCur = (p.x - viewCx) / viewW + 0.5
    const fyCur = (p.y - viewCy) / viewH + 0.5
    let moved = false
    if (fxCur < fxLo) {
      viewCx = clampCx(p.x + viewW * (0.5 - fxLo))
      moved = true
    } else if (fxCur > fxHi) {
      viewCx = clampCx(p.x + viewW * (0.5 - fxHi))
      moved = true
    }
    if (fyCur < fyLo) {
      viewCy = clampCy(p.y + viewH * (0.5 - fyLo))
      moved = true
    } else if (fyCur > fyHi) {
      viewCy = clampCy(p.y + viewH * (0.5 - fyHi))
      moved = true
    }
    if (moved) applyView()
  }
  /** Select a node by id, keep it on screen, refresh; optionally move focus to it. */
  const selectAndReveal = (id: string, focus: boolean): void => {
    selectedId = id
    const p = positions[id]
    if (p) ensureVisible(p)
    update()
    if (focus) focusNode(id)
  }
  /** Nearest node from `fromId` inside a 90° cone toward screen direction (dx, dy). */
  const nearestInDirection = (fromId: string, dx: number, dy: number): string | undefined => {
    const from = positions[fromId]
    if (!from) return undefined
    let best: string | undefined
    let bestD = Infinity
    for (const ref of nodeRefs) {
      if (ref.id === fromId) continue
      const vx = ref.pos.x - from.x
      const vy = ref.pos.y - from.y
      if (dx !== 0) {
        if (Math.sign(vx) !== dx || Math.abs(vx) < Math.abs(vy)) continue
      } else {
        if (Math.sign(vy) !== dy || Math.abs(vy) < Math.abs(vx)) continue
      }
      const d = vx * vx + vy * vy
      if (d < bestD) {
        bestD = d
        best = ref.id
      }
    }
    return best
  }

  // ---- Detail card ---------------------------------------------------------
  const detail = h('div', 'tech-detail')
  detail.setAttribute('role', 'region')
  detail.setAttribute('aria-label', 'Szczegóły wybranego węzła')

  const detailHead = h('div', 'tech-detail-head')
  const nameEl = h('h3', 'tech-detail-name')
  const levelEl = h('span', 'tech-detail-level num')
  detailHead.appendChild(nameEl)
  detailHead.appendChild(levelEl)
  detail.appendChild(detailHead)

  const subEl = h('p', 'tech-detail-sub muted')
  detail.appendChild(subEl)

  const emptyEl = h(
    'p',
    'tech-detail-empty muted',
    'Kliknij węzeł w konstelacji (lub przejdź do niego strzałkami i naciśnij Enter), aby ' +
      'zobaczyć jego efekt, poziom i koszt następnego poziomu.',
  )
  detail.appendChild(emptyEl)

  const bodyEl = h('div', 'tech-detail-body')

  const descEl = h('p', 'tech-detail-desc')
  bodyEl.appendChild(descEl)

  const effectEl = h('p', 'tech-detail-effect')
  bodyEl.appendChild(effectEl)

  // Next-level cost: a single text line (currency-specific, from config.costText).
  // "is-short" flags an affordability shortfall (colour from the token PLUS the title
  // text — never colour alone).
  bodyEl.appendChild(h('h4', 'tech-detail-cost-title', 'Koszt następnego poziomu'))
  const costRow = h('div', 'tech-cost')
  const costItem = h('span', 'tech-cost-item')
  const costVal = h('span', 'num tech-cost-val')
  costItem.appendChild(costVal)
  costRow.appendChild(costItem)
  bodyEl.appendChild(costRow)

  const maxedEl = h('p', 'tech-detail-maxed', 'Osiągnięto poziom maksymalny.')
  maxedEl.style.display = 'none'
  bodyEl.appendChild(maxedEl)

  const actions = h('div', 'tech-detail-actions')
  const buyBtn = h('button', 'btn btn-primary tech-buy-btn', 'Wykup')
  buyBtn.type = 'button'
  actions.appendChild(buyBtn)
  bodyEl.appendChild(actions)

  const msg = h('p', 'recruit-msg muted')
  msg.setAttribute('role', 'status')
  msg.setAttribute('aria-live', 'polite')
  bodyEl.appendChild(msg)

  detail.appendChild(bodyEl)
  // Anchor the floating/sheet card to the POSITIONED viewport (.tech-wrap is
  // position:relative) so position:absolute resolves against the constellation.
  wrap.appendChild(detail)

  /** Derive a node's visual state from the config callbacks. */
  const stateOf = (id: string): NodeState => {
    const node = config.nodes[id]
    const lvl = config.level(id)
    if (lvl >= node.maxLevel) return 'maxed'
    if (lvl > 0) return 'owned'
    return config.available(id) ? 'available' : 'locked'
  }
  /** A node is buyable when its prerequisites are met and it is not maxed. */
  const isBuyable = (st: NodeState): boolean => st === 'available' || st === 'owned'

  buyBtn.addEventListener('click', () => {
    if (selectedId === null) return
    const id = selectedId
    const node = config.nodes[id]
    if (!node) return
    const lvl = config.level(id)
    const st = stateOf(id)
    if (lvl >= node.maxLevel) {
      msg.textContent = 'Osiągnięto poziom maksymalny.'
      update()
      return
    }
    if (!isBuyable(st)) {
      msg.textContent = 'Najpierw odblokuj wymagane węzły.'
      update()
      return
    }
    if (!config.affordable(id)) {
      msg.textContent = 'Za mało, aby wykupić ten węzeł.'
      update()
      return
    }
    const ok = config.purchase(id)
    msg.textContent = ok ? 'Wykupiono: ' + node.name + '.' : 'Nie udało się wykupić węzła.'
    update()
  })

  // ---- Reactivity ----------------------------------------------------------
  const update = (): void => {
    // Refresh the (opaque) currency header — swaps only if the element changed.
    mountCurrency()

    applyView()

    // Edge emphasis: an edge whose prerequisite is owned (level >= 1) is "unlocked".
    for (const ref of edgeRefs) {
      ref.line.classList.toggle('is-unlocked', config.level(ref.from) >= 1)
    }

    // Per-node state classes + aria — written only when a node's state/level changes.
    for (const ref of nodeRefs) {
      const node = config.nodes[ref.id]
      const st = stateOf(ref.id)
      const lvl = config.level(ref.id)
      const key = st + ':' + lvl
      if (key !== ref.lastKey) {
        ref.lastKey = key
        ref.g.classList.toggle('tech-node--locked', st === 'locked')
        ref.g.classList.toggle('tech-node--available', st === 'available')
        ref.g.classList.toggle('tech-node--owned', st === 'owned')
        ref.g.classList.toggle('tech-node--maxed', st === 'maxed')
        ref.g.setAttribute(
          'aria-label',
          node.name +
            ' — ' +
            catLabel(ref.category) +
            ', ' +
            ARCHETYPE_LABEL[ref.archetype] +
            '. Stan: ' +
            STATE_LABEL[st] +
            ', poziom ' +
            lvl +
            ' z ' +
            node.maxLevel +
            '. ' +
            config.effectText(ref.id) +
            '. Naciśnij Enter, aby wybrać.',
        )
      }
      // Affordability is a frequently-changing SECONDARY cue: a node is affordable when
      // it is buyable (prereqs met, not maxed) AND the caller says it can be paid for.
      const affordable = isBuyable(st) && config.affordable(ref.id)
      ref.g.classList.toggle('is-affordable', affordable)
    }

    // Drop a selection whose node vanished (defensive — ids are static).
    if (selectedId !== null && !refById.has(selectedId)) selectedId = null
    // Auto-select an entry root on first open (desktop only) so the card is useful
    // immediately; on narrow viewports the bottom sheet would cover the constellation.
    if (selectedId === null && !isNarrow()) {
      selectedId = roots[0] ?? (placedIds[0] || null)
    }

    // Roving tabindex + selection highlight: exactly ONE node is tabbable.
    const tabTarget = selectedId ?? (placedIds[0] || null)
    for (const ref of nodeRefs) {
      const isSel = ref.id === selectedId
      ref.g.classList.toggle('is-selected', isSel)
      ref.g.setAttribute('tabindex', ref.id === tabTarget ? '0' : '-1')
    }

    const selected = selectedId ? nodeOf(selectedId) : undefined
    const selPos = selectedId ? positions[selectedId] : undefined
    if (selected && selPos && selectedId) {
      const ref = refById.get(selectedId)
      selRing.setAttribute('cx', fmt2(selPos.x))
      selRing.setAttribute('cy', fmt2(selPos.y))
      selRing.setAttribute('r', fmt2((ref ? ref.radius : radiusFor('minor')) + unit * 0.14))
      selRing.style.display = ''
    } else {
      selRing.style.display = 'none'
    }

    // Detail card.
    if (!selected || !selectedId) {
      emptyEl.style.display = ''
      bodyEl.style.display = 'none'
      subEl.style.display = 'none'
      nameEl.textContent = 'Brak wyboru'
      levelEl.textContent = ''
      return
    }
    emptyEl.style.display = 'none'
    bodyEl.style.display = ''
    subEl.style.display = ''

    const lvl = config.level(selectedId)
    const st = stateOf(selectedId)
    nameEl.textContent = selected.name
    levelEl.textContent = 'poz. ' + lvl + ' / ' + selected.maxLevel
    subEl.textContent =
      catLabel(selected.category) +
      ' · ' +
      ARCHETYPE_LABEL[archetypeOf(selected.archetype)] +
      ' · ' +
      STATE_LABEL[st]
    descEl.textContent = selected.desc
    effectEl.textContent = config.effectText(selectedId)

    const maxed = lvl >= selected.maxLevel
    if (maxed) {
      costRow.style.display = 'none'
      maxedEl.style.display = ''
    } else {
      costRow.style.display = ''
      maxedEl.style.display = 'none'
      costVal.textContent = config.costText(selectedId, lvl)
      const short = isBuyable(st) && !config.affordable(selectedId)
      costItem.classList.toggle('is-short', short)
      costItem.title = short ? 'Nie stać Cię na ten węzeł' : ''
    }

    // aria-disabled (not `disabled`) keeps the button focusable so its reason reaches
    // the user; the click handler is a guarded no-op when the purchase is rejected.
    const canBuy = !maxed && isBuyable(st) && config.affordable(selectedId)
    let reason = ''
    if (maxed) reason = 'Poziom maksymalny'
    else if (!isBuyable(st)) reason = 'Najpierw odblokuj wymagane węzły'
    else if (!config.affordable(selectedId)) reason = 'Za mało, aby wykupić'
    buyBtn.setAttribute('aria-disabled', canBuy ? 'false' : 'true')
    buyBtn.title = canBuy ? '' : reason
    buyBtn.textContent = maxed ? 'Maksymalny poziom' : 'Wykup poziom ' + (lvl + 1)
    buyBtn.setAttribute(
      'aria-label',
      maxed
        ? selected.name + ': poziom maksymalny'
        : 'Wykup następny poziom: ' + selected.name + ' (poziom ' + (lvl + 1) + ')',
    )
  }

  // Frame the whole tree once the element is in the layout, then draw.
  fitView()
  update()

  return { el, update }
}
