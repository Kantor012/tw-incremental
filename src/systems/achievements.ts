import type { GameState } from '../engine/state'
import { ACHIEVEMENTS, ACHIEVEMENT_IDS } from '../content/achievements'

/**
 * Achievements engine (M5.4) — the generic, data-driven unlock pass over the
 * {@link ACHIEVEMENTS} catalogue. Pure functions over a {@link GameState}; Node-safe
 * (no DOM / clock / RNG), so the sim and tests can drive it headless. Adding or
 * rebalancing an achievement is an edit to src/content/achievements.ts — never to this
 * file (the engine treats every entry uniformly via its pure `condition`).
 *
 * Determinism is the whole point. {@link checkAchievements} is invoked on the
 * DETERMINISTIC tick path (engine/tick.ts), iterates the STABLE {@link ACHIEVEMENT_IDS}
 * order, reads only the (deterministic) game state + its lifetime {@link GameState.stats}
 * counters, and stamps each newly satisfied achievement with a DETERMINISTIC integer
 * marker (NEVER a clock — no Date) — so unlocks happen byte-identically online, offline
 * and in the sim. In v1 an achievement is a pure DISTINCTION (no gameplay bonus), so the
 * unlock pass never feeds back into the economy and the 17 balance goals stay untouched.
 *
 * Import discipline (no cycle): this module value-imports the pure data catalogue from
 * content/achievements.ts (which itself only TYPE-imports state.ts, erased at runtime) and
 * type-imports {@link GameState} from the engine. state.ts never imports this module, so
 * there is no initialisation cycle (mirrors systems/tech.ts ↔ content/tech.ts).
 */

/**
 * Whether `id` is already unlocked, i.e. it carries an unlock marker in
 * {@link GameState.achievements}. A missing key means "still locked". Used by the UI to
 * render the ✓/locked state and by {@link checkAchievements} to skip already-earned ones
 * (an unlock is permanent and is never cleared).
 */
export function achievementUnlocked(state: GameState, id: string): boolean {
  return state.achievements[id] !== undefined
}

/**
 * Evaluate every not-yet-unlocked achievement and unlock the ones whose pure
 * `condition(state, stats)` now holds, MUTATING `state.achievements` in place. Returns
 * the ids unlocked on THIS pass, in {@link ACHIEVEMENT_IDS} order (empty when nothing
 * new fired) — the caller (tick) can use it to surface a toast, the sim/tests to assert.
 *
 * Properties (all relied on for determinism):
 *  - MONOTONIC: an already-unlocked achievement is skipped and never re-stamped or
 *    cleared, so the set of unlocked ids only ever grows.
 *  - STABLE ORDER: iterates {@link ACHIEVEMENT_IDS} (the catalogue's fixed insertion
 *    order), so the unlock order — and the markers below — are reproducible.
 *  - DETERMINISTIC MARKER: each unlock records the 1-based ORDINAL of the unlock
 *    (count already unlocked + 1), i.e. "I was the Nth achievement earned". This is a
 *    pure function of the (deterministic) unlock history — NO Date / clock / RNG — so it
 *    is identical across online / offline / sim replays. The exact value is not relied on
 *    by gameplay (it is just a non-zero "unlocked" stamp); the ordinal is a small, stable
 *    bonus for any future "unlocked in order" UI.
 *
 * `condition` is contractually pure and total (must not throw on any valid state — see
 * content/achievements.ts), so it is called directly with no error trapping.
 */
export function checkAchievements(state: GameState): string[] {
  const newlyUnlocked: string[] = []
  // Seed the ordinal from how many are already unlocked so markers stay monotonic across
  // ticks; bump it per unlock so each gets a distinct 1-based unlock-order stamp.
  let unlockedCount = Object.keys(state.achievements).length

  for (const id of ACHIEVEMENT_IDS) {
    if (state.achievements[id] !== undefined) continue // already earned — never re-mark
    const def = ACHIEVEMENTS[id]
    if (!def) continue // defensive: ACHIEVEMENT_IDS is derived from ACHIEVEMENTS, so unreachable
    if (def.condition(state, state.stats)) {
      unlockedCount += 1
      state.achievements[id] = unlockedCount
      newlyUnlocked.push(id)
    }
  }

  return newlyUnlocked
}
