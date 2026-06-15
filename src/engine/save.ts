import { Decimal, isFiniteDecimal } from './decimal'
import type { GameState } from './state'
import { recomputeDerived, INITIAL_BUILDINGS, INITIAL_UNITS, RAID_BASE_INTERVAL } from './state'
import { BUILDING_IDS, BUILDINGS } from '../content/buildings'
import { UNIT_IDS } from '../content/units'
import { barbarianTarget, MAX_TARGET_LEVEL } from '../content/barbarians'
import { TECH_NODES, TECH_NODE_IDS } from '../content/tech'
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
 *   validation) is PURE DATA that imports only the erased `ResourceId` type from
 *   state.ts, so it adds no runtime edge and can never form an initialisation cycle.
 * - Everything here must run headless (Node + browser): localStorage access is
 *   always feature-detected and wrapped in try/catch.
 */

/** Current save schema version. Bump together with a migration entry. */
export const SAVE_VERSION = 8

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
    // targetLevel is the SNAPSHOT combat/loot tier (1..MAX_TARGET_LEVEL); the M2.2
    // fields (targetId + the targetX/targetY geometry snapshot) drive line drawing
    // and the return-leg distance, so coords must be finite. targetId is 'legacy'
    // for marches carried over by the v5->v6 migration.
    if (
      typeof m.targetLevel !== 'number' ||
      !Number.isInteger(m.targetLevel) ||
      m.targetLevel < 1 ||
      m.targetLevel > MAX_TARGET_LEVEL
    ) {
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
 * coordinate, a level in [1, MAX_TARGET_LEVEL] and — since M2.4 — a `loyalty` in
 * [0, 100]), the GLOBAL battle log is validated (each report's `villageId`, plus the
 * M2.4 `conquer` variant alongside the existing `attack` / `raid`), and finally the
 * M3.1 `tech` map is checked (an object whose every present key is a known node id at
 * an integer level within that node's [0, maxLevel] band; unknown keys are rejected).
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
  }

  // GLOBAL battle log — a list of plain-JSON reports (no Decimals). Validate the
  // discriminant and shared fields; loot is a pre-summed string (never a number),
  // and since M2.1 each report carries the villageId it came from.
  const { battleLog } = s
  if (!Array.isArray(battleLog)) throw new Error('save: invalid battleLog')
  for (const r of battleLog) {
    if (!isObject(r)) throw new Error('save: invalid battle report')
    if (r.kind !== 'attack' && r.kind !== 'raid' && r.kind !== 'conquer') {
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
    // attack | raid share the combat fields (player POV win + own losses).
    if (typeof r.won !== 'boolean') throw new Error('save: invalid battle report won')
    if (typeof r.losses !== 'number' || !Number.isInteger(r.losses) || r.losses < 0) {
      throw new Error('save: invalid battle report losses')
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
      throw new Error('save: invalid raid report looted')
    }
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
