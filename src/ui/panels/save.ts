import type { UiCtx, Panel } from '../types'
import { h } from '../dom'

/**
 * Save panel — export / import / reset, laid out as a RESPONSIVE GRID of cards
 * (replaces the old single vertical column of stacked rows). Built once with
 * createElement / textContent (never innerHTML with data); there is no per-frame
 * reactive state here, so {@link update} is a deliberate no-op (the shell still
 * calls it harmlessly on every revision while the tab is active).
 *
 * The card chrome + grid come from the SHARED design-system classes (.save-grid /
 * .save-card in layout.css) — the single source of truth for every tab's grid
 * template and card surface — so framing never diverges between tabs; no inline
 * layout styles. The controls themselves reuse the existing styled classes
 * (.save-area / .save-actions / .save-msg / .btn / .btn-danger / .visually-hidden)
 * so the save UX matches the rest of the app byte-for-byte.
 *
 * Accessibility (preserved + extended from the previous implementation):
 * - each card is a labelled region (section[aria-labelledby] → its own heading);
 * - export & import each own a polite live region (role=status, aria-live=polite)
 *   so the outcome of an action is announced — never signalled by colour alone;
 * - the reset action is gated behind a Polish window.confirm and visually marked
 *   as destructive with a ⚠ glyph + "Strefa zagrożenia" wording (not colour only);
 * - every textarea / button carries an explicit aria-label; touch targets and
 *   :focus-visible come from the shared .btn / .save-area styling.
 */

/** Build one labelled card (heading + body) wired into the responsive grid. */
function card(headingId: string, title: string): { section: HTMLElement; body: HTMLElement } {
  // Card chrome (flex column / padding / --panel-2 surface / border / radius)
  // comes from the shared .save-card class (layout.css) — no inline styles, so
  // the surface matches every other tab's cards.
  const section = h('section', 'save-card')
  section.setAttribute('aria-labelledby', headingId)

  // h3 under the panel's section h2 (h1 > h2 > h3 chain). Size comes from the
  // base h3 rule — no inline font-size (the old var(--text-md) token never existed).
  const heading = h('h3', 'save-card-title', title)
  heading.id = headingId
  section.appendChild(heading)

  const body = h('div', 'save-card-body')
  body.style.display = 'flex'
  body.style.flexDirection = 'column'
  body.style.gap = 'var(--space-2)'
  section.appendChild(body)

  return { section, body }
}

/**
 * Build the save panel. Returns a {@link Panel}: `el` is the root the shell drops
 * into the active tabpanel; `update()` is a no-op (no live, store-driven state).
 */
export function createSavePanel(ctx: UiCtx): Panel {
  const el = h('div', 'save-panel')

  const intro = h(
    'p',
    'muted',
    'Twój postęp zapisuje się automatycznie w tej przeglądarce. ' +
      'Aby przenieść grę na inne urządzenie, wyeksportuj kod i wczytaj go gdzie indziej.',
  )
  intro.style.fontSize = 'var(--text-sm)'
  intro.style.marginBottom = 'var(--space-3)'
  el.appendChild(intro)

  // Responsive grid: cards tile side by side where width allows, stack on phones.
  // The .save-grid class (layout.css) carries the shared grid template — the
  // single source of truth across tabs — so no inline layout styles.
  const grid = h('div', 'save-grid')
  el.appendChild(grid)

  // ---- a) Export card -------------------------------------------------------
  const exportCard = card('save-export-h', 'Eksport')
  grid.appendChild(exportCard.section)

  const exportDesc = h(
    'p',
    'muted',
    'Wygeneruj kod zapisu i skopiuj go w bezpieczne miejsce.',
  )
  exportDesc.style.fontSize = 'var(--text-sm)'
  exportDesc.style.margin = '0'
  exportCard.body.appendChild(exportDesc)

  const exportArea = h('textarea', 'save-area')
  exportArea.readOnly = true
  exportArea.rows = 4
  exportArea.setAttribute('aria-label', 'Wyeksportowany kod zapisu')
  exportArea.placeholder = 'Tu pojawi się wyeksportowany kod…'

  const exportMsg = h('p', 'save-msg muted')
  exportMsg.setAttribute('role', 'status')
  exportMsg.setAttribute('aria-live', 'polite')

  /** Fallback when the async Clipboard API is unavailable / denied. */
  const selectForManualCopy = (): void => {
    exportArea.focus()
    exportArea.select()
    exportMsg.textContent = 'Zaznaczono kod — skopiuj go ręcznie (Ctrl+C / Cmd+C).'
  }

  const exportBtn = h('button', 'btn', 'Eksportuj')
  exportBtn.type = 'button'
  exportBtn.setAttribute('aria-label', 'Wygeneruj kod zapisu')
  exportBtn.addEventListener('click', () => {
    exportArea.value = ctx.onExport()
    exportArea.focus()
    exportArea.select()
    exportMsg.textContent = 'Kod gotowy — zaznaczony do skopiowania.'
  })

  // Improvement over the old "select only": copy straight to the clipboard when
  // the browser allows it, with a graceful select-fallback otherwise.
  const copyBtn = h('button', 'btn', 'Kopiuj')
  copyBtn.type = 'button'
  copyBtn.setAttribute('aria-label', 'Skopiuj kod zapisu do schowka')
  copyBtn.addEventListener('click', () => {
    const code = exportArea.value || ctx.onExport()
    exportArea.value = code
    const clip = navigator.clipboard as Clipboard | undefined
    if (clip && typeof clip.writeText === 'function') {
      clip.writeText(code).then(
        () => {
          exportMsg.textContent = 'Skopiowano kod do schowka.'
        },
        () => selectForManualCopy(),
      )
    } else {
      selectForManualCopy()
    }
  })

  const exportActions = h('div', 'save-actions')
  exportActions.appendChild(exportBtn)
  exportActions.appendChild(copyBtn)

  exportCard.body.appendChild(exportActions)
  exportCard.body.appendChild(exportArea)
  exportCard.body.appendChild(exportMsg)

  // ---- b) Import card -------------------------------------------------------
  const importCard = card('save-import-h', 'Import')
  grid.appendChild(importCard.section)

  const importDesc = h(
    'p',
    'muted',
    'Wklej kod zapisu, aby wczytać postęp. Zastąpi on bieżącą grę.',
  )
  importDesc.style.fontSize = 'var(--text-sm)'
  importDesc.style.margin = '0'
  importCard.body.appendChild(importDesc)

  const importArea = h('textarea', 'save-area')
  importArea.rows = 4
  importArea.setAttribute('aria-label', 'Kod zapisu do wczytania')
  importArea.placeholder = 'Wklej kod zapisu, aby go wczytać…'

  const importMsg = h('p', 'save-msg muted')
  importMsg.setAttribute('role', 'status')
  importMsg.setAttribute('aria-live', 'polite')

  const importBtn = h('button', 'btn', 'Importuj')
  importBtn.type = 'button'
  importBtn.setAttribute('aria-label', 'Wczytaj kod zapisu')
  importBtn.addEventListener('click', () => {
    const ok = ctx.onImport(importArea.value)
    importMsg.textContent = ok ? 'Wczytano zapis.' : 'Niepoprawny kod zapisu.'
    if (ok) importArea.value = ''
  })

  const importActions = h('div', 'save-actions')
  importActions.appendChild(importBtn)

  importCard.body.appendChild(importArea)
  importCard.body.appendChild(importActions)
  importCard.body.appendChild(importMsg)

  // ---- c) Danger zone: reset ------------------------------------------------
  const resetCard = card('save-reset-h', '⚠ Strefa zagrożenia')
  resetCard.section.style.borderColor = 'var(--bad, var(--border))'
  grid.appendChild(resetCard.section)

  const resetDesc = h(
    'p',
    'muted',
    'Reset usuwa cały postęp bezpowrotnie i rozpoczyna grę od nowa. ' +
      'Przed resetem warto wyeksportować kod zapisu.',
  )
  resetDesc.style.fontSize = 'var(--text-sm)'
  resetDesc.style.margin = '0'
  resetCard.body.appendChild(resetDesc)

  const resetBtn = h('button', 'btn btn-danger', 'Resetuj grę')
  resetBtn.type = 'button'
  resetBtn.setAttribute('aria-label', 'Zresetuj grę i usuń cały postęp')
  resetBtn.addEventListener('click', () => {
    if (
      window.confirm('Na pewno zresetować grę? Cały postęp zostanie bezpowrotnie utracony.')
    ) {
      ctx.onReset()
    }
  })

  const resetActions = h('div', 'save-actions')
  resetActions.appendChild(resetBtn)
  resetCard.body.appendChild(resetActions)

  // No store-driven live values in this panel — the export/import outcomes are
  // pushed straight into their live regions by the click handlers above.
  const update = (): void => {}

  return { el, update }
}
