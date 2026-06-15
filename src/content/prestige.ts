/**
 * Prestige (ascension) tree catalogue — PURE DATA (no engine logic lives here).
 *
 * The prestige tree is the PERMANENT, account-wide constellation bought with
 * PRESTIGE POINTS (PP) earned by ascending (resetting the run). It uses the same
 * Path-of-Exile-style cluster model as the tech tree, but with two differences:
 *  1. The currency is PP (a plain number on {@link PrestigeNode.baseCost}), not
 *     resources from the global pool.
 *  2. Its effects are GLOBAL and PERMANENT: they survive every reset and COMBINE
 *     with the tech-tree effects (multipliers multiply, fractions add+clamp — see
 *     systems/prestige.ts `combine`).
 *
 * Effect kinds mirror the multiplicative tech kinds (production/storage/pop/cost/
 * recruit/march/attack/defense/loot) — all GLOBAL, so there is no resource-specific
 * production variant here — plus one prestige-only kind, `start_resources`, applied
 * to the capital at the start of every fresh run after an ascension (it does NOT
 * fold into the transient multiplier bag; see `startResourceBonus`).
 *
 * Import discipline: this module imports nothing from the engine at runtime (it is
 * PURE DATA), so it can never form an initialisation cycle (mirrors content/tech.ts).
 *
 * SHAPE (the contract): the types below, plus the tree. THIS FILE currently carries a
 * MINIMAL placeholder (one root per category, a valid DAG); the Build step replaces
 * the node table with the full ~24-36-node, 3-branch constellation. The contract
 * (types, the PRESTIGE_NODES / PRESTIGE_NODE_IDS / PRESTIGE_ROOTS exports and their
 * derivation) stays fixed so layout/systems/UI can be authored against it in parallel.
 */

/**
 * What a prestige node *does*, as a discriminated union — all GLOBAL and PERMANENT.
 * `perLevel` is added per owned level to the relevant accumulator.
 *
 * The nine MULTIPLICATIVE kinds mirror the tech effects (a `1 + Σ` factor, or a
 * clamped fraction for the cost/recruit/march reductions); they are summed by
 * `aggregatePrestigeMods` (systems/prestige.ts) and COMBINED with the tech bag.
 *
 * The prestige-only `start_resources` kind grants `perLevel` of EACH resource per
 * owned level at the start of a fresh run (applied to the capital by `ascend`); it is
 * NOT a multiplier and never enters `aggregatePrestigeMods`.
 */
export type PrestigeEffect =
  | { kind: 'production_mult'; perLevel: number }
  | { kind: 'storage_mult'; perLevel: number }
  | { kind: 'pop_mult'; perLevel: number }
  | { kind: 'cost_reduction'; perLevel: number }
  | { kind: 'recruit_speed'; perLevel: number }
  | { kind: 'march_speed'; perLevel: number }
  | { kind: 'attack_mult'; perLevel: number }
  | { kind: 'defense_mult'; perLevel: number }
  | { kind: 'loot_mult'; perLevel: number }
  /** +startowe surowce (każdy surowiec) na poziom, stosowane przy starcie biegu. */
  | { kind: 'start_resources'; perLevel: number }

/**
 * Top-level branch of the prestige constellation. Three branches at launch
 * (extensible exactly like {@link TechCategory}): `might` (combat power), `prosperity`
 * (economy/growth) and `dominion` (loot/expansion). The radial layout treats every
 * category as an arm automatically, so adding a branch is a pure data change.
 */
export type PrestigeCategory = 'might' | 'prosperity' | 'dominion'

/**
 * Node role, fixing the `maxLevel` band (CLAUDE.md tree rule), mirroring
 * {@link TechArchetype}:
 *  - minor:    drobny bonus na poziom -> maxLevel 7-10
 *  - notable:  silny nazwany efekt    -> maxLevel 2-3
 *  - gateway:  binarne odblokowanie / rozjazd -> maxLevel 1 (drogie)
 */
export type PrestigeArchetype = 'minor' | 'notable' | 'gateway'

export interface PrestigeNode {
  /** Stable id (the key under {@link PRESTIGE_NODES}); what prerequisites point at. */
  id: string
  /** Display name (PL). */
  name: string
  /** Short description (PL). */
  desc: string
  category: PrestigeCategory
  /** Id of the owning cluster (authoring unit: notable + ring of minors). */
  cluster: string
  archetype: PrestigeArchetype
  /** Finite upgrade ceiling, 1..10, sized to the archetype (CLAUDE.md). */
  maxLevel: number
  /** Ids of nodes that must be at level >= 1 before this node is available (DAG). */
  prerequisites: string[]
  /** Cost of the *first* level (level 0 -> 1), in PRESTIGE POINTS (a plain number). */
  baseCost: number
  /** Geometric PP-cost growth per owned level. */
  costFactor: number
  effect: PrestigeEffect
}

/**
 * The full prestige tree — 33 nodes, 12 clusters, 3 branches. PERMANENT, account-wide
 * power bought with PP; effects COMBINE with the tech tree (multipliers multiply, the
 * cost/recruit/march fractions add+clamp; `start_resources` is applied to the capital
 * at the start of every fresh run — see systems/prestige.ts).
 *
 *  - might      (combat: attack / defense / loot) — 4 clusters, 11 nodes.
 *      might_core (entry, attack) -> might_def (defense notable) & might_loot (loot
 *      notable) -> might_apex (gateway + attack apex behind it).
 *  - prosperity (economy: production / storage / pop / cost / recruit) — 4 clusters,
 *      11 nodes. prosperity_core (entry, production) -> prosperity_growth (pop notable)
 *      & prosperity_craft (cost/recruit notable) -> prosperity_apex (gateway + apex).
 *  - dominion   (expansion: march speed / starter resources, plus a strong gateway) —
 *      4 clusters, 11 nodes. dominion_core (entry, march speed) -> dominion_supply
 *      (starter-resources notable) & dominion_raid (loot notable) -> dominion_apex
 *      (gateway + starter-resources apex behind it).
 *
 * Each cluster = one notable (maxLevel 2-3, strong named effect) + a ring of minors
 * (maxLevel 7-8, drobny effect); three gateways (maxLevel 1, drogie) gate the apex
 * clusters. Roots (might_root / prosperity_root / dominion_root) have no prerequisites
 * — one per category. Prerequisites are a DAG with no cycles; every node is reachable
 * from a root and every node has a real effect (perLevel > 0). PP costs grow per archetype
 * (minor ~1-3, notable ~6-12, gateway ~20-25) at costFactor ~1.5 (gateways are one-shot
 * so their factor is inert). perLevel is deliberately STRONGER than the tech tree — a
 * prestige level should be felt — without breaking the clamps on the fraction effects.
 *
 * Object key order IS the stable source order driving every order-sensitive pass
 * (aggregatePrestigeMods, layout, validation, the sim) — keep new nodes appended when
 * extending so saves/round-trips stay reproducible.
 */
export const PRESTIGE_NODES: Record<string, PrestigeNode> = {
  // =====================================================================
  // MIGHT branch — combat power (attack / defense / loot)
  // =====================================================================

  // --- might_core: entry cluster (attack) ------------------------------
  might_root: {
    id: 'might_root',
    name: 'Potęga',
    desc: 'Wejście do gałęzi potęgi. Trwały wzrost siły ataku wojsk na poziom.',
    category: 'might',
    cluster: 'might_core',
    archetype: 'notable',
    maxLevel: 3,
    prerequisites: [],
    baseCost: 1,
    costFactor: 1.5,
    effect: { kind: 'attack_mult', perLevel: 0.05 },
  },
  might_core_m1: {
    id: 'might_core_m1',
    name: 'Krwawy zew',
    desc: 'Trwały, drobny wzrost siły ataku wojsk na poziom.',
    category: 'might',
    cluster: 'might_core',
    archetype: 'minor',
    maxLevel: 8,
    prerequisites: ['might_root'],
    baseCost: 1,
    costFactor: 1.5,
    effect: { kind: 'attack_mult', perLevel: 0.02 },
  },
  might_core_m2: {
    id: 'might_core_m2',
    name: 'Twarda skóra',
    desc: 'Trwały, drobny wzrost siły obrony wojsk na poziom.',
    category: 'might',
    cluster: 'might_core',
    archetype: 'minor',
    maxLevel: 7,
    prerequisites: ['might_root'],
    baseCost: 1,
    costFactor: 1.5,
    effect: { kind: 'defense_mult', perLevel: 0.025 },
  },

  // --- might_def: defense notable cluster ------------------------------
  might_def_n: {
    id: 'might_def_n',
    name: 'Niezłomna straż',
    desc: 'Notable potęgi: znaczny, trwały wzrost siły obrony wojsk.',
    category: 'might',
    cluster: 'might_def',
    archetype: 'notable',
    maxLevel: 3,
    prerequisites: ['might_root'],
    baseCost: 6,
    costFactor: 1.5,
    effect: { kind: 'defense_mult', perLevel: 0.08 },
  },
  might_def_m1: {
    id: 'might_def_m1',
    name: 'Mur tarcz',
    desc: 'Trwały wzrost siły obrony wojsk na poziom.',
    category: 'might',
    cluster: 'might_def',
    archetype: 'minor',
    maxLevel: 8,
    prerequisites: ['might_def_n'],
    baseCost: 2,
    costFactor: 1.5,
    effect: { kind: 'defense_mult', perLevel: 0.02 },
  },
  might_def_m2: {
    id: 'might_def_m2',
    name: 'Kontruderzenie',
    desc: 'Trwały wzrost siły ataku wojsk na poziom.',
    category: 'might',
    cluster: 'might_def',
    archetype: 'minor',
    maxLevel: 7,
    prerequisites: ['might_def_n'],
    baseCost: 2,
    costFactor: 1.5,
    effect: { kind: 'attack_mult', perLevel: 0.025 },
  },

  // --- might_loot: loot notable cluster --------------------------------
  might_loot_n: {
    id: 'might_loot_n',
    name: 'Krwawa danina',
    desc: 'Notable potęgi: znaczny, trwały wzrost łupów z wypraw.',
    category: 'might',
    cluster: 'might_loot',
    archetype: 'notable',
    maxLevel: 3,
    prerequisites: ['might_root'],
    baseCost: 6,
    costFactor: 1.5,
    effect: { kind: 'loot_mult', perLevel: 0.08 },
  },
  might_loot_m1: {
    id: 'might_loot_m1',
    name: 'Łupieżcy',
    desc: 'Trwały wzrost łupów z wypraw na poziom.',
    category: 'might',
    cluster: 'might_loot',
    archetype: 'minor',
    maxLevel: 7,
    prerequisites: ['might_loot_n'],
    baseCost: 2,
    costFactor: 1.5,
    effect: { kind: 'loot_mult', perLevel: 0.025 },
  },

  // --- might_apex: gateway + szczyt potęgi (attack) --------------------
  might_gateway: {
    id: 'might_gateway',
    name: 'Wojna totalna',
    desc: 'Brama potęgi (droga, jednorazowa): trwały wzrost siły ataku wojsk. Odsłania szczytowy klaster potęgi.',
    category: 'might',
    cluster: 'might_apex',
    archetype: 'gateway',
    maxLevel: 1,
    prerequisites: ['might_def_n'],
    baseCost: 20,
    costFactor: 1.0,
    effect: { kind: 'attack_mult', perLevel: 0.1 },
  },
  might_apex_n: {
    id: 'might_apex_n',
    name: 'Władcy wojny',
    desc: 'Szczytowy notable potęgi: bardzo silny, trwały wzrost siły ataku wojsk.',
    category: 'might',
    cluster: 'might_apex',
    archetype: 'notable',
    maxLevel: 2,
    prerequisites: ['might_gateway'],
    baseCost: 10,
    costFactor: 1.5,
    effect: { kind: 'attack_mult', perLevel: 0.12 },
  },
  might_apex_m1: {
    id: 'might_apex_m1',
    name: 'Żelazna falanga',
    desc: 'Trwały wzrost siły obrony wojsk na poziom.',
    category: 'might',
    cluster: 'might_apex',
    archetype: 'minor',
    maxLevel: 7,
    prerequisites: ['might_apex_n'],
    baseCost: 3,
    costFactor: 1.5,
    effect: { kind: 'defense_mult', perLevel: 0.03 },
  },

  // =====================================================================
  // PROSPERITY branch — economy (production / storage / pop / cost / recruit)
  // =====================================================================

  // --- prosperity_core: entry cluster (production) ---------------------
  prosperity_root: {
    id: 'prosperity_root',
    name: 'Dobrobyt',
    desc: 'Wejście do gałęzi dobrobytu. Trwały wzrost produkcji wszystkich surowców na poziom.',
    category: 'prosperity',
    cluster: 'prosperity_core',
    archetype: 'notable',
    maxLevel: 3,
    prerequisites: [],
    baseCost: 1,
    costFactor: 1.5,
    effect: { kind: 'production_mult', perLevel: 0.05 },
  },
  prosperity_core_m1: {
    id: 'prosperity_core_m1',
    name: 'Pracowite dłonie',
    desc: 'Trwały, drobny wzrost produkcji wszystkich surowców na poziom.',
    category: 'prosperity',
    cluster: 'prosperity_core',
    archetype: 'minor',
    maxLevel: 8,
    prerequisites: ['prosperity_root'],
    baseCost: 1,
    costFactor: 1.5,
    effect: { kind: 'production_mult', perLevel: 0.02 },
  },
  prosperity_core_m2: {
    id: 'prosperity_core_m2',
    name: 'Zapobiegliwość',
    desc: 'Trwały, drobny wzrost pojemności magazynów na poziom.',
    category: 'prosperity',
    cluster: 'prosperity_core',
    archetype: 'minor',
    maxLevel: 8,
    prerequisites: ['prosperity_root'],
    baseCost: 1,
    costFactor: 1.5,
    effect: { kind: 'storage_mult', perLevel: 0.02 },
  },

  // --- prosperity_growth: population notable cluster -------------------
  prosperity_growth_n: {
    id: 'prosperity_growth_n',
    name: 'Rozkwit ludu',
    desc: 'Notable dobrobytu: znaczny, trwały wzrost limitu populacji.',
    category: 'prosperity',
    cluster: 'prosperity_growth',
    archetype: 'notable',
    maxLevel: 3,
    prerequisites: ['prosperity_root'],
    baseCost: 6,
    costFactor: 1.5,
    effect: { kind: 'pop_mult', perLevel: 0.08 },
  },
  prosperity_growth_m1: {
    id: 'prosperity_growth_m1',
    name: 'Liczne rody',
    desc: 'Trwały wzrost limitu populacji na poziom.',
    category: 'prosperity',
    cluster: 'prosperity_growth',
    archetype: 'minor',
    maxLevel: 7,
    prerequisites: ['prosperity_growth_n'],
    baseCost: 2,
    costFactor: 1.5,
    effect: { kind: 'pop_mult', perLevel: 0.025 },
  },
  prosperity_growth_m2: {
    id: 'prosperity_growth_m2',
    name: 'Pełne spichlerze',
    desc: 'Trwały wzrost pojemności magazynów na poziom.',
    category: 'prosperity',
    cluster: 'prosperity_growth',
    archetype: 'minor',
    maxLevel: 8,
    prerequisites: ['prosperity_growth_n'],
    baseCost: 2,
    costFactor: 1.5,
    effect: { kind: 'storage_mult', perLevel: 0.02 },
  },

  // --- prosperity_craft: cost / recruit notable cluster ---------------
  prosperity_craft_n: {
    id: 'prosperity_craft_n',
    name: 'Mistrzowie cechu',
    desc: 'Notable dobrobytu: znaczna, trwała zniżka kosztu budowy.',
    category: 'prosperity',
    cluster: 'prosperity_craft',
    archetype: 'notable',
    maxLevel: 3,
    prerequisites: ['prosperity_root'],
    baseCost: 7,
    costFactor: 1.5,
    effect: { kind: 'cost_reduction', perLevel: 0.025 },
  },
  prosperity_craft_m1: {
    id: 'prosperity_craft_m1',
    name: 'Sprawny werbunek',
    desc: 'Trwałe, drobne skrócenie czasu rekrutacji na poziom.',
    category: 'prosperity',
    cluster: 'prosperity_craft',
    archetype: 'minor',
    maxLevel: 7,
    prerequisites: ['prosperity_craft_n'],
    baseCost: 2,
    costFactor: 1.5,
    effect: { kind: 'recruit_speed', perLevel: 0.012 },
  },

  // --- prosperity_apex: gateway + szczyt dobrobytu (production) --------
  prosperity_gateway: {
    id: 'prosperity_gateway',
    name: 'Złoty wiek',
    desc: 'Brama dobrobytu (droga, jednorazowa): trwały wzrost produkcji wszystkich surowców. Odsłania szczytowy klaster dobrobytu.',
    category: 'prosperity',
    cluster: 'prosperity_apex',
    archetype: 'gateway',
    maxLevel: 1,
    prerequisites: ['prosperity_growth_n'],
    baseCost: 22,
    costFactor: 1.0,
    effect: { kind: 'production_mult', perLevel: 0.1 },
  },
  prosperity_apex_n: {
    id: 'prosperity_apex_n',
    name: 'Róg obfitości',
    desc: 'Szczytowy notable dobrobytu: bardzo silny, trwały wzrost produkcji wszystkich surowców.',
    category: 'prosperity',
    cluster: 'prosperity_apex',
    archetype: 'notable',
    maxLevel: 2,
    prerequisites: ['prosperity_gateway'],
    baseCost: 10,
    costFactor: 1.5,
    effect: { kind: 'production_mult', perLevel: 0.12 },
  },
  prosperity_apex_m1: {
    id: 'prosperity_apex_m1',
    name: 'Skarbce królestwa',
    desc: 'Trwały wzrost pojemności magazynów na poziom.',
    category: 'prosperity',
    cluster: 'prosperity_apex',
    archetype: 'minor',
    maxLevel: 7,
    prerequisites: ['prosperity_apex_n'],
    baseCost: 3,
    costFactor: 1.5,
    effect: { kind: 'storage_mult', perLevel: 0.03 },
  },

  // =====================================================================
  // DOMINION branch — expansion (march speed / starter resources)
  // =====================================================================

  // --- dominion_core: entry cluster (march speed) ---------------------
  dominion_root: {
    id: 'dominion_root',
    name: 'Dominacja',
    desc: 'Wejście do gałęzi dominacji. Trwałe skrócenie czasu marszu wojsk na poziom.',
    category: 'dominion',
    cluster: 'dominion_core',
    archetype: 'notable',
    maxLevel: 3,
    prerequisites: [],
    baseCost: 1,
    costFactor: 1.5,
    effect: { kind: 'march_speed', perLevel: 0.02 },
  },
  dominion_core_m1: {
    id: 'dominion_core_m1',
    name: 'Lekka kawaleria',
    desc: 'Trwałe, drobne skrócenie czasu marszu wojsk na poziom.',
    category: 'dominion',
    cluster: 'dominion_core',
    archetype: 'minor',
    maxLevel: 7,
    prerequisites: ['dominion_root'],
    baseCost: 1,
    costFactor: 1.5,
    effect: { kind: 'march_speed', perLevel: 0.012 },
  },
  dominion_core_m2: {
    id: 'dominion_core_m2',
    name: 'Utwardzone trakty',
    desc: 'Trwałe, drobne skrócenie czasu marszu wojsk na poziom.',
    category: 'dominion',
    cluster: 'dominion_core',
    archetype: 'minor',
    maxLevel: 8,
    prerequisites: ['dominion_root'],
    baseCost: 1,
    costFactor: 1.5,
    effect: { kind: 'march_speed', perLevel: 0.01 },
  },

  // --- dominion_supply: starter-resources notable cluster -------------
  dominion_supply_n: {
    id: 'dominion_supply_n',
    name: 'Dziedzictwo',
    desc: 'Notable dominacji: każdy nowy bieg zaczynasz ze znacznym zapasem każdego surowca (na poziom).',
    category: 'dominion',
    cluster: 'dominion_supply',
    archetype: 'notable',
    maxLevel: 3,
    prerequisites: ['dominion_root'],
    baseCost: 6,
    costFactor: 1.5,
    effect: { kind: 'start_resources', perLevel: 120 },
  },
  dominion_supply_m1: {
    id: 'dominion_supply_m1',
    name: 'Skrzętne zapasy',
    desc: 'Każdy nowy bieg zaczynasz z dodatkowym zapasem każdego surowca (na poziom).',
    category: 'dominion',
    cluster: 'dominion_supply',
    archetype: 'minor',
    maxLevel: 7,
    prerequisites: ['dominion_supply_n'],
    baseCost: 2,
    costFactor: 1.5,
    effect: { kind: 'start_resources', perLevel: 25 },
  },
  dominion_supply_m2: {
    id: 'dominion_supply_m2',
    name: 'Trybut wasali',
    desc: 'Trwały wzrost łupów z wypraw na poziom.',
    category: 'dominion',
    cluster: 'dominion_supply',
    archetype: 'minor',
    maxLevel: 8,
    prerequisites: ['dominion_supply_n'],
    baseCost: 2,
    costFactor: 1.5,
    effect: { kind: 'loot_mult', perLevel: 0.02 },
  },

  // --- dominion_raid: loot notable cluster ----------------------------
  dominion_raid_n: {
    id: 'dominion_raid_n',
    name: 'Bezlitosne najazdy',
    desc: 'Notable dominacji: znaczny, trwały wzrost łupów z wypraw.',
    category: 'dominion',
    cluster: 'dominion_raid',
    archetype: 'notable',
    maxLevel: 3,
    prerequisites: ['dominion_root'],
    baseCost: 6,
    costFactor: 1.5,
    effect: { kind: 'loot_mult', perLevel: 0.08 },
  },
  dominion_raid_m1: {
    id: 'dominion_raid_m1',
    name: 'Forsowne marsze',
    desc: 'Trwałe skrócenie czasu marszu wojsk na poziom.',
    category: 'dominion',
    cluster: 'dominion_raid',
    archetype: 'minor',
    maxLevel: 7,
    prerequisites: ['dominion_raid_n'],
    baseCost: 2,
    costFactor: 1.5,
    effect: { kind: 'march_speed', perLevel: 0.012 },
  },

  // --- dominion_apex: gateway + szczyt dominacji (starter resources) --
  dominion_gateway: {
    id: 'dominion_gateway',
    name: 'Imperium',
    desc: 'Brama dominacji (droga, jednorazowa): każdy nowy bieg zaczynasz z dużym skarbcem każdego surowca. Odsłania szczytowy klaster dominacji.',
    category: 'dominion',
    cluster: 'dominion_apex',
    archetype: 'gateway',
    maxLevel: 1,
    prerequisites: ['dominion_supply_n'],
    baseCost: 25,
    costFactor: 1.0,
    effect: { kind: 'start_resources', perLevel: 500 },
  },
  dominion_apex_n: {
    id: 'dominion_apex_n',
    name: 'Skarbiec dynastii',
    desc: 'Szczytowy notable dominacji: każdy nowy bieg zaczynasz z bardzo dużym zapasem każdego surowca (na poziom).',
    category: 'dominion',
    cluster: 'dominion_apex',
    archetype: 'notable',
    maxLevel: 2,
    prerequisites: ['dominion_gateway'],
    baseCost: 12,
    costFactor: 1.5,
    effect: { kind: 'start_resources', perLevel: 200 },
  },
  dominion_apex_m1: {
    id: 'dominion_apex_m1',
    name: 'Gońcy imperium',
    desc: 'Trwałe skrócenie czasu marszu wojsk na poziom.',
    category: 'dominion',
    cluster: 'dominion_apex',
    archetype: 'minor',
    maxLevel: 7,
    prerequisites: ['dominion_apex_n'],
    baseCost: 3,
    costFactor: 1.5,
    effect: { kind: 'march_speed', perLevel: 0.015 },
  },
}

/**
 * Stable id list — the single source of iteration order for every order-sensitive
 * pass (aggregatePrestigeMods, layout, validation, the sim). Object key order here =
 * source order; keep it stable when extending (append) so saves/round-trips stay
 * reproducible.
 */
export const PRESTIGE_NODE_IDS: readonly string[] = Object.keys(PRESTIGE_NODES)

/**
 * Roots = nodes with no prerequisites (always available once you have PP). Derived
 * deterministically from {@link PRESTIGE_NODE_IDS} so adding a node is a single data
 * edit. The contract: at least one entry per category.
 */
export const PRESTIGE_ROOTS: readonly string[] = PRESTIGE_NODE_IDS.filter(
  (id) => PRESTIGE_NODES[id].prerequisites.length === 0,
)
