import { RESOURCE_IDS, type ResourceId, type GameState } from '../../engine/state'
import { formatInt } from '../../engine/format'
import { UNIT_IDS, UNITS, type UnitId } from '../../content/units'
import { catalogMaxUpgrade, isUpgradeable, upgradeCost, unitUpgradeMult } from '../../content/forge'
import {
  forgeBuilt,
  forgeLevel,
  unitUpgradeLevel,
  effectiveMaxUpgrade,
  canUpgrade,
} from '../../systems/forge'
import type { UiCtx, Panel } from '../types'
import { h, unitIcon, RESOURCE_NAMES, emptyState, helpTip, pulseFx } from '../dom'

/**
 * Forge panel — the „Kuźnia" tab (M15): PERMANENT, account-wide upgrades of concrete unit
 * types. The FIRST per-unit-type modifier in the game (the passive/prestige trees grant only
 * GLOBAL attack/defense multipliers), so this screen sits beside Wojsko as the second axis of
 * army-building: a one-time, ever-deepening boost to a type's attack AND defence.
 *
 * Gated by the manually-built Kuźnia (content/buildings.forge, autoBuildable:false): without
 * one the mechanic is dormant and the panel shows an emptyState pointing at the building. The
 * Kuźnia's level is the DEPTH CAP on every track (systems/forge.effectiveMaxUpgrade), and the
 * upgrades are paid from the CAPITAL (villageOrder[0]) regardless of which village is active —
 * so the status line names the capital and the cost cards read its garrison's resources.
 *
 * Scope: only the LINE COMBAT units are upgradeable (content/forge.FORGE_UPGRADES — the
 * infantry triad + the cavalry pair); the utility/siege units are absent here by design. The
 * card roster is derived from {@link isUpgradeable}, so adding/removing an upgradeable unit in
 * the data needs no edit to this file.
 *
 * Discipline (panel contract): the static chrome is built ONCE; {@link Panel.update} only pokes
 * textContent / styles / attributes onto existing nodes — it never rebuilds the tree. The
 * „Ulepsz" button uses aria-disabled (not the hard `disabled` property) so it stays focusable
 * and its reason reaches the user; pulseFx confirms a successful upgrade (mirrors Budynki /
 * Wojsko). The visible cues (level/cap, cost shortfall, the cap/gate note) are read straight
 * from the forge engine so they can never disagree with the button verdict.
 */

/** Cached handles for one upgradeable-unit card. */
interface ForgeCardRefs {
  /** „Poziom X/Y" — current upgrade level over the catalogue depth cap. */
  level: HTMLElement
  /** „+N% atak i obrona" (current bonus, with the next-level preview). */
  bonus: HTMLElement
  /** Wrapper holding the next-level cost chips; hidden once the catalogue cap is reached. */
  costWrap: HTMLElement
  /**
   * Structural note (role=note): names the reason the track is blocked when it is NOT an
   * affordability issue (no Kuźnia / catalogue cap reached / Kuźnia-level gate). Affordability
   * is cued on the cost chips themselves, so it is not repeated here. Hidden when upgradeable.
   */
  note: HTMLElement
  /** „Ulepsz" button (aria-disabled + reason title, never the hard `disabled`). */
  button: HTMLButtonElement
  /**
   * Per-resource next-level cost chip: `item` toggles the .is-short shortfall state, `val`
   * holds the cost amount, `mark` is a visually-hidden text cue (shortfall must never be
   * conveyed by colour alone — WCAG 1.4.1). Mirrors the recruit card's cost chips.
   */
  costItems: Record<ResourceId, { item: HTMLElement; val: HTMLElement; mark: HTMLElement }>
}

/** The upgradeable unit ids, in the catalogue's stable order (derived — not hand-listed). */
const UPGRADEABLE: UnitId[] = UNIT_IDS.filter((id) => isUpgradeable(id))

/**
 * The whole-percent bonus a unit type fights with at upgrade `level`, derived from the CANONICAL
 * combat multiplier (content/forge.unitUpgradeMult) — `(mult - 1) × 100` — so the displayed „+N%"
 * can never drift from the value armyAttackPower/armyDefensePower actually apply. Level 0 → +0%.
 */
function bonusPct(level: number): number {
  return Math.round((unitUpgradeMult(level) - 1) * 100)
}

export function createForgePanel(ctx: UiCtx): Panel {
  // No outer .panel frame: a column of sections directly on the page background, like the
  // other Wojna tabs (army/campaign/events) for consistent framing.
  const el = h('div', 'forge-panel')

  // ---- Intro -------------------------------------------------------------
  const intro = h(
    'p',
    'muted',
    'Kuźnia trwale ulepsza WYPOSAŻENIE wybranego typu jednostki — każdy poziom zwiększa zarówno ' +
      'atak, jak i obronę tej jednostki. Ulepszenia są stałe i obejmują całe imperium (nie znikają ' +
      'po wysłaniu wojsk), a opłacasz je ze stolicy.',
  )
  intro.style.fontSize = 'var(--text-sm)'
  intro.appendChild(
    helpTip(
      'Ulepszać można tylko jednostki liniowe (piechota i kawaleria) — narzędzia oblężnicze i ' +
        'zwiadowcze nie. Głębokość ulepszeń ogranicza poziom Kuźni: aby sięgnąć kolejnego poziomu ' +
        'ulepszenia, Kuźnia musi mieć co najmniej taki poziom. Bonus liczy się przy rozstrzygnięciu ' +
        'walki, więc działa dla każdej jednostki danego typu, w ataku i w obronie.',
      { label: 'Jak działa Kuźnia' },
    ),
  )
  el.appendChild(intro)

  // ---- Status line (Kuźnia level + capital attribution) -------------------
  // Visible only with a Kuźnia. Names the capital because every upgrade is paid from
  // villageOrder[0], regardless of the active village (account-wide mechanic). This is
  // PERSISTENT info rewritten every frame, NOT an announcement — so it carries no
  // role=status / aria-live (that would make a screen reader re-read it on every tick).
  // Real announcements (upgrade success / blocking reason) go to the live `msg` line below.
  const status = h('p', 'recruit-status muted')
  el.appendChild(status)

  // ---- Gate (no Kuźnia) ---------------------------------------------------
  // emptyState carries the message in real text; the hint points at the concrete next step
  // (the Kuźnia is autoBuildable:false → it must be built by hand on the Budynki tab).
  // Worded to read correctly in BOTH no-Kuźnia cases: a fresh game (no upgrades yet) AND a
  // post-reset account that still carries persisted upgrades — the cards below then show those
  // active levels, so the banner only signals that no FURTHER upgrades are possible until rebuilt.
  const gateBox = emptyState(
    'Brak Kuźni',
    'Zbuduj Kuźnię (zakładka Budynki), aby ulepszać jednostki. Wykupione ulepszenia są trwałe — ' +
      'obejmują całe imperium i działają w walce nawet bez Kuźni.',
    'div',
  )
  el.appendChild(gateBox)

  // ---- Upgrade cards (responsive grid, shared .unit-grid) -----------------
  const grid = h('div', 'unit-grid')
  const cards = {} as Record<UnitId, ForgeCardRefs>

  for (const id of UPGRADEABLE) {
    const def = UNITS[id]
    const card = h('div', 'unit-card')

    // Header: icon + name (left), level/cap (right).
    const head = h('div', 'building-head')
    const nameWrap = h('span', 'building-name')
    const iconWrap = h('span', 'res-icon-wrap')
    iconWrap.appendChild(unitIcon(id))
    nameWrap.appendChild(iconWrap)
    nameWrap.appendChild(document.createTextNode(' ' + def.name))
    head.appendChild(nameWrap)
    const level = h('span', 'building-level num')
    head.appendChild(level)

    // Bonus line: the current per-type bonus, with the next-level preview.
    const bonus = h('p', 'building-desc')

    // Next-level cost chips (TOTAL for the next single level). Shortfall is cued without
    // relying on colour alone (.is-short adds a ⚠ glyph + bold, a hover title and a
    // visually-hidden marker), exactly like the recruit card.
    const initial = upgradeCost(id, 0)
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

    // Structural note (no Kuźnia / cap reached / Kuźnia-level gate). Visible text, never a
    // colour cue or a hover-only title; built hidden and revealed only while blocked.
    const note = h('p', 'unit-lock muted')
    note.hidden = true
    note.setAttribute('role', 'note')

    // Action: „Ulepsz". aria-disabled (not the hard `disabled`) so it stays focusable and its
    // reason reaches the user; the click handler is a guarded no-op when canUpgrade rejects.
    const controls = h('div', 'recruit-controls')
    const button = h('button', 'btn btn-primary', 'Ulepsz')
    button.type = 'button'
    button.setAttribute('aria-label', 'Ulepsz: ' + def.name)
    button.addEventListener('click', () => {
      const gs = ctx.store.state
      if (canUpgrade(gs, id)) {
        const ok = ctx.onUpgradeUnit(id)
        if (ok) {
          pulseFx(card)
          msg.textContent =
            'Ulepszono: ' + def.name + ' (poziom ' + unitUpgradeLevel(ctx.store.state, id) + ').'
        } else {
          msg.textContent = 'Nie udało się ulepszyć: ' + def.name + '.'
        }
      } else {
        msg.textContent = upgradeReason(gs, id) || 'Nie można ulepszyć.'
      }
      update()
    })
    controls.appendChild(button)

    card.appendChild(head)
    card.appendChild(bonus)
    card.appendChild(costWrap)
    card.appendChild(note)
    card.appendChild(controls)
    grid.appendChild(card)

    cards[id] = { level, bonus, costWrap, note, button, costItems }
  }
  el.appendChild(grid)

  // Feedback for the last upgrade attempt (success or the blocking reason).
  const msg = h('p', 'recruit-msg muted')
  msg.setAttribute('role', 'status')
  msg.setAttribute('aria-live', 'polite')
  el.appendChild(msg)

  /**
   * The reason `id` cannot be upgraded right now (or '' when it can). Mirrors the gate ORDER in
   * systems/forge.canUpgrade so the visible cue can never disagree with the button verdict: no
   * Kuźnia → catalogue cap reached → Kuźnia-level gate → capital affordability. Pure read.
   */
  const upgradeReason = (gs: GameState, id: UnitId): string => {
    if (!forgeBuilt(gs)) return 'Najpierw zbuduj Kuźnię (zakładka Budynki).'
    const lvl = unitUpgradeLevel(gs, id)
    if (lvl >= catalogMaxUpgrade(id)) return 'Osiągnięto maksymalny poziom ulepszenia.'
    if (lvl >= effectiveMaxUpgrade(gs, id)) return 'Wymaga Kuźni na poziomie ' + (lvl + 1) + '.'
    const capital = gs.villages[gs.villageOrder[0]]
    if (!capital) return 'Brak stolicy.'
    const cost = upgradeCost(id, lvl)
    for (const r of RESOURCE_IDS) {
      if (capital.resources[r].lt(cost[r])) return 'Brak surowców w stolicy.'
    }
    return ''
  }

  // ---- Reactivity ----------------------------------------------------------
  const update = (): void => {
    const gs = ctx.store.state
    const built = forgeBuilt(gs)
    const fLevel = forgeLevel(gs)
    const capital = gs.villages[gs.villageOrder[0]]
    // state.forge is EMPIRE-WIDE within a run (one map, every village's army), bought with the
    // capital's resources and gated by the per-run Kuźnia — so every meta reset (ascend / newEra /
    // newDynasty / startChallenge) clears it alongside state.tech. It can still be non-empty here
    // mid-run with a razed/not-yet-built Kuźnia (forgeBuilt false but levels persist until reset),
    // and those upgrades keep applying in combat (tick → marches/raids/hordes). So the cards must
    // stay visible whenever a Kuźnia stands OR any upgrade level remains — otherwise the panel would
    // hide active, in-combat bonuses and the banner would falsely imply the player has none.
    const hasAnyUpgrade = UPGRADEABLE.some((id) => unitUpgradeLevel(gs, id) > 0)

    // Gate banner shows whenever no Kuźnia stands; the grid additionally shows the (still-applying)
    // upgrade cards, so the banner only means: no FURTHER upgrades are possible until rebuilt.
    gateBox.hidden = built
    grid.hidden = !(built || hasAnyUpgrade)
    status.hidden = !built
    if (built) {
      status.textContent =
        'Poziom Kuźni: ' +
        formatInt(fLevel) +
        ' • ulepszenia opłacasz ze stolicy: ' +
        (capital?.name ?? '—')
    }

    for (const id of UPGRADEABLE) {
      const ref = cards[id]
      const lvl = unitUpgradeLevel(gs, id)
      const catCap = catalogMaxUpgrade(id)
      const effMax = effectiveMaxUpgrade(gs, id)
      const atCatCap = lvl >= catCap

      // Level/cap + current bonus (with the next-level preview while there is headroom).
      ref.level.textContent = 'Poziom ' + lvl + '/' + catCap
      const cur = '+' + bonusPct(lvl) + '% atak i obrona'
      ref.bonus.textContent = atCatCap
        ? 'Bonus: ' + cur + ' (maks.)'
        : 'Bonus: ' + cur + ' → +' + bonusPct(lvl + 1) + '% po ulepszeniu'

      // Next-level cost chips: hidden once nothing can be bought right now — either the
      // catalogue cap is reached (no further level) OR the Kuźnia-level gate blocks the next
      // level (lvl >= effMax). In the gated case the cost is unpayable for a reason that is
      // NOT affordability, so showing the chips (with their red shortfall cue) would falsely
      // read as „brak surowca"; the structural note „Wymaga Kuźni na poziomie N+1" carries the
      // real reason instead.
      const gatedOrCapped = atCatCap || lvl >= effMax
      ref.costWrap.hidden = gatedOrCapped
      if (!gatedOrCapped) {
        const cost = upgradeCost(id, lvl)
        for (const r of RESOURCE_IDS) {
          const ci = ref.costItems[r]
          ci.val.textContent = formatInt(cost[r])
          const short = capital !== undefined && capital.resources[r].lt(cost[r])
          ci.item.classList.toggle('is-short', short)
          ci.item.title = short ? RESOURCE_NAMES[r] + ': brak surowca' : ''
          ci.mark.textContent = short ? ' (brak)' : ''
        }
      }

      // Structural note (text, not colour alone): only the NON-affordability blocks, since the
      // cost chips already cue a shortfall. Order matches upgradeReason / canUpgrade.
      if (!built) {
        ref.note.textContent = 'Wymaga Kuźni (zbuduj na zakładce Budynki).'
        ref.note.hidden = false
      } else if (atCatCap) {
        ref.note.textContent = 'Osiągnięto maksymalny poziom ulepszenia.'
        ref.note.hidden = false
      } else if (lvl >= effMax) {
        ref.note.textContent = 'Wymaga Kuźni na poziomie ' + (lvl + 1) + '.'
        ref.note.hidden = false
      } else {
        ref.note.textContent = ''
        ref.note.hidden = true
      }

      // Button reflects the engine's canUpgrade; the reason becomes the tooltip + aria cue.
      const ok = canUpgrade(gs, id)
      ref.button.setAttribute('aria-disabled', ok ? 'false' : 'true')
      ref.button.title = ok ? '' : upgradeReason(gs, id)
    }
  }

  return { el, update }
}
