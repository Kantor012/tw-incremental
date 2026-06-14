import { Decimal } from '../engine/decimal'
import type { ResourceId } from '../engine/state'

/**
 * Building catalogue — PURE DATA (no engine logic lives here).
 *
 * The engine (src/systems/buildings.ts + src/engine/state.ts) is data-driven:
 * adding or rebalancing a building is an edit to this file, never to the engine.
 * Effects are a discriminated union so a new effect *kind* is the only thing that
 * ever needs a new engine branch (CLAUDE.md hard rule #5: generalise, then add
 * content).
 *
 * Import discipline: this module imports only the *type* `ResourceId` from
 * state.ts (erased at runtime) plus the `Decimal` value, so it has no runtime
 * dependency back on the engine and can never form an initialisation cycle.
 */

export type BuildingId =
  | 'hq'
  | 'sawmill'
  | 'clay_pit'
  | 'iron_mine'
  | 'warehouse'
  | 'farm'
  | 'barracks'
  | 'academy'

/**
 * Stable iteration order for derived-stat recompute and UI listing. `academy`
 * stays LAST so older saves' building key order is unchanged (the new building is
 * appended), keeping migration and round-trip deterministic.
 */
export const BUILDING_IDS: readonly BuildingId[] = [
  'hq',
  'sawmill',
  'clay_pit',
  'iron_mine',
  'warehouse',
  'farm',
  'barracks',
  'academy',
]

/** A cost expressed per base resource, on Decimal so it scales past 2^53. */
export interface ResourceCost {
  wood: Decimal
  clay: Decimal
  iron: Decimal
}

/**
 * What a building *does*, as a discriminated union. `perLevel` is the linear
 * contribution of one level (the engine multiplies it by the current level):
 *  - production:    +perLevel resource/second of `resource`
 *  - storage:       +perLevel to the shared storage cap
 *  - population:    +perLevel to the population cap (unit upkeep budget, M2+)
 *  - cost_reduction:fraction (0..1) subtracted per level from the global build
 *                   cost multiplier; consumed by buildingCost, NOT by recompute.
 *  - recruit_speed: fraction (0..1) cut per level from unit training time; consumed
 *                   by the recruitment system (recruitSpeedMult), NOT by recompute.
 *  - noble_unlock:  BINARY (no perLevel) — having this building at level >= 1 lets
 *                   the village recruit the noble (see units.ts `requires`) and so
 *                   conquer barbarian villages. Pure gate: contributes nothing to a
 *                   tick-derived stat, so recompute treats it as a no-op.
 */
export type BuildingEffect =
  | { kind: 'production'; resource: ResourceId; perLevel: number }
  | { kind: 'storage'; perLevel: number }
  | { kind: 'population'; perLevel: number }
  | { kind: 'cost_reduction'; perLevel: number }
  | { kind: 'recruit_speed'; perLevel: number }
  | { kind: 'noble_unlock' }

export interface BuildingDef {
  id: BuildingId
  /** Display name (PL). */
  name: string
  /** Short description (PL). */
  desc: string
  category: 'core' | 'economy' | 'storage' | 'military'
  /** Finite upgrade ceiling (CLAUDE.md: never infinite depth). */
  maxLevel: number
  /** Cost of the *first* level (level 0 -> 1), per resource. */
  baseCost: { wood: number; clay: number; iron: number }
  /** Geometric cost growth per owned level. */
  costFactor: number
  effect: BuildingEffect
  /**
   * Level a fresh run starts this building at (default 0). DATA, not engine:
   * INITIAL_BUILDINGS in state.ts derives the starting-level map from this field,
   * so a new building is a single edit to this file (CLAUDE.md hard rule #5).
   */
  initialLevel?: number
}

/**
 * Starting data. Numbers are intentionally provisional — the Balance phase tunes
 * the cost/effect curves against the harness targets; the SHAPE (data-driven,
 * Decimal economy, finite maxLevel) is the contract.
 *
 * The starting production rates (sawmill/clay_pit/iron_mine perLevel) are pinned
 * to 1 / 0.8 / 0.5 so that the initial state (all of these at level 1) reproduces
 * the M0 base economy exactly — see recomputeDerived + tests/simulate.test.ts.
 */
export const BUILDINGS: Record<BuildingId, BuildingDef> = {
  hq: {
    id: 'hq',
    name: 'Ratusz',
    desc: 'Centrum wioski. Każdy poziom obniża koszt rozbudowy wszystkich budynków.',
    category: 'core',
    maxLevel: 20,
    baseCost: { wood: 90, clay: 80, iron: 70 },
    costFactor: 1.26,
    effect: { kind: 'cost_reduction', perLevel: 0.04 },
    initialLevel: 1,
  },
  sawmill: {
    id: 'sawmill',
    name: 'Tartak',
    desc: 'Pozyskuje drewno. Każdy poziom zwiększa produkcję drewna.',
    category: 'economy',
    maxLevel: 30,
    baseCost: { wood: 50, clay: 60, iron: 20 },
    costFactor: 1.27,
    effect: { kind: 'production', resource: 'wood', perLevel: 1 },
    initialLevel: 1,
  },
  clay_pit: {
    id: 'clay_pit',
    name: 'Cegielnia',
    desc: 'Wydobywa glinę. Każdy poziom zwiększa produkcję gliny.',
    category: 'economy',
    maxLevel: 30,
    baseCost: { wood: 65, clay: 50, iron: 20 },
    costFactor: 1.27,
    effect: { kind: 'production', resource: 'clay', perLevel: 0.8 },
    initialLevel: 1,
  },
  iron_mine: {
    id: 'iron_mine',
    name: 'Huta żelaza',
    desc: 'Wytapia żelazo. Każdy poziom zwiększa produkcję żelaza.',
    category: 'economy',
    maxLevel: 30,
    baseCost: { wood: 75, clay: 65, iron: 40 },
    costFactor: 1.28,
    effect: { kind: 'production', resource: 'iron', perLevel: 0.5 },
    initialLevel: 1,
  },
  warehouse: {
    id: 'warehouse',
    name: 'Spichlerz',
    desc: 'Magazynuje surowce. Każdy poziom zwiększa pojemność magazynu.',
    category: 'storage',
    maxLevel: 30,
    // perLevel is sized to the late-game economy now that M1.2 added the recruitment
    // SINK: the cap (base 1000 + 30*3000 = 91000 at max) sits ~1.5x above the single
    // most expensive purchase the bot ever makes — warehouse L29->30, wood ~60.5k at
    // the cost_reduction floor (0.5) — so resources can always accumulate enough to
    // afford any building (no pre-frontier softlock) WITHOUT being inflated to hide
    // the content frontier. cap@L29 (1000+29*3000 = 88000) is the binding case since
    // warehouse, the fastest-growing cost (factor 1.3), is the last building maxed.
    // M1.1 deliberately oversized this (perLevel 25000 -> cap 751000) to dodge a
    // no-softlock failure it could not yet classify; the content-aware no-softlock
    // check now lets us run the honest cap and report the capped frontier as a
    // WARNING instead. Storage stays LINEAR (the engine's storage effect) and the
    // cap scales from the building, not a huge base constant.
    costFactor: 1.3,
    baseCost: { wood: 60, clay: 50, iron: 40 },
    effect: { kind: 'storage', perLevel: 3000 },
    initialLevel: 1,
  },
  farm: {
    id: 'farm',
    name: 'Zagroda',
    desc: 'Wyżywia mieszkańców. Każdy poziom zwiększa limit populacji.',
    category: 'core',
    maxLevel: 30,
    baseCost: { wood: 45, clay: 40, iron: 30 },
    costFactor: 1.25,
    effect: { kind: 'population', perLevel: 12 },
    initialLevel: 1,
  },
  barracks: {
    id: 'barracks',
    name: 'Koszary',
    desc: 'Szkoli jednostki. Poziom 1 odblokowuje rekrutację; każdy kolejny skraca czas szkolenia.',
    category: 'military',
    maxLevel: 25,
    baseCost: { wood: 200, clay: 170, iron: 90 },
    costFactor: 1.28,
    // -5% training time per level (multiplicative), floored in recruitSpeedMult.
    effect: { kind: 'recruit_speed', perLevel: 0.05 },
    // Starts at 0: building it to level 1 is the first real expansion goal — the
    // gate that unlocks unit recruitment (a brand-new resource sink in M1.2).
    initialLevel: 0,
  },
  academy: {
    id: 'academy',
    name: 'Pałac',
    desc: 'Pozwala szkolić szlachcica i przejmować wioski barbarzyńskie.',
    category: 'military',
    // Binary gate (noble_unlock) — level 1 already unlocks the noble; the few extra
    // levels exist only so the building reads like the others (finite ceiling).
    maxLevel: 3,
    baseCost: { wood: 15000, clay: 15000, iron: 15000 },
    costFactor: 1.6,
    effect: { kind: 'noble_unlock' },
    // Starts at 0: building it is the late-M2 expansion goal that opens conquest.
    initialLevel: 0,
  },
}
