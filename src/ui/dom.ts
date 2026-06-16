import type { ResourceId } from '../engine/state'
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
    default: {
      const _exhaustive: never = id
      throw new Error('Brak ikony dla budynku: ' + String(_exhaustive))
    }
  }
}
