import { effect } from '../engine/store'
import { RESOURCE_IDS, type ResourceId, type VillageId } from '../engine/state'
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

  // ---- Village switcher (picks the village the HUD + active panel reflect) --
  // The HUD and the active tab always reflect exactly ONE village; this control
  // selects which by WRITING ctx.activeVillageId (panels/HUD read it back). Built
  // once: its buttons are reconciled only when the village SET (ids/names) changes,
  // and selecting a village just re-flags the active button — so the hot per-frame
  // path never rebuilds DOM. At a single village it degrades to a plain name label
  // (no switcher), yet the same code scales to N villages the instant villageOrder
  // grows (M2.3). A small "Wioski: N" indicator sits beside it.
  const villageCluster = h('div', 'hud-villages')
  const villageList = h('div', 'village-switch')
  // Panel-level attribution: in the multi-village group the HUD numbers AND every
  // panel reflect the ACTIVE village, yet the panels never repeat its name. This
  // small persistent label (written in updateVillageActive) names the active
  // village beside the count, so a user scrolled deep in a tab still knows which
  // village they operate on. Empty at a single village — .village-current already
  // carries the lone name there.
  const villageActiveName = h('span', 'hud-active-village')
  const villageCount = h('span', 'hud-village-count muted')
  villageCluster.appendChild(villageList)
  villageCluster.appendChild(villageActiveName)
  villageCluster.appendChild(villageCount)
  hudInner.appendChild(villageCluster)

  // Reconciliation state: a signature of the current village SET (rebuild buttons
  // only when ids/names actually change), the per-village button cache, and whether
  // we are in the multi-village (group) layout.
  let villageSetSig = ''
  let villageBtns: { id: VillageId; btn: HTMLButtonElement }[] = []
  let villageIsGroup = false

  /** Activate village `id` (no-op when already active). */
  const selectVillage = (id: VillageId): void => {
    if (ctx.activeVillageId.value !== id) ctx.activeVillageId.value = id
  }

  /**
   * Rebuild the switcher's children IFF the set of villages changed. One village →
   * a single static label; two or more → a labelled group of toggle buttons. Cheap
   * to call every frame: early-returns when the set signature is unchanged.
   */
  const rebuildVillageSwitch = (): void => {
    const s = ctx.store.state
    const order = s.villageOrder
    let sig = ''
    for (const id of order) sig += id + ':' + (s.villages[id]?.name ?? '') + '|'
    if (sig === villageSetSig) return
    villageSetSig = sig

    villageList.textContent = ''
    villageBtns = []
    villageCount.textContent = 'Wioski: ' + order.length

    if (order.length <= 1) {
      // Single village: a plain, non-interactive name label (no switcher needed).
      villageIsGroup = false
      villageList.removeAttribute('role')
      villageList.removeAttribute('aria-label')
      // The lone name lives in .village-current; keep the attribution label empty
      // so it is not duplicated.
      villageActiveName.textContent = ''
      const only = order[0]
      const label = h('span', 'village-current')
      label.textContent = only ? (s.villages[only]?.name ?? '—') : '—'
      villageList.appendChild(label)
      return
    }

    // Multiple villages: a single-select RADIOGROUP (WAI-ARIA APG). Each option is
    // a role=radio button with a roving tabindex; arrow keys move focus AND select
    // (selection-follows-focus — the radiogroup convention) via the keydown handler
    // below. aria-checked + the .is-active class (set in updateVillageActive) carry
    // the selection as more than colour (WCAG 1.4.1). aria-setsize/-posinset expose
    // the "N-ta z N" position to assistive tech.
    villageIsGroup = true
    villageList.setAttribute('role', 'radiogroup')
    villageList.setAttribute('aria-label', 'Wybór aktywnej wioski')
    for (let i = 0; i < order.length; i++) {
      const id = order[i]
      const btn = h('button', 'village-btn')
      btn.type = 'button'
      btn.setAttribute('role', 'radio')
      btn.setAttribute('aria-setsize', order.length.toString())
      btn.setAttribute('aria-posinset', (i + 1).toString())
      btn.textContent = s.villages[id].name
      btn.addEventListener('click', () => selectVillage(id))
      villageList.appendChild(btn)
      villageBtns.push({ id, btn })
    }
  }

  /**
   * Flag the active village on the cached buttons (aria-checked + the .is-active
   * class + roving tabindex) and name it in the panel-attribution label. No DOM
   * rebuild — only attribute/text writes — so it is safe on every frame and on
   * every selection change.
   */
  const updateVillageActive = (): void => {
    if (!villageIsGroup) return
    const s = ctx.store.state
    const active = ctx.activeVillageId.value
    let activeName = ''
    for (const { id, btn } of villageBtns) {
      const on = id === active
      btn.setAttribute('aria-checked', on ? 'true' : 'false')
      btn.classList.toggle('is-active', on)
      btn.tabIndex = on ? 0 : -1
      if (on) activeName = s.villages[id]?.name ?? ''
    }
    villageActiveName.textContent = activeName
  }

  // Keyboard navigation inside the radiogroup (roving tabindex, selection follows
  // focus per ARIA APG) — like the tablist: arrows wrap, Home/End jump to the ends.
  villageList.addEventListener('keydown', (e: KeyboardEvent) => {
    if (!villageIsGroup || villageBtns.length === 0) return
    let idx = villageBtns.findIndex((b) => b.id === ctx.activeVillageId.value)
    if (idx < 0) idx = 0
    let next = -1
    switch (e.key) {
      case 'ArrowRight':
      case 'ArrowDown':
        next = (idx + 1) % villageBtns.length
        break
      case 'ArrowLeft':
      case 'ArrowUp':
        next = (idx - 1 + villageBtns.length) % villageBtns.length
        break
      case 'Home':
        next = 0
        break
      case 'End':
        next = villageBtns.length - 1
        break
      default:
        return
    }
    e.preventDefault()
    const target = villageBtns[next]
    selectVillage(target.id)
    target.btn.focus()
  })

  // Resource cluster: wood / clay / iron — icon + value + rate.
  const resCluster = h('div', 'hud-resources')
  const hudRes = {} as Record<ResourceId, HudResRefs>
  for (const id of RESOURCE_IDS) {
    // Modyfikator per-surowiec (hud-res--wood/clay/iron) daje CSS hak na delikatną
    // poświatę ikony w barwie surowca — dekoracja, nie jedyny sygnał (nazwę niesie
    // aria-label ikony + title chipa).
    const chip = h('div', 'hud-res hud-res--' + id)
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

  /**
   * Refresh every HUD node from the ACTIVE village. Runs on EVERY store revision
   * AND on every village selection (the effect tracks both signals). Falls back to
   * the first village if the selection is momentarily stale (e.g. a just-removed
   * village before main.ts re-seeds the signal) so the HUD never reads `undefined`.
   */
  const updateHud = (): void => {
    const s = ctx.store.state
    const v = s.villages[ctx.activeVillageId.value] ?? s.villages[s.villageOrder[0]]
    // Resource amounts + rates; track the fullest resource for the storage bar
    // (storage cap is per-resource, so the closest-to-capping resource is the
    // binding "how full is the magazyn" signal — when it caps, production wastes).
    let fullest = v.resources[RESOURCE_IDS[0]]
    for (const id of RESOURCE_IDS) {
      const r = hudRes[id]
      r.value.textContent = formatNumber(v.resources[id])
      r.rate.textContent = formatRate(v.production[id])
      if (v.resources[id].gt(fullest)) fullest = v.resources[id]
    }

    const cap = v.storageCap
    storageStat.val.textContent = formatNumber(fullest) + ' / ' + formatNumber(cap)
    setBar(storageStat.bar, cap.gt(0) ? pctOf(fullest.div(cap).mul(100).toNumber()) : 0)

    const used = usedPopulation(v)
    popStat.val.textContent = formatInt(used) + ' / ' + formatInt(v.popCap)
    setBar(popStat.bar, v.popCap.gt(0) ? pctOf(used.div(v.popCap).mul(100).toNumber()) : 0)
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
    // Track BOTH the store revision and the active-village selection: a tick OR a
    // village switch refreshes the switcher, the HUD and the active panel. Reading
    // activeVillageId here is what makes switching villages re-render the HUD + tab
    // without rebuilding the shell.
    void ctx.store.rev.value
    void ctx.activeVillageId.value
    rebuildVillageSwitch()
    updateVillageActive()
    updateHud()
    entries[activeIndex].panel.update()
  })

  return shell
}
