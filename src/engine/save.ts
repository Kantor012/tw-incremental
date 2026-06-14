import { Decimal } from './decimal'
import type { GameState } from './state'

/**
 * Save/load engine. Owns the on-disk schema version and all (de)serialization.
 *
 * Design notes:
 * - The economy runs on Decimal, which JSON cannot represent natively. We tag
 *   every Decimal as `{ $d: "<string>" }` on the way out and rebuild it on the
 *   way in, so round-trips are loss-free and idempotent.
 * - This module is the value-level owner of `SAVE_VERSION`. `state.ts` imports
 *   that constant from here. To avoid a runtime import cycle we only ever import
 *   the *type* `GameState` from `state.ts`, never a value.
 * - Everything here must run headless (Node + browser): localStorage access is
 *   always feature-detected and wrapped in try/catch.
 */

/** Current save schema version. Bump together with a migration entry. */
export const SAVE_VERSION = 1

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
  if (!(s.storageCap instanceof Decimal)) throw new Error('save: invalid storageCap')

  const { resources, production } = s
  if (!isObject(resources)) throw new Error('save: missing resources')
  if (!isObject(production)) throw new Error('save: missing production')
  for (const id of REQUIRED_RESOURCES) {
    if (!(resources[id] instanceof Decimal)) throw new Error(`save: invalid resource ${id}`)
    if (!(production[id] instanceof Decimal)) throw new Error(`save: invalid production ${id}`)
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
  return validateState(migrate(raw))
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
