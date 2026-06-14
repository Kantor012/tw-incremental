import type { ResourceId } from '../engine/state'
import { UNITS, type UnitId } from '../content/units'

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
    default: {
      const _exhaustive: never = id
      throw new Error('Brak ikony dla jednostki: ' + String(_exhaustive))
    }
  }
}
