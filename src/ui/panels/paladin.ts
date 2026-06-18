import type { GameState } from '../../engine/state'
import { formatInt, formatTime } from '../../engine/format'
import {
  MAX_PALADIN_LEVEL,
  PALADIN_ABILITY,
  paladinAuraMult,
  xpForLevel,
} from '../../content/paladin'
import { paladinUnlocked, canActivateAbility } from '../../systems/paladin'
import type { UiCtx, Panel } from '../types'
import { h, paladinIcon, emptyState, helpTip, pulseFx } from '../dom'

/**
 * Paladin panel — the „Paladyn" tab (M16): the FIRST hero that grows DIRECTLY from the PvE
 * loop. The paladin earns XP from WON attacks, levels up (a finite 1..{@link MAX_PALADIN_LEVEL}
 * ladder), radiates a scaling AURA (a global attack+defence multiplier folded into combat via
 * systems/paladin.paladinMods), and — the game's FIRST player-triggered, cooldown-gated
 * ABILITY — can charge for a short, strong attack surge that the player times for a hard target.
 *
 * Gated by the manually-built Pałac paladyna (content/buildings.paladin, autoBuildable:false):
 * without one the mechanic is dormant and the panel shows an emptyState pointing at the building
 * (mirroring the engine's identity gate — paladinUnlocked is false, paladinMods folds to identity,
 * XP accrual is short-circuited). The level/aura/XP/timers live on {@link GameState.paladin}.
 *
 * Discipline (panel contract): the static chrome is built ONCE; {@link Panel.update} only pokes
 * textContent / styles / attributes onto existing nodes — it never rebuilds the tree. The „Użyj"
 * button uses aria-disabled (not the hard `disabled`) so it stays focusable and its blocking
 * reason reaches the user; pulseFx confirms a successful activation (mirrors Kuźnia / Wojsko).
 *
 * Accessibility: the PERSISTENT lines (level / XP bar / aura / the ability countdown) carry NO
 * aria-live — they are rewritten every tick (the countdown burns down each frame) and a live
 * region would make a screen reader re-read them every second. Real ANNOUNCEMENTS (a successful
 * activation, a refusal reason) go to a separate polite `msg` line. The countdown urgency is
 * carried in WORDS (Aktywna / Odnowienie / Gotowa), never colour alone (WCAG 1.4.1).
 */

/** Clamp a 0..100 pct (NaN → 0) onto a `.bar > i` fill + the host's aria-valuenow. */
function setBar(fill: HTMLElement, bar: HTMLElement, pct: number): void {
  const p = Number.isFinite(pct) ? Math.max(0, Math.min(100, pct)) : 0
  fill.style.width = p + '%'
  bar.setAttribute('aria-valuenow', String(Math.round(p)))
}

export function createPaladinPanel(ctx: UiCtx): Panel {
  // No outer .panel frame: a column of sections directly on the page background, like the
  // other Wojna tabs (army/forge/campaign/events) for consistent framing.
  const el = h('div', 'paladin-panel')

  // ---- Intro --------------------------------------------------------------
  const intro = h(
    'p',
    'muted',
    'Paladyn rośnie w sile WALKĄ: każda WYGRANA bitwa daje mu doświadczenie, a kolejne ' +
      'poziomy wzmacniają jego AURĘ — stały mnożnik ataku i obrony całego imperium. Im więcej ' +
      'walczysz, tym silniejszy paladyn, a silniejszy paladyn ułatwia kolejne walki.',
  )
  intro.style.fontSize = 'var(--text-sm)'
  intro.appendChild(
    helpTip(
      'Paladyn działa tylko, gdy stoi Pałac paladyna. XP zdobywa za wygrane ataki (im silniejszy ' +
        'pokonany wróg, tym więcej). Aura podbija atak i obronę przy KAŻDYM rozstrzygnięciu walki. ' +
        'Aktywna zdolność to krótki, mocny zryw na długim odnowieniu — wybierz moment na trudny cel. ' +
        'Poziom paladyna jest skończony i zeruje się po każdym wielkim resecie (prestiż/era/dynastia/wyzwanie).',
      { label: 'Jak działa paladyn' },
    ),
  )
  el.appendChild(intro)

  // ---- Gate (no Pałac paladyna) -------------------------------------------
  // emptyState carries the message in real text; the hint points at the concrete next step
  // (the Pałac paladyna is autoBuildable:false → it must be built by hand on the Budynki tab).
  const gateBox = emptyState(
    'Brak paladyna',
    'Zbuduj Pałac paladyna (zakładka Budynki), aby powołać bohatera rosnącego w walce.',
    'div',
  )
  el.appendChild(gateBox)

  // ---- Live content (hidden without a Palace) -----------------------------
  const content = h('div', 'paladin-content')

  // Header: hero crest + „poziom N/10".
  const head = h('div', 'building-head')
  const nameWrap = h('span', 'building-name')
  const iconWrap = h('span', 'res-icon-wrap')
  iconWrap.appendChild(paladinIcon())
  nameWrap.appendChild(iconWrap)
  nameWrap.appendChild(document.createTextNode(' Paladyn'))
  head.appendChild(nameWrap)
  const levelLabel = h('span', 'building-level num')
  head.appendChild(levelLabel)
  content.appendChild(head)

  // XP progress: a textual „XP: 1234 / 2000" (never colour alone) + a companion bar showing
  // progress toward the NEXT level (the within-level slice of cumulative XP).
  const xpText = h('p', 'building-desc')
  content.appendChild(xpText)
  const xpBar = h('div', 'bar is-good')
  xpBar.setAttribute('role', 'progressbar')
  xpBar.setAttribute('aria-valuemin', '0')
  xpBar.setAttribute('aria-valuemax', '100')
  xpBar.setAttribute('aria-label', 'Postęp do następnego poziomu paladyna')
  const xpFill = h('i')
  xpBar.appendChild(xpFill)
  content.appendChild(xpBar)

  // Aura: the current global attack+defence bonus the paladin radiates (derived from level).
  const auraText = h('p', 'building-desc')
  content.appendChild(auraText)

  // ---- Active ability (the game's first cooldown-gated player buff) --------
  const abTitle = h('h3', 'recruit-subtitle', 'Aktywna zdolność')
  content.appendChild(abTitle)

  const abilityCard = h('section', 'paladin-ability target')
  const abHead = h('div', 'target-head')
  abHead.appendChild(h('span', 'target-name', PALADIN_ABILITY.name))
  abilityCard.appendChild(abHead)
  // Effect description straight from the DATA (content/paladin.PALADIN_ABILITY.desc), so a
  // rebalance of the ability updates this text with no per-string edit here.
  abilityCard.appendChild(h('p', 'target-stats muted', PALADIN_ABILITY.desc))
  // Static duration / cooldown summary (the timings the ability runs / locks for).
  abilityCard.appendChild(
    h(
      'p',
      'horde-line muted',
      'Czas trwania: ' +
        formatTime(PALADIN_ABILITY.durationSecs) +
        ' • Odnowienie: ' +
        formatTime(PALADIN_ABILITY.cooldownSecs),
    ),
  )
  // Live status line: Aktywna (running) / Odnowienie (cooldown) / Gotowa (ready). Rewritten
  // every frame → NO aria-live (a polite region would re-read it every second). Urgency in words.
  const abStatus = h('p', 'horde-line')
  abilityCard.appendChild(abStatus)

  const controls = h('div', 'recruit-controls')
  const button = h('button', 'btn btn-primary', 'Użyj')
  button.type = 'button'
  button.setAttribute('aria-label', 'Użyj zdolności: ' + PALADIN_ABILITY.name)
  controls.appendChild(button)
  abilityCard.appendChild(controls)
  content.appendChild(abilityCard)

  el.appendChild(content)

  // ---- Announcements (activation success / refusal reason) ----------------
  // Separate polite live region — the ONLY aria-live line, fired on REAL events (a click), never
  // on the steady per-frame poke of the persistent lines above.
  const msg = h('p', 'recruit-msg muted')
  msg.setAttribute('role', 'status')
  msg.setAttribute('aria-live', 'polite')
  el.appendChild(msg)

  /**
   * The reason the ability cannot be fired right now (or '' when it can). Mirrors the gate ORDER
   * in systems/paladin.canActivateAbility so the visible cue can never disagree with the button
   * verdict: no Palace → too low level → cooldown → already active. Pure read.
   */
  const activateReason = (gs: GameState): string => {
    if (!paladinUnlocked(gs)) return 'Najpierw zbuduj Pałac paladyna (zakładka Budynki).'
    const p = gs.paladin
    if (p.level < PALADIN_ABILITY.minLevel)
      return 'Wymaga paladyna na poziomie ' + PALADIN_ABILITY.minLevel + '.'
    if (p.cooldownRemaining > 0)
      return 'Zdolność się odnawia (gotowa za ' + formatTime(Math.ceil(p.cooldownRemaining)) + ').'
    if (p.abilityRemaining > 0) return 'Zdolność jest już aktywna.'
    return ''
  }

  // Activation: re-validates through canActivateAbility (the disabled cue uses it too), then
  // commits through the callback (ctx.onActivatePaladin → activateAbility), which no-ops/returns
  // false when it cannot fire. pulseFx + a polite announcement confirm a successful charge.
  button.addEventListener('click', () => {
    const gs = ctx.store.state
    if (canActivateAbility(gs)) {
      const ok = ctx.onActivatePaladin()
      if (ok) {
        pulseFx(abilityCard)
        msg.textContent = PALADIN_ABILITY.name + ' aktywowana — ' + PALADIN_ABILITY.desc
      } else {
        msg.textContent = 'Nie udało się aktywować zdolności.'
      }
    } else {
      msg.textContent = activateReason(gs) || 'Nie można aktywować zdolności.'
    }
    update()
  })

  // ---- Reactivity ---------------------------------------------------------
  const update = (): void => {
    const gs = ctx.store.state
    const unlocked = paladinUnlocked(gs)
    gateBox.hidden = unlocked
    content.hidden = !unlocked
    if (!unlocked) return

    const p = gs.paladin
    const level = p.level
    levelLabel.textContent = 'poziom ' + level + '/' + MAX_PALADIN_LEVEL

    // XP toward the next level — the within-level slice of the cumulative XP curve. At the
    // finite ceiling there is no next threshold, so the bar reads full and the text says so.
    if (level >= MAX_PALADIN_LEVEL) {
      xpText.textContent = 'XP: maksymalny poziom osiągnięty'
      setBar(xpFill, xpBar, 100)
    } else {
      const prev = xpForLevel(level)
      const next = xpForLevel(level + 1)
      const span = Math.max(1, next - prev)
      const inLevel = Math.max(0, Math.min(span, p.xp - prev))
      xpText.textContent = 'XP: ' + formatInt(inLevel) + ' / ' + formatInt(span)
      setBar(xpFill, xpBar, (inLevel / span) * 100)
    }

    // Aura: the whole-percent global attack+defence bonus, derived from the CANONICAL aura
    // multiplier (paladinAuraMult) so the shown „+N%" can never drift from what combat applies.
    const auraPct = Math.round((paladinAuraMult(level) - 1) * 100)
    auraText.textContent = 'Aura: +' + auraPct + '% atak i obrona'

    // Ability status (words, not colour alone). text-good only while actively running. When the
    // ability is neither running nor on cooldown but STILL cannot fire (the common early-game case:
    // a freshly built Palace makes paladinUnlocked true and shows this card, yet level is 0 < the
    // ability's minLevel until the first won battle), show the STRUCTURAL reason as a persistent
    // line instead of the misleading „Gotowa do użycia." — otherwise the visible status would claim
    // the ability is ready while the button reads aria-disabled, a contradiction whose real reason
    // would only live in the hover-only title / the post-click msg. Mirrors forge.ts's role=note
    // discipline (non-affordability blocks are visible text). This stays a PERSISTENT line — no
    // aria-live — since canActivateAbility flips only on real level/cooldown changes, not per frame.
    if (p.abilityRemaining > 0) {
      abStatus.textContent = 'Aktywna: pozostało ' + formatTime(Math.ceil(p.abilityRemaining))
      abStatus.classList.add('text-good')
    } else {
      abStatus.classList.remove('text-good')
      if (p.cooldownRemaining > 0) {
        abStatus.textContent = 'Odnowienie za ' + formatTime(Math.ceil(p.cooldownRemaining))
      } else if (!canActivateAbility(gs)) {
        // Only structural (non-cooldown, non-active) reasons reach here — chiefly „za niski poziom".
        abStatus.textContent = activateReason(gs) || 'Nie można aktywować zdolności.'
      } else {
        abStatus.textContent = 'Gotowa do użycia.'
      }
    }

    // Button reflects the engine's canActivateAbility; the reason becomes the tooltip + aria cue.
    const ok = canActivateAbility(gs)
    button.setAttribute('aria-disabled', ok ? 'false' : 'true')
    button.title = ok ? '' : activateReason(gs)
  }

  return { el, update }
}
