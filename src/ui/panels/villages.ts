import { RESOURCE_IDS, type ResourceId, type ResourceMap, type VillageId } from '../../engine/state'
import { formatNumber, formatInt, formatRate } from '../../engine/format'
import { UNIT_IDS } from '../../content/units'
import { usedPopulation } from '../../systems/recruitment'
import {
  foundCost,
  findFoundingSpot,
  canFound,
  playerVillageCount,
} from '../../systems/villages'
import type { UiCtx, Panel } from '../types'
import { h, RESOURCE_NAMES } from '../dom'
import { villageCrest } from '../crest'

/**
 * Villages panel (M2.3) — the GLOBAL, cross-village view that makes the
 * multi-village run visible: every owned village as a card (with its live
 * economy + a "Wybierz" selector) plus the founding section that plants a brand
 * new village on the map.
 *
 * Built once with createElement / textContent (never innerHTML with data); a
 * cached-ref `update()` only pokes textContent / styles / attributes. The CARD
 * SET is reconciled (rebuilt) only when {@link GameState.villageOrder} changes —
 * i.e. exactly when a village is founded — so the per-frame path never rebuilds
 * the DOM; it just refreshes the live numbers on the existing cards.
 *
 * Pure decisions (cost / where a new village can go / affordability) come
 * straight from systems/villages — {@link foundCost}, {@link findFoundingSpot},
 * {@link canFound}, {@link playerVillageCount} — so the panel never disagrees with
 * the engine. Only the MUTATION goes through the host (`ctx.onFound`), which spends
 * resources, appends the village, commits and persists.
 *
 * Visual chrome reuses the shared design-system classes (.card-grid / .card /
 * .building-cost / .cost-item / .building-name) — the single source of truth for
 * grid + card surfaces — so no bespoke CSS diverges; only token-valued inline
 * styles (var(--…)) are used for the local row layout, exactly as the buildings
 * panel does.
 */

/** One per-resource chip: its row element, the value node, an AT-only marker. */
interface CostChip {
  item: HTMLElement
  val: HTMLElement
  mark: HTMLElement
}

/** Cached handles for one village card, poked every frame by {@link update}. */
interface VillageCardRefs {
  card: HTMLElement
  badge: HTMLElement
  selectBtn: HTMLButtonElement
  coords: HTMLElement
  prod: Record<ResourceId, HTMLElement>
  storage: HTMLElement
  pop: HTMLElement
  units: HTMLElement
}

/** Build one resource chip (label + value + visually-hidden shortfall marker). */
function makeCostChip(label: string): CostChip {
  const item = h('span', 'cost-item')
  item.appendChild(h('span', 'cost-label', label))
  const val = h('span', 'num cost-val')
  item.appendChild(val)
  // Visually-hidden, AT-only shortfall cue (text, never colour alone — WCAG 1.4.1).
  const mark = h('span', 'visually-hidden')
  item.appendChild(mark)
  return { item, val, mark }
}

/** A simple "label … value" stat row (space-between, baseline-aligned). */
function makeStatRow(label: string): { row: HTMLElement; value: HTMLElement } {
  const row = h('div')
  row.style.display = 'flex'
  row.style.justifyContent = 'space-between'
  row.style.alignItems = 'baseline'
  row.style.gap = 'var(--space-2)'
  row.style.fontSize = 'var(--text-sm)'
  row.appendChild(h('span', 'muted', label))
  const value = h('span', 'num')
  row.appendChild(value)
  return { row, value }
}

/** Highest current stock across resources — the binding "how full is storage" value. */
function fullestStock(resources: ResourceMap): ResourceId {
  let best: ResourceId = RESOURCE_IDS[0]
  for (const r of RESOURCE_IDS) {
    if (resources[r].gt(resources[best])) best = r
  }
  return best
}

/**
 * Build the villages panel. Returns a {@link Panel}: `el` is the root the shell
 * inserts; `update()` reconciles the card set (on founding) and refreshes every
 * card + the founding section from current state.
 */
export function createVillagesPanel(ctx: UiCtx): Panel {
  const el = h('div', 'villages-panel')

  const intro = h(
    'p',
    'muted',
    'Zarządzaj wszystkimi wioskami i zakładaj nowe na mapie. Każda wioska ma własną produkcję, magazyn i wojsko.',
  )
  intro.style.fontSize = 'var(--text-sm)'
  intro.style.marginBottom = 'var(--space-4)'
  el.appendChild(intro)

  // ---- (1) List of owned villages -----------------------------------------
  const listHeading = h('h3', 'section-title', 'Twoje wioski')
  listHeading.style.fontSize = 'var(--text-lg)'
  listHeading.style.marginBottom = 'var(--space-3)'
  el.appendChild(listHeading)

  const grid = h('div', 'card-grid')
  el.appendChild(grid)

  // Card reconciliation: rebuild children only when the village SET (ids+names)
  // changes (i.e. a village was founded). Cheap to re-check every frame.
  let cardSig = ''
  const cardRefs = new Map<VillageId, VillageCardRefs>()

  /** Resolve a valid payer id (active village, or the first owned as a fallback). */
  const resolvePayer = (): VillageId => {
    const s = ctx.store.state
    const active = ctx.activeVillageId.value
    return s.villages[active] !== undefined ? active : s.villageOrder[0]
  }

  /** (Re)build one village card and cache its mutable refs. */
  const buildCard = (id: VillageId, name: string): VillageCardRefs => {
    const card = h('div', 'card')

    // Header: name + (hidden) "Aktywna" badge — the active village is flagged by
    // TEXT (badge) + a disabled selector + an accent border, never colour alone.
    const head = h('div')
    head.style.display = 'flex'
    head.style.justifyContent = 'space-between'
    head.style.alignItems = 'center'
    head.style.gap = 'var(--space-2)'
    // Lewa strona nagłówka: proceduralny HERB wioski + nazwa. Herb to czysta,
    // deterministyczna funkcja id wioski (ten sam id ⇒ ten sam herb, również po
    // przeładowaniu i wczytaniu zapisu — patrz crest.ts), więc każda karta ma
    // stałą, rozpoznawalną tożsamość. Herb niesie własną etykietę ('Herb wioski',
    // role=img w svgIcon) i jest dodatkiem skanowalności OBOK tekstu nazwy, nigdy
    // jedynym nośnikiem znaczenia (WCAG 1.1.1/1.4.1). To główna powierzchnia herbu.
    const left = h('div')
    left.style.display = 'flex'
    left.style.alignItems = 'center'
    left.style.gap = 'var(--space-2)'
    left.style.minWidth = '0'
    left.appendChild(villageCrest(id))
    left.appendChild(h('span', 'building-name', name))
    head.appendChild(left)
    const badge = h('span', undefined, 'Aktywna')
    badge.style.color = 'var(--accent)'
    badge.style.fontSize = 'var(--text-xs)'
    badge.style.fontWeight = 'var(--weight-bold)'
    badge.hidden = true
    head.appendChild(badge)
    card.appendChild(head)

    const coordsRow = makeStatRow('Pozycja')
    card.appendChild(coordsRow.row)

    // Production: a label over three per-resource rate chips.
    const prodWrap = h('div')
    prodWrap.style.display = 'flex'
    prodWrap.style.flexDirection = 'column'
    prodWrap.style.gap = 'var(--space-1)'
    const prodLabel = h('span', 'muted', 'Produkcja')
    prodLabel.style.fontSize = 'var(--text-sm)'
    prodWrap.appendChild(prodLabel)
    const prodChips = h('div', 'building-cost')
    const prod = {} as Record<ResourceId, HTMLElement>
    for (const r of RESOURCE_IDS) {
      const chip = makeCostChip(RESOURCE_NAMES[r])
      prodChips.appendChild(chip.item)
      prod[r] = chip.val
    }
    prodWrap.appendChild(prodChips)
    card.appendChild(prodWrap)

    const storageRow = makeStatRow('Magazyn')
    card.appendChild(storageRow.row)
    const popRow = makeStatRow('Populacja')
    card.appendChild(popRow.row)
    const unitsRow = makeStatRow('Wojsko (jedn.)')
    card.appendChild(unitsRow.row)

    const selectBtn = h('button', 'btn', 'Wybierz')
    selectBtn.type = 'button'
    selectBtn.setAttribute('aria-label', 'Wybierz wioskę: ' + name)
    selectBtn.style.marginTop = 'auto'
    selectBtn.addEventListener('click', () => {
      ctx.activeVillageId.value = id
      update()
    })
    card.appendChild(selectBtn)

    return {
      card,
      badge,
      selectBtn,
      coords: coordsRow.value,
      prod,
      storage: storageRow.value,
      pop: popRow.value,
      units: unitsRow.value,
    }
  }

  /** Rebuild the card list IFF the village set (ids+names) changed. */
  const reconcileCards = (): void => {
    const s = ctx.store.state
    let sig = ''
    for (const id of s.villageOrder) sig += id + ':' + (s.villages[id]?.name ?? '') + '|'
    if (sig === cardSig) return
    cardSig = sig

    grid.textContent = ''
    cardRefs.clear()
    for (const id of s.villageOrder) {
      const refs = buildCard(id, s.villages[id].name)
      grid.appendChild(refs.card)
      cardRefs.set(id, refs)
    }
  }

  // ---- (2) Founding section ------------------------------------------------
  const foundSection = h('section', 'founding-section')
  foundSection.style.marginTop = 'var(--space-5)'

  const foundHeading = h('h3', 'section-title', 'Zakładanie nowej wioski')
  foundHeading.style.fontSize = 'var(--text-lg)'
  foundHeading.style.marginBottom = 'var(--space-2)'
  foundSection.appendChild(foundHeading)

  const foundIntro = h(
    'p',
    'muted',
    'Nowa wioska powstaje obok twoich włości. Koszt rośnie z każdą posiadaną wioską.',
  )
  foundIntro.style.fontSize = 'var(--text-sm)'
  foundIntro.style.marginBottom = 'var(--space-3)'
  foundSection.appendChild(foundIntro)

  const countLine = makeStatRow('Liczba wiosek')
  countLine.row.style.maxWidth = '20rem'
  foundSection.appendChild(countLine.row)

  const costLabel = h('span', 'muted', 'Koszt założenia')
  costLabel.style.fontSize = 'var(--text-sm)'
  costLabel.style.display = 'block'
  costLabel.style.margin = 'var(--space-2) 0 var(--space-1)'
  foundSection.appendChild(costLabel)

  const costChips = h('div', 'building-cost')
  const foundCostRefs = {} as Record<ResourceId, CostChip>
  for (const r of RESOURCE_IDS) {
    const chip = makeCostChip(RESOURCE_NAMES[r])
    costChips.appendChild(chip.item)
    foundCostRefs[r] = chip
  }
  foundSection.appendChild(costChips)

  const foundBtn = h('button', 'btn btn-primary', 'Załóż wioskę')
  foundBtn.type = 'button'
  foundBtn.style.marginTop = 'var(--space-3)'
  foundSection.appendChild(foundBtn)

  // Single live status line: carries either the planned location (can found) or
  // the reason it is blocked (cannot). aria-live so AT announces the change.
  const statusEl = h('p', 'muted')
  statusEl.style.fontSize = 'var(--text-sm)'
  statusEl.style.marginTop = 'var(--space-2)'
  statusEl.setAttribute('aria-live', 'polite')
  foundSection.appendChild(statusEl)
  // The shell runs update() on EVERY store revision (every tick, as resources
  // accrue). Re-assigning an aria-live region's textContent re-fires it to AT even
  // when unchanged, so screen readers would re-announce the founding status many
  // times per second. Guard the write so the region only speaks on a real change.
  let lastStatus = ''

  foundBtn.addEventListener('click', () => {
    const s = ctx.store.state
    const payer = resolvePayer()
    const spot = findFoundingSpot(s, payer)
    if (spot === null) return
    if (!canFound(s, payer, spot.x, spot.y).ok) return
    const id = ctx.onFound(payer, spot.x, spot.y)
    if (id !== null) ctx.activeVillageId.value = id
    update()
  })

  el.appendChild(foundSection)

  /**
   * Refresh the whole panel from current state: reconcile the card set, poke each
   * card's live economy + active flag, and recompute the founding section (cost,
   * affordability, target spot, blocking reason). Reads `ctx.store.state` /
   * `ctx.activeVillageId.value` here (not at build time) so a tick OR a village
   * switch re-renders correctly.
   */
  const update = (): void => {
    const s = ctx.store.state
    const activeId = ctx.activeVillageId.value

    reconcileCards()

    for (const id of s.villageOrder) {
      const ref = cardRefs.get(id)
      if (ref === undefined) continue
      const v = s.villages[id]

      ref.coords.textContent = '(' + v.x + ', ' + v.y + ')'
      for (const r of RESOURCE_IDS) ref.prod[r].textContent = formatRate(v.production[r])

      const fullest = fullestStock(v.resources)
      ref.storage.textContent =
        formatNumber(v.resources[fullest]) + ' / ' + formatNumber(v.storageCap)

      const used = usedPopulation(v)
      ref.pop.textContent = formatInt(used) + ' / ' + formatInt(v.popCap)

      let total = 0
      for (const u of UNIT_IDS) total += v.units[u]
      ref.units.textContent = formatInt(total)

      const on = id === activeId
      ref.badge.hidden = !on
      ref.selectBtn.disabled = on
      ref.selectBtn.setAttribute('aria-pressed', on ? 'true' : 'false')
      ref.card.style.borderColor = on ? 'var(--accent)' : ''
      if (on) ref.card.setAttribute('aria-current', 'true')
      else ref.card.removeAttribute('aria-current')
    }

    // ---- Founding section ----
    const payer = resolvePayer()
    const payerV = s.villages[payer]
    countLine.value.textContent = formatInt(playerVillageCount(s))

    const cost = foundCost(s)
    for (const r of RESOURCE_IDS) {
      const ci = foundCostRefs[r]
      ci.val.textContent = formatInt(cost[r])
      // Shortfall cued THREE non-colour ways (WCAG 1.4.1): a CSS ⚠ glyph + bold
      // (.is-short), a hover title, and a visually-hidden "(brak)" marker for AT.
      const short = payerV.resources[r].lt(cost[r])
      ci.item.classList.toggle('is-short', short)
      ci.item.title = short ? RESOURCE_NAMES[r] + ': brak surowca' : ''
      ci.mark.textContent = short ? ' (brak)' : ''
    }

    const spot = findFoundingSpot(s, payer)
    let canDo = false
    let status: string
    if (spot === null) {
      status = 'Brak wolnego miejsca w zasięgu twoich wiosek.'
    } else {
      const verdict = canFound(s, payer, spot.x, spot.y)
      canDo = verdict.ok
      status = verdict.ok
        ? 'Nowa wioska powstanie w polu (' + spot.x + ', ' + spot.y + ').'
        : (verdict.reason ?? 'Nie można założyć wioski.')
    }
    foundBtn.disabled = !canDo
    if (status !== lastStatus) {
      statusEl.textContent = status
      lastStatus = status
    }
  }

  return { el, update }
}
