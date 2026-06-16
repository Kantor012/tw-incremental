/**
 * Dynasty tree catalogue — PURE DATA (no engine logic lives here).
 *
 * The dynasty tree is the THIRD meta-layer constellation, sitting ABOVE era: it is
 * bought with DYNASTY POINTS (DP) earned by founding a "Nowa Dynastia" (the great-great
 * reset), which WIPES the entire era account (EP, era nodes, eras) AND the entire
 * prestige account (PP, prestige nodes, ascensions) and resets the run. It uses the same
 * Path-of-Exile-style cluster model as the tech / prestige / era trees, but:
 *  1. The currency is DP (a plain number on {@link DynastyNode.baseCost}), rarer than EP
 *     (the DP yield uses a cube root of the ERA account's progress score, exactly as the
 *     EP yield uses a cube root of the PRESTIGE account's progress score).
 *  2. Its effects are GLOBAL and survive EVERY reset of any kind: they COMBINE onto the
 *     tech × prestige × era bag (multipliers multiply, fractions add+clamp — see
 *     systems/dynasty.ts `aggregateDynastyMods` and systems/prestige.ts `combine`), so
 *     each dynasty stacks on top of all prior progress.
 *
 * Effect kinds mirror the multiplicative era kinds (production/storage/pop/cost/recruit/
 * march/attack/defense/loot) — all GLOBAL — plus three dynasty-only kinds:
 *  - `start_resources`, applied to the capital at the start of every fresh run (it does
 *    NOT fold into the transient multiplier bag; see `dynastyStartResourceBonus`),
 *  - the signature `ep_mult`, which multiplies ERA-POINT gain (see `dynastyEpMult`), so
 *    each new dynasty accelerates the whole era loop (mirrors era's `pp_mult`), and
 *  - the binary `automation_unlock` gateway, which — unlike every other kind — has no
 *    `perLevel`: owning it (level 1) unlocks ALL THREE idle automations (build / recruit /
 *    attack) account-wide, permanently, from the very start of every run. It is the ONLY
 *    place in the whole game where automations are unlocked from the start. It too is
 *    skipped by `dynastyEpMult` / `dynastyStartResourceBonus`.
 *
 * Import discipline: this module imports nothing from the engine at runtime (it is
 * PURE DATA), so it can never form an initialisation cycle (mirrors content/era.ts).
 *
 * SHAPE (the contract): the types below, plus the tree. The node table is the full
 * multi-branch constellation (33 nodes, 12 clusters, 3 branches); the contract (types,
 * the three FIXED roots with their effect kinds, the single `automation_unlock` gateway,
 * and the DYNASTY_NODES / DYNASTY_NODE_IDS / DYNASTY_ROOTS exports and their derivation)
 * stays fixed so layout/systems/UI bind to it.
 */

/**
 * What a dynasty node *does*, as a discriminated union — all GLOBAL and permanent across
 * every reset. `perLevel` is added per owned level to the relevant accumulator, EXCEPT
 * `automation_unlock`, which is a BINARY gate (maxLevel 1) with no magnitude.
 *
 * The nine MULTIPLICATIVE kinds mirror the era effects (a `1 + Σ` factor, or a clamped
 * fraction for the cost/recruit/march reductions); they are summed by
 * `aggregateDynastyMods` (systems/dynasty.ts) and COMBINED onto the tech × prestige × era
 * bag.
 *
 * The three dynasty-only kinds are NOT multipliers and never enter `aggregateDynastyMods`
 * as magnitudes:
 *  - `start_resources` grants `perLevel` of EACH resource per owned level at the start of
 *    a fresh run (applied to the capital by `newDynasty` / `newEra` / `ascend`);
 *  - `ep_mult` multiplies era-point gain by `1 + perLevel * level` (see `dynastyEpMult`);
 *  - `automation_unlock` (no `perLevel`) sets all three automation flags true.
 */
export type DynastyEffect =
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
  /** Mnożnik zysku punktów ery: +perLevel * poziom (sygnaturowy efekt dynastii). */
  | { kind: 'ep_mult'; perLevel: number }
  /** Binarna brama: odblokowuje WSZYSTKIE automatyzacje od startu (bez perLevel). */
  | { kind: 'automation_unlock' }

/**
 * Top-level branch of the dynasty constellation. Three branches (extensible exactly like
 * {@link EraCategory}): `sovereignty` (the era-loop accelerator + the automation gate),
 * `apotheosis` (combat might) and `continuum` (economy/permanence). The radial layout
 * treats every category as an arm automatically, so adding a branch is a pure data change.
 */
export type DynastyCategory = 'sovereignty' | 'apotheosis' | 'continuum'

/**
 * Node role, fixing the `maxLevel` band (CLAUDE.md tree rule), mirroring
 * {@link EraArchetype}:
 *  - minor:    drobny bonus na poziom -> maxLevel 7-10
 *  - notable:  silny nazwany efekt    -> maxLevel 2-3
 *  - gateway:  binarne odblokowanie / rozjazd -> maxLevel 1 (drogie)
 */
export type DynastyArchetype = 'minor' | 'notable' | 'gateway'

export interface DynastyNode {
  /** Stable id (the key under {@link DYNASTY_NODES}); what prerequisites point at. */
  id: string
  /** Display name (PL). */
  name: string
  /** Short description (PL). */
  desc: string
  category: DynastyCategory
  /** Id of the owning cluster (authoring unit: notable + ring of minors). */
  cluster: string
  archetype: DynastyArchetype
  /** Finite upgrade ceiling, 1..10, sized to the archetype (CLAUDE.md). */
  maxLevel: number
  /** Ids of nodes that must be at level >= 1 before this node is available (DAG). */
  prerequisites: string[]
  /** Cost of the *first* level (level 0 -> 1), in DYNASTY POINTS (a plain number). */
  baseCost: number
  /** Geometric DP-cost growth per owned level. */
  costFactor: number
  effect: DynastyEffect
}

/**
 * The full dynasty tree — 33 nodes, 12 clusters, 3 branches. PERMANENT across every reset;
 * effects COMBINE onto the tech × prestige × era bag (multipliers multiply, the
 * cost/recruit/march fractions add+clamp), while the three dynasty-only kinds bypass the
 * bag: `start_resources` seeds the capital at the start of every fresh run, the signature
 * `ep_mult` scales era-point gain, and the single `automation_unlock` gateway unlocks all
 * idle automations account-wide from the start (see systems/dynasty.ts).
 *
 *  - sovereignty (META: ep_mult / automation gate / start_resources / cost) — 4 clusters,
 *      11 nodes. sovereignty_core (entry, ep_mult) -> sovereignty_regency (cost notable) &
 *      sovereignty_vault (starter-resources notable) -> sovereignty_apex (the
 *      `automation_unlock` gateway + ep_mult apex). The signature `ep_mult` lives on
 *      sovereignty_root, sovereignty_core_m1 and sovereignty_apex_n, so a deep sovereignty
 *      investment compounds the whole era loop every dynasty. The lone `automation_unlock`
 *      node (sovereignty_automation) is the ONLY place automations are unlocked from start.
 *  - apotheosis (combat: attack / defense / loot) — 4 clusters, 11 nodes.
 *      apotheosis_core (entry, attack) -> apotheosis_aegis (defense notable) &
 *      apotheosis_spoils (loot notable) -> apotheosis_apex (gateway + attack apex).
 *  - continuum (economy: production / storage / pop + march) — 4 clusters, 11 nodes.
 *      continuum_core (entry, production) -> continuum_growth (pop notable) &
 *      continuum_store (storage notable) -> continuum_apex (gateway + production apex).
 *
 * Each cluster = one notable (maxLevel 2-3, strong named effect) + a ring of minors
 * (maxLevel 7-8, drobny effect); three gateways (maxLevel 1, drogie, costFactor 1.0) gate
 * the apex clusters — the sovereignty gateway is the binary `automation_unlock`. The three
 * FIXED roots (sovereignty_root / apotheosis_root / continuum_root, one per category) have
 * no prerequisites and KEEP their ids + effect kinds (ep_mult / attack_mult /
 * production_mult) — other phases depend on them. Prerequisites are a DAG with no cycles;
 * every node is reachable from a root and every node has a real effect (perLevel > 0, or
 * `automation_unlock`). DP costs grow per archetype (minor ~1-3, notable ~6-12, gateway
 * ~18-20) at costFactor ~1.5 (gateways are one-shot so their factor is inert). perLevel is
 * deliberately STRONGER than the era tree — dynasty is a higher layer — while the
 * cost/march fractions stay well under the combined clamps (cost 0.9, recruit/march 0.75).
 *
 * Object key order IS the stable source order driving every order-sensitive pass
 * (aggregateDynastyMods, layout, validation, the sim) — keep new nodes appended when
 * extending so saves/round-trips stay reproducible.
 */
export const DYNASTY_NODES: Record<string, DynastyNode> = {
  // =====================================================================
  // SOVEREIGNTY branch — META (ep_mult / automation gate / start / cost)
  // =====================================================================

  // --- sovereignty_core: entry cluster (era-point multiplier) --------
  sovereignty_root: {
    id: 'sovereignty_root',
    name: 'Suwerenność',
    desc: 'Wejście do gałęzi suwerenności. Trwały wzrost zysku punktów ery na poziom — każda Dynastia przyspiesza całą pętlę ery.',
    category: 'sovereignty',
    cluster: 'sovereignty_core',
    archetype: 'notable',
    maxLevel: 3,
    prerequisites: [],
    baseCost: 1,
    costFactor: 1.5,
    effect: { kind: 'ep_mult', perLevel: 0.15 },
  },
  sovereignty_core_m1: {
    id: 'sovereignty_core_m1',
    name: 'Wieczne berło',
    desc: 'Trwały, drobny wzrost zysku punktów ery na poziom.',
    category: 'sovereignty',
    cluster: 'sovereignty_core',
    archetype: 'minor',
    maxLevel: 8,
    prerequisites: ['sovereignty_root'],
    baseCost: 1,
    costFactor: 1.5,
    effect: { kind: 'ep_mult', perLevel: 0.05 },
  },
  sovereignty_core_m2: {
    id: 'sovereignty_core_m2',
    name: 'Skarbiec koronny',
    desc: 'Każdy nowy bieg zaczynasz z dodatkowym zapasem każdego surowca (na poziom).',
    category: 'sovereignty',
    cluster: 'sovereignty_core',
    archetype: 'minor',
    maxLevel: 7,
    prerequisites: ['sovereignty_root'],
    baseCost: 1,
    costFactor: 1.5,
    effect: { kind: 'start_resources', perLevel: 50 },
  },

  // --- sovereignty_regency: cost-reduction notable cluster -----------
  sovereignty_regency_n: {
    id: 'sovereignty_regency_n',
    name: 'Regencja',
    desc: 'Notable suwerenności: znaczna, trwała zniżka kosztu budowy.',
    category: 'sovereignty',
    cluster: 'sovereignty_regency',
    archetype: 'notable',
    maxLevel: 3,
    prerequisites: ['sovereignty_root'],
    baseCost: 6,
    costFactor: 1.5,
    effect: { kind: 'cost_reduction', perLevel: 0.03 },
  },
  sovereignty_regency_m1: {
    id: 'sovereignty_regency_m1',
    name: 'Sprawny zarząd',
    desc: 'Trwała, drobna zniżka kosztu budowy na poziom.',
    category: 'sovereignty',
    cluster: 'sovereignty_regency',
    archetype: 'minor',
    maxLevel: 7,
    prerequisites: ['sovereignty_regency_n'],
    baseCost: 2,
    costFactor: 1.5,
    effect: { kind: 'cost_reduction', perLevel: 0.015 },
  },
  sovereignty_regency_m2: {
    id: 'sovereignty_regency_m2',
    name: 'Daniny wasali',
    desc: 'Każdy nowy bieg zaczynasz z dodatkowym zapasem każdego surowca (na poziom).',
    category: 'sovereignty',
    cluster: 'sovereignty_regency',
    archetype: 'minor',
    maxLevel: 7,
    prerequisites: ['sovereignty_regency_n'],
    baseCost: 2,
    costFactor: 1.5,
    effect: { kind: 'start_resources', perLevel: 50 },
  },

  // --- sovereignty_vault: starter-resources notable cluster ----------
  sovereignty_vault_n: {
    id: 'sovereignty_vault_n',
    name: 'Skarbiec dynastii',
    desc: 'Notable suwerenności: każdy nowy bieg zaczynasz ze znacznym zapasem każdego surowca (na poziom).',
    category: 'sovereignty',
    cluster: 'sovereignty_vault',
    archetype: 'notable',
    maxLevel: 3,
    prerequisites: ['sovereignty_root'],
    baseCost: 6,
    costFactor: 1.5,
    effect: { kind: 'start_resources', perLevel: 200 },
  },
  sovereignty_vault_m1: {
    id: 'sovereignty_vault_m1',
    name: 'Rodowe włości',
    desc: 'Każdy nowy bieg zaczynasz z dodatkowym zapasem każdego surowca (na poziom).',
    category: 'sovereignty',
    cluster: 'sovereignty_vault',
    archetype: 'minor',
    maxLevel: 7,
    prerequisites: ['sovereignty_vault_n'],
    baseCost: 2,
    costFactor: 1.5,
    effect: { kind: 'start_resources', perLevel: 50 },
  },

  // --- sovereignty_apex: automation gateway + szczyt suwerenności ----
  sovereignty_automation: {
    id: 'sovereignty_automation',
    name: 'Wieczna regencja',
    desc: 'Brama suwerenności (droga, jednorazowa): trwały zarząd, który prowadzi królestwo za ciebie — odblokowuje wszystkie automatyzacje (budowa, rekrutacja, ataki) od startu każdego biegu, na zawsze. Odsłania szczytowy klaster suwerenności.',
    category: 'sovereignty',
    cluster: 'sovereignty_apex',
    archetype: 'gateway',
    maxLevel: 1,
    prerequisites: ['sovereignty_regency_n'],
    baseCost: 20,
    costFactor: 1.0,
    effect: { kind: 'automation_unlock' },
  },
  sovereignty_apex_n: {
    id: 'sovereignty_apex_n',
    name: 'Tron wieczny',
    desc: 'Szczytowy notable suwerenności: bardzo silny, trwały wzrost zysku punktów ery.',
    category: 'sovereignty',
    cluster: 'sovereignty_apex',
    archetype: 'notable',
    maxLevel: 2,
    prerequisites: ['sovereignty_automation'],
    baseCost: 12,
    costFactor: 1.5,
    effect: { kind: 'ep_mult', perLevel: 0.2 },
  },
  sovereignty_apex_m1: {
    id: 'sovereignty_apex_m1',
    name: 'Dary korony',
    desc: 'Każdy nowy bieg zaczynasz z dodatkowym zapasem każdego surowca (na poziom).',
    category: 'sovereignty',
    cluster: 'sovereignty_apex',
    archetype: 'minor',
    maxLevel: 7,
    prerequisites: ['sovereignty_apex_n'],
    baseCost: 3,
    costFactor: 1.5,
    effect: { kind: 'start_resources', perLevel: 80 },
  },

  // =====================================================================
  // APOTHEOSIS branch — combat (attack / defense / loot)
  // =====================================================================

  // --- apotheosis_core: entry cluster (attack) -----------------------
  apotheosis_root: {
    id: 'apotheosis_root',
    name: 'Apoteoza',
    desc: 'Wejście do gałęzi apoteozy. Trwały wzrost siły ataku wojsk na poziom — przetrwa każdą Nową Dynastię.',
    category: 'apotheosis',
    cluster: 'apotheosis_core',
    archetype: 'notable',
    maxLevel: 3,
    prerequisites: [],
    baseCost: 1,
    costFactor: 1.5,
    effect: { kind: 'attack_mult', perLevel: 0.15 },
  },
  apotheosis_core_m1: {
    id: 'apotheosis_core_m1',
    name: 'Krew bohaterów',
    desc: 'Trwały, drobny wzrost siły ataku wojsk na poziom.',
    category: 'apotheosis',
    cluster: 'apotheosis_core',
    archetype: 'minor',
    maxLevel: 8,
    prerequisites: ['apotheosis_root'],
    baseCost: 1,
    costFactor: 1.5,
    effect: { kind: 'attack_mult', perLevel: 0.05 },
  },
  apotheosis_core_m2: {
    id: 'apotheosis_core_m2',
    name: 'Hart ciała',
    desc: 'Trwały, drobny wzrost siły obrony wojsk na poziom.',
    category: 'apotheosis',
    cluster: 'apotheosis_core',
    archetype: 'minor',
    maxLevel: 7,
    prerequisites: ['apotheosis_root'],
    baseCost: 1,
    costFactor: 1.5,
    effect: { kind: 'defense_mult', perLevel: 0.05 },
  },

  // --- apotheosis_aegis: defense notable cluster ---------------------
  apotheosis_aegis_n: {
    id: 'apotheosis_aegis_n',
    name: 'Egida apoteozy',
    desc: 'Notable apoteozy: znaczny, trwały wzrost siły obrony wojsk.',
    category: 'apotheosis',
    cluster: 'apotheosis_aegis',
    archetype: 'notable',
    maxLevel: 3,
    prerequisites: ['apotheosis_root'],
    baseCost: 6,
    costFactor: 1.5,
    effect: { kind: 'defense_mult', perLevel: 0.15 },
  },
  apotheosis_aegis_m1: {
    id: 'apotheosis_aegis_m1',
    name: 'Niezłomna straż',
    desc: 'Trwały wzrost siły obrony wojsk na poziom.',
    category: 'apotheosis',
    cluster: 'apotheosis_aegis',
    archetype: 'minor',
    maxLevel: 8,
    prerequisites: ['apotheosis_aegis_n'],
    baseCost: 2,
    costFactor: 1.5,
    effect: { kind: 'defense_mult', perLevel: 0.05 },
  },
  apotheosis_aegis_m2: {
    id: 'apotheosis_aegis_m2',
    name: 'Furia wojny',
    desc: 'Trwały wzrost siły ataku wojsk na poziom.',
    category: 'apotheosis',
    cluster: 'apotheosis_aegis',
    archetype: 'minor',
    maxLevel: 7,
    prerequisites: ['apotheosis_aegis_n'],
    baseCost: 2,
    costFactor: 1.5,
    effect: { kind: 'attack_mult', perLevel: 0.05 },
  },

  // --- apotheosis_spoils: loot notable cluster -----------------------
  apotheosis_spoils_n: {
    id: 'apotheosis_spoils_n',
    name: 'Triumf zdobywcy',
    desc: 'Notable apoteozy: znaczny, trwały wzrost łupów z wypraw.',
    category: 'apotheosis',
    cluster: 'apotheosis_spoils',
    archetype: 'notable',
    maxLevel: 3,
    prerequisites: ['apotheosis_root'],
    baseCost: 6,
    costFactor: 1.5,
    effect: { kind: 'loot_mult', perLevel: 0.15 },
  },
  apotheosis_spoils_m1: {
    id: 'apotheosis_spoils_m1',
    name: 'Prawo miecza',
    desc: 'Trwały wzrost łupów z wypraw na poziom.',
    category: 'apotheosis',
    cluster: 'apotheosis_spoils',
    archetype: 'minor',
    maxLevel: 7,
    prerequisites: ['apotheosis_spoils_n'],
    baseCost: 2,
    costFactor: 1.5,
    effect: { kind: 'loot_mult', perLevel: 0.05 },
  },

  // --- apotheosis_apex: gateway + szczyt apoteozy (attack) -----------
  apotheosis_gateway: {
    id: 'apotheosis_gateway',
    name: 'Wniebowstąpienie',
    desc: 'Brama apoteozy (droga, jednorazowa): trwały wzrost siły ataku wojsk. Odsłania szczytowy klaster apoteozy.',
    category: 'apotheosis',
    cluster: 'apotheosis_apex',
    archetype: 'gateway',
    maxLevel: 1,
    prerequisites: ['apotheosis_aegis_n'],
    baseCost: 20,
    costFactor: 1.0,
    effect: { kind: 'attack_mult', perLevel: 0.25 },
  },
  apotheosis_apex_n: {
    id: 'apotheosis_apex_n',
    name: 'Bóg wojny',
    desc: 'Szczytowy notable apoteozy: bardzo silny, trwały wzrost siły ataku wojsk.',
    category: 'apotheosis',
    cluster: 'apotheosis_apex',
    archetype: 'notable',
    maxLevel: 2,
    prerequisites: ['apotheosis_gateway'],
    baseCost: 12,
    costFactor: 1.5,
    effect: { kind: 'attack_mult', perLevel: 0.25 },
  },
  apotheosis_apex_m1: {
    id: 'apotheosis_apex_m1',
    name: 'Niebiański mur',
    desc: 'Trwały wzrost siły obrony wojsk na poziom.',
    category: 'apotheosis',
    cluster: 'apotheosis_apex',
    archetype: 'minor',
    maxLevel: 7,
    prerequisites: ['apotheosis_apex_n'],
    baseCost: 3,
    costFactor: 1.5,
    effect: { kind: 'defense_mult', perLevel: 0.06 },
  },

  // =====================================================================
  // CONTINUUM branch — economy (production / storage / pop + march)
  // =====================================================================

  // --- continuum_core: entry cluster (production) --------------------
  continuum_root: {
    id: 'continuum_root',
    name: 'Kontinuum',
    desc: 'Wejście do gałęzi kontinuum. Trwały wzrost produkcji wszystkich surowców na poziom — przetrwa każdą Nową Dynastię.',
    category: 'continuum',
    cluster: 'continuum_core',
    archetype: 'notable',
    maxLevel: 3,
    prerequisites: [],
    baseCost: 1,
    costFactor: 1.5,
    effect: { kind: 'production_mult', perLevel: 0.15 },
  },
  continuum_core_m1: {
    id: 'continuum_core_m1',
    name: 'Wieczny urodzaj',
    desc: 'Trwały, drobny wzrost produkcji wszystkich surowców na poziom.',
    category: 'continuum',
    cluster: 'continuum_core',
    archetype: 'minor',
    maxLevel: 8,
    prerequisites: ['continuum_root'],
    baseCost: 1,
    costFactor: 1.5,
    effect: { kind: 'production_mult', perLevel: 0.05 },
  },
  continuum_core_m2: {
    id: 'continuum_core_m2',
    name: 'Trwałe składy',
    desc: 'Trwały, drobny wzrost pojemności magazynów na poziom.',
    category: 'continuum',
    cluster: 'continuum_core',
    archetype: 'minor',
    maxLevel: 8,
    prerequisites: ['continuum_root'],
    baseCost: 1,
    costFactor: 1.5,
    effect: { kind: 'storage_mult', perLevel: 0.05 },
  },

  // --- continuum_growth: population notable cluster ------------------
  continuum_growth_n: {
    id: 'continuum_growth_n',
    name: 'Nieprzerwany ród',
    desc: 'Notable kontinuum: znaczny, trwały wzrost limitu populacji.',
    category: 'continuum',
    cluster: 'continuum_growth',
    archetype: 'notable',
    maxLevel: 3,
    prerequisites: ['continuum_root'],
    baseCost: 6,
    costFactor: 1.5,
    effect: { kind: 'pop_mult', perLevel: 0.15 },
  },
  continuum_growth_m1: {
    id: 'continuum_growth_m1',
    name: 'Wieczne pokolenia',
    desc: 'Trwały wzrost limitu populacji na poziom.',
    category: 'continuum',
    cluster: 'continuum_growth',
    archetype: 'minor',
    maxLevel: 7,
    prerequisites: ['continuum_growth_n'],
    baseCost: 2,
    costFactor: 1.5,
    effect: { kind: 'pop_mult', perLevel: 0.05 },
  },
  continuum_growth_m2: {
    id: 'continuum_growth_m2',
    name: 'Odwieczne szlaki',
    desc: 'Trwałe skrócenie czasu marszu wojsk na poziom.',
    category: 'continuum',
    cluster: 'continuum_growth',
    archetype: 'minor',
    maxLevel: 7,
    prerequisites: ['continuum_growth_n'],
    baseCost: 2,
    costFactor: 1.5,
    effect: { kind: 'march_speed', perLevel: 0.02 },
  },

  // --- continuum_store: storage notable cluster ----------------------
  continuum_store_n: {
    id: 'continuum_store_n',
    name: 'Spichlerz wieczności',
    desc: 'Notable kontinuum: znaczny, trwały wzrost pojemności magazynów.',
    category: 'continuum',
    cluster: 'continuum_store',
    archetype: 'notable',
    maxLevel: 3,
    prerequisites: ['continuum_root'],
    baseCost: 6,
    costFactor: 1.5,
    effect: { kind: 'storage_mult', perLevel: 0.15 },
  },
  continuum_store_m1: {
    id: 'continuum_store_m1',
    name: 'Niewyczerpane żyły',
    desc: 'Trwały wzrost produkcji wszystkich surowców na poziom.',
    category: 'continuum',
    cluster: 'continuum_store',
    archetype: 'minor',
    maxLevel: 7,
    prerequisites: ['continuum_store_n'],
    baseCost: 2,
    costFactor: 1.5,
    effect: { kind: 'production_mult', perLevel: 0.05 },
  },

  // --- continuum_apex: gateway + szczyt kontinuum (production) -------
  continuum_gateway: {
    id: 'continuum_gateway',
    name: 'Wieczny strumień',
    desc: 'Brama kontinuum (droga, jednorazowa): trwały wzrost produkcji wszystkich surowców. Odsłania szczytowy klaster kontinuum.',
    category: 'continuum',
    cluster: 'continuum_apex',
    archetype: 'gateway',
    maxLevel: 1,
    prerequisites: ['continuum_growth_n'],
    baseCost: 18,
    costFactor: 1.0,
    effect: { kind: 'production_mult', perLevel: 0.25 },
  },
  continuum_apex_n: {
    id: 'continuum_apex_n',
    name: 'Źródło obfitości',
    desc: 'Szczytowy notable kontinuum: bardzo silny, trwały wzrost produkcji wszystkich surowców.',
    category: 'continuum',
    cluster: 'continuum_apex',
    archetype: 'notable',
    maxLevel: 2,
    prerequisites: ['continuum_gateway'],
    baseCost: 12,
    costFactor: 1.5,
    effect: { kind: 'production_mult', perLevel: 0.25 },
  },
  continuum_apex_m1: {
    id: 'continuum_apex_m1',
    name: 'Wieczni osadnicy',
    desc: 'Trwały wzrost limitu populacji na poziom.',
    category: 'continuum',
    cluster: 'continuum_apex',
    archetype: 'minor',
    maxLevel: 7,
    prerequisites: ['continuum_apex_n'],
    baseCost: 3,
    costFactor: 1.5,
    effect: { kind: 'pop_mult', perLevel: 0.06 },
  },
}

/**
 * Stable id list — the single source of iteration order for every order-sensitive
 * pass (aggregateDynastyMods, layout, validation, the sim). Object key order here =
 * source order; keep it stable when extending (append) so saves/round-trips stay
 * reproducible.
 */
export const DYNASTY_NODE_IDS: readonly string[] = Object.keys(DYNASTY_NODES)

/**
 * Roots = nodes with no prerequisites (always available once you have DP). Derived
 * deterministically from {@link DYNASTY_NODE_IDS} so adding a node is a single data edit.
 * The contract: exactly the three FIXED roots (one per category).
 */
export const DYNASTY_ROOTS: readonly string[] = DYNASTY_NODE_IDS.filter(
  (id) => DYNASTY_NODES[id].prerequisites.length === 0,
)
