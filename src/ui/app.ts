import { effect } from '../engine/store'
import { RESOURCE_IDS } from '../engine/state'
import { formatNumber, formatRate, formatTime } from '../engine/format'
import type { GameStore } from '../engine/state'
import type { GameBus } from '../engine/eventbus'

/**
 * Root view. Vanilla TS + DOM, no framework. Built once with createElement /
 * textContent (never innerHTML with data), then a single reactive effect pokes
 * cached element references on every store revision — the DOM tree is never
 * rebuilt per frame.
 *
 * Hard rules honoured here:
 * - Zero external assets: every icon is procedural inline SVG (createElementNS).
 * - Decimal economy: values are formatted via the engine's formatters, never
 *   coerced through `number` arithmetic except the clamped bar percentage.
 */

export interface AppContext {
  store: GameStore
  bus: GameBus
  onExport: () => string
  onImport: (s: string) => boolean
  onReset: () => void
  version: string
  offlineSeconds: number
}

const SVG_NS = 'http://www.w3.org/2000/svg'

/** Polish display names per resource id. */
const RESOURCE_NAMES: Record<string, string> = {
  wood: 'Drewno',
  clay: 'Glina',
  iron: 'Żelazo',
}

/** Cached, per-frame-updated handles for one resource row. */
interface ResourceRefs {
  value: HTMLElement
  rate: HTMLElement
  bar: HTMLElement
}

/** Create an HTML element with optional class and text content. */
function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

/** Create an SVG element and apply a flat attribute map. */
function svg(tag: string, attrs: Record<string, string>): SVGElement {
  const node = document.createElementNS(SVG_NS, tag)
  for (const key in attrs) node.setAttribute(key, attrs[key])
  return node
}

/** Wrap procedural SVG children into a labelled, decorative-safe icon. */
function svgIcon(
  viewBox: string,
  label: string,
  className: string,
  children: SVGElement[],
): SVGSVGElement {
  const root = document.createElementNS(SVG_NS, 'svg') as SVGSVGElement
  root.setAttribute('viewBox', viewBox)
  root.setAttribute('class', className)
  root.setAttribute('role', 'img')
  root.setAttribute('aria-label', label)
  root.setAttribute('focusable', 'false')
  for (const child of children) root.appendChild(child)
  return root
}

/** Procedural heraldic shield for the header. */
function shieldIcon(): SVGSVGElement {
  const face = svg('path', {
    d: 'M24 3 7 9v13c0 11 8 17 17 21 9-4 17-10 17-21V9z',
    fill: '#d9a441',
  })
  const shade = svg('path', {
    d: 'M24 3 7 9v13c0 11 8 17 17 21V3z',
    fill: '#b9852f',
  })
  const band = svg('path', {
    d: 'M7 19h34v5H7z',
    fill: '#1a1410',
    'fill-opacity': '0.22',
  })
  const boss = svg('path', {
    d: 'M24 13l7 6-7 6-7-6z',
    fill: '#3a2a17',
    'fill-opacity': '0.55',
  })
  return svgIcon('0 0 48 48', 'Tarcza plemienna', 'shield', [face, shade, band, boss])
}

/** Procedural resource icon (wood log / clay brick / iron ingot). */
function resourceIcon(id: string): SVGSVGElement {
  if (id === 'wood') {
    const body = svg('rect', { x: '5', y: '8', width: '15', height: '8', rx: '4', fill: '#8a5a2b' })
    const endFace = svg('ellipse', { cx: '5', cy: '12', rx: '2', ry: '4', fill: '#a96f3a' })
    const ring = svg('ellipse', {
      cx: '5',
      cy: '12',
      rx: '1',
      ry: '2',
      fill: 'none',
      stroke: '#6b431d',
      'stroke-width': '0.8',
    })
    return svgIcon('0 0 24 24', RESOURCE_NAMES[id], 'res-icon', [body, endFace, ring])
  }
  if (id === 'clay') {
    const block = svg('rect', { x: '3', y: '7', width: '18', height: '10', rx: '1.5', fill: '#c1663b' })
    const groove = (d: string): SVGElement =>
      svg('path', { d, stroke: '#7e3d22', 'stroke-width': '1', fill: 'none' })
    return svgIcon('0 0 24 24', RESOURCE_NAMES[id], 'res-icon', [
      block,
      groove('M3 12h18'),
      groove('M12 7v5'),
      groove('M8 12v5'),
      groove('M16 12v5'),
    ])
  }
  // iron ingot
  const body = svg('path', { d: 'M5 16 19 16 17 9 7 9Z', fill: '#9aa3ad' })
  const top = svg('path', { d: 'M7 9 17 9 15.5 7 8.5 7Z', fill: '#c6cdd5' })
  const shine = svg('path', { d: 'M8 14 16 14', stroke: '#6b7682', 'stroke-width': '1', fill: 'none' })
  return svgIcon('0 0 24 24', RESOURCE_NAMES[id], 'res-icon', [body, top, shine])
}

/**
 * Mount the application UI into `root`. Builds the static DOM once, wires
 * interactions, then subscribes a single effect that refreshes live values.
 */
export function mountApp(root: HTMLElement, ctx: AppContext): void {
  const state = ctx.store.state
  const container = h('div', 'container')

  // ---- a) Header: procedural shield + title + seed subtitle -----------------
  const header = h('header', 'app-header')
  const mark = h('span', 'brand-mark')
  mark.setAttribute('aria-hidden', 'false')
  mark.appendChild(shieldIcon())
  const brandText = h('div', 'brand-text')
  brandText.appendChild(h('h1', 'brand-title', 'TW Incremental'))
  brandText.appendChild(h('p', 'subtitle muted', 'osada • seed: ' + state.seed))
  header.appendChild(mark)
  header.appendChild(brandText)
  container.appendChild(header)

  // ---- b) Resources panel ---------------------------------------------------
  const resPanel = h('section', 'panel')
  resPanel.setAttribute('aria-labelledby', 'res-title')
  const resTitle = h('h2', 'panel-title', 'Surowce')
  resTitle.id = 'res-title'
  resPanel.appendChild(resTitle)

  const refs: Record<string, ResourceRefs> = {}

  for (const id of RESOURCE_IDS) {
    const row = h('div', 'resource-row')

    const iconWrap = h('span', 'res-icon-wrap')
    iconWrap.appendChild(resourceIcon(id))

    const name = h('span', 'res-label', RESOURCE_NAMES[id])

    const value = h('span', 'num res-value')
    const rate = h('span', 'num muted res-rate')

    const bar = h('div', 'bar')
    bar.setAttribute('role', 'progressbar')
    bar.setAttribute('aria-valuemin', '0')
    bar.setAttribute('aria-valuemax', '100')
    bar.setAttribute('aria-label', 'Zapełnienie magazynu: ' + RESOURCE_NAMES[id])
    const barFill = h('i')
    bar.appendChild(barFill)

    row.appendChild(iconWrap)
    row.appendChild(name)
    row.appendChild(value)
    row.appendChild(rate)
    row.appendChild(bar)
    resPanel.appendChild(row)

    refs[id] = { value, rate, bar }
  }
  container.appendChild(resPanel)

  // ---- c) Save panel: export / import / reset -------------------------------
  const savePanel = h('section', 'panel')
  savePanel.setAttribute('aria-labelledby', 'save-title')
  const saveTitle = h('h2', 'panel-title', 'Zapis')
  saveTitle.id = 'save-title'
  savePanel.appendChild(saveTitle)

  const msg = h('p', 'save-msg muted', 'Eksportuj kod zapisu lub wczytaj istniejący.')
  msg.setAttribute('role', 'status')
  msg.setAttribute('aria-live', 'polite')

  const exportArea = h('textarea', 'save-area')
  exportArea.readOnly = true
  exportArea.rows = 3
  exportArea.setAttribute('aria-label', 'Wyeksportowany kod zapisu')
  exportArea.placeholder = 'Tu pojawi się wyeksportowany kod…'

  const exportBtn = h('button', 'btn', 'Eksportuj')
  exportBtn.type = 'button'
  exportBtn.addEventListener('click', () => {
    exportArea.value = ctx.onExport()
    exportArea.focus()
    exportArea.select()
    msg.textContent = 'Skopiuj zaznaczony kod, aby zachować postęp.'
  })

  const importArea = h('textarea', 'save-area')
  importArea.rows = 3
  importArea.setAttribute('aria-label', 'Kod zapisu do wczytania')
  importArea.placeholder = 'Wklej kod zapisu, aby go wczytać…'

  const importBtn = h('button', 'btn', 'Importuj')
  importBtn.type = 'button'
  importBtn.addEventListener('click', () => {
    const ok = ctx.onImport(importArea.value)
    msg.textContent = ok ? 'Wczytano zapis.' : 'Niepoprawny kod zapisu.'
  })

  const resetBtn = h('button', 'btn btn-danger', 'Reset')
  resetBtn.type = 'button'
  resetBtn.addEventListener('click', () => {
    if (window.confirm('Na pewno zresetować grę? Cały postęp zostanie bezpowrotnie utracony.')) {
      ctx.onReset()
    }
  })

  const exportRow = h('div', 'save-actions')
  exportRow.appendChild(exportBtn)
  const importRow = h('div', 'save-actions')
  importRow.appendChild(importBtn)
  const resetRow = h('div', 'save-actions')
  resetRow.appendChild(resetBtn)

  savePanel.appendChild(exportRow)
  savePanel.appendChild(exportArea)
  savePanel.appendChild(importArea)
  savePanel.appendChild(importRow)
  savePanel.appendChild(msg)
  savePanel.appendChild(resetRow)
  container.appendChild(savePanel)

  // ---- d) Footer ------------------------------------------------------------
  const footerText =
    'wersja ' +
    ctx.version +
    (ctx.offlineSeconds > 0 ? ' • offline: ' + formatTime(ctx.offlineSeconds) : '')
  container.appendChild(h('footer', 'app-footer muted', footerText))

  root.appendChild(container)

  // ---- Reactivity: refresh cached nodes on each store revision --------------
  const update = (): void => {
    const s = ctx.store.state
    for (const id of RESOURCE_IDS) {
      const ref = refs[id]
      ref.value.textContent = formatNumber(s.resources[id])
      ref.rate.textContent = formatRate(s.production[id])
      const cap = s.storageCap
      let pct = 0
      if (cap.gt(0)) {
        const raw = s.resources[id].div(cap).mul(100).toNumber()
        pct = Number.isFinite(raw) ? Math.max(0, Math.min(100, raw)) : 100
      }
      const barFill = ref.bar.firstElementChild as HTMLElement | null
      if (barFill) barFill.style.width = pct + '%'
      ref.bar.setAttribute('aria-valuenow', Math.round(pct).toString())
    }
  }

  effect(() => {
    void ctx.store.rev.value
    update()
  })
}
