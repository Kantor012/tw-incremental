import { D, ZERO, type Decimal } from '../engine/decimal'
import {
  RESOURCE_IDS,
  type GameState,
  type BattleReport,
  type ResourceMap,
} from '../engine/state'
import { UNIT_IDS, UNITS, type UnitId } from '../content/units'
import { barbarianTarget, MAX_TARGET_LEVEL } from '../content/barbarians'
import { battleOutcome, armyAttackPower, armyCarry, applyLosses } from './combat'
import { barracksUnlocked } from './recruitment'

/**
 * March engine — the GENERIC, deterministic mover for PvE attacks (M1.3). Sends an
 * army at a barbarian camp, resolves the battle on arrival, and hauls loot home.
 * Pure functions of `GameState` + the catalogues; the only mutating one is
 * {@link advanceMarches} (the per-tick clock, called by simulate) and
 * {@link sendAttack} (dispatch). Node-safe (no DOM/clock/RNG).
 *
 * Convention (see {@link March}): `state.units` = ALL living owned units (home +
 * away). A march's `units` is the away subset, still counted in `state.units`.
 * "At home" is derived as {@link stationedUnits}. Dispatch does NOT touch
 * `state.units`; casualties are subtracted from it at resolution. This keeps the
 * population budget honest (an army on the road still eats) with zero changes to
 * recruitment.ts.
 *
 * Determinism: marches advance on the SAME fixed TICK_RATE grid as recruitment
 * (simulate feeds this function uniform sub-steps), so online / offline / sim
 * produce byte-identical state. Combat is RNG-free until M5.
 */

/** Re-exported so `March` can be imported from the system that owns its logic. */
export type { March } from '../engine/state'

/** Cap on retained battle-log entries (oldest dropped first). Shared with raids. */
const BATTLE_LOG_MAX = 20

/**
 * Time-compression scale for march travel: travel seconds = distance(fields) ×
 * slowest-unit speed(min/field) × this. Kept at 1 (a deliberate 1-min-per-field →
 * 1-second compression for idle pacing); exposed as a named constant so the
 * Balance phase can retune travel duration without touching the formula.
 */
const MARCH_TIME_SCALE = 1

/** A fresh, complete (all UnitId present) zero roster. */
function emptyUnits(): Record<UnitId, number> {
  const r = {} as Record<UnitId, number>
  for (const id of UNIT_IDS) r[id] = 0
  return r
}

/** A fresh zero-loot map (every resource at Decimal 0). */
function emptyLoot(): ResourceMap {
  const loot = {} as ResourceMap
  for (const id of RESOURCE_IDS) loot[id] = D(0)
  return loot
}

/** Total head-count of a roster. */
function totalUnits(units: Record<UnitId, number>): number {
  let total = 0
  for (const id of UNIT_IDS) total += units[id] ?? 0
  return total
}

/**
 * Append a battle report, trimming to the most recent {@link BATTLE_LOG_MAX}.
 * Exported so raids.ts shares the exact same cap/trim behaviour.
 */
export function pushBattleReport(state: GameState, report: BattleReport): void {
  state.battleLog.push(report)
  if (state.battleLog.length > BATTLE_LOG_MAX) {
    state.battleLog.splice(0, state.battleLog.length - BATTLE_LOG_MAX)
  }
}

/**
 * Units currently AT HOME = owned roster minus everything out on a march. Returns
 * a fresh complete record, clamped non-negative per type (defensive against any
 * hand-edited save where march counts exceed the roster).
 */
export function stationedUnits(state: GameState): Record<UnitId, number> {
  const home = emptyUnits()
  for (const id of UNIT_IDS) home[id] = state.units[id] ?? 0
  for (const m of state.marches) {
    for (const id of UNIT_IDS) home[id] -= m.units[id] ?? 0
  }
  for (const id of UNIT_IDS) if (home[id] < 0) home[id] = 0
  return home
}

/**
 * One-way travel time (seconds) for `units` marching to `targetLevel`. The SLOWEST
 * unit governs the pace: since `UnitDef.speed` is minutes-per-field (lower = faster),
 * the slowest unit is the one with the MAX speed value. (The brief's "min speed"
 * wording is inverted relative to that data convention — using min would let a fast
 * unit speed up a slow stack, so we take the slowest, the standard TW rule.) Returns
 * 0 for an empty army. There-and-back is symmetric: the return leg reuses the
 * outbound army's time so survivors never travel home faster than they came.
 */
export function marchTime(
  _state: GameState,
  targetLevel: number,
  units: Record<UnitId, number>,
): number {
  const target = barbarianTarget(targetLevel)
  let slowest = 0
  for (const id of UNIT_IDS) {
    if ((units[id] ?? 0) > 0) slowest = Math.max(slowest, UNITS[id].speed)
  }
  if (slowest <= 0) return 0
  return target.distance * slowest * MARCH_TIME_SCALE
}

/**
 * Whether an attack can be launched right now, with a PL reason when not. Gates on:
 * the barracks (the military unlock), a valid camp level, integer non-negative
 * per-type counts that do not exceed the units AT HOME, and a non-empty army.
 */
export function canAttack(
  state: GameState,
  targetLevel: number,
  units: Record<UnitId, number>,
): { ok: boolean; reason?: string } {
  if (!barracksUnlocked(state)) return { ok: false, reason: 'Wymaga koszar (poziom 1).' }
  if (!Number.isInteger(targetLevel) || targetLevel < 1 || targetLevel > MAX_TARGET_LEVEL) {
    return { ok: false, reason: 'Niepoprawny cel.' }
  }
  const home = stationedUnits(state)
  let total = 0
  for (const id of UNIT_IDS) {
    const n = units[id] ?? 0
    if (!Number.isInteger(n) || n < 0) return { ok: false, reason: 'Niepoprawna armia.' }
    if (n > home[id]) return { ok: false, reason: 'Za mało jednostek w domu.' }
    total += n
  }
  if (total <= 0) return { ok: false, reason: 'Pusta armia.' }
  return { ok: true }
}

/**
 * Dispatch an attack. No-op returning false when {@link canAttack} rejects.
 * Records the march (a snapshot of the dispatched army) WITHOUT debiting
 * `state.units` — those units remain owned (and population-counted) while away;
 * {@link stationedUnits} subtracts them so they can't be sent twice.
 */
export function sendAttack(
  state: GameState,
  targetLevel: number,
  units: Record<UnitId, number>,
): boolean {
  if (!canAttack(state, targetLevel, units).ok) return false
  const sent = emptyUnits()
  for (const id of UNIT_IDS) sent[id] = units[id] ?? 0
  state.marches.push({
    targetLevel,
    units: sent,
    phase: 'outbound',
    remaining: marchTime(state, targetLevel, sent),
    loot: emptyLoot(),
  })
  return true
}

/** Loot actually hauled: min(carry, total camp loot), split proportionally, floored. */
function computeLoot(survivors: Record<UnitId, number>, targetLevel: number): ResourceMap {
  const target = barbarianTarget(targetLevel)
  const carry = D(armyCarry(survivors))
  const totalTarget = target.loot.wood.add(target.loot.clay).add(target.loot.iron)
  if (carry.lte(0) || totalTarget.lte(0)) return emptyLoot()
  const haul: Decimal = carry.lt(totalTarget) ? carry : totalTarget
  const loot = {} as ResourceMap
  for (const id of RESOURCE_IDS) {
    loot[id] = haul.mul(target.loot[id]).div(totalTarget).floor()
  }
  return loot
}

/** Add loot to resources, clamped to the storage cap (overflow is spilled). */
function deliverLoot(state: GameState, loot: ResourceMap): void {
  for (const id of RESOURCE_IDS) {
    let next = state.resources[id].add(loot[id])
    if (next.gt(state.storageCap)) next = state.storageCap
    state.resources[id] = next
  }
}

/** Subtract casualties (before − after, per type) from the owned roster. */
function applyCasualties(
  state: GameState,
  before: Record<UnitId, number>,
  after: Record<UnitId, number>,
): number {
  let dead = 0
  for (const id of UNIT_IDS) {
    const lost = (before[id] ?? 0) - (after[id] ?? 0)
    if (lost > 0) {
      state.units[id] -= lost
      if (state.units[id] < 0) state.units[id] = 0
      dead += lost
    }
  }
  return dead
}

/** Sum a loot map to an exact decimal string (for the battle log). */
function lootSum(loot: ResourceMap): string {
  let sum: Decimal = ZERO
  for (const id of RESOURCE_IDS) sum = sum.add(loot[id])
  return sum.toString()
}

/**
 * Advance every in-flight march by `dtSeconds`, mutating `state`. Deterministic and
 * Node-safe; a no-op when there are no marches. Each march can cross MULTIPLE phase
 * boundaries in a single `dt` (e.g. arrive, resolve, and fully return within one
 * large offline step):
 *
 *  - outbound completes  → resolve the battle (battleOutcome of the army's attack
 *    power vs the camp's defence). Casualties leave `state.units` immediately. On a
 *    win with survivors: stash carry-capped loot, flip to `returning` with a
 *    symmetric travel time, and log the result now (loot lands on return). On a win
 *    with no survivors (attrition floored the army to 0) or a loss: log and drop the
 *    march (nothing returns).
 *  - returning completes → deliver the loot (clamped) and drop the march. Survivors
 *    were never removed from `state.units`, so there is nothing to add back.
 *
 * Iterates back-to-front so a completed march can be spliced without disturbing
 * the indices still to process.
 */
export function advanceMarches(state: GameState, dtSeconds: number): void {
  if (!(dtSeconds > 0)) return
  const marches = state.marches
  for (let i = marches.length - 1; i >= 0; i--) {
    const m = marches[i]
    let dt = dtSeconds
    while (dt > 0) {
      if (m.remaining > dt) {
        m.remaining -= dt
        break
      }
      // Current phase completes; spend its share of the budget and transition.
      dt -= m.remaining
      m.remaining = 0

      if (m.phase === 'returning') {
        deliverLoot(state, m.loot)
        marches.splice(i, 1)
        break
      }

      // Outbound complete → resolve the engagement.
      const target = barbarianTarget(m.targetLevel)
      const outcome = battleOutcome(armyAttackPower(m.units), target.defensePower)
      const sent = m.units

      if (!outcome.attackerWins) {
        const survivors = applyLosses(sent, 1) // total wipe
        const losses = applyCasualties(state, sent, survivors)
        pushBattleReport(state, { kind: 'attack', targetLevel: m.targetLevel, won: false, lootSum: '0', losses })
        marches.splice(i, 1)
        break
      }

      const survivors = applyLosses(sent, outcome.attackerLossFrac)
      const losses = applyCasualties(state, sent, survivors)
      const loot = computeLoot(survivors, m.targetLevel)
      pushBattleReport(state, {
        kind: 'attack',
        targetLevel: m.targetLevel,
        won: true,
        lootSum: lootSum(loot),
        losses,
      })

      if (totalUnits(survivors) <= 0) {
        // Won but the whole army attrited to zero — no one carries the loot home.
        marches.splice(i, 1)
        break
      }

      // Symmetric return: reuse the OUTBOUND army's travel time (computed from the
      // originally dispatched stack) so survivors don't teleport home faster.
      const returnTime = marchTime(state, m.targetLevel, sent)
      m.units = survivors
      m.loot = loot
      m.phase = 'returning'
      m.remaining = returnTime
      // loop continues: a large dt may also complete the return leg this step.
    }
  }
}
