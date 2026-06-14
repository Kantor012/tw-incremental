import { effect } from '../engine/store'
import { RESOURCE_IDS, type ResourceId } from '../engine/state'
import { formatNumber, formatInt, formatRate, formatTime } from '../engine/format'
import { usedPopulation } from '../systems/recruitment'
import type { UiCtx, Panel } from './types'
import { h, resourceIcon, shieldIcon, RESOURCE_NAMES } from './dom'

/**
 * Dashboard shell. Replaces the old single vertical stack of panels with:
 *   a) a STICKY HUD (always-visible resources + storage/population), and
 *   b) a TAB BAR (accessible tablist) switching one panel into the content area.
 *
 * The shell owns no game logic — it only mounts the panel instances, keeps the
 * HUD live and routes `update()` to the active panel. Reactivity follows the same
 * no-rebuild discipline as the panels: a single effect on `store.rev` pokes the
 * HUD's cached nodes and the active panel's cached nodes; the DOM tree built here
 * is never reconstructed per frame.
 */

/** One tab: its stable id (storage key + DOM ids), label and panel factory. */
export interface TabSpec {
  id: string
  label: string
  create: (ctx: UiCtx) => Panel
}

/** localStorage key remembering the last active tab across reloads. */
const TAB_STORAGE_KEY = 'tw-incremental:tab'

/** Read the persisted active-tab id, mapped to an index (0 when absent/unknown). */
function restoreTabIndex(tabs: TabSpec[]): number {
  try {
    if (typeof localStorage !== 'undefined') {
      const saved = localStorage.getItem(TAB_STORAGE_KEY)
      if (saved) {
        const idx = tabs.findIndex((t) => t.id === saved)
        if (idx >= 0) return idx
      }
    }
  } catch {
    /* private mode / blocked storage — fall through to the first tab */
  }
  return 0
}

/** Persist the active-tab id (best-effort; storage may be unavailable). */
function persistTabId(id: string): void {
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(TAB_STORAGE_KEY, id)
  } catch {
    /* ignore */
  }
}

/** Set a `.bar > i` fill width and the host's aria-valuenow from a 0..100 pct. */
function setBar(bar: HTMLElement, pct: number): void {
  const fill = bar.firstElementChild as HTMLElement | null
  if (fill) fill.style.width = pct + '%'
  bar.setAttribute('aria-valuenow', Math.round(pct).toString())
}

/** Clamp a raw ratio*100 to a finite 0..100 percentage (NaN/∞ → full). */
function pctOf(part: number): number {
  return Number.isFinite(part) ? Math.max(0, Math.min(100, part)) : 100
}

interface HudResRefs {
  value: HTMLElement
  rate: HTMLElement
}

interface HudStatRefs {
  wrap: HTMLElement
  val: HTMLElement
  bar: HTMLElement
}

/** Build one HUD stat group (label + value + thin fill bar). */
function makeHudStat(label: string): HudStatRefs {
  const wrap = h('div', 'hud-stat')
  wrap.appendChild(h('span', 'hud-stat-label muted', label))
  const val = h('span', 'num hud-stat-val')
  wrap.appendChild(val)
  const bar = h('div', 'bar hud-bar')
  bar.setAttribute('role', 'progressbar')
  bar.setAttribute('aria-valuemin', '0')
  bar.setAttribute('aria-valuemax', '100')
  bar.setAttribute('aria-label', 'Zapełnienie: ' + label)
  bar.appendChild(h('i'))
  wrap.appendChild(bar)
  return { wrap, val, bar }
}

/**
 * Build the whole dashboard and wire its reactivity. Returns the root element to
 * append into `#app`. The caller (app.ts) supplies the tab specs; this function
 * instantiates each panel exactly once via `spec.create(ctx)`.
 */
export function buildShell(ctx: UiCtx, tabs: TabSpec[]): HTMLElement {
  const state = ctx.store.state
  const shell = h('div', 'app-shell')

  // ---- a) Sticky HUD -------------------------------------------------------
  const hud = h('header', 'hud')
  hud.setAttribute('role', 'banner')
  const hudInner = h('div', 'hud-inner container')

  // Brand: procedural shield + title + small seed subtitle.
  const brand = h('div', 'hud-brand')
  const brandMark = h('span', 'hud-brand-mark')
  brandMark.setAttribute('aria-hidden', 'false')
  brandMark.appendChild(shieldIcon())
  const brandText = h('div', 'hud-brand-text')
  // Marka jest jednocześnie h1 dokumentu (korzeń hierarchii nagłówków: h1 > h2
  // sekcji > h3 podsekcji), by nawigacja po nagłówkach w czytniku ekranu nie
  // zaczynała się od h3. Wygląd bez zmian — styl niesie klasa .hud-title.
  brandText.appendChild(h('h1', 'hud-title', 'TW Incremental'))
  brandText.appendChild(h('span', 'hud-seed muted', 'seed: ' + state.seed))
  brand.appendChild(brandMark)
  brand.appendChild(brandText)
  hudInner.appendChild(brand)

  // Resource cluster: wood / clay / iron — icon + value + rate.
  const resCluster = h('div', 'hud-resources')
  const hudRes = {} as Record<ResourceId, HudResRefs>
  for (const id of RESOURCE_IDS) {
    const chip = h('div', 'hud-res')
    // Name reaches assistive tech via the icon's aria-label AND a hover title; the
    // glyph is never the sole carrier of which resource a number belongs to.
    chip.title = RESOURCE_NAMES[id]
    const iconWrap = h('span', 'hud-res-icon res-icon-wrap')
    iconWrap.appendChild(resourceIcon(id))
    const txt = h('span', 'hud-res-text')
    const value = h('span', 'num hud-res-value')
    const rate = h('span', 'num muted hud-res-rate')
    txt.appendChild(value)
    txt.appendChild(rate)
    chip.appendChild(iconWrap)
    chip.appendChild(txt)
    resCluster.appendChild(chip)
    hudRes[id] = { value, rate }
  }
  hudInner.appendChild(resCluster)

  // Storage + population stats (used / cap with a thin fill bar each).
  const statCluster = h('div', 'hud-stats')
  const storageStat = makeHudStat('Magazyn')
  const popStat = makeHudStat('Populacja')
  statCluster.appendChild(storageStat.wrap)
  statCluster.appendChild(popStat.wrap)
  hudInner.appendChild(statCluster)

  hud.appendChild(hudInner)
  shell.appendChild(hud)

  /** Refresh every HUD node from the live state. Runs on EVERY store revision. */
  const updateHud = (): void => {
    const s = ctx.store.state
    // Resource amounts + rates; track the fullest resource for the storage bar
    // (storage cap is per-resource, so the closest-to-capping resource is the
    // binding "how full is the magazyn" signal — when it caps, production wastes).
    let fullest = s.resources[RESOURCE_IDS[0]]
    for (const id of RESOURCE_IDS) {
      const r = hudRes[id]
      r.value.textContent = formatNumber(s.resources[id])
      r.rate.textContent = formatRate(s.production[id])
      if (s.resources[id].gt(fullest)) fullest = s.resources[id]
    }

    const cap = s.storageCap
    storageStat.val.textContent = formatNumber(fullest) + ' / ' + formatNumber(cap)
    setBar(storageStat.bar, cap.gt(0) ? pctOf(fullest.div(cap).mul(100).toNumber()) : 0)

    const used = usedPopulation(s)
    popStat.val.textContent = formatInt(used) + ' / ' + formatInt(s.popCap)
    setBar(popStat.bar, s.popCap.gt(0) ? pctOf(used.div(s.popCap).mul(100).toNumber()) : 0)
  }

  // ---- b) Tab bar (tablist) + c) content area (tabpanels) ------------------
  const tabsBar = h('nav', 'tabs-bar')
  tabsBar.setAttribute('aria-label', 'Nawigacja sekcji')
  const tablist = h('div', 'tabs container')
  tablist.setAttribute('role', 'tablist')
  tablist.setAttribute('aria-label', 'Sekcje gry')
  tabsBar.appendChild(tablist)

  const main = h('main', 'tabpanels container')

  interface TabEntry {
    id: string
    tab: HTMLButtonElement
    panelWrap: HTMLElement
    panel: Panel
  }
  const entries: TabEntry[] = []

  for (let i = 0; i < tabs.length; i++) {
    const spec = tabs[i]

    const tab = h('button', 'tab', spec.label)
    tab.type = 'button'
    tab.id = 'tab-' + spec.id
    tab.setAttribute('role', 'tab')
    tab.setAttribute('aria-controls', 'panel-' + spec.id)
    tab.setAttribute('aria-selected', 'false')
    // Roving tabindex: only the active tab is in the Tab order; arrow keys move
    // focus within the tablist (set in selectTab).
    tab.tabIndex = -1
    tab.addEventListener('click', () => selectTab(i, true))
    tablist.appendChild(tab)

    const panelWrap = h('section', 'tabpanel')
    panelWrap.id = 'panel-' + spec.id
    panelWrap.setAttribute('role', 'tabpanel')
    panelWrap.setAttribute('aria-labelledby', 'tab-' + spec.id)
    panelWrap.tabIndex = 0
    panelWrap.hidden = true
    // Nagłówek sekcji (h2) dla nawigacji po nagłówkach: domyka łańcuch h1 > h2 >
    // h3, więc podtytuły paneli (h3) nigdy nie przeskakują poziomu. Wizualnie
    // ukryty — sekcję nazywa już zakładka (aria-labelledby → tab-<id>).
    panelWrap.appendChild(h('h2', 'visually-hidden', spec.label))
    const panel = spec.create(ctx)
    panelWrap.appendChild(panel.el)
    main.appendChild(panelWrap)

    entries.push({ id: spec.id, tab, panelWrap, panel })
  }

  let activeIndex = restoreTabIndex(tabs)

  /**
   * Activate tab `index`: update aria-selected + roving tabindex + `.is-active`,
   * show its panel (hide the rest), persist the choice, and immediately refresh
   * the now-visible panel from current state (it was skipped while hidden).
   */
  const selectTab = (index: number, moveFocus: boolean): void => {
    if (index < 0 || index >= entries.length) return
    activeIndex = index
    for (let i = 0; i < entries.length; i++) {
      const en = entries[i]
      const on = i === index
      en.tab.setAttribute('aria-selected', on ? 'true' : 'false')
      en.tab.tabIndex = on ? 0 : -1
      en.tab.classList.toggle('is-active', on)
      en.panelWrap.hidden = !on
    }
    if (moveFocus) entries[index].tab.focus()
    persistTabId(entries[index].id)
    entries[index].panel.update()
  }

  // Keyboard navigation within the tablist (automatic activation): arrows wrap,
  // Home/End jump to the ends. Enter/Space need no special handling — a focused
  // tab is already selected, and the button's native click covers them anyway.
  tablist.addEventListener('keydown', (e: KeyboardEvent) => {
    let next = -1
    switch (e.key) {
      case 'ArrowRight':
      case 'ArrowDown':
        next = (activeIndex + 1) % entries.length
        break
      case 'ArrowLeft':
      case 'ArrowUp':
        next = (activeIndex - 1 + entries.length) % entries.length
        break
      case 'Home':
        next = 0
        break
      case 'End':
        next = entries.length - 1
        break
      default:
        return
    }
    e.preventDefault()
    selectTab(next, true)
  })

  shell.appendChild(tabsBar)
  shell.appendChild(main)

  // ---- d) Footer (version + offline credit) --------------------------------
  const footer = h('footer', 'app-footer container muted')
  footer.textContent =
    'wersja ' +
    ctx.version +
    (ctx.offlineSeconds > 0 ? ' • offline: ' + formatTime(ctx.offlineSeconds) : '')
  shell.appendChild(footer)

  // ---- Reactivity ----------------------------------------------------------
  // Show the initial tab (also runs its first update), then subscribe a single
  // effect that refreshes the HUD + ONLY the active panel on every revision.
  selectTab(activeIndex, false)
  effect(() => {
    void ctx.store.rev.value
    updateHud()
    entries[activeIndex].panel.update()
  })

  return shell
}
