import type { UiCtx, Panel } from '../types'
import type { Stats } from '../../engine/state'
import { h, lockIcon, checkIcon } from '../dom'
import { formatNumber } from '../../engine/format'
import { ACHIEVEMENTS, ACHIEVEMENT_IDS } from '../../content/achievements'
import { achievementUnlocked } from '../../systems/achievements'

/**
 * "Osiągnięcia" panel (M5.4) — the player's career trophy case.
 *
 * Two stacked regions:
 *  1. The LIFETIME-stats strip (top): a read-only summary of the cumulative
 *     {@link GameState.stats} counters (attacks won/lost, total loot hauled,
 *     raids repelled/let through, camps razed, scouts returned, villages founded/
 *     conquered) plus the headline "n / total unlocked" tally and a native
 *     `<progress>` bar. These counters survive every ascension, so the strip reads
 *     as a true career record.
 *  2. The ACHIEVEMENT roster (below): every entry in {@link ACHIEVEMENTS}, grouped
 *     by its `category` and shown as a card with name, description and an explicit
 *     UNLOCKED / LOCKED state. The unlock state is carried by TEXT ("Odblokowane" /
 *     "Zablokowane") + an aria-hidden proceduralna ikona (check/kłódka) and a per-card
 *     aria-label, never by colour alone (WCAG 1.4.1); colour and a left accent stripe
 *     are a secondary cue.
 *
 * Data-driven & passive: this module owns NO unlock logic and NO thresholds. The
 * catalogue (content/achievements.ts) supplies the names/descriptions/categories and
 * `checkAchievements` (systems/achievements.ts) does the unlocking on the deterministic
 * tick path; the panel only READS `state.achievements` / `state.stats`. Adding or
 * rebalancing an achievement — even adding a whole new category — is a pure data edit;
 * the category sections here are derived from the catalogue (first-seen order), so a new
 * bucket appears automatically with no change to this file.
 *
 * Panel contract: the DOM is built ONCE. {@link Panel.update} only pokes the cached
 * stat values, the tally/progress and each card's status text/aria-label/accent — it
 * never rebuilds the roster.
 */

/** One lifetime-stat row in the summary strip. Pure getter over {@link Stats}. */
interface StatSpec {
  label: string
  value: (stats: Stats) => string
}

/**
 * The lifetime counters surfaced at the top, in display order. `lootHauled` is a
 * Decimal (the economy rule) and is run through {@link formatNumber}; every other
 * counter is a plain non-negative integer formatted without decimals.
 */
const STAT_SPECS: readonly StatSpec[] = [
  { label: 'Wygrane ataki', value: (s) => formatNumber(s.attacksWon, 0) },
  { label: 'Przegrane ataki', value: (s) => formatNumber(s.attacksLost, 0) },
  { label: 'Łup łączny', value: (s) => formatNumber(s.lootHauled, 0) },
  { label: 'Najazdy odparte', value: (s) => formatNumber(s.raidsRepelled, 0) },
  { label: 'Najazdy przepuszczone', value: (s) => formatNumber(s.raidsLost, 0) },
  { label: 'Obozy zrównane', value: (s) => formatNumber(s.campsRazed, 0) },
  { label: 'Powroty zwiadów', value: (s) => formatNumber(s.scoutsReturned, 0) },
  { label: 'Wioski założone', value: (s) => formatNumber(s.villagesFounded, 0) },
  { label: 'Wioski przejęte', value: (s) => formatNumber(s.villagesConquered, 0) },
]

/** Capitalise the first letter of a free-form category id for the section heading. */
function capitalize(s: string): string {
  return s.length > 0 ? s[0].toUpperCase() + s.slice(1) : s
}

/**
 * Group the catalogue ids by `category`, preserving FIRST-SEEN order over the stable
 * {@link ACHIEVEMENT_IDS} list. Deterministic and fully data-driven: a new category in
 * the catalogue yields a new section here with no code change.
 */
function groupByCategory(): { category: string; ids: string[] }[] {
  const groups: { category: string; ids: string[] }[] = []
  const byCat = new Map<string, string[]>()
  for (const id of ACHIEVEMENT_IDS) {
    const def = ACHIEVEMENTS[id]
    if (!def) continue
    let bucket = byCat.get(def.category)
    if (!bucket) {
      bucket = []
      byCat.set(def.category, bucket)
      groups.push({ category: def.category, ids: bucket })
    }
    bucket.push(id)
  }
  return groups
}

/** Cached, per-achievement handles poked by update(). */
interface AchRef {
  id: string
  name: string
  card: HTMLElement
  status: HTMLElement
  statusIcon: HTMLElement
  statusText: HTMLElement
  /** Last rendered unlock state; `null` = never rendered (forces first paint). */
  last: boolean | null
}

/**
 * Build the "Osiągnięcia" panel. Reads {@link UiCtx} only for the live store —
 * achievements are passive (read-only); there is no commit callback to wire.
 */
export function createAchievementsPanel(ctx: UiCtx): Panel {
  const el = h('div', 'achievements-panel')

  // ---- Intro note ----------------------------------------------------------
  const note = h(
    'p',
    'tech-note muted',
    'Osiągnięcia to TRWAŁE wyróżnienia za kamienie milowe Twojej kariery — ' +
      'odblokowują się automatycznie, gdy spełnisz warunek, i nigdy nie znikają ' +
      '(przetrwają każdą ascensję). Są czysto honorowe: nie dają żadnych bonusów ' +
      'do rozgrywki.',
  )
  note.setAttribute('role', 'note')
  el.appendChild(note)

  // ---- Lifetime-stats summary ---------------------------------------------
  const summary = h('section', 'achievements-summary')
  summary.setAttribute('aria-labelledby', 'ach-summary-h')
  const summaryHead = h('h3', 'achievements-summary-h', 'Statystyki kariery')
  summaryHead.id = 'ach-summary-h'
  summary.appendChild(summaryHead)

  // Reuse the shared .building-stats/.stat chrome so the strip matches every tab.
  const stats = h('div', 'building-stats')
  const statVals: HTMLElement[] = []
  for (const spec of STAT_SPECS) {
    const wrap = h('div', 'stat')
    wrap.appendChild(h('span', 'stat-label muted', spec.label))
    const val = h('span', 'stat-val num', '—')
    wrap.appendChild(val)
    stats.appendChild(wrap)
    statVals.push(val)
  }
  summary.appendChild(stats)

  // Headline tally + native progress bar (built-in aria semantics; we mirror the
  // text in aria-label so a SR reads "7 z 30 osiągnięć odblokowanych").
  const tally = h('div', 'achievements-tally')
  tally.style.display = 'flex'
  tally.style.flexDirection = 'column'
  tally.style.gap = 'var(--space-1)'
  tally.style.marginTop = 'var(--space-2)'
  const tallyText = h('p', 'num', '0 / ' + ACHIEVEMENT_IDS.length + ' odblokowanych')
  tallyText.setAttribute('role', 'status')
  tallyText.setAttribute('aria-live', 'polite')
  tally.appendChild(tallyText)
  // Reuse the shared, token-styled `.bar > i` fill (var(--accent) on var(--bg-2),
  // pill border) instead of a native <progress> — the native element ignores the
  // gold-on-dark design system and renders with browser/OS chrome. This is the same
  // progressbar pattern used by the HUD, buildings, map and campaign tabs.
  const progress = h('div', 'bar achievements-progress')
  progress.setAttribute('role', 'progressbar')
  progress.setAttribute('aria-valuemin', '0')
  progress.setAttribute('aria-valuemax', String(ACHIEVEMENT_IDS.length))
  progress.setAttribute('aria-valuenow', '0')
  progress.setAttribute('aria-label', 'Postęp odblokowanych osiągnięć')
  progress.style.maxWidth = '24rem'
  const progressFill = h('i')
  progress.appendChild(progressFill)
  tally.appendChild(progress)
  summary.appendChild(tally)

  el.appendChild(summary)

  // ---- Achievement roster (grouped by category) ---------------------------
  const refs: AchRef[] = []
  for (const group of groupByCategory()) {
    const section = h('section', 'achievements-category')
    const headingId = 'ach-cat-' + group.category.replace(/\s+/g, '-')
    section.setAttribute('aria-labelledby', headingId)
    const heading = h('h3', 'achievements-category-h', capitalize(group.category))
    heading.id = headingId
    section.appendChild(heading)

    const list = h('ul', 'card-grid achievements-list')
    list.setAttribute('role', 'list')
    list.style.listStyle = 'none'
    list.style.margin = '0'
    list.style.padding = '0'

    for (const id of group.ids) {
      const def = ACHIEVEMENTS[id]
      if (!def) continue
      const card = h('li', 'card achievement')
      card.style.borderLeft = '3px solid var(--border)'

      const name = h('h4', 'achievement-name', def.name)
      name.style.margin = '0'
      name.style.fontSize = 'var(--text-base)'
      card.appendChild(name)

      const desc = h('p', 'achievement-desc muted', def.desc)
      desc.style.margin = '0'
      desc.style.fontSize = 'var(--text-sm)'
      card.appendChild(desc)

      const status = h('span', 'achievement-status num')
      status.style.fontSize = 'var(--text-sm)'
      status.style.color = 'var(--muted)'
      status.style.display = 'inline-flex'
      status.style.alignItems = 'center'
      status.style.gap = 'var(--space-1)'
      const statusIcon = h('span', 'achievement-status-icon')
      statusIcon.setAttribute('aria-hidden', 'true')
      statusIcon.style.display = 'inline-flex'
      const statusText = h('span')
      status.appendChild(statusIcon)
      status.appendChild(statusText)
      card.appendChild(status)

      list.appendChild(card)
      refs.push({ id, name: def.name, card, status, statusIcon, statusText, last: null })
    }

    section.appendChild(list)
    el.appendChild(section)
  }

  // ---- Reactivity ----------------------------------------------------------
  // update() is driven by the shell effect, which fires on EVERY store.rev bump —
  // i.e. ~60×/s while this tab is open, whether or not anything actually changed.
  // So every reactive write below is guarded against its cached last value. This is
  // not just a perf win: `tallyText` is a polite live region, and rewriting its text
  // node each frame would make a screen reader re-announce "x z y osiągnięć"
  // continuously, drowning the one announcement that matters (a real new unlock).
  const total = ACHIEVEMENT_IDS.length
  const lastStatVals: (string | null)[] = STAT_SPECS.map(() => null)
  let lastUnlocked = -1

  const update = (): void => {
    const state = ctx.store.state
    const s = state.stats

    for (let i = 0; i < STAT_SPECS.length; i++) {
      const v = STAT_SPECS[i].value(s)
      if (v !== lastStatVals[i]) {
        lastStatVals[i] = v
        statVals[i].textContent = v
      }
    }

    let unlocked = 0
    for (const ref of refs) {
      const isUnlocked = achievementUnlocked(state, ref.id)
      if (isUnlocked) unlocked++
      if (isUnlocked === ref.last) continue
      ref.last = isUnlocked
      ref.statusText.textContent = isUnlocked ? 'Odblokowane' : 'Zablokowane'
      ref.statusIcon.textContent = ''
      const statusGlyph = isUnlocked ? checkIcon() : lockIcon()
      statusGlyph.setAttribute('aria-hidden', 'true')
      statusGlyph.style.width = '1em'
      statusGlyph.style.height = '1em'
      ref.statusIcon.appendChild(statusGlyph)
      // Colour is a SECONDARY cue — the status TEXT + the per-card aria-label carry
      // the state on their own (WCAG 1.4.1).
      ref.status.style.color = isUnlocked ? 'var(--good)' : 'var(--muted)'
      ref.card.style.borderLeft = isUnlocked
        ? '3px solid var(--good)'
        : '3px solid var(--border)'
      ref.card.setAttribute(
        'aria-label',
        ref.name + ' — ' + (isUnlocked ? 'odblokowane' : 'zablokowane'),
      )
    }

    if (unlocked !== lastUnlocked) {
      lastUnlocked = unlocked
      tallyText.textContent = unlocked + ' / ' + total + ' odblokowanych'
      // `.bar > i` width is the fill; mirror the count into the progressbar aria.
      progressFill.style.width = total > 0 ? (unlocked / total) * 100 + '%' : '0%'
      progress.setAttribute('aria-valuenow', String(unlocked))
      progress.setAttribute(
        'aria-label',
        'Odblokowano ' + unlocked + ' z ' + total + ' osiągnięć',
      )
    }
  }

  update()

  return { el, update }
}
