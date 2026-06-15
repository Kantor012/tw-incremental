import type { Village, BarbarianVillage, ResourceMap, TechModifiers } from '../../engine/state'
import { RESOURCE_IDS } from '../../engine/state'
import { D, type Decimal } from '../../engine/decimal'
import { formatNumber, formatInt, formatTime } from '../../engine/format'
import { UNIT_IDS, UNITS, type UnitId } from '../../content/units'
import { barbarianTarget, MAX_TARGET_LEVEL } from '../../content/barbarians'
import {
  distance,
  targetsByDistance,
  barbarianById,
  WORLD_CENTER,
  WORLD_SIZE,
} from '../../systems/world'
import { canFound } from '../../systems/villages'
import { marchTime, stationedUnits, canAttack } from '../../systems/marches'
import { unitUnlocked } from '../../systems/recruitment'
import { armyAttackPower, armyCarry, battleOutcome } from '../../systems/combat'
import { aggregateTechMods } from '../../systems/tech'
import type { UiCtx, Panel } from '../types'
import { h, svg, SVG_NS, unitIcon, shieldIcon } from '../dom'
// Aliased: the detail card already has a local element named `conquestHint`.
import { conquestHint as conquestHintText } from '../conquestCopy'

/**
 * World map panel (M2.2) — the spatial twin of the "Wyprawy" (campaign) tab and
 * the headline visual of this milestone. Renders the seed-generated world as a
 * pan/zoom SVG: a subtle grid, the player's villages (gold heraldic shields) from
 * `store.state.villageOrder`, every barbarian village (red, sized/shaded by camp
 * tier) from `store.state.world.barbarians`, and a live line per in-flight march of
 * the ACTIVE village. Selecting a barbarian opens a detail card (defence, estimated
 * loot, distance, march time, a battle forecast) with a compact army composer and an
 * Attack button that calls `ctx.onAttack(active, barb.id, units)`.
 *
 * Everything is built procedurally with `createElementNS` (the hard rule: no
 * external assets, no innerHTML with data); per-tier shades are computed in JS the
 * same way dom.ts authors its procedural icons. The map's chrome (`.map-wrap`,
 * `.map-svg`, `.map-controls`, `.map-node`, `.map-march`, the detail card) is styled
 * from design-system tokens in the stylesheet; this module owns only geometry and
 * behaviour, plus the data-driven node fill.
 *
 * Accessibility: the map is a convenience view, NOT the only way in — the "Wyprawy"
 * tab is the fully accessible list alternative (stated in the on-screen note and the
 * SVG's aria-label). Still, every barbarian node is a real, focusable control
 * (role=button, tabindex=0, Enter/Space to select, an aria-label carrying tier AND
 * distance from the active village); player villages are decorative (aria-hidden).
 *
 * Reactivity (panel contract): the DOM is built ONCE and cached. {@link Panel.update}
 * never rebuilds the tree per frame — it pokes the viewBox, march-marker positions,
 * the selection/active rings and the detail card. The three bounded rebuilds (the
 * barbarian set, the player set, the active village's march lines) fire only when
 * their content signature changes (e.g. a save import regenerates the world).
 *
 * Determinism: this is a pure VIEW. It reads world coordinates generated from the
 * seed and computes distances/march times via the shared engine helpers; it owns no
 * clock and no RNG (pan/zoom are ephemeral camera state, never persisted).
 */

/** Default viewBox aspect (h/w) used before the element has been laid out/measured. */
const DEFAULT_ASPECT = 0.62
/** Closest zoom: viewBox width in world fields (smaller = more zoomed in). */
const MIN_VIEW_W = 24
/** Farthest zoom: a touch beyond the whole world so the edges stay reachable. */
const MAX_VIEW_W = WORLD_SIZE * 1.6
/** Initial viewBox width — frames the capital plus the dense low-tier inner rings. */
const INITIAL_VIEW_W = 150
/** Multiplicative zoom per wheel notch / button press. */
const ZOOM_STEP = 1.2
/** Grid spacing in world fields. */
const GRID = 50
/** Pixels of pointer travel that turn a click into a pan (so a tap still selects). */
const PAN_THRESHOLD = 4

/** Cached handles for one army-composer row in the detail card. */
interface ArmyPickRefs {
  input: HTMLInputElement
  avail: HTMLElement
}

/** Cached handles for one rendered barbarian node. */
interface BarbNodeRefs {
  g: SVGGElement
  title: SVGElement
  /** Transparent, screen-sized hit circle so taps meet the touch-target minimum. */
  hit: SVGCircleElement
  barb: BarbarianVillage
}

/** Cached handles for one rendered march (a line plus its travelling marker). */
interface MarchRefs {
  marker: SVGElement
  fromX: number
  fromY: number
  toX: number
  toY: number
}

/** 0..1 position of a camp tier between level 1 and the ceiling. */
function tierFrac(level: number): number {
  return MAX_TARGET_LEVEL > 1 ? Math.min(1, Math.max(0, (level - 1) / (MAX_TARGET_LEVEL - 1))) : 0
}

/**
 * Per-tier fill OPACITY applied to the token hue (--bad) of the barbarian dot.
 * Higher tiers read BRIGHTER / more opaque so the most dangerous camps stand out at
 * a glance (and hold non-text contrast against the dark field) instead of fading to
 * near-invisible; the hue itself stays the token, so a palette change is followed.
 */
function barbOpacity(level: number): number {
  return 0.5 + 0.5 * tierFrac(level)
}

/** Per-tier node radius (world fields): small low-tier dots up to chunkier strongholds. */
function barbRadius(level: number): number {
  return 2 + tierFrac(level) * 4
}

/** Total camp loot (Σ over resources) for a tier, as Decimal (the haul cap). */
function totalLootOf(level: number): Decimal {
  const loot: ResourceMap = barbarianTarget(level).loot
  let s = loot[RESOURCE_IDS[0]]
  for (let i = 1; i < RESOURCE_IDS.length; i++) s = s.add(loot[RESOURCE_IDS[i]])
  return s
}

/** Round to 2dp for compact, stable viewBox strings. */
function fmt2(n: number): string {
  return (Math.round(n * 100) / 100).toString()
}

/**
 * Set a `.bar > i` fill width + aria-valuenow from a loyalty value, clamped to a
 * finite 0..100 (NaN/∞ → full). Shared shape with campaign.ts's setBar; kept local
 * here so the map panel stays self-contained (no cross-panel imports).
 */
function setLoyaltyBar(bar: HTMLElement, loyalty: number): void {
  const pct = Math.max(0, Math.min(100, Number.isFinite(loyalty) ? loyalty : 100))
  const fill = bar.firstElementChild as HTMLElement | null
  if (fill) fill.style.width = pct + '%'
  bar.setAttribute('aria-valuenow', String(Math.round(pct)))
}

/**
 * Build the world map panel. Reads {@link UiCtx} for the live store, the active
 * village selection and the `onAttack` commit; every estimate (distance, march
 * time, loot, the forecast) comes straight from the shared engine helpers so what
 * the map shows can never disagree with what a dispatch actually does.
 */
export function createMapPanel(ctx: UiCtx): Panel {
  const el = h('div', 'map-panel')

  // Active village resolved fresh on every read so a HUD selection change is picked
  // up without rebuilding DOM. Falls back to the first village if the selection is
  // momentarily stale (mirrors layout.ts / campaign.ts).
  const activeVillage = (): Village => {
    const s = ctx.store.state
    return s.villages[ctx.activeVillageId.value] ?? s.villages[s.villageOrder[0]]
  }

  // Narrow-viewport probe (mirrors the CSS breakpoint). Pure VIEW state — not a
  // clock/RNG — used to avoid auto-opening the detail sheet over a short mobile map.
  const narrowMql =
    typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia('(max-width: 639.98px)')
      : null
  const isNarrow = (): boolean => (narrowMql ? narrowMql.matches : false)

  // ---- Accessible-alternative note ----------------------------------------
  const note = h(
    'p',
    'map-note muted',
    'Mapa świata — przeciągnij, aby przesunąć, użyj kółka lub przycisków, aby przybliżyć. ' +
      'Kliknij wioskę barbarzyńską, aby zaplanować atak. Pełna, dostępna lista celów ' +
      'znajduje się w zakładce „Wyprawy".',
  )
  note.setAttribute('role', 'note')
  el.appendChild(note)

  // ---- Legend (token swatches + text) -------------------------------------
  // At-a-glance meaning of colour/size/line so „poziom celu" is readable without
  // hovering. Swatches are decorative (aria-hidden); the text carries the meaning.
  const legend = h('div', 'map-legend')
  legend.setAttribute('role', 'note')
  const addLegend = (cls: string, label: string): void => {
    const item = h('span', 'map-legend-item')
    const swatch = h('span', 'map-legend-swatch ' + cls)
    swatch.setAttribute('aria-hidden', 'true')
    item.appendChild(swatch)
    item.appendChild(document.createTextNode(' ' + label))
    legend.appendChild(item)
  }
  addLegend('is-player', 'Twoja wioska')
  addLegend('is-barb', 'Barbarzyńca (jaśniejszy/większy = wyższy poziom)')
  addLegend('is-march', 'Marsz')
  el.appendChild(legend)

  // ---- Founding-mode status line (M2.3) -----------------------------------
  // Live, polite status for the "Załóż wioskę" mode: the hint while armed, then the
  // PL reason a tapped field was rejected (geometry/affordability from canFound).
  // Carries the meaning in text (colour is never the only cue); hidden when idle.
  // It is an absolute OVERLAY anchored INSIDE .map-wrap (appended below, after the
  // controls) so the feedback stays in the viewport next to where the user is acting
  // — on phones the controls live at the bottom of the map, where this banner sits.
  const foundStatus = h('p', 'map-found-status muted')
  foundStatus.setAttribute('role', 'status')
  foundStatus.setAttribute('aria-live', 'polite')
  foundStatus.style.display = 'none'

  // ---- Map viewport (SVG) + overlay controls ------------------------------
  const wrap = h('div', 'map-wrap')

  const svgEl = document.createElementNS(SVG_NS, 'svg') as SVGSVGElement
  svgEl.setAttribute('class', 'map-svg')
  svgEl.setAttribute('width', '100%')
  svgEl.setAttribute('height', '100%')
  svgEl.setAttribute('preserveAspectRatio', 'xMidYMid meet')
  svgEl.setAttribute('role', 'group')
  svgEl.setAttribute(
    'aria-label',
    'Mapa świata: wioski gracza i wioski barbarzyńskie. Dostępna lista celów w zakładce „Wyprawy".',
  )
  wrap.appendChild(svgEl)

  // Drawing layers, back-to-front: grid, march lines, barbarians, players, overlay.
  const gridGroup = document.createElementNS(SVG_NS, 'g') as SVGGElement
  gridGroup.setAttribute('class', 'map-grid')
  gridGroup.setAttribute('aria-hidden', 'true')
  const marchesGroup = document.createElementNS(SVG_NS, 'g') as SVGGElement
  marchesGroup.setAttribute('class', 'map-marches')
  marchesGroup.setAttribute('aria-hidden', 'true')
  const barbsGroup = document.createElementNS(SVG_NS, 'g') as SVGGElement
  barbsGroup.setAttribute('class', 'map-barbs')
  const playersGroup = document.createElementNS(SVG_NS, 'g') as SVGGElement
  playersGroup.setAttribute('class', 'map-players')
  playersGroup.setAttribute('aria-hidden', 'true')
  const overlayGroup = document.createElementNS(SVG_NS, 'g') as SVGGElement
  overlayGroup.setAttribute('class', 'map-overlay')
  overlayGroup.setAttribute('aria-hidden', 'true')

  // Static background grid (world bounds + minor lines), built once.
  {
    const border = svg('rect', {
      x: '0',
      y: '0',
      width: String(WORLD_SIZE),
      height: String(WORLD_SIZE),
      class: 'map-grid-border',
      fill: 'none',
    })
    border.setAttribute('vector-effect', 'non-scaling-stroke')
    gridGroup.appendChild(border)
    let d = ''
    for (let g = 0; g <= WORLD_SIZE; g += GRID) {
      d += `M${g} 0V${WORLD_SIZE}M0 ${g}H${WORLD_SIZE}`
    }
    const lines = svg('path', { d, class: 'map-grid-lines', fill: 'none' })
    lines.setAttribute('vector-effect', 'non-scaling-stroke')
    gridGroup.appendChild(lines)
  }

  // Active-village + selected-barbarian rings (single shared markers, moved per frame).
  const activeRing = svg('circle', { class: 'map-active-ring', r: '0', fill: 'none' })
  activeRing.setAttribute('vector-effect', 'non-scaling-stroke')
  activeRing.style.display = 'none'
  const selRing = svg('circle', { class: 'map-sel-ring', r: '0', fill: 'none' })
  selRing.setAttribute('vector-effect', 'non-scaling-stroke')
  selRing.style.display = 'none'
  overlayGroup.appendChild(activeRing)
  overlayGroup.appendChild(selRing)

  svgEl.appendChild(gridGroup)
  svgEl.appendChild(marchesGroup)
  svgEl.appendChild(barbsGroup)
  svgEl.appendChild(playersGroup)
  svgEl.appendChild(overlayGroup)

  // Overlay controls (zoom out / in / recenter). Touch-target sizing lives in CSS.
  const controls = h('div', 'map-controls')
  const zoomOutBtn = h('button', 'btn btn-ghost map-zoom-btn', '−')
  zoomOutBtn.type = 'button'
  zoomOutBtn.setAttribute('aria-label', 'Oddal mapę')
  const zoomInBtn = h('button', 'btn btn-ghost map-zoom-btn', '+')
  zoomInBtn.type = 'button'
  zoomInBtn.setAttribute('aria-label', 'Przybliż mapę')
  const centerBtn = h('button', 'btn btn-ghost map-center-btn', 'Wycentruj na stolicy')
  centerBtn.type = 'button'
  // Founding-mode toggle (M2.3). A pressed-state button (aria-pressed); when armed it
  // also swaps to the primary fill so the active mode is signalled by more than colour.
  const foundBtn = h('button', 'btn btn-ghost map-found-btn', 'Załóż wioskę')
  foundBtn.type = 'button'
  foundBtn.setAttribute('aria-pressed', 'false')
  foundBtn.title = 'Włącz tryb zakładania i kliknij wolne pole na mapie'
  controls.appendChild(zoomOutBtn)
  controls.appendChild(zoomInBtn)
  controls.appendChild(centerBtn)
  controls.appendChild(foundBtn)
  wrap.appendChild(controls)
  el.appendChild(wrap)

  // ---- Camera (ephemeral; never persisted) --------------------------------
  let viewCx = WORLD_CENTER.x
  let viewCy = WORLD_CENTER.y
  let viewW = INITIAL_VIEW_W
  let viewH = INITIAL_VIEW_W * DEFAULT_ASPECT

  const clampViewW = (w: number): number => Math.max(MIN_VIEW_W, Math.min(MAX_VIEW_W, w))
  const clampCenter = (c: number): number => Math.max(0, Math.min(WORLD_SIZE, c))
  const currentAspect = (): number => {
    const w = svgEl.clientWidth
    const hh = svgEl.clientHeight
    return w > 0 && hh > 0 ? hh / w : DEFAULT_ASPECT
  }
  /** Push the camera state into the viewBox, syncing height to the element aspect. */
  const applyView = (): void => {
    viewH = viewW * currentAspect()
    const x = viewCx - viewW / 2
    const y = viewCy - viewH / 2
    svgEl.setAttribute('viewBox', `${fmt2(x)} ${fmt2(y)} ${fmt2(viewW)} ${fmt2(viewH)}`)
  }
  /**
   * Zoom by `factor` (>1 = out) about the screen fraction (fx, fy) so the world
   * point under the cursor stays put. Exact while the viewBox aspect tracks the
   * element aspect (no letterbox) — which applyView guarantees.
   */
  const zoomBy = (factor: number, fx: number, fy: number): void => {
    const aspect = currentAspect()
    const curH = viewW * aspect
    const wpx = viewCx - viewW / 2 + fx * viewW
    const wpy = viewCy - curH / 2 + fy * curH
    const newW = clampViewW(viewW * factor)
    const newH = newW * aspect
    viewCx = clampCenter(wpx + newW * (0.5 - fx))
    viewCy = clampCenter(wpy + newH * (0.5 - fy))
    viewW = newW
    applyView()
    updateHitRadii()
  }
  const centerOnCapital = (): void => {
    const s = ctx.store.state
    const cap = s.villages[s.villageOrder[0]]
    viewCx = cap ? cap.x : WORLD_CENTER.x
    viewCy = cap ? cap.y : WORLD_CENTER.y
    applyView()
  }

  zoomInBtn.addEventListener('click', () => zoomBy(1 / ZOOM_STEP, 0.5, 0.5))
  zoomOutBtn.addEventListener('click', () => zoomBy(ZOOM_STEP, 0.5, 0.5))
  centerBtn.addEventListener('click', () => centerOnCapital())

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

  // Pointer gestures: ONE finger/button = pan (capture taken only after the move
  // threshold, so a plain tap still reaches a node), TWO fingers = pinch-zoom about
  // their midpoint (mobile parity with wheel zoom). Active pointers live in a Map so
  // a second touch is recognised as pinch rather than overwriting the pan.
  const pointers = new Map<number, { x: number; y: number }>()
  let panActive = false
  let suppressClick = false
  let startClientX = 0
  let startClientY = 0
  let startCx = 0
  let startCy = 0
  let pinchActive = false
  let pinchStartDist = 1
  let pinchStartW = INITIAL_VIEW_W

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
      // Promote to a pinch: cancel any pan and snapshot the finger gap + zoom.
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
      updateHitRadii()
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
        /* capture unsupported — pan still works without it */
      }
    }
    const rect = svgEl.getBoundingClientRect()
    if (rect.width <= 0 || rect.height <= 0) return
    viewCx = clampCenter(startCx - (dxpx * viewW) / rect.width)
    viewCy = clampCenter(startCy - (dypx * viewH) / rect.height)
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
      // A drag just ended; swallow the click it would otherwise synthesize so the
      // gesture pans rather than selecting whatever happened to be under the cursor.
      suppressClick = true
      panActive = false
      svgEl.classList.remove('is-panning')
    }
    if (pinchActive && pointers.size < 2) {
      pinchActive = false
      suppressClick = true
      // If one finger remains, resume panning from its current position (no jump).
      const rest = pointerList()[0]
      if (rest) beginPanFrom(rest.x, rest.y)
    }
  }
  svgEl.addEventListener('pointerup', endPointer)
  svgEl.addEventListener('pointercancel', endPointer)

  // Keep the viewBox aspect — and the screen-sized node hit areas — in step with the
  // element as it resizes.
  if (typeof ResizeObserver !== 'undefined') {
    const ro = new ResizeObserver(() => {
      applyView()
      updateHitRadii()
    })
    ro.observe(svgEl)
  }
  applyView()

  // ---- Selection state -----------------------------------------------------
  let selectedId: string | null = null
  // Founding mode (M2.3): when armed, a plain click on a FREE, valid field plants a
  // new owned village (ctx.onFound) instead of selecting a target — the two click
  // gestures are mutually exclusive so they never collide. Pan/zoom keep working (a
  // drag still pans; suppressClick swallows the click a drag synthesises).
  let foundMode = false
  const select = (id: string): void => {
    // In founding mode the map click is a "place village" gesture: never select a
    // target here (leave suppressClick for the svg-level founding handler to read).
    if (foundMode) return
    if (suppressClick) {
      suppressClick = false
      return
    }
    selectedId = id
    update()
  }

  // ---- Founding-mode wiring (M2.3) ----------------------------------------
  const FOUND_HINT =
    'Tryb zakładania: kliknij wolne pole na mapie, aby założyć nową wioskę. ' +
    'Przeciągnij, aby przesunąć mapę.'
  /** Arm/disarm founding: reflect it on the button (pressed + primary fill), the SVG
   * cursor/class, and the status line. Pure view state — never persisted. */
  const setFoundMode = (on: boolean): void => {
    foundMode = on
    foundBtn.setAttribute('aria-pressed', on ? 'true' : 'false')
    foundBtn.classList.toggle('btn-primary', on)
    foundBtn.classList.toggle('btn-ghost', !on)
    svgEl.style.cursor = on ? 'crosshair' : ''
    svgEl.classList.toggle('is-founding', on)
    foundStatus.textContent = on ? FOUND_HINT : ''
    foundStatus.style.display = on ? '' : 'none'
  }
  foundBtn.addEventListener('click', () => setFoundMode(!foundMode))

  // A plain (non-pan) click while armed plants a village on the rounded world field
  // under the cursor. This bubbles up AFTER any node's own click (which select()
  // ignores in this mode), so tapping an occupied/too-close field just reports its
  // PL reason. Geometry/affordability are decided by the pure canFound; the actual
  // mutation + persistence go through ctx.onFound.
  svgEl.addEventListener('click', (e: MouseEvent) => {
    if (!foundMode) return
    if (suppressClick) {
      suppressClick = false
      return
    }
    const rect = svgEl.getBoundingClientRect()
    if (rect.width <= 0 || rect.height <= 0) return
    const aspect = currentAspect()
    const curH = viewW * aspect
    const fx = (e.clientX - rect.left) / rect.width
    const fy = (e.clientY - rect.top) / rect.height
    const wx = Math.round(viewCx - viewW / 2 + fx * viewW)
    const wy = Math.round(viewCy - curH / 2 + fy * curH)
    const v = activeVillage()
    const verdict = canFound(ctx.store.state, v.id, wx, wy)
    if (!verdict.ok) {
      foundStatus.textContent =
        'Pole (' + wx + ', ' + wy + '): ' + (verdict.reason ?? 'nie można tu założyć wioski') + '.'
      foundStatus.style.display = ''
      return
    }
    const newId = ctx.onFound(v.id, wx, wy)
    if (newId !== null) {
      setFoundMode(false)
      ctx.activeVillageId.value = newId
      update()
    } else {
      foundStatus.textContent = 'Nie udało się założyć wioski.'
      foundStatus.style.display = ''
    }
  })

  // ---- Detail card ---------------------------------------------------------
  const detail = h('div', 'map-detail')
  detail.setAttribute('role', 'region')
  detail.setAttribute('aria-label', 'Szczegóły wybranego celu')

  const detailHead = h('div', 'map-detail-head')
  const nameEl = h('h3', 'map-detail-name')
  const levelEl = h('span', 'map-detail-level num')
  detailHead.appendChild(nameEl)
  detailHead.appendChild(levelEl)
  detail.appendChild(detailHead)

  const emptyEl = h(
    'p',
    'map-detail-empty muted',
    'Kliknij wioskę barbarzyńską na mapie, aby zobaczyć jej obronę, łup i czas marszu.',
  )
  detail.appendChild(emptyEl)

  const body = h('div', 'map-detail-body')

  const stats = h('div', 'building-stats')
  const mkStat = (label: string): HTMLElement => {
    const w = h('div', 'stat')
    w.appendChild(h('span', 'stat-label muted', label))
    const val = h('span', 'num stat-val')
    w.appendChild(val)
    stats.appendChild(w)
    return val
  }
  const defVal = mkStat('Obrona')
  const lootVal = mkStat('Szac. łup')
  const distVal = mkStat('Odległość')
  const timeVal = mkStat('Czas marszu')
  const loyaltyVal = mkStat('Lojalność')
  body.appendChild(stats)

  // ---- Loyalty / conquest progress (M2.4) ---------------------------------
  // A camp's loyalty (0..100) is its resistance to capture: a won attack with a
  // surviving Szlachcic knocks it down, and at 0 the village is conquered (turns
  // into a player village in place). Shown as a labelled bar PLUS the numeric stat
  // above (colour is never the sole cue), with a hint that capture needs a noble.
  const loyaltyBar = h('div', 'bar')
  loyaltyBar.setAttribute('role', 'progressbar')
  loyaltyBar.setAttribute('aria-valuemin', '0')
  loyaltyBar.setAttribute('aria-valuemax', '100')
  loyaltyBar.setAttribute('aria-label', 'Lojalność celu (100 = najtrudniej przejąć)')
  loyaltyBar.appendChild(h('i'))
  body.appendChild(loyaltyBar)

  const conquestHint = h('p', 'map-detail-hint muted')
  body.appendChild(conquestHint)

  const forecast = h('p', 'map-detail-forecast')
  forecast.setAttribute('role', 'status')
  forecast.setAttribute('aria-live', 'polite')
  body.appendChild(forecast)
  // update() runs on EVERY store revision (every tick). Re-assigning an aria-live
  // region's textContent re-announces it to assistive tech even when unchanged, so
  // guard the write to fire only on an actual forecast change (the class toggles
  // below are idempotent and carry no announcement).
  let lastForecast = ''
  const setForecast = (text: string): void => {
    if (text !== lastForecast) {
      forecast.textContent = text
      lastForecast = text
    }
  }

  // Compact army composer — reuses the campaign tab's styled component classes.
  body.appendChild(h('h4', 'recruit-subtitle', 'Skład wyprawy'))
  const composer = h('div', 'army-picker')
  const armyPicks = {} as Record<UnitId, ArmyPickRefs>
  for (const id of UNIT_IDS) {
    const def = UNITS[id]
    const pick = h('div', 'army-pick')
    const labelRow = h('span', 'army-pick-label')
    const iconWrap = h('span', 'res-icon-wrap')
    iconWrap.appendChild(unitIcon(id))
    labelRow.appendChild(iconWrap)
    labelRow.appendChild(document.createTextNode(' ' + def.name))
    const avail = h('span', 'army-pick-avail num muted')
    const input = h('input', 'recruit-count num')
    input.type = 'number'
    input.min = '0'
    input.step = '1'
    input.value = '0'
    input.inputMode = 'numeric'
    input.setAttribute('aria-label', 'Liczba do wysłania: ' + def.name)
    input.addEventListener('input', () => update())
    pick.appendChild(labelRow)
    pick.appendChild(avail)
    pick.appendChild(input)
    composer.appendChild(pick)
    armyPicks[id] = { input, avail }
  }
  body.appendChild(composer)

  const actions = h('div', 'recruit-controls')
  const sendAllBtn = h('button', 'btn btn-ghost', 'Wszystkie dostępne')
  sendAllBtn.type = 'button'
  sendAllBtn.addEventListener('click', () => {
    const home = stationedUnits(activeVillage())
    for (const id of UNIT_IDS) armyPicks[id].input.value = String(home[id])
    update()
  })
  const clearBtn = h('button', 'btn btn-ghost', 'Wyczyść')
  clearBtn.type = 'button'
  clearBtn.addEventListener('click', () => {
    for (const id of UNIT_IDS) armyPicks[id].input.value = '0'
    update()
  })
  const attackBtn = h('button', 'btn btn-primary', 'Atakuj')
  attackBtn.type = 'button'
  actions.appendChild(sendAllBtn)
  actions.appendChild(clearBtn)
  actions.appendChild(attackBtn)
  body.appendChild(actions)

  const msg = h('p', 'recruit-msg muted')
  msg.setAttribute('role', 'status')
  msg.setAttribute('aria-live', 'polite')
  body.appendChild(msg)

  detail.appendChild(body)
  // Anchor the floating/sheet card to the POSITIONED map viewport (.map-wrap is
  // position:relative), not the unpositioned .map-panel — otherwise position:absolute
  // resolves against the viewport/initial containing block and the card escapes the map.
  wrap.appendChild(detail)
  // Founding banner as an in-map overlay (see note at its creation). Appended last so
  // it stacks above the field/detail; CSS positions it (top on desktop, above the
  // bottom controls on phones) and toggles nothing but its look — JS owns visibility.
  wrap.appendChild(foundStatus)

  /** Read the composed army from the inputs, clamped per-type to the home garrison. */
  const readArmy = (v: Village): Record<UnitId, number> => {
    const home = stationedUnits(v)
    const army = {} as Record<UnitId, number>
    for (const id of UNIT_IDS) {
      const parsed = Math.floor(Number(armyPicks[id].input.value))
      const n = Number.isFinite(parsed) && parsed > 0 ? parsed : 0
      army[id] = Math.min(n, home[id])
    }
    return army
  }
  const armySize = (army: Record<UnitId, number>): number => {
    let n = 0
    for (const id of UNIT_IDS) n += army[id]
    return n
  }

  attackBtn.addEventListener('click', () => {
    const v = activeVillage()
    const world = ctx.store.state.world
    if (selectedId === null) return
    const barb = barbarianById(world, selectedId)
    if (barb === undefined) {
      msg.textContent = 'Cel już nie istnieje.'
      update()
      return
    }
    const army = readArmy(v)
    const verdict = canAttack(v, barb, army)
    if (!verdict.ok) {
      msg.textContent = verdict.reason ?? 'Nie można wysłać wyprawy.'
      update()
      return
    }
    const target = barbarianTarget(barb.level)
    const mods = aggregateTechMods(ctx.store.state.tech)
    const outcome = battleOutcome(armyAttackPower(army, mods), target.defensePower)
    if (
      !outcome.attackerWins &&
      !window.confirm(
        'Prognoza: porażka — wysłana armia prawdopodobnie zostanie zniszczona. Wysłać mimo to?',
      )
    ) {
      return
    }
    const ok = ctx.onAttack(ctx.activeVillageId.value, barb.id, army)
    if (ok) {
      msg.textContent = 'Wysłano wyprawę: ' + barb.name + '.'
      for (const id of UNIT_IDS) armyPicks[id].input.value = '0'
    } else {
      msg.textContent = 'Nie udało się wysłać wyprawy.'
    }
    update()
  })

  // ---- Bounded rebuilds (only when their content signature changes) --------
  let barbNodes: BarbNodeRefs[] = []
  let barbSig = ''

  /** Target on-screen diameter (px) for a node's transparent hit area (touch). */
  const HIT_TARGET_PX = 40
  /**
   * Resize each node's transparent hit circle so it stays ~HIT_TARGET_PX wide on
   * SCREEN regardless of zoom (radius in world units = px ÷ current px-per-field),
   * never smaller than the visible dot and capped so it can't swallow the whole map.
   * Cheap (~125 setAttributes) and only called on zoom / resize / rebuild — not pan.
   */
  const updateHitRadii = (): void => {
    const w = svgEl.clientWidth
    if (w <= 0) return
    const worldPerPx = viewW / w
    const target = (HIT_TARGET_PX / 2) * worldPerPx
    for (const node of barbNodes) {
      const r = Math.max(barbRadius(node.barb.level), Math.min(target, 12))
      node.hit.setAttribute('r', fmt2(r))
    }
  }

  /** Move keyboard focus to a node by id (roving tabindex keeps exactly one tabbable). */
  const focusNode = (id: string): void => {
    const ref = barbNodes.find((n) => n.barb.id === id)
    if (ref) ref.g.focus()
  }
  /** Pan the minimum needed so point `b` sits comfortably inside the viewBox. */
  const ensureVisible = (b: { x: number; y: number }): void => {
    const mx = (viewW / 2) * 0.85
    const my = (viewH / 2) * 0.85
    let moved = false
    if (b.x < viewCx - mx || b.x > viewCx + mx) {
      viewCx = clampCenter(b.x)
      moved = true
    }
    if (b.y < viewCy - my || b.y > viewCy + my) {
      viewCy = clampCenter(b.y)
      moved = true
    }
    if (moved) applyView()
  }
  /** Select a target by id, keep it on screen (so focus is never off-viewBox), refresh. */
  const selectAndReveal = (id: string, focus: boolean): void => {
    selectedId = id
    const b = barbarianById(ctx.store.state.world, id)
    if (b) ensureVisible(b)
    update()
    if (focus) focusNode(id)
  }
  /** Nearest barbarian from `from` inside a 90° cone toward screen direction (dx,dy). */
  const nearestInDirection = (
    from: BarbarianVillage,
    dx: number,
    dy: number,
  ): BarbarianVillage | undefined => {
    let best: BarbarianVillage | undefined
    let bestD = Infinity
    for (const node of barbNodes) {
      const b = node.barb
      if (b.id === from.id) continue
      const vx = b.x - from.x
      const vy = b.y - from.y
      if (dx !== 0) {
        if (Math.sign(vx) !== dx || Math.abs(vx) < Math.abs(vy)) continue
      } else {
        if (Math.sign(vy) !== dy || Math.abs(vy) < Math.abs(vx)) continue
      }
      const d = vx * vx + vy * vy
      if (d < bestD) {
        bestD = d
        best = b
      }
    }
    return best
  }

  /** Rebuild the barbarian node set when the world changes (e.g. a save import). */
  const rebuildBarbs = (): void => {
    const s = ctx.store.state
    const sig = s.seed + ':' + s.world.barbarians.length
    if (sig === barbSig) return
    barbSig = sig
    barbsGroup.textContent = ''
    barbNodes = []
    for (const barb of s.world.barbarians) {
      const g = document.createElementNS(SVG_NS, 'g') as SVGGElement
      g.setAttribute('class', 'map-node map-node--barb')
      g.setAttribute('role', 'button')
      // Roving tabindex: only the selected/entry node is tabbable (set in update),
      // so a keyboard user doesn't traverse all ~125 nodes to reach the controls.
      g.setAttribute('tabindex', '-1')
      const r = barbRadius(barb.level)
      // Transparent, screen-sized hit circle FIRST (under the dot) so taps meet the
      // touch-target minimum without enlarging the visible dot. Inherits stroke/fill
      // from .map-node--barb, so both are explicitly cleared. Radius set by updateHitRadii.
      const hit = svg('circle', {
        cx: String(barb.x),
        cy: String(barb.y),
        r: String(r * 2),
        class: 'map-node-hit',
      }) as SVGCircleElement
      hit.style.fill = 'transparent'
      hit.style.stroke = 'none'
      hit.style.pointerEvents = 'all'
      const circle = svg('circle', {
        cx: String(barb.x),
        cy: String(barb.y),
        r: String(r),
        class: 'map-node-dot',
      })
      // Tier intensity via fill-opacity on the token hue (--bad from CSS): higher
      // tiers brighter, never a hardcoded colour.
      circle.setAttribute('fill-opacity', String(barbOpacity(barb.level)))
      circle.setAttribute('vector-effect', 'non-scaling-stroke')
      const title = document.createElementNS(SVG_NS, 'title')
      g.appendChild(hit)
      g.appendChild(circle)
      g.appendChild(title)
      g.addEventListener('click', () => select(barb.id))
      g.addEventListener('keydown', (e: KeyboardEvent) => {
        if (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') {
          e.preventDefault()
          selectAndReveal(barb.id, false)
          return
        }
        let dx = 0
        let dy = 0
        switch (e.key) {
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
        e.preventDefault()
        const next = nearestInDirection(barb, dx, dy)
        if (next) selectAndReveal(next.id, true)
      })
      barbsGroup.appendChild(g)
      barbNodes.push({ g, title, hit, barb })
    }
    updateHitRadii()
  }

  let playerSig = ''
  /** Rebuild the player-village shields when the village set/coords change. */
  const rebuildPlayers = (): void => {
    const s = ctx.store.state
    let sig = ''
    for (const id of s.villageOrder) {
      const v = s.villages[id]
      sig += id + ':' + (v ? v.x + ',' + v.y : 'x') + '|'
    }
    if (sig === playerSig) return
    playerSig = sig
    playersGroup.textContent = ''
    const size = 9
    for (const id of s.villageOrder) {
      const v = s.villages[id]
      if (!v) continue
      const g = document.createElementNS(SVG_NS, 'g') as SVGGElement
      g.setAttribute('class', 'map-node map-node--player')
      const shield = shieldIcon()
      shield.setAttribute('x', String(v.x - size / 2))
      shield.setAttribute('y', String(v.y - size / 2))
      shield.setAttribute('width', String(size))
      shield.setAttribute('height', String(size))
      const title = document.createElementNS(SVG_NS, 'title')
      title.textContent = v.name
      g.appendChild(shield)
      g.appendChild(title)
      playersGroup.appendChild(g)
    }
  }

  let marchRefs: MarchRefs[] = []
  let marchSig = ''
  /** Rebuild the active village's march lines when their composition/target changes. */
  const rebuildMarches = (v: Village): void => {
    const sig = v.id +
      '#' +
      v.marches
        .map(
          (m) =>
            m.targetX +
            ',' +
            m.targetY +
            ':' +
            m.phase +
            ':' +
            UNIT_IDS.map((id) => m.units[id]).join(','),
        )
        .join('|')
    if (sig === marchSig) return
    marchSig = sig
    marchesGroup.textContent = ''
    marchRefs = []
    for (const m of v.marches) {
      const line = svg('line', {
        x1: String(v.x),
        y1: String(v.y),
        x2: String(m.targetX),
        y2: String(m.targetY),
        class: 'map-march ' + (m.phase === 'returning' ? 'is-returning' : 'is-outbound'),
      })
      line.setAttribute('vector-effect', 'non-scaling-stroke')
      const marker = svg('circle', {
        cx: String(v.x),
        cy: String(v.y),
        r: '2.4',
        class: 'map-march-marker ' + (m.phase === 'returning' ? 'is-returning' : 'is-outbound'),
      })
      marker.setAttribute('vector-effect', 'non-scaling-stroke')
      marchesGroup.appendChild(line)
      marchesGroup.appendChild(marker)
      // outbound: village → target; returning: target → village.
      if (m.phase === 'returning') {
        marchRefs.push({ marker, fromX: m.targetX, fromY: m.targetY, toX: v.x, toY: v.y })
      } else {
        marchRefs.push({ marker, fromX: v.x, fromY: v.y, toX: m.targetX, toY: m.targetY })
      }
    }
  }

  // Per-frame: slide each march marker to its current progress along its line. Takes the
  // aggregated tech mods so the denominator (total travel time) matches the tech-discounted
  // time the march was actually dispatched with — otherwise the marker progress would drift.
  const updateMarchMarkers = (v: Village, mods: TechModifiers): void => {
    for (let i = 0; i < marchRefs.length && i < v.marches.length; i++) {
      const ref = marchRefs[i]
      const m = v.marches[i]
      const total = marchTime(v, { x: m.targetX, y: m.targetY }, m.units, mods)
      const prog = total > 0 ? Math.max(0, Math.min(1, 1 - m.remaining / total)) : 1
      ref.marker.setAttribute('cx', fmt2(ref.fromX + (ref.toX - ref.fromX) * prog))
      ref.marker.setAttribute('cy', fmt2(ref.fromY + (ref.toY - ref.fromY) * prog))
    }
  }

  // aria-labels carry tier + distance from the active village; they change only on a
  // village switch / move, so refresh them only when that signature changes.
  let ariaSig = ''
  const refreshAria = (v: Village): void => {
    const sig = v.id + ':' + v.x + ',' + v.y
    if (sig === ariaSig) return
    ariaSig = sig
    for (const node of barbNodes) {
      const dist = distance(v.x, v.y, node.barb.x, node.barb.y)
      const label =
        node.barb.name +
        ', poziom ' +
        node.barb.level +
        ', odległość ' +
        formatNumber(dist, 1) +
        ' pól od aktywnej wioski. Naciśnij Enter, aby wybrać i zaplanować atak.'
      node.g.setAttribute('aria-label', label)
      node.title.textContent =
        node.barb.name + ' (poz. ' + node.barb.level + ') · ' + formatNumber(dist, 1) + ' pól'
    }
  }

  // ---- Reactivity ----------------------------------------------------------
  const update = (): void => {
    const v = activeVillage()
    const world = ctx.store.state.world
    // Account-wide tech mods, computed once per frame and threaded into every display
    // estimate (march time, attack forecast) so what the map shows matches a dispatch.
    const mods = aggregateTechMods(ctx.store.state.tech)

    rebuildBarbs()
    rebuildPlayers()
    refreshAria(v)
    rebuildMarches(v)
    updateMarchMarkers(v, mods)
    applyView()

    // Drop a selection whose target no longer exists (e.g. after a save import).
    if (selectedId !== null && barbarianById(world, selectedId) === undefined) {
      selectedId = null
    }
    // Auto-focus the nearest target so the card is useful the moment the tab opens —
    // but NOT on narrow viewports, where the detail bottom-sheet would cover most of
    // the (short) map before any interaction; there the user taps a node to open it.
    if (selectedId === null && !isNarrow()) {
      const nearest = targetsByDistance(v, world)[0]
      selectedId = nearest ? nearest.id : null
    }

    // Selection highlight + roving tabindex: exactly ONE node is keyboard-tabbable
    // (the selection, else the first node as an entry point), so Tab reaches the
    // controls/Attack without walking every node (the full list lives in „Wyprawy").
    const tabTarget = selectedId ?? (world.barbarians[0] ? world.barbarians[0].id : null)
    for (const node of barbNodes) {
      node.g.classList.toggle('is-selected', node.barb.id === selectedId)
      node.g.setAttribute('tabindex', node.barb.id === tabTarget ? '0' : '-1')
    }
    const selected = selectedId ? barbarianById(world, selectedId) : undefined
    if (selected) {
      selRing.setAttribute('cx', String(selected.x))
      selRing.setAttribute('cy', String(selected.y))
      selRing.setAttribute('r', fmt2(barbRadius(selected.level) + 1.6))
      selRing.style.display = ''
    } else {
      selRing.style.display = 'none'
    }

    // Active-village ring.
    activeRing.setAttribute('cx', String(v.x))
    activeRing.setAttribute('cy', String(v.y))
    activeRing.setAttribute('r', '6.5')
    activeRing.style.display = ''

    // Detail card.
    if (!selected) {
      emptyEl.style.display = ''
      body.style.display = 'none'
      nameEl.textContent = 'Brak celu'
      levelEl.textContent = ''
      return
    }
    emptyEl.style.display = 'none'
    body.style.display = ''

    const army = readArmy(v)
    const composed = armySize(army)
    const home = stationedUnits(v)
    const target = barbarianTarget(selected.level)

    nameEl.textContent = selected.name
    levelEl.textContent = 'poz. ' + selected.level
    defVal.textContent = formatInt(target.defensePower)

    const totalLoot = totalLootOf(selected.level)
    if (composed > 0) {
      const cd = D(armyCarry(army))
      const haul = cd.lt(totalLoot) ? cd : totalLoot
      lootVal.textContent = formatInt(haul)
    } else {
      lootVal.textContent = 'do ' + formatNumber(totalLoot)
    }

    distVal.textContent = formatNumber(distance(v.x, v.y, selected.x, selected.y), 1) + ' pól'
    timeVal.textContent = composed > 0 ? formatTime(marchTime(v, selected, army, mods)) : '—'

    // Loyalty (live: regenerates every tick) + conquest hint. The numeric stat and
    // the bar both carry the value; the hint adapts to whether the active village can
    // yet field a Szlachcic (academy unlocked).
    loyaltyVal.textContent = Math.round(selected.loyalty) + ' / 100'
    setLoyaltyBar(loyaltyBar, selected.loyalty)
    // Shared, constant-sourced hint (kept in lockstep with the Wyprawy tab via
    // ../conquestCopy): states the per-win loyalty drop AND that loyalty regenerates,
    // adapting to whether this village can yet field a Szlachcic (academy unlocked).
    conquestHint.textContent = conquestHintText(unitUnlocked(v, 'noble'))

    if (composed > 0) {
      const oc = battleOutcome(armyAttackPower(army, mods), target.defensePower)
      const pct = Math.round(oc.attackerLossFrac * 100)
      setForecast(oc.attackerWins ? '✓ wygrana · straty ~' + pct + '%' : '✗ porażka')
      forecast.classList.toggle('forecast-win', oc.attackerWins)
      forecast.classList.toggle('forecast-lose', !oc.attackerWins)
    } else {
      setForecast('Wybierz jednostki, aby zobaczyć prognozę.')
      forecast.classList.remove('forecast-win', 'forecast-lose')
    }

    // Composer availability + clamp any over-cap entry down to the garrison.
    for (const id of UNIT_IDS) {
      const pick = armyPicks[id]
      pick.avail.textContent = 'dostępne: ' + formatInt(home[id])
      pick.input.max = String(home[id])
      pick.input.disabled = home[id] <= 0
      const cur = Math.floor(Number(pick.input.value))
      if (Number.isFinite(cur) && cur > home[id]) pick.input.value = String(home[id])
    }

    let homeSum = 0
    for (const id of UNIT_IDS) homeSum += home[id]
    sendAllBtn.disabled = homeSum <= 0
    clearBtn.disabled = composed <= 0

    // aria-disabled (not `disabled`) keeps the button focusable so its reason reaches
    // the user; the click handler is a guarded no-op when canAttack rejects.
    const verdict = canAttack(v, selected, army)
    attackBtn.setAttribute('aria-disabled', verdict.ok ? 'false' : 'true')
    attackBtn.title = verdict.ok ? '' : (verdict.reason ?? '')
    attackBtn.setAttribute('aria-label', 'Atakuj: ' + selected.name + ' (poziom ' + selected.level + ')')
  }

  return { el, update }
}
