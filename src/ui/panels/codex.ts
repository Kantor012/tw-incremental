import type { UiCtx, Panel } from '../types'
import { h, resourceIcon, unitIcon, buildingIcon, RESOURCE_NAMES, collapsible } from '../dom'
import { formatNumber, formatRate } from '../../engine/format'
import { RESOURCE_IDS, type ResourceId, type AutomationKind } from '../../engine/state'
import { BUILDINGS, BUILDING_IDS, type BuildingEffect } from '../../content/buildings'
import { UNITS, UNIT_IDS, type UnitDef } from '../../content/units'
import { TECH_NODES, TECH_NODE_IDS, type TechCategory } from '../../content/tech'
import { PRESTIGE_NODES, PRESTIGE_NODE_IDS, type PrestigeCategory } from '../../content/prestige'
import { ACHIEVEMENTS, ACHIEVEMENT_IDS } from '../../content/achievements'
import { CODEX_MECHANICS } from '../../content/codex'

/**
 * "Kodeks" panel (M6.3) — a READ-ONLY, in-game encyclopaedia gathering every system
 * in one place so the player can understand the deep game.
 *
 * Eight collapsible sections built with the shared `collapsible()` primitive (a native
 * `<details>` fronted by an `<h3>` summary). Only the first (Surowce) is open by default;
 * the rest start collapsed to cut scrolling. Each is reachable from a focusable
 * table-of-contents nav at the top (a TOC link opens its section and scrolls to it):
 *  1. Surowce       — RESOURCE_IDS + RESOURCE_NAMES, each with its producing building
 *                     (derived from BUILDINGS, not hardcoded).
 *  2. Budynki       — every BUILDING_IDS entry: name, effect (read off the typed
 *                     BuildingEffect union), max level and description.
 *  3. Jednostki     — every UNIT_IDS entry: attack/defence/carry/speed/pop, the
 *                     required building and the recon/siege/conquest role (derived
 *                     from the unit's own data flags).
 *  4. Drzewo rozwoju— the TechCategory arms with PL labels and live node counts, plus
 *                     how the shared global resource pool works.
 *  5. Prestiż       — the PrestigeCategory branches with counts, plus how ascension/PP
 *                     work.
 *  6. Automatyzacja — the three idle routines and how to unlock + enable them.
 *  7. Osiągnięcia   — the achievement total and its categories.
 *  8. Mechaniki     — the authored CODEX_MECHANICS chapters/topics (combat, raids,
 *                     siege, scouting, …) rendered chapter (h4) → topic (h5) → prose.
 *
 * PURELY DERIVED: this panel owns NO balance numbers and NO gameplay logic. Every
 * figure is read straight from the content tables (BUILDINGS / UNITS / TECH_NODES /
 * PRESTIGE_NODES / ACHIEVEMENTS) or from the authored mechanics data (CODEX_MECHANICS),
 * so the encyclopaedia can never drift from the simulation. Adding a building/unit/tech
 * node/achievement makes it appear here automatically with no edit to this file.
 *
 * READ-ONLY: the panel reads no live state, dispatches no intent callbacks and mutates
 * nothing — its whole content is catalogue metadata, so {@link Panel.update} is a no-op
 * (the counts shown are catalogue SIZES, which never change at runtime). All markup is
 * built through {@link h} (createElement/textContent), never innerHTML with data.
 *
 * Accessibility: a heading chain (h2 from the shell → h3 sections → h4 items/chapters →
 * h5 topics), a focusable 44px nav, `<details>`/`<summary>` disclosures (keyboard- and
 * SR-friendly), aria-labelled regions, and no colour-only signalling.
 */

/** PL display name per tech arm. Mirrors panels/tech.ts CATEGORY_LABEL, which is a
 * private const there; duplicated here (display strings only, never balance data) so
 * the Codex stays read-only and never edits an existing panel. */
const TECH_CATEGORY_LABEL: Record<TechCategory, string> = {
  economy: 'Gospodarka',
  storage: 'Magazyny',
  settlement: 'Osadnictwo',
  military: 'Militaria',
  fortification: 'Fortyfikacje',
  logistics: 'Logistyka',
  plunder: 'Grabież',
  construction: 'Budownictwo',
  training: 'Szkolenie',
}

/** PL display name per prestige branch. Mirrors panels/prestige.ts CATEGORY_LABEL
 * (a private const there) for the same read-only reason as {@link TECH_CATEGORY_LABEL}. */
const PRESTIGE_CATEGORY_LABEL: Record<PrestigeCategory, string> = {
  might: 'Potęga',
  prosperity: 'Dobrobyt',
  dominion: 'Dominacja',
}

/** One idle automation routine for the catalogue blurb (display only — the behaviour
 * itself lives in systems/automation.ts; this mirrors panels/automation.ts SPECS). */
interface AutoRoutine {
  kind: AutomationKind
  title: string
  desc: string
}

/** The three routines in the order the tick runs them (build → recruit → attack). */
const AUTO_ROUTINES: readonly AutoRoutine[] = [
  {
    kind: 'build',
    title: 'Auto-budowa',
    desc:
      'Buduje najtańszy budynek, na który stać wioskę z jej lokalnych surowców. ' +
      'Pomija budynki na maksymalnym poziomie. Działa w każdej wiosce.',
  },
  {
    kind: 'recruit',
    title: 'Auto-rekrutacja',
    desc:
      'Utrzymuje wybraną jednostkę na zadanej liczebności — dokolejkowuje brakujące ' +
      'sztuki, gdy starcza surowców i populacji.',
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

/** A percentage label for a per-level fraction (0.05 -> "5%", 0.012 -> "1.2%"). */
function pct(frac: number): string {
  return formatNumber(frac * 100, 2) + '%'
}

/** Capitalise the first letter of a free-form (achievement) category id. */
function capitalize(s: string): string {
  return s.length > 0 ? s[0].toUpperCase() + s.slice(1) : s
}

/**
 * The building that PRODUCES `resource`, derived from BUILDINGS (the production effect
 * carrying this resource). Data-driven: a renamed/added producer is reflected here with
 * no edit. Returns `null` if no building produces it.
 */
function producerName(resource: ResourceId): string | null {
  for (const id of BUILDING_IDS) {
    const e = BUILDINGS[id].effect
    if (e.kind === 'production' && e.resource === resource) return BUILDINGS[id].name
  }
  return null
}

/** A human-readable PL sentence for a {@link BuildingEffect}, read off the typed union. */
function buildingEffectText(effect: BuildingEffect): string {
  switch (effect.kind) {
    case 'production':
      return (
        'Produkcja surowca: ' +
        RESOURCE_NAMES[effect.resource] +
        ' +' +
        formatRate(effect.perLevel) +
        ' na poziom.'
      )
    case 'storage':
      return 'Pojemność magazynu: +' + formatNumber(effect.perLevel, 0) + ' na poziom.'
    case 'population':
      return 'Limit populacji: +' + formatNumber(effect.perLevel, 0) + ' na poziom.'
    case 'cost_reduction':
      return 'Koszt budowy wszystkich budynków: −' + pct(effect.perLevel) + ' na poziom.'
    case 'recruit_speed':
      return 'Czas szkolenia jednostek: −' + pct(effect.perLevel) + ' na poziom.'
    case 'noble_unlock':
      return 'Odblokowuje szkolenie szlachcica i przejmowanie wiosek barbarzyńskich.'
    case 'defense_bonus':
      return 'Obrona wioski przed najazdami: +' + pct(effect.perLevel) + ' na poziom.'
    case 'merchant_capacity':
      return 'Ładowność kupców (transport między wioskami): +' + formatNumber(effect.perLevel, 0) + ' na poziom.'
    default: {
      const _exhaustive: never = effect
      return _exhaustive
    }
  }
}

/**
 * The special role of a unit (recon / siege / conquest), derived from its DATA flags
 * (`siege`, `attack`, `carry`, `requires`) — never a hardcoded id — or `null` for an
 * ordinary line unit (whose `desc` already explains it).
 */
function unitRole(def: UnitDef): string | null {
  if (def.siege === 'ram') {
    return 'Machina oblężnicza — w trakcie bitwy osłabia obronę atakowanego obozu.'
  }
  if (def.siege === 'catapult') {
    return 'Machina oblężnicza — po wygranym ataku trwale obniża poziom obozu.'
  }
  if (def.attack === 0) {
    return 'Zwiad — odkrywa obronę i łup obozu; nie walczy i nie bierze łupu.'
  }
  if (def.carry === 0 && def.requires === 'academy') {
    return 'Narzędzie podboju — wysłany z armią obniża lojalność wioski; gdy spadnie do zera, przejmujesz wioskę.'
  }
  return null
}

/** A definition-list of label/value rows (numeric values get the tabular `.num` font). */
function statList(rows: { label: string; value: string; num?: boolean }[]): HTMLElement {
  const dl = h('dl', 'codex-stats')
  for (const row of rows) {
    dl.appendChild(h('dt', 'muted', row.label))
    dl.appendChild(h('dd', row.num ? 'num' : undefined, row.value))
  }
  return dl
}

/** The 8 sections, in display order: anchor id + nav/heading label. */
const SECTIONS: readonly { id: string; label: string }[] = [
  { id: 'codex-resources', label: 'Surowce' },
  { id: 'codex-buildings', label: 'Budynki' },
  { id: 'codex-units', label: 'Jednostki' },
  { id: 'codex-tech', label: 'Drzewo rozwoju' },
  { id: 'codex-prestige', label: 'Prestiż' },
  { id: 'codex-automation', label: 'Automatyzacja' },
  { id: 'codex-achievements', label: 'Osiągnięcia' },
  { id: 'codex-mechanics', label: 'Mechaniki' },
]

/** A short muted intro paragraph for a section body. */
function intro(text: string): HTMLElement {
  return h('p', 'codex-intro muted', text)
}

/** A card with an h4 title (used by Surowce/Budynki/Jednostki). */
function card(title: string, leading?: SVGElement): HTMLElement {
  const li = h('li', 'card')
  const head = h('div', 'codex-card-head')
  if (leading) {
    const wrap = h('span', 'res-icon-wrap')
    wrap.appendChild(leading)
    head.appendChild(wrap)
  }
  head.appendChild(h('h4', undefined, title))
  li.appendChild(head)
  return li
}

// ---- Section builders -------------------------------------------------------

function buildResources(body: HTMLElement): void {
  body.appendChild(
    intro(
      'Trzy surowce bazowe napędzają całą grę: każdą rozbudowę budynków i każde ' +
        'szkolenie jednostek opłacasz właśnie nimi. Magazyn ogranicza ich zapas, a ' +
        'nadwyżka produkcji ponad limit przepada.',
    ),
  )
  const grid = h('ul', 'card-grid codex-grid')
  grid.setAttribute('role', 'list')
  for (const id of RESOURCE_IDS) {
    const li = card(RESOURCE_NAMES[id], resourceIcon(id))
    const producer = producerName(id)
    li.appendChild(
      h(
        'p',
        'codex-text muted',
        producer
          ? 'Surowiec bazowy. Pozyskiwany w budynku „' + producer + '".'
          : 'Surowiec bazowy.',
      ),
    )
    grid.appendChild(li)
  }
  body.appendChild(grid)
}

function buildBuildings(body: HTMLElement): void {
  body.appendChild(
    intro(
      'Budynki rozwijasz poziomami w obrębie wioski; każdy poziom kosztuje coraz ' +
        'więcej surowców. Niżej działanie i maksymalny poziom każdego z nich.',
    ),
  )
  const grid = h('ul', 'card-grid codex-grid')
  grid.setAttribute('role', 'list')
  for (const id of BUILDING_IDS) {
    const def = BUILDINGS[id]
    // Ikona budynku jako wiodący glif karty — identyczny idiom jak Surowce/Jednostki
    // (resourceIcon/unitIcon). Dekoracyjna podpórka skanowalności: nazwa w <h4> niesie
    // etykietę, a sama ikona ma własny aria-label z DANYCH (BUILDINGS[id].name) z svgIcon.
    const li = card(def.name, buildingIcon(id))
    li.appendChild(h('p', 'codex-text muted', def.desc))
    li.appendChild(h('p', 'codex-text', buildingEffectText(def.effect)))
    li.appendChild(
      statList([{ label: 'Maks. poziom', value: formatNumber(def.maxLevel, 0), num: true }]),
    )
    grid.appendChild(li)
  }
  body.appendChild(grid)
}

function buildUnits(body: HTMLElement): void {
  body.appendChild(
    intro(
      'Jednostki szkolisz w czasie rzeczywistym; każda zajmuje populację (Zagroda). ' +
        'Obrona zależy od typu atakującego — w tej grze wszyscy wrogowie to piechota, ' +
        'więc liczy się obrona przed piechotą.',
    ),
  )
  const grid = h('ul', 'card-grid codex-grid')
  grid.setAttribute('role', 'list')
  for (const id of UNIT_IDS) {
    const def = UNITS[id]
    const li = card(def.name, unitIcon(id))
    li.appendChild(h('p', 'codex-text muted', def.desc))
    li.appendChild(
      statList([
        { label: 'Atak', value: formatNumber(def.attack, 0), num: true },
        {
          label: 'Obrona',
          value:
            formatNumber(def.defInfantry, 0) +
            ' (piech.) / ' +
            formatNumber(def.defCavalry, 0) +
            ' (kaw.)',
          num: true,
        },
        { label: 'Ładunek', value: formatNumber(def.carry, 0), num: true },
        { label: 'Szybkość', value: formatNumber(def.speed, 0) + ' min/pole', num: true },
        { label: 'Populacja', value: formatNumber(def.pop, 0), num: true },
        { label: 'Wymaga', value: BUILDINGS[def.requires].name },
      ]),
    )
    const role = unitRole(def)
    if (role) {
      li.appendChild(h('p', 'codex-text', role))
    }
    grid.appendChild(li)
  }
  body.appendChild(grid)
}

/** Render a category roster (label + "N węzłów/osiągnięć") as an accessible list. */
function categoryList(rows: { label: string; count: number }[], unit: string): HTMLElement {
  const ul = h('ul', 'codex-cat-list')
  ul.setAttribute('role', 'list')
  for (const row of rows) {
    const li = h('li', 'codex-cat-row')
    li.appendChild(h('span', undefined, row.label))
    li.appendChild(h('span', 'num muted', formatNumber(row.count, 0) + ' ' + unit))
    ul.appendChild(li)
  }
  return ul
}

function buildTech(body: HTMLElement): void {
  body.appendChild(
    intro(
      'Drzewo „Rozwój" to globalna, kont-wide konstelacja perków w stylu Path of ' +
        'Exile. Węzły kupujesz ze WSPÓLNEJ puli surowców (sumowanej ze wszystkich ' +
        'wiosek), a ich bonusy działają na całe imperium. Każdy węzeł ma skończony ' +
        'maksymalny poziom; drzewo rośnie wszerz (nowe gałęzie i liście), nie w głąb.',
    ),
  )
  const counts = new Map<TechCategory, number>()
  for (const id of TECH_NODE_IDS) {
    const c = TECH_NODES[id].category
    counts.set(c, (counts.get(c) ?? 0) + 1)
  }
  const rows: { label: string; count: number }[] = []
  for (const cat of Object.keys(TECH_CATEGORY_LABEL) as TechCategory[]) {
    rows.push({ label: TECH_CATEGORY_LABEL[cat], count: counts.get(cat) ?? 0 })
  }
  body.appendChild(categoryList(rows, 'węzłów'))
  body.appendChild(
    intro('Łącznie ' + formatNumber(TECH_NODE_IDS.length, 0) + ' węzłów w drzewie rozwoju.'),
  )
}

function buildPrestige(body: HTMLElement): void {
  body.appendChild(
    intro(
      'Prestiż (ascensja) to warstwa „nowej gry plus". Resetujesz bieżący bieg — ' +
        'wioski wracają do jednej świeżej stolicy, świat jest regenerowany, a drzewo ' +
        'rozwoju wyczyszczone — w zamian za Punkty Prestiżu (PP). Za PP kupujesz ' +
        'TRWAŁE węzły z drzewa prestiżu, które przetrwają każdy reset i łączą się z ' +
        'bonusami z drzewa rozwoju.',
    ),
  )
  const counts = new Map<PrestigeCategory, number>()
  for (const id of PRESTIGE_NODE_IDS) {
    const c = PRESTIGE_NODES[id].category
    counts.set(c, (counts.get(c) ?? 0) + 1)
  }
  const rows: { label: string; count: number }[] = []
  for (const cat of Object.keys(PRESTIGE_CATEGORY_LABEL) as PrestigeCategory[]) {
    rows.push({ label: PRESTIGE_CATEGORY_LABEL[cat], count: counts.get(cat) ?? 0 })
  }
  body.appendChild(categoryList(rows, 'węzłów'))
  body.appendChild(
    intro(
      'Łącznie ' + formatNumber(PRESTIGE_NODE_IDS.length, 0) + ' węzłów w drzewie prestiżu.',
    ),
  )
}

function buildAutomation(body: HTMLElement): void {
  body.appendChild(
    intro(
      'Automatyzacje wyręczają Cię w rutynie. Każdą rutynę najpierw ODBLOKUJ w ' +
        'drzewie „Rozwój" (węzeł-brama odblokowujący automatyzację), a potem WŁĄCZ ' +
        'przełącznikiem w zakładce „Automatyzacja". Domyślnie są wyłączone — bez nich ' +
        'gra przebiega dokładnie tak jak dotąd.',
    ),
  )
  const grid = h('ul', 'card-grid codex-grid')
  grid.setAttribute('role', 'list')
  for (const routine of AUTO_ROUTINES) {
    const li = card(routine.title)
    li.appendChild(h('p', 'codex-text muted', routine.desc))
    grid.appendChild(li)
  }
  body.appendChild(grid)
}

function buildAchievements(body: HTMLElement): void {
  body.appendChild(
    intro(
      'Osiągnięcia to TRWAŁE wyróżnienia za kamienie milowe Twojej kariery — ' +
        'odblokowują się automatycznie po spełnieniu warunku i przetrwają każdą ' +
        'ascensję. Są czysto honorowe: nie dają żadnych bonusów do rozgrywki.',
    ),
  )
  // First-seen category order over the stable id list (mirrors the achievements panel).
  const rows: { label: string; count: number }[] = []
  const index = new Map<string, number>()
  for (const id of ACHIEVEMENT_IDS) {
    const cat = ACHIEVEMENTS[id].category
    let i = index.get(cat)
    if (i === undefined) {
      i = rows.length
      index.set(cat, i)
      rows.push({ label: capitalize(cat), count: 0 })
    }
    rows[i].count++
  }
  body.appendChild(categoryList(rows, 'osiągnięć'))
  body.appendChild(
    intro('Łącznie ' + formatNumber(ACHIEVEMENT_IDS.length, 0) + ' osiągnięć do zdobycia.'),
  )
}

function buildMechanics(body: HTMLElement): void {
  body.appendChild(
    intro(
      'Jak naprawdę działają systemy gry — walka, najazdy, oblężenie i zwiad. ' +
        'Wartości są zgodne z kodem symulacji.',
    ),
  )
  for (const chapter of CODEX_MECHANICS) {
    const chapterEl = h('section', 'codex-chapter')
    chapterEl.setAttribute('aria-labelledby', 'codex-ch-' + chapter.id)
    const chHead = h('h4', 'codex-chapter-title', chapter.title)
    chHead.id = 'codex-ch-' + chapter.id
    chapterEl.appendChild(chHead)
    for (const topic of chapter.topics) {
      const topHead = h('h5', 'codex-topic-title', topic.title)
      topHead.id = 'codex-tp-' + topic.id
      chapterEl.appendChild(topHead)
      for (const para of topic.body) {
        chapterEl.appendChild(h('p', 'codex-para', para))
      }
    }
    body.appendChild(chapterEl)
  }
}

/** Body builder per section id — keeps {@link SECTIONS} the single source of order/labels
 * while each section's content stays in its own builder. */
const SECTION_BUILDERS: Record<string, (body: HTMLElement) => void> = {
  'codex-resources': buildResources,
  'codex-buildings': buildBuildings,
  'codex-units': buildUnits,
  'codex-tech': buildTech,
  'codex-prestige': buildPrestige,
  'codex-automation': buildAutomation,
  'codex-achievements': buildAchievements,
  'codex-mechanics': buildMechanics,
}

/**
 * Build the "Kodeks" panel. The `ctx` is intentionally unused: the codex is a fully
 * STATIC, read-only catalogue, so it neither reads live state nor wires any callback.
 */
export function createCodexPanel(_ctx: UiCtx): Panel {
  const el = h('div', 'codex-panel')

  // ---- Intro note ----------------------------------------------------------
  const note = h(
    'p',
    'codex-note',
    'Kodeks to encyklopedia gry — wyłącznie do odczytu. Zbiera w jednym miejscu ' +
      'całą treść (surowce, budynki, jednostki, drzewa, osiągnięcia) i wyjaśnia ' +
      'mechaniki, byś rozumiał głęboki system. Nic tu nie zmieniasz.',
  )
  note.setAttribute('role', 'note')
  el.appendChild(note)

  // id -> <details>, by linki spisu treści mogły rozwinąć i przewinąć daną sekcję.
  const sectionRoots = new Map<string, HTMLDetailsElement>()

  // ---- Table-of-contents nav (focusable, 44px targets) ---------------------
  const nav = h('nav', 'codex-nav')
  nav.setAttribute('aria-label', 'Spis treści kodeksu')
  for (const section of SECTIONS) {
    const link = h('a', 'btn btn-ghost', section.label)
    link.setAttribute('href', '#' + section.id)
    // Klik w spis treści: ROZWIŃ docelową sekcję (gdy zwinięta) i przewiń do niej.
    link.addEventListener('click', (ev) => {
      const root = sectionRoots.get(section.id)
      if (!root) return
      ev.preventDefault()
      root.open = true
      root.scrollIntoView()
    })
    nav.appendChild(link)
  }
  el.appendChild(nav)

  // ---- Sections ------------------------------------------------------------
  // Współdzielony collapsible(): nagłówek h3 + szewron, klawiatura/ARIA za darmo.
  // Domyślnie OTWARTA jest tylko pierwsza sekcja (Surowce); reszta zwinięta, by
  // skrócić przewijanie. scroll-margin-top trzyma kotwicę poniżej lepkiego HUD-a.
  SECTIONS.forEach((section, i) => {
    const { root, body } = collapsible(section.label, { open: i === 0, headingLevel: 3 })
    root.id = section.id
    root.style.scrollMarginTop = 'var(--hud-h)'
    SECTION_BUILDERS[section.id](body)
    el.appendChild(root)
    sectionRoots.set(section.id, root)
  })

  // Content is fully static catalogue metadata — nothing to refresh per frame.
  const update = (): void => {}

  return { el, update }
}
