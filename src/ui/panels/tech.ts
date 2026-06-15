import { RESOURCE_IDS, type ResourceId, type GameState } from '../../engine/state'
import { formatNumber } from '../../engine/format'
import {
  TECH_NODES,
  TECH_NODE_IDS,
  TECH_ROOTS,
  type TechNode,
  type TechArchetype,
  type TechCategory,
} from '../../content/tech'
import {
  nodeLevel,
  prerequisitesMet,
  canPurchaseTech,
  techCost,
  globalResources,
} from '../../systems/tech'
import { layoutTree, techEdges, type NodePos } from '../../systems/techLayout'
import type { UiCtx, Panel } from '../types'
import { h, svg, SVG_NS, resourceIcon, RESOURCE_NAMES } from '../dom'

/**
 * "Rozwój" panel (M3.1) — the global, account-wide PASSIVE TREE rendered as a
 * Path-of-Exile-style radial CONSTELLATION. It is the spatial twin of the tech
 * data in src/content/tech.ts: a pan/zoom SVG whose node positions come straight
 * from the deterministic radial layout ({@link layoutTree}) and whose links come
 * from the prerequisite topology ({@link techEdges}) — never hand-placed.
 *
 * Each node is drawn by ARCHETYPE (a small dot for a minor, a larger ringed dot
 * for a notable, a bigger diamond for a gateway) and coloured by STATE — locked
 * (prerequisites unmet, dimmed), available (unlocked, not yet bought, accent
 * outline), owned (level 1..max-1, gold) and maxed (bright, thick ring). State is
 * NEVER carried by colour alone (WCAG 1.4.1): shape/size differ by archetype, the
 * outline/fill differ by state, every node has an aria-label carrying its state +
 * level, and an on-screen legend explains the four states. Selecting an unlocked
 * node opens a detail card (name, effect-per-level, current/max level, the cost of
 * the next level from {@link techCost}, the GLOBAL resource pool) with a "Wykup"
 * button that commits through {@link UiCtx.onPurchaseTech}.
 *
 * Everything is built procedurally with `createElementNS` (the hard rules: zero
 * external assets, no innerHTML with data); the chrome (`.tech-wrap`, `.tech-svg`,
 * `.tech-node--*`, `.tech-edge`, the detail card, the legend) is styled from
 * design-system tokens in the stylesheet — this module owns only geometry and
 * behaviour.
 *
 * Accessibility: the SVG is a real, keyboard-driven control surface. Every node is
 * a focusable button (role=button, Enter/Space to select, arrow keys to step to the
 * nearest node in that direction); a roving tabindex keeps exactly one node tabbable
 * so the Tab key reaches the detail card without walking all ~70 nodes.
 *
 * Reactivity (panel contract): the DOM is built ONCE and cached. {@link Panel.update}
 * never rebuilds the tree — it pokes the viewBox, per-node state classes/labels (only
 * when a node's state actually changes), the selection ring and the detail card.
 *
 * Determinism: a pure VIEW. Positions/edges are derived from the static topology and
 * the live `state.tech` levels; it owns no clock and no RNG (pan/zoom are ephemeral
 * camera state, never persisted).
 *
 * Scale note: at the M3.1 size (~70 nodes) every node is rendered up front. Beyond
 * roughly 500 nodes (M3.2+) this should switch to viewport culling — only build/keep
 * the nodes whose layout position falls inside the current viewBox (plus a margin)
 * and recycle the rest — so the constellation can grow in WIDTH without a render cost.
 */

/** Default viewBox aspect (h/w) used before the element has been measured. */
const DEFAULT_ASPECT = 0.62
/** Multiplicative zoom per wheel notch / button press. */
const ZOOM_STEP = 1.2
/** Pixels of pointer travel that turn a click into a pan (so a tap still selects). */
const PAN_THRESHOLD = 4
/** Target on-screen diameter (px) for a node's transparent hit area (touch). */
const HIT_TARGET_PX = 44

/** The four mutually-exclusive node states (level + prerequisite derived). */
type NodeState = 'locked' | 'available' | 'owned' | 'maxed'

/** Cached handles for one rendered tech node. */
interface NodeRefs {
  g: SVGGElement
  shape: SVGElement
  hit: SVGCircleElement
  node: TechNode
  pos: NodePos
  /** Visible radius in LAYOUT units (drives the hit floor + selection ring). */
  radius: number
  /** Signature of the last DOM-applied state, so update() only writes on change. */
  lastKey: string
}

/** Cached handles for one rendered prerequisite link. */
interface EdgeRefs {
  line: SVGElement
  from: string
}

/** PL display name per category (matches the constellation arms). */
const CATEGORY_LABEL: Record<TechCategory, string> = {
  economy: 'Gospodarka',
  storage: 'Magazyny',
  settlement: 'Osadnictwo',
}

/** PL display name per archetype (carried in the node aria-label + detail card). */
const ARCHETYPE_LABEL: Record<TechArchetype, string> = {
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

/** A percentage label for a per-level fraction (0.03 -> "3%", 0.012 -> "1.2%"). */
function pct(frac: number): string {
  return formatNumber(frac * 100, 2) + '%'
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
  }
}

/** Full "+X% <subject> / poziom" line for the detail card. */
function effectText(node: TechNode): string {
  return '+' + pct(node.effect.perLevel) + ' ' + effectSubject(node) + ' / poziom'
}

/** Derive a node's visual state from the live `state.tech` levels + prerequisites. */
function stateOf(state: GameState, node: TechNode): NodeState {
  const lvl = nodeLevel(state, node.id)
  if (lvl >= node.maxLevel) return 'maxed'
  if (lvl > 0) return 'owned'
  return prerequisitesMet(state, node.id) ? 'available' : 'locked'
}

/** Diamond polygon points (gateway glyph) centred on (cx, cy) with "radius" r. */
function diamond(cx: number, cy: number, r: number): string {
  return `${fmt2(cx)},${fmt2(cy - r)} ${fmt2(cx + r)},${fmt2(cy)} ${fmt2(cx)},${fmt2(cy + r)} ${fmt2(cx - r)},${fmt2(cy)}`
}

/**
 * Build the "Rozwój" constellation panel. Reads {@link UiCtx} for the live store and
 * the `onPurchaseTech` commit; every affordability/availability cue comes straight
 * from the shared engine helpers (canPurchaseTech / techCost / globalResources) so
 * what the card shows can never disagree with what a purchase actually does.
 */
export function createTechPanel(ctx: UiCtx): Panel {
  const el = h('div', 'tech-panel')

  // Narrow-viewport probe (mirrors the CSS breakpoint). Pure VIEW state — used to
  // avoid auto-opening the detail sheet over a short mobile constellation.
  const narrowMql =
    typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia('(max-width: 639.98px)')
      : null
  const isNarrow = (): boolean => (narrowMql ? narrowMql.matches : false)

  // ---- Static topology (computed once; layout is deterministic) ------------
  const positions = layoutTree()
  const edges = techEdges()
  // Ids that actually got a position (defensive: layout owns every id, but never
  // crash the whole tab if one is missing — just skip it).
  const placedIds = TECH_NODE_IDS.filter((id) => positions[id])

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
  // sized as a fraction of it so two adjacent nodes can never visually overlap
  // (largest pair-sum 0.92·unit < unit), independent of the layout's coordinate scale.
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

  const radiusFor = (a: TechArchetype): number =>
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
    'Drzewo rozwoju (globalne, na całe konto). Przeciągnij, aby przesunąć, kółkiem lub ' +
      'przyciskami przybliż. Kliknij węzeł, aby zobaczyć efekt i koszt; węzły kupujesz ze ' +
      'WSPÓLNEJ puli surowców wszystkich wiosek. Strzałkami przechodzisz między węzłami, ' +
      'Enter wybiera.',
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

  // ---- Global resource pool (the currency tech is bought from) ------------
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
  el.appendChild(pool)

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
    'Konstelacja drzewa rozwoju. Węzły są przyciskami: strzałki przechodzą między nimi, ' +
      'Enter wybiera, a panel szczegółów pozwala je wykupić.',
  )
  wrap.appendChild(svgEl)

  // Drawing layers, back-to-front: edges, nodes, overlay (selection ring).
  const edgesGroup = document.createElementNS(SVG_NS, 'g') as SVGGElement
  edgesGroup.setAttribute('class', 'tech-edges')
  edgesGroup.setAttribute('aria-hidden', 'true')
  const nodesGroup = document.createElementNS(SVG_NS, 'g') as SVGGElement
  nodesGroup.setAttribute('class', 'tech-nodes')
  const overlayGroup = document.createElementNS(SVG_NS, 'g') as SVGGElement
  overlayGroup.setAttribute('class', 'tech-overlay')
  overlayGroup.setAttribute('aria-hidden', 'true')

  const selRing = svg('circle', { class: 'tech-sel-ring', r: '0', fill: 'none' })
  selRing.setAttribute('vector-effect', 'non-scaling-stroke')
  selRing.style.display = 'none'
  overlayGroup.appendChild(selRing)

  svgEl.appendChild(edgesGroup)
  svgEl.appendChild(nodesGroup)
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

  // ---- Camera plumbing (mirrors the world map) ----------------------------
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
  for (const e of edges) {
    const a = positions[e.from]
    const b = positions[e.to]
    if (!a || !b) continue
    const line = svg('line', {
      x1: fmt2(a.x),
      y1: fmt2(a.y),
      x2: fmt2(b.x),
      y2: fmt2(b.y),
      class: 'tech-edge',
    })
    line.setAttribute('vector-effect', 'non-scaling-stroke')
    edgesGroup.appendChild(line)
    edgeRefs.push({ line, from: e.from })
  }

  // ---- Nodes ---------------------------------------------------------------
  // NOTE (virtualization): at ~70 nodes we render all of them. Past ~500 (M3.2+)
  // build only nodes whose `pos` is inside the viewBox (plus margin) and recycle the
  // rest on pan/zoom — the topology already gives us positions to cull against.
  const nodeRefs: NodeRefs[] = []
  for (const id of placedIds) {
    const node = TECH_NODES[id]
    const p = positions[id]
    const r = radiusFor(node.archetype)

    const g = document.createElementNS(SVG_NS, 'g') as SVGGElement
    g.setAttribute('class', 'tech-node tech-node--' + node.archetype)
    g.setAttribute('role', 'button')
    // Roving tabindex: only the selected / first node is tabbable (set in update()),
    // so a keyboard user reaches the detail card without traversing every node.
    g.setAttribute('tabindex', '-1')

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

    // Visible glyph: diamond for a gateway (shape cue), circle otherwise.
    let shape: SVGElement
    if (node.archetype === 'gateway') {
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
    if (node.archetype === 'notable') {
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
      const next = nearestInDirection(node.id, dx, dy)
      if (next) selectAndReveal(next, true)
    })

    nodesGroup.appendChild(g)
    nodeRefs.push({ g, shape, hit, node, pos: p, radius: r, lastKey: '' })
  }
  const refById = new Map<string, NodeRefs>()
  for (const ref of nodeRefs) refById.set(ref.node.id, ref)

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
   * opaque detail card (WCAG 2.2 SC 2.4.11 — Focus Not Obscured). The card is anchored
   * to one edge (bottom-left on desktop, a bottom sheet on mobile) and would otherwise
   * hide a node — and its focus ring — that arrow-key navigation just selected. We read
   * the card's on-screen rect, convert it to viewBox fractions, shrink the "comfortable"
   * target window away from the covered edge(s), then place the node inside that window.
   */
  const ensureVisible = (p: NodePos): void => {
    // Default comfortable window: the central 85% band (half-extent 0.425 around 0.5).
    let fxLo = 0.075
    let fxHi = 0.925
    let fyLo = 0.075
    let fyHi = 0.925

    // Treat the detail card as an exclusion zone — but only when it is actually on screen
    // (a selection is showing). Skip if rects are unmeasured (panel not yet laid out).
    if (selectedId !== null) {
      const svgRect = svgEl.getBoundingClientRect()
      const cardRect = detail.getBoundingClientRect()
      if (
        svgRect.width > 0 &&
        svgRect.height > 0 &&
        cardRect.width > 0 &&
        cardRect.height > 0
      ) {
        const m = 0.06 // fractional gap kept between the node and the card edge
        const left = clamp01((cardRect.left - svgRect.left) / svgRect.width)
        const right = clamp01((cardRect.right - svgRect.left) / svgRect.width)
        const top = clamp01((cardRect.top - svgRect.top) / svgRect.height)
        const bottom = clamp01((cardRect.bottom - svgRect.top) / svgRect.height)
        // Vertical: bias away from whichever half the card occupies (it is bottom-anchored
        // in both layouts, so this normally lifts the window above the card's top edge).
        if ((top + bottom) / 2 >= 0.5) fyHi = Math.min(fyHi, top - m)
        else fyLo = Math.max(fyLo, bottom + m)
        // Horizontal: only for a corner card (NOT a full-width bottom sheet, which can't be
        // cleared sideways) — on desktop this nudges the window toward the right.
        if (right - left < 0.85) {
          if ((left + right) / 2 < 0.5) fxLo = Math.max(fxLo, right + m)
          else fxHi = Math.min(fxHi, left - m)
        }
        // Defensive: a card covering most of an axis would invert the window — collapse it
        // to a sliver pinned to the clear edge so the node still pans fully into the open.
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

    // Current on-screen fraction of the node, then pan the minimum to land it inside the
    // comfortable window (viewCx so that p hits fraction f is p.x + viewW*(0.5 - f)).
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
      if (ref.node.id === fromId) continue
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
        best = ref.node.id
      }
    }
    return best
  }

  // ---- Detail card ---------------------------------------------------------
  const detail = h('div', 'tech-detail')
  detail.setAttribute('role', 'region')
  detail.setAttribute('aria-label', 'Szczegóły wybranego węzła rozwoju')

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

  const bonusEl = h('p', 'tech-detail-bonus muted')
  bodyEl.appendChild(bonusEl)

  // Next-level cost: one icon+amount per resource; "is-short" flags a shortfall
  // against the GLOBAL pool (colour PLUS the title carry it — never colour alone).
  bodyEl.appendChild(h('h4', 'tech-detail-cost-title', 'Koszt następnego poziomu'))
  const costRow = h('div', 'tech-cost')
  const costRefs = {} as Record<ResourceId, { item: HTMLElement; val: HTMLElement }>
  for (const r of RESOURCE_IDS) {
    const item = h('span', 'tech-cost-item')
    const iconWrap = h('span', 'res-icon-wrap')
    iconWrap.appendChild(resourceIcon(r))
    const val = h('span', 'num tech-cost-val')
    item.appendChild(iconWrap)
    item.appendChild(val)
    costRow.appendChild(item)
    costRefs[r] = { item, val }
  }
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

  buyBtn.addEventListener('click', () => {
    if (selectedId === null) return
    const verdict = canPurchaseTech(ctx.store.state, selectedId)
    if (!verdict.ok) {
      msg.textContent = verdict.reason ?? 'Nie można wykupić tego węzła.'
      update()
      return
    }
    const node = TECH_NODES[selectedId]
    const ok = ctx.onPurchaseTech(selectedId)
    msg.textContent = ok
      ? 'Wykupiono: ' + (node ? node.name : selectedId) + '.'
      : 'Nie udało się wykupić węzła.'
    update()
  })

  // ---- Reactivity ----------------------------------------------------------
  const update = (): void => {
    const state = ctx.store.state

    // Global pool (drives both the header row and per-resource cost shortfalls).
    const poolRes = globalResources(state)
    for (const r of RESOURCE_IDS) poolVals[r].textContent = formatNumber(poolRes[r])

    applyView()

    // Edge emphasis: an edge whose prerequisite is owned (level >= 1) is "unlocked"
    // (the path beyond it is reachable) — brighter than a still-locked link.
    for (const ref of edgeRefs) {
      ref.line.classList.toggle('is-unlocked', nodeLevel(state, ref.from) >= 1)
    }

    // Per-node state classes + aria — written only when a node's state/level changes.
    for (const ref of nodeRefs) {
      const st = stateOf(state, ref.node)
      const lvl = nodeLevel(state, ref.node.id)
      const key = st + ':' + lvl
      if (key !== ref.lastKey) {
        ref.lastKey = key
        ref.g.classList.toggle('tech-node--locked', st === 'locked')
        ref.g.classList.toggle('tech-node--available', st === 'available')
        ref.g.classList.toggle('tech-node--owned', st === 'owned')
        ref.g.classList.toggle('tech-node--maxed', st === 'maxed')
        ref.g.setAttribute(
          'aria-label',
          ref.node.name +
            ' — ' +
            CATEGORY_LABEL[ref.node.category] +
            ', ' +
            ARCHETYPE_LABEL[ref.node.archetype] +
            '. Stan: ' +
            STATE_LABEL[st] +
            ', poziom ' +
            lvl +
            ' z ' +
            ref.node.maxLevel +
            '. ' +
            effectText(ref.node) +
            '. Naciśnij Enter, aby wybrać.',
        )
      }
      // Affordability is a frequently-changing, SECONDARY cue (resources accrue every
      // tick) — a static glow, layered on top of the structural state. Cheap + idempotent.
      ref.g.classList.toggle('is-affordable', canPurchaseTech(state, ref.node.id).ok)
    }

    // Drop a selection whose node somehow vanished (defensive — ids are static).
    if (selectedId !== null && !refById.has(selectedId)) selectedId = null
    // Auto-select an entry root on first open (desktop only) so the card is useful
    // immediately; on narrow viewports the bottom sheet would cover the constellation.
    if (selectedId === null && !isNarrow()) {
      selectedId = TECH_ROOTS[0] ?? (placedIds[0] || null)
    }

    // Roving tabindex + selection highlight: exactly ONE node is tabbable.
    const tabTarget = selectedId ?? (placedIds[0] || null)
    for (const ref of nodeRefs) {
      const isSel = ref.node.id === selectedId
      ref.g.classList.toggle('is-selected', isSel)
      ref.g.setAttribute('tabindex', ref.node.id === tabTarget ? '0' : '-1')
    }

    const selected = selectedId ? TECH_NODES[selectedId] : undefined
    const selPos = selectedId ? positions[selectedId] : undefined
    if (selected && selPos) {
      selRing.setAttribute('cx', fmt2(selPos.x))
      selRing.setAttribute('cy', fmt2(selPos.y))
      selRing.setAttribute('r', fmt2(radiusFor(selected.archetype) + unit * 0.14))
      selRing.style.display = ''
    } else {
      selRing.style.display = 'none'
    }

    // Detail card.
    if (!selected) {
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

    const lvl = nodeLevel(state, selected.id)
    const st = stateOf(state, selected)
    nameEl.textContent = selected.name
    levelEl.textContent = 'poz. ' + lvl + ' / ' + selected.maxLevel
    subEl.textContent =
      CATEGORY_LABEL[selected.category] +
      ' · ' +
      ARCHETYPE_LABEL[selected.archetype] +
      ' · ' +
      STATE_LABEL[st]
    descEl.textContent = selected.desc
    effectEl.textContent = effectText(selected)
    bonusEl.textContent =
      lvl > 0
        ? 'Obecny łączny bonus: +' + pct(selected.effect.perLevel * lvl)
        : 'Jeszcze nie wykupiony.'

    const verdict = canPurchaseTech(state, selected.id)
    const maxed = lvl >= selected.maxLevel
    if (maxed) {
      costRow.style.display = 'none'
      maxedEl.style.display = ''
    } else {
      costRow.style.display = ''
      maxedEl.style.display = 'none'
      const cost = techCost(selected.id, lvl)
      for (const r of RESOURCE_IDS) {
        costRefs[r].val.textContent = formatNumber(cost[r])
        const short = poolRes[r].lt(cost[r])
        costRefs[r].item.classList.toggle('is-short', short)
        costRefs[r].item.title = short
          ? 'Za mało: ' + RESOURCE_NAMES[r]
          : RESOURCE_NAMES[r]
      }
    }

    // aria-disabled (not `disabled`) keeps the button focusable so its reason reaches
    // the user; the click handler is a guarded no-op when canPurchaseTech rejects.
    buyBtn.setAttribute('aria-disabled', verdict.ok ? 'false' : 'true')
    buyBtn.title = verdict.ok ? '' : (verdict.reason ?? '')
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
