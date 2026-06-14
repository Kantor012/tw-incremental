import type { Village } from '../../engine/state'
import { D } from '../../engine/decimal'
import { formatInt, formatTime } from '../../engine/format'
import { UNIT_IDS, UNITS, type UnitId } from '../../content/units'
import { barbarianTarget, MAX_TARGET_LEVEL } from '../../content/barbarians'
import { armyAttackPower, armyDefensePower, armyCarry, battleOutcome } from '../../systems/combat'
import { stationedUnits, marchTime, canAttack } from '../../systems/marches'
import { raidPower } from '../../systems/raids'
import { barracksUnlocked } from '../../systems/recruitment'
import type { UiCtx, Panel } from '../types'
import { h, unitIcon } from '../dom'

/**
 * Campaign panel — the offensive screen (the old app.ts "Wyprawy" + "Obrona"
 * sections, lifted verbatim in behaviour and re-laid-out as responsive grids).
 *
 * Owns: the army composer (one count input per unit, clamped to the home
 * garrison), the sliding window of barbarian camp targets (defence / loot /
 * march time / battle forecast / Attack), the in-flight march list, and the
 * defence indicator (next-raid ETA, home defence vs raid power). Recruitment
 * lives in the army panel; the rolling battle log lives in the reports panel.
 *
 * Discipline (panel contract): the DOM is built ONCE here and cached;
 * {@link Panel.update} only pokes textContent / style / attributes onto existing
 * nodes — it never rebuilds the tree, with two bounded exceptions (the march list
 * and would-be lists) that rebuild ONLY when their content signature changes. The
 * shell drives update() on every store revision while this is the active tab, and
 * once when it becomes active.
 *
 * Accessibility carried over from the old panel, unchanged in substance:
 *  - the Attack buttons use aria-disabled (not the hard `disabled` property) so
 *    they stay focusable/hoverable and their reason (title + aria-live message)
 *    actually reaches the user; the click handler is a guarded no-op when rejected.
 *  - battle phase / forecast / defence verdict are conveyed by a glyph AND a word,
 *    never by colour alone (WCAG 1.4.1).
 *
 * Layout note: the targets sit in an intrinsically-responsive card grid (the
 * shared .target-list class: auto-fill + minmax), so desktop shows several
 * columns and mobile collapses to one — no media query needed. Grid template +
 * card surface live ENTIRELY in the design-system classes (.target-list /
 * .target in layout.css), shared with every other tab so framing never diverges;
 * no inline layout styles. Every card's INNER markup reuses the shared,
 * already-styled component classes so the a11y affordances carry over untouched.
 */

/**
 * Fixed window of camp tiers shown at once. The window SLIDES with the player's
 * reach (see update()), so the DOM rows are built once and only their text/state
 * is poked per frame — the same no-rebuild discipline as everywhere else.
 */
const TARGET_WINDOW = 6

/** Cached handles for one barbarian-target card. */
interface TargetRowRefs {
  level: HTMLElement
  defense: HTMLElement
  loot: HTMLElement
  march: HTMLElement
  forecast: HTMLElement
  button: HTMLButtonElement
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
 * Build the campaign panel. Reads {@link UiCtx} for the live store and the
 * `onAttack` commit; every cue (availability, the battle forecast, the button
 * verdict) is read straight from the combat / march engines so the visible state
 * can never disagree with what a dispatch will actually do.
 */
export function createCampaignPanel(ctx: UiCtx): Panel {
  // No outer .panel frame: every tab is a grid of cards directly on the page
  // background (matches buildings/army/reports/save) for consistent framing.
  const el = h('div', 'campaign-panel')

  // The village this panel currently operates on. The selector (layout.ts) writes
  // ctx.activeVillageId; every read here resolves it fresh so a selection change is
  // picked up on the next update()/handler without rebuilding the DOM.
  const activeVillage = (): Village => ctx.store.state.villages[ctx.activeVillageId.value]

  // ---- Garrison status (home vs away) --------------------------------------
  // Doubles as the "no barracks" notice required by the brief: when locked it
  // tells the player to build the Koszary first.
  const status = h('p', 'recruit-status muted')
  status.setAttribute('role', 'status')
  status.setAttribute('aria-live', 'polite')
  el.appendChild(status)

  // ---- Army composer -------------------------------------------------------
  el.appendChild(h('h3', 'recruit-subtitle', 'Skład wyprawy'))
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

    // "dostępne: N" — the units AT HOME (stationedUnits), distinct from those away.
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
  el.appendChild(composer)

  const composerActions = h('div', 'recruit-controls')
  const sendAllBtn = h('button', 'btn btn-ghost', 'Wyślij wszystkie dostępne')
  sendAllBtn.type = 'button'
  sendAllBtn.addEventListener('click', () => {
    const home = stationedUnits(activeVillage())
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
  el.appendChild(composerActions)

  const summary = h('p', 'attack-summary muted')
  summary.setAttribute('role', 'status')
  summary.setAttribute('aria-live', 'polite')
  el.appendChild(summary)

  /**
   * Read the composed army from the inputs, clamped per-type to the units currently
   * AT HOME (stationedUnits). Clamping here means the request can never exceed the
   * garrison, so canAttack only ever gates on the barracks unlock / an empty army —
   * the displayed estimates, the button verdict and the actual dispatch can never
   * disagree.
   */
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

  // Feedback for the last attack attempt (success or the canAttack reason).
  const msg = h('p', 'recruit-msg muted')
  msg.setAttribute('role', 'status')
  msg.setAttribute('aria-live', 'polite')

  // ---- Targets (sliding window, responsive card grid) ----------------------
  el.appendChild(h('h3', 'recruit-subtitle', 'Cele'))
  // Grid template + card surface come from the shared .target-list / .target
  // classes (layout.css) — the single source of truth across tabs; no inline.
  const targetList = h('div', 'target-list')

  const targetRows: TargetRowRefs[] = []
  // The level currently shown in each row (updated per frame); the click handler
  // reads THIS so a row always attacks the tier it is currently displaying.
  const rowLevels: number[] = []
  for (let i = 0; i < TARGET_WINDOW; i++) {
    rowLevels.push(i + 1)
    // Card chrome comes from the shared .target class (layout.css) — no inline.
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
    const button = h('button', 'btn btn-primary', 'Atakuj')
    button.type = 'button'
    // aria-disabled (not `disabled`) keeps the control focusable/hoverable so its
    // reason tooltip + aria-live message reach the user; the handler stays a
    // guarded no-op when canAttack rejects (mirrors the recruitment panel).
    button.addEventListener('click', () => {
      const v = activeVillage()
      const lvl = rowLevels[i]
      const army = readArmy(v)
      const verdict = canAttack(v, lvl, army)
      if (!verdict.ok) {
        msg.textContent = verdict.reason ?? 'Nie można wysłać wyprawy.'
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
      const ok = ctx.onAttack(ctx.activeVillageId.value, lvl, army)
      if (ok) {
        msg.textContent = 'Wysłano wyprawę: ' + target.name + '.'
        for (const uid of UNIT_IDS) armyPicks[uid].input.value = '0'
      } else {
        msg.textContent = 'Nie udało się wysłać wyprawy.'
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
  el.appendChild(targetList)
  el.appendChild(msg)

  // ---- Marches in progress -------------------------------------------------
  el.appendChild(h('h3', 'recruit-subtitle', 'Marsze w toku'))
  const marchList = h('ul', 'march-list')
  el.appendChild(marchList)
  let lastMarchSig = ''

  // ---- Defence indicator (incoming raids) ----------------------------------
  el.appendChild(h('h3', 'recruit-subtitle', 'Obrona osady'))
  const defStats = h('div', 'building-stats')
  const mkStat = (label: string): HTMLElement => {
    const wrap = h('div', 'stat')
    wrap.appendChild(h('span', 'stat-label muted', label))
    const val = h('span', 'num stat-val')
    wrap.appendChild(val)
    defStats.appendChild(wrap)
    return val
  }
  const raidEtaVal = mkStat('Następny najazd')
  const homeDefVal = mkStat('Obrona domowa')
  const raidPowerVal = mkStat('Siła najazdu')
  el.appendChild(defStats)

  // Defence-vs-threat bar. Colour is never the sole cue: a glyph + worded verdict
  // (below) carries the same information for colour-blind / greyscale users.
  const defBar = h('div', 'bar defense-bar')
  defBar.setAttribute('role', 'progressbar')
  defBar.setAttribute('aria-valuemin', '0')
  defBar.setAttribute('aria-valuemax', '100')
  defBar.setAttribute('aria-label', 'Obrona domowa względem siły najazdu')
  defBar.appendChild(h('i'))
  el.appendChild(defBar)

  const defVerdict = h('p', 'defense-verdict')
  defVerdict.setAttribute('role', 'status')
  defVerdict.setAttribute('aria-live', 'polite')
  el.appendChild(defVerdict)

  // ---- Reactivity ----------------------------------------------------------
  const update = (): void => {
    const v = activeVillage()
    const unlocked = barracksUnlocked(v)
    const home = stationedUnits(v)
    const army = readArmy(v)
    const composed = armySize(army)
    const carry = armyCarry(army)
    const atkPow = armyAttackPower(army)
    const atkHomePow = armyAttackPower(home)

    let homeSum = 0
    for (const id of UNIT_IDS) homeSum += home[id]
    let awaySum = 0
    for (const m of v.marches) for (const id of UNIT_IDS) awaySum += m.units[id]

    status.textContent = unlocked
      ? 'W domu: ' + formatInt(homeSum) + ' jedn. · na marszach: ' + formatInt(awaySum)
      : 'Zbuduj Koszary (poziom 1), aby wysyłać wyprawy.'

    // Composer rows: available counts + clamp any over-cap entry down to home size.
    for (const id of UNIT_IDS) {
      const pick = armyPicks[id]
      pick.avail.textContent = 'dostępne: ' + formatInt(home[id])
      pick.input.max = String(home[id])
      pick.input.disabled = !unlocked || home[id] <= 0
      // Self-correct an over-cap entry down to the garrison size (rare; only when a
      // value already exceeds what's at home — never touches an in-range entry, so
      // typing is undisturbed).
      const cur = Math.floor(Number(pick.input.value))
      if (Number.isFinite(cur) && cur > home[id]) pick.input.value = String(home[id])
    }

    summary.textContent =
      composed > 0
        ? 'Wyślesz ' +
          formatInt(composed) +
          ' jedn. · atak ' +
          formatInt(atkPow) +
          ' · udźwig ' +
          formatInt(carry)
        : 'Wybierz jednostki do wysłania.'
    sendAllBtn.disabled = !unlocked || homeSum <= 0
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
        tr.march.textContent = formatTime(marchTime(v, lvl, army))
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

      const verdict = canAttack(v, lvl, army)
      tr.button.setAttribute('aria-disabled', verdict.ok ? 'false' : 'true')
      tr.button.title = verdict.ok ? '' : (verdict.reason ?? '')
      tr.button.setAttribute('aria-label', 'Atakuj obóz barbarzyńców (poziom ' + lvl + ')')
    }

    // Marches in progress — rebuilt only when their signature (level / phase /
    // whole-second ETA / composition) changes, so the steady state is poke-free.
    const marchSig = v.marches
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
      if (v.marches.length === 0) {
        marchList.appendChild(h('li', 'queue-empty muted', 'Brak marszów w toku.'))
      } else {
        for (const m of v.marches) {
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
    raidEtaVal.textContent = formatTime(v.raidTimer)
    const homeDef = armyDefensePower(home)
    const threat = raidPower(v)
    homeDefVal.textContent = formatInt(homeDef)
    raidPowerVal.textContent = formatInt(Math.round(threat))

    setBar(defBar, threat > 0 ? pctOf((homeDef / threat) * 100) : 0)
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
  }

  return { el, update }
}
