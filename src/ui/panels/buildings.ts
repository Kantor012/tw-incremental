import { D } from '../../engine/decimal'
import {
  RESOURCE_IDS,
  NO_TECH_MODS,
  type ResourceId,
  type Village,
  type TechModifiers,
} from '../../engine/state'
import { formatNumber, formatInt, formatRate } from '../../engine/format'
import {
  BUILDINGS,
  BUILDING_IDS,
  type BuildingId,
  type BuildingDef,
} from '../../content/buildings'
import { nextCostAffordable, costReduction, villageDefenseMult } from '../../systems/buildings'
import { aggregateTechMods } from '../../systems/tech'
import type { UiCtx, Panel } from '../types'
import { h, RESOURCE_NAMES } from '../dom'

/**
 * Buildings panel — a RESPONSIVE GRID of building cards (replaces the old single
 * vertical list). Built once with createElement / textContent (never innerHTML
 * with data); a cached-ref `update()` only pokes textContent / styles / attributes
 * on every store revision while this tab is active — the DOM is never rebuilt.
 *
 * The grid + card chrome come from the SHARED design-system classes
 * (.building-grid / .building-card in layout.css) — the single source of truth
 * for every tab's grid template and card surface — so no inline layout styles
 * diverge between tabs. The SUB-components reuse the existing styled classes
 * (.building-head/.building-cost/.cost-item/.building-maxed/.bar) so the WCAG
 * 1.4.1 shortfall cue (⚠ glyph + bold + red + hover title + AT-only "(brak)"
 * text) is preserved byte-for-byte from the previous implementation.
 *
 * The derived-stats summary (storage cap / population cap / production rates) that
 * used to live here has MOVED to the always-visible sticky HUD (layout.ts), so it
 * is not duplicated in this panel.
 */

/** Polish category labels (text, never colour, carries the grouping cue). */
const CATEGORY_LABELS: Record<BuildingDef['category'], string> = {
  core: 'Rdzeń',
  economy: 'Gospodarka',
  storage: 'Magazyn',
  military: 'Wojsko',
}

/** One per-resource cost chip: row element, value node, AT-only shortfall marker. */
interface CostChip {
  item: HTMLElement
  val: HTMLElement
  mark: HTMLElement
}

/** Cached handles for one building card, poked every frame by {@link update}. */
interface BuildingRefs {
  level: HTMLElement
  effect: HTMLElement
  bar: HTMLElement
  barFill: HTMLElement
  cost: HTMLElement
  maxed: HTMLElement
  costItems: Record<ResourceId, CostChip>
  button: HTMLButtonElement
}

/**
 * Human-readable CURRENT effect of one building, computed from the active village.
 * Linear effects (production/storage/population) show the level's total contribution;
 * the global effects (cost_reduction/recruit_speed) show the derived percentage from
 * the engine's own roll-up functions, so the card never disagrees with the engine.
 *
 * `mods` are the account-wide tech modifiers (default {@link NO_TECH_MODS}); they are
 * threaded into the global-effect lines so the "Koszt rozbudowy: -X%" / "Czas
 * szkolenia: -X%" percentages reflect building + tech, consistent with the cost chips
 * (which use nextCostAffordable(v, id, mods)) and the army tab (recruit time WITH tech).
 *
 * EXHAUSTIVE over the BuildingEffect union: a new effect kind is a COMPILE error
 * here (the `never` in `default`), keeping the data-driven contract honest.
 */
function effectText(v: Village, id: BuildingId, mods: TechModifiers = NO_TECH_MODS): string {
  const level = v.buildings[id]
  if (level <= 0) return 'Zbuduj poziom 1, aby aktywować.'

  const e = BUILDINGS[id].effect
  switch (e.kind) {
    case 'production':
      return 'Produkcja: +' + formatRate(D(e.perLevel).mul(level)) + ' ' + RESOURCE_NAMES[e.resource]
    case 'storage':
      return 'Pojemność magazynu: +' + formatNumber(D(e.perLevel).mul(level))
    case 'population':
      return 'Limit populacji: +' + formatInt(D(e.perLevel).mul(level))
    case 'cost_reduction':
      return 'Koszt rozbudowy: -' + Math.round((1 - costReduction(v, mods).toNumber()) * 100) + '%'
    case 'recruit_speed':
      // This building's OWN training-speed cut (multiplicative per level: 1-(1-perLevel)^level).
      // recruitSpeedMult folds EVERY recruit_speed building (Koszary + Stajnia) + tech, so showing
      // the combined total on each card would double-count once both stand — isolate per card here.
      return 'Czas szkolenia: -' + Math.round((1 - Math.pow(1 - e.perLevel, level)) * 100) + '%'
    case 'noble_unlock':
      return 'Odblokowuje szlachcica (przejmowanie wiosek)'
    case 'defense_bonus':
      // The wall raises ONLY the village's raid defence (villageDefenseMult, consumed
      // by raids.ts) — show the resulting bonus as a percentage so it reads like the
      // other global-effect lines (e.g. "+50%" for a maxed wall at perLevel 0.05).
      return 'Obrona wioski: +' + Math.round((villageDefenseMult(v) - 1) * 100) + '%'
    case 'merchant_capacity':
      // The market grants merchant CARRY capacity (cached as Village.merchantCapacity);
      // show the level's total like the other linear-per-level lines (storage/population).
      return 'Ładowność kupców: +' + formatNumber(D(e.perLevel).mul(level))
    default: {
      const _exhaustive: never = e
      return String(_exhaustive)
    }
  }
}

/** Clamp a 0..1 ratio to a finite 0..100 percentage. */
function pct(ratio: number): number {
  return Number.isFinite(ratio) ? Math.max(0, Math.min(100, ratio * 100)) : 0
}

/**
 * Build the buildings panel. Returns a {@link Panel}: `el` is the grid root the
 * shell inserts into the active tabpanel; `update()` refreshes every card.
 */
export function createBuildingsPanel(ctx: UiCtx): Panel {
  const el = h('div', 'building-panel')

  const intro = h(
    'p',
    'muted',
    'Rozbudowuj budynki, aby zwiększać produkcję, pojemność magazynu i populację.',
  )
  intro.style.fontSize = 'var(--text-sm)'
  intro.style.marginBottom = 'var(--space-3)'
  el.appendChild(intro)

  // Responsive auto-fill grid (1 column on phones, 2+ where width allows). The
  // layout lives ENTIRELY in the .building-grid class (layout.css) — the single
  // source of truth shared by every tab — so the grid template never diverges.
  const grid = h('div', 'building-grid')
  el.appendChild(grid)

  const bRefs = {} as Record<BuildingId, BuildingRefs>

  for (const id of BUILDING_IDS) {
    const def = BUILDINGS[id]

    // Card chrome (flex column / padding / --panel-2 surface / border / radius)
    // comes from the shared .building-card class in layout.css — no inline styles.
    const card = h('div', 'building-card')

    // -- header: name + category (left, stacked) · level (right) --------------
    const head = h('div', 'building-head')
    const left = h('div')
    left.style.display = 'flex'
    left.style.flexDirection = 'column'
    left.appendChild(h('span', 'building-name', def.name))
    const cat = h('span', 'building-cat muted', CATEGORY_LABELS[def.category])
    cat.style.fontSize = 'var(--text-xs)'
    left.appendChild(cat)
    const level = h('span', 'building-level num')
    head.appendChild(left)
    head.appendChild(level)

    // -- level progress bar (visual companion to the "poz. X / Y" text) -------
    const bar = h('div', 'bar')
    bar.setAttribute('role', 'progressbar')
    bar.setAttribute('aria-valuemin', '0')
    bar.setAttribute('aria-valuemax', String(def.maxLevel))
    bar.setAttribute('aria-label', 'Poziom: ' + def.name)
    const barFill = h('i')
    bar.appendChild(barFill)

    // -- current effect (dynamic) + flavour description (static) --------------
    const effect = h('p', 'building-effect')
    effect.style.fontSize = 'var(--text-sm)'
    effect.style.color = 'var(--text)'
    const desc = h('p', 'building-desc muted', def.desc)

    // -- next-level cost chips (per resource) / "Maks." marker ----------------
    const cost = h('div', 'building-cost')
    const costItems = {} as Record<ResourceId, CostChip>
    for (const r of RESOURCE_IDS) {
      const item = h('span', 'cost-item')
      item.appendChild(h('span', 'cost-label', RESOURCE_NAMES[r]))
      const val = h('span', 'num cost-val')
      item.appendChild(val)
      // Visually-hidden, AT-only shortfall cue (text, never colour alone).
      const mark = h('span', 'visually-hidden')
      item.appendChild(mark)
      cost.appendChild(item)
      costItems[r] = { item, val, mark }
    }
    const maxed = h('span', 'building-maxed', 'Maks.')
    maxed.hidden = true

    // -- upgrade button (pinned to card bottom for tidy rows) -----------------
    const button = h('button', 'btn', 'Rozbuduj')
    button.type = 'button'
    button.setAttribute('aria-label', 'Rozbuduj: ' + def.name)
    button.style.marginTop = 'auto'
    button.addEventListener('click', () => {
      ctx.onBuild(ctx.activeVillageId.value, id)
      update()
    })

    card.appendChild(head)
    card.appendChild(bar)
    card.appendChild(effect)
    card.appendChild(desc)
    card.appendChild(cost)
    card.appendChild(maxed)
    card.appendChild(button)
    grid.appendChild(card)

    bRefs[id] = { level, effect, bar, barFill, cost, maxed, costItems, button }
  }

  /**
   * Refresh every card from the ACTIVE village's economy. Read inside `update()`
   * (not captured at build time) so switching the active village re-renders the
   * cards against the newly selected village's buildings / resources.
   */
  const update = (): void => {
    const v = ctx.store.state.villages[ctx.activeVillageId.value]
    // Account-wide tech modifiers — folded into the displayed next-level cost so the
    // shown amount matches what build() (onBuild threads the same mods) actually charges.
    const mods = aggregateTechMods(ctx.store.state.tech)
    for (const id of BUILDING_IDS) {
      const ref = bRefs[id]
      const def = BUILDINGS[id]
      const level = v.buildings[id]

      ref.level.textContent = 'poz. ' + level + ' / ' + def.maxLevel
      ref.effect.textContent = effectText(v, id, mods)

      const lvlPct = pct(def.maxLevel > 0 ? level / def.maxLevel : 0)
      ref.barFill.style.width = lvlPct + '%'
      ref.bar.setAttribute('aria-valuenow', String(level))
      ref.bar.setAttribute('aria-valuetext', 'poziom ' + level + ' z ' + def.maxLevel)

      const { cost, affordable, maxed } = nextCostAffordable(v, id, mods)
      ref.maxed.hidden = !maxed
      ref.cost.hidden = maxed
      ref.button.disabled = maxed || !affordable

      if (!maxed) {
        for (const r of RESOURCE_IDS) {
          const ci = ref.costItems[r]
          ci.val.textContent = formatInt(cost[r])
          // Shortfall cued THREE non-colour ways (WCAG 1.4.1): a CSS ⚠ glyph + bold
          // (.is-short), a hover title, and a visually-hidden text marker for AT —
          // never colour alone.
          const short = v.resources[r].lt(cost[r])
          ci.item.classList.toggle('is-short', short)
          ci.item.title = short ? RESOURCE_NAMES[r] + ': brak surowca' : ''
          ci.mark.textContent = short ? ' (brak)' : ''
        }
      }
    }
  }

  return { el, update }
}
