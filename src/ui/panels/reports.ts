import { formatInt } from '../../engine/format'
import type { BattleReport } from '../../engine/state'
import { barbarianTarget } from '../../content/barbarians'
import type { UiCtx, Panel } from '../types'
import { h, svg, svgIcon } from '../dom'

/**
 * Reports panel — the rolling battle log (last ~20 events), NEWEST FIRST, laid out
 * as a RESPONSIVE GRID of cards (replaces the old single vertical list). Built with
 * createElement / textContent (never innerHTML with data); the procedural SVG glyphs
 * come from {@link svg}/{@link svgIcon}, so the "zero external assets" rule holds.
 *
 * Reactivity: the battle log is an append-mostly, bounded array, so update() guards
 * a full re-render behind a content SIGNATURE — the grid is rebuilt ONLY when the
 * log actually changes (a new battle, or the rolling window dropping its oldest),
 * never per frame. While the signature is unchanged, update() is a cheap no-op. This
 * matches the no-rebuild-per-frame discipline of the marches/queue lists.
 *
 * Accessibility (WCAG): a win/loss is NEVER signalled by colour alone — every card
 * carries a ✓ / ✗ glyph AND a Polish result word in its title (the coloured left
 * border + badge are an addition, not the sole cue). Each card also gets a labelled
 * SVG icon (crossed swords for an outgoing attack, a shield for a defended raid).
 */

/** Procedural crossed-swords glyph for an outgoing attack (offence). */
function attackIcon(): SVGSVGElement {
  const blade = (d: string): SVGElement =>
    svg('path', { d, stroke: '#c6cdd5', 'stroke-width': '2', 'stroke-linecap': 'round', fill: 'none' })
  const hilt = (d: string): SVGElement =>
    svg('path', { d, stroke: '#8a5a2b', 'stroke-width': '2', 'stroke-linecap': 'round', fill: 'none' })
  return svgIcon('0 0 24 24', 'Atak na obóz', 'report-glyph', [
    blade('M4 4 14 14'),
    blade('M20 4 10 14'),
    hilt('M14 14 18 20'),
    hilt('M10 14 6 20'),
  ])
}

/** Procedural shield glyph for an incoming raid (defence). */
function raidIcon(): SVGSVGElement {
  const face = svg('path', {
    d: 'M12 2 4 5v6c0 5 4 8 8 9 4-1 8-4 8-9V5z',
    fill: '#9aa3ad',
  })
  const shade = svg('path', {
    d: 'M12 2 4 5v6c0 5 4 8 8 9z',
    fill: '#7d858f',
  })
  const boss = svg('path', { d: 'M12 7 16 10 12 13 8 10z', fill: '#3a2a17', 'fill-opacity': '0.4' })
  return svgIcon('0 0 24 24', 'Najazd na osadę', 'report-glyph', [face, shade, boss])
}

/** One labelled value chip (label muted, value as `.num`). Text carries the cue. */
function chip(label: string, value: string): HTMLElement {
  const wrap = h('span', 'report-chip')
  wrap.style.display = 'inline-flex'
  wrap.style.alignItems = 'baseline'
  wrap.style.gap = 'var(--space-1)'
  wrap.style.padding = '2px var(--space-2)'
  wrap.style.borderRadius = 'var(--radius-sm)'
  wrap.style.background = 'var(--panel-2)'
  wrap.style.border = '1px solid var(--border)'
  wrap.appendChild(h('span', 'muted', label))
  wrap.appendChild(h('span', 'num', value))
  return wrap
}

/** Build the single-event card (newest entries are appended first). */
function reportCard(r: BattleReport): HTMLElement {
  const won = r.won
  const li = h('li', 'report-item ' + (won ? 'report-win' : 'report-lose'))

  // -- header: glyph + (result title / context subtitle) ----------------------
  const head = h('div', 'report-head')
  head.style.display = 'flex'
  head.style.alignItems = 'center'
  head.style.gap = 'var(--space-2)'

  const iconWrap = h('span', 'report-icon')
  iconWrap.style.flex = '0 0 auto'
  iconWrap.style.display = 'inline-flex'
  iconWrap.appendChild(r.kind === 'attack' ? attackIcon() : raidIcon())

  const headText = h('div', 'report-headtext')
  headText.style.display = 'flex'
  headText.style.flexDirection = 'column'
  headText.style.minWidth = '0'

  const mark = won ? '✓ ' : '✗ '
  const meta = h('div', 'report-meta')
  meta.style.display = 'flex'
  meta.style.flexWrap = 'wrap'
  meta.style.gap = 'var(--space-1)'
  meta.style.marginTop = 'var(--space-1)'

  if (r.kind === 'attack') {
    const title = h('span', 'report-title', mark + (won ? 'Zwycięstwo' : 'Porażka'))
    const sub = h('span', 'report-detail muted', barbarianTarget(r.targetLevel).name)
    headText.appendChild(title)
    headText.appendChild(sub)
    meta.appendChild(chip('Łup', formatInt(r.lootSum)))
    meta.appendChild(chip('Straty', formatInt(r.losses)))
  } else {
    const title = h('span', 'report-title', mark + (won ? 'Najazd odparty' : 'Osada złupiona'))
    const sub = h('span', 'report-detail muted', 'Obrona osady')
    headText.appendChild(title)
    headText.appendChild(sub)
    if (won) {
      meta.appendChild(chip('Straty', 'brak'))
    } else {
      meta.appendChild(chip('Zrabowano', formatInt(r.looted)))
      meta.appendChild(chip('Straty', formatInt(r.losses)))
    }
  }

  head.appendChild(iconWrap)
  head.appendChild(headText)
  li.appendChild(head)
  li.appendChild(meta)
  return li
}

/**
 * Compact, order-sensitive signature of the battle log. Any change (a new entry,
 * or the rolling window dropping its oldest) flips this string and triggers exactly
 * one rebuild; an unchanged log leaves update() a no-op.
 */
function logSignature(log: readonly BattleReport[]): string {
  return (
    log.length +
    '#' +
    log
      .map((r) =>
        r.kind === 'attack'
          ? 'a' + r.targetLevel + (r.won ? '1' : '0') + r.lootSum + r.losses
          : 'r' + (r.won ? '1' : '0') + r.looted + r.losses,
      )
      .join('|')
  )
}

/**
 * Build the reports panel. Returns a {@link Panel}: `el` is the root the shell
 * inserts into the active tabpanel; `update()` re-renders the grid only when the
 * battle log's content signature changes.
 */
export function createReportsPanel(ctx: UiCtx): Panel {
  const el = h('div', 'reports-panel')

  const intro = h('p', 'muted', 'Raporty z pola bitwy — najnowsze na górze.')
  intro.style.fontSize = 'var(--text-sm)'
  intro.style.marginBottom = 'var(--space-3)'
  el.appendChild(intro)

  // Responsive grid: 1 column on narrow phones, 2+ where width allows. The
  // .report-list class (layout.css) supplies the list-reset AND the shared grid
  // template (the single source of truth across tabs), so many reports tile
  // instead of stacking — no inline layout styles.
  const list = h('ul', 'report-list')
  el.appendChild(list)

  let lastSig = ''

  const update = (): void => {
    const log = ctx.store.state.battleLog
    const sig = logSignature(log)
    if (sig === lastSig) return
    lastSig = sig

    list.textContent = ''

    if (log.length === 0) {
      // Empty state is a single full-width row (not a grid cell), so the message
      // reads naturally rather than floating in one narrow column.
      const empty = h('li', 'queue-empty muted', 'Brak raportów — wyślij wyprawę lub odeprzyj najazd.')
      empty.style.gridColumn = '1 / -1'
      list.appendChild(empty)
      return
    }

    // Newest first: iterate the log (oldest→newest, append order) in reverse.
    for (let i = log.length - 1; i >= 0; i--) {
      list.appendChild(reportCard(log[i]))
    }
  }

  return { el, update }
}
