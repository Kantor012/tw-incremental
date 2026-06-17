import type { GameState, Village } from '../engine/state'
import { pendingPrestigePoints } from '../systems/prestige'
import { pendingEraPoints } from '../systems/era'

/**
 * PROGRESSIVE DISCLOSURE (M12.2) — which sidebar tabs are VISIBLE right now.
 *
 * A PURE, read-only module: {@link tabVisible} maps a sidebar tab id to a boolean
 * by reading EXISTING {@link GameState} only — this module itself adds NO game state,
 * NO save field and NO migration (it is purely derived). The sidebar (src/ui/layout.ts) calls
 * this every time it reconciles the rail so each tab appears exactly when the player
 * reaches the game stage that makes it relevant — a calmer onboarding and a built-in
 * progression cue.
 *
 * Discipline (matches the milestone's hard constraints):
 *  - DERIVED, never stored. Every predicate is a pure read over `state`; nothing here
 *    mutates, and there is no clock / RNG (no Date.now / Math.random), so visibility is
 *    deterministic and identical online / offline / in the sim.
 *  - NO SOFTLOCK. `buildings` and `save` are ALWAYS visible (the core opening loop and
 *    the backup/restore safety net), so a path to progress can never be hidden. The
 *    caller additionally falls back to `buildings` if the active tab becomes hidden.
 *  - MONOTONIC where it matters. A tab the player still needs does not vanish
 *    mid-action: predicates lean on the LIFETIME {@link GameState.stats} counters, on the
 *    permanent meta accounts (prestige/era/dynasty), and on the empire's summed building
 *    levels — all of which only grow within a run (buildings are never downgraded). A tab
 *    revealed by a run that an era/dynasty RESET wipes (which zeroes the prestige account
 *    and rebuilds a fresh 6-level capital) is kept visible across that reset by ORing a
 *    permanent `era.eras` / `dynasty.dynasties` clause (e.g. `prestige`/`tech`/`codex`) or
 *    a lifetime stat (e.g. `villages` via `stats.villagesFounded`). The ONE intentional
 *    exception is `automation`, which is genuinely RE-LOCKED after an ascension (its
 *    tech-based unlock resets, while a dynasty-granted unlock survives) and is never the
 *    sole progress path.
 *  - FUTURE-PROOF. An unknown id falls through to `true`, so a tab added later can never
 *    silently disappear because someone forgot to extend the table here.
 */

/**
 * Total building levels across the whole empire: Σ over {@link GameState.villageOrder}
 * of Σ of each village's building levels. A fresh capital starts at 6 building levels
 * (the INITIAL_BUILDINGS footprint), so the `>= 9` gates used below fire after ~3
 * upgrades. Pure integer addition — order-independent and reproducible.
 */
export function sumBuildingLevels(s: GameState): number {
  let total = 0
  for (const id of s.villageOrder) {
    const v = s.villages[id]
    if (!v) continue
    for (const lvl of Object.values(v.buildings)) {
      if (typeof lvl === 'number' && Number.isFinite(lvl) && lvl > 0) total += lvl
    }
  }
  return total
}

/** True when the village owns at least one unit (any unit count > 0). */
function hasAnyUnits(v: Village): boolean {
  for (const count of Object.values(v.units)) {
    if (count > 0) return true
  }
  return false
}

/**
 * Tech node ids whose purchase unlocks an idle automation routine (M5.1) — one BINARY
 * gateway per routine. Owning any at level >= 1 flips that routine's automation flag on
 * (see `aggregateTechMods`). Reset to {} on every ascension, which is what makes
 * `automation` the one intentional RE-LOCKING tab.
 */
export const TECH_AUTOMATION_NODE_IDS = ['con_automation', 'tra_automation', 'mil_automation'] as const

/**
 * Dynasty node id whose purchase unlocks ALL THREE idle automations account-wide (M6.2) —
 * the single `automation_unlock` gateway. Lives on the PERMANENT dynasty account, so a
 * dynasty-granted unlock SURVIVES an ascension (unlike the tech gateways above).
 */
export const DYNASTY_AUTOMATION_NODE_IDS = ['sovereignty_automation'] as const

/**
 * Whether ANY idle automation is unlocked, read STRAIGHT from the raw unlock node levels
 * instead of folding all four meta trees via `effectiveMods` — the same boolean
 * (`effectiveMods(s).automations.{build|recruit|attack}` is true iff one of these nodes is
 * owned, since only the tech + dynasty gateways set those flags), at O(constant) with no
 * bag allocation. This keeps progressive disclosure off the heavy per-frame fold (M12.2,
 * perf). RE-LOCKS when the tech gateways reset on ascension; a dynasty unlock persists.
 */
function automationUnlocked(s: GameState): boolean {
  for (const id of TECH_AUTOMATION_NODE_IDS) {
    const lvl = s.tech[id]
    if (typeof lvl === 'number' && lvl >= 1) return true
  }
  const dn = s.dynasty?.nodes
  if (dn) {
    for (const id of DYNASTY_AUTOMATION_NODE_IDS) {
      const lvl = dn[id]
      if (typeof lvl === 'number' && lvl >= 1) return true
    }
  }
  return false
}

/** True when some owned village has building `id` at level >= 1. */
function someVillageHasBuilding(s: GameState, building: string): boolean {
  for (const id of s.villageOrder) {
    const v = s.villages[id]
    if (!v) continue
    const lvl = (v.buildings as Record<string, number>)[building]
    if (typeof lvl === 'number' && lvl >= 1) return true
  }
  return false
}

/** True when some owned village satisfies `pred`. */
function someVillage(s: GameState, pred: (v: Village) => boolean): boolean {
  for (const id of s.villageOrder) {
    const v = s.villages[id]
    if (v && pred(v)) return true
  }
  return false
}

/** True when ANY combat has ever happened from the player's side (won OR lost an attack). */
function hasFought(s: GameState): boolean {
  return s.stats.attacksWon > 0 || s.stats.attacksLost > 0
}

/**
 * Is the sidebar tab `id` visible at the current game stage? Pure read over `state`;
 * see the module doc for the discipline. Unknown ids return `true` (fail-open) so a
 * future tab never disappears by accident.
 */
export function tabVisible(id: string, state: GameState): boolean {
  const s = state
  switch (id) {
    // --- Core loop + safety net: ALWAYS visible (never gameplay-gated, no softlock).
    case 'buildings':
      return true
    case 'save':
      return true

    // --- Osada: expansion + logistics reveal as the economy matures.
    case 'villages':
      // MONOTONIC founding-readiness, NOT a live affordability compare: resources
      // oscillate every tick (production fills them, purchases drain them), so testing
      // them against foundCost popped the tab in and out as the player neared the cost.
      // Instead: a second village already exists, the lifetime founding stat (survives
      // every reset), or a summed building economy big enough that 3000/3000/2000 is
      // realistically accumulable — all of which only ever grow within a run.
      return s.villageOrder.length > 1 || s.stats.villagesFounded > 0 || sumBuildingLevels(s) >= 20
    case 'market':
      return someVillageHasBuilding(s, 'market') || s.stats.resourcesExchanged.gt(0)
    case 'automation':
      // The ONE re-locking tab: gated by the tech/dynasty automation unlock, which the
      // tech side resets on ascension. Read the raw unlock node levels directly — NOT via
      // effectiveMods (which folds all four meta trees + allocates ~6 bags). Never the sole
      // progress path.
      return automationUnlocked(s)

    // --- Wojna: the military layer reveals once the player can fight or has fought.
    case 'army':
      return someVillageHasBuilding(s, 'barracks') || hasFought(s)
    case 'map':
      return (
        s.villageOrder.length > 1 ||
        someVillage(
          s,
          (v) => (v.buildings.barracks ?? 0) >= 1 || hasAnyUnits(v) || v.marches.length > 0,
        ) ||
        s.stats.scoutsReturned > 0 ||
        s.stats.villagesFounded > 0 ||
        hasFought(s)
      )
    case 'raids':
      return someVillage(s, hasAnyUnits) || hasFought(s)
    case 'events':
      // Revealed by the manually-built Wieża strażnicza (the mechanic's gate); the lifetime
      // `eventsResolved` clause keeps it visible across a reset that rebuilds a fresh capital
      // (monotonic — the counter only ever grows), so a player who has claimed an offer never
      // loses the tab.
      return someVillageHasBuilding(s, 'watchtower') || s.stats.eventsResolved > 0
    case 'reports':
      return (
        s.battleLog.length > 0 ||
        s.stats.attacksWon > 0 ||
        s.stats.attacksLost > 0 ||
        s.stats.raidsRepelled > 0 ||
        s.stats.raidsLost > 0 ||
        s.stats.hordesRepelled > 0 ||
        s.stats.hordesBreached > 0
      )

    // --- Postęp: the meta progression ladder, each rung gated by the rung below.
    case 'tech':
      // ... plus era.eras / dynasty.dynasties so an era/dynasty reset (which wipes the
      // prestige account and the economy) never RE-LOCKS the already-unlocked tech tree.
      return (
        s.prestige.ascensions > 0 ||
        s.prestige.totalEarned > 0 ||
        sumBuildingLevels(s) >= 9 ||
        s.era.eras > 0 ||
        s.dynasty.dynasties > 0
      )
    case 'prestige':
      // ... plus era.eras so a Nowa Era (which zeroes the prestige account) never
      // RE-LOCKS the core Prestiż tab right after the player deliberately reset into it.
      return s.prestige.ascensions > 0 || pendingPrestigePoints(s) >= 8 || s.era.eras > 0
    case 'era':
      // Reveal only after REAL prestige depth (cbrt(eraScore) >= 4 → eraScore ≈ 64, i.e.
      // several ascensions / meaningful totalEarned), not one ascension in: era WIPES the
      // whole prestige account, so dangling it too early defeats the staged ladder. Stays
      // visible forever once an era has been performed (era.eras > 0).
      return s.era.eras > 0 || pendingEraPoints(s) >= 4
    case 'dynasty':
      return s.dynasty.dynasties > 0 || s.era.eras >= 1
    case 'challenges':
      return (
        s.challenge.activeId !== null ||
        Object.keys(s.challenge.completed).length > 0 ||
        s.prestige.ascensions >= 1
      )

    // --- Archiwum: lore + career records reveal once there is something to show.
    case 'codex':
      // A lore/career ARCHIVE — reveal once there is genuinely a story: an ascension, a
      // fought battle, or a mature economy (25 building levels, aligned with the first
      // 'foundations' achievement). Tech-early (9 levels) is too soon — nothing to show
      // yet — and it must NOT trail the first combat tab. The era.eras / dynasty.dynasties
      // clauses keep it visible across an era/dynasty reset (monotonic, like `tech`).
      return (
        s.prestige.ascensions > 0 ||
        hasFought(s) ||
        sumBuildingLevels(s) >= 25 ||
        s.era.eras > 0 ||
        s.dynasty.dynasties > 0
      )
    case 'achievements':
      return Object.keys(s.achievements).length > 0

    // Fail-open: an unrecognised (future) tab is always shown rather than hidden.
    default:
      return true
  }
}
