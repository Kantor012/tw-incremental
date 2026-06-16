import { Decimal, isFiniteDecimal } from './decimal'
import type { GameState } from './state'
import {
  recomputeDerived,
  INITIAL_BUILDINGS,
  INITIAL_UNITS,
  RAID_BASE_INTERVAL,
  HORDE_INTERVAL,
  createInitialStats,
} from './state'
import { BUILDING_IDS, BUILDINGS } from '../content/buildings'
import { UNIT_IDS } from '../content/units'
import { barbarianTarget, MAX_TARGET_LEVEL } from '../content/barbarians'
import { TECH_NODES, TECH_NODE_IDS } from '../content/tech'
import { PRESTIGE_NODES, PRESTIGE_NODE_IDS } from '../content/prestige'
import { ERA_NODES, ERA_NODE_IDS } from '../content/era'
import { DYNASTY_NODES, DYNASTY_NODE_IDS } from '../content/dynasty'
import { ACHIEVEMENT_IDS } from '../content/achievements'
import { generateWorld, WORLD_CENTER, WORLD_SIZE, DISTANCE_PER_LEVEL } from '../systems/world'

/**
 * Save/load engine. Owns the on-disk schema version and all (de)serialization.
 *
 * Design notes:
 * - The economy runs on Decimal, which JSON cannot represent natively. We tag
 *   every Decimal as `{ $d: "<string>" }` on the way out and rebuild it on the
 *   way in, so round-trips are loss-free and idempotent.
 * - This module is the value-level owner of `SAVE_VERSION`. `state.ts` imports
 *   that constant from here, and this module imports `recomputeDerived` /
 *   `INITIAL_BUILDINGS` back from `state.ts`. That two-way value import is a
 *   *benign* initialisation cycle: neither side uses the other's value at module
 *   top level — only inside function bodies (importSave/migrate here,
 *   createInitialState there) — so both modules are fully evaluated before any of
 *   those functions can run. The v5→v6 migration additionally pulls in
 *   `generateWorld` / `WORLD_CENTER` (systems/world.ts) and `barbarianTarget`
 *   (content/barbarians.ts); those too are read ONLY inside `migrate`, so the wider
 *   value cycle (save → world → barbarians → state → save) stays benign. The tech
 *   catalogue (`TECH_NODES` / `TECH_NODE_IDS`, content/tech.ts, used by the v8
 *   validation), the prestige catalogue (`PRESTIGE_NODES` / `PRESTIGE_NODE_IDS`,
 *   content/prestige.ts, used by the v9 validation), the era catalogue (`ERA_NODES` /
 *   `ERA_NODE_IDS`, content/era.ts, used by the v15 validation) and the dynasty catalogue
 *   (`DYNASTY_NODES` / `DYNASTY_NODE_IDS`, content/dynasty.ts, used by the v16 validation)
 *   are PURE DATA that import only the erased `ResourceId` type from state.ts (era.ts /
 *   dynasty.ts import nothing at all), so they add no runtime edge and can never form an
 *   initialisation cycle. The achievements
 *   id list (`ACHIEVEMENT_IDS`,
 *   content/achievements.ts, used by the v13 validation) is the same: that module imports
 *   ONLY erased types (`GameState` / `Stats` from state.ts, `BuildingId` from
 *   buildings.ts), so it too adds no runtime edge.
 * - Everything here must run headless (Node + browser): localStorage access is
 *   always feature-detected and wrapped in try/catch.
 */

/** Current save schema version. Bump together with a migration entry. */
export const SAVE_VERSION = 18

/** localStorage key under which the encoded save is persisted. */
export const LOCAL_KEY = 'tw-incremental:save'

/**
 * Resource ids required by a valid save. Duplicated here on purpose: importing
 * the `RESOURCE_IDS` *value* from state.ts would form a runtime import cycle
 * (state.ts already imports SAVE_VERSION from this module).
 */
const REQUIRED_RESOURCES = ['wood', 'clay', 'iron'] as const

/** Wire shape for a serialized Decimal. */
interface DecimalDTO {
  $d: string
}

function isDecimalDTO(value: unknown): value is DecimalDTO {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { $d?: unknown }).$d === 'string'
  )
}

/**
 * Replacer that tags Decimals. We read `this[key]` (the *original* value) rather
 * than `value`, because JSON.stringify may have already run a `toJSON` hook and
 * handed us a transformed value — the raw slot still holds the Decimal instance.
 */
function replacer(this: Record<string, unknown>, key: string, value: unknown): unknown {
  const raw = this[key]
  if (raw instanceof Decimal) return { $d: raw.toString() }
  return value
}

/** Reviver that rebuilds Decimals from their `{ $d }` wire shape. */
function reviver(_key: string, value: unknown): unknown {
  if (isDecimalDTO(value)) return new Decimal(value.$d)
  return value
}

/**
 * Serialize a GameState to JSON. Round-trip-faithful and idempotent:
 * `serialize(deserialize(serialize(s))) === serialize(s)`.
 */
export function serialize(state: GameState): string {
  return JSON.stringify(state, replacer)
}

/** Parse a JSON string produced by {@link serialize} back into a GameState. */
export function deserialize(json: string): GameState {
  return JSON.parse(json, reviver) as GameState
}

/**
 * Migrate a raw, possibly-old save object up to {@link SAVE_VERSION}.
 *
 * Each entry `migrations[n]` upgrades a v`n` save to v`n+1` and MUST set the new
 * `version`. A missing migration for a version below current is a hard error —
 * silently relabelling an old-shaped save as current would corrupt it (CLAUDE.md
 * hard rule #3: "Brak migracji = brak merge"). A save from a *newer* version
 * (v >= SAVE_VERSION) is returned untouched (best-effort forward compat).
 */
export function migrate(raw: any): any {
  const migrations: Record<number, (s: any) => any> = {
    // v0 is the pre-versioning save; it shares the v1 shape, so just stamp it.
    0: (s) => ({ ...s, version: 1 }),
    // v1 -> v2: buildings system. v1 had flat production/storageCap; v2 derives
    // them from building levels. Seed the new fields (levels + popCap) so the
    // shape validates; importSave then calls recomputeDerived to make
    // production/storageCap/popCap consistent with the seeded levels.
    1: (s) => ({
      ...s,
      buildings: { ...INITIAL_BUILDINGS },
      popCap: new Decimal(0),
      version: 2,
    }),
    // v2 -> v3: units + recruitment. Seed empty unit counts and an empty training
    // queue, and merge in any buildings added since v2 (e.g. the barracks) keyed
    // at their initial level WITHOUT clobbering the player's existing levels —
    // `...s.buildings` wins over the seed so progress is preserved. importSave then
    // re-derives the cached stats from the merged levels.
    2: (s) => ({
      ...s,
      buildings: { ...INITIAL_BUILDINGS, ...(s.buildings ?? {}) },
      units: { ...INITIAL_UNITS },
      recruitQueue: [],
      version: 3,
    }),
    // v3 -> v4: combat (marches + raids). Seed the new fields a pre-combat save
    // lacks: no armies in transit, an empty battle log, and the raid clock armed at
    // its base interval so the first raid is a full interval away (never instant).
    3: (s) => ({
      ...s,
      marches: [],
      battleLog: [],
      raidTimer: RAID_BASE_INTERVAL,
      version: 4,
    }),
    // v4 -> v5: single village -> multi-village (M2.1). A v4 save IS the capital's
    // economy at top level; wrap those nine per-village fields (plus a stable id and
    // the legacy "Stolica" name) under villages.v0 and seed the bijective
    // villageOrder. The battle log becomes GLOBAL: every legacy report is stamped
    // with villageId 'v0' (it could only have come from the lone village). Nothing
    // is recomputed here — importSave's recomputeDerived pass reconciles the cached
    // derived fields afterwards, exactly as for every other migration.
    4: (s) => ({
      version: 5,
      seed: s.seed,
      rngState: s.rngState,
      createdAt: s.createdAt,
      lastSeen: s.lastSeen,
      villages: {
        v0: {
          id: 'v0',
          name: 'Stolica',
          resources: s.resources,
          production: s.production,
          storageCap: s.storageCap,
          popCap: s.popCap,
          buildings: s.buildings,
          units: s.units,
          recruitQueue: s.recruitQueue,
          marches: s.marches,
          raidTimer: s.raidTimer,
        },
      },
      villageOrder: ['v0'],
      battleLog: (Array.isArray(s.battleLog) ? s.battleLog : []).map((r: any) => ({
        ...r,
        villageId: 'v0',
      })),
    }),
    // v5 -> v6: spatial world (M2.2). A v5 save predates map coordinates and the
    // barbarian world. Give every village an (x, y): the capital ('v0') stands at
    // WORLD_CENTER; any other village (none exist at v5 today — purely defensive) is
    // spread deterministically onto a golden-angle spiral around the centre so coords
    // stay stable, off-centre and in-bounds. Regenerate the barbarian world from the
    // run seed (on world.ts's OWN RNG stream — it never touches rngState). Each
    // in-flight march is upgraded to the M2.2 shape: it has no real target id, so
    // 'legacy', with geometry reconstructed from the OLD distance — placed due-"east"
    // of its village at targetX = village.x + barbarianTarget(targetLevel).distance,
    // targetY = village.y — which preserves the source→target Euclidean distance (and
    // hence the return-leg travel time computed by marches.ts). `remaining` is left
    // untouched. Nothing is recomputed here; importSave's recomputeDerived pass runs
    // afterwards exactly as for every other migration.
    5: (s) => {
      const clamp = (n: number): number => (n < 0 ? 0 : n > WORLD_SIZE ? WORLD_SIZE : n)
      const order: string[] = Array.isArray(s.villageOrder)
        ? s.villageOrder
        : Object.keys(s.villages ?? {})
      const villages: Record<string, any> = {}
      let spreadIndex = 0
      for (const id of order) {
        const v = (s.villages ?? {})[id]
        // Leave a malformed entry untouched so validateState rejects it loudly.
        if (!isObject(v)) {
          villages[id] = v
          continue
        }
        let x: number
        let y: number
        if (
          typeof v.x === 'number' &&
          Number.isFinite(v.x) &&
          typeof v.y === 'number' &&
          Number.isFinite(v.y)
        ) {
          // Forward-compat: a save that already carries coords keeps them verbatim.
          x = v.x
          y = v.y
        } else if (id === 'v0') {
          x = WORLD_CENTER.x
          y = WORLD_CENTER.y
        } else {
          const angle = spreadIndex * 2.399963229728653 // golden angle (rad)
          const radius = DISTANCE_PER_LEVEL * (2 + spreadIndex)
          x = clamp(Math.round(WORLD_CENTER.x + radius * Math.cos(angle)))
          y = clamp(Math.round(WORLD_CENTER.y + radius * Math.sin(angle)))
          spreadIndex++
        }
        const marches = Array.isArray(v.marches)
          ? v.marches.map((m: any) =>
              isObject(m)
                ? {
                    ...m,
                    targetId: typeof m.targetId === 'string' ? m.targetId : 'legacy',
                    targetX:
                      typeof m.targetX === 'number'
                        ? m.targetX
                        : x + barbarianTarget(m.targetLevel as number).distance,
                    targetY: typeof m.targetY === 'number' ? m.targetY : y,
                  }
                : m,
            )
          : v.marches
        villages[id] = { ...v, x, y, marches }
      }
      return { ...s, villages, world: generateWorld(s.seed), version: 6 }
    },
    // v6 -> v7: nobles + conquest (M2.4). A v6 save predates the noble unit, the
    // academy ("Pałac") building and barbarian loyalty. Backfill those WITHOUT
    // disturbing the player's progress:
    //  - every village's `buildings` gains the new key (academy:0) and `units` gains
    //    (noble:0) by spreading INITIAL_BUILDINGS / INITIAL_UNITS *first*, so the
    //    save's own values win over the seed and existing levels/counts are preserved;
    //  - every in-flight march's `units` gets the noble:0 slot the same way (over the
    //    zero full roster), so its dispatched subset has the M2.4 key order;
    //  - every barbarian gains `loyalty`, defaulting to full (100 = hardest to take)
    //    unless the save already carries a numeric one (forward-compat).
    // Malformed entries are left as-is so validateState rejects them loudly. Nothing
    // is recomputed here; importSave's recomputeDerived pass runs afterwards exactly
    // as for every other migration.
    6: (s) => {
      const order: string[] = Array.isArray(s.villageOrder)
        ? s.villageOrder
        : Object.keys(s.villages ?? {})
      const villages: Record<string, any> = {}
      for (const id of order) {
        const v = (s.villages ?? {})[id]
        if (!isObject(v)) {
          villages[id] = v
          continue
        }
        const marches = Array.isArray(v.marches)
          ? v.marches.map((m: any) =>
              isObject(m)
                ? { ...m, units: { ...INITIAL_UNITS, ...(isObject(m.units) ? m.units : {}) } }
                : m,
            )
          : v.marches
        villages[id] = {
          ...v,
          buildings: { ...INITIAL_BUILDINGS, ...(isObject(v.buildings) ? v.buildings : {}) },
          units: { ...INITIAL_UNITS, ...(isObject(v.units) ? v.units : {}) },
          marches,
        }
      }
      const barbarians = Array.isArray(s.world?.barbarians)
        ? s.world.barbarians.map((b: any) =>
            isObject(b) ? { ...b, loyalty: typeof b.loyalty === 'number' ? b.loyalty : 100 } : b,
          )
        : s.world?.barbarians
      const world = isObject(s.world) ? { ...s.world, barbarians } : s.world
      return { ...s, villages, world, version: 7 }
    },
    // v7 -> v8: global passive tree (M3.1). A v7 save predates the account-wide tech
    // map, so backfill the single new field — `tech`, a sparse `{ nodeId: level }` map
    // (absent key = level 0) — as empty. Its economic multipliers are TRANSIENT (folded
    // by aggregateTechMods in recomputeDerived), so nothing else is stored or seeded
    // here. A forward-compat save that already carries an object `tech` keeps it
    // verbatim; any non-object (corrupt/missing) is reset to {}. Nothing is recomputed
    // here; importSave's recomputeDerived pass runs afterwards exactly as for every
    // other migration (and now also folds in the — empty — tech mods).
    7: (s) => ({ ...s, tech: isObject(s.tech) ? s.tech : {}, version: 8 }),
    // v8 -> v9: prestige / ascension (M4.1). A v8 save predates the permanent,
    // account-wide prestige tree, so backfill the single new field — `prestige`, the
    // persistent { points, totalEarned, ascensions, nodes } record (current PP balance,
    // lifetime PP earned, ascension count and a sparse { nodeId: level } map). The
    // prestige multipliers it drives are TRANSIENT (folded by aggregatePrestigeMods inside
    // effectiveMods in recomputeDerived), so nothing else is stored or seeded here. A
    // forward-compat save that already carries an object `prestige` keeps it verbatim; any
    // non-object (corrupt/missing) is reset to the zero state. Nothing is recomputed here;
    // importSave's recomputeDerived pass runs afterwards exactly as for every other
    // migration (and now also folds in the — empty — prestige mods).
    8: (s) => ({
      ...s,
      prestige: isObject(s.prestige)
        ? s.prestige
        : { points: 0, totalEarned: 0, ascensions: 0, nodes: {} },
      version: 9,
    }),
    // v9 -> v10: idle automation (M5.1). A v9 save predates the automation toggles +
    // policy, so backfill the single new field — `automation`, the { build, recruit,
    // attack, recruitUnit, recruitTarget } record — all OFF (no unit chosen, target 0).
    // Defaulting everything off makes a migrated save behave EXACTLY like pre-M5.1 play
    // (the routines only fire when both unlocked in the tree AND switched on), so no
    // balance goal is disturbed. A forward-compat save that already carries an object
    // `automation` keeps it verbatim; any non-object (corrupt/missing) is reset to the
    // all-off default. Nothing is recomputed here (automation is read straight from the
    // state by runAutomation each sub-step, not a derived field); importSave's
    // recomputeDerived pass still runs afterwards exactly as for every other migration.
    9: (s) => ({
      ...s,
      automation: isObject(s.automation)
        ? s.automation
        : { build: false, recruit: false, attack: false, recruitUnit: null, recruitTarget: 0 },
      version: 10,
    }),
    // v10 -> v11: wall (defensive building) + scouts (recon unit + march kinds) (M5.2).
    // A v10 save predates FOUR new bits of state, all backfilled WITHOUT disturbing the
    // player's progress:
    //  - the new 'wall' BUILDING key and 'scout' UNIT key (both appended to
    //    BUILDING_IDS / UNIT_IDS): every village's `buildings` gains wall:0 and `units`
    //    gains scout:0 by spreading INITIAL_BUILDINGS / INITIAL_UNITS *first*, so the
    //    save's own levels/counts win over the seed and existing progress is preserved
    //    (exactly as the v2->v3 / v6->v7 building-and-unit backfills did). Without this,
    //    validateVillage — which iterates the now-longer lists — would reject the save;
    //  - every in-flight march gets the scout:0 unit slot the same way, and gains
    //    `kind: 'attack'` (the only kind that existed before M5.2) unless it already
    //    carries a string one (forward-compat);
    //  - every barbarian gains `scouted: false` (undiscovered) unless it already carries
    //    a boolean one (forward-compat).
    // Malformed entries are left as-is so validateState rejects them loudly. Nothing is
    // recomputed here; importSave's recomputeDerived pass runs afterwards exactly as for
    // every other migration.
    10: (s) => {
      const order: string[] = Array.isArray(s.villageOrder)
        ? s.villageOrder
        : Object.keys(s.villages ?? {})
      const villages: Record<string, any> = {}
      for (const id of order) {
        const v = (s.villages ?? {})[id]
        if (!isObject(v)) {
          villages[id] = v
          continue
        }
        const marches = Array.isArray(v.marches)
          ? v.marches.map((m: any) =>
              isObject(m)
                ? {
                    ...m,
                    kind: typeof m.kind === 'string' ? m.kind : 'attack',
                    units: { ...INITIAL_UNITS, ...(isObject(m.units) ? m.units : {}) },
                  }
                : m,
            )
          : v.marches
        villages[id] = {
          ...v,
          buildings: { ...INITIAL_BUILDINGS, ...(isObject(v.buildings) ? v.buildings : {}) },
          units: { ...INITIAL_UNITS, ...(isObject(v.units) ? v.units : {}) },
          marches,
        }
      }
      const barbarians = Array.isArray(s.world?.barbarians)
        ? s.world.barbarians.map((b: any) =>
            isObject(b)
              ? { ...b, scouted: typeof b.scouted === 'boolean' ? b.scouted : false }
              : b,
          )
        : s.world?.barbarians
      const world = isObject(s.world) ? { ...s.world, barbarians } : s.world
      return { ...s, villages, world, version: 11 }
    },
    // v11 -> v12: siege engines — the ram + catapult units (M5.3). A v11 save predates
    // the two new UNIT keys (both appended to UNIT_IDS after 'scout'), so backfill them
    // to 0 WITHOUT disturbing the player's progress:
    //  - every village's `units` gains ram:0 and catapult:0 by spreading INITIAL_UNITS
    //    *first*, so the save's own counts win over the seed and existing progress is
    //    preserved (exactly as the v2->v3 / v6->v7 / v10->v11 unit backfills did). Without
    //    this, validateVillage — which iterates the now-longer UNIT_IDS — would reject the
    //    save;
    //  - every in-flight march gets the ram:0 / catapult:0 unit slots the same way (over
    //    the zero full roster), so its dispatched subset has the M5.3 key order.
    // M5.3 adds NO new building, march kind or barbarian field (siege is a per-unit role
    // tag plus pure combat/march logic), so nothing else is touched — the barbarian level
    // band is unchanged and the catapult only ever LOWERS a camp's level with a >= 1 clamp
    // applied in marches.advanceMarches, so no persisted level can leave validateState's
    // [1, MAX_TARGET_LEVEL] range. Malformed entries are left as-is so validateState rejects
    // them loudly. Nothing is recomputed here; importSave's recomputeDerived pass runs
    // afterwards exactly as for every other migration.
    11: (s) => {
      const order: string[] = Array.isArray(s.villageOrder)
        ? s.villageOrder
        : Object.keys(s.villages ?? {})
      const villages: Record<string, any> = {}
      for (const id of order) {
        const v = (s.villages ?? {})[id]
        if (!isObject(v)) {
          villages[id] = v
          continue
        }
        const marches = Array.isArray(v.marches)
          ? v.marches.map((m: any) =>
              isObject(m)
                ? { ...m, units: { ...INITIAL_UNITS, ...(isObject(m.units) ? m.units : {}) } }
                : m,
            )
          : v.marches
        villages[id] = {
          ...v,
          units: { ...INITIAL_UNITS, ...(isObject(v.units) ? v.units : {}) },
          marches,
        }
      }
      return { ...s, villages, version: 12 }
    },
    // v12 -> v13: lifetime stats + achievements (M5.4). A v12 save predates the two new
    // account-wide fields, so backfill them WITHOUT disturbing the player's progress:
    //  - `stats` — the permanent career counters ({ attacksWon, attacksLost, lootHauled,
    //    raidsRepelled, raidsLost, campsRazed, scoutsReturned, villagesFounded,
    //    villagesConquered }) — seeded to the all-zero record (createInitialStats(), with
    //    lootHauled a Decimal zero). They are EVENT counters that leave no standing trace,
    //    so an old save genuinely has no value to recover: zero is the honest career start.
    //  - `achievements` — the sparse `{ id: unlock-marker }` map — seeded EMPTY ({}); the
    //    first tick after load re-evaluates every condition over the migrated state and
    //    unlocks any whose threshold the carried-over progress already meets (a pure DATA
    //    distinction with no gameplay bonus, so the 17 balance goals stay untouched).
    // A forward-compat save that already carries an object for either field keeps it
    // verbatim (validateState then vets it); any non-object (corrupt/missing) is reset to
    // its default. Nothing is recomputed here; importSave's recomputeDerived pass runs
    // afterwards exactly as for every other migration.
    12: (s) => ({
      ...s,
      stats: isObject(s.stats) ? s.stats : createInitialStats(),
      achievements: isObject(s.achievements) ? s.achievements : {},
      version: 13,
    }),
    // v13 -> v14: combat luck (M5.5). A v13 save predates the per-engagement luck roll
    // recorded on attack / raid battle reports, but that field — `BattleReport.luck`, a
    // finite multiplier in [1-COMBAT_LUCK, 1+COMBAT_LUCK] — is strictly OPTIONAL: an old
    // report that never recorded it stays valid ("luck unknown for this old engagement"),
    // and the `rngState` that drives the roll already lives on the state (serialized since
    // v1, simply unused by the combat path before now). So there is NOTHING to transform
    // or backfill: this is a pure version step, kept only for migration discipline (every
    // schema bump gets an entry — CLAUDE.md hard rule #3). validateState now additionally
    // vets any PRESENT `luck` on an attack / raid report (finite number > 0).
    13: (s) => ({ ...s, version: 14 }),
    // v14 -> v15: era / great reset (M6.1). A v14 save predates the permanent, account-wide
    // era tree (the SECOND meta-layer above prestige), so backfill the single new field —
    // `era`, the persistent { points, totalEarned, eras, nodes } record (current EP balance,
    // lifetime EP earned, era count and a sparse { nodeId: level } map). The era multipliers
    // it drives are TRANSIENT (folded by aggregateEraMods inside effectiveMods in
    // recomputeDerived, plus eraPpMult on the PP yield), so nothing else is stored or seeded
    // here. A forward-compat save that already carries an object `era` keeps it verbatim; any
    // non-object (corrupt/missing) is reset to the zero state. Nothing is recomputed here;
    // importSave's recomputeDerived pass runs afterwards exactly as for every other migration
    // (and now also folds in the — empty — era mods, an identity bag, so the result is
    // byte-identical to the pre-M6.1 derived stats). Mirrors the v8->v9 prestige backfill.
    14: (s) => ({
      ...s,
      era: isObject(s.era) ? s.era : { points: 0, totalEarned: 0, eras: 0, nodes: {} },
      version: 15,
    }),
    // v15 -> v16: dynasty / great-great reset (M6.2). A v15 save predates the permanent,
    // account-wide dynasty tree (the THIRD meta-layer above era), so backfill the single new
    // field — `dynasty`, the persistent { points, totalEarned, dynasties, nodes } record
    // (current DP balance, lifetime DP earned, dynasty count and a sparse { nodeId: level }
    // map). The dynasty multipliers it drives are TRANSIENT (folded by aggregateDynastyMods
    // inside effectiveMods in recomputeDerived, plus dynastyEpMult on the EP yield), so
    // nothing else is stored or seeded here. A forward-compat save that already carries an
    // object `dynasty` keeps it verbatim; any non-object (corrupt/missing) is reset to the
    // zero state. Nothing is recomputed here; importSave's recomputeDerived pass runs
    // afterwards exactly as for every other migration (and now also folds in the — empty —
    // dynasty mods, an identity bag, so the result is byte-identical to the pre-M6.2 derived
    // stats — and automations stay locked, since the gateway is unowned). Mirrors the v14->v15
    // era backfill.
    15: (s) => ({
      ...s,
      dynasty: isObject(s.dynasty)
        ? s.dynasty
        : { points: 0, totalEarned: 0, dynasties: 0, nodes: {} },
      version: 16,
    }),
    // v16 -> v17: fortresses (M7). A v16 save predates the FINITE class of boss targets and
    // the per-march target discriminant, so backfill three additive bits WITHOUT disturbing
    // the player's progress or the barbarian world:
    //  - `world.fortresses` — DETERMINISTICALLY regenerated from the run seed via
    //    generateWorld(s.seed).fortresses (its OWN rng stream, so the barbarian list is left
    //    byte-identical). A fresh, all-unrazed set is the honest start: razing is an EVENT
    //    that leaves no recoverable trace on an old save. A forward-compat save that already
    //    carries an array `world.fortresses` keeps it verbatim;
    //  - every in-flight march gains `targetType: 'camp'` (every pre-M7 march is a camp
    //    attack/scout) unless it already carries a string one (forward-compat);
    //  - `stats.fortressesRazed` — the lifetime trophy counter — seeded to 0.
    // Malformed entries are left as-is so validateState rejects them loudly. Nothing else is
    // touched (no new economic multiplier/currency — the reward is loot + a trophy stat only),
    // so a migrated run is byte-identical to pre-M7 until a fortress is actually assaulted.
    // Nothing is recomputed here; importSave's recomputeDerived pass runs afterwards exactly
    // as for every other migration.
    16: (s) => {
      const order: string[] = Array.isArray(s.villageOrder)
        ? s.villageOrder
        : Object.keys(s.villages ?? {})
      const villages: Record<string, any> = {}
      for (const id of order) {
        const v = (s.villages ?? {})[id]
        if (!isObject(v)) {
          villages[id] = v
          continue
        }
        const marches = Array.isArray(v.marches)
          ? v.marches.map((m: any) =>
              isObject(m)
                ? { ...m, targetType: typeof m.targetType === 'string' ? m.targetType : 'camp' }
                : m,
            )
          : v.marches
        villages[id] = { ...v, marches }
      }
      const fortresses = Array.isArray(s.world?.fortresses)
        ? s.world.fortresses
        : generateWorld(s.seed).fortresses
      const world = isObject(s.world) ? { ...s.world, fortresses } : s.world
      const stats = isObject(s.stats)
        ? { ...s.stats, fortressesRazed: typeof s.stats.fortressesRazed === 'number' ? s.stats.fortressesRazed : 0 }
        : s.stats
      return { ...s, villages, world, stats, version: 17 }
    },
    // v17 -> v18: hordes (M7.2). A v17 save predates the single GLOBAL horde schedule and the
    // two lifetime horde counters, so backfill three additive bits WITHOUT disturbing the
    // player's progress:
    //  - `horde` — the { timer, level } schedule — seeded { timer: HORDE_INTERVAL, level: 0 },
    //    i.e. the first horde a full interval out and escalation reset (an old save genuinely
    //    has no horde history to recover: starting fresh is the honest, and least punishing,
    //    default — the early game of the migrated run is unaffected). A forward-compat save that
    //    already carries an object `horde` keeps it verbatim;
    //  - `stats.hordesRepelled` / `stats.hordesBreached` — the lifetime trophy counters — each
    //    seeded to 0 (event tallies with no recoverable trace on an old save), mirroring the
    //    v16->v17 fortressesRazed backfill.
    // Nothing else is touched (the horde reward is a trophy/achievement + recoverable loot/army
    // swing, no new economic multiplier or currency), and the new horde clock only fires a full
    // HORDE_INTERVAL after load, so a migrated run is byte-identical to pre-M7.2 until the first
    // horde lands. Nothing is recomputed here; importSave's recomputeDerived pass runs afterwards
    // exactly as for every other migration.
    17: (s) => ({
      ...s,
      horde: isObject(s.horde) ? s.horde : { timer: HORDE_INTERVAL, level: 0 },
      stats: isObject(s.stats)
        ? {
            ...s.stats,
            hordesRepelled: typeof s.stats.hordesRepelled === 'number' ? s.stats.hordesRepelled : 0,
            hordesBreached: typeof s.stats.hordesBreached === 'number' ? s.stats.hordesBreached : 0,
          }
        : s.stats,
      version: 18,
    }),
  }
  let v = typeof raw?.version === 'number' ? raw.version : 0
  while (v < SAVE_VERSION) {
    const m = migrations[v]
    if (!m) throw new Error(`No migration from save version ${v} to ${v + 1}`)
    raw = m(raw)
    v = raw.version
  }
  return raw
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/**
 * Semantic guard for a SINGLE village. Throws on any missing/invalid field, with
 * the village id woven into the message so a bad multi-village save points at the
 * offending entry. These are EXACTLY the per-village checks the single-village save
 * (v4) ran at top level — every Decimal is value-checked (not just instanceof),
 * because a NaN / Infinity / negative would corrupt the economy and then get
 * autosaved (CLAUDE.md hard rule #3); importSave is reachable from arbitrary pasted
 * input, so this is the only semantic gate.
 */
function validateVillage(v: unknown, id: string): void {
  if (!isObject(v)) throw new Error(`save: village ${id} not an object`)
  if (typeof v.id !== 'string') throw new Error(`save: village ${id} invalid id`)
  if (typeof v.name !== 'string') throw new Error(`save: village ${id} invalid name`)

  // Map coordinates (M2.2) — plain finite numbers (not derived). They drive march
  // time / line drawing, so a NaN/Infinity here would poison every distance calc.
  if (typeof v.x !== 'number' || !Number.isFinite(v.x)) {
    throw new Error(`save: village ${id} invalid x`)
  }
  if (typeof v.y !== 'number' || !Number.isFinite(v.y)) {
    throw new Error(`save: village ${id} invalid y`)
  }

  // Storage cap must be strictly positive (resources clamp to it); popCap may be 0
  // (a freshly seeded village is recomputed only after validation, and the v4->v5
  // migration carries whatever the source save had).
  if (!(v.storageCap instanceof Decimal) || !isFiniteDecimal(v.storageCap) || v.storageCap.lte(0)) {
    throw new Error(`save: village ${id} invalid storageCap`)
  }
  if (!(v.popCap instanceof Decimal) || !isFiniteDecimal(v.popCap) || v.popCap.lt(0)) {
    throw new Error(`save: village ${id} invalid popCap`)
  }

  const { resources, production, buildings } = v
  if (!isObject(resources)) throw new Error(`save: village ${id} missing resources`)
  if (!isObject(production)) throw new Error(`save: village ${id} missing production`)
  for (const r of REQUIRED_RESOURCES) {
    const res = resources[r]
    if (!(res instanceof Decimal) || !isFiniteDecimal(res) || res.lt(0)) {
      throw new Error(`save: village ${id} invalid resource ${r}`)
    }
    const prod = production[r]
    if (!(prod instanceof Decimal) || !isFiniteDecimal(prod) || prod.lt(0)) {
      throw new Error(`save: village ${id} invalid production ${r}`)
    }
  }

  if (!isObject(buildings)) throw new Error(`save: village ${id} missing buildings`)
  for (const bid of BUILDING_IDS) {
    const level = buildings[bid]
    if (
      typeof level !== 'number' ||
      !Number.isInteger(level) ||
      level < 0 ||
      level > BUILDINGS[bid].maxLevel
    ) {
      throw new Error(`save: village ${id} invalid building ${bid}`)
    }
  }

  // units are plain non-negative integer counts; the training queue is a list of
  // finite, non-negative number fields with a known unit id.
  const { units, recruitQueue } = v
  if (!isObject(units)) throw new Error(`save: village ${id} missing units`)
  for (const uid of UNIT_IDS) {
    const n = units[uid]
    if (typeof n !== 'number' || !Number.isInteger(n) || n < 0) {
      throw new Error(`save: village ${id} invalid unit ${uid}`)
    }
  }

  if (!Array.isArray(recruitQueue)) throw new Error(`save: village ${id} invalid recruitQueue`)
  const validIds = UNIT_IDS as readonly string[]
  for (const order of recruitQueue) {
    if (!isObject(order)) throw new Error(`save: village ${id} invalid recruit order`)
    if (typeof order.unitId !== 'string' || !validIds.includes(order.unitId)) {
      throw new Error(`save: village ${id} invalid recruit order unitId`)
    }
    for (const key of ['count', 'remaining', 'perUnitSeconds'] as const) {
      const n = order[key]
      if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) {
        throw new Error(`save: village ${id} invalid recruit order ${key}`)
      }
    }
  }

  // marches must be a list of well-formed in-transit armies. loot Decimals are
  // value-checked (finite, non-negative) exactly like the resource pool — a
  // NaN/negative haul would corrupt the economy on delivery and then get autosaved.
  const { marches, raidTimer } = v
  if (!Array.isArray(marches)) throw new Error(`save: village ${id} invalid marches`)
  for (const m of marches) {
    if (!isObject(m)) throw new Error(`save: village ${id} invalid march`)
    // kind (M5.2) is the march's purpose discriminant: 'attack' (battle + loot +
    // conquest) or 'scout' (pure recon — reveals the target, never fights/loots). The
    // v10->v11 migration backfills 'attack' on every pre-M5.2 march, so a migrated save
    // always carries a valid kind; anything else means a corrupt/tampered save.
    if (m.kind !== 'attack' && m.kind !== 'scout') {
      throw new Error(`save: village ${id} invalid march kind`)
    }
    // targetType (M7) is the target-class discriminant: 'camp' (the targetId points at a
    // world.barbarians entry) or 'fortress' (a world.fortresses entry). The v16->v17
    // migration backfills 'camp' on every pre-M7 march, so a migrated save always carries a
    // valid one; anything else means a corrupt/tampered save.
    if (m.targetType !== 'camp' && m.targetType !== 'fortress') {
      throw new Error(`save: village ${id} invalid march targetType`)
    }
    // targetLevel is the SNAPSHOT combat/loot tier; the M2.2 fields (targetId + the
    // targetX/targetY geometry snapshot) drive line drawing and the return-leg distance,
    // so coords must be finite. targetId is 'legacy' for marches carried over by the
    // v5->v6 migration. A 'camp' march's tier is bounded by [1, MAX_TARGET_LEVEL]; a
    // 'fortress' march (M7) snapshots a far-ring boss tier that sits ABOVE MAX_TARGET_LEVEL,
    // so its only ceiling is "a positive integer" (mirrors the unbounded attack-report tier).
    if (typeof m.targetLevel !== 'number' || !Number.isInteger(m.targetLevel) || m.targetLevel < 1) {
      throw new Error(`save: village ${id} invalid march targetLevel`)
    }
    if (m.targetType === 'camp' && m.targetLevel > MAX_TARGET_LEVEL) {
      throw new Error(`save: village ${id} invalid march targetLevel`)
    }
    if (typeof m.targetId !== 'string') {
      throw new Error(`save: village ${id} invalid march targetId`)
    }
    if (typeof m.targetX !== 'number' || !Number.isFinite(m.targetX)) {
      throw new Error(`save: village ${id} invalid march targetX`)
    }
    if (typeof m.targetY !== 'number' || !Number.isFinite(m.targetY)) {
      throw new Error(`save: village ${id} invalid march targetY`)
    }
    if (m.phase !== 'outbound' && m.phase !== 'returning') {
      throw new Error(`save: village ${id} invalid march phase`)
    }
    if (typeof m.remaining !== 'number' || !Number.isFinite(m.remaining) || m.remaining < 0) {
      throw new Error(`save: village ${id} invalid march remaining`)
    }
    if (!isObject(m.units)) throw new Error(`save: village ${id} invalid march units`)
    for (const uid of UNIT_IDS) {
      const n = m.units[uid]
      if (typeof n !== 'number' || !Number.isInteger(n) || n < 0) {
        throw new Error(`save: village ${id} invalid march unit ${uid}`)
      }
    }
    if (!isObject(m.loot)) throw new Error(`save: village ${id} invalid march loot`)
    for (const r of REQUIRED_RESOURCES) {
      const n = m.loot[r]
      if (!(n instanceof Decimal) || !isFiniteDecimal(n) || n.lt(0)) {
        throw new Error(`save: village ${id} invalid march loot ${r}`)
      }
    }
  }

  // raid clock — a finite, non-negative number of seconds until the next raid.
  if (typeof raidTimer !== 'number' || !Number.isFinite(raidTimer) || raidTimer < 0) {
    throw new Error(`save: village ${id} invalid raidTimer`)
  }
}

/**
 * Shape guard run after migration. Throws on any missing/invalid required field
 * so {@link importSave} fails loudly and {@link loadFromLocal}'s catch falls back
 * to a fresh save instead of booting a half-initialised state that would crash
 * the app on the first tick (CLAUDE.md hard rule #3).
 *
 * Multi-village (M2.1): the global header is checked, then `villages` /
 * `villageOrder` must form a bijection (every ordered id has a village and every
 * village key is ordered, exactly once — so the tick iterates each village once and
 * never references a missing entry), every village passes {@link validateVillage},
 * the spatial `world` (M2.2) is checked (its `barbarians` list, each with a finite
 * coordinate, a level in [1, MAX_TARGET_LEVEL], a `loyalty` in [0, 100] since M2.4 and
 * a boolean `scouted` since M5.2, PLUS the M7 `fortresses` list — finite coords, an integer
 * level >= 1 with no camp ceiling, a string id/name and a boolean `razed`), every village's
 * marches now also carry a `kind` discriminant in {`attack`, `scout`} (M5.2) and an M7
 * `targetType` in {`camp`, `fortress`} (a camp march keeps the [1, MAX_TARGET_LEVEL] tier
 * ceiling; a fortress march's tier is only bounded below) and the new `wall` building / `scout` unit
 * and the M5.3 siege units (`ram` / `catapult`, appended to UNIT_IDS) validate like any
 * other roster entry (the lists simply grew — siege is a per-unit role tag plus pure
 * combat/march logic, so it adds no new persisted field of its own), the GLOBAL battle log is validated (each report's `villageId`, plus the
 * M2.4 `conquer` variant alongside the existing `attack` / `raid`, and the OPTIONAL M5.5
 * `luck` roll on an attack / raid report — a finite power multiplier > 0 when present), and finally the
 * M3.1 `tech` map is checked (an object whose every present key is a known node id at
 * an integer level within that node's [0, maxLevel] band; unknown keys are rejected),
 * and finally the M4.1 `prestige` record is checked (the PP counters `points` /
 * `totalEarned` / `ascensions` are finite, non-negative numbers, and its `nodes` map
 * follows the same known-id / [0, maxLevel] rule as `tech`), and finally the M5.1
 * `automation` record is checked (the three switches are booleans, `recruitUnit` is
 * `null` or a known unit id, and `recruitTarget` is a non-negative integer), and finally
 * the M5.4 lifetime `stats` record (nine non-negative integer event counters — including the
 * M7 `fortressesRazed` — plus the Decimal `lootHauled`, finite + non-negative) and the M5.4 `achievements` map (every
 * present key a known ACHIEVEMENT_ID, every value a finite, non-negative unlock marker).
 */
export function validateState(s: unknown): GameState {
  if (!isObject(s)) throw new Error('save: not an object')
  if (typeof s.version !== 'number') throw new Error('save: missing version')
  if (typeof s.seed !== 'string') throw new Error('save: missing seed')
  if (typeof s.rngState !== 'number') throw new Error('save: missing rngState')
  if (typeof s.createdAt !== 'number' || !Number.isFinite(s.createdAt)) {
    throw new Error('save: invalid createdAt')
  }
  if (typeof s.lastSeen !== 'number' || !Number.isFinite(s.lastSeen)) {
    throw new Error('save: invalid lastSeen')
  }

  // villages + villageOrder must be a strict bijection: every ordered id resolves
  // to a village, every village key is ordered, and there are no duplicates (the
  // length check rules out a repeated id that would make the tick simulate a
  // village twice). This is what lets every other system trust villageOrder.
  const { villages, villageOrder } = s
  if (!isObject(villages)) throw new Error('save: missing villages')
  if (!Array.isArray(villageOrder) || villageOrder.length === 0) {
    throw new Error('save: invalid villageOrder')
  }
  for (const id of villageOrder) {
    if (typeof id !== 'string') throw new Error('save: invalid villageOrder id')
    if (!isObject(villages[id])) throw new Error(`save: villageOrder id ${id} not in villages`)
  }
  const villageKeys = Object.keys(villages)
  if (villageKeys.length !== villageOrder.length) {
    throw new Error('save: villageOrder / villages length mismatch')
  }
  for (const key of villageKeys) {
    if (!villageOrder.includes(key)) {
      throw new Error(`save: village ${key} not in villageOrder`)
    }
  }
  for (const id of villageOrder) validateVillage(villages[id], id)

  // Spatial world (M2.2) — a Decimal-free bag of plain barbarian descriptors,
  // deterministically generated from the seed. The UI and marches.ts index into
  // it by id and read `level` to resolve combat (via barbarianTarget), so each
  // entry must be well-formed: a bad level would mis-resolve a battle and then get
  // autosaved, and a NaN coordinate would poison distance/march-time maths.
  const { world } = s
  if (!isObject(world)) throw new Error('save: missing world')
  if (!Array.isArray(world.barbarians)) throw new Error('save: invalid world.barbarians')
  for (const b of world.barbarians) {
    if (!isObject(b)) throw new Error('save: invalid barbarian village')
    if (typeof b.id !== 'string') throw new Error('save: invalid barbarian id')
    if (typeof b.x !== 'number' || !Number.isFinite(b.x)) {
      throw new Error('save: invalid barbarian x')
    }
    if (typeof b.y !== 'number' || !Number.isFinite(b.y)) {
      throw new Error('save: invalid barbarian y')
    }
    if (
      typeof b.level !== 'number' ||
      !Number.isInteger(b.level) ||
      b.level < 1 ||
      b.level > MAX_TARGET_LEVEL
    ) {
      throw new Error('save: invalid barbarian level')
    }
    if (typeof b.name !== 'string') throw new Error('save: invalid barbarian name')
    // Conquest loyalty (M2.4) — a finite number in [0, 100]. The march/regen path
    // keeps it clamped to that band (a hit that drives it <= 0 conquers and removes
    // the village in the same sub-step, so a persisted barbarian never carries a
    // negative), and an out-of-range / NaN loyalty would mis-drive the conquest
    // maths, so reject it loudly rather than autosave a corrupt world.
    if (typeof b.loyalty !== 'number' || !Number.isFinite(b.loyalty) || b.loyalty < 0 || b.loyalty > 100) {
      throw new Error('save: invalid barbarian loyalty')
    }
    // Scouted flag (M5.2) — a plain boolean: false until a scout march has reached and
    // returned from this camp, then true (the UI gates its defence/loot reveal on it).
    // generateWorld seeds false and the v10->v11 migration backfills false, so a fresh or
    // migrated world always carries a boolean; anything else means a corrupt/tampered save.
    if (typeof b.scouted !== 'boolean') {
      throw new Error('save: invalid barbarian scouted')
    }
  }

  // Fortresses (M7) — the FINITE set of boss targets, mirroring the barbarian list above:
  // an array of plain descriptors deterministically generated from the seed (on a separate
  // rng stream). marches.ts indexes into it by id and reads `level` to resolve combat (via
  // fortressTarget), so each entry must be well-formed — a bad level/coord would mis-resolve
  // an assault and then get autosaved. The one mutable field is `razed` (a boolean one-shot,
  // unlike a barbarian's loyalty/scouted). The v16->v17 migration backfills the whole array
  // from the seed, so a migrated world always carries a (possibly empty, but well-shaped) list.
  if (!Array.isArray(world.fortresses)) throw new Error('save: invalid world.fortresses')
  for (const f of world.fortresses) {
    if (!isObject(f)) throw new Error('save: invalid fortress')
    if (typeof f.id !== 'string') throw new Error('save: invalid fortress id')
    if (typeof f.x !== 'number' || !Number.isFinite(f.x)) {
      throw new Error('save: invalid fortress x')
    }
    if (typeof f.y !== 'number' || !Number.isFinite(f.y)) {
      throw new Error('save: invalid fortress y')
    }
    // A fortress tier sits at a FAR ring ABOVE the camp ceiling, so the only bound is
    // "a positive integer" (no MAX_TARGET_LEVEL cap — mirrors the fortress march tier).
    if (typeof f.level !== 'number' || !Number.isInteger(f.level) || f.level < 1) {
      throw new Error('save: invalid fortress level')
    }
    if (typeof f.name !== 'string') throw new Error('save: invalid fortress name')
    // Razed flag (M7) — a plain boolean one-shot: false until a victorious assault razes the
    // fortress for good, then true (a razed fortress is permanently out of play). generateWorld
    // seeds false and the v16->v17 migration backfills the array fresh, so a fresh or migrated
    // world always carries a boolean; anything else means a corrupt/tampered save.
    if (typeof f.razed !== 'boolean') {
      throw new Error('save: invalid fortress razed')
    }
  }

  // GLOBAL battle log — a list of plain-JSON reports (no Decimals). Validate the
  // discriminant and shared fields; loot is a pre-summed string (never a number),
  // and since M2.1 each report carries the villageId it came from.
  const { battleLog } = s
  if (!Array.isArray(battleLog)) throw new Error('save: invalid battleLog')
  for (const r of battleLog) {
    if (!isObject(r)) throw new Error('save: invalid battle report')
    if (r.kind !== 'attack' && r.kind !== 'raid' && r.kind !== 'horde' && r.kind !== 'conquer') {
      throw new Error('save: invalid battle report kind')
    }
    // villageId is shared by all three variants (the village the report belongs to).
    if (typeof r.villageId !== 'string') throw new Error('save: invalid battle report villageId')
    // conquer (M2.4) is a distinct shape: no won/losses, but it names the taken
    // barbarian village and the brand-new player village created in its place.
    if (r.kind === 'conquer') {
      if (typeof r.targetName !== 'string') {
        throw new Error('save: invalid conquer report targetName')
      }
      if (typeof r.newVillageId !== 'string') {
        throw new Error('save: invalid conquer report newVillageId')
      }
      continue
    }
    // attack | raid | horde share the combat fields (player POV win + own losses).
    if (typeof r.won !== 'boolean') throw new Error('save: invalid battle report won')
    if (typeof r.losses !== 'number' || !Number.isInteger(r.losses) || r.losses < 0) {
      throw new Error('save: invalid battle report losses')
    }
    // Combat luck (M5.5) — the per-engagement attacker-power roll, shared by both the
    // attack and raid variants. OPTIONAL: a pre-M5.5 report never recorded it (absent =
    // "luck unknown for this old engagement"), which is why the v13->v14 migration needs
    // no transform. When PRESENT it must be a finite number strictly > 0 (it is a power
    // MULTIPLIER — luckFactor returns a value in [1-COMBAT_LUCK, 1+COMBAT_LUCK], never
    // <= 0); a NaN/Infinity/zero/negative would mis-describe the engagement, so reject it
    // loudly rather than autosave a corrupt log.
    if (r.luck !== undefined && (typeof r.luck !== 'number' || !Number.isFinite(r.luck) || r.luck <= 0)) {
      throw new Error('save: invalid battle report luck')
    }
    if (r.kind === 'attack') {
      if (
        typeof r.targetLevel !== 'number' ||
        !Number.isInteger(r.targetLevel) ||
        r.targetLevel < 1
      ) {
        throw new Error('save: invalid attack report targetLevel')
      }
      if (typeof r.lootSum !== 'string') throw new Error('save: invalid attack report lootSum')
      // M2.4 conquest progress (loyaltyHit / loyaltyAfter): OPTIONAL — present only on a
      // won attack whose army carried a surviving noble. When present each must be a
      // finite number in the loyalty band [0, 100] (the same band a barbarian's loyalty
      // is validated against); absent is the normal "no noble progress" case.
      for (const key of ['loyaltyHit', 'loyaltyAfter'] as const) {
        const n = r[key]
        if (n !== undefined && (typeof n !== 'number' || !Number.isFinite(n) || n < 0 || n > 100)) {
          throw new Error(`save: invalid attack report ${key}`)
        }
      }
    } else if (typeof r.looted !== 'string') {
      // raid (M1.3) and horde (M7.2) both carry the pre-summed `looted` string.
      throw new Error('save: invalid raid/horde report looted')
    }
  }

  // GLOBAL horde schedule (M7.2) — the single { timer, level } clock for the capital
  // invasion. `timer` is a finite, non-negative number of seconds until the next horde
  // (a NaN/Infinity/negative would mis-drive the countdown), and `level` is a
  // non-negative INTEGER escalation counter (it only ever rises by 1 per horde, never
  // fractional/negative); a corrupt value would mis-scale hordePower and then get
  // autosaved (CLAUDE.md hard rule #3). The v17->v18 migration backfills the default, so
  // a migrated save always passes.
  const { horde } = s
  if (!isObject(horde)) throw new Error('save: missing horde')
  if (typeof horde.timer !== 'number' || !Number.isFinite(horde.timer) || horde.timer < 0) {
    throw new Error('save: invalid horde timer')
  }
  if (typeof horde.level !== 'number' || !Number.isInteger(horde.level) || horde.level < 0) {
    throw new Error('save: invalid horde level')
  }

  // GLOBAL passive tree (M3.1) — a sparse `{ nodeId: level }` map (absent key = level
  // 0). It is the ONLY tech field that serializes; the economic multipliers it drives
  // are TRANSIENT (recomputeDerived re-derives them via aggregateTechMods after import),
  // so there is nothing else to check. Every PRESENT key must be a KNOWN node id whose
  // level is an integer inside that node's [0, maxLevel] band — an out-of-band level
  // would mis-scale the whole economy and then get autosaved (CLAUDE.md hard rule #3).
  //
  // Unknown keys are REJECTED (fail loudly) rather than silently ignored. The contract
  // leaves the choice to this module; rejecting is the safer one here: tech is a
  // free-form account-wide map written ONLY by onPurchaseTech (known ids), unlike the
  // dense, fully-keyed buildings/units rosters, so a key outside TECH_NODE_IDS is never
  // a benign omission — it means a corrupt/tampered/forward-version save, and importSave
  // runs over arbitrary pasted input. Trade-off: a save from a FUTURE version that added
  // nodes will not load on this build (downgrade is best-effort, like the rest of
  // forward-compat). An empty `{}` always passes, which the v7->v8 migration guarantees.
  const { tech } = s
  if (!isObject(tech)) throw new Error('save: missing tech')
  const knownNodeIds = TECH_NODE_IDS as readonly string[]
  for (const nodeId of Object.keys(tech)) {
    if (!knownNodeIds.includes(nodeId)) {
      throw new Error(`save: unknown tech node ${nodeId}`)
    }
    const level = tech[nodeId]
    const maxLevel = TECH_NODES[nodeId].maxLevel
    if (
      typeof level !== 'number' ||
      !Number.isInteger(level) ||
      level < 0 ||
      level > maxLevel
    ) {
      throw new Error(`save: invalid tech level ${nodeId}`)
    }
  }

  // PERMANENT prestige / ascension record (M4.1) — the ONLY account-wide state that
  // survives an ascension reset. `points` (current PP balance), `totalEarned` (lifetime
  // PP earned) and `ascensions` (reset count) are finite, non-negative numbers; a
  // NaN/Infinity/negative would poison the PP economy and the ascension maths and then
  // get autosaved (CLAUDE.md hard rule #3). `nodes` is a sparse `{ nodeId: level }` map
  // exactly like `tech` (absent key = level 0): the global multipliers it drives are
  // TRANSIENT (re-derived by aggregatePrestigeMods inside effectiveMods in
  // recomputeDerived after import), so only the levels persist. Every PRESENT key must be
  // a KNOWN prestige node id whose level is an integer inside that node's [0, maxLevel]
  // band; unknown keys are REJECTED for the same reason as the tech map — `nodes` is a
  // free-form account-wide map written ONLY by onPurchasePrestige (known ids), so a key
  // outside PRESTIGE_NODE_IDS means a corrupt/tampered/forward-version save (downgrade is
  // best-effort, like the rest of forward-compat). An empty `{}` always passes, which the
  // v8->v9 migration guarantees.
  const { prestige } = s
  if (!isObject(prestige)) throw new Error('save: missing prestige')
  for (const key of ['points', 'totalEarned', 'ascensions'] as const) {
    const n = prestige[key]
    if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) {
      throw new Error(`save: invalid prestige ${key}`)
    }
  }
  const prestigeNodes = prestige.nodes
  if (!isObject(prestigeNodes)) throw new Error('save: invalid prestige nodes')
  const knownPrestigeIds = PRESTIGE_NODE_IDS as readonly string[]
  for (const nodeId of Object.keys(prestigeNodes)) {
    if (!knownPrestigeIds.includes(nodeId)) {
      throw new Error(`save: unknown prestige node ${nodeId}`)
    }
    const level = prestigeNodes[nodeId]
    const maxLevel = PRESTIGE_NODES[nodeId].maxLevel
    if (typeof level !== 'number' || !Number.isInteger(level) || level < 0 || level > maxLevel) {
      throw new Error(`save: invalid prestige level ${nodeId}`)
    }
  }

  // PERMANENT era record (M6.1) — the SECOND meta-layer account, which SURVIVES every era
  // reset (and which a Nowa Era wipes the prestige account in favour of). `points` (current
  // EP balance), `totalEarned` (lifetime EP earned) and `eras` (great-reset count) are
  // finite, non-negative numbers; a NaN/Infinity/negative would poison the EP economy and
  // the era maths and then get autosaved (CLAUDE.md hard rule #3). `nodes` is a sparse
  // `{ nodeId: level }` map exactly like `prestige.nodes` (absent key = level 0): the
  // multipliers it drives are TRANSIENT (re-derived by aggregateEraMods inside effectiveMods
  // in recomputeDerived after import, plus eraPpMult on the PP yield), so only the levels
  // persist. Every PRESENT key must be a KNOWN era node id whose level is an integer inside
  // that node's [0, maxLevel] band; unknown keys are REJECTED for the same reason as the
  // tech/prestige maps — `nodes` is a free-form account-wide map written ONLY by
  // onPurchaseEra (known ids), so a key outside ERA_NODE_IDS means a corrupt/tampered/
  // forward-version save (downgrade is best-effort, like the rest of forward-compat). An
  // empty `{}` always passes, which the v14->v15 migration guarantees.
  const { era } = s
  if (!isObject(era)) throw new Error('save: missing era')
  for (const key of ['points', 'totalEarned', 'eras'] as const) {
    const n = era[key]
    if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) {
      throw new Error(`save: invalid era ${key}`)
    }
  }
  const eraNodes = era.nodes
  if (!isObject(eraNodes)) throw new Error('save: invalid era nodes')
  const knownEraIds = ERA_NODE_IDS as readonly string[]
  for (const nodeId of Object.keys(eraNodes)) {
    if (!knownEraIds.includes(nodeId)) {
      throw new Error(`save: unknown era node ${nodeId}`)
    }
    const level = eraNodes[nodeId]
    const maxLevel = ERA_NODES[nodeId].maxLevel
    if (typeof level !== 'number' || !Number.isInteger(level) || level < 0 || level > maxLevel) {
      throw new Error(`save: invalid era level ${nodeId}`)
    }
  }

  // PERMANENT dynasty record (M6.2) — the THIRD meta-layer account, which SURVIVES every
  // reset (and which a Nowa Dynastia wipes the era AND prestige accounts in favour of).
  // `points` (current DP balance), `totalEarned` (lifetime DP earned) and `dynasties`
  // (great-great-reset count) are finite, non-negative numbers; a NaN/Infinity/negative would
  // poison the DP economy and the dynasty maths and then get autosaved (CLAUDE.md hard rule
  // #3). `nodes` is a sparse `{ nodeId: level }` map exactly like `era.nodes` (absent key =
  // level 0): the multipliers it drives are TRANSIENT (re-derived by aggregateDynastyMods
  // inside effectiveMods in recomputeDerived after import, plus dynastyEpMult on the EP yield
  // and the automation gateway), so only the levels persist. Every PRESENT key must be a KNOWN
  // dynasty node id whose level is an integer inside that node's [0, maxLevel] band; unknown
  // keys are REJECTED for the same reason as the tech/prestige/era maps — `nodes` is a
  // free-form account-wide map written ONLY by onPurchaseDynasty (known ids), so a key outside
  // DYNASTY_NODE_IDS means a corrupt/tampered/forward-version save (downgrade is best-effort,
  // like the rest of forward-compat). An empty `{}` always passes, which the v15->v16
  // migration guarantees.
  const { dynasty } = s
  if (!isObject(dynasty)) throw new Error('save: missing dynasty')
  for (const key of ['points', 'totalEarned', 'dynasties'] as const) {
    const n = dynasty[key]
    if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) {
      throw new Error(`save: invalid dynasty ${key}`)
    }
  }
  const dynastyNodes = dynasty.nodes
  if (!isObject(dynastyNodes)) throw new Error('save: invalid dynasty nodes')
  const knownDynastyIds = DYNASTY_NODE_IDS as readonly string[]
  for (const nodeId of Object.keys(dynastyNodes)) {
    if (!knownDynastyIds.includes(nodeId)) {
      throw new Error(`save: unknown dynasty node ${nodeId}`)
    }
    const level = dynastyNodes[nodeId]
    const maxLevel = DYNASTY_NODES[nodeId].maxLevel
    if (typeof level !== 'number' || !Number.isInteger(level) || level < 0 || level > maxLevel) {
      throw new Error(`save: invalid dynasty level ${nodeId}`)
    }
  }

  // Idle automation toggles + policy (M5.1) — the player's ON/OFF state, not a derived
  // field (runAutomation reads it straight from the state each sub-step). The three
  // switches are plain booleans; `recruitUnit` is the unit auto-recruit tops up — `null`
  // (none chosen yet) or a KNOWN unit id, anything else would mis-target recruitment and
  // then get autosaved; `recruitTarget` is the standing-count goal, a finite integer >= 0
  // (a NaN/negative/fractional would loop or never settle the auto-recruit deficit). The
  // v9->v10 migration guarantees the all-off default, so a migrated save always passes.
  const { automation } = s
  if (!isObject(automation)) throw new Error('save: missing automation')
  for (const key of ['build', 'recruit', 'attack'] as const) {
    if (typeof automation[key] !== 'boolean') {
      throw new Error(`save: invalid automation ${key}`)
    }
  }
  const recruitUnit = automation.recruitUnit
  if (
    recruitUnit !== null &&
    (typeof recruitUnit !== 'string' || !(UNIT_IDS as readonly string[]).includes(recruitUnit))
  ) {
    throw new Error('save: invalid automation recruitUnit')
  }
  const recruitTarget = automation.recruitTarget
  if (
    typeof recruitTarget !== 'number' ||
    !Number.isInteger(recruitTarget) ||
    recruitTarget < 0
  ) {
    throw new Error('save: invalid automation recruitTarget')
  }

  // PERMANENT lifetime stats (M5.4; +fortressesRazed M7) — the account-wide career counters
  // that survive every ascension. Nine of the ten are plain non-negative, finite INTEGERS
  // (event tallies — battles won/lost, raids, camps razed, fortresses razed, scouts, villages
  // founded/conquered);
  // a NaN/Infinity/negative/fractional would corrupt the career record and then get
  // autosaved (CLAUDE.md hard rule #3). `lootHauled` is the one Decimal (the economy
  // rule — the lifetime haul grows past 2^53), value-checked finite + non-negative
  // exactly like a resource pool, and round-trips via the `{ $d }` wire shape. The
  // v12->v13 migration guarantees the all-zero default, so a migrated save always passes.
  const { stats } = s
  if (!isObject(stats)) throw new Error('save: missing stats')
  for (const key of [
    'attacksWon',
    'attacksLost',
    'raidsRepelled',
    'raidsLost',
    'hordesRepelled',
    'hordesBreached',
    'campsRazed',
    'fortressesRazed',
    'scoutsReturned',
    'villagesFounded',
    'villagesConquered',
  ] as const) {
    const n = stats[key]
    if (typeof n !== 'number' || !Number.isInteger(n) || n < 0) {
      throw new Error(`save: invalid stats ${key}`)
    }
  }
  const lootHauled = stats.lootHauled
  if (!(lootHauled instanceof Decimal) || !isFiniteDecimal(lootHauled) || lootHauled.lt(0)) {
    throw new Error('save: invalid stats lootHauled')
  }

  // Unlocked ACHIEVEMENTS (M5.4) — a sparse `{ achievementId: marker }` map (absent key
  // = still locked). The marker is a DETERMINISTIC unlock tag written once by
  // checkAchievements (never a clock — no Date), so every PRESENT value must be a finite,
  // non-negative number. Every PRESENT key must be a KNOWN achievement id; unknown keys
  // are REJECTED for the same reason as the tech/prestige maps — `achievements` is written
  // ONLY by checkAchievements (known ids), so a key outside ACHIEVEMENT_IDS means a
  // corrupt/tampered/forward-version save (downgrade is best-effort, like the rest of
  // forward-compat). An empty `{}` always passes, which the v12->v13 migration guarantees.
  const { achievements } = s
  if (!isObject(achievements)) throw new Error('save: missing achievements')
  const knownAchievementIds = ACHIEVEMENT_IDS as readonly string[]
  for (const id of Object.keys(achievements)) {
    if (!knownAchievementIds.includes(id)) {
      throw new Error(`save: unknown achievement ${id}`)
    }
    const marker = achievements[id]
    if (typeof marker !== 'number' || !Number.isFinite(marker) || marker < 0) {
      throw new Error(`save: invalid achievement marker ${id}`)
    }
  }

  return s as unknown as GameState
}

/**
 * Encode a GameState as a UTF-8-safe base64 string for export/sharing.
 * btoa only handles Latin-1, so we go through TextEncoder first.
 */
export function exportSave(state: GameState): string {
  const bytes = new TextEncoder().encode(serialize(state))
  let binary = ''
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i])
  }
  return btoa(binary)
}

/** Decode a base64 string produced by {@link exportSave} (after migration). */
export function importSave(b64: string): GameState {
  const binary = atob(b64.trim())
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i)
  }
  const json = new TextDecoder().decode(bytes)
  const raw = JSON.parse(json, reviver)
  const state = validateState(migrate(raw))
  // Re-derive production / storageCap / popCap from the (possibly just-migrated)
  // building levels so the cached fields are always consistent with the source of
  // truth — both for v1->v2 upgrades and for any hand-edited/forward-compat save.
  recomputeDerived(state)
  return state
}

/** Persist the save to localStorage. Returns false when unavailable/failing. */
export function saveToLocal(state: GameState): boolean {
  if (typeof localStorage === 'undefined') return false
  try {
    localStorage.setItem(LOCAL_KEY, exportSave(state))
    return true
  } catch {
    return false
  }
}

/** Load and migrate the save from localStorage, or null when absent/failing. */
export function loadFromLocal(): GameState | null {
  if (typeof localStorage === 'undefined') return null
  try {
    const raw = localStorage.getItem(LOCAL_KEY)
    if (raw === null) return null
    return importSave(raw)
  } catch {
    return null
  }
}

/** Remove the persisted save. No-op when localStorage is unavailable. */
export function clearLocal(): void {
  if (typeof localStorage === 'undefined') return
  try {
    localStorage.removeItem(LOCAL_KEY)
  } catch {
    // ignore — clearing is best-effort
  }
}
