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
 * Scope: the battle log is GLOBAL (one rolling window across every village), so the
 * panel reads {@link UiCtx.store}.state.battleLog directly and is independent of the
 * active village. Each report carries its origin via {@link BattleReport.villageId};
 * once the run has more than one village, every card shows that origin name as a
 * small extra cue (with a single capital it would be redundant, so it stays hidden).
 *
 * Reactivity: the battle log is an append-mostly, bounded array, so update() guards
 * a full re-render behind a content SIGNATURE — the grid is rebuilt ONLY when the
 * log actually changes (a new battle, the rolling window dropping its oldest, or the
 * village-origin context appearing/changing), never per frame. While the signature
 * is unchanged, update() is a cheap no-op. This matches the no-rebuild-per-frame
 * discipline of the marches/queue lists.
 *
 * Accessibility (WCAG): a win/loss is NEVER signalled by colour alone — every card
 * carries a ✓ / ✗ glyph AND a Polish result word in its title (the coloured left
 * border + badge are an addition, not the sole cue). Each card also gets a labelled
 * SVG icon (crossed swords for an outgoing attack, a shield for a defended raid, a
 * crown for a conquest). The conquest card (M2.4) is a milestone rather than a
 * win/loss, so it uses a ★ mark + the title "Przejęto wioskę" + a gold accent border.
 */

/**
 * Procedural crossed-swords glyph for an outgoing attack (offence). Fills/strokes are
 * driven from design-system TOKENS (set via the `style` property, which — unlike SVG
 * presentation attributes — accepts the `var()` grammar, exactly as dom.ts's shieldIcon
 * and the chip() helper do), so a palette change in tokens.css follows here and the
 * project's single-source-of-truth colour rule holds (no hardcoded hex).
 */
function attackIcon(): SVGSVGElement {
  const blade = (d: string): SVGElement => {
    const p = svg('path', { d, 'stroke-width': '2', 'stroke-linecap': 'round', fill: 'none' })
    p.style.stroke = 'var(--iron)' // steel blade
    return p
  }
  const hilt = (d: string): SVGElement => {
    const p = svg('path', { d, 'stroke-width': '2', 'stroke-linecap': 'round', fill: 'none' })
    p.style.stroke = 'var(--wood)' // wooden hilt
    return p
  }
  return svgIcon('0 0 24 24', 'Atak na obóz', 'report-glyph', [
    blade('M4 4 14 14'),
    blade('M20 4 10 14'),
    hilt('M14 14 18 20'),
    hilt('M10 14 6 20'),
  ])
}

/** Procedural shield glyph for an incoming raid (defence). Token-driven fills (see attackIcon). */
function raidIcon(): SVGSVGElement {
  const face = svg('path', { d: 'M12 2 4 5v6c0 5 4 8 8 9 4-1 8-4 8-9V5z' })
  face.style.fill = 'var(--iron)' // steel shield face
  const shade = svg('path', { d: 'M12 2 4 5v6c0 5 4 8 8 9z' })
  shade.style.fill = 'color-mix(in srgb, var(--iron) 70%, black)' // shaded half
  const boss = svg('path', { d: 'M12 7 16 10 12 13 8 10z', 'fill-opacity': '0.4' })
  boss.style.fill = 'color-mix(in srgb, var(--wood) 40%, black)' // dark central boss
  return svgIcon('0 0 24 24', 'Najazd na osadę', 'report-glyph', [face, shade, boss])
}

/**
 * Procedural crown glyph for a CONQUERED village (M2.4) — a milestone event, so it
 * gets its own positive cue distinct from the win/loss ✓/✗ used by attacks/raids.
 * The gold tones come from the accent TOKENS (set via `style` so `var()` / `color-mix`
 * resolve — see attackIcon); the icon is one of several non-colour cues (alongside the
 * ★ mark and the Polish title) so colour is never the sole signal.
 */
function conquerIcon(): SVGSVGElement {
  const points = svg('path', {
    d: 'M4 16 4 7 8.5 11 12 5 15.5 11 20 7 20 16Z',
    'stroke-width': '1',
    'stroke-linejoin': 'round',
  })
  points.style.fill = 'var(--accent-2)' // bright brass crown body
  points.style.stroke = 'color-mix(in srgb, var(--accent) 70%, black)' // darker gold outline
  const band = svg('rect', { x: '4', y: '16', width: '16', height: '4', rx: '1' })
  band.style.fill = 'var(--accent)' // gold band
  const gem = svg('circle', { cx: '12', cy: '18', r: '1.1' })
  gem.style.fill = 'color-mix(in srgb, var(--bad) 55%, black)' // dark ruby
  return svgIcon('0 0 24 24', 'Przejęcie wioski', 'report-glyph', [points, band, gem])
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

/**
 * Build the single-event card (newest entries are appended first). `villageName`
 * is the resolved origin of the report ({@link BattleReport.villageId}); when
 * non-null it is rendered as a small muted line above the result so a global log
 * spanning many villages stays readable. It is passed `null` while the run has a
 * single village (the lone origin would be redundant noise).
 */
function reportCard(r: BattleReport, villageName: string | null): HTMLElement {
  // Conquest is neither a win nor a loss row — it has its own card (gold accent,
  // crown glyph) and carries no `won` field, so it is handled before the win/loss
  // path narrows `r` to attack | raid below.
  if (r.kind === 'conquer') return conquerCard(r, villageName)

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

  // Origin village (only when the run spans more than one village) — a small,
  // muted context line above the result; never the sole cue for anything.
  if (villageName !== null) {
    const origin = h('span', 'report-village muted', villageName)
    origin.style.fontSize = 'var(--text-xs)'
    headText.appendChild(origin)
  }

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
    // Conquest progress (M2.4): a won strike whose surviving noble eroded the target's
    // loyalty carries it here, so the log shows the "postęp" toward capture (e.g.
    // „Lojalność −25 → 50") rather than an indistinguishable plain victory. Present
    // only on such strikes (optional fields); rounded for display, exact in state.
    if (r.loyaltyAfter !== undefined) {
      const drop = Math.round(r.loyaltyHit ?? 0)
      const left = Math.round(r.loyaltyAfter)
      meta.appendChild(chip('Lojalność', '−' + drop + ' → ' + left))
    }
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
 * Build the conquest card (M2.4). Mirrors {@link reportCard}'s head/meta layout but
 * for the `conquer` variant, which has no win/loss: it is always a positive outcome,
 * marked by a gold accent border, a crown glyph, a ★ symbol and the Polish title —
 * never colour alone. `villageName` is the resolved attacking origin (shown only on
 * multi-village runs, same rule as the other cards). The taken village's name comes
 * straight from the report (`targetName`); the freshly created player village is
 * surfaced as a status chip so the milestone reads clearly.
 */
function conquerCard(
  r: Extract<BattleReport, { kind: 'conquer' }>,
  villageName: string | null,
): HTMLElement {
  const li = h('li', 'report-item report-conquer')
  // Gold (accent) left border — a distinct, additional cue beyond the icon + text.
  // Set inline (not via a CSS class) so this panel stays self-contained.
  li.style.borderLeftColor = 'var(--accent)'

  const head = h('div', 'report-head')
  head.style.display = 'flex'
  head.style.alignItems = 'center'
  head.style.gap = 'var(--space-2)'

  const iconWrap = h('span', 'report-icon')
  iconWrap.style.flex = '0 0 auto'
  iconWrap.style.display = 'inline-flex'
  iconWrap.appendChild(conquerIcon())

  const headText = h('div', 'report-headtext')
  headText.style.display = 'flex'
  headText.style.flexDirection = 'column'
  headText.style.minWidth = '0'

  if (villageName !== null) {
    const origin = h('span', 'report-village muted', villageName)
    origin.style.fontSize = 'var(--text-xs)'
    headText.appendChild(origin)
  }

  const title = h('span', 'report-title', '★ Przejęto wioskę')
  const sub = h('span', 'report-detail muted', r.targetName)
  headText.appendChild(title)
  headText.appendChild(sub)

  const meta = h('div', 'report-meta')
  meta.style.display = 'flex'
  meta.style.flexWrap = 'wrap'
  meta.style.gap = 'var(--space-1)'
  meta.style.marginTop = 'var(--space-1)'
  meta.appendChild(chip('Status', 'Twoja wioska'))

  head.appendChild(iconWrap)
  head.appendChild(headText)
  li.appendChild(head)
  li.appendChild(meta)
  return li
}

/**
 * Compact, order-sensitive signature of the battle log. Any change (a new entry,
 * the rolling window dropping its oldest, or the origin context appearing/changing)
 * flips this string and triggers exactly one rebuild; an unchanged log leaves
 * update() a no-op. `originOf` returns the rendered origin label for a report (or
 * `null` when origins are hidden), so the signature tracks exactly what is drawn.
 */
function logSignature(
  log: readonly BattleReport[],
  originOf: (r: BattleReport) => string | null,
): string {
  return (
    log.length +
    '#' +
    log.map((r) => r.villageId + '~' + (originOf(r) ?? '') + '~' + reportBase(r)).join('|')
  )
}

/**
 * Per-report content fingerprint used by {@link logSignature}. EXHAUSTIVE over the
 * `kind` union (no `default` short-circuit, a `never` assignment instead): adding a
 * new report variant to {@link BattleReport} is a COMPILE error here until it gets an
 * explicit fingerprint — the signature can never silently miss a new report's fields.
 */
function reportBase(r: BattleReport): string {
  switch (r.kind) {
    case 'attack':
      return (
        'a' +
        r.targetLevel +
        (r.won ? '1' : '0') +
        r.lootSum +
        r.losses +
        (r.loyaltyAfter !== undefined ? 'L' + (r.loyaltyHit ?? 0) + '>' + r.loyaltyAfter : '')
      )
    case 'raid':
      return 'r' + (r.won ? '1' : '0') + r.looted + r.losses
    case 'conquer':
      return 'c' + r.targetName + r.newVillageId
    default: {
      const _exhaustive: never = r
      return String(_exhaustive)
    }
  }
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
    const state = ctx.store.state
    const log = state.battleLog
    // Origins are shown only once the run spans more than one village (with a lone
    // capital the single origin would be pure noise). When shown, resolve the name
    // from the GLOBAL village map by the report's villageId; an unknown id yields
    // null so the line is simply omitted rather than rendering a broken label.
    const showOrigin = state.villageOrder.length > 1
    const originOf = (r: BattleReport): string | null =>
      showOrigin ? (state.villages[r.villageId]?.name ?? null) : null

    const sig = logSignature(log, originOf)
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
      list.appendChild(reportCard(log[i], originOf(log[i])))
    }
  }

  return { el, update }
}
