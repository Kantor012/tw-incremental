/**
 * Unit catalogue — PURE DATA (no engine logic lives here).
 *
 * Mirrors the buildings catalogue contract (src/content/buildings.ts): adding or
 * rebalancing a unit is an edit to this file, never to the engine. The recruitment
 * engine (src/systems/recruitment.ts) reads these definitions; the tick advances
 * in-flight orders. Combat stats (attack/def/carry/speed) are STORED here now and
 * only displayed in M1.2 — the battle system (M1.3) consumes them later.
 *
 * Import discipline: this module imports NOTHING at runtime, so it is a pure leaf
 * and can never take part in an initialisation cycle (state/save/recruitment all
 * import from here, never the other way around). Costs are plain `number` (small,
 * fixed catalogue data); the live economy turns them into Decimal at spend time —
 * the "economy on Decimal" rule applies to resource amounts/production, not to the
 * authored cost constants.
 */

export type UnitId = 'spearman' | 'swordsman' | 'axeman'

/** Stable iteration order for population roll-up, save validation and UI listing. */
export const UNIT_IDS: readonly UnitId[] = ['spearman', 'swordsman', 'axeman']

export interface UnitDef {
  id: UnitId
  /** Display name (PL). */
  name: string
  /** Short description (PL). */
  desc: string
  /** Cost per single unit, per base resource (small fixed data → plain number). */
  cost: { wood: number; clay: number; iron: number }
  /** Population (farm) upkeep per unit. */
  pop: number
  /** Base seconds to train ONE unit at barracks level 1 (before recruit_speed). */
  recruitSeconds: number
  /** Offensive power (battle, M1.3). */
  attack: number
  /** Defensive power vs infantry (battle, M1.3). */
  defInfantry: number
  /** Defensive power vs cavalry (battle, M1.3). */
  defCavalry: number
  /** Resources a unit can haul when raiding (battle/expansion, M1.3). */
  carry: number
  /** Travel speed, minutes per field — lower is faster (expansion, M1.3). */
  speed: number
}

/**
 * Starting unit roster — classic TW infantry triad:
 *  - Pikinier  (spearman):  cheap, strong defence vs cavalry, the bread-and-butter wall.
 *  - Miecznik  (swordsman): iron-heavy, strong defence vs infantry.
 *  - Topornik  (axeman):    the offensive workhorse — high attack, fragile on defence.
 * `recruitSeconds` rises with raw power (80 → 110 → 130). pop = 1 each.
 */
export const UNITS: Record<UnitId, UnitDef> = {
  spearman: {
    id: 'spearman',
    name: 'Pikinier',
    desc: 'Tania piechota obronna. Doskonały w obronie przed kawalerią; dźwiga też pokaźny łup.',
    cost: { wood: 50, clay: 30, iron: 10 },
    pop: 1,
    recruitSeconds: 80,
    attack: 10,
    defInfantry: 15,
    defCavalry: 45,
    // Carry is the lever that makes PvE attacks pay for themselves: loot is
    // min(carry, camp loot), and the bot fields the cheapest unit (the Pikinier) as
    // its raider, so its haul must beat the replacement cost of the ~30% attrition a
    // win costs against the test-locked unit price (90). Tuned 25 -> 50 so a march
    // nets resources instead of bleeding them (see CHANGELOG "Balance"). The other
    // units' carry / the loot base are pinned by unit tests, so the Pikinier carries
    // the loot economy until cavalry (a proper high-carry raider) arrives in M2+.
    carry: 50,
    speed: 18,
  },
  swordsman: {
    id: 'swordsman',
    name: 'Miecznik',
    desc: 'Ciężka piechota obronna. Najlepszy w obronie przed piechotą.',
    cost: { wood: 30, clay: 30, iron: 70 },
    pop: 1,
    recruitSeconds: 110,
    attack: 25,
    defInfantry: 50,
    defCavalry: 25,
    carry: 15,
    speed: 22,
  },
  axeman: {
    id: 'axeman',
    name: 'Topornik',
    desc: 'Podstawowa jednostka ofensywna. Wysoki atak, słaba obrona.',
    cost: { wood: 60, clay: 30, iron: 40 },
    pop: 1,
    recruitSeconds: 130,
    attack: 40,
    defInfantry: 10,
    defCavalry: 5,
    carry: 10,
    speed: 18,
  },
}
