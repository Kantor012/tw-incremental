import type { ResourceId } from '../engine/state'

/**
 * Tech (passive) tree catalogue — PURE DATA (no engine logic lives here).
 *
 * The global, account-wide passive tree (M3.1) is a Path-of-Exile-style radial
 * constellation of CLUSTERS (the authoring unit: one notable + a ring of minor
 * nodes, with a handful of gateways on the junctions). A node has a FINITE
 * `maxLevel` (1..10, chosen by archetype), costs resources from the GLOBAL pool
 * (summed across all villages) and applies an ECONOMIC multiplier (production /
 * storage / population). Effects are folded in one place —
 * `recomputeVillageDerived` via `aggregateTechMods` — so the rest of the
 * simulation (combat, marches) is untouched until M3.2.
 *
 * Import discipline: this module imports only the *type* `ResourceId` from
 * state.ts (erased at runtime), so it has no runtime dependency back on the engine
 * and can never form an initialisation cycle (mirrors content/buildings.ts).
 *
 * SHAPE (the contract): the types below, plus the full STARTING tree — 72 nodes
 * across 12 clusters in 3 categories (economy/storage/settlement), each cluster a
 * notable (maxLevel 2-3) + a ring of minors (maxLevel 7-10), 3 expensive gateways
 * (maxLevel 1) on the junctions into the "master" clusters. Prerequisites form a
 * DAG with no cycles where every node is reachable from a root and every node has
 * a real effect (perLevel > 0). No x/y here — the radial layout is COMPUTED from
 * the prerequisite topology by systems/techLayout.ts (never hand-placed). Costs
 * (baseCost/costFactor) are provisional — the Balance phase tunes them so the tree
 * is a real sink that scales with the empire and is bought gradually.
 */

/**
 * Top-level branch of the constellation. The three starting categories map 1:1
 * onto the three M3.1 economic effects (economy -> production, storage -> storage,
 * settlement -> population). Extensible in M3.2 (new categories add new arms).
 */
export type TechCategory = 'economy' | 'storage' | 'settlement'

/**
 * Node role, which fixes the `maxLevel` band (CLAUDE.md tree rule):
 *  - minor:    drobny bonus na poziom -> maxLevel 7-10
 *  - notable:  silny nazwany efekt    -> maxLevel 2-3
 *  - gateway:  binarne odblokowanie / rozjazd -> maxLevel 1 (drogie)
 */
export type TechArchetype = 'minor' | 'notable' | 'gateway'

/**
 * What a tech node *does*, as a discriminated union. `perLevel` is a FRACTION added
 * per owned level to the relevant multiplier (e.g. 0.03 = +3%/level); the engine
 * sums `perLevel * level` across nodes into `1 + Σ` (see aggregateTechMods):
 *  - production_mult: scales production. `resource` absent = ALL resources.
 *  - storage_mult:    scales the storage cap.
 *  - pop_mult:        scales the population cap.
 *
 * M3.2 will add: cost_reduction, recruit_speed, march_speed, attack_mult,
 * defense_mult, loot_mult (new kinds = the only thing needing a new engine branch).
 */
export type TechEffect =
  | { kind: 'production_mult'; resource?: ResourceId; perLevel: number }
  | { kind: 'storage_mult'; perLevel: number }
  | { kind: 'pop_mult'; perLevel: number }

export interface TechNode {
  /** Stable id (the key under {@link TECH_NODES}); what prerequisites point at. */
  id: string
  /** Display name (PL). */
  name: string
  /** Short description (PL). */
  desc: string
  category: TechCategory
  /** Id of the owning cluster (authoring unit: notable + ring of minors). */
  cluster: string
  archetype: TechArchetype
  /** Finite upgrade ceiling, 1..10, sized to the archetype (CLAUDE.md). */
  maxLevel: number
  /** Ids of nodes that must be at level >= 1 before this node is available (DAG). */
  prerequisites: string[]
  /** Cost of the *first* level (level 0 -> 1), per resource. */
  baseCost: { wood: number; clay: number; iron: number }
  /** Geometric cost growth per owned level. */
  costFactor: number
  effect: TechEffect
}

/**
 * The full STARTING passive tree (M3.1). 72 nodes, 12 clusters, 3 categories:
 *
 *  - economy   (6 clusters): production_mult — eco_core (entry, all res) -> three
 *              per-resource clusters (wood/clay/iron) -> eco_industry (all res,
 *              converges the three) -> eco_master (all res, behind the eco gateway).
 *  - storage   (3 clusters): storage_mult — sto_core -> sto_deep -> sto_master
 *              (behind the storage gateway).
 *  - settlement(3 clusters): pop_mult — set_core -> set_deep -> set_master (behind
 *              the settlement gateway).
 *
 * Each cluster = one notable (maxLevel 2-3, strong named effect) + a ring of 4-5
 * minors (maxLevel 7-10, drobny effect). Three gateways (maxLevel 1, drogie) gate
 * the "master" clusters. Roots (eco_root/sto_root/set_root) have no prerequisites
 * — one per category. Prerequisites are a DAG with no cycles; every node is
 * reachable from a root and every node has a real effect (perLevel > 0).
 *
 * Object key order IS the stable source order driving every order-sensitive pass
 * (aggregateTechMods, layout, validation, the sim) — keep new nodes appended when
 * extending in M3.2 so saves/round-trips stay reproducible.
 */
export const TECH_NODES: Record<string, TechNode> = {
  // =====================================================================
  // ECONOMY arm — production_mult
  // =====================================================================

  // --- eco_core: entry cluster (all resources) -------------------------
  eco_root: {
    id: 'eco_root',
    name: 'Gospodarka',
    desc: 'Wejście do gałęzi gospodarczej. Niewielki wzrost produkcji wszystkich surowców na poziom.',
    category: 'economy',
    cluster: 'eco_core',
    archetype: 'minor',
    maxLevel: 8,
    prerequisites: [],
    baseCost: { wood: 120, clay: 120, iron: 120 },
    costFactor: 1.28,
    effect: { kind: 'production_mult', perLevel: 0.02 },
  },
  eco_core_n: {
    id: 'eco_core_n',
    name: 'Sprawne warsztaty',
    desc: 'Notable gospodarki: znaczny wzrost produkcji wszystkich surowców.',
    category: 'economy',
    cluster: 'eco_core',
    archetype: 'notable',
    maxLevel: 3,
    prerequisites: ['eco_root'],
    baseCost: { wood: 400, clay: 400, iron: 400 },
    costFactor: 1.55,
    effect: { kind: 'production_mult', perLevel: 0.06 },
  },
  eco_core_m1: {
    id: 'eco_core_m1',
    name: 'Drobni rzemieślnicy',
    desc: 'Marginalny, lecz głęboki wzrost produkcji wszystkich surowców.',
    category: 'economy',
    cluster: 'eco_core',
    archetype: 'minor',
    maxLevel: 10,
    prerequisites: ['eco_root'],
    baseCost: { wood: 150, clay: 150, iron: 150 },
    costFactor: 1.28,
    effect: { kind: 'production_mult', perLevel: 0.012 },
  },
  eco_core_m2: {
    id: 'eco_core_m2',
    name: 'Targowe szlaki',
    desc: 'Drobny wzrost produkcji wszystkich surowców.',
    category: 'economy',
    cluster: 'eco_core',
    archetype: 'minor',
    maxLevel: 8,
    prerequisites: ['eco_root'],
    baseCost: { wood: 160, clay: 160, iron: 160 },
    costFactor: 1.28,
    effect: { kind: 'production_mult', perLevel: 0.02 },
  },
  eco_core_m3: {
    id: 'eco_core_m3',
    name: 'Cechy rzemieślnicze',
    desc: 'Drobny wzrost produkcji wszystkich surowców.',
    category: 'economy',
    cluster: 'eco_core',
    archetype: 'minor',
    maxLevel: 8,
    prerequisites: ['eco_core_n'],
    baseCost: { wood: 170, clay: 170, iron: 170 },
    costFactor: 1.28,
    effect: { kind: 'production_mult', perLevel: 0.02 },
  },
  eco_core_m4: {
    id: 'eco_core_m4',
    name: 'Wydajne narzędzia',
    desc: 'Wyraźny wzrost produkcji wszystkich surowców.',
    category: 'economy',
    cluster: 'eco_core',
    archetype: 'minor',
    maxLevel: 7,
    prerequisites: ['eco_core_n'],
    baseCost: { wood: 200, clay: 200, iron: 200 },
    costFactor: 1.3,
    effect: { kind: 'production_mult', perLevel: 0.025 },
  },

  // --- eco_wood: drewno cluster ----------------------------------------
  eco_wood_n: {
    id: 'eco_wood_n',
    name: 'Leśne gospodarstwa',
    desc: 'Notable drewna: znaczny wzrost produkcji drewna.',
    category: 'economy',
    cluster: 'eco_wood',
    archetype: 'notable',
    maxLevel: 3,
    prerequisites: ['eco_core_n'],
    baseCost: { wood: 800, clay: 500, iron: 500 },
    costFactor: 1.5,
    effect: { kind: 'production_mult', resource: 'wood', perLevel: 0.08 },
  },
  eco_wood_m1: {
    id: 'eco_wood_m1',
    name: 'Ostrzone topory',
    desc: 'Wzrost produkcji drewna.',
    category: 'economy',
    cluster: 'eco_wood',
    archetype: 'minor',
    maxLevel: 8,
    prerequisites: ['eco_wood_n'],
    baseCost: { wood: 280, clay: 180, iron: 180 },
    costFactor: 1.3,
    effect: { kind: 'production_mult', resource: 'wood', perLevel: 0.025 },
  },
  eco_wood_m2: {
    id: 'eco_wood_m2',
    name: 'Spławianie drewna',
    desc: 'Wzrost produkcji drewna.',
    category: 'economy',
    cluster: 'eco_wood',
    archetype: 'minor',
    maxLevel: 8,
    prerequisites: ['eco_wood_n'],
    baseCost: { wood: 300, clay: 200, iron: 200 },
    costFactor: 1.3,
    effect: { kind: 'production_mult', resource: 'wood', perLevel: 0.025 },
  },
  eco_wood_m3: {
    id: 'eco_wood_m3',
    name: 'Karczownicy',
    desc: 'Wyraźny wzrost produkcji drewna.',
    category: 'economy',
    cluster: 'eco_wood',
    archetype: 'minor',
    maxLevel: 7,
    prerequisites: ['eco_wood_m1'],
    baseCost: { wood: 320, clay: 200, iron: 200 },
    costFactor: 1.3,
    effect: { kind: 'production_mult', resource: 'wood', perLevel: 0.03 },
  },
  eco_wood_m4: {
    id: 'eco_wood_m4',
    name: 'Sezonowanie drewna',
    desc: 'Marginalny, głęboki wzrost produkcji drewna.',
    category: 'economy',
    cluster: 'eco_wood',
    archetype: 'minor',
    maxLevel: 10,
    prerequisites: ['eco_wood_m2'],
    baseCost: { wood: 260, clay: 160, iron: 160 },
    costFactor: 1.28,
    effect: { kind: 'production_mult', resource: 'wood', perLevel: 0.015 },
  },
  eco_wood_m5: {
    id: 'eco_wood_m5',
    name: 'Trakty leśne',
    desc: 'Wzrost produkcji drewna.',
    category: 'economy',
    cluster: 'eco_wood',
    archetype: 'minor',
    maxLevel: 8,
    prerequisites: ['eco_wood_n'],
    baseCost: { wood: 300, clay: 200, iron: 200 },
    costFactor: 1.3,
    effect: { kind: 'production_mult', resource: 'wood', perLevel: 0.02 },
  },

  // --- eco_clay: glina cluster -----------------------------------------
  eco_clay_n: {
    id: 'eco_clay_n',
    name: 'Wielkie gliniska',
    desc: 'Notable gliny: znaczny wzrost produkcji gliny.',
    category: 'economy',
    cluster: 'eco_clay',
    archetype: 'notable',
    maxLevel: 3,
    prerequisites: ['eco_core_n'],
    baseCost: { wood: 500, clay: 800, iron: 500 },
    costFactor: 1.5,
    effect: { kind: 'production_mult', resource: 'clay', perLevel: 0.08 },
  },
  eco_clay_m1: {
    id: 'eco_clay_m1',
    name: 'Ubijaki gliny',
    desc: 'Wzrost produkcji gliny.',
    category: 'economy',
    cluster: 'eco_clay',
    archetype: 'minor',
    maxLevel: 8,
    prerequisites: ['eco_clay_n'],
    baseCost: { wood: 180, clay: 280, iron: 180 },
    costFactor: 1.3,
    effect: { kind: 'production_mult', resource: 'clay', perLevel: 0.025 },
  },
  eco_clay_m2: {
    id: 'eco_clay_m2',
    name: 'Suszarnie cegieł',
    desc: 'Wzrost produkcji gliny.',
    category: 'economy',
    cluster: 'eco_clay',
    archetype: 'minor',
    maxLevel: 8,
    prerequisites: ['eco_clay_n'],
    baseCost: { wood: 200, clay: 300, iron: 200 },
    costFactor: 1.3,
    effect: { kind: 'production_mult', resource: 'clay', perLevel: 0.025 },
  },
  eco_clay_m3: {
    id: 'eco_clay_m3',
    name: 'Głębokie wykopy',
    desc: 'Wyraźny wzrost produkcji gliny.',
    category: 'economy',
    cluster: 'eco_clay',
    archetype: 'minor',
    maxLevel: 7,
    prerequisites: ['eco_clay_m1'],
    baseCost: { wood: 200, clay: 320, iron: 200 },
    costFactor: 1.3,
    effect: { kind: 'production_mult', resource: 'clay', perLevel: 0.03 },
  },
  eco_clay_m4: {
    id: 'eco_clay_m4',
    name: 'Formy ceglane',
    desc: 'Marginalny, głęboki wzrost produkcji gliny.',
    category: 'economy',
    cluster: 'eco_clay',
    archetype: 'minor',
    maxLevel: 10,
    prerequisites: ['eco_clay_m2'],
    baseCost: { wood: 160, clay: 260, iron: 160 },
    costFactor: 1.28,
    effect: { kind: 'production_mult', resource: 'clay', perLevel: 0.015 },
  },
  eco_clay_m5: {
    id: 'eco_clay_m5',
    name: 'Piece do wypału',
    desc: 'Wzrost produkcji gliny.',
    category: 'economy',
    cluster: 'eco_clay',
    archetype: 'minor',
    maxLevel: 8,
    prerequisites: ['eco_clay_n'],
    baseCost: { wood: 200, clay: 300, iron: 200 },
    costFactor: 1.3,
    effect: { kind: 'production_mult', resource: 'clay', perLevel: 0.02 },
  },

  // --- eco_iron: żelazo cluster ----------------------------------------
  eco_iron_n: {
    id: 'eco_iron_n',
    name: 'Bogate złoża',
    desc: 'Notable żelaza: znaczny wzrost produkcji żelaza.',
    category: 'economy',
    cluster: 'eco_iron',
    archetype: 'notable',
    maxLevel: 3,
    prerequisites: ['eco_core_n'],
    baseCost: { wood: 500, clay: 500, iron: 800 },
    costFactor: 1.5,
    effect: { kind: 'production_mult', resource: 'iron', perLevel: 0.08 },
  },
  eco_iron_m1: {
    id: 'eco_iron_m1',
    name: 'Miechy kowalskie',
    desc: 'Wzrost produkcji żelaza.',
    category: 'economy',
    cluster: 'eco_iron',
    archetype: 'minor',
    maxLevel: 8,
    prerequisites: ['eco_iron_n'],
    baseCost: { wood: 180, clay: 180, iron: 280 },
    costFactor: 1.3,
    effect: { kind: 'production_mult', resource: 'iron', perLevel: 0.025 },
  },
  eco_iron_m2: {
    id: 'eco_iron_m2',
    name: 'Sztolnie',
    desc: 'Wzrost produkcji żelaza.',
    category: 'economy',
    cluster: 'eco_iron',
    archetype: 'minor',
    maxLevel: 8,
    prerequisites: ['eco_iron_n'],
    baseCost: { wood: 200, clay: 200, iron: 300 },
    costFactor: 1.3,
    effect: { kind: 'production_mult', resource: 'iron', perLevel: 0.025 },
  },
  eco_iron_m3: {
    id: 'eco_iron_m3',
    name: 'Wytapianie rud',
    desc: 'Wyraźny wzrost produkcji żelaza.',
    category: 'economy',
    cluster: 'eco_iron',
    archetype: 'minor',
    maxLevel: 7,
    prerequisites: ['eco_iron_m1'],
    baseCost: { wood: 200, clay: 200, iron: 320 },
    costFactor: 1.3,
    effect: { kind: 'production_mult', resource: 'iron', perLevel: 0.03 },
  },
  eco_iron_m4: {
    id: 'eco_iron_m4',
    name: 'Hartowanie',
    desc: 'Marginalny, głęboki wzrost produkcji żelaza.',
    category: 'economy',
    cluster: 'eco_iron',
    archetype: 'minor',
    maxLevel: 10,
    prerequisites: ['eco_iron_m2'],
    baseCost: { wood: 160, clay: 160, iron: 260 },
    costFactor: 1.28,
    effect: { kind: 'production_mult', resource: 'iron', perLevel: 0.015 },
  },
  eco_iron_m5: {
    id: 'eco_iron_m5',
    name: 'Dymarki',
    desc: 'Wzrost produkcji żelaza.',
    category: 'economy',
    cluster: 'eco_iron',
    archetype: 'minor',
    maxLevel: 8,
    prerequisites: ['eco_iron_n'],
    baseCost: { wood: 200, clay: 200, iron: 300 },
    costFactor: 1.3,
    effect: { kind: 'production_mult', resource: 'iron', perLevel: 0.02 },
  },

  // --- eco_industry: konwergencja (all res) ----------------------------
  eco_industry_n: {
    id: 'eco_industry_n',
    name: 'Manufaktury',
    desc: 'Notable przemysłu: silny wzrost produkcji wszystkich surowców. Zbiega trzy gałęzie surowcowe.',
    category: 'economy',
    cluster: 'eco_industry',
    archetype: 'notable',
    maxLevel: 3,
    prerequisites: ['eco_wood_n', 'eco_clay_n', 'eco_iron_n'],
    baseCost: { wood: 2000, clay: 2000, iron: 2000 },
    costFactor: 1.55,
    effect: { kind: 'production_mult', perLevel: 0.07 },
  },
  eco_industry_m1: {
    id: 'eco_industry_m1',
    name: 'Podział pracy',
    desc: 'Wzrost produkcji wszystkich surowców.',
    category: 'economy',
    cluster: 'eco_industry',
    archetype: 'minor',
    maxLevel: 8,
    prerequisites: ['eco_industry_n'],
    baseCost: { wood: 700, clay: 700, iron: 700 },
    costFactor: 1.32,
    effect: { kind: 'production_mult', perLevel: 0.02 },
  },
  eco_industry_m2: {
    id: 'eco_industry_m2',
    name: 'Koła wodne',
    desc: 'Wzrost produkcji wszystkich surowców.',
    category: 'economy',
    cluster: 'eco_industry',
    archetype: 'minor',
    maxLevel: 8,
    prerequisites: ['eco_industry_n'],
    baseCost: { wood: 750, clay: 750, iron: 750 },
    costFactor: 1.32,
    effect: { kind: 'production_mult', perLevel: 0.02 },
  },
  eco_industry_m3: {
    id: 'eco_industry_m3',
    name: 'Magazyny surowca',
    desc: 'Wyraźny wzrost produkcji wszystkich surowców.',
    category: 'economy',
    cluster: 'eco_industry',
    archetype: 'minor',
    maxLevel: 7,
    prerequisites: ['eco_industry_m1'],
    baseCost: { wood: 800, clay: 800, iron: 800 },
    costFactor: 1.33,
    effect: { kind: 'production_mult', perLevel: 0.025 },
  },
  eco_industry_m4: {
    id: 'eco_industry_m4',
    name: 'Księgi rachunkowe',
    desc: 'Marginalny, głęboki wzrost produkcji wszystkich surowców.',
    category: 'economy',
    cluster: 'eco_industry',
    archetype: 'minor',
    maxLevel: 10,
    prerequisites: ['eco_industry_m2'],
    baseCost: { wood: 650, clay: 650, iron: 650 },
    costFactor: 1.3,
    effect: { kind: 'production_mult', perLevel: 0.012 },
  },
  eco_industry_m5: {
    id: 'eco_industry_m5',
    name: 'Gildie kupieckie',
    desc: 'Wzrost produkcji wszystkich surowców.',
    category: 'economy',
    cluster: 'eco_industry',
    archetype: 'minor',
    maxLevel: 8,
    prerequisites: ['eco_industry_n'],
    baseCost: { wood: 750, clay: 750, iron: 750 },
    costFactor: 1.32,
    effect: { kind: 'production_mult', perLevel: 0.02 },
  },

  // --- eco_master: gateway + szczyt gospodarki (all res) ---------------
  eco_gateway: {
    id: 'eco_gateway',
    name: 'Rewolucja przemysłowa',
    desc: 'Brama przemysłu (drogie, jednorazowe): trwały wzrost produkcji wszystkich surowców. Odsłania szczytowy klaster gospodarki.',
    category: 'economy',
    cluster: 'eco_master',
    archetype: 'gateway',
    maxLevel: 1,
    prerequisites: ['eco_industry_n'],
    baseCost: { wood: 8000, clay: 8000, iron: 8000 },
    costFactor: 1.0,
    effect: { kind: 'production_mult', perLevel: 0.05 },
  },
  eco_master_n: {
    id: 'eco_master_n',
    name: 'Imperium handlowe',
    desc: 'Szczytowy notable gospodarki: bardzo silny wzrost produkcji wszystkich surowców.',
    category: 'economy',
    cluster: 'eco_master',
    archetype: 'notable',
    maxLevel: 3,
    prerequisites: ['eco_gateway'],
    baseCost: { wood: 6000, clay: 6000, iron: 6000 },
    costFactor: 1.6,
    effect: { kind: 'production_mult', perLevel: 0.1 },
  },
  eco_master_m1: {
    id: 'eco_master_m1',
    name: 'Banki kupieckie',
    desc: 'Znaczny wzrost produkcji wszystkich surowców.',
    category: 'economy',
    cluster: 'eco_master',
    archetype: 'minor',
    maxLevel: 8,
    prerequisites: ['eco_master_n'],
    baseCost: { wood: 2500, clay: 2500, iron: 2500 },
    costFactor: 1.35,
    effect: { kind: 'production_mult', perLevel: 0.025 },
  },
  eco_master_m2: {
    id: 'eco_master_m2',
    name: 'Floty handlowe',
    desc: 'Znaczny wzrost produkcji wszystkich surowców.',
    category: 'economy',
    cluster: 'eco_master',
    archetype: 'minor',
    maxLevel: 8,
    prerequisites: ['eco_master_n'],
    baseCost: { wood: 2700, clay: 2700, iron: 2700 },
    costFactor: 1.35,
    effect: { kind: 'production_mult', perLevel: 0.025 },
  },
  eco_master_m3: {
    id: 'eco_master_m3',
    name: 'Monopole surowcowe',
    desc: 'Silny wzrost produkcji wszystkich surowców.',
    category: 'economy',
    cluster: 'eco_master',
    archetype: 'minor',
    maxLevel: 7,
    prerequisites: ['eco_master_m1'],
    baseCost: { wood: 3000, clay: 3000, iron: 3000 },
    costFactor: 1.36,
    effect: { kind: 'production_mult', perLevel: 0.03 },
  },
  eco_master_m4: {
    id: 'eco_master_m4',
    name: 'Kontrakty dalekosiężne',
    desc: 'Marginalny, głęboki wzrost produkcji wszystkich surowców.',
    category: 'economy',
    cluster: 'eco_master',
    archetype: 'minor',
    maxLevel: 10,
    prerequisites: ['eco_master_m2'],
    baseCost: { wood: 2300, clay: 2300, iron: 2300 },
    costFactor: 1.33,
    effect: { kind: 'production_mult', perLevel: 0.015 },
  },

  // =====================================================================
  // STORAGE arm — storage_mult
  // =====================================================================

  // --- sto_core: entry cluster -----------------------------------------
  sto_root: {
    id: 'sto_root',
    name: 'Magazyny',
    desc: 'Wejście do gałęzi magazynowej. Niewielki wzrost pojemności magazynu na poziom.',
    category: 'storage',
    cluster: 'sto_core',
    archetype: 'minor',
    maxLevel: 8,
    prerequisites: [],
    baseCost: { wood: 120, clay: 120, iron: 90 },
    costFactor: 1.28,
    effect: { kind: 'storage_mult', perLevel: 0.02 },
  },
  sto_core_n: {
    id: 'sto_core_n',
    name: 'Głębokie składy',
    desc: 'Notable magazynów: znaczny wzrost pojemności magazynu.',
    category: 'storage',
    cluster: 'sto_core',
    archetype: 'notable',
    maxLevel: 3,
    prerequisites: ['sto_root'],
    baseCost: { wood: 450, clay: 450, iron: 350 },
    costFactor: 1.55,
    effect: { kind: 'storage_mult', perLevel: 0.07 },
  },
  sto_core_m1: {
    id: 'sto_core_m1',
    name: 'Półki i regały',
    desc: 'Marginalny, głęboki wzrost pojemności magazynu.',
    category: 'storage',
    cluster: 'sto_core',
    archetype: 'minor',
    maxLevel: 10,
    prerequisites: ['sto_root'],
    baseCost: { wood: 150, clay: 150, iron: 120 },
    costFactor: 1.28,
    effect: { kind: 'storage_mult', perLevel: 0.012 },
  },
  sto_core_m2: {
    id: 'sto_core_m2',
    name: 'Zadaszone składy',
    desc: 'Drobny wzrost pojemności magazynu.',
    category: 'storage',
    cluster: 'sto_core',
    archetype: 'minor',
    maxLevel: 8,
    prerequisites: ['sto_root'],
    baseCost: { wood: 160, clay: 160, iron: 130 },
    costFactor: 1.28,
    effect: { kind: 'storage_mult', perLevel: 0.02 },
  },
  sto_core_m3: {
    id: 'sto_core_m3',
    name: 'Beczki i skrzynie',
    desc: 'Drobny wzrost pojemności magazynu.',
    category: 'storage',
    cluster: 'sto_core',
    archetype: 'minor',
    maxLevel: 8,
    prerequisites: ['sto_core_n'],
    baseCost: { wood: 170, clay: 170, iron: 140 },
    costFactor: 1.28,
    effect: { kind: 'storage_mult', perLevel: 0.02 },
  },
  sto_core_m4: {
    id: 'sto_core_m4',
    name: 'Suche piwnice',
    desc: 'Wyraźny wzrost pojemności magazynu.',
    category: 'storage',
    cluster: 'sto_core',
    archetype: 'minor',
    maxLevel: 7,
    prerequisites: ['sto_core_n'],
    baseCost: { wood: 200, clay: 200, iron: 160 },
    costFactor: 1.3,
    effect: { kind: 'storage_mult', perLevel: 0.025 },
  },

  // --- sto_deep: rozbudowane magazyny ----------------------------------
  sto_deep_n: {
    id: 'sto_deep_n',
    name: 'Wzmocnione spichlerze',
    desc: 'Notable magazynów: duży wzrost pojemności magazynu.',
    category: 'storage',
    cluster: 'sto_deep',
    archetype: 'notable',
    maxLevel: 3,
    prerequisites: ['sto_core_n'],
    baseCost: { wood: 1400, clay: 1400, iron: 1100 },
    costFactor: 1.55,
    effect: { kind: 'storage_mult', perLevel: 0.08 },
  },
  sto_deep_m1: {
    id: 'sto_deep_m1',
    name: 'Kamienne fundamenty',
    desc: 'Wzrost pojemności magazynu.',
    category: 'storage',
    cluster: 'sto_deep',
    archetype: 'minor',
    maxLevel: 8,
    prerequisites: ['sto_deep_n'],
    baseCost: { wood: 500, clay: 500, iron: 400 },
    costFactor: 1.32,
    effect: { kind: 'storage_mult', perLevel: 0.02 },
  },
  sto_deep_m2: {
    id: 'sto_deep_m2',
    name: 'Wzmocnione belki',
    desc: 'Wzrost pojemności magazynu.',
    category: 'storage',
    cluster: 'sto_deep',
    archetype: 'minor',
    maxLevel: 8,
    prerequisites: ['sto_deep_n'],
    baseCost: { wood: 550, clay: 550, iron: 440 },
    costFactor: 1.32,
    effect: { kind: 'storage_mult', perLevel: 0.02 },
  },
  sto_deep_m3: {
    id: 'sto_deep_m3',
    name: 'Strażnicy zapasów',
    desc: 'Wyraźny wzrost pojemności magazynu.',
    category: 'storage',
    cluster: 'sto_deep',
    archetype: 'minor',
    maxLevel: 7,
    prerequisites: ['sto_deep_m1'],
    baseCost: { wood: 600, clay: 600, iron: 480 },
    costFactor: 1.33,
    effect: { kind: 'storage_mult', perLevel: 0.025 },
  },
  sto_deep_m4: {
    id: 'sto_deep_m4',
    name: 'Inwentaryzacja',
    desc: 'Marginalny, głęboki wzrost pojemności magazynu.',
    category: 'storage',
    cluster: 'sto_deep',
    archetype: 'minor',
    maxLevel: 10,
    prerequisites: ['sto_deep_m2'],
    baseCost: { wood: 460, clay: 460, iron: 360 },
    costFactor: 1.3,
    effect: { kind: 'storage_mult', perLevel: 0.012 },
  },
  sto_deep_m5: {
    id: 'sto_deep_m5',
    name: 'Zabezpieczenia',
    desc: 'Wzrost pojemności magazynu.',
    category: 'storage',
    cluster: 'sto_deep',
    archetype: 'minor',
    maxLevel: 8,
    prerequisites: ['sto_deep_n'],
    baseCost: { wood: 550, clay: 550, iron: 440 },
    costFactor: 1.32,
    effect: { kind: 'storage_mult', perLevel: 0.02 },
  },

  // --- sto_master: gateway + szczyt magazynów --------------------------
  sto_gateway: {
    id: 'sto_gateway',
    name: 'Wielkie składnice',
    desc: 'Brama magazynów (drogie, jednorazowe): trwały wzrost pojemności magazynu. Odsłania szczytowy klaster magazynowy.',
    category: 'storage',
    cluster: 'sto_master',
    archetype: 'gateway',
    maxLevel: 1,
    prerequisites: ['sto_deep_n'],
    baseCost: { wood: 7000, clay: 7000, iron: 6000 },
    costFactor: 1.0,
    effect: { kind: 'storage_mult', perLevel: 0.05 },
  },
  sto_master_n: {
    id: 'sto_master_n',
    name: 'Cytadele zaopatrzenia',
    desc: 'Szczytowy notable magazynów: bardzo duży wzrost pojemności magazynu.',
    category: 'storage',
    cluster: 'sto_master',
    archetype: 'notable',
    maxLevel: 3,
    prerequisites: ['sto_gateway'],
    baseCost: { wood: 5000, clay: 5000, iron: 4000 },
    costFactor: 1.6,
    effect: { kind: 'storage_mult', perLevel: 0.1 },
  },
  sto_master_m1: {
    id: 'sto_master_m1',
    name: 'Podziemne magazyny',
    desc: 'Znaczny wzrost pojemności magazynu.',
    category: 'storage',
    cluster: 'sto_master',
    archetype: 'minor',
    maxLevel: 8,
    prerequisites: ['sto_master_n'],
    baseCost: { wood: 2200, clay: 2200, iron: 1800 },
    costFactor: 1.35,
    effect: { kind: 'storage_mult', perLevel: 0.025 },
  },
  sto_master_m2: {
    id: 'sto_master_m2',
    name: 'Forteczne spichlerze',
    desc: 'Znaczny wzrost pojemności magazynu.',
    category: 'storage',
    cluster: 'sto_master',
    archetype: 'minor',
    maxLevel: 8,
    prerequisites: ['sto_master_n'],
    baseCost: { wood: 2400, clay: 2400, iron: 1900 },
    costFactor: 1.35,
    effect: { kind: 'storage_mult', perLevel: 0.025 },
  },
  sto_master_m3: {
    id: 'sto_master_m3',
    name: 'Sieci zaopatrzenia',
    desc: 'Silny wzrost pojemności magazynu.',
    category: 'storage',
    cluster: 'sto_master',
    archetype: 'minor',
    maxLevel: 7,
    prerequisites: ['sto_master_m1'],
    baseCost: { wood: 2600, clay: 2600, iron: 2100 },
    costFactor: 1.36,
    effect: { kind: 'storage_mult', perLevel: 0.03 },
  },
  sto_master_m4: {
    id: 'sto_master_m4',
    name: 'Rezerwy strategiczne',
    desc: 'Marginalny, głęboki wzrost pojemności magazynu.',
    category: 'storage',
    cluster: 'sto_master',
    archetype: 'minor',
    maxLevel: 10,
    prerequisites: ['sto_master_m2'],
    baseCost: { wood: 2000, clay: 2000, iron: 1600 },
    costFactor: 1.33,
    effect: { kind: 'storage_mult', perLevel: 0.015 },
  },

  // =====================================================================
  // SETTLEMENT arm — pop_mult
  // =====================================================================

  // --- set_core: entry cluster -----------------------------------------
  set_root: {
    id: 'set_root',
    name: 'Osadnictwo',
    desc: 'Wejście do gałęzi osadniczej. Niewielki wzrost limitu populacji na poziom.',
    category: 'settlement',
    cluster: 'set_core',
    archetype: 'minor',
    maxLevel: 8,
    prerequisites: [],
    baseCost: { wood: 90, clay: 110, iron: 110 },
    costFactor: 1.28,
    effect: { kind: 'pop_mult', perLevel: 0.02 },
  },
  set_core_n: {
    id: 'set_core_n',
    name: 'Żyzne ziemie',
    desc: 'Notable osadnictwa: znaczny wzrost limitu populacji.',
    category: 'settlement',
    cluster: 'set_core',
    archetype: 'notable',
    maxLevel: 3,
    prerequisites: ['set_root'],
    baseCost: { wood: 350, clay: 450, iron: 450 },
    costFactor: 1.55,
    effect: { kind: 'pop_mult', perLevel: 0.07 },
  },
  set_core_m1: {
    id: 'set_core_m1',
    name: 'Nowe zagrody',
    desc: 'Marginalny, głęboki wzrost limitu populacji.',
    category: 'settlement',
    cluster: 'set_core',
    archetype: 'minor',
    maxLevel: 10,
    prerequisites: ['set_root'],
    baseCost: { wood: 120, clay: 150, iron: 150 },
    costFactor: 1.28,
    effect: { kind: 'pop_mult', perLevel: 0.012 },
  },
  set_core_m2: {
    id: 'set_core_m2',
    name: 'Studnie i ujęcia',
    desc: 'Drobny wzrost limitu populacji.',
    category: 'settlement',
    cluster: 'set_core',
    archetype: 'minor',
    maxLevel: 8,
    prerequisites: ['set_root'],
    baseCost: { wood: 130, clay: 160, iron: 160 },
    costFactor: 1.28,
    effect: { kind: 'pop_mult', perLevel: 0.02 },
  },
  set_core_m3: {
    id: 'set_core_m3',
    name: 'Wspólnoty wiejskie',
    desc: 'Drobny wzrost limitu populacji.',
    category: 'settlement',
    cluster: 'set_core',
    archetype: 'minor',
    maxLevel: 8,
    prerequisites: ['set_core_n'],
    baseCost: { wood: 140, clay: 170, iron: 170 },
    costFactor: 1.28,
    effect: { kind: 'pop_mult', perLevel: 0.02 },
  },
  set_core_m4: {
    id: 'set_core_m4',
    name: 'Płodozmian',
    desc: 'Wyraźny wzrost limitu populacji.',
    category: 'settlement',
    cluster: 'set_core',
    archetype: 'minor',
    maxLevel: 7,
    prerequisites: ['set_core_n'],
    baseCost: { wood: 160, clay: 200, iron: 200 },
    costFactor: 1.3,
    effect: { kind: 'pop_mult', perLevel: 0.025 },
  },

  // --- set_deep: rozległe osadnictwo -----------------------------------
  set_deep_n: {
    id: 'set_deep_n',
    name: 'Rozległe pola',
    desc: 'Notable osadnictwa: duży wzrost limitu populacji.',
    category: 'settlement',
    cluster: 'set_deep',
    archetype: 'notable',
    maxLevel: 3,
    prerequisites: ['set_core_n'],
    baseCost: { wood: 1100, clay: 1400, iron: 1400 },
    costFactor: 1.55,
    effect: { kind: 'pop_mult', perLevel: 0.08 },
  },
  set_deep_m1: {
    id: 'set_deep_m1',
    name: 'Sady i ogrody',
    desc: 'Wzrost limitu populacji.',
    category: 'settlement',
    cluster: 'set_deep',
    archetype: 'minor',
    maxLevel: 8,
    prerequisites: ['set_deep_n'],
    baseCost: { wood: 400, clay: 500, iron: 500 },
    costFactor: 1.32,
    effect: { kind: 'pop_mult', perLevel: 0.02 },
  },
  set_deep_m2: {
    id: 'set_deep_m2',
    name: 'Pastwiska',
    desc: 'Wzrost limitu populacji.',
    category: 'settlement',
    cluster: 'set_deep',
    archetype: 'minor',
    maxLevel: 8,
    prerequisites: ['set_deep_n'],
    baseCost: { wood: 440, clay: 550, iron: 550 },
    costFactor: 1.32,
    effect: { kind: 'pop_mult', perLevel: 0.02 },
  },
  set_deep_m3: {
    id: 'set_deep_m3',
    name: 'Młyny zbożowe',
    desc: 'Wyraźny wzrost limitu populacji.',
    category: 'settlement',
    cluster: 'set_deep',
    archetype: 'minor',
    maxLevel: 7,
    prerequisites: ['set_deep_m1'],
    baseCost: { wood: 480, clay: 600, iron: 600 },
    costFactor: 1.33,
    effect: { kind: 'pop_mult', perLevel: 0.025 },
  },
  set_deep_m4: {
    id: 'set_deep_m4',
    name: 'Spichrze wiejskie',
    desc: 'Marginalny, głęboki wzrost limitu populacji.',
    category: 'settlement',
    cluster: 'set_deep',
    archetype: 'minor',
    maxLevel: 10,
    prerequisites: ['set_deep_m2'],
    baseCost: { wood: 360, clay: 460, iron: 460 },
    costFactor: 1.3,
    effect: { kind: 'pop_mult', perLevel: 0.012 },
  },
  set_deep_m5: {
    id: 'set_deep_m5',
    name: 'Drogi osadnicze',
    desc: 'Wzrost limitu populacji.',
    category: 'settlement',
    cluster: 'set_deep',
    archetype: 'minor',
    maxLevel: 8,
    prerequisites: ['set_deep_n'],
    baseCost: { wood: 440, clay: 550, iron: 550 },
    costFactor: 1.32,
    effect: { kind: 'pop_mult', perLevel: 0.02 },
  },

  // --- set_master: gateway + szczyt osadnictwa -------------------------
  set_gateway: {
    id: 'set_gateway',
    name: 'Wielkie migracje',
    desc: 'Brama osadnictwa (drogie, jednorazowe): trwały wzrost limitu populacji. Odsłania szczytowy klaster osadniczy.',
    category: 'settlement',
    cluster: 'set_master',
    archetype: 'gateway',
    maxLevel: 1,
    prerequisites: ['set_deep_n'],
    baseCost: { wood: 6000, clay: 7000, iron: 7000 },
    costFactor: 1.0,
    effect: { kind: 'pop_mult', perLevel: 0.05 },
  },
  set_master_n: {
    id: 'set_master_n',
    name: 'Kwitnące prowincje',
    desc: 'Szczytowy notable osadnictwa: bardzo duży wzrost limitu populacji.',
    category: 'settlement',
    cluster: 'set_master',
    archetype: 'notable',
    maxLevel: 3,
    prerequisites: ['set_gateway'],
    baseCost: { wood: 4000, clay: 5000, iron: 5000 },
    costFactor: 1.6,
    effect: { kind: 'pop_mult', perLevel: 0.1 },
  },
  set_master_m1: {
    id: 'set_master_m1',
    name: 'Miasta targowe',
    desc: 'Znaczny wzrost limitu populacji.',
    category: 'settlement',
    cluster: 'set_master',
    archetype: 'minor',
    maxLevel: 8,
    prerequisites: ['set_master_n'],
    baseCost: { wood: 1800, clay: 2200, iron: 2200 },
    costFactor: 1.35,
    effect: { kind: 'pop_mult', perLevel: 0.025 },
  },
  set_master_m2: {
    id: 'set_master_m2',
    name: 'Kolonie',
    desc: 'Znaczny wzrost limitu populacji.',
    category: 'settlement',
    cluster: 'set_master',
    archetype: 'minor',
    maxLevel: 8,
    prerequisites: ['set_master_n'],
    baseCost: { wood: 1900, clay: 2400, iron: 2400 },
    costFactor: 1.35,
    effect: { kind: 'pop_mult', perLevel: 0.025 },
  },
  set_master_m3: {
    id: 'set_master_m3',
    name: 'Wielkie rody',
    desc: 'Silny wzrost limitu populacji.',
    category: 'settlement',
    cluster: 'set_master',
    archetype: 'minor',
    maxLevel: 7,
    prerequisites: ['set_master_m1'],
    baseCost: { wood: 2100, clay: 2600, iron: 2600 },
    costFactor: 1.36,
    effect: { kind: 'pop_mult', perLevel: 0.03 },
  },
  set_master_m4: {
    id: 'set_master_m4',
    name: 'Prawo osadnicze',
    desc: 'Marginalny, głęboki wzrost limitu populacji.',
    category: 'settlement',
    cluster: 'set_master',
    archetype: 'minor',
    maxLevel: 10,
    prerequisites: ['set_master_m2'],
    baseCost: { wood: 1600, clay: 2000, iron: 2000 },
    costFactor: 1.33,
    effect: { kind: 'pop_mult', perLevel: 0.015 },
  },
}

/**
 * Stable iteration order over {@link TECH_NODES}. Derived from the data so it stays
 * deterministic (Object key order here = source order), driving every order-sensitive
 * pass: aggregateTechMods, layout, validation, the sim. Keep source order stable when
 * extending (append new nodes) so saves/round-trips stay reproducible.
 */
export const TECH_NODE_IDS: readonly string[] = Object.keys(TECH_NODES)

/**
 * Roots = nodes with no prerequisites (always available). Derived deterministically
 * from {@link TECH_NODE_IDS} so adding a node is a single data edit. The contract:
 * one entry per category (eco_root / sto_root / set_root).
 */
export const TECH_ROOTS: readonly string[] = TECH_NODE_IDS.filter(
  (id) => TECH_NODES[id].prerequisites.length === 0,
)
