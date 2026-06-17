import { effect } from '../engine/store'
import { RESOURCE_IDS, type ResourceId, type VillageId, type Village, type GameState } from '../engine/state'
import type { Decimal } from '../engine/decimal'
import { formatNumber, formatInt, formatRate, formatTime } from '../engine/format'
import { usedPopulation } from '../systems/recruitment'
import { BUILDING_IDS } from '../content/buildings'
import { UNIT_IDS } from '../content/units'
import { tabVisible, TECH_AUTOMATION_NODE_IDS, DYNASTY_AUTOMATION_NODE_IDS } from './tab-visibility'
import type { UiCtx, Panel } from './types'
import { h, resourceIcon, shieldIcon, navIcon, chevronIcon, menuIcon, RESOURCE_NAMES } from './dom'
import { villageCrest } from './crest'

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

/**
 * Index of the always-visible 'buildings' tab — the softlock-safe fallback used
 * whenever a desired tab is hidden by progressive disclosure (M12.2). 'buildings'
 * is one of the two tabs {@link tabVisible} can never hide, so this index is always
 * a legal, visible selection. Degrades to 0 only if (impossibly) absent.
 */
function buildingsIndex(tabs: TabSpec[]): number {
  const i = tabs.findIndex((t) => t.id === 'buildings')
  return i >= 0 ? i : 0
}

/**
 * Read the persisted active-tab id, mapped to an index. Falls back to the
 * always-visible 'buildings' tab when there is no valid persisted id OR when the
 * persisted tab is currently HIDDEN by progressive disclosure (M12.2) — focus and
 * the opening panel must never land on a tab the player cannot see (no softlock).
 */
function restoreTabIndex(tabs: TabSpec[], state: GameState): number {
  const fallback = buildingsIndex(tabs)
  try {
    if (typeof localStorage !== 'undefined') {
      const saved = localStorage.getItem(TAB_STORAGE_KEY)
      if (saved) {
        const idx = tabs.findIndex((t) => t.id === saved)
        if (idx >= 0 && tabVisible(tabs[idx].id, state)) return idx
      }
    }
  } catch {
    /* private mode / blocked storage — fall through to the fallback tab */
  }
  return fallback
}

/** Persist the active-tab id (best-effort; storage may be unavailable). */
function persistTabId(id: string): void {
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(TAB_STORAGE_KEY, id)
  } catch {
    /* ignore */
  }
}

/** localStorage key remembering whether the desktop rail is collapsed (UI pref). */
const NAV_COLLAPSED_STORAGE_KEY = 'tw-incremental:nav-collapsed'

/**
 * Read the persisted desktop-rail collapse preference ('1' = collapsed). Best-effort,
 * same try/catch discipline as {@link restoreTabIndex}: this is a UI PREF (like the
 * active tab), never game state, so a blocked storage simply degrades to "expanded".
 */
function readNavCollapsed(): boolean {
  try {
    if (typeof localStorage !== 'undefined') {
      return localStorage.getItem(NAV_COLLAPSED_STORAGE_KEY) === '1'
    }
  } catch {
    /* private mode / blocked storage — fall through to expanded */
  }
  return false
}

/** Persist the desktop-rail collapse preference (best-effort; storage may be unavailable). */
function persistNavCollapsed(collapsed: boolean): void {
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(NAV_COLLAPSED_STORAGE_KEY, collapsed ? '1' : '0')
    }
  } catch {
    /* ignore */
  }
}

/** One sidebar group: a visible heading + the ordered tab ids it contains. */
interface NavGroup {
  label: string
  tabIds: string[]
}

/**
 * Sidebar grouping (M12.1). The rail walks these in order, rendering a decorative
 * heading then the group's tabs. This is purely PRESENTATION ordering — adding/
 * moving a tab is a data edit here; tabs not covered by any group fall into a
 * trailing "Inne" group so none is ever dropped (see the build loop). The active
 * tab is restored/persisted by ID, so regrouping needs no migration.
 */
const NAV_GROUPS: NavGroup[] = [
  { label: 'Osada', tabIds: ['buildings', 'villages', 'market', 'automation'] },
  { label: 'Wojna', tabIds: ['army', 'map', 'raids', 'events', 'reports'] },
  { label: 'Postęp', tabIds: ['tech', 'prestige', 'era', 'dynasty', 'challenges'] },
  { label: 'Archiwum', tabIds: ['achievements', 'codex', 'save'] },
]

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

/**
 * Alloc-free sum of building levels across the whole empire — mirrors tab-visibility's
 * sumBuildingLevels but iterates the FIXED {@link BUILDING_IDS} instead of Object.values,
 * so it allocates nothing on the hot per-frame coarse-signature path (M12.2 perf).
 */
function coarseBuildingSum(s: GameState): number {
  let total = 0
  for (const vid of s.villageOrder) {
    const v = s.villages[vid]
    if (!v) continue
    const b = v.buildings
    for (const bid of BUILDING_IDS) {
      const lvl = b[bid]
      if (typeof lvl === 'number' && lvl > 0) total += lvl
    }
  }
  return total
}

/** Alloc-free "does any owned village hold any unit" (iterates the fixed {@link UNIT_IDS}). */
function coarseAnyUnits(s: GameState): boolean {
  for (const vid of s.villageOrder) {
    const v = s.villages[vid]
    if (!v) continue
    const u = v.units
    for (const uid of UNIT_IDS) {
      const c = u[uid]
      if (typeof c === 'number' && c > 0) return true
    }
  }
  return false
}

/**
 * The CHEAP coarse signature for progressive disclosure (M12.2). A string of the
 * MONOTONIC scalars every {@link tabVisible} predicate reads — and NOTHING that needs a
 * meta-tree fold (`effectiveMods` + its ~6 TechModifiers bags), a Decimal pow (`foundCost`)
 * or the prestige/era score. recomputeVisibility() re-evaluates the real predicates only
 * when this string changes, so the per-frame path stays an O(villages·buildings) scan with
 * no bag allocation. It is strictly a SUPERSET trigger: any progression event that could
 * flip a predicate also moves one of these scalars — building purchases bump the building
 * sum; recruiting bumps anyUnits; battles/founding/scouting/trading bump the lifetime
 * stats; the meta layers bump their account counts; an automation un/re-lock bumps the raw
 * gateway node levels — so a reveal is never silently missed.
 */
function coarseVisibilitySig(s: GameState): string {
  const st = s.stats
  let sig =
    s.villageOrder.length +
    '|' +
    coarseBuildingSum(s) +
    '|' +
    (coarseAnyUnits(s) ? '1' : '0') +
    '|' +
    s.battleLog.length +
    '|' +
    s.prestige.ascensions +
    ',' +
    s.prestige.totalEarned +
    '|' +
    s.era.eras +
    '|' +
    s.dynasty.dynasties +
    '|' +
    (s.challenge.activeId ?? '') +
    ',' +
    Object.keys(s.challenge.completed).length +
    '|' +
    Object.keys(s.achievements).length +
    '|' +
    st.villagesFounded +
    ',' +
    st.attacksWon +
    ',' +
    st.attacksLost +
    ',' +
    st.raidsRepelled +
    ',' +
    st.raidsLost +
    ',' +
    st.hordesRepelled +
    ',' +
    st.hordesBreached +
    ',' +
    st.scoutsReturned +
    ',' +
    st.eventsResolved +
    '|' +
    (st.resourcesExchanged.gt(0) ? '1' : '0') +
    '|'
  // Raw automation-unlock node levels (the ONLY re-locking signal): tech gateways reset on
  // ascension, the dynasty gateway persists — read them directly, never via effectiveMods.
  for (const id of TECH_AUTOMATION_NODE_IDS) sig += (s.tech[id] ?? 0) + ','
  for (const id of DYNASTY_AUTOMATION_NODE_IDS) sig += (s.dynasty.nodes[id] ?? 0) + ','
  return sig
}

interface HudResRefs {
  chip: HTMLElement
  value: HTMLElement
  rate: HTMLElement
  capBar: HTMLElement
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
      // Mały herb obok nazwy jedynej wioski — czysta dekoracja (nazwę niesie już
      // tekst .village-current), więc aria-hidden, by nie dokładał „Herb wioski"
      // do odczytu czytnika ekranu (WCAG 1.1.1).
      if (only) {
        const crest = villageCrest(only)
        crest.setAttribute('aria-hidden', 'true')
        villageList.appendChild(crest)
      }
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
      // Mały herb wioski w pigułce. Dostępną nazwę radia niosą tekst (poniżej) +
      // atrybuty ARIA, więc herb jest aria-hidden — czysta dekoracja, by nie
      // dopisywał „Herb wioski" do dostępnej nazwy kontrolki (WCAG 1.1.1).
      const crest = villageCrest(id)
      crest.setAttribute('aria-hidden', 'true')
      btn.appendChild(crest)
      btn.appendChild(h('span', 'village-btn-name', s.villages[id].name))
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
    const body = h('div', 'hud-res-body')
    const txt = h('span', 'hud-res-text')
    const value = h('span', 'num hud-res-value')
    const rate = h('span', 'num muted hud-res-rate')
    txt.appendChild(value)
    txt.appendChild(rate)
    // Cienki pasek zapełnienia magazynu dla tego surowca (fill = surowiec / cap).
    // Barwa wypełnienia z is-wood/clay/iron (base.css); near-cap niesie też klasa
    // is-near-cap na chipie + role/aria — kolor nie jest jedynym sygnałem.
    const capBar = h('div', 'bar hud-res-bar is-' + id)
    capBar.setAttribute('role', 'progressbar')
    capBar.setAttribute('aria-valuemin', '0')
    capBar.setAttribute('aria-valuemax', '100')
    capBar.setAttribute('aria-label', 'Zapełnienie magazynu: ' + RESOURCE_NAMES[id])
    capBar.appendChild(h('i'))
    body.appendChild(txt)
    body.appendChild(capBar)
    chip.appendChild(iconWrap)
    chip.appendChild(body)
    resCluster.appendChild(chip)
    hudRes[id] = { chip, value, rate, capBar }
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

  // --hud-h reflects the REAL HUD height instead of a static guess (Fix 4/7). It
  // drives the sticky rail's `top`, the rail's max-height and the scroll-padding/
  // scroll-margin that keep keyboard-focused tabs/content out from behind the
  // banner (WCAG 2.2 SC 2.4.11). `.hud-inner` is flex-wrap, so on mid widths the
  // HUD wraps to ~2 rows and the 5.5rem token under-measures — pinning the rail
  // beneath the banner. Publish the measured height to :root so it cascades to
  // html's scroll-padding-top AND every descendant. Layout-driven only (no Date/
  // Math.random, no game state); the token stays as the static fallback. Guarded
  // for headless/jsdom where ResizeObserver is absent.
  if (typeof ResizeObserver !== 'undefined') {
    const hudResize = new ResizeObserver(() => {
      document.documentElement.style.setProperty('--hud-h', hud.offsetHeight + 'px')
    })
    hudResize.observe(hud)
  }

  // ---- HUD spend-flash (M12.5) ---------------------------------------------
  // Cel: gdy gracz WYDAJE surowiec (rozbudowa/rekrutacja/założenie/transport/giełda),
  // chip HUD danego surowca na chwilę „mrugnie" — koszt widać, jak schodzi z zapasu.
  //
  // Jak wykrywamy wydatek BEZ nowego okablowania: surowce rosną wyłącznie z produkcji
  // i są przycinane do capu (przycięcie nigdy nie schodzi PONIŻEJ bieżącej wartości).
  // Zatem SPADEK kwoty klatka-do-klatki = wydatek (lub ładunek opuszczający wioskę).
  // Porównujemy więc każdą wartość z jej wartością z poprzedniej klatki — bez
  // eventbusa, bez sygnału, bez stanu. Przy PRZEŁĄCZENIU wioski różnica to zmiana
  // kontekstu (inne zapasy), nie wydatek: wtedy przesiewamy bazę i NIE migamy.
  //
  // Klucz przesiewu to REFERENCJA obiektu wioski (nie jej id): reset w miejscu
  // (ascend/era/dynastia/wyzwanie/import) odbudowuje stolicę jako NOWY obiekt z tym
  // samym id 'v0', więc gdyby kluczem był string, spadek zapasów po resecie wziąłby
  // się za wydatek. Porównanie referencji łapie to jako zmianę kontekstu (nowy obiekt
  // → switched), a normalny tick mutuje TEN SAM obiekt w miejscu, więc realne wydatki
  // wciąż porównują się poprawnie. Przełączenie wioski (inny obiekt) też jest pokryte.
  let prevAmounts: Record<ResourceId, Decimal> | null = null
  let prevVillage: Village | null = null

  // Powrót do karty (visibilitychange → widoczna): main.ts robi wtedy applyOffline()
  // + jeden store.commit(), a symulacja offline (najazdy/horda/automatyzacja) może
  // zostawić surowiec NIŻEJ niż przy ukryciu karty — bez przełączenia wioski (ten sam
  // obiekt), więc reset z findingu 1 tego NIE łapie. Wymuszamy przesiew, zerując klucz:
  // ten listener jest rejestrowany z buildShell (mountApp) PRZED handlerem main.ts, więc
  // pada pierwszy — kolejny commit → updateHud widzi null → switched → przesiew bez błysku.
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) prevVillage = null
  })

  /** Odpal mignięcie „wydatku" na chipie surowca — retrigger-safe i samo-sprzątające. */
  const flashSpend = (chip: HTMLElement): void => {
    // Reduced-motion: motion.css ustawia `animation: none`, więc `animationend` nie
    // padnie i listener `once` nie zdjąłby klasy (zostałaby na stałe). Wczesny return
    // = zero klasy/listenera; nieruchomy chip pozostaje nieruchomy.
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return
    chip.classList.remove('hud-spend')
    void chip.offsetWidth // wymuszony reflow — restart @keyframes przy serii wydatków
    chip.classList.add('hud-spend')
    chip.addEventListener('animationend', () => chip.classList.remove('hud-spend'), { once: true })
  }

  /**
   * Refresh every HUD node from the ACTIVE village. Runs on EVERY store revision
   * AND on every village selection (the effect tracks both signals). Falls back to
   * the first village if the selection is momentarily stale (e.g. a just-removed
   * village before main.ts re-seeds the signal) so the HUD never reads `undefined`.
   */
  const updateHud = (): void => {
    const s = ctx.store.state
    // Wioska FAKTYCZNIE pokazywana: aktywny wybór albo pierwsza wioska, gdy wybór jest
    // chwilowo nieaktualny. Śledzimy jej REFERENCJĘ pod spend-flash, żeby PRZEŁĄCZENIE
    // wioski ORAZ reset w miejscu (nowy obiekt o tym samym id) nigdy nie zostały wzięte
    // za wydatek — tick mutuje ten sam obiekt, więc realne wydatki wciąż się łapią.
    const shownId: VillageId = s.villages[ctx.activeVillageId.value] ? ctx.activeVillageId.value : s.villageOrder[0]
    const v = s.villages[shownId]
    const cap = v.storageCap
    const switched = prevVillage !== v
    prevVillage = v
    if (prevAmounts === null) prevAmounts = {} as Record<ResourceId, Decimal>
    const prev = prevAmounts
    // Resource amounts + rates; track the fullest resource for the storage bar
    // (storage cap is per-resource, so the closest-to-capping resource is the
    // binding "how full is the magazyn" signal — when it caps, production wastes).
    let fullest = v.resources[RESOURCE_IDS[0]]
    for (const id of RESOURCE_IDS) {
      const r = hudRes[id]
      const cur = v.resources[id]
      // Spadek względem poprzedniej klatki = wydatek → mignij chipem. Pomijamy przy
      // przełączeniu wioski (to zmiana kontekstu, nie wydatek). Bez alokacji w pętli:
      // nadpisujemy współdzielony rekord referencją istniejącego Decimala stanu.
      if (!switched && cur.lt(prev[id])) flashSpend(r.chip)
      prev[id] = cur
      r.value.textContent = formatNumber(cur)
      r.rate.textContent = formatRate(v.production[id])
      if (cur.gt(fullest)) fullest = cur
      // Per-resource zapełnienie + ostrzeżenie near-cap (>= 90%) — gracz widzi
      // nadchodzące marnowanie produkcji zanim surowiec dobije do wspólnego capu.
      const pct = cap.gt(0) ? pctOf(cur.div(cap).mul(100).toNumber()) : 0
      setBar(r.capBar, pct)
      const nearCap = pct >= 90
      r.chip.classList.toggle('is-near-cap', nearCap)
      // aria-valuetext przy near-cap: czytnik ekranu ogłasza DYSKRETNY stan
      // „blisko limitu", a nie samą liczbę (uzupełnia wytłoczony znacznik progu,
      // który niesie ten próg wzrokowo). Poza progiem czyścimy, by nie został
      // nieaktualny — wtedy AT czyta z powrotem aria-valuenow.
      if (nearCap) r.capBar.setAttribute('aria-valuetext', Math.round(pct) + '% — blisko limitu')
      else r.capBar.removeAttribute('aria-valuetext')
    }

    storageStat.val.textContent = formatNumber(fullest) + ' / ' + formatNumber(cap)
    setBar(storageStat.bar, cap.gt(0) ? pctOf(fullest.div(cap).mul(100).toNumber()) : 0)

    const used = usedPopulation(v)
    popStat.val.textContent = formatInt(used) + ' / ' + formatInt(v.popCap)
    setBar(popStat.bar, v.popCap.gt(0) ? pctOf(used.div(v.popCap).mul(100).toNumber()) : 0)
  }

  // ---- b) Side navigation rail (vertical tablist) + c) content (tabpanels) --
  // The horizontal strip is replaced by a LEFT RAIL: a grouped, vertical tablist
  // collapsible to an icon-only rail on desktop, and a disclosure ("Menu") on
  // mobile. The tablist/tabpanel wiring, selectTab, the roving tabindex and the
  // keyboard nav are unchanged — only the chrome around them moved.
  const sideNav = h('nav', 'side-nav')
  sideNav.setAttribute('aria-label', 'Nawigacja sekcji')

  // Head row: mobile disclosure toggle (CSS-hidden on desktop) + desktop collapse
  // toggle (CSS-hidden on mobile). Both icons are decorative; their accessible
  // names come from text / aria-label below.
  const sideHead = h('div', 'side-nav-head')

  const menuToggle = h('button', 'side-menu-toggle')
  menuToggle.type = 'button'
  menuToggle.appendChild(menuIcon())
  menuToggle.appendChild(h('span', 'side-menu-text', 'Menu'))
  // Decorative context label: selectTab writes the active section name here so a
  // collapsed mobile disclosure still tells the user where they are.
  const menuCurrent = h('span', 'side-menu-current')
  menuToggle.appendChild(menuCurrent)
  menuToggle.setAttribute('aria-expanded', 'false')
  menuToggle.setAttribute('aria-controls', 'side-tabs')

  const sideCollapse = h('button', 'side-collapse')
  sideCollapse.type = 'button'
  // Widoczna etykieta + szewron: czyni z railowego nagłówka rozpoznawalną kontrolkę
  // (NN/Jakob: same ikony bez etykiety są słabo odkrywane). Etykietę chowa CSS w
  // stanie zwiniętym; dostępną nazwę i tak niesie aria-label (ustawiany niżej).
  sideCollapse.appendChild(h('span', 'side-collapse-text', 'Zwiń'))
  sideCollapse.appendChild(chevronIcon())

  sideHead.appendChild(menuToggle)
  sideHead.appendChild(sideCollapse)
  sideNav.appendChild(sideHead)

  // The vertical tablist itself (id is the disclosure's aria-controls target).
  const tablist = h('div', 'side-tabs')
  tablist.id = 'side-tabs'
  tablist.setAttribute('role', 'tablist')
  tablist.setAttribute('aria-orientation', 'vertical')
  tablist.setAttribute('aria-label', 'Sekcje gry')
  sideNav.appendChild(tablist)

  // main loses the `container` cap: it fills the remaining body-row width.
  const main = h('main', 'tabpanels')

  interface TabEntry {
    id: string
    tab: HTMLButtonElement
    panelWrap: HTMLElement
    panel: Panel
  }
  const entries: TabEntry[] = []

  // Group ordering: assign each spec to its NAV_GROUPS group (first match wins);
  // any spec NOT covered by a group falls into a trailing "Inne" group so no tab
  // is ever dropped. The flat `orderedTabs` is the canonical order — entries[],
  // the rail buttons and the panels all follow it, so visual order == arrow-key
  // order == panel pairing.
  const covered = new Set<string>()
  const renderGroups: { label: string; specs: TabSpec[] }[] = []
  for (const group of NAV_GROUPS) {
    const specs: TabSpec[] = []
    for (const id of group.tabIds) {
      const spec = tabs.find((t) => t.id === id)
      if (spec && !covered.has(spec.id)) {
        specs.push(spec)
        covered.add(spec.id)
      }
    }
    if (specs.length > 0) renderGroups.push({ label: group.label, specs })
  }
  const leftover = tabs.filter((t) => !covered.has(t.id))
  if (leftover.length > 0) renderGroups.push({ label: 'Inne', specs: leftover })
  const orderedTabs: TabSpec[] = renderGroups.flatMap((g) => g.specs)

  // Group-label elements paired with the tab ids they head — recomputeVisibility()
  // hides a heading when ALL its tabs are hidden, so the rail never shows an empty
  // "Wojna"/"Postęp" heading during early-game progressive disclosure (M12.2).
  const navGroupEls: { labelEl: HTMLElement; tabIds: string[] }[] = []

  let buildIndex = 0
  for (const group of renderGroups) {
    // Decorative group heading: aria-hidden + role=presentation removes it from the
    // a11y tree, so the tablist's exposed children are exactly the role=tab buttons.
    const groupLabel = h('div', 'side-group-label')
    groupLabel.setAttribute('aria-hidden', 'true')
    groupLabel.setAttribute('role', 'presentation')
    groupLabel.appendChild(h('span', 'side-group-text', group.label))
    tablist.appendChild(groupLabel)
    navGroupEls.push({ labelEl: groupLabel, tabIds: group.specs.map((sp) => sp.id) })

    for (const spec of group.specs) {
      const i = buildIndex++

      const tab = h('button', 'tab')
      tab.type = 'button'
      tab.id = 'tab-' + spec.id
      tab.setAttribute('role', 'tab')
      tab.setAttribute('aria-controls', 'panel-' + spec.id)
      tab.setAttribute('aria-selected', 'false')
      // Roving tabindex: only the active tab is in the Tab order; arrow keys move
      // focus within the tablist (set in selectTab).
      tab.tabIndex = -1
      // data-label feeds the collapsed-rail CSS tooltip AND the mobile context label.
      tab.dataset.label = spec.label
      // navIcon is decorative (aria-hidden); the span carries the accessible name.
      tab.appendChild(navIcon(spec.id))
      tab.appendChild(h('span', 'tab-label', spec.label))
      // A mouse/touch pick also collapses the mobile disclosure; keyboard arrows
      // (selectTab without closeMobileMenu) keep the list open for traversal.
      tab.addEventListener('click', () => {
        selectTab(i, true)
        closeMobileMenu()
      })
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
  }

  const buildingsIdx = buildingsIndex(orderedTabs)
  let activeIndex = restoreTabIndex(orderedTabs, state)

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
    // Wejście panelu: ponownie odpalamy animację wjazdu na świeżo odsłoniętym
    // panelu. Toggle klasy z wymuszonym reflowem restartuje @keyframes przy
    // KAŻDEJ zmianie zakładki (selectTab jest wołany wyłącznie na zdarzenia:
    // montaż, klik, klawiatura — nigdy per-frame). animationend sprząta klasę.
    const p = entries[index].panelWrap
    p.classList.remove('tabpanel-enter')
    void p.offsetWidth /* wymuszony reflow restartuje animację CSS */
    p.classList.add('tabpanel-enter')
    p.addEventListener('animationend', () => p.classList.remove('tabpanel-enter'), { once: true })
    if (moveFocus) entries[index].tab.focus()
    // Mobile context label (decorative): name the active section beside "Menu" so a
    // collapsed disclosure still shows where the player is. NOT a close trigger —
    // selectTab also runs on mount + keyboard nav, which must keep the list open.
    menuCurrent.textContent = entries[index].tab.dataset.label ?? ''
    persistTabId(entries[index].id)
    entries[index].panel.update()
  }

  // --- Progressive disclosure (M12.2): visibility helpers ------------------
  // Hidden tabs (entry.tab.hidden) are skipped by keyboard nav so focus never
  // lands on a tab the player cannot see. All four helpers operate over the
  // CURRENT hidden flags, so they stay correct as the rail grows mid-game.

  /** Next VISIBLE entry index from `from` in direction `dir`, wrapping over visible only. */
  const nextVisible = (from: number, dir: 1 | -1): number => {
    const n = entries.length
    if (n === 0) return from
    let i = from
    for (let step = 0; step < n; step++) {
      i = (i + dir + n) % n
      if (!entries[i].tab.hidden) return i
    }
    return from
  }

  /** First VISIBLE entry index (Home). Falls back to 0 if (impossibly) none is visible. */
  const firstVisible = (): number => {
    for (let i = 0; i < entries.length; i++) if (!entries[i].tab.hidden) return i
    return 0
  }

  /** Last VISIBLE entry index (End). Falls back to the last entry if none is visible. */
  const lastVisible = (): number => {
    for (let i = entries.length - 1; i >= 0; i--) if (!entries[i].tab.hidden) return i
    return entries.length - 1
  }

  // Keyboard navigation within the tablist (automatic activation): arrows wrap over
  // VISIBLE tabs only, Home/End jump to the first/last VISIBLE tab. Enter/Space need
  // no special handling — a focused tab is already selected, and the button's native
  // click covers them anyway.
  tablist.addEventListener('keydown', (e: KeyboardEvent) => {
    let next = -1
    switch (e.key) {
      case 'ArrowRight':
      case 'ArrowDown':
        next = nextVisible(activeIndex, 1)
        break
      case 'ArrowLeft':
      case 'ArrowUp':
        next = nextVisible(activeIndex, -1)
        break
      case 'Home':
        next = firstVisible()
        break
      case 'End':
        next = lastVisible()
        break
      default:
        return
    }
    e.preventDefault()
    selectTab(next, true)
  })

  // recomputeVisibility() reconciles each nav button's `hidden` flag (and each group
  // heading's) with tabVisible(). It runs every frame but is gated TWICE so the hot path
  // stays cheap and allocation-free:
  //   1. the cheap COARSE signature (monotonic scalars only — see coarseVisibilitySig)
  //      guards PREDICATE EVALUATION: bail before calling any tabVisible() unless a
  //      monotonic input some predicate reads has actually moved. This keeps the heavy
  //      tabVisible() work (effectiveMods / foundCost / prestigeScore) OFF the per-frame
  //      path — it fires only on a real progression event (or, for `automation`, a re-lock
  //      after an ascension).
  //   2. the FINE visibility signature (one char per tab) guards the DOM WRITES below — it
  //      changes only when a tab actually flips, so the DOM is touched rarely.
  // Panels/entries are never destroyed (the reports pulse needs the reports entry alive
  // while hidden); only the rail button is hidden.
  let coarseSig = ''
  let visibilitySig = ''
  const recomputeVisibility = (): void => {
    const st = ctx.store.state
    // (1) Coarse gate: skip the predicate fold entirely unless a relevant scalar moved.
    const coarse = coarseVisibilitySig(st)
    if (coarse === coarseSig) return
    coarseSig = coarse

    // (2) A coarse input moved → evaluate the real predicates; the fine sig gates the DOM.
    let sig = ''
    for (const en of entries) sig += tabVisible(en.id, st) ? '1' : '0'
    if (sig === visibilitySig) return
    visibilitySig = sig

    for (let i = 0; i < entries.length; i++) entries[i].tab.hidden = sig[i] === '0'
    // Hide a group heading when ALL its tabs are hidden (no empty headings early on).
    for (const g of navGroupEls) {
      let anyVisible = false
      for (let k = 0; k < g.tabIds.length; k++) {
        const idx = entries.findIndex((en) => en.id === g.tabIds[k])
        if (idx >= 0 && sig[idx] === '1') {
          anyVisible = true
          break
        }
      }
      g.labelEl.hidden = !anyVisible
    }
    // SOFTLOCK GUARD: if the active tab just became hidden, retreat to the
    // always-visible 'buildings' tab so the player is never stranded.
    if (entries[activeIndex] && entries[activeIndex].tab.hidden) {
      selectTab(buildingsIdx, false)
    }
  }

  // ---- Collapse (desktop icon-rail) + mobile disclosure (ephemeral) --------
  // Two independent UI prefs, NEITHER is game state. Collapse persists (like the
  // active tab); the mobile open state is ephemeral (always closed on load).
  let collapsed = readNavCollapsed()

  /**
   * Reflect the collapse state on the DOM. One STABLE a11y pattern (Fix 2): a
   * NEXT-ACTION accessible name ("Zwiń/Rozwiń nawigację") with NO aria-pressed —
   * a dynamic label + aria-pressed announced contradictory state ("Rozwiń …,
   * pressed"). The same string is mirrored to a native `title` so mouse users get
   * the hint too (Fix 5; with the visible "Zwiń" the name still contains it →
   * WCAG 2.5.3 holds). Each collapsed icon also gets a native `title` = its label
   * (Fix 3): the rail now scrolls (overflow-y:auto) so a CSS ::after tooltip would
   * be clipped — title renders outside the clip and survives.
   */
  const applyCollapseState = (): void => {
    sideNav.classList.toggle('is-collapsed', collapsed)
    const label = collapsed ? 'Rozwiń nawigację' : 'Zwiń nawigację'
    sideCollapse.setAttribute('aria-label', label)
    sideCollapse.title = label
    for (const en of entries) {
      if (collapsed) en.tab.title = en.tab.dataset.label ?? ''
      else en.tab.removeAttribute('title')
    }
  }
  applyCollapseState()

  const toggleCollapse = (): void => {
    collapsed = !collapsed
    applyCollapseState()
    persistNavCollapsed(collapsed)
  }
  sideCollapse.addEventListener('click', toggleCollapse)

  let menuOpen = false
  const openMobileMenu = (): void => {
    menuOpen = true
    sideNav.classList.add('is-open')
    menuToggle.setAttribute('aria-expanded', 'true')
    // Land keyboard focus inside the list (on the active tab).
    entries[activeIndex].tab.focus()
  }
  function closeMobileMenu(): void {
    if (!menuOpen) return
    menuOpen = false
    sideNav.classList.remove('is-open')
    menuToggle.setAttribute('aria-expanded', 'false')
    // Return focus to a stable element so it is never lost when the list hides.
    menuToggle.focus()
  }
  menuToggle.addEventListener('click', () => {
    if (menuOpen) closeMobileMenu()
    else openMobileMenu()
  })

  // Escape zamyka rozwiniętą listę (standardowe oczekiwanie dla disclosure/menu);
  // fokus wraca na menuToggle przez closeMobileMenu. Handler na sideNav, bo fokus
  // jest WEWNĄTRZ listy gdy otwarta; keydown tablisty ignoruje Escape, więc bez kolizji.
  sideNav.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key === 'Escape' && menuOpen) {
      e.preventDefault()
      closeMobileMenu()
    }
  })
  // Kliknięcie POZA railem także zamyka otwartą listę (strażnik menuOpen; toggle i
  // zakładki są wewnątrz sideNav, więc to odpala się tylko przy realnym kliknięciu obok).
  document.addEventListener('pointerdown', (e) => {
    if (menuOpen && !sideNav.contains(e.target as Node)) closeMobileMenu()
  })

  // ---- Body row: rail + content fill the row; footer follows below ---------
  const appBody = h('div', 'app-body')
  appBody.appendChild(sideNav)
  appBody.appendChild(main)
  shell.appendChild(appBody)

  // ---- d) Footer (version + offline credit) --------------------------------
  const footer = h('footer', 'app-footer container muted')
  footer.textContent =
    'wersja ' +
    ctx.version +
    (ctx.offlineSeconds > 0 ? ' • offline: ' + formatTime(ctx.offlineSeconds) : '')
  shell.appendChild(footer)

  // ---- Reactivity ----------------------------------------------------------
  // Apply progressive disclosure ONCE before the first paint so hidden tabs never
  // flash visible, then show the initial tab (also runs its first update) and
  // subscribe a single effect that refreshes the HUD + ONLY the active panel on
  // every revision. restoreTabIndex already kept activeIndex on a visible tab, so
  // this initial recompute never trips the softlock guard.
  recomputeVisibility()
  selectTab(activeIndex, false)
  // Puls "nowy raport": tani, O(1) cache ostatniego wpisu battleLog. battleLog to
  // ograniczone okno przesuwne (długość się nasyca), więc porównujemy TOŻSAMOŚĆ
  // ostatniego elementu — przy każdym nowym raporcie to świeży obiekt, więc
  // referencja zmienia się niezawodnie. Brak porównania długości, brak iteracji.
  let lastReportTop = ctx.store.state.battleLog.at(-1)
  const reportsEntry = entries.find((e) => e.id === 'reports')
  // Puls "nowa oferta" (M13): czasowo-ograniczona oferta wydarzenia (TTL krótki)
  // jest łatwa do przegapienia spoza panelu Wydarzenia, więc — wzorem pulsu raportów —
  // błyskamy przyciskiem, gdy pojawi się ŚWIEŻA oferta. Każdy spawn tworzy nowy obiekt
  // `events.active`, więc porównanie TOŻSAMOŚCI referencji wykrywa nową ofertę O(1),
  // bez iteracji; null gdy brak oferty (po odbiorze/wygaśnięciu) nie pulsuje.
  let lastEventActive = ctx.store.state.events.active
  const eventsEntry = entries.find((e) => e.id === 'events')
  effect(() => {
    // Track BOTH the store revision and the active-village selection: a tick OR a
    // village switch refreshes the switcher, the HUD and the active panel. Reading
    // activeVillageId here is what makes switching villages re-render the HUD + tab
    // without rebuilding the shell.
    void ctx.store.rev.value
    void ctx.activeVillageId.value
    // Tani compare per-frame: jeśli przybył nowy raport, a użytkownik jest na innej
    // zakładce niż Raporty, pulsujemy złotem przycisk Raporty (augmentuje wpis,
    // nie zastępuje go). Dodanie klasy tylko na rzadkim zdarzeniu wzrostu;
    // animationend usuwa klasę, więc .tab-pulse nigdy się nie kumuluje. Seria
    // raportów (horda / wiele wiosek) NIE restartuje trwającego pulsu — pomijamy
    // gdy klasa już wisi, więc strumień wyników daje jeden spokojny błysk, nie
    // stutter; kolejny puls dopiero po wygaśnięciu poprzedniego.
    const log = ctx.store.state.battleLog
    const top = log[log.length - 1]
    if (top !== undefined && top !== lastReportTop && reportsEntry && entries[activeIndex].id !== 'reports') {
      const t = reportsEntry.tab
      if (!t.classList.contains('tab-pulse')) {
        t.classList.add('tab-pulse')
        t.addEventListener('animationend', () => t.classList.remove('tab-pulse'), { once: true })
      }
    }
    lastReportTop = top
    // Ten sam tani wzorzec dla świeżej oferty wydarzenia: referencja `active` zmienia się
    // na nowy obiekt przy spawnie (null po odbiorze/wygaśnięciu), więc pulsujemy tylko przy
    // przejściu na nową ofertę i tylko gdy gracz jest na innej zakładce. animationend zdejmuje
    // klasę, więc puls się nie kumuluje. Przycisk ukryty (brak Wieży) i tak nie ma offerty.
    const ev = ctx.store.state.events
    if (
      ev.active !== null &&
      ev.active !== lastEventActive &&
      eventsEntry &&
      entries[activeIndex].id !== 'events'
    ) {
      const te = eventsEntry.tab
      if (!te.classList.contains('tab-pulse')) {
        te.classList.add('tab-pulse')
        te.addEventListener('animationend', () => te.classList.remove('tab-pulse'), { once: true })
      }
    }
    lastEventActive = ev.active
    // Reveal/relock tabs the instant their stage unlocks (cheap: a no-op unless the
    // coarse signature changed, so the heavy predicate fold stays off the per-frame path).
    // May retreat the active tab to 'buildings' via its softlock guard, so it runs BEFORE
    // the final active-panel update below.
    recomputeVisibility()
    rebuildVillageSwitch()
    updateVillageActive()
    updateHud()
    entries[activeIndex].panel.update()
  })

  return shell
}
