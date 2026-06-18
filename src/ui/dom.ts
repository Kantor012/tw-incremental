import type { ResourceId, AutomationKind } from '../engine/state'
import { UNITS, type UnitId } from '../content/units'
import { BUILDINGS, type BuildingId } from '../content/buildings'

/**
 * Shared DOM + procedural-SVG helpers for the whole UI layer.
 *
 * Every panel and the dashboard shell build their markup through these helpers
 * (createElement / textContent / createElementNS — NEVER innerHTML with data),
 * so the hard rules "zero external assets" and "no innerHTML with data" hold in
 * one small, audited place instead of being re-proven in every panel.
 *
 * This module is the foundation of the panel contract: a panel imports `h` for
 * elements, `unitIcon`/`resourceIcon` for glyphs and `RESOURCE_NAMES` for the
 * Polish labels — and nothing else is needed to render data-driven content.
 */

export const SVG_NS = 'http://www.w3.org/2000/svg'

/**
 * Polish display names per resource id. Keyed by ResourceId (not `string`) so
 * adding a 4th resource to RESOURCE_IDS is a COMPILE error here until its name is
 * supplied — never a silent runtime `undefined` label. Mirrors the exhaustive
 * discipline of {@link resourceIcon} / {@link unitIcon}.
 */
export const RESOURCE_NAMES: Record<ResourceId, string> = {
  wood: 'Drewno',
  clay: 'Glina',
  iron: 'Żelazo',
}

/** Create an HTML element with optional class and text content. */
export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

/** Create an SVG element and apply a flat attribute map. */
export function svg(tag: string, attrs: Record<string, string>): SVGElement {
  const node = document.createElementNS(SVG_NS, tag)
  for (const key in attrs) node.setAttribute(key, attrs[key])
  return node
}

/** Wrap procedural SVG children into a labelled, decorative-safe icon. */
export function svgIcon(
  viewBox: string,
  label: string,
  className: string,
  children: SVGElement[],
): SVGSVGElement {
  const root = document.createElementNS(SVG_NS, 'svg') as SVGSVGElement
  root.setAttribute('viewBox', viewBox)
  root.setAttribute('class', className)
  root.setAttribute('role', 'img')
  root.setAttribute('aria-label', label)
  root.setAttribute('focusable', 'false')
  for (const child of children) root.appendChild(child)
  return root
}

/**
 * Dekoracyjny glif pustego stanu — spokojny, obrysowany proporczyk heraldyczny na
 * drzewcu. Rysowany SUROWYM {@link svg} (nie {@link svgIcon}), bo svgIcon wymusza
 * role=img + aria-label, a ten glif jest CZYSTĄ dekoracją: nadajemy mu aria-hidden,
 * a komunikat niosą realne teksty obok (zasada dostępności — treści nie trzyma sam
 * obrazek). Malowany w `currentColor`, więc token `.empty-state-glyph` go barwi i
 * przygasza zgodnie z motywem — zero zewnętrznych assetów (twarda zasada #2).
 */
function emptyStateGlyph(): SVGSVGElement {
  const root = document.createElementNS(SVG_NS, 'svg') as SVGSVGElement
  root.setAttribute('viewBox', '0 0 24 24')
  root.setAttribute('class', 'empty-state-glyph')
  root.setAttribute('aria-hidden', 'true')
  root.setAttribute('focusable', 'false')
  // Drzewce: pionowa linia w currentColor (obrys, nie wypełnienie).
  const pole = svg('path', {
    d: 'M7 3 V21',
    fill: 'none',
    stroke: 'currentColor',
    'stroke-width': '1.6',
    'stroke-linecap': 'round',
  })
  // Proporczyk z rozwidlonym ogonem (jaskółczy) — wyłącznie obrys, by czytał się
  // lekko i „spokojnie", a nie jak pełna, ciężka chorągiew.
  const pennant = svg('path', {
    d: 'M7 4 L19 6.5 L14 8.5 L19 10.5 L7 13 Z',
    fill: 'none',
    stroke: 'currentColor',
    'stroke-width': '1.6',
    'stroke-linejoin': 'round',
    'stroke-linecap': 'round',
  })
  // Gałka na szczycie drzewca — drobny detal heraldyczny.
  const finial = svg('circle', { cx: '7', cy: '3', r: '1.1', fill: 'currentColor' })
  root.appendChild(pole)
  root.appendChild(pennant)
  root.appendChild(finial)
  return root
}

/**
 * Wielokrotnego użytku komponent PUSTEGO STANU — drobny proceduralny glif + nagłówek
 * i opcjonalna podpowiedź, wyśrodkowane z komfortowym oddechem w pustym obszarze.
 * Dzięki temu pusta sekcja/lista wygląda CELOWO i spokojnie, a nie jak niedokończony,
 * urwany jednolinijkowiec w lewym górnym rogu.
 *
 * - `heading` to REALNY tekst komunikatu (czyta go technologia asystująca); glif jest
 *   tylko dekoracją (aria-hidden), więc treść nigdy nie spoczywa na samym obrazku.
 * - `hint` (opcjonalny) to drugorzędna podpowiedź pod nagłówkiem.
 * - `tag` pozwala wyrenderować host jako `<li>` (jedyny wiersz `<ul>/<ol>` — zasada #7),
 *   `<div>` albo `<p>` dla wywołań blokowych, by DOM pozostał poprawny.
 *
 * Helper NIE dodaje role/aria-live — wywołania potrzebujące „live region" (bramki
 * Rynku) opakowują ten blok we własny host role=status i zostawiają go sobie.
 */
export function emptyState(
  heading: string,
  hint?: string,
  tag: 'li' | 'div' | 'p' = 'div',
): HTMLElement {
  const host = h(tag, 'empty-state')
  host.appendChild(emptyStateGlyph())
  // Nagłówek to <span> (blok przez CSS), nie <p>/<div> — dzięki temu host może być
  // <li>, <div> ALBO <p> i pozostać poprawnym HTML (zasada #7).
  host.appendChild(h('span', 'empty-state-heading', heading))
  if (hint !== undefined) host.appendChild(h('span', 'empty-state-hint', hint))
  return host
}

/**
 * Procedural heraldic shield for the dashboard brand and the player villages on the
 * map. Painted entirely from `currentColor` (+ token-derived shades), never hardcoded
 * hex: the caller sets `color` via a token (`.hud-brand-mark .shield` and
 * `.map-node--player` both resolve it to `var(--accent)`), so the shield follows any
 * palette change and the project's "zero hardcoded colours" rule holds.
 *
 * The darker passages (the shaded left half, the chief band, the central boss) are
 * derived with `color-mix` against `var(--bg)`; these must be set via the `style`
 * property, not as presentation attributes, because SVG attributes don't accept the
 * `color-mix()` / `var()` CSS grammar — inline style does.
 */
export function shieldIcon(): SVGSVGElement {
  // Main face: inherits the accent token through currentColor (valid in SVG attrs).
  const face = svg('path', {
    d: 'M24 3 7 9v13c0 11 8 17 17 21 9-4 17-10 17-21V9z',
    fill: 'currentColor',
  })
  // Shaded left half: same hue pushed toward the background token.
  const shade = svg('path', { d: 'M24 3 7 9v13c0 11 8 17 17 21V3z' })
  shade.style.fill = 'color-mix(in srgb, currentColor 72%, var(--bg))'
  // Chief band + central boss: dark heraldic detail over the face (token + opacity).
  const band = svg('path', { d: 'M7 19h34v5H7z', 'fill-opacity': '0.22' })
  band.style.fill = 'var(--bg)'
  const boss = svg('path', { d: 'M24 13l7 6-7 6-7-6z', 'fill-opacity': '0.55' })
  boss.style.fill = 'color-mix(in srgb, currentColor 32%, var(--bg))'
  return svgIcon('0 0 48 48', 'Tarcza plemienna', 'shield', [face, shade, band, boss])
}

/**
 * Procedural resource icon (wood log / clay brick / iron ingot).
 *
 * EXHAUSTIVE over ResourceId on purpose (mirrors {@link unitIcon}): adding a
 * resource to RESOURCE_IDS without an icon branch here is a COMPILE error (the
 * `never` assignment in `default`), not a silent fallback to the iron glyph. This
 * keeps the data-driven contract — "adding a resource is a data edit" — honest for
 * the UI: the new resource must be given an explicit icon + name, never mislabelled.
 */
export function resourceIcon(id: ResourceId): SVGSVGElement {
  switch (id) {
    case 'wood': {
      const body = svg('rect', { x: '5', y: '8', width: '15', height: '8', rx: '4', fill: '#8a5a2b' })
      const endFace = svg('ellipse', { cx: '5', cy: '12', rx: '2', ry: '4', fill: '#a96f3a' })
      const ring = svg('ellipse', {
        cx: '5',
        cy: '12',
        rx: '1',
        ry: '2',
        fill: 'none',
        stroke: '#6b431d',
        'stroke-width': '0.8',
      })
      return svgIcon('0 0 24 24', RESOURCE_NAMES[id], 'res-icon', [body, endFace, ring])
    }
    case 'clay': {
      const block = svg('rect', { x: '3', y: '7', width: '18', height: '10', rx: '1.5', fill: '#c1663b' })
      const groove = (d: string): SVGElement =>
        svg('path', { d, stroke: '#7e3d22', 'stroke-width': '1', fill: 'none' })
      return svgIcon('0 0 24 24', RESOURCE_NAMES[id], 'res-icon', [
        block,
        groove('M3 12h18'),
        groove('M12 7v5'),
        groove('M8 12v5'),
        groove('M16 12v5'),
      ])
    }
    case 'iron': {
      const body = svg('path', { d: 'M5 16 19 16 17 9 7 9Z', fill: '#9aa3ad' })
      const top = svg('path', { d: 'M7 9 17 9 15.5 7 8.5 7Z', fill: '#c6cdd5' })
      const shine = svg('path', { d: 'M8 14 16 14', stroke: '#6b7682', 'stroke-width': '1', fill: 'none' })
      return svgIcon('0 0 24 24', RESOURCE_NAMES[id], 'res-icon', [body, top, shine])
    }
    default: {
      const _exhaustive: never = id
      throw new Error('Brak ikony dla surowca: ' + String(_exhaustive))
    }
  }
}

/**
 * Procedural unit icon (spear / sword / axe), drawn entirely in SVG.
 *
 * EXHAUSTIVE over UnitId on purpose: adding a unit to units.ts without an icon
 * branch here is a COMPILE error (the `never` assignment in `default`), not a
 * silent fallback to the axe glyph. This keeps the units.ts contract — "adding a
 * unit is a data edit, never an engine edit" — honest for the UI layer too: the
 * new unit must be given an explicit icon decision rather than mislabelled.
 */
export function unitIcon(id: UnitId): SVGSVGElement {
  switch (id) {
    case 'spearman': {
      const shaft = svg('rect', { x: '11', y: '4', width: '2', height: '17', fill: '#8a5a2b' })
      const head = svg('path', { d: 'M12 1 15 7 9 7Z', fill: '#c6cdd5' })
      return svgIcon('0 0 24 24', UNITS[id].name, 'unit-icon', [shaft, head])
    }
    case 'swordsman': {
      const blade = svg('path', { d: 'M11 2 13 2 13 16 12 18 11 16Z', fill: '#c6cdd5' })
      const guard = svg('rect', { x: '8', y: '15', width: '8', height: '2', rx: '0.5', fill: '#d9a441' })
      const hilt = svg('rect', { x: '11', y: '17', width: '2', height: '5', rx: '0.8', fill: '#8a5a2b' })
      return svgIcon('0 0 24 24', UNITS[id].name, 'unit-icon', [blade, guard, hilt])
    }
    case 'axeman': {
      const handle = svg('rect', { x: '11', y: '3', width: '2', height: '18', fill: '#8a5a2b' })
      const head = svg('path', { d: 'M13 4 20 6 20 11 13 12Z', fill: '#9aa3ad' })
      const edge = svg('path', { d: 'M20 6 20 11', stroke: '#c6cdd5', 'stroke-width': '1', fill: 'none' })
      return svgIcon('0 0 24 24', UNITS[id].name, 'unit-icon', [handle, head, edge])
    }
    case 'noble': {
      // The Szlachcic is a conquest tool, not a soldier — a crown reads as authority
      // (taking a village) rather than combat. Gold body + band, a single jewel.
      const body = svg('path', { d: 'M4 8 8 12 12 5 16 12 20 8 19 17 5 17Z', fill: '#e3b755' })
      const band = svg('rect', { x: '5', y: '17', width: '14', height: '3', rx: '0.5', fill: '#d9a441' })
      const gem = svg('circle', { cx: '12', cy: '13', r: '1.3', fill: '#c1663b' })
      return svgIcon('0 0 24 24', UNITS[id].name, 'unit-icon', [body, band, gem])
    }
    case 'scout': {
      // The Zwiadowca gathers information, never fights — an eye reads as
      // "reveals" (the camp's defence/loot) rather than combat.
      const eye = svg('path', { d: 'M2 12 C6 6 18 6 22 12 C18 18 6 18 2 12 Z', fill: 'none', stroke: '#c6cdd5', 'stroke-width': '1.6' })
      const iris = svg('circle', { cx: '12', cy: '12', r: '3.4', fill: '#4a90c2' })
      const pupil = svg('circle', { cx: '12', cy: '12', r: '1.5', fill: '#16202b' })
      return svgIcon('0 0 24 24', UNITS[id].name, 'unit-icon', [eye, iris, pupil])
    }
    case 'ram': {
      // The Taran is a siege engine, not a soldier — a suspended timber beam with an
      // iron head reads as "batters the wall" (lowers the camp's defence) not combat.
      const frameL = svg('path', { d: 'M8 5 6 20', stroke: '#6b431d', 'stroke-width': '1.6', fill: 'none' })
      const frameR = svg('path', { d: 'M16 5 18 20', stroke: '#6b431d', 'stroke-width': '1.6', fill: 'none' })
      const top = svg('path', { d: 'M7 5 17 5', stroke: '#6b431d', 'stroke-width': '1.6', fill: 'none' })
      const beam = svg('rect', { x: '5', y: '11', width: '13', height: '3', rx: '1', fill: '#8a5a2b' })
      const head = svg('path', { d: 'M2 12.5 5 10 5 15Z', fill: '#9aa3ad' })
      const cap = svg('rect', { x: '5', y: '10.5', width: '2', height: '4', fill: '#c6cdd5' })
      return svgIcon('0 0 24 24', UNITS[id].name, 'unit-icon', [frameL, frameR, top, beam, head, cap])
    }
    case 'catapult': {
      // The Katapulta razes a camp on a won attack (lowers its level) — a throwing
      // arm over a wheeled base reads as "siege artillery", distinct from line troops.
      const base = svg('path', { d: 'M4 17 20 17 18 20 6 20Z', fill: '#8a5a2b' })
      const wheelL = svg('circle', { cx: '8', cy: '20', r: '1.8', fill: '#6b431d' })
      const wheelR = svg('circle', { cx: '16', cy: '20', r: '1.8', fill: '#6b431d' })
      const arm = svg('path', { d: 'M6 17 18 6', stroke: '#8a5a2b', 'stroke-width': '2', fill: 'none' })
      const bucket = svg('circle', { cx: '18', cy: '6', r: '2.4', fill: '#9aa3ad' })
      const stone = svg('circle', { cx: '18', cy: '6', r: '1.2', fill: '#6b7682' })
      return svgIcon('0 0 24 24', UNITS[id].name, 'unit-icon', [base, wheelL, wheelR, arm, bucket, stone])
    }
    case 'light_cavalry': {
      // The Lekka kawaleria is the fast high-carry raider (M10) — a galloping horse
      // head reads as "mounted speed/loot" and sets the cavalry apart from the
      // infantry's weapon glyphs. Light tone, a flowing mane to signal pace.
      const head = svg('path', { d: 'M6 20 7 12 10 8 14 7 17 4 18 6 16 9 19 11 18 15 14 13 12 16 13 20Z', fill: '#b98b54' })
      const mane = svg('path', { d: 'M14 7 10 8 9 12', stroke: '#7e5a30', 'stroke-width': '1.4', fill: 'none' })
      const eye = svg('circle', { cx: '15.5', cy: '7.5', r: '0.9', fill: '#16202b' })
      return svgIcon('0 0 24 24', UNITS[id].name, 'unit-icon', [head, mane, eye])
    }
    case 'heavy_cavalry': {
      // The Ciężka kawaleria is the armoured mounted hammer (M10) — the same horse
      // head as the light cavalry but barded with iron plate (steel tones) to read as
      // "heavy charge", the offensive counterpart to its lighter sibling.
      const head = svg('path', { d: 'M6 20 7 12 10 8 14 7 17 4 18 6 16 9 19 11 18 15 14 13 12 16 13 20Z', fill: '#9aa3ad' })
      const plate = svg('path', { d: 'M10 8 14 7 16 9 13 12Z', fill: '#c6cdd5' })
      const eye = svg('circle', { cx: '15.5', cy: '7.5', r: '0.9', fill: '#16202b' })
      return svgIcon('0 0 24 24', UNITS[id].name, 'unit-icon', [head, plate, eye])
    }
    default: {
      const _exhaustive: never = id
      throw new Error('Brak ikony dla jednostki: ' + String(_exhaustive))
    }
  }
}

/**
 * Proceduralna ikona budynku (keep / piła / cegły / kowadło ...), rysowana wyłącznie
 * w SVG — bez żadnego zewnętrznego assetu (twarda zasada #2).
 *
 * EXHAUSTIVE po BuildingId — dokładnie jak {@link unitIcon} / {@link resourceIcon}:
 * dodanie budynku do BUILDING_IDS (buildings.ts) BEZ gałęzi z ikoną tutaj jest
 * BŁĘDEM KOMPILACJI (przypisanie do `never` w `default`), a nie cichym fallbackiem
 * na np. Ratusz. To utrzymuje kontrakt data-driven z buildings.ts — „dodanie budynku
 * to edycja danych, nie silnika" — uczciwym także w warstwie UI: nowy budynek musi
 * dostać świadomą decyzję ikonograficzną, a nie zostać błędnie oznaczony cudzą ikoną.
 *
 * aria-label bierzemy z DANYCH (BUILDINGS[id].name, polska nazwa wyświetlana), więc
 * etykieta dostępności podąża za jednym źródłem prawdy — nigdy nie dublujemy stringa.
 * Każda ikona jest „silhouette-first" (czytelny zarys przy ~20-28px) i wizualnie
 * ODRÓŻNIALNA od pozostałych; kolory inline są dobrane do palety reszty ikon.
 */
export function buildingIcon(id: BuildingId): SVGSVGElement {
  switch (id) {
    case 'hq': {
      // Ratusz = władza: kamienny donżon z blankami i wywieszoną chorągwią. Wąska,
      // wysoka bryła z flagą odróżnia go od szerokiego Muru (oba mają blanki).
      const body = svg('rect', { x: '7', y: '9', width: '10', height: '11', fill: '#9aa3ad' })
      const merlon = (x: string): SVGElement =>
        svg('rect', { x, y: '6', width: '2.4', height: '3.5', fill: '#9aa3ad' })
      const door = svg('rect', { x: '10', y: '14', width: '4', height: '6', rx: '0.5', fill: '#6b7682' })
      const winL = svg('rect', { x: '8.4', y: '11', width: '1.6', height: '1.6', fill: '#6b7682' })
      const winR = svg('rect', { x: '14', y: '11', width: '1.6', height: '1.6', fill: '#6b7682' })
      const pole = svg('rect', { x: '11.7', y: '1', width: '0.6', height: '5', fill: '#6b431d' })
      const pennant = svg('path', { d: 'M12 1 17 2.5 12 4Z', fill: '#d9a441' })
      return svgIcon('0 0 24 24', BUILDINGS[id].name, 'building-icon', [
        body,
        merlon('7'),
        merlon('10.8'),
        merlon('14.6'),
        winL,
        winR,
        door,
        pole,
        pennant,
      ])
    }
    case 'sawmill': {
      // Tartak = kłoda + piła: tarcza tnąca (gwiaździsty wielokąt zębów stali) nad
      // leżącą kłodą z czołem słoja. Kolczasty zarys piły jest jednoznaczny.
      const blade = svg('path', {
        d: 'M21 10 19.44 11.84 19.24 14.24 16.84 14.43 15 16 13.16 14.43 10.76 14.24 10.56 11.84 9 10 10.56 8.16 10.76 5.76 13.16 5.57 15 4 16.84 5.57 19.24 5.76 19.44 8.16Z',
        fill: '#c6cdd5',
      })
      const hub = svg('circle', { cx: '15', cy: '10', r: '1.5', fill: '#6b7682' })
      const log = svg('rect', { x: '2', y: '15', width: '10', height: '5', rx: '2.5', fill: '#8a5a2b' })
      const endFace = svg('ellipse', { cx: '2', cy: '17.5', rx: '1.4', ry: '2.5', fill: '#a96f3a' })
      const ring = svg('ellipse', {
        cx: '2',
        cy: '17.5',
        rx: '0.7',
        ry: '1.3',
        fill: 'none',
        stroke: '#6b431d',
        'stroke-width': '0.7',
      })
      return svgIcon('0 0 24 24', BUILDINGS[id].name, 'building-icon', [blade, hub, log, endFace, ring])
    }
    case 'clay_pit': {
      // Cegielnia = piec/stos cegieł: piramidka z gliny (kolor #c1663b) ze spoinami.
      // Schodkowy układ cegieł czyta się jako „wypalone, ułożone" — czysto i odrębnie.
      const brick = (x: string, y: string): SVGElement =>
        svg('rect', {
          x,
          y,
          width: '6',
          height: '4',
          rx: '0.6',
          fill: '#c1663b',
          stroke: '#7e3d22',
          'stroke-width': '0.8',
        })
      return svgIcon('0 0 24 24', BUILDINGS[id].name, 'building-icon', [
        brick('2', '15'),
        brick('9', '15'),
        brick('16', '15'),
        brick('5.5', '10.5'),
        brick('12.5', '10.5'),
        brick('9', '6'),
      ])
    }
    case 'iron_mine': {
      // Huta żelaza = kowadło: szeroki lico z rogiem po lewej, talia i rozszerzona
      // stopa (stal). Sylwetka kowadła wprost mówi „obróbka żelaza" — inna niż mur/HQ.
      const plate = svg('path', { d: 'M4 8 21 8 21 11 4 11Z', fill: '#9aa3ad' })
      const horn = svg('path', { d: 'M4 8.5 1 10 4 11Z', fill: '#9aa3ad' })
      const shine = svg('path', { d: 'M5 9 20 9', stroke: '#c6cdd5', 'stroke-width': '1', fill: 'none' })
      const neck = svg('rect', { x: '10', y: '11', width: '5', height: '2.5', fill: '#6b7682' })
      const foot = svg('path', { d: 'M6 18 9 13.5 16 13.5 19 18Z', fill: '#6b7682' })
      return svgIcon('0 0 24 24', BUILDINGS[id].name, 'building-icon', [plate, horn, shine, neck, foot])
    }
    case 'warehouse': {
      // Spichlerz = magazyn: jasna beczka spięta stalowymi obręczami + zawiązany wór.
      // Jasne drewno korpusu (#c0824a, ~4.5:1 na karcie) to mocny akcent kontrastu,
      // a chłodne stalowe obręcze odcinają się od ciepłego drewna i czytelnie znaczą
      // „beczka". Dwie różne bryły (okrągła beczka vs nieregularny wór) mówią „skład".
      const barrel = svg('path', { d: 'M5 7 11 7 Q13 13 11 19 L5 19 Q3 13 5 7Z', fill: '#c0824a' })
      const barrelTop = svg('ellipse', { cx: '8', cy: '7', rx: '3', ry: '1.1', fill: '#8a5a2b' })
      // Tylko dwie obręcze (góra/dół) — mniej zagęszczenia niż wcześniejsze trzy.
      const hoop = (y: string): SVGElement =>
        svg('rect', { x: '4', y, width: '8', height: '1.2', fill: '#6b7682' })
      const sack = svg('path', { d: 'M15.5 13 Q15 21 19 21 Q23 21 22.5 13 Q19 14.5 15.5 13Z', fill: '#a96f3a' })
      const sackNeck = svg('path', { d: 'M16.5 13 17 10.5 21 10.5 21.5 13Z', fill: '#c0824a' })
      const sackTie = svg('rect', { x: '16.2', y: '12.3', width: '5.6', height: '1.1', rx: '0.5', fill: '#6b7682' })
      return svgIcon('0 0 24 24', BUILDINGS[id].name, 'building-icon', [
        barrel,
        barrelTop,
        hoop('9.6'),
        hoop('15.4'),
        sack,
        sackNeck,
        sackTie,
      ])
    }
    case 'farm': {
      // Zagroda = snop zboża: pęk kłosów rozchylony u góry, ścięte źdźbła u dołu,
      // związany powrósłem (#8a5a2b). Złote kłosy dają od razu czytelny zarys „pola".
      const stalk = (d: string): SVGElement =>
        svg('path', { d, fill: 'none', stroke: '#e3b755', 'stroke-width': '1.3', 'stroke-linecap': 'round' })
      const ear = (cx: string, cy: string): SVGElement =>
        svg('ellipse', { cx, cy, rx: '1', ry: '1.8', fill: '#d9a441' })
      const tie = svg('rect', { x: '9.5', y: '13.5', width: '5', height: '2.2', rx: '0.6', fill: '#8a5a2b' })
      return svgIcon('0 0 24 24', BUILDINGS[id].name, 'building-icon', [
        stalk('M11 14 Q8.5 9 7 5'),
        stalk('M11.5 14 Q10.5 8 10 3.5'),
        stalk('M12 14 12 3'),
        stalk('M12.5 14 Q13.5 8 14 3.5'),
        stalk('M13 14 Q15.5 9 17 5'),
        stalk('M11.2 16 9.5 20'),
        stalk('M12 16 12 20'),
        stalk('M12.8 16 14.5 20'),
        ear('7', '5'),
        ear('10', '3.5'),
        ear('12', '3'),
        ear('14', '3.5'),
        ear('17', '5'),
        tie,
      ])
    }
    case 'barracks': {
      // Koszary = skrzyżowane miecze (stal + złote jelce) na tle namiotu obozowego.
      // „X" z ostrzy to klasyczny znak zbrojowni — odróżnia od pojedynczych broni jednostek.
      const tent = svg('path', { d: 'M3 19 12 8 21 19Z', fill: '#a96f3a' })
      const tentDoor = svg('path', { d: 'M12 19 10.5 13.5 13.5 13.5Z', fill: '#6b431d' })
      const blade = (x1: string, x2: string): SVGElement =>
        svg('line', { x1, y1: '18', x2, y2: '6', stroke: '#c6cdd5', 'stroke-width': '2', 'stroke-linecap': 'round' })
      const guard = (d: string): SVGElement =>
        svg('path', { d, stroke: '#d9a441', 'stroke-width': '1.6', 'stroke-linecap': 'round' })
      const pommelA = svg('circle', { cx: '6.5', cy: '18.5', r: '1', fill: '#d9a441' })
      const pommelB = svg('circle', { cx: '17.5', cy: '18.5', r: '1', fill: '#d9a441' })
      return svgIcon('0 0 24 24', BUILDINGS[id].name, 'building-icon', [
        tent,
        tentDoor,
        blade('7', '19'),
        blade('17', '5'),
        guard('M6 17 8 19'),
        guard('M18 17 16 19'),
        pommelA,
        pommelB,
      ])
    }
    case 'academy': {
      // Pałac (BUILDINGS[id].name) = kolumnowa hala: złoty fronton (przyczółek) na
      // marmurowych kolumnach. Świątynna sylwetka czyta się jako siedziba władzy/nauki.
      const pediment = svg('path', { d: 'M3 9 12 3 21 9Z', fill: '#d9a441' })
      const architrave = svg('rect', { x: '4', y: '9', width: '16', height: '2', fill: '#e3b755' })
      const column = (x: string): SVGElement =>
        svg('rect', { x, y: '11', width: '2', height: '8', fill: '#c6cdd5' })
      const base = svg('rect', { x: '3', y: '19', width: '18', height: '2.5', fill: '#9aa3ad' })
      return svgIcon('0 0 24 24', BUILDINGS[id].name, 'building-icon', [
        pediment,
        architrave,
        column('5'),
        column('9'),
        column('13'),
        column('17'),
        base,
      ])
    }
    case 'wall': {
      // Mur = blankowany wał obronny: szeroka, niska bryła z merlonami i wątkiem cegieł.
      // Szeroki proporcjon (vs wąski donżon HQ) jednoznacznie znaczy „fortyfikacja".
      const body = svg('rect', { x: '3', y: '10', width: '18', height: '10', fill: '#9aa3ad' })
      const merlon = (x: string): SVGElement =>
        svg('rect', { x, y: '7', width: '3', height: '3', fill: '#9aa3ad' })
      const brick = (d: string): SVGElement =>
        svg('path', { d, stroke: '#6b7682', 'stroke-width': '0.9', fill: 'none' })
      return svgIcon('0 0 24 24', BUILDINGS[id].name, 'building-icon', [
        body,
        merlon('3'),
        merlon('8'),
        merlon('13'),
        merlon('18'),
        brick('M3 14 21 14'),
        brick('M9 10 9 14'),
        brick('M15 10 15 14'),
        brick('M6 14 6 20'),
        brick('M12 14 12 20'),
        brick('M18 14 18 20'),
      ])
    }
    case 'market': {
      // Rynek = handel: pasiasta markiza ze straganu nad ladą + złota moneta na wierzchu.
      // Falbankowa markiza + moneta to czytelny skrót „kupno/sprzedaż", odrębny od reszty.
      const awning = svg('path', {
        d: 'M3 5 21 5 21 8 Q19.5 10 18 8 Q16.5 10 15 8 Q13.5 10 12 8 Q10.5 10 9 8 Q7.5 10 6 8 Q4.5 10 3 8Z',
        fill: '#c1663b',
      })
      const stripe = (x: string): SVGElement =>
        svg('rect', { x, y: '5', width: '2.2', height: '3', fill: '#e3b755' })
      const counter = svg('rect', { x: '4', y: '16', width: '16', height: '2.2', rx: '0.5', fill: '#a96f3a' })
      const coin = svg('circle', { cx: '12', cy: '13', r: '3.4', fill: '#d9a441' })
      const coinRing = svg('circle', { cx: '12', cy: '13', r: '2.2', fill: 'none', stroke: '#e3b755', 'stroke-width': '0.9' })
      const coinMark = svg('rect', { x: '11.5', y: '11.5', width: '1', height: '3', fill: '#e3b755' })
      return svgIcon('0 0 24 24', BUILDINGS[id].name, 'building-icon', [
        awning,
        stripe('5.5'),
        stripe('11'),
        stripe('16.5'),
        counter,
        coin,
        coinRing,
        coinMark,
      ])
    }
    case 'stable': {
      // Stajnia = podkowa (stal): otwarte u dołu „U" z otworami na gwoździe i piętami.
      // Świadomie podkowa, NIE łeb konia — odróżnia budynek od ikon kawalerii (unitIcon).
      const shoe = svg('path', {
        d: 'M7 19 C4 14 5 8 12 7 C19 8 20 14 17 19',
        fill: 'none',
        stroke: '#9aa3ad',
        'stroke-width': '3',
        'stroke-linecap': 'round',
      })
      const nail = (cx: string, cy: string): SVGElement =>
        svg('circle', { cx, cy, r: '0.6', fill: '#6b7682' })
      const heelL = svg('circle', { cx: '7', cy: '19', r: '1.2', fill: '#9aa3ad' })
      const heelR = svg('circle', { cx: '17', cy: '19', r: '1.2', fill: '#9aa3ad' })
      return svgIcon('0 0 24 24', BUILDINGS[id].name, 'building-icon', [
        shoe,
        heelL,
        heelR,
        nail('7', '15.5'),
        nail('8.5', '10.5'),
        nail('12', '8.5'),
        nail('15.5', '10.5'),
        nail('17', '15.5'),
      ])
    }
    case 'watchtower': {
      // Wieża strażnicza = wysoka, smukła wieża obserwacyjna z wystającą, blankowaną platformą
      // widokową na szczycie, wąskim okienkiem-szczeliną i proporczykiem. Smukła sylwetka +
      // nadwieszona platforma odróżniają ją od szerokiego Muru i krępego donżonu Ratusza.
      const shaft = svg('rect', { x: '9', y: '8', width: '6', height: '12', fill: '#9aa3ad' })
      const platform = svg('rect', { x: '7', y: '6', width: '10', height: '3', fill: '#9aa3ad' })
      const merlon = (x: string): SVGElement =>
        svg('rect', { x, y: '4', width: '2', height: '2', fill: '#9aa3ad' })
      const slit = svg('rect', { x: '11', y: '11', width: '2', height: '4', rx: '0.6', fill: '#3a4048' })
      const pole = svg('path', { d: 'M12 4 12 1', stroke: '#6b7682', 'stroke-width': '0.9', fill: 'none' })
      const pennant = svg('path', { d: 'M12 1 16 2 12 3Z', fill: '#c1663b' })
      return svgIcon('0 0 24 24', BUILDINGS[id].name, 'building-icon', [
        shaft,
        platform,
        merlon('7'),
        merlon('11'),
        merlon('15'),
        slit,
        pole,
        pennant,
      ])
    }
    case 'forge': {
      // Kuźnia = kowadło ze stali + złoty młot ułożony na ukos. Krępe kowadło z rogiem i
      // stopą czyta się od razu jako warsztat płatnerza — odróżnia od skrzyżowanych mieczy
      // Koszar (zbrojownia) i podkowy Stajni. Świadomie kowadło + młot, nie pojedyncza broń.
      const anvilBody = svg('path', {
        // Blat z rogiem po lewej, talia i szeroka stopa.
        d: 'M4 11 H17 L15 14 H9 L8.5 17 H15 V19 H6 V17 H6.5 L7 14 H5 Z',
        fill: '#6b7682',
      })
      const anvilFace = svg('rect', { x: '4', y: '10', width: '13', height: '1.4', fill: '#9aa3ad' })
      const hammerHead = svg('rect', {
        x: '13', y: '4', width: '6', height: '2.6', rx: '0.6',
        fill: '#d9a441', transform: 'rotate(32 16 5.3)',
      })
      const hammerHandle = svg('line', {
        x1: '13.5', y1: '7', x2: '8.5', y2: '11',
        stroke: '#8a5a2b', 'stroke-width': '1.6', 'stroke-linecap': 'round',
      })
      const spark = (cx: string, cy: string): SVGElement =>
        svg('circle', { cx, cy, r: '0.7', fill: '#e3b755' })
      return svgIcon('0 0 24 24', BUILDINGS[id].name, 'building-icon', [
        anvilBody,
        anvilFace,
        hammerHandle,
        hammerHead,
        spark('18', '9'),
        spark('20', '11'),
      ])
    }
    default: {
      const _exhaustive: never = id
      throw new Error('Brak ikony dla budynku: ' + String(_exhaustive))
    }
  }
}

/**
 * Procedural ikona wydarzenia świata (M13) — rysowana SVG, NIGDY emoji. Mechanika
 * wydarzeń ma `defId: string` (data-driven, bez unii literałów), więc — inaczej niż
 * {@link buildingIcon} — nie wymusza tu wyczerpalności `never`: znane wydarzenia
 * dostają dedykowaną sylwetkę, a każde nowe (lub nieznane) — neutralny złoty błysk.
 * Dzięki temu dodanie wpisu do `content/events.ts` NIGDY nie pokaże „tofu" na
 * systemach bez fontu emoji (lekcja M11.9), zachowując twardą zasadę #2 (grafika
 * tylko kodem). Dekoracyjna — etykietę niesie nazwa oferty obok (WCAG 1.4.1).
 */
export function eventIcon(defId: string, label = 'Wydarzenie'): SVGSVGElement {
  switch (defId) {
    case 'karawana': {
      // Karawana kupiecka = sakwa ze złotem: pękaty mieszek ze ściągniętą szyjką
      // i monetą — czyta się od razu jako „zastrzyk surowców / okazja".
      const pouch = svg('path', {
        d: 'M7 10 Q4 12 5 16 Q6 20 12 20 Q18 20 19 16 Q20 12 17 10 Z',
        fill: '#d9a441',
      })
      const flaps = svg('path', { d: 'M9 9 L10.5 5.5 L12 9 L13.5 5.5 L15 9 Z', fill: '#c0824a' })
      const tie = svg('rect', { x: '8', y: '8.4', width: '8', height: '2', rx: '0.6', fill: '#8a5a2b' })
      const coin = svg('circle', { cx: '12', cy: '15', r: '2.7', fill: '#e3b755', stroke: '#8a5a2b', 'stroke-width': '0.8' })
      const mark = svg('path', {
        d: 'M12 13.4 V16.6 M10.4 15 H13.6',
        stroke: '#8a5a2b',
        'stroke-width': '0.8',
        'stroke-linecap': 'round',
      })
      return svgIcon('0 0 24 24', label, 'event-glyph', [pouch, flaps, tie, coin, mark])
    }
    case 'zyla_zelaza': {
      // Żyła żelaza = kilof: stalowy łuk głowicy z połyskiem nad drewnianym stylem.
      const head = svg('path', {
        d: 'M4 9 Q12 2 20 9',
        fill: 'none',
        stroke: '#9aa3ad',
        'stroke-width': '2.8',
        'stroke-linecap': 'round',
      })
      const shine = svg('path', {
        d: 'M5.5 8 Q12 3 18.5 8',
        fill: 'none',
        stroke: '#c6cdd5',
        'stroke-width': '1',
        'stroke-linecap': 'round',
      })
      const handle = svg('path', {
        d: 'M12 5 V20',
        stroke: '#6b431d',
        'stroke-width': '2.4',
        'stroke-linecap': 'round',
      })
      return svgIcon('0 0 24 24', label, 'event-glyph', [head, handle, shine])
    }
    case 'dary_lasu': {
      // Dary lasu = ułożone kłody (czoła słojów) — drwa/budulec, na palecie brązów
      // (brak zieleni w tokenach ikon), spójne z kłodą Tartaku.
      const logEnd = (cx: string, cy: string): SVGElement[] => [
        svg('circle', { cx, cy, r: '3.4', fill: '#a96f3a', stroke: '#6b431d', 'stroke-width': '0.9' }),
        svg('circle', { cx, cy, r: '1.7', fill: 'none', stroke: '#6b431d', 'stroke-width': '0.8' }),
        svg('circle', { cx, cy, r: '0.5', fill: '#6b431d' }),
      ]
      return svgIcon('0 0 24 24', label, 'event-glyph', [
        ...logEnd('7', '16'),
        ...logEnd('14', '16'),
        ...logEnd('10.5', '9.5'),
      ])
    }
    case 'piesn_wojenna': {
      // Piesn wojenna (buff ataku) = chorągiew bojowa: drzewce + wypełniony złoty
      // proporzec z heraldycznym paskiem. „Zagrzewa do boju" — odrębne od ikon windfalli.
      const pole = svg('path', { d: 'M7 3 V21', stroke: '#6b431d', 'stroke-width': '1.8', 'stroke-linecap': 'round' })
      const banner = svg('path', { d: 'M7 4 L20 6.5 L7 12 Z', fill: '#d9a441' })
      const stripe = svg('path', { d: 'M7.5 7 L15 8.4', stroke: '#8a5a2b', 'stroke-width': '1', fill: 'none', 'stroke-linecap': 'round' })
      const finial = svg('circle', { cx: '7', cy: '3', r: '1.2', fill: '#e3b755' })
      return svgIcon('0 0 24 24', label, 'event-glyph', [pole, banner, stripe, finial])
    }
    case 'lowcy_lupow': {
      // Lowcy lupow (buff lupu) = skrzynia skarbu: korpus + zaokrąglone wieko, stalowa
      // obręcz i złoty zamek. Odrębne od sakwy karawany (też złoto, ale inna bryła).
      const body = svg('rect', { x: '4', y: '11', width: '16', height: '9', rx: '1', fill: '#8a5a2b' })
      const lid = svg('path', { d: 'M4 11 Q4 6.5 12 6.5 Q20 6.5 20 11 Z', fill: '#a96f3a' })
      const band = svg('rect', { x: '4', y: '13.2', width: '16', height: '1.8', fill: '#6b7682' })
      const lock = svg('rect', { x: '10.5', y: '12', width: '3', height: '3.2', rx: '0.4', fill: '#e3b755', stroke: '#6b431d', 'stroke-width': '0.6' })
      return svgIcon('0 0 24 24', label, 'event-glyph', [body, lid, band, lock])
    }
    case 'forsowny_marsz': {
      // Forsowny marsz (buff prędkości) = szewrony naprzód: trzy złote „>" jak linie
      // pędu — czyta się „szybciej / w marszu", odrębne od pozostałych ikon.
      const chev = (x: string, x2: string): SVGElement =>
        svg('path', {
          d: 'M' + x + ' 6 L' + x2 + ' 12 L' + x + ' 18',
          fill: 'none',
          stroke: '#d9a441',
          'stroke-width': '2.4',
          'stroke-linecap': 'round',
          'stroke-linejoin': 'round',
        })
      return svgIcon('0 0 24 24', label, 'event-glyph', [chev('5', '11'), chev('12', '18')])
    }
    default: {
      // Nieznane/przyszłe wydarzenie — neutralny złoty błysk „okazji" (czter'opromienna
      // gwiazda), zawsze SVG, nigdy tofu.
      const star = svg('path', {
        d: 'M12 2 L14 10 L22 12 L14 14 L12 22 L10 14 L2 12 L10 10 Z',
        fill: '#d9a441',
      })
      return svgIcon('0 0 24 24', label, 'event-glyph', [star])
    }
  }
}

/**
 * Procedural kłódka (padlock) — status "zablokowane" w panelu osiągnięć.
 *
 * Zastępuje kolorowe emoji 🔒 spójną ikoną SVG malowaną w `currentColor` (tak jak
 * {@link shieldIcon}/{@link buildingIcon}) — kafelek nadaje barwę przez CSS `color`,
 * więc kłódka idzie za motywem (twarda zasada #2: grafika tylko kodem). To CZYSTA
 * dekoracja: znaczenie niesie tekst obok (dostępność — WCAG 1.4.1), a aria-label
 * 'Zablokowane' służy tylko czytnikom ekranu.
 */
export function lockIcon(): SVGSVGElement {
  // Pałąk (shackle) nad korpusem — otwarty łuk obrysowany tokenem.
  const shackle = svg('path', {
    d: 'M8 10 V8 a4 4 0 0 1 8 0 V10',
    fill: 'none',
    stroke: 'currentColor',
    'stroke-width': '1.8',
    'stroke-linecap': 'round',
  })
  // Korpus kłódki — wypełniony tokenem.
  const body = svg('rect', { x: '5', y: '10', width: '14', height: '10', rx: '2', fill: 'currentColor' })
  // Otwór na klucz — przygaszony w stronę tła, by odcinał się na korpusie.
  const keyhole = svg('circle', { cx: '12', cy: '15', r: '1.5', 'fill-opacity': '0.5' })
  keyhole.style.fill = 'var(--bg)'
  return svgIcon('0 0 24 24', 'Zablokowane', 'lock-icon', [shackle, body, keyhole])
}

/**
 * Procedural ptaszek (checkmark) — status "odblokowane" w panelu osiągnięć.
 *
 * Zastępuje kolorowe emoji ✅ obrysowanym haczykiem w `currentColor` (jak pozostałe
 * ikony tego modułu). CZYSTA dekoracja: znaczenie niesie tekst obok (WCAG 1.4.1),
 * aria-label 'Odblokowane' jest tylko dla czytników ekranu.
 */
export function checkIcon(): SVGSVGElement {
  const check = svg('path', {
    d: 'M5 12.5 L10 17.5 L19 7',
    fill: 'none',
    stroke: 'currentColor',
    'stroke-width': '2.2',
    'stroke-linecap': 'round',
    'stroke-linejoin': 'round',
  })
  return svgIcon('0 0 24 24', 'Odblokowane', 'check-icon', [check])
}

/**
 * Procedural ikona automatyzacji (młot / tarcza / celownik) dla kart panelu
 * automatyzacji — zastępuje kolorowe emoji 🔨🛡️🎯 spójnym SVG w `currentColor`.
 *
 * EXHAUSTIVE po {@link AutomationKind} — dokładnie jak {@link buildingIcon}/
 * {@link unitIcon}: dodanie nowego rodzaju automatyzacji bez gałęzi ikony tutaj to
 * BŁĄD KOMPILACJI (przypisanie do `never` w `default`), nie ciche pominięcie. Każda
 * ikona to CZYSTA dekoracja: znaczenie niesie tekst karty obok (WCAG 1.4.1), a
 * aria-label służy tylko czytnikom ekranu.
 */
export function automationIcon(kind: AutomationKind): SVGSVGElement {
  switch (kind) {
    case 'build': {
      // Młot ciesielski — krępa głowica (9×5, środek ~15.5,6.5) + ukośny trzonek
      // startujący WEWNĄTRZ obrysu głowicy, by łączenie czytało się jako jeden młot;
      // niżej osadzony niż celownik/tarcza, by równać centroidy w rzędzie. "auto-budowa".
      const head = svg('rect', { x: '11', y: '4', width: '9', height: '5', rx: '1', fill: 'currentColor', transform: 'rotate(45 15.5 6.5)' })
      const handle = svg('path', {
        d: 'M14.5 6.5 L6.5 18',
        fill: 'none',
        stroke: 'currentColor',
        'stroke-width': '2.4',
        'stroke-linecap': 'round',
      })
      return svgIcon('0 0 24 24', 'Auto-budowa', 'automation-icon', [handle, head])
    }
    case 'recruit': {
      // Sylwetka tarczy (echo {@link shieldIcon}) — "auto-rekrutacja".
      const face = svg('path', { d: 'M12 2 4 5v7c0 6 4 9 8 11 4-2 8-5 8-11V5z', fill: 'currentColor' })
      const band = svg('path', { d: 'M4 11h16v2.5H4z', 'fill-opacity': '0.3' })
      band.style.fill = 'var(--bg)'
      return svgIcon('0 0 24 24', 'Auto-rekrutacja', 'automation-icon', [face, band])
    }
    case 'attack': {
      // Celownik — dwa współśrodkowe okręgi + kreski celownika przecinające pierścienie
      // + wypełniona kropka; pogrubiony, by zrównoważyć masę tarczy w rzędzie i czytał
      // się jako krzyż celowniczy (nie tarcza strzelnicza/symbol nagrywania). "auto-atak".
      const outer = svg('circle', { cx: '12', cy: '12', r: '9', fill: 'none', stroke: 'currentColor', 'stroke-width': '2.2' })
      const inner = svg('circle', { cx: '12', cy: '12', r: '4.5', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.6' })
      const ticks = svg('path', { d: 'M12 1 V4 M12 20 V23 M1 12 H4 M20 12 H23', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.8', 'stroke-linecap': 'round' })
      const dot = svg('circle', { cx: '12', cy: '12', r: '1.6', fill: 'currentColor' })
      return svgIcon('0 0 24 24', 'Auto-atak', 'automation-icon', [outer, inner, ticks, dot])
    }
    default: {
      const _exhaustive: never = kind
      throw new Error('Brak ikony dla automatyzacji: ' + String(_exhaustive))
    }
  }
}

/**
 * Dekoracyjny kontener glifu nawigacji (sidebar M12.1). Mirror {@link emptyStateGlyph}:
 * surowy `<svg>` z aria-hidden + focusable=false, NIE {@link svgIcon} — svgIcon wymusza
 * role=img + aria-label, a ikona w railu jest CZYSTĄ dekoracją (nazwę dostępną niesie
 * `span.tab-label` obok). viewBox 0 0 24 24 i klasa `nav-icon`, więc CSS barwi glif
 * przez `color` (muted w spoczynku, --accent przy .is-active) — wszystkie kształty malowane
 * WYŁĄCZNIE w `currentColor`, zero literalnego heksa (twarda zasada #2).
 */
function navGlyph(children: SVGElement[]): SVGSVGElement {
  const root = document.createElementNS(SVG_NS, 'svg') as SVGSVGElement
  root.setAttribute('viewBox', '0 0 24 24')
  root.setAttribute('class', 'nav-icon')
  root.setAttribute('aria-hidden', 'true')
  root.setAttribute('focusable', 'false')
  for (const child of children) root.appendChild(child)
  return root
}

/**
 * Ciemniejsza wnęka glifu nawigacji — token tła (`var(--bg)`) nałożony półprzezroczyście
 * na sylwetkę z currentColor (dokładnie jak otwór kłódki w {@link lockIcon}). Pozwala
 * „wyrzeźbić" detal w pełnej bryle bez literalnego koloru: barwa wnęki idzie z motywu.
 * `var(--bg)` ustawiamy przez `.style` (atrybuty SVG nie przyjmują gramatyki var()).
 */
function navShade(tag: string, attrs: Record<string, string>, opacity = '0.5'): SVGElement {
  const node = svg(tag, { ...attrs, 'fill-opacity': opacity })
  node.style.fill = 'var(--bg)'
  return node
}

/**
 * Proceduralna ikona zakładki bocznego nawigatora (M12.1). Jedna odróżnialna sylwetka
 * na `TabSpec.id`, czytelna przy ~20px obok etykiety w railu.
 *
 * NIE jest exhaustive po typie (jak {@link buildingIcon}) — `TabSpec.id` to swobodny
 * `string`, więc zamiast przypisania do `never` mamy `default` zwracający neutralny glif
 * (zakładka/wstążka). Dzięki temu nieznana lub PRZYSZŁA zakładka renderuje się bez błędu,
 * a dorzucenie nowej sekcji pozostaje edycją danych — nie wymusza dotknięcia tego pliku.
 *
 * Każdy glif jest dekoracją (przez {@link navGlyph}), malowaną wyłącznie w `currentColor`
 * (+ wnęki {@link navShade} przez `var(--bg)`), więc podąża za barwą zakładki i motywem.
 */
export function navIcon(id: string): SVGSVGElement {
  switch (id) {
    case 'buildings': {
      // Kamienny donżon: wysoki korpus + 3 blanki na szczycie + przyciemniona brama.
      const body = svg('rect', { x: '6', y: '8', width: '12', height: '13', fill: 'currentColor' })
      const merlon = (x: string): SVGElement =>
        svg('rect', { x, y: '5', width: '2.6', height: '3.5', fill: 'currentColor' })
      const door = navShade('rect', { x: '10', y: '14', width: '4', height: '7', rx: '0.6' })
      return navGlyph([body, merlon('6'), merlon('10.7'), merlon('15.4'), door])
    }
    case 'villages': {
      // Skupisko dwóch chat: dwa daszki nad kwadratami, przesunięte — czyta się jako „osada".
      const roofA = svg('path', { d: 'M2.5 12 L7 6.5 L11.5 12 Z', fill: 'currentColor' })
      const bodyA = svg('rect', { x: '4', y: '12', width: '6', height: '8', fill: 'currentColor' })
      const roofB = svg('path', { d: 'M11 14 L15.5 9 L20 14 Z', fill: 'currentColor' })
      const bodyB = svg('rect', { x: '12.5', y: '14', width: '6', height: '6', fill: 'currentColor' })
      const door = navShade('rect', { x: '14.5', y: '16', width: '2', height: '4', rx: '0.4' }, '0.55')
      return navGlyph([roofA, bodyA, roofB, bodyB, door])
    }
    case 'market': {
      // Moneta: pełny krążek + grawerowany pierścień i pionowy mincerski znaczek (wnęki tła).
      const disc = svg('circle', { cx: '12', cy: '12', r: '9', fill: 'currentColor' })
      const ring = svg('circle', { cx: '12', cy: '12', r: '5.6', fill: 'none', 'stroke-width': '1.4', 'stroke-opacity': '0.55' })
      ring.style.stroke = 'var(--bg)'
      const mint = navShade('rect', { x: '11.1', y: '8.4', width: '1.8', height: '7.2', rx: '0.6' }, '0.6')
      return navGlyph([disc, ring, mint])
    }
    case 'automation': {
      // Zębatka: 8 promienistych zębów + pełna piasta + przyciemniony otwór (wnęka tła).
      const parts: SVGElement[] = []
      for (let d = 0; d < 360; d += 45) {
        parts.push(svg('rect', {
          x: '10.6',
          y: '1',
          width: '2.8',
          height: '5.5',
          rx: '0.6',
          fill: 'currentColor',
          transform: 'rotate(' + d + ' 12 12)',
        }))
      }
      parts.push(svg('circle', { cx: '12', cy: '12', r: '7', fill: 'currentColor' }))
      parts.push(navShade('circle', { cx: '12', cy: '12', r: '2.7' }, '0.65'))
      return navGlyph(parts)
    }
    case 'army': {
      // Skrzyżowane miecze: dwa ukośne ostrza w „X" + krótkie jelce przy rękojeściach.
      const blade = (x1: string, y1: string, x2: string, y2: string): SVGElement =>
        svg('line', { x1, y1, x2, y2, stroke: 'currentColor', 'stroke-width': '2.2', 'stroke-linecap': 'round' })
      const guard = (x1: string, y1: string, x2: string, y2: string): SVGElement =>
        svg('line', { x1, y1, x2, y2, stroke: 'currentColor', 'stroke-width': '1.6', 'stroke-linecap': 'round' })
      return navGlyph([
        blade('5', '5', '17', '17'),
        blade('19', '5', '7', '17'),
        guard('15', '19', '19', '15'),
        guard('9', '19', '5', '15'),
      ])
    }
    case 'map': {
      // Pinezka lokalizacji: kropla z wydrążonym okręgiem (wnęka tła) — znacznik na mapie.
      const pin = svg('path', {
        d: 'M12 2 C7.6 2 4 5.6 4 10 C4 16 12 22 12 22 C12 22 20 16 20 10 C20 5.6 16.4 2 12 2 Z',
        fill: 'currentColor',
      })
      const hole = navShade('circle', { cx: '12', cy: '10', r: '3' }, '0.85')
      return navGlyph([pin, hole])
    }
    case 'raids': {
      // Proporzec wyprawy: pionowe drzewce + trójkątna chorągiew + gałka na szczycie.
      const pole = svg('line', { x1: '6', y1: '3', x2: '6', y2: '21', stroke: 'currentColor', 'stroke-width': '2', 'stroke-linecap': 'round' })
      const flag = svg('path', { d: 'M6 4 L19 7 L6 10 Z', fill: 'currentColor' })
      const finial = svg('circle', { cx: '6', cy: '3', r: '1.3', fill: 'currentColor' })
      return navGlyph([pole, flag, finial])
    }
    case 'reports': {
      // Dokument/zwój: arkusz z zagiętym rogiem + 3 linie tekstu (wnęki tła).
      const sheet = svg('rect', { x: '5', y: '3', width: '14', height: '18', rx: '2', fill: 'currentColor' })
      const fold = navShade('path', { d: 'M15 3 L19 7 L15 7 Z' }, '0.5')
      const line = (y: string, w: string): SVGElement =>
        navShade('rect', { x: '8', y, width: w, height: '1.6', rx: '0.8' }, '0.6')
      return navGlyph([sheet, fold, line('7.5', '8'), line('11', '8'), line('14.5', '5')])
    }
    case 'tech': {
      // Konstelacja: 4 węzły połączone cienkimi liniami — echo drzewa talentów.
      const link = (d: string): SVGElement =>
        svg('path', { d, fill: 'none', stroke: 'currentColor', 'stroke-width': '1.4', 'stroke-linecap': 'round', 'stroke-opacity': '0.7' })
      const node = (cx: string, cy: string, r = '2'): SVGElement =>
        svg('circle', { cx, cy, r, fill: 'currentColor' })
      return navGlyph([
        link('M6 18 L10 9 L18 6'),
        link('M10 9 L16 14'),
        node('6', '18'),
        node('10', '9', '2.4'),
        node('18', '6'),
        node('16', '14'),
      ])
    }
    case 'prestige': {
      // Pełna pięcioramienna gwiazda.
      const star = svg('path', {
        d: 'M12 2 L15.09 8.26 L22 9.27 L17 14.14 L18.18 21.02 L12 17.77 L5.82 21.02 L7 14.14 L2 9.27 L8.91 8.26 Z',
        fill: 'currentColor',
      })
      return navGlyph([star])
    }
    case 'era': {
      // Klepsydra: dwa trójkąty stykające się w talii + listwa górna i dolna.
      const topBar = svg('rect', { x: '5', y: '3', width: '14', height: '2', rx: '0.8', fill: 'currentColor' })
      const botBar = svg('rect', { x: '5', y: '19', width: '14', height: '2', rx: '0.8', fill: 'currentColor' })
      const glass = svg('path', { d: 'M6.5 5 L17.5 5 L12 12 Z M12 12 L17.5 19 L6.5 19 Z', fill: 'currentColor' })
      return navGlyph([topBar, botBar, glass])
    }
    case 'dynasty': {
      // Korona: zygzakowaty obrys + opaska podstawy + jeden przyciemniony klejnot.
      const crown = svg('path', { d: 'M3 8 L7 13 L12 6 L17 13 L21 8 L19 18 L5 18 Z', fill: 'currentColor' })
      const band = svg('rect', { x: '5', y: '17.5', width: '14', height: '2.6', rx: '0.5', fill: 'currentColor' })
      const gem = navShade('circle', { cx: '12', cy: '13.5', r: '1.4' }, '0.6')
      return navGlyph([crown, band, gem])
    }
    case 'challenges': {
      // Tarcza strzelnicza: dwa współśrodkowe pierścienie (obrys) + pełna kropka środka.
      const outer = svg('circle', { cx: '12', cy: '12', r: '9', fill: 'none', stroke: 'currentColor', 'stroke-width': '2' })
      const inner = svg('circle', { cx: '12', cy: '12', r: '5', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.6' })
      const dot = svg('circle', { cx: '12', cy: '12', r: '2', fill: 'currentColor' })
      return navGlyph([outer, inner, dot])
    }
    case 'achievements': {
      // Puchar: czasza + dwa boczne ucha + nóżka + podstawa.
      const handleL = svg('path', { d: 'M7 5 C3 5 3 11 8 11', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.6' })
      const handleR = svg('path', { d: 'M17 5 C21 5 21 11 16 11', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.6' })
      const bowl = svg('path', { d: 'M6.5 4 L17.5 4 L16.8 9 C16.4 12.2 13.6 13.5 12 13.5 C10.4 13.5 7.6 12.2 7.2 9 Z', fill: 'currentColor' })
      const stem = svg('rect', { x: '11', y: '13', width: '2', height: '4', fill: 'currentColor' })
      const foot = svg('rect', { x: '9.5', y: '17', width: '5', height: '1.6', fill: 'currentColor' })
      const base = svg('rect', { x: '8', y: '18.4', width: '8', height: '2.2', rx: '0.6', fill: 'currentColor' })
      return navGlyph([handleL, handleR, bowl, stem, foot, base])
    }
    case 'codex': {
      // Otwarta księga: dwie strony rozdzielone grzbietem (wnęka) + po dwie linie tekstu.
      const pageL = svg('path', { d: 'M12 5 C9.5 3.5 6 3.5 3.5 4.5 L3.5 18 C6 17 9.5 17 12 18.5 Z', fill: 'currentColor' })
      const pageR = svg('path', { d: 'M12 5 C14.5 3.5 18 3.5 20.5 4.5 L20.5 18 C18 17 14.5 17 12 18.5 Z', fill: 'currentColor' })
      const spine = navShade('rect', { x: '11.4', y: '5', width: '1.2', height: '13.5' }, '0.5')
      const line = (x: string, y: string): SVGElement =>
        navShade('rect', { x, y, width: '5', height: '1', rx: '0.5' }, '0.55')
      return navGlyph([pageL, pageR, spine, line('5', '8'), line('5', '11'), line('14', '8'), line('14', '11')])
    }
    case 'save': {
      // Skrzynia skarbów: zaokrąglone wieko + korpus + opaska szwu + zatrzask (wnęki tła).
      const lid = svg('path', { d: 'M4 9 C4 5.5 7 4 12 4 C17 4 20 5.5 20 9 L20 10 L4 10 Z', fill: 'currentColor' })
      const body = svg('rect', { x: '4', y: '10', width: '16', height: '9', rx: '1', fill: 'currentColor' })
      const band = navShade('rect', { x: '4', y: '9.2', width: '16', height: '1.6' }, '0.5')
      const latch = navShade('rect', { x: '10.5', y: '11', width: '3', height: '4', rx: '0.5' }, '0.7')
      return navGlyph([lid, body, band, latch])
    }
    default: {
      // Nieznana/przyszła zakładka — neutralna zakładka-wstążka, NIGDY nie rzuca wyjątkiem.
      const mark = svg('path', { d: 'M7 3 L17 3 L17 21 L12 16.5 L7 21 Z', fill: 'currentColor' })
      return navGlyph([mark])
    }
  }
}

/**
 * Drobny szewron w lewo dla przycisku zwijania railu (M12.1). Dekoracja (aria-hidden);
 * CSS obraca go o 180° w stanie `.is-collapsed`. Malowany w `currentColor`.
 */
export function chevronIcon(): SVGSVGElement {
  const path = svg('path', {
    d: 'M15 5 L8 12 L15 19',
    fill: 'none',
    stroke: 'currentColor',
    'stroke-width': '2',
    'stroke-linecap': 'round',
    'stroke-linejoin': 'round',
  })
  return navGlyph([path])
}

/**
 * Hamburger (3 poziome belki) dla mobilnego przełącznika menu (M12.1). Dekoracja
 * (aria-hidden) — nazwę przycisku niesie tekst „Menu" obok. Malowany w `currentColor`.
 */
export function menuIcon(): SVGSVGElement {
  const bar = (y: string): SVGElement =>
    svg('rect', { x: '3', y, width: '18', height: '2.2', rx: '1.1', fill: 'currentColor' })
  return navGlyph([bar('5'), bar('11'), bar('17')])
}

/* ============================================================================
 * M12.3 — Prymitywy zagęszczenia pionowego (mniej przewijania strony)
 * --------------------------------------------------------------------------
 * Trzy współdzielone, czysto-DOM-owe prymitywy konsumowane DOSŁOWNIE przez panele:
 *  - collapsible() — natywny <details> (klawiatura + ARIA za darmo) z własnym
 *    szewronem (chevronIcon) obracanym CSS-em na [open],
 *  - helpTip() — drobny, fokusowalny przycisk „?" przenoszący długą prozę z ekranu
 *    do tooltipa (title) + etykiety dla czytników (aria-label),
 *  - segmented() — pasek pigułek role=radiogroup z roaming-tabindex (Strzałki/Home/End),
 *    by dwie sekcje mogły dzielić to samo miejsce.
 * Zero importów ze store'a — wyłącznie {@link h} i {@link chevronIcon} z tego modułu.
 * ========================================================================== */

/**
 * Sekcja rozwijana oparta na natywnym `<details>` — klawiatura (Enter/Spacja na
 * `<summary>`) i ARIA (expanded/collapsed) są wbudowane, więc nie odtwarzamy ich ręcznie.
 * Zwraca `root` (sam `<details>`) i `body` (pusty `<div class="collapse-body">`), który
 * wypełnia wywołujący. Tytuł owijamy w nagłówek h2/h3/h4 (gdy podano `headingLevel`,
 * dla poprawnej hierarchii dokumentu) ALBO w `<span>`. Szewron jest CZYSTĄ dekoracją
 * (aria-hidden) — obraca się przez CSS na `[open]` (sygnał KSZTAŁTU, nie samego koloru).
 */
export function collapsible(
  title: string,
  opts?: { open?: boolean; headingLevel?: 2 | 3 | 4 },
): { root: HTMLDetailsElement; body: HTMLElement } {
  const root = h('details', 'collapse')
  if (opts?.open) root.open = true

  const summary = h('summary', 'collapse-summary')
  const level = opts?.headingLevel
  const titleEl =
    level === undefined
      ? h('span', 'collapse-title', title)
      : h(`h${level}`, 'collapse-title', title)
  summary.appendChild(titleEl)

  // Szewron z chevronIcon() — dekoracja; CSS obraca go na [open] (".collapse[open]").
  const chevron = h('span', 'collapse-chevron')
  chevron.setAttribute('aria-hidden', 'true')
  chevron.appendChild(chevronIcon())
  summary.appendChild(chevron)
  root.appendChild(summary)

  const body = h('div', 'collapse-body')
  root.appendChild(body)

  return { root, body }
}

/** Licznik do unikalnych id powiązań aria-describedby (jedna instancja = jeden opis). */
let helpTipSeq = 0

/**
 * Drobna, inline'owa podpowiedź „?" — zdejmuje długą prozę wyjaśniającą z ekranu.
 *
 * Dostępność (problem: sam `title` nie wystarcza — nie wychodzi na fokusie klawiatury,
 * nie reaguje na dotyk, a jego ekspozycja jako OPISU bywa zależna od przeglądarki/AT):
 *  - pełne wyjaśnienie niesie TRWAŁY, wizualnie-ukryty `<span class="visually-hidden">`
 *    powiązany przez `aria-describedby` — to NIEZAWODNA ścieżka do treści dla czytników
 *    ekranu, działająca tak samo przy obsłudze klawiaturą, jak i dotykiem;
 *  - `aria-label` daje przyciskowi KRÓTKĄ nazwę (`opts.label` lub, w braku, sam `text`),
 *    więc opis nie dubluje się z nazwą;
 *  - `title` zostaje WYŁĄCZNIE jako redundantny tooltip dla myszy.
 * Span żyje WEWNĄTRZ przycisku, więc jest częścią zwracanego poddrzewa (id zadziała po
 * wstawieniu do dokumentu). Fokusowalny `<button type="button">` trafia w globalny pierścień
 * fokusa i obsługę klawiatury — siada obok nagłówka.
 */
export function helpTip(text: string, opts?: { label?: string }): HTMLElement {
  const btn = h('button', 'help-tip', '?')
  btn.type = 'button'
  btn.title = text
  btn.setAttribute('aria-label', opts?.label ?? text)

  const descId = `help-tip-desc-${(helpTipSeq += 1)}`
  const desc = h('span', 'visually-hidden', text)
  desc.id = descId
  btn.setAttribute('aria-describedby', descId)
  btn.appendChild(desc)

  return btn
}

/**
 * Segmentowany przełącznik (pasek pigułek) jako `role="radiogroup"` z przyciskami
 * `role="radio"`. Pozwala DWÓM sekcjom dzielić to samo miejsce (jedna widoczna na raz).
 *
 * Dostępność wg wzorca ARIA radiogroup:
 *  - roaming tabindex: tabbable jest TYLKO zaznaczony radio (reszta -1), więc Tab wchodzi/
 *    wychodzi z grupy jednym krokiem;
 *  - Strzałki Lewo/Prawo przesuwają zaznaczenie (z zawijaniem), Home/End skaczą na skraje;
 *  - klik LUB nawigacja klawiaturą zaznacza i woła `onSelect`.
 * Zwracany `select(id)` przełącza PROGRAMOWO (aktualizuje aria-checked + tabindex, BEZ
 * wołania `onSelect` — to wywołujący inicjuje zmianę, więc nie domykamy pętli zwrotnej).
 */
export function segmented(
  items: Array<{ id: string; label: string }>,
  initialId: string,
  onSelect: (id: string) => void,
): { root: HTMLElement; select: (id: string) => void } {
  const root = h('div', 'segmented')
  root.setAttribute('role', 'radiogroup')

  const buttons = new Map<string, HTMLButtonElement>()
  const order: string[] = []

  // Czysto wizualne/ARIA przełączenie zaznaczenia — NIE woła onSelect (patrz docstring).
  const select = (id: string): void => {
    if (!buttons.has(id)) return
    for (const [bid, btn] of buttons) {
      const checked = bid === id
      btn.setAttribute('aria-checked', checked ? 'true' : 'false')
      btn.classList.toggle('is-checked', checked)
      btn.tabIndex = checked ? 0 : -1
    }
  }

  // Interakcja użytkownika: zaznacz + powiadom wywołującego.
  const choose = (id: string): void => {
    select(id)
    onSelect(id)
  }

  for (const item of items) {
    const btn = h('button', 'seg-btn', item.label)
    btn.type = 'button'
    btn.setAttribute('role', 'radio')
    btn.setAttribute('aria-checked', 'false')
    btn.tabIndex = -1
    btn.addEventListener('click', () => choose(item.id))
    buttons.set(item.id, btn)
    order.push(item.id)
    root.appendChild(btn)
  }

  // Roaming klawiaturą: ustal bieżący indeks z fokusa (fallback: zaznaczony, potem 0).
  root.addEventListener('keydown', (ev: KeyboardEvent) => {
    const n = order.length
    if (n === 0) return
    let target = -1
    if (ev.key === 'ArrowRight') target = 1
    else if (ev.key === 'ArrowLeft') target = -1
    else if (ev.key === 'Home') target = -2
    else if (ev.key === 'End') target = -3
    else return
    const active = document.activeElement
    let cur = order.findIndex((id) => buttons.get(id) === active)
    if (cur < 0) cur = order.findIndex((id) => buttons.get(id)?.getAttribute('aria-checked') === 'true')
    if (cur < 0) cur = 0
    let next: number
    if (target === -2) next = 0
    else if (target === -3) next = n - 1
    else next = (cur + target + n) % n
    ev.preventDefault()
    const nextId = order[next]
    choose(nextId)
    buttons.get(nextId)?.focus()
  })

  // Stan początkowy: zaznacz initialId; jeśli nieznany — utrzymaj grupę osiągalną Tabem
  // (pierwszy przycisk tabbable), nie zaznaczając niczego.
  if (buttons.has(initialId)) {
    select(initialId)
  } else if (order.length > 0) {
    const first = buttons.get(order[0])
    if (first) first.tabIndex = 0
  }

  return { root, select }
}

/* ============================================================================
 * M12.4 — Puls potwierdzenia akcji (sukces)
 * --------------------------------------------------------------------------
 * Współdzielony prymityw warstwy „delight": gdy akcja pętli rdzeniowej się POWIODŁA
 * (rozbudowa, rekrutacja, zakup węzła drzewa, ruch na Rynku), karta/węzeł raz „popa"
 * krótkim, smacznym pulsem (skala + złota poświata). To CZYSTO prezentacyjne — żadnego
 * stanu gry, zero importu store'a.
 *
 * Dyscyplina jak reszta motion.css: animacja żyje WYŁĄCZNIE w CSS (@keyframes .fx-bump),
 * a JS tylko dokłada/zdejmuje samo-sprzątającą klasę na ZDARZENIE (nie w pętli ticka).
 * Przy reduced-motion motion.css ustawia `animation: none` (animation-name: none), więc
 * zdarzenie `animationend` NIGDY by nie padło — listener `once` nie posprzątałby klasy,
 * a na stałych (raz budowanych, tylko rekonsyliowanych) kartach/węzłach klasa zostałaby
 * na trwałe, a listenery kumulowałyby się przy każdej akcji. Dlatego dla reduced-motion
 * robimy wczesny return: zero klasy, zero listenera — kontrakt „one-shot, samo-sprzątające"
 * pozostaje spełniony także bez animacji.
 * ========================================================================== */

/**
 * Retrigger-safe puls sukcesu na elemencie `el` (HTML karta LUB węzeł SVG).
 *
 * Zdejmuje klasę `fx-bump`, WYMUSZA synchroniczny reflow (odczyt `offsetWidth` dla HTML,
 * `getBoundingClientRect()` dla SVG — `offsetWidth` istnieje tylko na HTMLElement), po czym
 * dokłada klasę z powrotem. Dzięki temu animacja restartuje się od zera nawet w trakcie
 * trwania (szybkie, powtórne kliknięcia). Klasę zdejmuje JEDNORAZOWY listener `animationend`
 * (`once`), więc nigdy się nie kumuluje i sama się sprząta. Bezpieczny no-op dla null/undefined.
 */
export function pulseFx(el: HTMLElement | SVGElement | null | undefined): void {
  if (!el) return
  // Reduced-motion: motion.css ma `animation: none`, więc `animationend` nigdy nie padnie
  // i listener `once` nie posprzątałby klasy (trwała klasa + kumulacja listenerów na stałych
  // kartach/węzłach). Wczesny return = zero klasy, zero listenera; CSS `animation: none` zostaje.
  if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return
  el.classList.remove('fx-bump')
  // Wymuszony reflow: bez niego ponowne dodanie klasy nie zrestartuje @keyframes.
  if (el instanceof HTMLElement) void el.offsetWidth
  else el.getBoundingClientRect()
  el.classList.add('fx-bump')
  // Jednorazowo, samo-sprzątająco: po zakończeniu animacji zdejmij klasę (bez kumulacji).
  el.addEventListener('animationend', () => el.classList.remove('fx-bump'), { once: true })
}
