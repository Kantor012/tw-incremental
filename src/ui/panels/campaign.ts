import type { Village, BarbarianVillage, TechModifiers } from '../../engine/state'
import { D } from '../../engine/decimal'
import { formatInt, formatTime } from '../../engine/format'
import { UNIT_IDS, UNITS, type UnitId } from '../../content/units'
import { barbarianTarget } from '../../content/barbarians'
import { armyAttackPower, armyDefensePower, armyCarry, battleOutcome } from '../../systems/combat'
import { villageDefenseMult } from '../../systems/buildings'
import { stationedUnits, marchTime, canAttack, canScout } from '../../systems/marches'
import { targetsByDistance, distance, barbarianById } from '../../systems/world'
import { raidPower } from '../../systems/raids'
import { barracksUnlocked, unitUnlocked } from '../../systems/recruitment'
import { aggregateTechMods } from '../../systems/tech'
import type { UiCtx, Panel } from '../types'
import { h, unitIcon } from '../dom'
import { conquestHint } from '../conquestCopy'

/**
 * Campaign panel — the offensive screen (the "Wyprawy" tab). Since M2.2 the world
 * is SPATIAL: this lists CONCRETE barbarian villages from `store.state.world`,
 * sorted by Euclidean distance from the active village (nearest first), instead of
 * an abstract level ladder. It is the keyboard/screen-reader-friendly ALTERNATIVE
 * to the Mapa tab — every reachable target appears here as a focusable card with
 * the same dispatch path (ctx.onAttack(villageId, barb.id, units)).
 *
 * Owns: the shared army composer (one count input per unit, clamped to the home
 * garrison), the distance-sorted list of barbarian-village targets (defence / loot
 * / distance / march time / battle forecast / Attack), the in-flight march list,
 * and the defence indicator (next-raid ETA, home defence vs raid power).
 * Recruitment lives in the army panel; the rolling battle log lives in reports.
 *
 * Discipline (panel contract): the static chrome is built ONCE; {@link Panel.update}
 * only pokes textContent / attributes onto existing nodes, with two bounded
 * exceptions that rebuild ONLY when their content signature changes:
 *  - the target list rebuilds when the active village changes (the sort order is
 *    fixed per village, since neither villages nor barbarians move in M2.2), and
 *  - the in-flight march list rebuilds when its level/phase/ETA/composition
 *    signature changes.
 * The army-dependent fields on the (potentially many) target cards are only re-poked
 * when the composed army (or the barracks unlock) changes — so a steady tick that
 * merely accrues resources does no per-card work.
 *
 * Accessibility (unchanged in substance): the Attack buttons use aria-disabled (not
 * the hard `disabled` property) so they stay focusable/hoverable and their reason
 * (title + aria-live message) reaches the user; battle forecast / defence verdict
 * are conveyed by a glyph AND a word, never by colour alone (WCAG 1.4.1).
 *
 * Layout: the cards sit in the shared intrinsically-responsive .target-list grid
 * (auto-fill + minmax) with the .target card surface — the same design-system
 * classes every other tab uses; no inline layout styles.
 */

/**
 * Units the ATTACK composer offers (M5.2). The scout is a RECON unit (attack 0) with
 * its own march kind and a dedicated per-target „Zwiad" button, so it is filtered out
 * of the offensive composer. Derived from UNIT_IDS so a new combat unit needs no edit.
 */
const ATTACK_UNIT_IDS: readonly UnitId[] = UNIT_IDS.filter((id) => id !== 'scout')

/** Placeholder shown for an unscouted camp's hidden defence/loot (text, never colour). */
const UNKNOWN = '?'

/** Cached handles for the army-dependent fields of one barbarian-target card. */
interface TargetCard {
  /** The concrete barbarian village this card dispatches at (stable per build). */
  barb: BarbarianVillage
  /** Defence number — '?' until the camp is scouted (M5.2 fog of war). */
  defense: HTMLElement
  /** AT-only marker that spells out what the '?' means (title is keyboard/touch-unreachable). */
  defenseMark: HTMLElement
  loot: HTMLElement
  /** AT-only marker mirroring {@link defenseMark} for the loot '?'. */
  lootMark: HTMLElement
  march: HTMLElement
  forecast: HTMLElement
  button: HTMLButtonElement
  /** „Zwiad" dispatch (recon) — sends the shared scout count at this camp. */
  scoutBtn: HTMLButtonElement
  /** Loyalty number text + bar (M2.4 conquest progress). */
  loyalty: HTMLElement
  loyaltyBar: HTMLElement
  /** Last rounded loyalty written to the DOM (NaN = never), so a steady tick is poke-free. */
  loyaltyShown: number
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

/** Total camp loot (sum across resources) for a camp tier, as a Decimal. */
function campTotalLoot(level: number) {
  const t = barbarianTarget(level)
  return t.loot.wood.add(t.loot.clay).add(t.loot.iron)
}

/**
 * Build the campaign panel. Reads {@link UiCtx} for the live store, the world and
 * the `onAttack` commit; every cue (availability, the battle forecast, the button
 * verdict) is read straight from the combat / march / world engines so the visible
 * state can never disagree with what a dispatch will actually do.
 */
export function createCampaignPanel(ctx: UiCtx): Panel {
  // No outer .panel frame: every tab is a grid of cards directly on the page
  // background (matches buildings/army/reports/save) for consistent framing.
  const el = h('div', 'campaign-panel')

  // The village this panel currently operates on, resolved fresh on every read so a
  // selection change is picked up on the next update()/handler without a rebuild.
  const activeVillage = (): Village => ctx.store.state.villages[ctx.activeVillageId.value]

  // ---- Garrison status (home vs away) --------------------------------------
  // Doubles as the "no barracks" notice: when locked it tells the player to build
  // the Koszary first.
  const status = h('p', 'recruit-status muted')
  status.setAttribute('role', 'status')
  status.setAttribute('aria-live', 'polite')
  el.appendChild(status)

  // ---- Army composer -------------------------------------------------------
  el.appendChild(h('h3', 'recruit-subtitle', 'Skład wyprawy'))
  const composer = h('div', 'army-picker')
  const armyPicks = {} as Record<UnitId, { input: HTMLInputElement; avail: HTMLElement }>
  for (const id of ATTACK_UNIT_IDS) {
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
    for (const id of ATTACK_UNIT_IDS) armyPicks[id].input.value = String(home[id])
    update()
  })
  const clearAllBtn = h('button', 'btn btn-ghost', 'Wyczyść')
  clearAllBtn.type = 'button'
  clearAllBtn.addEventListener('click', () => {
    for (const id of ATTACK_UNIT_IDS) armyPicks[id].input.value = '0'
    update()
  })
  composerActions.appendChild(sendAllBtn)
  composerActions.appendChild(clearAllBtn)
  el.appendChild(composerActions)

  const summary = h('p', 'attack-summary muted')
  summary.setAttribute('role', 'status')
  summary.setAttribute('aria-live', 'polite')
  el.appendChild(summary)

  // ---- Scout (recon) — M5.2 -----------------------------------------------
  // A SHARED scout-count input; each target card carries its own „Zwiad" button that
  // dispatches this many scouts at that camp. Scouts reveal the camp's defence/loot
  // (the '?' on the card turns into numbers), never fight and return home unharmed.
  el.appendChild(h('h3', 'recruit-subtitle', 'Zwiad'))
  el.appendChild(
    h(
      'p',
      'muted',
      'Wyślij zwiadowców na obóz przyciskiem „Zwiad" przy celu, aby odkryć jego obronę i łup. ' +
        'Zwiad nie walczy i wraca cały.',
    ),
  )
  const scoutPick = h('div', 'army-pick')
  const scoutLabel = h('span', 'army-pick-label')
  const scoutIconWrap = h('span', 'res-icon-wrap')
  scoutIconWrap.appendChild(unitIcon('scout'))
  scoutLabel.appendChild(scoutIconWrap)
  scoutLabel.appendChild(document.createTextNode(' ' + UNITS.scout.name))
  const scoutAvail = h('span', 'army-pick-avail num muted')
  const scoutCountInput = h('input', 'recruit-count num')
  scoutCountInput.type = 'number'
  scoutCountInput.min = '0'
  scoutCountInput.step = '1'
  scoutCountInput.value = '1'
  scoutCountInput.inputMode = 'numeric'
  scoutCountInput.setAttribute('aria-label', 'Liczba zwiadowców do wysłania')
  scoutCountInput.addEventListener('input', () => update())
  scoutPick.appendChild(scoutLabel)
  scoutPick.appendChild(scoutAvail)
  scoutPick.appendChild(scoutCountInput)
  el.appendChild(scoutPick)

  const scoutMsg = h('p', 'recruit-msg muted')
  scoutMsg.setAttribute('role', 'status')
  scoutMsg.setAttribute('aria-live', 'polite')
  el.appendChild(scoutMsg)
  let lastScoutCtrlSig = ''
  // Last-seen `scouted` flag per camp id, so update() can ANNOUNCE the moment a camp
  // flips unscouted→scouted (a scout returned) — recon completion is otherwise silent
  // (the '?' just becomes numbers), leaving a player who tabbed away with no cue. A camp
  // first seen already scouted is recorded WITHOUT announcing (no false "discovered" on
  // load/import). Keyed by global barb id, so it survives a village switch.
  const scoutedSeen = new Map<string, boolean>()

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
    // Complete roster (every UnitId present) so the combat/march helpers iterating
    // UNIT_IDS see a count for each; the scout has no composer input and stays 0 — it
    // is dispatched only via the per-target „Zwiad" button, never on an attack march.
    for (const id of UNIT_IDS) army[id] = 0
    for (const id of ATTACK_UNIT_IDS) {
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

  // ---- Targets (concrete barbarian villages, nearest first) ----------------
  el.appendChild(h('h3', 'recruit-subtitle', 'Cele'))
  // Keyboard/screen-reader alternative to the Mapa tab: it lists the SAME targets,
  // sorted by distance, with the same dispatch path.
  const targetsNote = h(
    'p',
    'muted',
    'Wioski barbarzyńskie ze świata, posortowane wg odległości od aktywnej wioski — dostępna alternatywa dla widoku Mapy.',
  )
  el.appendChild(targetsNote)
  // Conquest primer (M2.4): how loyalty + the noble turn a camp into a player village.
  // ADAPTIVE — its text is set in update() from the shared conquestHint(), toggling on
  // whether the active village can yet field a Szlachcic (Pałac built), so a player
  // without the academy is told to build it (matching the per-target hint on the Mapa
  // tab) and a player with it gets the per-win drop + regeneration facts. Kept in
  // lockstep with map.ts via the shared ../conquestCopy module.
  const conquestNote = h('p', 'muted')
  el.appendChild(conquestNote)
  let lastNobleUnlocked: boolean | null = null
  // Grid template + card surface come from the shared .target-list / .target
  // classes (layout.css) — the single source of truth across tabs; no inline.
  const targetList = h('div', 'target-list')
  el.appendChild(targetList)
  el.appendChild(msg)

  // Rebuilt only when the active village (hence the sort order) changes; the army
  // signature gates the per-card poke so a plain tick does no per-card work.
  let targetCards: TargetCard[] = []
  let lastTargetSig = ''
  let lastArmySig = ''

  /**
   * (Re)build the target card list from `targetsByDistance(v, world)`. Sets every
   * STATIC field (name, level, defence, distance, the per-target Attack handler and
   * its aria-label) once; the army-dependent fields (loot/march/forecast/verdict)
   * are filled by {@link pokeTargets}. Called only when the active village changes.
   */
  const rebuildTargets = (v: Village): void => {
    const world = ctx.store.state.world
    const targets = targetsByDistance(v, world)
    targetList.textContent = ''
    targetCards = []
    if (targets.length === 0) {
      targetList.appendChild(h('p', 'queue-empty muted', 'Brak celów na mapie.'))
      return
    }
    for (const barb of targets) {
      const dist = Math.round(distance(v.x, v.y, barb.x, barb.y))

      // Card chrome comes from the shared .target class (layout.css) — no inline.
      const row = h('div', 'target')

      const head = h('div', 'target-head')
      head.appendChild(h('span', 'target-name', barb.name))
      head.appendChild(h('span', 'target-level num', 'poz. ' + barb.level))

      const statsLine = h('p', 'target-stats muted')
      // Defence is filled by pokeTargets (it shows '?' until the camp is scouted — M5.2).
      const defense = h('span', 'num')
      // Visually-hidden, AT-only cue that explains the '?' for keyboard/touch/SR users —
      // the title alone (mouse-hover only) can't reach them. Mirrors the buildings panel's
      // "(brak)" marker; pokeTargets fills/clears it alongside the glyph.
      const defenseMark = h('span', 'visually-hidden')
      const loot = h('span', 'num')
      const lootMark = h('span', 'visually-hidden')
      const distEl = h('span', 'num', formatInt(dist) + ' pól')
      const march = h('span', 'num')
      statsLine.appendChild(document.createTextNode('Obrona '))
      statsLine.appendChild(defense)
      statsLine.appendChild(defenseMark)
      statsLine.appendChild(document.createTextNode(' · Łup '))
      statsLine.appendChild(loot)
      statsLine.appendChild(lootMark)
      statsLine.appendChild(document.createTextNode(' · Odl. '))
      statsLine.appendChild(distEl)
      statsLine.appendChild(document.createTextNode(' · Marsz '))
      statsLine.appendChild(march)

      // Loyalty / conquest progress (M2.4): the camp's resistance to capture. Number
      // text AND a bar (colour is never the only cue); refreshed live by refreshLoyalty.
      const loyaltyWrap = h('div', 'target-loyalty')
      const loyaltyLabel = h('span', 'muted')
      loyaltyLabel.appendChild(document.createTextNode('Lojalność '))
      const loyalty = h('span', 'num')
      loyaltyLabel.appendChild(loyalty)
      const loyaltyBar = h('div', 'bar')
      loyaltyBar.setAttribute('role', 'progressbar')
      loyaltyBar.setAttribute('aria-valuemin', '0')
      loyaltyBar.setAttribute('aria-valuemax', '100')
      loyaltyBar.setAttribute(
        'aria-label',
        'Lojalność: ' + barb.name + ' (100 = najtrudniej przejąć)',
      )
      loyaltyBar.appendChild(h('i'))
      loyaltyWrap.appendChild(loyaltyLabel)
      loyaltyWrap.appendChild(loyaltyBar)

      const bottom = h('div', 'target-bottom')
      const forecast = h('span', 'target-forecast')
      // „Zwiad" (recon) button — dispatches the SHARED scout count at this camp (M5.2).
      // aria-disabled (not `disabled`) keeps it focusable so canScout's reason reaches
      // the user; the handler is a guarded no-op when canScout rejects.
      const scoutBtn = h('button', 'btn btn-ghost', 'Zwiad')
      scoutBtn.type = 'button'
      scoutBtn.setAttribute('aria-label', 'Wyślij zwiad: ' + barb.name)
      scoutBtn.addEventListener('click', () => {
        const cv = activeVillage()
        const world = ctx.store.state.world
        const parsed = Math.floor(Number(scoutCountInput.value))
        const count = Number.isFinite(parsed) && parsed > 0 ? parsed : 0
        const verdict = canScout(cv, world, barb.id, count, aggregateTechMods(ctx.store.state.tech))
        if (!verdict.ok) {
          scoutMsg.textContent = verdict.reason ?? 'Nie można wysłać zwiadu.'
          update()
          return
        }
        const ok = ctx.onScout(ctx.activeVillageId.value, barb.id, count)
        scoutMsg.textContent = ok
          ? 'Wysłano zwiad: ' + barb.name + '.'
          : 'Nie udało się wysłać zwiadu.'
        update()
      })
      const button = h('button', 'btn btn-primary', 'Atakuj')
      button.type = 'button'
      // aria-disabled (not `disabled`) keeps the control focusable/hoverable so its
      // reason tooltip + aria-live message reach the user; the handler stays a
      // guarded no-op when canAttack rejects (mirrors the recruitment panel).
      button.setAttribute(
        'aria-label',
        'Atakuj ' + barb.name + ' (poziom ' + barb.level + ', odległość ' + dist + ' pól)',
      )
      button.addEventListener('click', () => {
        const cv = activeVillage()
        const army = readArmy(cv)
        const verdict = canAttack(cv, barb, army)
        if (!verdict.ok) {
          msg.textContent = verdict.reason ?? 'Nie można wysłać wyprawy.'
          update()
          return
        }
        // Fog of war (M5.2): only reveal a loss FORECAST for a SCOUTED camp — otherwise
        // the confirm would leak the very defence the scout is meant to uncover. An
        // unscouted attack instead warns the target is unknown (attacking blind is allowed).
        if (!barb.scouted) {
          if (
            !window.confirm(
              'Cel niezbadany — nie znasz jego obrony. Wyślij najpierw zwiad lub zaatakuj w ciemno. Wysłać mimo to?',
            )
          ) {
            return
          }
        } else {
          const outcome = battleOutcome(
            armyAttackPower(army, aggregateTechMods(ctx.store.state.tech)),
            barbarianTarget(barb.level).defensePower,
          )
          // Guard against accidentally throwing the whole army at a camp it will lose to.
          if (
            !outcome.attackerWins &&
            !window.confirm(
              'Prognoza: porażka — wysłana armia prawdopodobnie zostanie zniszczona. Wysłać mimo to?',
            )
          ) {
            return
          }
        }
        const ok = ctx.onAttack(ctx.activeVillageId.value, barb.id, army)
        if (ok) {
          msg.textContent = 'Wysłano wyprawę: ' + barb.name + '.'
          for (const uid of ATTACK_UNIT_IDS) armyPicks[uid].input.value = '0'
        } else {
          msg.textContent = 'Nie udało się wysłać wyprawy.'
        }
        update()
      })
      bottom.appendChild(forecast)
      bottom.appendChild(scoutBtn)
      bottom.appendChild(button)

      row.appendChild(head)
      row.appendChild(statsLine)
      row.appendChild(loyaltyWrap)
      row.appendChild(bottom)
      targetList.appendChild(row)
      targetCards.push({
        barb,
        defense,
        defenseMark,
        loot,
        lootMark,
        march,
        forecast,
        button,
        scoutBtn,
        loyalty,
        loyaltyBar,
        loyaltyShown: Number.NaN,
      })
    }
  }

  /**
   * Refresh the army-dependent fields of every target card from the composed army.
   * Only called when the army (or barracks unlock) changes — never on a plain tick.
   */
  const pokeTargets = (
    v: Village,
    army: Record<UnitId, number>,
    composed: number,
    mods: TechModifiers,
  ): void => {
    const carry = armyCarry(army)
    const atkPow = armyAttackPower(army, mods)
    for (const card of targetCards) {
      const lvl = card.barb.level
      const scouted = card.barb.scouted
      // March time is pure geometry (distance × speed), so it leaks no combat info and
      // shows whenever an army is composed, scouted or not.
      card.march.textContent = composed > 0 ? formatTime(marchTime(v, card.barb, army, mods)) : '—'

      if (!scouted) {
        // Fog of war (M5.2): hide defence, loot and the battle forecast until a scout
        // reveals the camp. '?' is TEXT (never colour alone); a title points to „Zwiad"
        // for mouse users, and a visually-hidden marker carries the same cue to AT/touch.
        card.defense.textContent = UNKNOWN
        card.defense.title = 'Wyślij zwiad, aby poznać obronę.'
        card.defenseMark.textContent = ' (nieznane — wyślij zwiad, aby poznać)'
        card.loot.textContent = UNKNOWN
        card.loot.title = 'Wyślij zwiad, aby poznać łup.'
        card.lootMark.textContent = ' (nieznane — wyślij zwiad, aby poznać)'
        card.forecast.textContent = 'zbadaj zwiadem'
        card.forecast.classList.remove('forecast-win', 'forecast-lose')
      } else {
        card.defense.textContent = formatInt(barbarianTarget(lvl).defensePower)
        card.defense.title = ''
        card.defenseMark.textContent = ''
        const total = campTotalLoot(lvl)
        if (composed > 0) {
          // Haul = min(army carry, total camp loot) — the exact sum computeLoot lands.
          const cd = D(carry)
          const haul = cd.lt(total) ? cd : total
          card.loot.textContent = formatInt(haul)
          const oc = battleOutcome(atkPow, barbarianTarget(lvl).defensePower)
          const pct = Math.round(oc.attackerLossFrac * 100)
          card.forecast.textContent = oc.attackerWins
            ? '✓ wygrana · straty ~' + pct + '%'
            : '✗ porażka'
          card.forecast.classList.toggle('forecast-win', oc.attackerWins)
          card.forecast.classList.toggle('forecast-lose', !oc.attackerWins)
        } else {
          card.loot.textContent = 'do ' + formatInt(total)
          card.forecast.textContent = '—'
          card.forecast.classList.remove('forecast-win', 'forecast-lose')
        }
        card.loot.title = ''
        card.lootMark.textContent = ''
      }

      const verdict = canAttack(v, card.barb, army)
      card.button.setAttribute('aria-disabled', verdict.ok ? 'false' : 'true')
      card.button.title = verdict.ok ? '' : (verdict.reason ?? '')
    }
  }

  /**
   * Live loyalty refresh (M2.4). Loyalty regenerates every tick, so unlike the
   * army-gated {@link pokeTargets} this runs on EVERY update — but it writes a card
   * only when its rounded loyalty actually changed, so a steady tick costs ~N cheap
   * comparisons and no DOM work. (Loyalty is independent of the composed army.)
   */
  const refreshLoyalty = (): void => {
    for (const card of targetCards) {
      const rounded = Math.round(card.barb.loyalty)
      if (rounded === card.loyaltyShown) continue
      card.loyaltyShown = rounded
      card.loyalty.textContent = rounded + ' / 100'
      setBar(card.loyaltyBar, pctOf(card.barb.loyalty))
    }
  }

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
  // AT-only attribution of the wall's share of the home defence (the title is
  // mouse-only). Filled in update() when villageDefenseMult(v) > 1, else cleared.
  const homeDefWallMark = h('span', 'visually-hidden')
  homeDefVal.insertAdjacentElement('afterend', homeDefWallMark)
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
    const world = ctx.store.state.world
    const unlocked = barracksUnlocked(v)
    // Adaptive conquest primer (findings: regen + per-win drop must be stated; the
    // Mapa/Wyprawy hints must match). Refresh only when the noble-unlock state flips.
    const nobleUnlocked = unitUnlocked(v, 'noble')
    if (nobleUnlocked !== lastNobleUnlocked) {
      lastNobleUnlocked = nobleUnlocked
      conquestNote.textContent = conquestHint(nobleUnlocked)
    }
    const home = stationedUnits(v)
    const army = readArmy(v)
    const composed = armySize(army)
    const carry = armyCarry(army)
    // Account-wide tech mods threaded into every power/time estimate shown here and in
    // the per-target cards (pokeTargets), so the display matches what a dispatch does.
    const mods = aggregateTechMods(ctx.store.state.tech)
    const atkPow = armyAttackPower(army, mods)

    // "W domu" counts EVERY unit at home (scouts included); the send-all gate below uses
    // only the attack-eligible total (scouts are dispatched via „Zwiad", not attacks).
    let homeSum = 0
    for (const id of UNIT_IDS) homeSum += home[id]
    let attackHomeSum = 0
    for (const id of ATTACK_UNIT_IDS) attackHomeSum += home[id]
    let awaySum = 0
    for (const m of v.marches) for (const id of UNIT_IDS) awaySum += m.units[id]

    status.textContent = unlocked
      ? 'W domu: ' + formatInt(homeSum) + ' jedn. · na marszach: ' + formatInt(awaySum)
      : 'Zbuduj Koszary (poziom 1), aby wysyłać wyprawy.'

    // Composer rows (attack units only): available counts + clamp over-cap entries.
    for (const id of ATTACK_UNIT_IDS) {
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
    sendAllBtn.disabled = !unlocked || attackHomeSum <= 0
    clearAllBtn.disabled = composed <= 0

    // Target list: rebuild only when the active village changes (the distance sort
    // is fixed per village in M2.2). Force a card poke right after a rebuild.
    const targetSig = v.id + ':' + world.barbarians.length
    if (targetSig !== lastTargetSig) {
      lastTargetSig = targetSig
      rebuildTargets(v)
      lastArmySig = '' // force the poke below
      lastScoutCtrlSig = '' // force the scout-button refresh below
    }
    // Army-dependent card fields: poke when the composed army / unlock changes OR when
    // any camp's scouted flag flips (M5.2) — revealing its defence/loot/forecast.
    const scoutedSig = targetCards.map((c) => (c.barb.scouted ? '1' : '0')).join('')
    const armySig =
      v.id + ':' + unlocked + ':' + UNIT_IDS.map((id) => army[id]).join(',') + ':' + scoutedSig
    if (armySig !== lastArmySig) {
      lastArmySig = armySig
      pokeTargets(v, army, composed, mods)
    }

    // ---- Scout control (M5.2) ----
    // Shared scout-count availability + clamp; the per-card „Zwiad" buttons share one
    // canScout verdict (same garrison + count, target always exists for a listed card),
    // so it is computed once and applied, change-gated so a steady tick is poke-free.
    scoutAvail.textContent = 'dostępne: ' + formatInt(home.scout)
    scoutCountInput.max = String(home.scout)
    scoutCountInput.disabled = home.scout <= 0
    const scoutCur = Math.floor(Number(scoutCountInput.value))
    if (Number.isFinite(scoutCur) && scoutCur > home.scout) {
      scoutCountInput.value = String(home.scout)
    }
    const scoutParsed = Math.floor(Number(scoutCountInput.value))
    const scoutCount = Number.isFinite(scoutParsed) && scoutParsed > 0 ? scoutParsed : 0
    const scoutCtrlSig = home.scout + ':' + scoutCount + ':' + targetCards.length
    if (scoutCtrlSig !== lastScoutCtrlSig) {
      lastScoutCtrlSig = scoutCtrlSig
      for (const card of targetCards) {
        const verdict = canScout(v, world, card.barb.id, scoutCount, mods)
        card.scoutBtn.setAttribute('aria-disabled', verdict.ok ? 'false' : 'true')
        card.scoutBtn.title = verdict.ok ? '' : (verdict.reason ?? '')
      }
    }

    // Scout-reveal feedback (M5.2): close the discovery loop when a scout returns. Any
    // camp whose `scouted` flips false→true since the last frame is announced via the
    // polite scout status, so the completion is heard even if the user is not looking at
    // the silently-revealing card. First sighting of a camp only records its state.
    const revealed: string[] = []
    for (const card of targetCards) {
      const id = card.barb.id
      const now = card.barb.scouted
      const seen = scoutedSeen.get(id)
      if (seen === undefined) {
        scoutedSeen.set(id, now)
      } else if (seen !== now) {
        scoutedSeen.set(id, now)
        if (now) revealed.push(card.barb.name)
      }
    }
    if (revealed.length > 0) {
      scoutMsg.textContent = 'Zwiad zakończony — odkryto obronę: ' + revealed.join(', ') + '.'
    }

    // Loyalty changes every tick (regen / noble hits), independent of the army — so it
    // gets its own per-tick, change-gated refresh rather than riding the army poke.
    refreshLoyalty()

    // Marches in progress — rebuilt only when their signature (target / phase /
    // whole-second ETA / composition) changes, so the steady state is poke-free.
    const marchSig = v.marches
      .map(
        (m) =>
          m.kind +
          ':' +
          m.targetId +
          ':' +
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
          // Name the concrete target village; fall back to the tier label for a
          // legacy/migrated march whose id no longer resolves in the world.
          const barb = barbarianById(world, m.targetId)
          const baseName = barb
            ? barb.name
            : 'Wioska barbarzyńska (poz. ' + m.targetLevel + ')'
          // Tag a recon march so the list distinguishes „Zwiad" from an attack (M5.2).
          const targetName = (m.kind === 'scout' ? 'Zwiad — ' : '') + baseName
          main.appendChild(h('span', 'march-target', targetName))
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
    // Defence MUST be read with the same tech mods AND the same wall shield the raid
    // engine defends with (raids.ts: battleOutcome(power, armyDefensePower(home, mods) *
    // villageDefenseMult(v))), or the shown "Obrona domowa" stat, the defence-vs-threat
    // bar and the verdict would understate real defence once Fortyfikacje (defense_mult)
    // is bought or a Mur (defense_bonus) is built — and could contradict the actual raid
    // outcome (a village the engine keeps safe being reported as zagrożona). The threat
    // (raidPower) stays on NO_TECH_MODS, mirroring raids.ts.
    const wallMult = villageDefenseMult(v)
    const homeDef = armyDefensePower(home, mods) * wallMult
    const threat = raidPower(v)
    homeDefVal.textContent = formatInt(homeDef)
    // Attribute the wall's contribution so the player connects the boost to the Mur.
    if (wallMult > 1) {
      const wallPct = Math.round((wallMult - 1) * 100)
      homeDefVal.title = 'Mur zwiększa obronę osady o +' + wallPct + '%.'
      homeDefWallMark.textContent = ' (w tym mur +' + wallPct + '%)'
    } else {
      homeDefVal.title = ''
      homeDefWallMark.textContent = ''
    }
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
