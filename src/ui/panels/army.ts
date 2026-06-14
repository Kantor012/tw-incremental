import { RESOURCE_IDS, type ResourceId } from '../../engine/state'
import { formatInt, formatTime } from '../../engine/format'
import { UNIT_IDS, UNITS, type UnitId } from '../../content/units'
import {
  barracksUnlocked,
  canRecruit,
  recruitCost,
  recruitSpeedMult,
  freePopulation,
  usedPopulation,
} from '../../systems/recruitment'
import type { UiCtx, Panel } from '../types'
import { h, unitIcon, RESOURCE_NAMES } from '../dom'

/**
 * Army panel — recruitment screen (the old app.ts "Rekrutacja" section, lifted
 * verbatim in behaviour and re-laid-out as a responsive CARD GRID).
 *
 * Scope: training only. The expedition/march composer and the in-flight march
 * list moved to the campaign panel (panels/campaign.ts); this panel owns the
 * population budget, the per-unit recruit cards and the training queue.
 *
 * Discipline (panel contract): the DOM is built ONCE here and cached; {@link Panel.update}
 * only pokes textContent / style / attributes onto existing nodes — it never
 * rebuilds the tree (the queue list is the one exception, and only when its
 * content signature actually changes). The shell drives update() on every store
 * revision while this is the active tab, and once when it becomes active.
 *
 * Layout note: the unit cards sit in an intrinsically-responsive grid (the
 * shared .unit-grid class: auto-fill + minmax) so desktop shows several columns
 * and mobile collapses to one — no media query needed. Grid template + card
 * surface live ENTIRELY in the design-system classes (.unit-grid / .unit-card in
 * layout.css), shared with every other tab so framing never diverges; no inline
 * layout styles. Every card's INNER markup reuses the shared, already-styled
 * component classes (.building-head/.building-cost/.cost-item/.recruit-controls/
 * ...), so all the accessibility affordances carry over unchanged.
 */

/** Cached handles for one unit recruit card. */
interface UnitCardRefs {
  /** "masz: N" owned counter in the card header. */
  owned: HTMLElement
  /** "Czas: Xs/szt." live training time per unit (tracks barracks speed). */
  time: HTMLElement
  /** Quantity input (the typed count drives cost + the recruit verdict). */
  input: HTMLInputElement
  /** Recruit button (aria-disabled + reason title, never the hard `disabled`). */
  button: HTMLButtonElement
  /** +1 / +10 steppers — hard-disabled together with the input while locked. */
  steppers: HTMLButtonElement[]
  /**
   * Per-resource cost chip: `item` toggles the .is-short shortfall state, `val`
   * holds the TOTAL cost for the typed count, `mark` is a visually-hidden text
   * cue (shortfall must never be conveyed by colour alone — WCAG 1.4.1).
   */
  costItems: Record<ResourceId, { item: HTMLElement; val: HTMLElement; mark: HTMLElement }>
}

/** Clamp a raw ratio*100 to a finite 0..100 percentage (NaN/∞ → full). */
function pctOf(part: number): number {
  return Number.isFinite(part) ? Math.max(0, Math.min(100, part)) : 100
}

/** Set a `.bar > i` fill width and the host's aria-valuenow from a 0..100 pct. */
function setBar(bar: HTMLElement, pct: number): void {
  const fill = bar.firstElementChild as HTMLElement | null
  if (fill) fill.style.width = pct + '%'
  bar.setAttribute('aria-valuenow', Math.round(pct).toString())
}

/**
 * Build the recruitment panel. Reads {@link UiCtx} for the live store and the
 * `onRecruit` commit; all validation is read straight from the recruitment
 * engine (canRecruit / freePopulation / ...) so the visible cues can never
 * disagree with the button verdict.
 */
export function createArmyPanel(ctx: UiCtx): Panel {
  // No outer .panel frame: every tab is a grid of cards directly on the page
  // background (matches buildings/campaign/reports/save) for consistent framing.
  const el = h('div', 'army-panel')

  // ---- Status + population budget ------------------------------------------
  // Unlock / free-population line. Doubles as the "no barracks" notice required
  // by the brief: when locked it tells the player to build the Koszary first.
  const status = h('p', 'recruit-status muted')
  status.setAttribute('role', 'status')
  status.setAttribute('aria-live', 'polite')
  el.appendChild(status)

  // Population usage bar (usedPopulation / popCap) — a visual companion to the
  // status text, never the sole carrier of the information.
  const popBar = h('div', 'bar recruit-pop')
  popBar.setAttribute('role', 'progressbar')
  popBar.setAttribute('aria-valuemin', '0')
  popBar.setAttribute('aria-valuemax', '100')
  popBar.setAttribute('aria-label', 'Wykorzystanie populacji')
  popBar.appendChild(h('i'))
  el.appendChild(popBar)

  // Feedback for the last recruit attempt (success or the canRecruit reason).
  const recMsg = h('p', 'recruit-msg muted')
  recMsg.setAttribute('role', 'status')
  recMsg.setAttribute('aria-live', 'polite')

  // ---- Unit cards (responsive grid) ----------------------------------------
  // Grid template + card surface live in the shared .unit-grid / .unit-card
  // classes (layout.css) — the single source of truth across tabs. The gap below
  // the population bar comes from .recruit-pop's own margin-bottom.
  const grid = h('div', 'unit-grid')

  const cards = {} as Record<UnitId, UnitCardRefs>

  for (const id of UNIT_IDS) {
    const def = UNITS[id]
    // Card chrome comes from the shared .unit-card class (layout.css) — no inline.
    const card = h('div', 'unit-card')

    // Header: icon + name (left), owned counter (right).
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

    // Combat stats (atk / def vs infantry / def vs cavalry / carry / pop).
    const statLine = h(
      'p',
      'unit-stats muted',
      `Atak ${def.attack} · Obr. piech. ${def.defInfantry} · Obr. kaw. ${def.defCavalry} · ` +
        `Udźwig ${def.carry} · Pop. ${def.pop}`,
    )

    // Cost chips. The displayed value is the TOTAL cost for the currently typed
    // count (recomputed in update()), so it always agrees with the button's
    // canRecruit verdict. Shortfall is cued without relying on colour alone
    // (WCAG 1.4.1): .is-short adds a ⚠ glyph + bold, a hover title, and a
    // visually-hidden text marker for assistive tech.
    const initial = recruitCost(id, 1)
    const costWrap = h('div', 'building-cost')
    const costItems = {} as Record<
      ResourceId,
      { item: HTMLElement; val: HTMLElement; mark: HTMLElement }
    >
    for (const r of RESOURCE_IDS) {
      const item = h('span', 'cost-item')
      item.appendChild(h('span', 'cost-label', RESOURCE_NAMES[r]))
      const val = h('span', 'num cost-val', formatInt(initial[r]))
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

    const button = h('button', 'btn btn-primary', 'Rekrutuj')
    button.type = 'button'
    button.setAttribute('aria-label', 'Rekrutuj: ' + def.name)
    // aria-disabled (not the `disabled` property) keeps the control focusable and
    // hoverable so its reason tooltip / aria-live message actually reach the user;
    // the click handler stays a guarded no-op when recruitment is rejected.
    button.addEventListener('click', () => {
      const villageId = ctx.activeVillageId.value
      const v = ctx.store.state.villages[villageId]
      const count = readCount()
      const verdict = canRecruit(v, id, count)
      if (verdict.ok) {
        ctx.onRecruit(villageId, id, count)
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

    card.appendChild(head)
    card.appendChild(desc)
    card.appendChild(statLine)
    card.appendChild(costWrap)
    card.appendChild(timeLine)
    card.appendChild(controls)
    grid.appendChild(card)

    cards[id] = { owned, time: timeLine, input, button, steppers, costItems }
  }
  el.appendChild(grid)

  // ---- Training queue ------------------------------------------------------
  el.appendChild(h('h3', 'recruit-subtitle', 'Kolejka szkolenia'))
  const queueList = h('ul', 'recruit-queue')
  el.appendChild(queueList)
  let lastQueueSig = ''

  el.appendChild(recMsg)

  // ---- Reactivity ----------------------------------------------------------
  const update = (): void => {
    const v = ctx.store.state.villages[ctx.activeVillageId.value]
    const unlocked = barracksUnlocked(v)
    const usedPop = usedPopulation(v)

    status.textContent = unlocked
      ? 'Populacja: ' +
        formatInt(usedPop) +
        ' / ' +
        formatInt(v.popCap) +
        ' • wolne: ' +
        formatInt(freePopulation(v))
      : 'Zbuduj Koszary (poziom 1), aby rozpocząć rekrutację.'

    setBar(popBar, v.popCap.gt(0) ? pctOf(usedPop.div(v.popCap).mul(100).toNumber()) : 0)

    const speedMult = recruitSpeedMult(v)
    for (const id of UNIT_IDS) {
      const ref = cards[id]
      ref.owned.textContent = 'masz: ' + formatInt(v.units[id])
      ref.time.textContent = 'Czas: ' + formatTime(UNITS[id].recruitSeconds * speedMult) + '/szt.'

      // Cost + shortfall track the *typed* count (the same count the button
      // checks), so the visible cost/affordability cue can never contradict the
      // button state.
      const parsed = Math.floor(Number(ref.input.value))
      const count = Number.isFinite(parsed) && parsed > 0 ? parsed : 1
      const total = recruitCost(id, count)
      for (const r of RESOURCE_IDS) {
        const ci = ref.costItems[r]
        ci.val.textContent = formatInt(total[r])
        const short = v.resources[r].lt(total[r])
        ci.item.classList.toggle('is-short', short)
        ci.item.title = short ? RESOURCE_NAMES[r] + ': brak surowca' : ''
        ci.mark.textContent = short ? ' (brak)' : ''
      }

      // Button reflects canRecruit for the SAME typed count; the reason becomes
      // the tooltip + aria cue. Steppers/input are hard-locked only with no barracks.
      const verdict = canRecruit(v, id, count)
      ref.button.setAttribute('aria-disabled', verdict.ok ? 'false' : 'true')
      ref.button.title = verdict.ok ? '' : (verdict.reason ?? '')
      ref.input.disabled = !unlocked
      for (const b of ref.steppers) b.disabled = !unlocked
    }

    // Queue: rebuild only when its signature changes (small + bounded), so the
    // steady-state path stays allocation-free. The head order shows the live
    // countdown to the NEXT unit; the rest are just listed.
    const sig = v.recruitQueue
      .map((o) => o.unitId + ':' + o.count + ':' + Math.ceil(o.remaining))
      .join('|')
    if (sig !== lastQueueSig) {
      lastQueueSig = sig
      queueList.textContent = ''
      if (v.recruitQueue.length === 0) {
        queueList.appendChild(h('li', 'queue-empty muted', 'Kolejka pusta.'))
      } else {
        for (let i = 0; i < v.recruitQueue.length; i++) {
          const o = v.recruitQueue[i]
          const li = h('li', i === 0 ? 'queue-item is-active' : 'queue-item')
          li.appendChild(h('span', 'queue-name', UNITS[o.unitId].name + ' ×' + o.count))
          const eta = i === 0 ? 'następny za ' + formatTime(o.remaining) : 'w kolejce'
          li.appendChild(h('span', 'queue-eta num muted', eta))
          queueList.appendChild(li)
        }
      }
    }
  }

  return { el, update }
}
