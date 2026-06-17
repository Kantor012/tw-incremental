import { RESOURCE_IDS, type ResourceId } from '../../engine/state'
import { formatInt, formatTime } from '../../engine/format'
import { UNIT_IDS, UNITS, type UnitId } from '../../content/units'
import { BUILDINGS } from '../../content/buildings'
import {
  barracksUnlocked,
  canRecruit,
  recruitCost,
  recruitSpeedMult,
  freePopulation,
  usedPopulation,
  unitUnlocked,
} from '../../systems/recruitment'
import { aggregateTechMods } from '../../systems/tech'
import { effectiveMods } from '../../systems/prestige'
import { hordePower, hordeForecast } from '../../systems/hordes'
import { HORDE_BREACH_RESOURCE_FRAC, HORDE_BREACH_ARMY_FRAC } from '../../content/hordes'
import type { UiCtx, Panel } from '../types'
import { h, unitIcon, RESOURCE_NAMES, collapsible, pulseFx } from '../dom'
import { applyForecastClass } from '../combatForecast'

/**
 * Army panel — recruitment screen (the old app.ts "Rekrutacja" section, lifted
 * verbatim in behaviour and re-laid-out as a responsive CARD GRID).
 *
 * Scope: training only. The expedition/march composer and the in-flight march
 * list moved to the campaign panel (panels/campaign.ts); this panel owns the
 * population budget, the per-unit recruit cards and the training queue.
 *
 * M7.2 — defensive context: a read-only „Nadciągająca horda" section telegraphs the
 * single GLOBAL, escalating invasion of the CAPITAL (state.horde) — its countdown,
 * level, projected strength, a 3-state defence FORECAST and the breach stakes — so the
 * player can PREPARE through the existing build/recruit actions (hordes resolve
 * automatically in the tick, like raids; there is no new action here). The readout
 * always reports the CAPITAL's defence (villageOrder[0]) — the horde's only target —
 * regardless of which village this tab currently shows.
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
   * Per-unit requirement notice ("Wymaga: <building>"). Shown (text, never colour
   * alone — WCAG 1.4.1) only while the unit's `requires` building is missing; the
   * noble's "Wymaga: Pałac" is the visible signpost toward conquest. The building
   * name is read from the catalogue, so a re-gated unit needs no edit here.
   */
  lock: HTMLElement
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

  // ---- Nadciągająca horda (kontekst obronny) -------------------------------
  // M7.2 read-only readout: the army screen is where the player PREPARES for the
  // telegraphed horde. Everything here is GLOBAL (state.horde) and reports the CAPITAL's
  // defence (villageOrder[0]) — the horde's only target — so the copy names „stolica"
  // explicitly and the section is identical on every village tab. There is no new action:
  // the player reacts through the existing build/recruit controls; the horde resolves in
  // the tick like a raid. DOM built once; update() pokes the cached refs.
  const hordeTitleId = 'army-horde-title'
  const hordeSection = h('section', 'horde-section')
  hordeSection.setAttribute('aria-labelledby', hordeTitleId)

  // panel-sticky-head pins the heading while the player scrolls the unit grid below,
  // keeping the horde context glanceable without extra vertical travel (M12.3).
  const hordeHead = h('h3', 'recruit-subtitle horde-title panel-sticky-head', '⚔︎ Nadciągająca horda')
  hordeHead.id = hordeTitleId
  hordeSection.appendChild(hordeHead)

  // ---- Compact always-visible summary (countdown + forecast verdict) -------
  // M12.3: only the two at-a-glance lines stay on screen under the heading; the rest
  // folds into „Szczegóły hordy" below to cut the section's vertical footprint.

  // Countdown to the next horde. Uses the shared formatTime — the project's countdown
  // formatter (same as the recruit-queue ETA): for the long horde cadence it reads
  // „4h 0m 0s", far clearer than a raw 240:00 MM:SS would be at this scale. NOT a live
  // region: it ticks every frame and an aria-live here would spam screen readers.
  const hordeTimerLine = h('p', 'horde-line muted')
  hordeTimerLine.appendChild(document.createTextNode('Następna horda za '))
  const hordeTimerVal = h('span', 'num')
  hordeTimerLine.appendChild(hordeTimerVal)
  hordeSection.appendChild(hordeTimerLine)

  // 3-state defence FORECAST for the capital. The verdict is carried in WORDS + a glyph
  // (hordeForecast.text), never colour alone (WCAG 1.4.1); the forecast-win/-lose tint is
  // only supplementary, applied to the verdict span via the shared applyForecastClass.
  // role=status + aria-live announce the occasional verdict FLIP (kept, per the brief).
  const hordeForecastLine = h('p', 'horde-forecast')
  hordeForecastLine.setAttribute('role', 'status')
  hordeForecastLine.setAttribute('aria-live', 'polite')
  hordeForecastLine.appendChild(document.createTextNode('Obrona stolicy: '))
  const hordeForecastVal = h('span', 'horde-forecast-verdict')
  hordeForecastLine.appendChild(hordeForecastVal)
  hordeSection.appendChild(hordeForecastLine)

  // ---- „Szczegóły hordy" — collapsible detail (defaults COLLAPSED) ----------
  // M12.3: level, projected strength and breach stakes move off-screen by default. They
  // still UPDATE every frame in update() (the native <details> only hides them visually,
  // and gives keyboard + ARIA for free).
  const hordeDetails = collapsible('Szczegóły hordy', { open: false, headingLevel: 4 })

  // Escalation level — rises by 1 after EVERY horde (repelled or breached), so each is
  // harder than the last.
  const hordeLevelLine = h('p', 'horde-line muted')
  hordeLevelLine.appendChild(document.createTextNode('Poziom hordy: '))
  const hordeLevelVal = h('span', 'num')
  hordeLevelLine.appendChild(hordeLevelVal)
  hordeDetails.body.appendChild(hordeLevelLine)

  // Projected incoming strength (hordePower — level-escalated + the capital's progress).
  const hordePowerLine = h('p', 'horde-line muted')
  hordePowerLine.appendChild(document.createTextNode('Szacowana siła: '))
  const hordePowerVal = h('span', 'num')
  hordePowerLine.appendChild(hordePowerVal)
  hordeDetails.body.appendChild(hordePowerLine)

  // Breach stakes — read straight from the content knobs so the copy can never drift from
  // the penalty the engine actually applies (a far heavier blow than a raid; no buildings).
  const hordeResPct = Math.round(HORDE_BREACH_RESOURCE_FRAC * 100)
  const hordeArmyPct = Math.round(HORDE_BREACH_ARMY_FRAC * 100)
  hordeDetails.body.appendChild(
    h(
      'p',
      'horde-stakes muted',
      'Przy przełamaniu stolica traci ' +
        hordeResPct +
        '% każdego surowca oraz ' +
        hordeArmyPct +
        '% garnizonu (budynki bez zmian).',
    ),
  )

  hordeSection.appendChild(hordeDetails.root)

  el.appendChild(hordeSection)

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

    // Requirement notice. Visible text (not a colour cue or a hover-only title) that
    // names the building this unit needs; toggled in update() from unitUnlocked().
    // Built hidden — populated/revealed only while the unit is locked.
    const lock = h('p', 'unit-lock muted')
    lock.hidden = true
    lock.setAttribute('role', 'note')

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
        const ok = ctx.onRecruit(villageId, id, count)
        if (ok) pulseFx(card)
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
    card.appendChild(lock)
    card.appendChild(controls)
    grid.appendChild(card)

    cards[id] = { owned, time: timeLine, input, button, steppers, lock, costItems }
  }
  el.appendChild(grid)

  // ---- Training queue ------------------------------------------------------
  el.appendChild(h('h3', 'recruit-subtitle panel-sticky-head', 'Kolejka szkolenia'))
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

    // Horde readout (GLOBAL, capital-only). The projected strength and the forecast are
    // computed with the SAME effective mods (tech × prestige) the tick resolves the horde
    // with (effectiveMods), so the worded verdict can never disagree with the outcome the
    // engine rolls. Pure read — no mutation, no RNG.
    const gs = ctx.store.state
    const mods = effectiveMods(gs)
    hordeTimerVal.textContent = formatTime(gs.horde.timer)
    hordeLevelVal.textContent = formatInt(gs.horde.level)
    hordePowerVal.textContent = formatInt(hordePower(gs))
    const fc = hordeForecast(gs, mods)
    hordeForecastVal.textContent = fc.text
    applyForecastClass(hordeForecastVal, fc.cls)

    // Fold account-wide tech (training-speed) into the displayed per-unit time so it
    // matches the snapshot recruit() takes (onRecruit threads the same mods).
    const speedMult = recruitSpeedMult(v, aggregateTechMods(ctx.store.state.tech))
    for (const id of UNIT_IDS) {
      const ref = cards[id]
      // Per-unit unlock: the infantry triad gates on the barracks, the noble on the
      // academy (Pałac). Each card locks/unlocks independently from its own
      // `requires` building — so the noble card opens with the academy alone.
      const cardUnlocked = unitUnlocked(v, id)
      ref.owned.textContent = 'masz: ' + formatInt(v.units[id])
      ref.time.textContent = 'Czas: ' + formatTime(UNITS[id].recruitSeconds * speedMult) + '/szt.'

      // Requirement notice: shown as text while the unit is locked, naming the
      // building it needs (data-driven via UNITS[id].requires), then hidden once met.
      if (cardUnlocked) {
        ref.lock.hidden = true
        ref.lock.textContent = ''
      } else {
        ref.lock.textContent = 'Wymaga: ' + BUILDINGS[UNITS[id].requires].name
        ref.lock.hidden = false
      }

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
      // the tooltip + aria cue. Steppers/input are hard-locked per-unit (the noble's
      // controls stay live with the academy even before the barracks, and vice versa).
      const verdict = canRecruit(v, id, count)
      ref.button.setAttribute('aria-disabled', verdict.ok ? 'false' : 'true')
      ref.button.title = verdict.ok ? '' : (verdict.reason ?? '')
      ref.input.disabled = !cardUnlocked
      for (const b of ref.steppers) b.disabled = !cardUnlocked
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
