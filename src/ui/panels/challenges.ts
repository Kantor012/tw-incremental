import type { UiCtx, Panel } from '../types'
import { h } from '../dom'
import { formatNumber, formatRate } from '../../engine/format'
import {
  CHALLENGES,
  CHALLENGE_IDS,
  type ChallengeDef,
  type ChallengeMods,
  type ChallengeGoal,
} from '../../content/challenges'
import {
  challengeById,
  challengeGoalValue,
  challengeGoalProgress,
  canStartChallenge,
} from '../../systems/challenges'

/**
 * "Wyzwania" panel (M8) — the CONSTRAINED-RUN layer that plugs into the SAME
 * `combine` fold as the three meta-trees.
 *
 * A single stacked region: an intro note, a polite status live region and a card
 * LIST (one card per {@link CHALLENGES} entry). Each card spells out the challenge's
 * name, description, its active CONSTRAINT (the penalty multipliers), the current-run
 * GOAL, the permanent REWARD ({@link ChallengeDef.rewardText}) and a textual state
 * badge (▶ w trakcie / ✓ ukończone ×N / nieukończone). The ACTIVE challenge also shows
 * a goal PROGRESS bar ({@link challengeGoalProgress}) and a "Porzuć wyzwanie" button; an
 * inactive challenge shows a "Rozpocznij" button gated behind a Polish `window.confirm`
 * that SPELLS OUT the destructive reset (a fresh capital + world, tech/log cleared, the
 * horde re-armed) AND what SURVIVES (the prestige/era/dynasty accounts and the lifetime
 * stats/achievements — a challenge does NOT bank or wipe them).
 *
 * Data-driven & passive: this module owns NO economy logic, NO constraint/reward maths
 * and NO clock/RNG. The catalogue (content/challenges.ts) supplies every name/penalty/
 * goal/reward, and the engine (systems/challenges.ts) decides startability, goal progress
 * and completion on the deterministic tick path; the panel only READS state and routes
 * the two intent callbacks ({@link UiCtx.onStartChallenge} / {@link UiCtx.onAbandonChallenge}).
 * Adding or rebalancing a challenge — even adding a whole new one — is a pure data edit; a
 * new entry appears here automatically with no change to this file.
 *
 * Reactivity (panel contract): the DOM is built ONCE. {@link Panel.update} pokes each
 * card's state badge / accent class, the active card's progress bar + readout, and each
 * button's visibility/disabled cue — it never rebuilds the roster. State is carried by
 * TEXT (the badge wording, the button labels) and per-card aria-labels, never by colour
 * alone (WCAG 1.4.1); the coloured left accent and badge hue are a SECONDARY cue. The
 * panel writes ZERO inline styles — every appearance lives in the layout.css "Wyzwania"
 * section (the goal bar is a native `<progress>` driven through its value/max properties,
 * never a style.width), mirroring the fully-declarative Kodeks panel.
 */

/** One multiplier axis of a {@link ChallengeMods} bag + its PL label, in display order. */
const MOD_LABELS: { key: keyof ChallengeMods; label: string }[] = [
  { key: 'productionMult', label: 'Produkcja' },
  { key: 'storageMult', label: 'Magazyn' },
  { key: 'popMult', label: 'Populacja' },
  { key: 'attackMult', label: 'Atak' },
  { key: 'defenseMult', label: 'Obrona' },
  { key: 'lootMult', label: 'Łup' },
]

/**
 * Summarise a {@link ChallengeMods} bag as "Etykieta ×factor" pairs (e.g. "Produkcja
 * ×0.4"), in the fixed {@link MOD_LABELS} order — used for both the constraint penalty
 * and (where needed) a reward. Absent / non-finite axes are skipped; an empty bag reads
 * "—" (defensive — catalogue constraints/rewards always carry at least one axis).
 */
function modsText(m: ChallengeMods): string {
  const parts: string[] = []
  for (const { key, label } of MOD_LABELS) {
    const v = m[key]
    if (typeof v === 'number' && Number.isFinite(v)) {
      parts.push(label + ' ×' + formatNumber(v, 2))
    }
  }
  return parts.length > 0 ? parts.join(', ') : '—'
}

/** PL line for the current-run win condition. Exhaustive over the {@link ChallengeGoal} union. */
function goalText(goal: ChallengeGoal): string {
  switch (goal.kind) {
    case 'prestige_score':
      return 'Wynik prestiżu ≥ ' + formatNumber(goal.target, 0)
    case 'production':
      return 'Łączna produkcja ≥ ' + formatRate(goal.target, 0)
  }
}

/** Cached, per-challenge handles poked by update(). */
interface ChallengeRef {
  id: string
  name: string
  def: ChallengeDef
  card: HTMLElement
  badge: HTMLElement
  progressWrap: HTMLElement
  progressBar: HTMLProgressElement
  progressVal: HTMLElement
  startBtn: HTMLButtonElement
  abandonBtn: HTMLButtonElement
  /** Last rendered badge text; `null` = never rendered (forces first paint). */
  lastBadge: string | null
}

/**
 * Build the "Wyzwania" panel. Reads {@link UiCtx} for the live store and the two intent
 * callbacks; every startability cue comes straight from {@link canStartChallenge} so a
 * card can never disagree with what an action actually does.
 */
export function createChallengesPanel(ctx: UiCtx): Panel {
  const el = h('div', 'challenges-panel')

  // ---- Intro note ----------------------------------------------------------
  const note = h(
    'p',
    'tech-note muted',
    'Wyzwania to jednorazowe biegi z ograniczeniem (karą) w zamian za TRWAŁĄ nagrodę. ' +
      'Rozpoczęcie wyzwania RESETUJE bieżący bieg (jak ascensja: świeża stolica, świat od ' +
      'nowa, wyczyszczone drzewo rozwoju), ale konta prestiżu, ery i dynastii oraz dorobek ' +
      'życiowy (statystyki i osiągnięcia) pozostają nietknięte. Po osiągnięciu celu pod ' +
      'ograniczeniem zdobywasz nagrodę na stałe — nagrody z różnych wyzwań sumują się.',
  )
  note.setAttribute('role', 'note')
  el.appendChild(note)

  // ---- Status live region --------------------------------------------------
  // One polite live region for action outcomes (start / abandon / completion). Mirrors
  // the prestige/era summary `msg`; for a list a single shared status reads cleanest.
  const msg = h('p', 'save-msg muted')
  msg.setAttribute('role', 'status')
  msg.setAttribute('aria-live', 'polite')
  el.appendChild(msg)

  // ---- Challenge roster ----------------------------------------------------
  const list = h('ul', 'card-grid challenges-list')
  list.setAttribute('role', 'list')

  const refs: ChallengeRef[] = []
  for (const def of CHALLENGES) {
    const card = h('li', 'card challenge-card')

    // Head: name (grows) + textual state badge.
    const head = h('div', 'challenge-head')
    head.appendChild(h('h4', 'challenge-name', def.name))
    const badge = h('span', 'challenge-status-badge', '')
    head.appendChild(badge)
    card.appendChild(head)

    card.appendChild(h('p', 'challenge-desc muted', def.desc))

    // Spec list: constraint (penalty) / goal / reward as label–value pairs.
    const specs = h('dl', 'challenge-specs')
    const addSpec = (label: string, value: string, valueClass?: string): void => {
      specs.appendChild(h('dt', undefined, label))
      specs.appendChild(h('dd', valueClass, value))
    }
    addSpec('Ograniczenie', modsText(def.constraint), 'challenge-spec-constraint')
    addSpec('Cel', goalText(def.goal))
    addSpec('Nagroda', def.rewardText, 'challenge-spec-reward')
    card.appendChild(specs)

    // Goal progress (active challenge only; hidden otherwise). The bar is a native
    // <progress> styled to match the shared .bar — driven via value/max, never style.
    const progressWrap = h('div', 'challenge-progress')
    const progressHead = h('div', 'challenge-progress-head')
    progressHead.appendChild(h('span', 'muted', 'Postęp celu'))
    const progressVal = h('span', 'num', '—')
    progressHead.appendChild(progressVal)
    progressWrap.appendChild(progressHead)
    const progressBar = h('progress', 'challenge-progress-bar')
    progressBar.max = 1
    progressBar.value = 0
    progressBar.setAttribute('aria-label', 'Postęp celu wyzwania ' + def.name)
    progressWrap.appendChild(progressBar)
    card.appendChild(progressWrap)

    // Actions: exactly one is visible at a time (start when inactive, abandon when active).
    const actions = h('div', 'challenge-actions')
    const startBtn = h('button', 'btn btn-primary', 'Rozpocznij')
    startBtn.type = 'button'
    const abandonBtn = h('button', 'btn btn-danger', 'Porzuć wyzwanie')
    abandonBtn.type = 'button'
    actions.appendChild(startBtn)
    actions.appendChild(abandonBtn)
    card.appendChild(actions)

    list.appendChild(card)

    const ref: ChallengeRef = {
      id: def.id,
      name: def.name,
      def,
      card,
      badge,
      progressWrap,
      progressBar,
      progressVal,
      startBtn,
      abandonBtn,
      lastBadge: null,
    }
    refs.push(ref)

    // ---- Start: confirm spells out the run RESET (meta + stats survive) ----
    startBtn.addEventListener('click', () => {
      const verdict = canStartChallenge(ctx.store.state, def.id)
      // Guarded no-op (button stays focusable via aria-disabled so its reason is read).
      if (!verdict.ok) {
        msg.textContent = verdict.reason ?? 'Nie można teraz rozpocząć tego wyzwania.'
        return
      }
      const alreadyDone = (ctx.store.state.challenge?.completed[def.id] ?? 0) > 0
      const confirmed = window.confirm(
        'ROZPOCZĘCIE WYZWANIA ZRESETUJE BIEŻĄCY BIEG.\n\n' +
          'Stracisz: wszystkie wioski (zostanie jedna nowa stolica), całe drzewo rozwoju ' +
          'oraz bieżące surowce; świat zostanie wygenerowany od nowa, a horda uzbrojona od ' +
          'początku.\n\n' +
          'Zachowasz: konta prestiżu, ery i dynastii oraz cały dorobek życiowy (statystyki ' +
          'i osiągnięcia) — wyzwanie ich NIE kasuje.\n\n' +
          'Wyzwanie „' +
          def.name +
          '": przez cały bieg obowiązuje ograniczenie ' +
          modsText(def.constraint) +
          '. Po osiągnięciu celu (' +
          goalText(def.goal) +
          ') zdobędziesz trwałą nagrodę: ' +
          def.rewardText +
          (alreadyDone
            ? '\n\nTo wyzwanie masz już ukończone — jego nagroda jest zdobyta na stałe i ' +
              'ponowne ukończenie jej nie zwiększa.'
            : '') +
          '\n\nKontynuować?',
      )
      if (!confirmed) {
        msg.textContent = 'Rozpoczęcie wyzwania anulowane.'
        return
      }
      const ok = ctx.onStartChallenge(def.id)
      msg.textContent = ok
        ? 'Wyzwanie „' + def.name + '" rozpoczęte — bieg zresetowany, ograniczenie aktywne.'
        : 'Nie udało się rozpocząć wyzwania.'
      update()
    })

    // ---- Abandon: ends the active challenge with NO reward (run continues) --
    abandonBtn.addEventListener('click', () => {
      const confirmed = window.confirm(
        'Porzucić wyzwanie „' +
          def.name +
          '"?\n\n' +
          'Ograniczenie zostanie zdjęte i bieg będzie kontynuowany normalnie, ale NIE ' +
          'otrzymasz nagrody, a dotychczasowy postęp wyzwania przepadnie.\n\nKontynuować?',
      )
      if (!confirmed) {
        msg.textContent = 'Porzucenie wyzwania anulowane.'
        return
      }
      ctx.onAbandonChallenge()
      msg.textContent =
        'Wyzwanie „' + def.name + '" porzucone. Bieg kontynuowany bez ograniczenia.'
      update()
    })
  }

  el.appendChild(list)

  // ---- Reactivity ----------------------------------------------------------
  // update() fires on EVERY store.rev bump (~60×/s while this tab is open), so each
  // reactive write is guarded against its cached last value — this also keeps the polite
  // `msg` live region from re-announcing on every frame. Completion is tick-driven: we
  // detect the active challenge clearing WITH its completed count going up (vs an abandon,
  // which clears it without an increment) and announce it once, on the transition.
  let lastActiveId: string | null = null
  const lastCount: Record<string, number> = {}
  let primed = false

  const update = (): void => {
    const state = ctx.store.state
    const ch = state.challenge
    const activeId = ch ? ch.activeId : null
    const completed = ch && ch.completed ? ch.completed : {}
    const anyActive = activeId !== null

    for (const ref of refs) {
      const isActive = activeId === ref.id
      const count = completed[ref.id] || 0
      const isCompleted = count > 0

      // Accent stripe (a SECONDARY cue — the badge text carries the state on its own).
      ref.card.classList.toggle('is-active', isActive)
      ref.card.classList.toggle('is-completed', !isActive && isCompleted)

      // State badge — wording carries the state without relying on colour (WCAG 1.4.1).
      const badgeText = isActive
        ? '▶ W trakcie'
        : isCompleted
          ? count > 1
            ? '✓ Ukończone ×' + count
            : '✓ Ukończone'
          : 'Nieukończone'
      if (badgeText !== ref.lastBadge) {
        ref.lastBadge = badgeText
        ref.badge.textContent = badgeText
      }

      // Goal progress — only meaningful for the active challenge.
      ref.progressWrap.hidden = !isActive
      if (isActive) {
        const frac = challengeGoalProgress(state)
        const value = challengeGoalValue(state)
        const target = ref.def.goal.target
        ref.progressBar.value = frac
        const pctText = formatNumber(frac * 100, 0) + '%'
        ref.progressBar.setAttribute('aria-valuetext', pctText)
        // Format the value/target per goal kind, mirroring goalText(): a 'production' goal is a
        // per-second rate, so show the /s unit (formatRate) and keep 1 decimal on the current
        // value so a sub-target figure (e.g. 29.7) never 0-decimal-rounds up to look complete
        // while the bar/percent still read < 100%. 'prestige_score' stays a 0-decimal count.
        const isProd = ref.def.goal.kind === 'production'
        const valText = isProd ? formatRate(value, 1) : formatNumber(value, 0)
        const tgtText = isProd ? formatRate(target, 0) : formatNumber(target, 0)
        ref.progressVal.textContent = pctText + ' (' + valText + ' / ' + tgtText + ')'
      }

      // Buttons — exactly one visible; the start button is disabled (not removed) while
      // ANOTHER challenge is running, so its reason stays readable (mirrors onAscend).
      ref.startBtn.hidden = isActive
      ref.abandonBtn.hidden = !isActive
      if (!isActive) {
        const blocked = anyActive
        const label = isCompleted ? 'Rozpocznij ponownie' : 'Rozpocznij'
        ref.startBtn.textContent = label
        ref.startBtn.setAttribute('aria-disabled', blocked ? 'true' : 'false')
        ref.startBtn.title = blocked
          ? 'Najpierw zakończ lub porzuć trwające wyzwanie.'
          : ''
        ref.startBtn.setAttribute(
          'aria-label',
          label + ' wyzwanie ' + ref.name + ' (resetuje bieżący bieg)',
        )
      }
    }

    // Tick-driven completion announcement (once, on the transition).
    if (primed && lastActiveId !== null && activeId !== lastActiveId) {
      const prev = lastCount[lastActiveId] || 0
      const now = completed[lastActiveId] || 0
      if (now > prev) {
        const def = challengeById(lastActiveId)
        msg.textContent =
          'Wyzwanie „' +
          (def ? def.name : lastActiveId) +
          '" ukończone! Zdobyto trwałą nagrodę: ' +
          (def ? def.rewardText : '')
      }
    }
    lastActiveId = activeId
    for (const id of CHALLENGE_IDS) lastCount[id] = completed[id] || 0
    primed = true
  }

  update()

  return { el, update }
}
