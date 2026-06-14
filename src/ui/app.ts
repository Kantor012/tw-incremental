import { effect } from '../engine/store'
import { RESOURCE_IDS, type ResourceId } from '../engine/state'
import { formatNumber, formatInt, formatRate, formatTime } from '../engine/format'
import type { GameStore, GameState } from '../engine/state'
import type { GameBus } from '../engine/eventbus'
import { D } from '../engine/decimal'
import { BUILDING_IDS, BUILDINGS, type BuildingId } from '../content/buildings'
import { UNIT_IDS, UNITS, type UnitId } from '../content/units'
import { barbarianTarget, MAX_TARGET_LEVEL } from '../content/barbarians'
import { nextCostAffordable } from '../systems/buildings'
import {
  barracksUnlocked,
  canRecruit,
  recruitCost,
  recruitSpeedMult,
  freePopulation,
  usedPopulation,
} from '../systems/recruitment'
import {
  armyAttackPower,
  armyDefensePower,
  armyCarry,
  battleOutcome,
} from '../systems/combat'
import { stationedUnits, marchTime, canAttack } from '../systems/marches'
import { raidPower } from '../systems/raids'

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
  /** Upgrade one building level; returns true on success (spent + level++). */
  onBuild: (id: BuildingId) => boolean
  /** Queue `count` of a unit for training; returns true on success (spent + enqueued). */
  onRecruit: (id: UnitId, count: number) => boolean
  /**
   * Dispatch an army at a barbarian camp of `targetLevel`; returns true on a
   * successful send (the march is queued and the dispatched units leave the home
   * garrison until they return). Rejected (false) when {@link canAttack} fails.
   */
  onAttack: (targetLevel: number, units: Record<UnitId, number>) => boolean
  version: string
  offlineSeconds: number
}

const SVG_NS = 'http://www.w3.org/2000/svg'

/**
 * Polish display names per resource id. Keyed by ResourceId (not `string`) so
 * adding a 4th resource to RESOURCE_IDS is a COMPILE error here until its name is
 * supplied — never a silent runtime `undefined` label. Mirrors the exhaustive
 * discipline of {@link unitIcon}.
 */
const RESOURCE_NAMES: Record<ResourceId, string> = {
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

/** Cached handles for one building row (level / cost / affordability / button). */
interface BuildingRefs {
  level: HTMLElement
  /** Wrapper holding the per-resource cost chips (hidden when maxed). */
  cost: HTMLElement
  /** "Maks." marker shown in place of the cost when at maxLevel. */
  maxed: HTMLElement
  /**
   * Per-resource cost chip: `item` toggles the "short" state, `val` holds the
   * number, `mark` is a visually-hidden text cue read by assistive tech (the
   * shortfall must not be conveyed by colour alone — WCAG 1.4.1).
   */
  costItems: Record<ResourceId, { item: HTMLElement; val: HTMLElement; mark: HTMLElement }>
  button: HTMLButtonElement
}

/** Cached handles for the derived-stats summary (storage / population / production). */
interface StatRefs {
  storage: HTMLElement
  pop: HTMLElement
  prod: Record<ResourceId, HTMLElement>
}

/** Cached handles for one unit row (owned / cost chips / training time / controls). */
interface UnitRowRefs {
  owned: HTMLElement
  time: HTMLElement
  input: HTMLInputElement
  button: HTMLButtonElement
  /** Quantity steppers (+1/+10) — disabled together with the row when locked. */
  steppers: HTMLButtonElement[]
  /**
   * Per-resource cost chip handles (mirrors the buildings panel). `val` holds the
   * TOTAL cost for the typed count, recomputed every frame in update() so the
   * displayed cost / shortfall always agrees with the button's canRecruit verdict.
   */
  costItems: Record<ResourceId, { item: HTMLElement; val: HTMLElement; mark: HTMLElement }>
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

/**
 * Procedural resource icon (wood log / clay brick / iron ingot).
 *
 * EXHAUSTIVE over ResourceId on purpose (mirrors {@link unitIcon}): adding a
 * resource to RESOURCE_IDS without an icon branch here is a COMPILE error (the
 * `never` assignment in `default`), not a silent fallback to the iron glyph. This
 * keeps the data-driven contract — "adding a resource is a data edit" — honest for
 * the UI: the new resource must be given an explicit icon + name, never mislabelled.
 */
function resourceIcon(id: ResourceId): SVGSVGElement {
  switch (id) {
    case 'wood': {
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
    case 'clay': {
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
    case 'iron': {
      const body = svg('path', { d: 'M5 16 19 16 17 9 7 9Z', fill: '#9aa3ad' })
      const top = svg('path', { d: 'M7 9 17 9 15.5 7 8.5 7Z', fill: '#c6cdd5' })
      const shine = svg('path', { d: 'M8 14 16 14', stroke: '#6b7682', 'stroke-width': '1', fill: 'none' })
      return svgIcon('0 0 24 24', RESOURCE_NAMES[id], 'res-icon', [body, top, shine])
    }
    default: {
      const _exhaustive: never = id
      throw new Error('Brak ikony dla surowca: ' + String(_exhaustive))
    }
  }
}

/**
 * Procedural unit icon (spear / sword / axe), drawn entirely in SVG.
 *
 * EXHAUSTIVE over UnitId on purpose: adding a unit to units.ts without an icon
 * branch here is a COMPILE error (the `never` assignment in `default`), not a
 * silent fallback to the axe glyph. This keeps the units.ts contract — "adding a
 * unit is a data edit, never an engine edit" — honest for the UI layer too: the
 * new unit must be given an explicit icon decision rather than mislabelled.
 */
function unitIcon(id: UnitId): SVGSVGElement {
  switch (id) {
    case 'spearman': {
      const shaft = svg('rect', { x: '11', y: '4', width: '2', height: '17', fill: '#8a5a2b' })
      const head = svg('path', { d: 'M12 1 15 7 9 7Z', fill: '#c6cdd5' })
      return svgIcon('0 0 24 24', UNITS[id].name, 'unit-icon', [shaft, head])
    }
    case 'swordsman': {
      const blade = svg('path', { d: 'M11 2 13 2 13 16 12 18 11 16Z', fill: '#c6cdd5' })
      const guard = svg('rect', { x: '8', y: '15', width: '8', height: '2', rx: '0.5', fill: '#d9a441' })
      const hilt = svg('rect', { x: '11', y: '17', width: '2', height: '5', rx: '0.8', fill: '#8a5a2b' })
      return svgIcon('0 0 24 24', UNITS[id].name, 'unit-icon', [blade, guard, hilt])
    }
    case 'axeman': {
      const handle = svg('rect', { x: '11', y: '3', width: '2', height: '18', fill: '#8a5a2b' })
      const head = svg('path', { d: 'M13 4 20 6 20 11 13 12Z', fill: '#9aa3ad' })
      const edge = svg('path', { d: 'M20 6 20 11', stroke: '#c6cdd5', 'stroke-width': '1', fill: 'none' })
      return svgIcon('0 0 24 24', UNITS[id].name, 'unit-icon', [handle, head, edge])
    }
    default: {
      const _exhaustive: never = id
      throw new Error('Brak ikony dla jednostki: ' + String(_exhaustive))
    }
  }
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

  // ---- c) Buildings panel ---------------------------------------------------
  const buildPanel = h('section', 'panel')
  buildPanel.setAttribute('aria-labelledby', 'build-title')
  const buildTitle = h('h2', 'panel-title', 'Budynki')
  buildTitle.id = 'build-title'
  buildPanel.appendChild(buildTitle)

  // Derived-stats summary (storage cap, population cap, production per resource).
  const stats = h('div', 'building-stats')
  const mkStat = (label: string): { wrap: HTMLElement; val: HTMLElement } => {
    const wrap = h('div', 'stat')
    wrap.appendChild(h('span', 'stat-label muted', label))
    const val = h('span', 'num stat-val')
    wrap.appendChild(val)
    return { wrap, val }
  }
  const storageStat = mkStat('Magazyn')
  const popStat = mkStat('Populacja')
  stats.appendChild(storageStat.wrap)
  stats.appendChild(popStat.wrap)
  const prodStats: Record<ResourceId, HTMLElement> = {} as Record<ResourceId, HTMLElement>
  for (const id of RESOURCE_IDS) {
    const st = mkStat(RESOURCE_NAMES[id] + '/s')
    prodStats[id] = st.val
    stats.appendChild(st.wrap)
  }
  const statRefs: StatRefs = { storage: storageStat.val, pop: popStat.val, prod: prodStats }
  buildPanel.appendChild(stats)

  const bRefs: Record<string, BuildingRefs> = {}

  for (const id of BUILDING_IDS) {
    const def = BUILDINGS[id]
    const row = h('div', 'building')

    const head = h('div', 'building-head')
    head.appendChild(h('span', 'building-name', def.name))
    const levelEl = h('span', 'building-level num')
    head.appendChild(levelEl)

    const desc = h('p', 'building-desc muted', def.desc)

    const costWrap = h('div', 'building-cost')
    const costItems: Record<
      ResourceId,
      { item: HTMLElement; val: HTMLElement; mark: HTMLElement }
    > = {} as Record<ResourceId, { item: HTMLElement; val: HTMLElement; mark: HTMLElement }>
    for (const r of RESOURCE_IDS) {
      const item = h('span', 'cost-item')
      item.appendChild(h('span', 'cost-label', RESOURCE_NAMES[r]))
      const val = h('span', 'num cost-val')
      item.appendChild(val)
      // Visually-hidden, AT-only shortfall cue (text, not colour).
      const mark = h('span', 'visually-hidden')
      item.appendChild(mark)
      costWrap.appendChild(item)
      costItems[r] = { item, val, mark }
    }

    const maxedLabel = h('span', 'building-maxed', 'Maks.')
    maxedLabel.hidden = true

    const button = h('button', 'btn', 'Rozbuduj')
    button.type = 'button'
    button.setAttribute('aria-label', 'Rozbuduj: ' + def.name)
    button.addEventListener('click', () => {
      ctx.onBuild(id)
      update()
    })

    row.appendChild(head)
    row.appendChild(desc)
    row.appendChild(costWrap)
    row.appendChild(maxedLabel)
    row.appendChild(button)
    buildPanel.appendChild(row)

    bRefs[id] = { level: levelEl, cost: costWrap, maxed: maxedLabel, costItems, button }
  }
  container.appendChild(buildPanel)

  // ---- c2) Recruitment panel ------------------------------------------------
  const recPanel = h('section', 'panel')
  recPanel.setAttribute('aria-labelledby', 'recruit-title')
  const recTitle = h('h2', 'panel-title', 'Rekrutacja')
  recTitle.id = 'recruit-title'
  recPanel.appendChild(recTitle)

  // Unlock / free-population status line (live).
  const recStatus = h('p', 'recruit-status muted')
  recStatus.setAttribute('role', 'status')
  recStatus.setAttribute('aria-live', 'polite')
  recPanel.appendChild(recStatus)

  // Population usage bar (usedPopulation / popCap) — visual companion to the
  // status text. Updated reactively; never the sole carrier of information.
  const popBar = h('div', 'bar recruit-pop')
  popBar.setAttribute('role', 'progressbar')
  popBar.setAttribute('aria-valuemin', '0')
  popBar.setAttribute('aria-valuemax', '100')
  popBar.setAttribute('aria-label', 'Wykorzystanie populacji')
  popBar.appendChild(h('i'))
  recPanel.appendChild(popBar)

  // Feedback for the last recruit attempt (success or the canRecruit reason).
  const recMsg = h('p', 'recruit-msg muted')
  recMsg.setAttribute('role', 'status')
  recMsg.setAttribute('aria-live', 'polite')

  const uRefs: Record<string, UnitRowRefs> = {}

  for (const id of UNIT_IDS) {
    const def = UNITS[id]
    const row = h('div', 'unit-row')

    const head = h('div', 'building-head')
    const nameWrap = h('span', 'building-name')
    const iconWrap = h('span', 'res-icon-wrap')
    iconWrap.appendChild(unitIcon(id))
    nameWrap.appendChild(iconWrap)
    nameWrap.appendChild(document.createTextNode(' ' + def.name))
    head.appendChild(nameWrap)
    const owned = h('span', 'building-level num')
    head.appendChild(owned)

    const desc = h('p', 'building-desc muted', def.desc)

    // Combat stats (stored now, used by the M1.3 battle system) — shown for flavour.
    const statLine = h(
      'p',
      'unit-stats muted',
      `Atak ${def.attack} · Obr. piech. ${def.defInfantry} · Obr. kaw. ${def.defCavalry} · ` +
        `Udźwig ${def.carry} · Pop. ${def.pop}`,
    )

    // Cost chips. The displayed value is the TOTAL cost for the currently typed
    // count (recomputed in update()), so it agrees with the button's canRecruit
    // check — never showing "affordable" while the button is disabled. The initial
    // text is the count=1 cost; update() overwrites it on the first frame. Shortfall
    // is cued without relying on colour alone (WCAG 1.4.1): the .is-short class adds
    // a ⚠ glyph + bold, a hover title, and a visually-hidden text marker for
    // assistive tech — exactly like the buildings panel.
    const cost = recruitCost(id, 1)
    const costWrap = h('div', 'building-cost')
    const costItems = {} as Record<
      ResourceId,
      { item: HTMLElement; val: HTMLElement; mark: HTMLElement }
    >
    for (const r of RESOURCE_IDS) {
      const item = h('span', 'cost-item')
      item.appendChild(h('span', 'cost-label', RESOURCE_NAMES[r]))
      const val = h('span', 'num cost-val', formatInt(cost[r]))
      item.appendChild(val)
      const mark = h('span', 'visually-hidden')
      item.appendChild(mark)
      costWrap.appendChild(item)
      costItems[r] = { item, val, mark }
    }

    const timeLine = h('p', 'unit-time muted')

    // Controls: quantity input + (+1/+10) steppers + recruit button.
    const controls = h('div', 'recruit-controls')
    const input = h('input', 'recruit-count num')
    input.type = 'number'
    input.min = '1'
    input.step = '1'
    input.value = '1'
    input.inputMode = 'numeric'
    input.setAttribute('aria-label', 'Liczba do wyszkolenia: ' + def.name)

    /** Read the typed quantity, coerced to a positive integer (default 1). */
    const readCount = (): number => {
      const parsed = Math.floor(Number(input.value))
      return Number.isFinite(parsed) && parsed > 0 ? parsed : 1
    }

    const steppers: HTMLButtonElement[] = []
    const mkStep = (delta: number): HTMLButtonElement => {
      const b = h('button', 'btn btn-step', '+' + delta)
      b.type = 'button'
      b.setAttribute('aria-label', '+' + delta + ' do liczby: ' + def.name)
      b.addEventListener('click', () => {
        input.value = String(readCount() + delta)
        update()
      })
      steppers.push(b)
      return b
    }

    const button = h('button', 'btn', 'Rekrutuj')
    button.type = 'button'
    button.setAttribute('aria-label', 'Rekrutuj: ' + def.name)
    // aria-disabled (not the `disabled` property) keeps the control focusable and
    // hoverable so its reason tooltip / aria-live message actually reaches the
    // user; the click handler stays a guarded no-op when recruitment is rejected.
    button.addEventListener('click', () => {
      const cur = ctx.store.state
      const count = readCount()
      const verdict = canRecruit(cur, id, count)
      if (verdict.ok) {
        ctx.onRecruit(id, count)
        recMsg.textContent = 'Rozpoczęto szkolenie: ' + def.name + ' ×' + count + '.'
      } else {
        recMsg.textContent = verdict.reason ?? 'Nie można rekrutować.'
      }
      update()
    })

    // The button's state tracks the *typed* count, which does not bump the store
    // revision — so refresh affordability on direct input too.
    input.addEventListener('input', () => update())

    controls.appendChild(input)
    controls.appendChild(mkStep(1))
    controls.appendChild(mkStep(10))
    controls.appendChild(button)

    row.appendChild(head)
    row.appendChild(desc)
    row.appendChild(statLine)
    row.appendChild(costWrap)
    row.appendChild(timeLine)
    row.appendChild(controls)
    recPanel.appendChild(row)

    uRefs[id] = { owned, time: timeLine, input, button, steppers, costItems }
  }

  // Training queue list (rebuilt only when its content signature changes).
  recPanel.appendChild(h('h3', 'recruit-subtitle', 'Kolejka szkolenia'))
  const queueList = h('ul', 'recruit-queue')
  recPanel.appendChild(queueList)
  recPanel.appendChild(recMsg)
  container.appendChild(recPanel)
  let lastQueueSig = ''

  // ---- c3) Expeditions panel (attacks on barbarian camps) -------------------
  // A fixed window of camp tiers is shown at once; the window slides with the
  // player's reach (see update()), so the DOM rows are built ONCE and only their
  // text/state is poked per frame — the same no-rebuild discipline as everywhere.
  const TARGET_WINDOW = 6

  const expPanel = h('section', 'panel')
  expPanel.setAttribute('aria-labelledby', 'exp-title')
  const expTitle = h('h2', 'panel-title', 'Wyprawy')
  expTitle.id = 'exp-title'
  expPanel.appendChild(expTitle)

  // Unlock / garrison status line (live).
  const expStatus = h('p', 'recruit-status muted')
  expStatus.setAttribute('role', 'status')
  expStatus.setAttribute('aria-live', 'polite')
  expPanel.appendChild(expStatus)

  // Army composer: one count input per unit type + send-all / clear helpers.
  expPanel.appendChild(h('h3', 'recruit-subtitle', 'Skład wyprawy'))
  const composer = h('div', 'army-picker')
  const armyPicks = {} as Record<UnitId, { input: HTMLInputElement; avail: HTMLElement }>
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
    // The typed army does not bump the store revision, so refresh on direct input.
    input.addEventListener('input', () => update())

    pick.appendChild(labelRow)
    pick.appendChild(avail)
    pick.appendChild(input)
    composer.appendChild(pick)
    armyPicks[id] = { input, avail }
  }
  expPanel.appendChild(composer)

  const composerActions = h('div', 'recruit-controls')
  const sendAllBtn = h('button', 'btn btn-ghost', 'Wyślij wszystkie dostępne')
  sendAllBtn.type = 'button'
  sendAllBtn.addEventListener('click', () => {
    const home = stationedUnits(ctx.store.state)
    for (const id of UNIT_IDS) armyPicks[id].input.value = String(home[id])
    update()
  })
  const clearAllBtn = h('button', 'btn btn-ghost', 'Wyczyść')
  clearAllBtn.type = 'button'
  clearAllBtn.addEventListener('click', () => {
    for (const id of UNIT_IDS) armyPicks[id].input.value = '0'
    update()
  })
  composerActions.appendChild(sendAllBtn)
  composerActions.appendChild(clearAllBtn)
  expPanel.appendChild(composerActions)

  const expSummary = h('p', 'attack-summary muted')
  expSummary.setAttribute('role', 'status')
  expSummary.setAttribute('aria-live', 'polite')
  expPanel.appendChild(expSummary)

  /**
   * Read the composed army from the inputs, clamped per-type to the units currently
   * AT HOME (stationedUnits). Clamping here means the request can never exceed the
   * garrison, so canAttack only ever gates on the barracks unlock / an empty army —
   * the displayed estimates, the button verdict and the actual dispatch can never
   * disagree.
   */
  const readArmy = (s: GameState): Record<UnitId, number> => {
    const home = stationedUnits(s)
    const army = {} as Record<UnitId, number>
    for (const id of UNIT_IDS) {
      const parsed = Math.floor(Number(armyPicks[id].input.value))
      const v = Number.isFinite(parsed) && parsed > 0 ? parsed : 0
      army[id] = Math.min(v, home[id])
    }
    return army
  }
  const armySize = (army: Record<UnitId, number>): number => {
    let n = 0
    for (const id of UNIT_IDS) n += army[id]
    return n
  }

  // Feedback for the last attack attempt (success or the canAttack reason).
  const expMsg = h('p', 'recruit-msg muted')
  expMsg.setAttribute('role', 'status')
  expMsg.setAttribute('aria-live', 'polite')

  // Target list — a fixed window of rows whose levels shift with the player's reach.
  expPanel.appendChild(h('h3', 'recruit-subtitle', 'Cele'))
  const targetList = h('div', 'target-list')
  expPanel.appendChild(targetList)

  interface TargetRowRefs {
    level: HTMLElement
    defense: HTMLElement
    loot: HTMLElement
    march: HTMLElement
    forecast: HTMLElement
    button: HTMLButtonElement
  }
  const targetRows: TargetRowRefs[] = []
  // Current level shown in each row (updated per frame); the click handler reads
  // THIS so a row always attacks the tier it is currently displaying.
  const rowLevels: number[] = []
  for (let i = 0; i < TARGET_WINDOW; i++) {
    rowLevels.push(i + 1)
    const row = h('div', 'target')

    const head = h('div', 'target-head')
    head.appendChild(h('span', 'target-name', 'Obóz barbarzyńców'))
    const level = h('span', 'target-level num')
    head.appendChild(level)

    const statsLine = h('p', 'target-stats muted')
    const defense = h('span', 'num')
    const loot = h('span', 'num')
    const march = h('span', 'num')
    statsLine.appendChild(document.createTextNode('Obrona '))
    statsLine.appendChild(defense)
    statsLine.appendChild(document.createTextNode(' · Łup '))
    statsLine.appendChild(loot)
    statsLine.appendChild(document.createTextNode(' · Marsz '))
    statsLine.appendChild(march)

    const bottom = h('div', 'target-bottom')
    const forecast = h('span', 'target-forecast')
    const button = h('button', 'btn', 'Atakuj')
    button.type = 'button'
    // aria-disabled (not `disabled`) keeps the control focusable/hoverable so its
    // reason tooltip + aria-live message reach the user; the handler stays a guarded
    // no-op when canAttack rejects (mirrors the recruitment panel).
    button.addEventListener('click', () => {
      const s = ctx.store.state
      const lvl = rowLevels[i]
      const army = readArmy(s)
      const verdict = canAttack(s, lvl, army)
      if (!verdict.ok) {
        expMsg.textContent = verdict.reason ?? 'Nie można wysłać wyprawy.'
        update()
        return
      }
      const target = barbarianTarget(lvl)
      const outcome = battleOutcome(armyAttackPower(army), target.defensePower)
      // Guard against accidentally throwing the whole army at a camp it will lose to.
      if (
        !outcome.attackerWins &&
        !window.confirm(
          'Prognoza: porażka — wysłana armia prawdopodobnie zostanie zniszczona. Wysłać mimo to?',
        )
      ) {
        return
      }
      const ok = ctx.onAttack(lvl, army)
      if (ok) {
        expMsg.textContent = 'Wysłano wyprawę: ' + target.name + '.'
        for (const uid of UNIT_IDS) armyPicks[uid].input.value = '0'
      } else {
        expMsg.textContent = 'Nie udało się wysłać wyprawy.'
      }
      update()
    })
    bottom.appendChild(forecast)
    bottom.appendChild(button)

    row.appendChild(head)
    row.appendChild(statsLine)
    row.appendChild(bottom)
    targetList.appendChild(row)
    targetRows.push({ level, defense, loot, march, forecast, button })
  }
  expPanel.appendChild(expMsg)

  // Marches in progress (rebuilt only when their signature changes).
  expPanel.appendChild(h('h3', 'recruit-subtitle', 'Marsze w toku'))
  const marchList = h('ul', 'march-list')
  expPanel.appendChild(marchList)
  let lastMarchSig = ''

  container.appendChild(expPanel)

  // ---- c4) Defense panel (incoming raids) -----------------------------------
  const defPanel = h('section', 'panel')
  defPanel.setAttribute('aria-labelledby', 'def-title')
  const defTitle = h('h2', 'panel-title', 'Obrona')
  defTitle.id = 'def-title'
  defPanel.appendChild(defTitle)

  const defStats = h('div', 'building-stats')
  const mkDefStat = (label: string): { wrap: HTMLElement; val: HTMLElement } => {
    const wrap = h('div', 'stat')
    wrap.appendChild(h('span', 'stat-label muted', label))
    const val = h('span', 'num stat-val')
    wrap.appendChild(val)
    return { wrap, val }
  }
  const raidEtaStat = mkDefStat('Następny najazd')
  const homeDefStat = mkDefStat('Obrona domowa')
  const raidPowerStat = mkDefStat('Siła najazdu')
  defStats.appendChild(raidEtaStat.wrap)
  defStats.appendChild(homeDefStat.wrap)
  defStats.appendChild(raidPowerStat.wrap)
  defPanel.appendChild(defStats)

  // Defence-vs-threat bar. Colour is never the sole cue: a glyph + worded verdict
  // (below) carries the same information for colour-blind / greyscale users.
  const defBar = h('div', 'bar defense-bar')
  defBar.setAttribute('role', 'progressbar')
  defBar.setAttribute('aria-valuemin', '0')
  defBar.setAttribute('aria-valuemax', '100')
  defBar.setAttribute('aria-label', 'Obrona domowa względem siły najazdu')
  defBar.appendChild(h('i'))
  defPanel.appendChild(defBar)

  const defVerdict = h('p', 'defense-verdict')
  defVerdict.setAttribute('role', 'status')
  defVerdict.setAttribute('aria-live', 'polite')
  defPanel.appendChild(defVerdict)

  container.appendChild(defPanel)

  // ---- c5) Battle reports panel ---------------------------------------------
  const repPanel = h('section', 'panel')
  repPanel.setAttribute('aria-labelledby', 'rep-title')
  const repTitle = h('h2', 'panel-title', 'Raporty')
  repTitle.id = 'rep-title'
  repPanel.appendChild(repTitle)
  const reportList = h('ul', 'report-list')
  repPanel.appendChild(reportList)
  let lastReportSig = ''
  container.appendChild(repPanel)

  // ---- d) Save panel: export / import / reset -------------------------------
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

  // ---- e) Footer ------------------------------------------------------------
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

    // Derived-stats summary (all read from the cached derived fields).
    statRefs.storage.textContent = formatNumber(s.storageCap)
    statRefs.pop.textContent = formatInt(s.popCap)
    for (const r of RESOURCE_IDS) {
      statRefs.prod[r].textContent = formatRate(s.production[r])
    }

    // Building rows: level, next-level cost (red where short), affordability.
    for (const id of BUILDING_IDS) {
      const ref = bRefs[id]
      const def = BUILDINGS[id]
      const level = s.buildings[id]
      ref.level.textContent = 'poz. ' + level + ' / ' + def.maxLevel
      const { cost, affordable, maxed } = nextCostAffordable(s, id)
      ref.maxed.hidden = !maxed
      ref.cost.hidden = maxed
      ref.button.disabled = maxed || !affordable
      if (!maxed) {
        for (const r of RESOURCE_IDS) {
          const ci = ref.costItems[r]
          ci.val.textContent = formatInt(cost[r])
          // Shortfall is cued three non-colour ways (WCAG 1.4.1): a CSS glyph +
          // bold (.is-short), a hover title, and a visually-hidden text marker for
          // screen readers — never colour alone.
          const short = s.resources[r].lt(cost[r])
          ci.item.classList.toggle('is-short', short)
          ci.item.title = short ? RESOURCE_NAMES[r] + ': brak surowca' : ''
          ci.mark.textContent = short ? ' (brak)' : ''
        }
      }
    }

    // ---- Recruitment ----
    const unlocked = barracksUnlocked(s)
    const usedPop = usedPopulation(s)
    recStatus.textContent = unlocked
      ? 'Populacja: ' +
        formatInt(usedPop) +
        ' / ' +
        formatInt(s.popCap) +
        ' • wolne: ' +
        formatInt(freePopulation(s))
      : 'Zbuduj Koszary (poziom 1), aby rozpocząć rekrutację.'

    // Population bar (usedPopulation / popCap), clamped to 0..100.
    let popPct = 0
    if (s.popCap.gt(0)) {
      const raw = usedPop.div(s.popCap).mul(100).toNumber()
      popPct = Number.isFinite(raw) ? Math.max(0, Math.min(100, raw)) : 100
    }
    const popFill = popBar.firstElementChild as HTMLElement | null
    if (popFill) popFill.style.width = popPct + '%'
    popBar.setAttribute('aria-valuenow', Math.round(popPct).toString())

    const speedMult = recruitSpeedMult(s)
    for (const id of UNIT_IDS) {
      const ur = uRefs[id]
      ur.owned.textContent = 'masz: ' + formatInt(s.units[id])
      ur.time.textContent = 'Czas: ' + formatTime(UNITS[id].recruitSeconds * speedMult) + '/szt.'

      // Cost + shortfall track the *typed* count (same count the button checks), so
      // the visible cost/affordability cue can never contradict the button state.
      const parsed = Math.floor(Number(ur.input.value))
      const count = Number.isFinite(parsed) && parsed > 0 ? parsed : 1
      const total = recruitCost(id, count)
      for (const r of RESOURCE_IDS) {
        const ci = ur.costItems[r]
        ci.val.textContent = formatInt(total[r])
        const short = s.resources[r].lt(total[r])
        ci.item.classList.toggle('is-short', short)
        ci.item.title = short ? RESOURCE_NAMES[r] + ': brak surowca' : ''
        ci.mark.textContent = short ? ' (brak)' : ''
      }

      // Button reflects canRecruit for the SAME typed count; the reason becomes the
      // tooltip + aria cue. Steppers/input are hard-locked only when no barracks.
      const verdict = canRecruit(s, id, count)
      ur.button.setAttribute('aria-disabled', verdict.ok ? 'false' : 'true')
      ur.button.title = verdict.ok ? '' : (verdict.reason ?? '')
      ur.input.disabled = !unlocked
      for (const b of ur.steppers) b.disabled = !unlocked
    }

    // Queue: rebuild the list only when its signature changes (small + bounded),
    // so the per-frame path stays allocation-free in the steady state. The head
    // order shows the live countdown to the NEXT unit; the rest are just listed.
    const sig = s.recruitQueue
      .map((o) => o.unitId + ':' + o.count + ':' + Math.ceil(o.remaining))
      .join('|')
    if (sig !== lastQueueSig) {
      lastQueueSig = sig
      queueList.textContent = ''
      if (s.recruitQueue.length === 0) {
        queueList.appendChild(h('li', 'queue-empty muted', 'Kolejka pusta.'))
      } else {
        for (let i = 0; i < s.recruitQueue.length; i++) {
          const o = s.recruitQueue[i]
          const li = h('li', i === 0 ? 'queue-item is-active' : 'queue-item')
          li.appendChild(h('span', 'queue-name', UNITS[o.unitId].name + ' ×' + o.count))
          const eta = i === 0 ? 'następny za ' + formatTime(o.remaining) : 'w kolejce'
          li.appendChild(h('span', 'queue-eta num muted', eta))
          queueList.appendChild(li)
        }
      }
    }

    // ---- Expeditions ----
    const expUnlocked = barracksUnlocked(s)
    const home = stationedUnits(s)
    const army = readArmy(s)
    const composed = armySize(army)
    const carry = armyCarry(army)
    const atkPow = armyAttackPower(army)
    const atkHomePow = armyAttackPower(home)

    let homeSum = 0
    for (const id of UNIT_IDS) homeSum += home[id]
    let awaySum = 0
    for (const m of s.marches) for (const id of UNIT_IDS) awaySum += m.units[id]

    expStatus.textContent = expUnlocked
      ? 'W domu: ' + formatInt(homeSum) + ' jedn. · na marszach: ' + formatInt(awaySum)
      : 'Zbuduj Koszary (poziom 1), aby wysyłać wyprawy.'

    for (const id of UNIT_IDS) {
      const pick = armyPicks[id]
      pick.avail.textContent = 'dostępne: ' + formatInt(home[id])
      pick.input.max = String(home[id])
      pick.input.disabled = !expUnlocked || home[id] <= 0
      // Self-correct an over-cap entry down to the garrison size (rare; only when a
      // value already exceeds what's at home — never touches an in-range entry, so
      // typing is undisturbed).
      const cur = Math.floor(Number(pick.input.value))
      if (Number.isFinite(cur) && cur > home[id]) pick.input.value = String(home[id])
    }

    expSummary.textContent =
      composed > 0
        ? 'Wyślesz ' +
          formatInt(composed) +
          ' jedn. · atak ' +
          formatInt(atkPow) +
          ' · udźwig ' +
          formatInt(carry)
        : 'Wybierz jednostki do wysłania.'
    sendAllBtn.disabled = !expUnlocked || homeSum <= 0
    clearAllBtn.disabled = composed <= 0

    // Slide the visible window so it sits around the highest beatable tier (camp
    // defence grows monotonically, so the scan can break early). Always shows one
    // tier below the player's reach plus several aspirational tiers above.
    let best = 0
    for (let l = 1; l <= MAX_TARGET_LEVEL; l++) {
      if (barbarianTarget(l).defensePower < atkHomePow) best = l
      else break
    }
    let start = Math.max(1, best) - 1
    if (start < 1) start = 1
    if (start > MAX_TARGET_LEVEL - TARGET_WINDOW + 1) start = MAX_TARGET_LEVEL - TARGET_WINDOW + 1
    if (start < 1) start = 1

    for (let i = 0; i < TARGET_WINDOW; i++) {
      const lvl = start + i
      rowLevels[i] = lvl
      const target = barbarianTarget(lvl)
      const tr = targetRows[i]
      tr.level.textContent = 'poz. ' + lvl
      tr.defense.textContent = formatInt(target.defensePower)

      const totalLoot = target.loot.wood.add(target.loot.clay).add(target.loot.iron)
      if (composed > 0) {
        // Haul = min(army carry, total camp loot) — the exact sum computeLoot lands.
        const cd = D(carry)
        const haul = cd.lt(totalLoot) ? cd : totalLoot
        tr.loot.textContent = formatInt(haul)
        tr.march.textContent = formatTime(marchTime(s, lvl, army))
        const oc = battleOutcome(atkPow, target.defensePower)
        const pct = Math.round(oc.attackerLossFrac * 100)
        tr.forecast.textContent = oc.attackerWins
          ? '✓ wygrana · straty ~' + pct + '%'
          : '✗ porażka'
        tr.forecast.classList.toggle('forecast-win', oc.attackerWins)
        tr.forecast.classList.toggle('forecast-lose', !oc.attackerWins)
      } else {
        tr.loot.textContent = 'do ' + formatInt(totalLoot)
        tr.march.textContent = '—'
        tr.forecast.textContent = '—'
        tr.forecast.classList.remove('forecast-win', 'forecast-lose')
      }

      const verdict = canAttack(s, lvl, army)
      tr.button.setAttribute('aria-disabled', verdict.ok ? 'false' : 'true')
      tr.button.title = verdict.ok ? '' : (verdict.reason ?? '')
      tr.button.setAttribute('aria-label', 'Atakuj obóz barbarzyńców (poziom ' + lvl + ')')
    }

    // Marches in progress — rebuilt only when their signature (level / phase /
    // whole-second ETA / composition) changes, so the steady state is poke-free.
    const marchSig = s.marches
      .map(
        (m) =>
          m.targetLevel +
          ':' +
          m.phase +
          ':' +
          Math.ceil(m.remaining) +
          ':' +
          UNIT_IDS.map((id) => m.units[id]).join(','),
      )
      .join('|')
    if (marchSig !== lastMarchSig) {
      lastMarchSig = marchSig
      marchList.textContent = ''
      if (s.marches.length === 0) {
        marchList.appendChild(h('li', 'queue-empty muted', 'Brak marszów w toku.'))
      } else {
        for (const m of s.marches) {
          const li = h(
            'li',
            'march-item ' + (m.phase === 'returning' ? 'is-returning' : 'is-outbound'),
          )
          const main = h('div', 'march-main')
          main.appendChild(h('span', 'march-target', barbarianTarget(m.targetLevel).name))
          // Phase is conveyed by an arrow glyph AND a word — never colour alone.
          main.appendChild(
            h('span', 'march-phase', m.phase === 'outbound' ? '→ w drodze' : '← powrót'),
          )
          li.appendChild(main)

          const parts: string[] = []
          for (const id of UNIT_IDS) {
            if (m.units[id] > 0) parts.push(UNITS[id].name + ' ×' + m.units[id])
          }
          const sub = h('div', 'march-sub muted')
          sub.appendChild(h('span', 'march-units', parts.join(', ') || '—'))
          sub.appendChild(h('span', 'march-eta num', formatTime(m.remaining)))
          li.appendChild(sub)
          marchList.appendChild(li)
        }
      }
    }

    // ---- Defence (incoming raids) ----
    raidEtaStat.val.textContent = formatTime(s.raidTimer)
    const homeDef = armyDefensePower(home)
    const threat = raidPower(s)
    homeDefStat.val.textContent = formatInt(homeDef)
    raidPowerStat.val.textContent = formatInt(Math.round(threat))

    let defPct = 0
    if (threat > 0) {
      const raw = (homeDef / threat) * 100
      defPct = Number.isFinite(raw) ? Math.max(0, Math.min(100, raw)) : 100
    }
    const defFill = defBar.firstElementChild as HTMLElement | null
    if (defFill) defFill.style.width = defPct + '%'
    defBar.setAttribute('aria-valuenow', Math.round(defPct).toString())
    // A raid (the attacker) wins only when its power strictly exceeds the garrison,
    // so a tie still repels it — mirror battleOutcome's verdict exactly.
    const safe = homeDef >= threat
    defBar.classList.toggle('is-good', safe)
    defBar.classList.toggle('is-bad', !safe)
    defVerdict.textContent = safe
      ? '✓ Osada powinna odeprzeć najazd.'
      : '✗ Osada zagrożona — wzmocnij obronę domową.'
    defVerdict.classList.toggle('text-good', safe)
    defVerdict.classList.toggle('text-bad', !safe)

    // Battle reports — newest first, rebuilt only when the log signature changes.
    const repSig =
      s.battleLog.length +
      '#' +
      s.battleLog
        .map((r) =>
          r.kind === 'attack'
            ? 'a' + r.targetLevel + (r.won ? '1' : '0') + r.lootSum + r.losses
            : 'r' + (r.won ? '1' : '0') + r.looted + r.losses,
        )
        .join('|')
    if (repSig !== lastReportSig) {
      lastReportSig = repSig
      reportList.textContent = ''
      if (s.battleLog.length === 0) {
        reportList.appendChild(h('li', 'queue-empty muted', 'Brak raportów.'))
      } else {
        for (let i = s.battleLog.length - 1; i >= 0; i--) {
          const r = s.battleLog[i]
          const li = h('li', 'report-item ' + (r.won ? 'report-win' : 'report-lose'))
          let title: string
          let detail: string
          if (r.kind === 'attack') {
            title =
              (r.won ? '✓ Zwycięstwo' : '✗ Porażka') +
              ' · ' +
              barbarianTarget(r.targetLevel).name
            detail = 'Łup ' + formatInt(r.lootSum) + ' · Straty ' + formatInt(r.losses)
          } else {
            title = r.won ? '✓ Najazd odparty' : '✗ Osada złupiona'
            detail = r.won
              ? 'Brak strat'
              : 'Zrabowano ' + formatInt(r.looted) + ' · Straty ' + formatInt(r.losses)
          }
          li.appendChild(h('span', 'report-title', title))
          li.appendChild(h('span', 'report-detail muted', detail))
          reportList.appendChild(li)
        }
      }
    }
  }

  effect(() => {
    void ctx.store.rev.value
    update()
  })
}
