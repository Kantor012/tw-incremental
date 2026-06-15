import type { GameState, Stats } from '../engine/state'
import type { BuildingId } from './buildings'

/**
 * Achievements catalogue (M5.4) — PURE DATA (no engine logic lives here).
 *
 * An achievement is a named DISTINCTION the player unlocks the first moment its
 * `condition` holds. In v1 it is ONLY a distinction — it grants NO gameplay bonus —
 * so adding the system leaves all 17 balance goals untouched. The catalogue is
 * data-driven: a new achievement is one entry in {@link ACHIEVEMENTS} (a name, a
 * description, a category and a pure predicate); the engine never changes.
 *
 * The condition is a PURE function over ({@link GameState}, {@link Stats}): it MUST
 * be side-effect-free, deterministic and total (it must NOT throw on ANY valid state,
 * including a brand-new one), because `checkAchievements` (systems/achievements.ts)
 * evaluates it on the deterministic tick path so unlocks are identical online/offline/
 * sim. It reads two kinds of input:
 *  - the LIFETIME counters in {@link Stats} (events that leave no standing trace —
 *    battles won/lost, loot delivered, camps razed, scouts returned, …); `lootHauled`
 *    is a Decimal, so compare it with `.gte(...)`, never `>=`;
 *  - anything derivable from {@link GameState} on the fly (current village count,
 *    summed building/tech levels, `prestige.ascensions` / `totalEarned`, …) — the small
 *    pure derivation helpers below (sumBuildingLevels, maxBuildingLevel, sumTechLevels,
 *    techNodesBought, prestigeNodesBought) all iterate the stable state maps so they are
 *    deterministic and total on any well-formed state.
 *
 * THE CATALOGUE: 30 achievements across six categories — gospodarka / militaria /
 * oblężenie i zwiad / ekspansja / drzewo / prestiż — with RISING thresholds within each
 * theme (e.g. attacksWon 1 → 10 → 50 → 250). None of them confers any in-game effect.
 *
 * Import discipline: this module imports ONLY *types* — {@link GameState}/{@link Stats}
 * from state.ts and {@link BuildingId} from buildings.ts — all erased at runtime, so it
 * adds no runtime dependency back on the engine and can never form an initialisation
 * cycle (mirrors content/tech.ts and content/prestige.ts).
 */

/**
 * One achievement definition. `id` is the stable key (matches its slot in
 * {@link ACHIEVEMENTS} and the key written into {@link GameState.achievements} on
 * unlock); `name`/`desc` are the PL display strings; `category` groups it in the UI
 * (free-form string so adding a category is a pure data change). `condition` is the
 * pure unlock predicate described in the module header.
 */
export interface AchievementDef {
  /** Stable id; equals this entry's key in {@link ACHIEVEMENTS}. */
  id: string
  /** Display name (PL). */
  name: string
  /** One-line description of how to earn it (PL). */
  desc: string
  /** UI grouping bucket (e.g. 'gospodarka' | 'militaria' | 'ekspansja' | …). Free-form. */
  category: string
  /** Pure, total, deterministic unlock predicate over (state, lifetime stats). */
  condition: (state: GameState, stats: Stats) => boolean
}

// =====================================================================
// Pure derivation helpers (no side effects, total on any well-formed state).
// Used by the conditions to test quantities that live in the live state rather
// than in the lifetime counters — current building/tech/prestige progress.
// =====================================================================

/** Sum of EVERY building level across EVERY owned village (the empire's build score). */
function sumBuildingLevels(state: GameState): number {
  let total = 0
  for (const id of state.villageOrder) {
    const v = state.villages[id]
    if (!v) continue
    for (const level of Object.values(v.buildings)) total += level
  }
  return total
}

/** Highest level of one building across all villages (e.g. the tallest warehouse). */
function maxBuildingLevel(state: GameState, building: BuildingId): number {
  let max = 0
  for (const id of state.villageOrder) {
    const v = state.villages[id]
    if (!v) continue
    const level = v.buildings[building] ?? 0
    if (level > max) max = level
  }
  return max
}

/** Sum of all purchased tech-tree node levels (the passive-tree research score). */
function sumTechLevels(state: GameState): number {
  let total = 0
  for (const level of Object.values(state.tech)) total += level
  return total
}

/** Count of DISTINCT tech nodes bought to level >= 1 (tree breadth). */
function techNodesBought(state: GameState): number {
  let n = 0
  for (const level of Object.values(state.tech)) if (level > 0) n++
  return n
}

/** Count of DISTINCT prestige nodes bought to level >= 1 (prestige-tree breadth). */
function prestigeNodesBought(state: GameState): number {
  let n = 0
  for (const level of Object.values(state.prestige.nodes)) if (level > 0) n++
  return n
}

/**
 * The achievements catalogue, keyed by id. 30 entries across six categories with
 * rising thresholds. Every condition is pure, total and safe on a fresh state (a
 * Decimal haul is compared with `.gte`); none grants any gameplay bonus.
 */
export const ACHIEVEMENTS: Record<string, AchievementDef> = {
  // =====================================================================
  // GOSPODARKA — building-out the empire (live building levels).
  // =====================================================================
  foundations: {
    id: 'foundations',
    name: 'Fundamenty',
    desc: 'Osiągnij łącznie 25 poziomów budynków we wszystkich wioskach.',
    category: 'gospodarka',
    condition: (state) => sumBuildingLevels(state) >= 25,
  },
  township: {
    id: 'township',
    name: 'Miasteczko',
    desc: 'Osiągnij łącznie 75 poziomów budynków we wszystkich wioskach.',
    category: 'gospodarka',
    condition: (state) => sumBuildingLevels(state) >= 75,
  },
  metropolis: {
    id: 'metropolis',
    name: 'Metropolia',
    desc: 'Osiągnij łącznie 150 poziomów budynków we wszystkich wioskach.',
    category: 'gospodarka',
    condition: (state) => sumBuildingLevels(state) >= 150,
  },
  high_hall: {
    id: 'high_hall',
    name: 'Wielki ratusz',
    desc: 'Rozbuduj ratusz do poziomu 12 w dowolnej wiosce.',
    category: 'gospodarka',
    condition: (state) => maxBuildingLevel(state, 'hq') >= 12,
  },
  granary: {
    id: 'granary',
    name: 'Pełne spichlerze',
    desc: 'Rozbuduj spichlerz do poziomu 15 w dowolnej wiosce.',
    category: 'gospodarka',
    condition: (state) => maxBuildingLevel(state, 'warehouse') >= 15,
  },

  // =====================================================================
  // MILITARIA — attacks won, loot hauled, raids repelled.
  // =====================================================================
  first_blood: {
    id: 'first_blood',
    name: 'Pierwsza krew',
    desc: 'Wygraj swój pierwszy atak na obóz barbarzyńców.',
    category: 'militaria',
    condition: (_state, stats) => stats.attacksWon >= 1,
  },
  warband: {
    id: 'warband',
    name: 'Drużyna wojenna',
    desc: 'Wygraj 10 ataków.',
    category: 'militaria',
    condition: (_state, stats) => stats.attacksWon >= 10,
  },
  warlord: {
    id: 'warlord',
    name: 'Wódz wojenny',
    desc: 'Wygraj 50 ataków.',
    category: 'militaria',
    condition: (_state, stats) => stats.attacksWon >= 50,
  },
  war_machine: {
    id: 'war_machine',
    name: 'Machina wojenna',
    desc: 'Wygraj 250 ataków.',
    category: 'militaria',
    condition: (_state, stats) => stats.attacksWon >= 250,
  },
  first_loot: {
    id: 'first_loot',
    name: 'Pierwszy łup',
    desc: 'Przywieź łącznie co najmniej 1000 surowców z wypraw.',
    category: 'militaria',
    condition: (_state, stats) => stats.lootHauled.gte(1000),
  },
  plunderer: {
    id: 'plunderer',
    name: 'Grabieżca',
    desc: 'Przywieź łącznie co najmniej 100 000 surowców z wypraw.',
    category: 'militaria',
    condition: (_state, stats) => stats.lootHauled.gte(100000),
  },
  treasure_hauler: {
    id: 'treasure_hauler',
    name: 'Wozy pełne skarbów',
    desc: 'Przywieź łącznie co najmniej 10 000 000 surowców z wypraw.',
    category: 'militaria',
    condition: (_state, stats) => stats.lootHauled.gte(10000000),
  },
  defender: {
    id: 'defender',
    name: 'Obrońca',
    desc: 'Odeprzyj 10 najazdów barbarzyńców.',
    category: 'militaria',
    condition: (_state, stats) => stats.raidsRepelled >= 10,
  },

  // =====================================================================
  // OBLĘŻENIE I ZWIAD — scouts returned, camps razed by catapults.
  // =====================================================================
  first_scout: {
    id: 'first_scout',
    name: 'Pierwszy zwiad',
    desc: 'Odeślij do domu pierwszego zwiadowcę z misji rozpoznania.',
    category: 'oblężenie i zwiad',
    condition: (_state, stats) => stats.scoutsReturned >= 1,
  },
  cartographer: {
    id: 'cartographer',
    name: 'Kartograf',
    desc: 'Zakończ 25 udanych misji zwiadowczych.',
    category: 'oblężenie i zwiad',
    condition: (_state, stats) => stats.scoutsReturned >= 25,
  },
  first_razed: {
    id: 'first_razed',
    name: 'Zgliszcza',
    desc: 'Obniż poziom obozu barbarzyńców katapultami po raz pierwszy.',
    category: 'oblężenie i zwiad',
    condition: (_state, stats) => stats.campsRazed >= 1,
  },
  siege_master: {
    id: 'siege_master',
    name: 'Mistrz oblężeń',
    desc: 'Zrównaj z ziemią 25 poziomów obozów katapultami.',
    category: 'oblężenie i zwiad',
    condition: (_state, stats) => stats.campsRazed >= 25,
  },

  // =====================================================================
  // EKSPANSJA — village count, founded and conquered.
  // =====================================================================
  second_village: {
    id: 'second_village',
    name: 'Ekspansja',
    desc: 'Posiadaj co najmniej 2 wioski (założone lub przejęte).',
    category: 'ekspansja',
    condition: (state) => state.villageOrder.length >= 2,
  },
  settler: {
    id: 'settler',
    name: 'Osadnik',
    desc: 'Załóż swoją pierwszą nową wioskę.',
    category: 'ekspansja',
    condition: (_state, stats) => stats.villagesFounded >= 1,
  },
  first_conquest: {
    id: 'first_conquest',
    name: 'Pierwszy podbój',
    desc: 'Przejmij swoją pierwszą wioskę barbarzyńską.',
    category: 'ekspansja',
    condition: (_state, stats) => stats.villagesConquered >= 1,
  },
  empire: {
    id: 'empire',
    name: 'Imperium',
    desc: 'Posiadaj co najmniej 5 wiosek.',
    category: 'ekspansja',
    condition: (state) => state.villageOrder.length >= 5,
  },
  great_empire: {
    id: 'great_empire',
    name: 'Wielkie imperium',
    desc: 'Posiadaj co najmniej 10 wiosek.',
    category: 'ekspansja',
    condition: (state) => state.villageOrder.length >= 10,
  },

  // =====================================================================
  // DRZEWO — passive tech-tree research progress.
  // =====================================================================
  scholar: {
    id: 'scholar',
    name: 'Uczony',
    desc: 'Wykup łącznie 10 poziomów w drzewie technologicznym.',
    category: 'drzewo',
    condition: (state) => sumTechLevels(state) >= 10,
  },
  researcher: {
    id: 'researcher',
    name: 'Badacz',
    desc: 'Wykup łącznie 50 poziomów w drzewie technologicznym.',
    category: 'drzewo',
    condition: (state) => sumTechLevels(state) >= 50,
  },
  sage: {
    id: 'sage',
    name: 'Mędrzec',
    desc: 'Wykup łącznie 150 poziomów w drzewie technologicznym.',
    category: 'drzewo',
    condition: (state) => sumTechLevels(state) >= 150,
  },
  polymath: {
    id: 'polymath',
    name: 'Erudyta',
    desc: 'Odblokuj 30 różnych węzłów w drzewie technologicznym.',
    category: 'drzewo',
    condition: (state) => techNodesBought(state) >= 30,
  },

  // =====================================================================
  // PRESTIŻ — ascensions and the permanent prestige tree.
  // =====================================================================
  first_ascension: {
    id: 'first_ascension',
    name: 'Odrodzenie',
    desc: 'Dokonaj pierwszej transcendencji (prestiżu).',
    category: 'prestiż',
    condition: (state) => state.prestige.ascensions >= 1,
  },
  reborn: {
    id: 'reborn',
    name: 'Wieczny cykl',
    desc: 'Dokonaj 5 transcendencji.',
    category: 'prestiż',
    condition: (state) => state.prestige.ascensions >= 5,
  },
  prestige_adept: {
    id: 'prestige_adept',
    name: 'Adept prestiżu',
    desc: 'Odblokuj 10 różnych węzłów w drzewie prestiżu.',
    category: 'prestiż',
    condition: (state) => prestigeNodesBought(state) >= 10,
  },
  prestige_legacy: {
    id: 'prestige_legacy',
    name: 'Dziedzictwo',
    desc: 'Zdobądź łącznie 50 punktów prestiżu w całej karierze.',
    category: 'prestiż',
    condition: (state) => state.prestige.totalEarned >= 50,
  },
}

/**
 * Stable id list, derived from {@link ACHIEVEMENTS} so adding an achievement is a
 * single data edit. `checkAchievements` iterates THIS array (fixed insertion order)
 * so the unlock check is deterministic, and the save validator uses it to reject any
 * unknown key in {@link GameState.achievements}.
 */
export const ACHIEVEMENT_IDS: readonly string[] = Object.keys(ACHIEVEMENTS)
