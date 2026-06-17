import type { UiCtx, Panel } from '../types'
import { h, automationIcon, lockIcon } from '../dom'
import { effectiveMods } from '../../systems/prestige'
import { UNIT_IDS, UNITS, type UnitId } from '../../content/units'
import type { AutomationKind, AutomationSettings } from '../../engine/state'

/**
 * "Automatyzacja" panel (M5.1) — the idle layer's control surface.
 *
 * Three routines, each its own card in the shared responsive grid:
 *  - AUTO-BUDOWA  (build):   builds the cheapest affordable building in every village.
 *  - AUTO-REKRUTACJA (recruit): keeps a chosen unit topped up to a target headcount.
 *  - AUTO-ATAK   (attack):   sends the idle army at the nearest beatable barbarian
 *                            (never nobles — conquest stays a manual decision).
 *
 * Each routine has TWO gates, mirroring the engine (systems/automation.ts +
 * runAutomation in the tick): it must be UNLOCKED in the tech tree
 * (`effectiveMods(state).automations[kind]`) AND switched ON by the player
 * (`state.automation[kind]`). This panel reads the unlock flag straight from the
 * shared engine so the locked/disabled cue can never disagree with what the tick
 * actually does. Until a routine is unlocked its toggle is DISABLED and a visible
 * note (proceduralna ikona kłódki + tekst "Odblokuj w drzewie rozwoju" — znaczenie
 * niesie TEKST, nie sam kolor/obrazek — WCAG 1.4.1) points the player at the "Rozwój" tree.
 *
 * Mutations go through {@link UiCtx.onSetAutomation} (a partial patch merged into
 * `state.automation`, then committed + persisted by main.ts). Settings are GLOBAL
 * (not per-village): the tick applies the same policy to every village in order.
 *
 * Panel contract: the DOM is built ONCE; {@link Panel.update} only pokes the cached
 * toggles / lock notes / config controls from the current store — it never rebuilds
 * the tree. Data-driven: the routine roster + the unit options come from data
 * ({@link AutomationKind}, {@link UNIT_IDS}); adding a unit needs no edit here.
 */

/** One automation routine's card metadata (display only — behaviour lives in the engine). */
interface AutoSpec {
  kind: AutomationKind
  title: string
  /** Plain-language description of the FIXED policy the tick runs. */
  desc: string
}

/** The three routines, in the stable order the tick runs them (build → recruit → attack). */
const SPECS: readonly AutoSpec[] = [
  {
    kind: 'build',
    title: 'Auto-budowa',
    desc:
      'Buduje najtańszy budynek, na który stać wioskę (z jej lokalnych surowców). ' +
      'Pomija budynki na maksymalnym poziomie. Działa w każdej wiosce.',
  },
  {
    kind: 'recruit',
    title: 'Auto-rekrutacja',
    desc:
      'Utrzymuje wybraną jednostkę na zadanym poziomie liczebności — dokolejkowuje ' +
      'brakujące sztuki, gdy starcza surowców i populacji.',
  },
  {
    kind: 'attack',
    title: 'Auto-atak',
    desc:
      'Wysyła bezczynną armię bojową na najbliższego pokonywalnego barbarzyńcę ' +
      '(z bezpiecznym zapasem siły). Nigdy nie wysyła szlachciców — przejmowanie ' +
      'wiosek pozostaje ręczne.',
  },
]

/** Cached, per-card handles poked by update(). */
interface CardRefs {
  toggle: HTMLButtonElement
  lock: HTMLElement
}

/**
 * Build the "Automatyzacja" panel. Reads {@link UiCtx} for the live store and the
 * `onSetAutomation` commit; the unlock state comes straight from `effectiveMods`
 * so the disabled/locked cue mirrors the tick's own gate.
 */
export function createAutomationPanel(ctx: UiCtx): Panel {
  const el = h('div', 'automation-panel')

  // ---- Intro note ----------------------------------------------------------
  const note = h(
    'p',
    'tech-note muted',
    'Automatyzacje wyręczają Cię w rutynie. Najpierw ODBLOKUJ je w drzewie ' +
      '„Rozwój", potem WŁĄCZ przełącznikiem poniżej. Domyślnie wyłączone — bez nich ' +
      'gra przebiega dokładnie tak jak dotąd.',
  )
  note.setAttribute('role', 'note')
  el.appendChild(note)

  // ---- Routine cards (shared responsive grid) ------------------------------
  const grid = h('div', 'save-grid')
  el.appendChild(grid)

  const refs = {} as Record<AutomationKind, CardRefs>

  // Auto-recruit's extra policy controls (built once, wired below).
  let unitSelect!: HTMLSelectElement
  let targetInput!: HTMLInputElement
  // Live note shown when auto-recruit is ON but its policy is incomplete (no unit /
  // target 0), where autoRecruitOnce is a silent no-op — closes the "enabled but inert"
  // gap. Poked by update(); declared here so it's reachable from there.
  let recruitHint!: HTMLElement

  for (const spec of SPECS) {
    const section = h('section', 'save-card')
    const headingId = 'auto-' + spec.kind + '-h'
    section.setAttribute('aria-labelledby', headingId)

    const heading = h('h3', 'save-card-title')
    heading.id = headingId
    const headIcon = automationIcon(spec.kind)
    // Pure decoration: the <h3> text node (spec.title) carries the meaning, so drop
    // the svgIcon's role=img/aria-label from the a11y tree (mirrors lockGlyph below) —
    // otherwise the title is announced twice ('Auto-budowa Auto-budowa').
    headIcon.setAttribute('aria-hidden', 'true')
    headIcon.style.width = '1.15em'
    headIcon.style.height = '1.15em'
    headIcon.style.verticalAlign = '-0.18em'
    headIcon.style.marginRight = 'var(--space-1)'
    headIcon.style.color = 'var(--accent)'
    heading.appendChild(headIcon)
    heading.appendChild(document.createTextNode(spec.title))
    section.appendChild(heading)

    const body = h('div', 'save-card-body')
    body.style.display = 'flex'
    body.style.flexDirection = 'column'
    body.style.gap = 'var(--space-2)'
    section.appendChild(body)

    const desc = h('p', 'muted', spec.desc)
    desc.style.fontSize = 'var(--text-sm)'
    desc.style.margin = '0'
    body.appendChild(desc)

    // Auto-recruit: a unit picker + a target headcount. These configure the policy
    // and stay editable regardless of the unlock state (so it can be pre-set); only
    // the toggle is gated by the lock.
    if (spec.kind === 'recruit') {
      const cfg = h('div', 'recruit-controls')

      const unitField = h('label')
      unitField.style.display = 'inline-flex'
      unitField.style.flexDirection = 'column'
      unitField.style.gap = 'var(--space-1)'
      unitField.appendChild(h('span', 'muted', 'Jednostka'))
      unitSelect = h('select', 'num')
      unitSelect.style.minHeight = '44px'
      unitSelect.style.padding = 'var(--space-2)'
      unitSelect.style.backgroundColor = 'var(--bg-2)'
      unitSelect.style.color = 'var(--text)'
      unitSelect.style.border = '1px solid var(--border)'
      unitSelect.style.borderRadius = 'var(--radius-md)'
      unitSelect.setAttribute('aria-label', 'Jednostka utrzymywana przez auto-rekrutację')
      const ph = h('option', undefined, '— wybierz jednostkę —')
      ph.value = ''
      unitSelect.appendChild(ph)
      for (const uid of UNIT_IDS) {
        const opt = h('option', undefined, UNITS[uid].name)
        opt.value = uid
        unitSelect.appendChild(opt)
      }
      unitSelect.addEventListener('change', () => {
        const v = unitSelect.value
        ctx.onSetAutomation({ recruitUnit: v === '' ? null : (v as UnitId) })
        update()
      })
      unitField.appendChild(unitSelect)

      const targetField = h('label')
      targetField.style.display = 'inline-flex'
      targetField.style.flexDirection = 'column'
      targetField.style.gap = 'var(--space-1)'
      targetField.appendChild(h('span', 'muted', 'Docelowa liczba'))
      targetInput = h('input', 'recruit-count num')
      targetInput.type = 'number'
      targetInput.min = '0'
      targetInput.step = '1'
      targetInput.inputMode = 'numeric'
      targetInput.setAttribute('aria-label', 'Docelowa liczba jednostek auto-rekrutacji')
      // 'change' (not 'input') so the value commits on blur/Enter — update() then
      // mirrors the canonical stored value back, but never while the field is focused.
      targetInput.addEventListener('change', () => {
        const parsed = Math.floor(Number(targetInput.value))
        const n = Number.isFinite(parsed) && parsed > 0 ? parsed : 0
        ctx.onSetAutomation({ recruitTarget: n })
        update()
      })
      targetField.appendChild(targetInput)

      cfg.appendChild(unitField)
      cfg.appendChild(targetField)
      body.appendChild(cfg)

      // "Enabled but inert" guard: autoRecruitOnce no-ops when no unit is chosen or the
      // target is 0, so the toggle can read "Włączona" while nothing is trained. This
      // status note (text, role=status — never colour alone) explains the gap; update()
      // shows it only while the routine is active AND its policy is still incomplete.
      recruitHint = h(
        'p',
        'muted',
        'Wybierz jednostkę i ustaw docelową liczbę (>0), aby auto-rekrutacja ' +
          'faktycznie działała.',
      )
      recruitHint.setAttribute('role', 'status')
      recruitHint.hidden = true
      body.appendChild(recruitHint)
    }

    const actions = h('div', 'save-actions')
    // A toggle BUTTON (not a checkbox) so it reuses the shared .btn 44px touch target
    // and :focus-visible. State rides on aria-pressed AND the label text ("Włączona"/
    // "Wyłączona") + the .btn-primary fill — never colour alone (WCAG 1.4.1).
    const toggle = h('button', 'btn', 'Wyłączona')
    toggle.type = 'button'
    toggle.setAttribute('aria-pressed', 'false')
    toggle.addEventListener('click', () => {
      if (toggle.disabled) return
      const cur = ctx.store.state.automation[spec.kind]
      ctx.onSetAutomation({ [spec.kind]: !cur } as Partial<AutomationSettings>)
      update()
    })
    actions.appendChild(toggle)
    body.appendChild(actions)

    // Locked notice: visible text (role=note), shown only while the routine is not yet
    // unlocked in the tree. The toggle is hard-disabled then; this note carries the
    // reason in the DOM so it never depends on a hover title or colour.
    const lock = h('p', 'muted')
    const lockGlyph = lockIcon()
    lockGlyph.setAttribute('aria-hidden', 'true')
    lockGlyph.style.width = '1em'
    lockGlyph.style.height = '1em'
    lockGlyph.style.verticalAlign = '-0.12em'
    lockGlyph.style.marginRight = 'var(--space-1)'
    lock.appendChild(lockGlyph)
    lock.appendChild(document.createTextNode('Odblokuj w drzewie rozwoju'))
    lock.setAttribute('role', 'note')
    lock.hidden = true
    body.appendChild(lock)

    grid.appendChild(section)
    refs[spec.kind] = { toggle, lock }
  }

  // ---- Reactivity ----------------------------------------------------------
  const update = (): void => {
    const state = ctx.store.state
    // Same source of truth as the tick: a routine is live only when UNLOCKED
    // (tech × prestige) AND switched ON by the player.
    const mods = effectiveMods(state)
    for (const spec of SPECS) {
      const r = refs[spec.kind]
      const unlocked = mods.automations[spec.kind]
      const active = unlocked && state.automation[spec.kind]
      r.toggle.disabled = !unlocked
      r.toggle.setAttribute('aria-pressed', active ? 'true' : 'false')
      r.toggle.textContent = active ? 'Włączona' : 'Wyłączona'
      r.toggle.classList.toggle('btn-primary', active)
      r.toggle.setAttribute(
        'aria-label',
        spec.title + ': ' + (active ? 'włączona' : 'wyłączona'),
      )
      r.lock.hidden = unlocked
    }

    // Mirror the stored auto-recruit policy back into the controls, but never clobber
    // a field the player is actively editing.
    if (document.activeElement !== unitSelect) {
      unitSelect.value = state.automation.recruitUnit ?? ''
    }
    if (document.activeElement !== targetInput) {
      targetInput.value = String(state.automation.recruitTarget)
    }

    // Surface the "enabled but inert" hint only when auto-recruit is genuinely live
    // (unlocked × toggled on) yet its policy can't act: no unit picked or target <= 0.
    const recruitActive = mods.automations.recruit && state.automation.recruit
    recruitHint.hidden = !(
      recruitActive &&
      (state.automation.recruitUnit === null || state.automation.recruitTarget <= 0)
    )
  }

  update()

  return { el, update }
}
