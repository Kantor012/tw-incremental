import { Decimal, isFiniteDecimal } from './decimal'
import type { GameState } from './state'
import { recomputeDerived, INITIAL_BUILDINGS, INITIAL_UNITS, RAID_BASE_INTERVAL } from './state'
import { BUILDING_IDS, BUILDINGS } from '../content/buildings'
import { UNIT_IDS } from '../content/units'

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
 *   those functions can run.
 * - Everything here must run headless (Node + browser): localStorage access is
 *   always feature-detected and wrapped in try/catch.
 */

/** Current save schema version. Bump together with a migration entry. */
export const SAVE_VERSION = 4

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
 * Shape guard run after migration. Throws on any missing/invalid required field
 * so {@link importSave} fails loudly and {@link loadFromLocal}'s catch falls back
 * to a fresh save instead of booting a half-initialised state that would crash
 * the app on the first tick (CLAUDE.md hard rule #3).
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
  // Decimal fields must be value-sane, not just instanceof: NaN / Infinity /
  // negative all parse but would corrupt the live game and then get autosaved
  // (CLAUDE.md hard rule #3). importSave is reachable from arbitrary pasted input,
  // so this is the only semantic gate. Storage cap must be strictly positive
  // (resources clamp to it); popCap may be 0 (migrate seeds 0 pre-recompute).
  if (!(s.storageCap instanceof Decimal) || !isFiniteDecimal(s.storageCap) || s.storageCap.lte(0)) {
    throw new Error('save: invalid storageCap')
  }
  if (!(s.popCap instanceof Decimal) || !isFiniteDecimal(s.popCap) || s.popCap.lt(0)) {
    throw new Error('save: invalid popCap')
  }

  const { resources, production, buildings } = s
  if (!isObject(resources)) throw new Error('save: missing resources')
  if (!isObject(production)) throw new Error('save: missing production')
  for (const id of REQUIRED_RESOURCES) {
    const res = resources[id]
    if (!(res instanceof Decimal) || !isFiniteDecimal(res) || res.lt(0)) {
      throw new Error(`save: invalid resource ${id}`)
    }
    const prod = production[id]
    if (!(prod instanceof Decimal) || !isFiniteDecimal(prod) || prod.lt(0)) {
      throw new Error(`save: invalid production ${id}`)
    }
  }

  if (!isObject(buildings)) throw new Error('save: missing buildings')
  for (const id of BUILDING_IDS) {
    const level = buildings[id]
    if (
      typeof level !== 'number' ||
      !Number.isInteger(level) ||
      level < 0 ||
      level > BUILDINGS[id].maxLevel
    ) {
      throw new Error(`save: invalid building ${id}`)
    }
  }

  // v3: units are plain non-negative integer counts; the training queue is a list
  // of finite, non-negative number fields with a known unit id. importSave is
  // reachable from arbitrary pasted input, so this is the only semantic gate.
  const { units, recruitQueue } = s
  if (!isObject(units)) throw new Error('save: missing units')
  for (const id of UNIT_IDS) {
    const n = units[id]
    if (typeof n !== 'number' || !Number.isInteger(n) || n < 0) {
      throw new Error(`save: invalid unit ${id}`)
    }
  }

  if (!Array.isArray(recruitQueue)) throw new Error('save: invalid recruitQueue')
  const validIds = UNIT_IDS as readonly string[]
  for (const order of recruitQueue) {
    if (!isObject(order)) throw new Error('save: invalid recruit order')
    if (typeof order.unitId !== 'string' || !validIds.includes(order.unitId)) {
      throw new Error('save: invalid recruit order unitId')
    }
    for (const key of ['count', 'remaining', 'perUnitSeconds'] as const) {
      const v = order[key]
      if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) {
        throw new Error(`save: invalid recruit order ${key}`)
      }
    }
  }

  // v4: marches must be a list of well-formed in-transit armies. importSave is
  // reachable from arbitrary pasted input, so loot Decimals are value-checked
  // (finite, non-negative) exactly like the resource pool — a NaN/negative haul
  // would corrupt the economy on delivery and then get autosaved.
  const { marches, battleLog, raidTimer } = s
  if (!Array.isArray(marches)) throw new Error('save: invalid marches')
  for (const m of marches) {
    if (!isObject(m)) throw new Error('save: invalid march')
    if (typeof m.targetLevel !== 'number' || !Number.isInteger(m.targetLevel) || m.targetLevel < 1) {
      throw new Error('save: invalid march targetLevel')
    }
    if (m.phase !== 'outbound' && m.phase !== 'returning') {
      throw new Error('save: invalid march phase')
    }
    if (typeof m.remaining !== 'number' || !Number.isFinite(m.remaining) || m.remaining < 0) {
      throw new Error('save: invalid march remaining')
    }
    if (!isObject(m.units)) throw new Error('save: invalid march units')
    for (const id of UNIT_IDS) {
      const n = m.units[id]
      if (typeof n !== 'number' || !Number.isInteger(n) || n < 0) {
        throw new Error(`save: invalid march unit ${id}`)
      }
    }
    if (!isObject(m.loot)) throw new Error('save: invalid march loot')
    for (const id of REQUIRED_RESOURCES) {
      const v = m.loot[id]
      if (!(v instanceof Decimal) || !isFiniteDecimal(v) || v.lt(0)) {
        throw new Error(`save: invalid march loot ${id}`)
      }
    }
  }

  // v4: battle log — a list of plain-JSON reports (no Decimals). Validate the
  // discriminant and the shared fields; loot is a pre-summed string, never a number.
  if (!Array.isArray(battleLog)) throw new Error('save: invalid battleLog')
  for (const r of battleLog) {
    if (!isObject(r)) throw new Error('save: invalid battle report')
    if (r.kind !== 'attack' && r.kind !== 'raid') {
      throw new Error('save: invalid battle report kind')
    }
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
    } else if (typeof r.looted !== 'string') {
      throw new Error('save: invalid raid report looted')
    }
  }

  // v4: raid clock — a finite, non-negative number of seconds until the next raid.
  if (typeof raidTimer !== 'number' || !Number.isFinite(raidTimer) || raidTimer < 0) {
    throw new Error('save: invalid raidTimer')
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
