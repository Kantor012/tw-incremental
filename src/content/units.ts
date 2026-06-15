/**
 * Unit catalogue — PURE DATA (no engine logic lives here).
 *
 * Mirrors the buildings catalogue contract (src/content/buildings.ts): adding or
 * rebalancing a unit is an edit to this file, never to the engine. The recruitment
 * engine (src/systems/recruitment.ts) reads these definitions; the tick advances
 * in-flight orders. Combat stats (attack/def/carry/speed) are STORED here now and
 * only displayed in M1.2 — the battle system (M1.3) consumes them later.
 *
 * Import discipline: this module imports only the *type* `BuildingId` (erased at
 * runtime), so it stays a pure leaf and can never take part in an initialisation
 * cycle: buildings.ts does NOT import units.ts, and state/save/recruitment all
 * import from here, never the other way around. Costs are plain `number` (small,
 * fixed catalogue data); the live economy turns them into Decimal at spend time —
 * the "economy on Decimal" rule applies to resource amounts/production, not to the
 * authored cost constants.
 */

import type { BuildingId } from './buildings'

export type UnitId = 'spearman' | 'swordsman' | 'axeman' | 'noble' | 'scout'

/**
 * Stable iteration order for population roll-up, save validation and UI listing.
 * New units are APPENDED (here `scout`, after `noble`) so older saves' roster key
 * order is never disturbed, keeping migration and round-trip deterministic.
 */
export const UNIT_IDS: readonly UnitId[] = ['spearman', 'swordsman', 'axeman', 'noble', 'scout']

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
  /**
   * Building that must be built (level >= 1) before this unit can be recruited.
   * DATA, not engine: recruitment gates on `v.buildings[requires] > 0` (see
   * unitUnlocked in recruitment.ts), so a unit's unlock is a single edit here.
   * The infantry triad requires the barracks; the noble requires the academy.
   */
  requires: BuildingId
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
    requires: 'barracks',
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
    requires: 'barracks',
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
    requires: 'barracks',
    attack: 40,
    defInfantry: 10,
    defCavalry: 5,
    carry: 10,
    speed: 18,
  },
  // The Szlachcic (noble): not a battle unit but a CONQUEST tool. Sent with an
  // attacking army, every survivor of a won fight knocks the target's loyalty down
  // (conquest.ts); drive it to <= 0 and the barbarian village is captured. It is
  // deliberately very expensive, population-heavy and slow, and gated behind the
  // academy (Palac), so taking a village is a sustained investment, not a one-shot.
  // Numbers provisional — the Balance phase tunes them against the harness targets.
  noble: {
    id: 'noble',
    name: 'Szlachcic',
    desc: 'Obniża lojalność wioski; po serii udanych ataków przejmujesz wioskę. Bardzo drogi, wolny.',
    cost: { wood: 8000, clay: 8000, iron: 8000 },
    pop: 10,
    recruitSeconds: 600,
    requires: 'academy',
    attack: 30,
    defInfantry: 30,
    defCavalry: 30,
    carry: 0,
    speed: 35,
  },
  // The Zwiadowca (scout): not a soldier but a RECON tool (M5.2). Sent at a barbarian
  // camp, it reveals that camp's defence/loot (BarbarianVillage.scouted) and returns
  // home unharmed — it never fights and never loots (attack 0, carry 0). Fast (lowest
  // min/field) and cheap so reconnaissance is quick and low-stakes. Gated behind the
  // barracks like the infantry triad. Auto-attack deliberately excludes it (it would
  // add no attack power), keeping the bot's behaviour — and the 17 balance goals —
  // unchanged. Numbers provisional; the Balance phase tunes them against the harness.
  scout: {
    id: 'scout',
    name: 'Zwiadowca',
    desc: 'Szybki zwiad. Odkrywa obronę i łup obozu barbarzyńskiego; nie walczy i nie bierze łupu.',
    cost: { wood: 50, clay: 30, iron: 20 },
    pop: 1,
    recruitSeconds: 40,
    requires: 'barracks',
    attack: 0,
    defInfantry: 2,
    defCavalry: 2,
    carry: 0,
    // Fastest unit (lowest min/field) — recon should outrun the standing army.
    speed: 9,
  },
}
