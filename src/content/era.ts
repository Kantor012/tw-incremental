/**
 * Era tree catalogue — PURE DATA (no engine logic lives here).
 *
 * The era tree is the SECOND meta-layer constellation, sitting ABOVE prestige: it is
 * bought with ERA POINTS (EP) earned by starting a "Nowa Era" (the great reset), which
 * WIPES the entire prestige account (PP, prestige nodes, ascensions) and resets the run.
 * It uses the same Path-of-Exile-style cluster model as the tech and prestige trees, but:
 *  1. The currency is EP (a plain number on {@link EraNode.baseCost}), rarer than PP
 *     (the EP yield uses a cube root where prestige uses a square root).
 *  2. Its effects are GLOBAL and survive EVERY era reset: they COMBINE onto the
 *     tech × prestige bag (multipliers multiply, fractions add+clamp — see
 *     systems/era.ts `aggregateEraMods` and systems/prestige.ts `combine`), so each
 *     era stacks on top of all prior progress.
 *
 * Effect kinds mirror the multiplicative prestige kinds (production/storage/pop/cost/
 * recruit/march/attack/defense/loot) — all GLOBAL — plus two era-only kinds:
 *  - `start_resources`, applied to the capital at the start of every fresh run (it does
 *    NOT fold into the transient multiplier bag; see `eraStartResourceBonus`), and
 *  - the signature `pp_mult`, which multiplies PRESTIGE-POINT gain (see `eraPpMult`),
 *    so each new era accelerates the whole prestige loop. It too is skipped by
 *    `aggregateEraMods`.
 *
 * Import discipline: this module imports nothing from the engine at runtime (it is
 * PURE DATA), so it can never form an initialisation cycle (mirrors content/prestige.ts).
 *
 * SHAPE (the contract): the types below, plus the tree. The node table is the full
 * multi-branch constellation (33 nodes, 12 clusters, 3 branches); the contract (types,
 * the three FIXED roots with their effect kinds, and the ERA_NODES / ERA_NODE_IDS /
 * ERA_ROOTS exports and their derivation) stays fixed so layout/systems/UI bind to it.
 */

/**
 * What an era node *does*, as a discriminated union — all GLOBAL and permanent across
 * era resets. `perLevel` is added per owned level to the relevant accumulator.
 *
 * The nine MULTIPLICATIVE kinds mirror the prestige effects (a `1 + Σ` factor, or a
 * clamped fraction for the cost/recruit/march reductions); they are summed by
 * `aggregateEraMods` (systems/era.ts) and COMBINED onto the tech × prestige bag.
 *
 * The two era-only kinds are NOT multipliers and never enter `aggregateEraMods`:
 *  - `start_resources` grants `perLevel` of EACH resource per owned level at the start
 *    of a fresh run (applied to the capital by `newEra` / `ascend`);
 *  - `pp_mult` multiplies prestige-point gain by `1 + perLevel * level` (see `eraPpMult`).
 */
export type EraEffect =
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
  /** Mnożnik zysku punktów prestiżu: +perLevel * poziom (sygnaturowy efekt ery). */
  | { kind: 'pp_mult'; perLevel: number }

/**
 * Top-level branch of the era constellation. Three branches at launch (extensible
 * exactly like {@link PrestigeCategory}): `eternity` (economy/permanence),
 * `pantheon` (combat might) and `legacy` (the prestige-loop accelerator). The radial
 * layout treats every category as an arm automatically, so adding a branch is a pure
 * data change.
 */
export type EraCategory = 'eternity' | 'pantheon' | 'legacy'

/**
 * Node role, fixing the `maxLevel` band (CLAUDE.md tree rule), mirroring
 * {@link PrestigeArchetype}:
 *  - minor:    drobny bonus na poziom -> maxLevel 7-10
 *  - notable:  silny nazwany efekt    -> maxLevel 2-3
 *  - gateway:  binarne odblokowanie / rozjazd -> maxLevel 1 (drogie)
 */
export type EraArchetype = 'minor' | 'notable' | 'gateway'

export interface EraNode {
  /** Stable id (the key under {@link ERA_NODES}); what prerequisites point at. */
  id: string
  /** Display name (PL). */
  name: string
  /** Short description (PL). */
  desc: string
  category: EraCategory
  /** Id of the owning cluster (authoring unit: notable + ring of minors). */
  cluster: string
  archetype: EraArchetype
  /** Finite upgrade ceiling, 1..10, sized to the archetype (CLAUDE.md). */
  maxLevel: number
  /** Ids of nodes that must be at level >= 1 before this node is available (DAG). */
  prerequisites: string[]
  /** Cost of the *first* level (level 0 -> 1), in ERA POINTS (a plain number). */
  baseCost: number
  /** Geometric EP-cost growth per owned level. */
  costFactor: number
  effect: EraEffect
}

/**
 * The full era tree — 33 nodes, 12 clusters, 3 branches. PERMANENT across every era
 * reset; effects COMBINE onto the tech × prestige bag (multipliers multiply, the
 * cost/recruit/march fractions add+clamp), while the two era-only kinds bypass the bag:
 * `start_resources` seeds the capital at the start of every fresh run and the signature
 * `pp_mult` scales prestige-point gain (see systems/era.ts).
 *
 *  - eternity (economy: production / storage / pop) — 4 clusters, 11 nodes.
 *      eternity_core (entry, production) -> eternity_growth (pop notable) &
 *      eternity_store (storage notable) -> eternity_apex (gateway + production apex).
 *  - pantheon (combat: attack / defense / loot) — 4 clusters, 11 nodes.
 *      pantheon_core (entry, attack) -> pantheon_guard (defense notable) &
 *      pantheon_spoils (loot notable) -> pantheon_apex (gateway + attack apex).
 *  - legacy   (META: pp_mult / start_resources / cost / march) — 4 clusters, 11 nodes.
 *      legacy_core (entry, pp_mult) -> legacy_vault (starter-resources notable) &
 *      legacy_swift (cost/march notable) -> legacy_apex (gateway + pp_mult apex). The
 *      signature `pp_mult` lives on legacy_root, legacy_gateway and legacy_apex_n, so a
 *      deep legacy investment compounds the whole prestige loop every era.
 *
 * Each cluster = one notable (maxLevel 2-3, strong named effect) + a ring of minors
 * (maxLevel 7-8, drobny effect); three gateways (maxLevel 1, drogie, costFactor 1.0)
 * gate the apex clusters. The three FIXED roots (eternity_root / pantheon_root /
 * legacy_root, one per category) have no prerequisites and KEEP their ids + effect kinds
 * (production_mult / attack_mult / pp_mult) — other phases depend on them. Prerequisites
 * are a DAG with no cycles; every node is reachable from a root and every node has a real
 * effect (perLevel > 0). EP costs grow per archetype (minor ~1-3, notable ~6-12, gateway
 * ~18-22) at costFactor ~1.5 (gateways are one-shot so their factor is inert). perLevel
 * is deliberately STRONGER than the prestige tree — era is a higher layer — while the
 * cost/march fractions stay well under the combined clamps (cost 0.9, recruit/march 0.75).
 *
 * Object key order IS the stable source order driving every order-sensitive pass
 * (aggregateEraMods, layout, validation, the sim) — keep new nodes appended when
 * extending so saves/round-trips stay reproducible.
 */
export const ERA_NODES: Record<string, EraNode> = {
  // =====================================================================
  // ETERNITY branch — economy (production / storage / pop)
  // =====================================================================

  // --- eternity_core: entry cluster (production) ----------------------
  eternity_root: {
    id: 'eternity_root',
    name: 'Wieczność',
    desc: 'Wejście do gałęzi wieczności. Trwały wzrost produkcji wszystkich surowców na poziom — przetrwa każdą Nową Erę.',
    category: 'eternity',
    cluster: 'eternity_core',
    archetype: 'notable',
    maxLevel: 3,
    prerequisites: [],
    baseCost: 1,
    costFactor: 1.5,
    effect: { kind: 'production_mult', perLevel: 0.1 },
  },
  eternity_core_m1: {
    id: 'eternity_core_m1',
    name: 'Wieczny plon',
    desc: 'Trwały, drobny wzrost produkcji wszystkich surowców na poziom.',
    category: 'eternity',
    cluster: 'eternity_core',
    archetype: 'minor',
    maxLevel: 8,
    prerequisites: ['eternity_root'],
    baseCost: 1,
    costFactor: 1.5,
    effect: { kind: 'production_mult', perLevel: 0.04 },
  },
  eternity_core_m2: {
    id: 'eternity_core_m2',
    name: 'Niezniszczalne składy',
    desc: 'Trwały, drobny wzrost pojemności magazynów na poziom.',
    category: 'eternity',
    cluster: 'eternity_core',
    archetype: 'minor',
    maxLevel: 8,
    prerequisites: ['eternity_root'],
    baseCost: 1,
    costFactor: 1.5,
    effect: { kind: 'storage_mult', perLevel: 0.04 },
  },

  // --- eternity_growth: population notable cluster --------------------
  eternity_growth_n: {
    id: 'eternity_growth_n',
    name: 'Nieśmiertelny ród',
    desc: 'Notable wieczności: znaczny, trwały wzrost limitu populacji.',
    category: 'eternity',
    cluster: 'eternity_growth',
    archetype: 'notable',
    maxLevel: 3,
    prerequisites: ['eternity_root'],
    baseCost: 6,
    costFactor: 1.5,
    effect: { kind: 'pop_mult', perLevel: 0.12 },
  },
  eternity_growth_m1: {
    id: 'eternity_growth_m1',
    name: 'Wieczne pokolenia',
    desc: 'Trwały wzrost limitu populacji na poziom.',
    category: 'eternity',
    cluster: 'eternity_growth',
    archetype: 'minor',
    maxLevel: 7,
    prerequisites: ['eternity_growth_n'],
    baseCost: 2,
    costFactor: 1.5,
    effect: { kind: 'pop_mult', perLevel: 0.04 },
  },
  eternity_growth_m2: {
    id: 'eternity_growth_m2',
    name: 'Głębokie spichlerze',
    desc: 'Trwały wzrost pojemności magazynów na poziom.',
    category: 'eternity',
    cluster: 'eternity_growth',
    archetype: 'minor',
    maxLevel: 8,
    prerequisites: ['eternity_growth_n'],
    baseCost: 2,
    costFactor: 1.5,
    effect: { kind: 'storage_mult', perLevel: 0.04 },
  },

  // --- eternity_store: storage notable cluster -----------------------
  eternity_store_n: {
    id: 'eternity_store_n',
    name: 'Skarbnica wieków',
    desc: 'Notable wieczności: znaczny, trwały wzrost pojemności magazynów.',
    category: 'eternity',
    cluster: 'eternity_store',
    archetype: 'notable',
    maxLevel: 3,
    prerequisites: ['eternity_root'],
    baseCost: 6,
    costFactor: 1.5,
    effect: { kind: 'storage_mult', perLevel: 0.12 },
  },
  eternity_store_m1: {
    id: 'eternity_store_m1',
    name: 'Niewyczerpane żyły',
    desc: 'Trwały wzrost produkcji wszystkich surowców na poziom.',
    category: 'eternity',
    cluster: 'eternity_store',
    archetype: 'minor',
    maxLevel: 7,
    prerequisites: ['eternity_store_n'],
    baseCost: 2,
    costFactor: 1.5,
    effect: { kind: 'production_mult', perLevel: 0.04 },
  },

  // --- eternity_apex: gateway + szczyt wieczności (production) --------
  eternity_gateway: {
    id: 'eternity_gateway',
    name: 'Złota wieczność',
    desc: 'Brama wieczności (droga, jednorazowa): trwały wzrost produkcji wszystkich surowców. Odsłania szczytowy klaster wieczności.',
    category: 'eternity',
    cluster: 'eternity_apex',
    archetype: 'gateway',
    maxLevel: 1,
    prerequisites: ['eternity_growth_n'],
    baseCost: 18,
    costFactor: 1.0,
    effect: { kind: 'production_mult', perLevel: 0.2 },
  },
  eternity_apex_n: {
    id: 'eternity_apex_n',
    name: 'Tchnienie wieczności',
    desc: 'Szczytowy notable wieczności: bardzo silny, trwały wzrost produkcji wszystkich surowców.',
    category: 'eternity',
    cluster: 'eternity_apex',
    archetype: 'notable',
    maxLevel: 2,
    prerequisites: ['eternity_gateway'],
    baseCost: 10,
    costFactor: 1.5,
    effect: { kind: 'production_mult', perLevel: 0.2 },
  },
  eternity_apex_m1: {
    id: 'eternity_apex_m1',
    name: 'Wieczni osadnicy',
    desc: 'Trwały wzrost limitu populacji na poziom.',
    category: 'eternity',
    cluster: 'eternity_apex',
    archetype: 'minor',
    maxLevel: 7,
    prerequisites: ['eternity_apex_n'],
    baseCost: 3,
    costFactor: 1.5,
    effect: { kind: 'pop_mult', perLevel: 0.05 },
  },

  // =====================================================================
  // PANTHEON branch — combat (attack / defense / loot)
  // =====================================================================

  // --- pantheon_core: entry cluster (attack) -------------------------
  pantheon_root: {
    id: 'pantheon_root',
    name: 'Panteon',
    desc: 'Wejście do gałęzi panteonu. Trwały wzrost siły ataku wojsk na poziom — przetrwa każdą Nową Erę.',
    category: 'pantheon',
    cluster: 'pantheon_core',
    archetype: 'notable',
    maxLevel: 3,
    prerequisites: [],
    baseCost: 1,
    costFactor: 1.5,
    effect: { kind: 'attack_mult', perLevel: 0.1 },
  },
  pantheon_core_m1: {
    id: 'pantheon_core_m1',
    name: 'Bogowie wojny',
    desc: 'Trwały, drobny wzrost siły ataku wojsk na poziom.',
    category: 'pantheon',
    cluster: 'pantheon_core',
    archetype: 'minor',
    maxLevel: 8,
    prerequisites: ['pantheon_root'],
    baseCost: 1,
    costFactor: 1.5,
    effect: { kind: 'attack_mult', perLevel: 0.04 },
  },
  pantheon_core_m2: {
    id: 'pantheon_core_m2',
    name: 'Boska egida',
    desc: 'Trwały, drobny wzrost siły obrony wojsk na poziom.',
    category: 'pantheon',
    cluster: 'pantheon_core',
    archetype: 'minor',
    maxLevel: 7,
    prerequisites: ['pantheon_root'],
    baseCost: 1,
    costFactor: 1.5,
    effect: { kind: 'defense_mult', perLevel: 0.04 },
  },

  // --- pantheon_guard: defense notable cluster -----------------------
  pantheon_guard_n: {
    id: 'pantheon_guard_n',
    name: 'Tarcza panteonu',
    desc: 'Notable panteonu: znaczny, trwały wzrost siły obrony wojsk.',
    category: 'pantheon',
    cluster: 'pantheon_guard',
    archetype: 'notable',
    maxLevel: 3,
    prerequisites: ['pantheon_root'],
    baseCost: 6,
    costFactor: 1.5,
    effect: { kind: 'defense_mult', perLevel: 0.12 },
  },
  pantheon_guard_m1: {
    id: 'pantheon_guard_m1',
    name: 'Niebiańscy strażnicy',
    desc: 'Trwały wzrost siły obrony wojsk na poziom.',
    category: 'pantheon',
    cluster: 'pantheon_guard',
    archetype: 'minor',
    maxLevel: 8,
    prerequisites: ['pantheon_guard_n'],
    baseCost: 2,
    costFactor: 1.5,
    effect: { kind: 'defense_mult', perLevel: 0.04 },
  },
  pantheon_guard_m2: {
    id: 'pantheon_guard_m2',
    name: 'Gniew bogów',
    desc: 'Trwały wzrost siły ataku wojsk na poziom.',
    category: 'pantheon',
    cluster: 'pantheon_guard',
    archetype: 'minor',
    maxLevel: 7,
    prerequisites: ['pantheon_guard_n'],
    baseCost: 2,
    costFactor: 1.5,
    effect: { kind: 'attack_mult', perLevel: 0.04 },
  },

  // --- pantheon_spoils: loot notable cluster -------------------------
  pantheon_spoils_n: {
    id: 'pantheon_spoils_n',
    name: 'Łupy bogów',
    desc: 'Notable panteonu: znaczny, trwały wzrost łupów z wypraw.',
    category: 'pantheon',
    cluster: 'pantheon_spoils',
    archetype: 'notable',
    maxLevel: 3,
    prerequisites: ['pantheon_root'],
    baseCost: 6,
    costFactor: 1.5,
    effect: { kind: 'loot_mult', perLevel: 0.12 },
  },
  pantheon_spoils_m1: {
    id: 'pantheon_spoils_m1',
    name: 'Świątynne daniny',
    desc: 'Trwały wzrost łupów z wypraw na poziom.',
    category: 'pantheon',
    cluster: 'pantheon_spoils',
    archetype: 'minor',
    maxLevel: 7,
    prerequisites: ['pantheon_spoils_n'],
    baseCost: 2,
    costFactor: 1.5,
    effect: { kind: 'loot_mult', perLevel: 0.04 },
  },

  // --- pantheon_apex: gateway + szczyt panteonu (attack) -------------
  pantheon_gateway: {
    id: 'pantheon_gateway',
    name: 'Apoteoza',
    desc: 'Brama panteonu (droga, jednorazowa): trwały wzrost siły ataku wojsk. Odsłania szczytowy klaster panteonu.',
    category: 'pantheon',
    cluster: 'pantheon_apex',
    archetype: 'gateway',
    maxLevel: 1,
    prerequisites: ['pantheon_guard_n'],
    baseCost: 20,
    costFactor: 1.0,
    effect: { kind: 'attack_mult', perLevel: 0.2 },
  },
  pantheon_apex_n: {
    id: 'pantheon_apex_n',
    name: 'Awatar wojny',
    desc: 'Szczytowy notable panteonu: bardzo silny, trwały wzrost siły ataku wojsk.',
    category: 'pantheon',
    cluster: 'pantheon_apex',
    archetype: 'notable',
    maxLevel: 2,
    prerequisites: ['pantheon_gateway'],
    baseCost: 10,
    costFactor: 1.5,
    effect: { kind: 'attack_mult', perLevel: 0.2 },
  },
  pantheon_apex_m1: {
    id: 'pantheon_apex_m1',
    name: 'Mur niebios',
    desc: 'Trwały wzrost siły obrony wojsk na poziom.',
    category: 'pantheon',
    cluster: 'pantheon_apex',
    archetype: 'minor',
    maxLevel: 7,
    prerequisites: ['pantheon_apex_n'],
    baseCost: 3,
    costFactor: 1.5,
    effect: { kind: 'defense_mult', perLevel: 0.05 },
  },

  // =====================================================================
  // LEGACY branch — META (pp_mult / start_resources / cost / march)
  // =====================================================================

  // --- legacy_core: entry cluster (prestige-point multiplier) --------
  legacy_root: {
    id: 'legacy_root',
    name: 'Dziedzictwo',
    desc: 'Wejście do gałęzi dziedzictwa. Trwały wzrost zysku punktów prestiżu na poziom — każda Era przyspiesza całą pętlę prestiżu.',
    category: 'legacy',
    cluster: 'legacy_core',
    archetype: 'notable',
    maxLevel: 3,
    prerequisites: [],
    baseCost: 1,
    costFactor: 1.5,
    effect: { kind: 'pp_mult', perLevel: 0.1 },
  },
  legacy_core_m1: {
    id: 'legacy_core_m1',
    name: 'Spuścizna przodków',
    desc: 'Każdy nowy bieg zaczynasz z dodatkowym zapasem każdego surowca (na poziom).',
    category: 'legacy',
    cluster: 'legacy_core',
    archetype: 'minor',
    maxLevel: 7,
    prerequisites: ['legacy_root'],
    baseCost: 1,
    costFactor: 1.5,
    effect: { kind: 'start_resources', perLevel: 30 },
  },
  legacy_core_m2: {
    id: 'legacy_core_m2',
    name: 'Mądrość pokoleń',
    desc: 'Trwała, drobna zniżka kosztu budowy na poziom.',
    category: 'legacy',
    cluster: 'legacy_core',
    archetype: 'minor',
    maxLevel: 7,
    prerequisites: ['legacy_root'],
    baseCost: 1,
    costFactor: 1.5,
    effect: { kind: 'cost_reduction', perLevel: 0.01 },
  },

  // --- legacy_vault: starter-resources notable cluster ---------------
  legacy_vault_n: {
    id: 'legacy_vault_n',
    name: 'Skarbiec dziedzictwa',
    desc: 'Notable dziedzictwa: każdy nowy bieg zaczynasz ze znacznym zapasem każdego surowca (na poziom).',
    category: 'legacy',
    cluster: 'legacy_vault',
    archetype: 'notable',
    maxLevel: 3,
    prerequisites: ['legacy_root'],
    baseCost: 6,
    costFactor: 1.5,
    effect: { kind: 'start_resources', perLevel: 150 },
  },
  legacy_vault_m1: {
    id: 'legacy_vault_m1',
    name: 'Rodowe zapasy',
    desc: 'Każdy nowy bieg zaczynasz z dodatkowym zapasem każdego surowca (na poziom).',
    category: 'legacy',
    cluster: 'legacy_vault',
    archetype: 'minor',
    maxLevel: 7,
    prerequisites: ['legacy_vault_n'],
    baseCost: 2,
    costFactor: 1.5,
    effect: { kind: 'start_resources', perLevel: 30 },
  },
  legacy_vault_m2: {
    id: 'legacy_vault_m2',
    name: 'Odwieczne rzemiosło',
    desc: 'Trwała, drobna zniżka kosztu budowy na poziom.',
    category: 'legacy',
    cluster: 'legacy_vault',
    archetype: 'minor',
    maxLevel: 7,
    prerequisites: ['legacy_vault_n'],
    baseCost: 2,
    costFactor: 1.5,
    effect: { kind: 'cost_reduction', perLevel: 0.01 },
  },

  // --- legacy_swift: cost / march notable cluster --------------------
  legacy_swift_n: {
    id: 'legacy_swift_n',
    name: 'Dziedziczne plany',
    desc: 'Notable dziedzictwa: znaczna, trwała zniżka kosztu budowy.',
    category: 'legacy',
    cluster: 'legacy_swift',
    archetype: 'notable',
    maxLevel: 3,
    prerequisites: ['legacy_root'],
    baseCost: 7,
    costFactor: 1.5,
    effect: { kind: 'cost_reduction', perLevel: 0.03 },
  },
  legacy_swift_m1: {
    id: 'legacy_swift_m1',
    name: 'Szlaki przodków',
    desc: 'Trwałe skrócenie czasu marszu wojsk na poziom.',
    category: 'legacy',
    cluster: 'legacy_swift',
    archetype: 'minor',
    maxLevel: 7,
    prerequisites: ['legacy_swift_n'],
    baseCost: 2,
    costFactor: 1.5,
    effect: { kind: 'march_speed', perLevel: 0.015 },
  },

  // --- legacy_apex: gateway + szczyt dziedzictwa (pp_mult) -----------
  legacy_gateway: {
    id: 'legacy_gateway',
    name: 'Echo wieczności',
    desc: 'Brama dziedzictwa (droga, jednorazowa): trwały wzrost zysku punktów prestiżu. Odsłania szczytowy klaster dziedzictwa.',
    category: 'legacy',
    cluster: 'legacy_apex',
    archetype: 'gateway',
    maxLevel: 1,
    prerequisites: ['legacy_vault_n'],
    baseCost: 22,
    costFactor: 1.0,
    effect: { kind: 'pp_mult', perLevel: 0.25 },
  },
  legacy_apex_n: {
    id: 'legacy_apex_n',
    name: 'Korona dziedzictwa',
    desc: 'Szczytowy notable dziedzictwa: bardzo silny, trwały wzrost zysku punktów prestiżu.',
    category: 'legacy',
    cluster: 'legacy_apex',
    archetype: 'notable',
    maxLevel: 2,
    prerequisites: ['legacy_gateway'],
    baseCost: 12,
    costFactor: 1.5,
    effect: { kind: 'pp_mult', perLevel: 0.15 },
  },
  legacy_apex_m1: {
    id: 'legacy_apex_m1',
    name: 'Dary dynastii',
    desc: 'Każdy nowy bieg zaczynasz z dodatkowym zapasem każdego surowca (na poziom).',
    category: 'legacy',
    cluster: 'legacy_apex',
    archetype: 'minor',
    maxLevel: 7,
    prerequisites: ['legacy_apex_n'],
    baseCost: 3,
    costFactor: 1.5,
    effect: { kind: 'start_resources', perLevel: 50 },
  },
}

/**
 * Stable id list — the single source of iteration order for every order-sensitive
 * pass (aggregateEraMods, layout, validation, the sim). Object key order here =
 * source order; keep it stable when extending (append) so saves/round-trips stay
 * reproducible.
 */
export const ERA_NODE_IDS: readonly string[] = Object.keys(ERA_NODES)

/**
 * Roots = nodes with no prerequisites (always available once you have EP). Derived
 * deterministically from {@link ERA_NODE_IDS} so adding a node is a single data edit.
 * The contract: exactly the three FIXED roots (one per category).
 */
export const ERA_ROOTS: readonly string[] = ERA_NODE_IDS.filter(
  (id) => ERA_NODES[id].prerequisites.length === 0,
)
