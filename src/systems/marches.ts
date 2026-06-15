import { D, ZERO, type Decimal } from '../engine/decimal'
import {
  RESOURCE_IDS,
  NO_TECH_MODS,
  type Village,
  type BattleReport,
  type ResourceMap,
  type BarbarianVillage,
  type World,
  type TechModifiers,
} from '../engine/state'
import { UNIT_IDS, UNITS, type UnitId } from '../content/units'
import { barbarianTarget, MAX_TARGET_LEVEL } from '../content/barbarians'
import { battleOutcome, armyAttackPower, armyCarry, applyLosses } from './combat'
import { barracksUnlocked } from './recruitment'
import { distance, barbarianById } from './world'
import { nobleCount, LOYALTY_NOBLE_HIT, type ConquestEvent } from './conquest'

/**
 * March engine — the GENERIC, deterministic mover for PvE attacks (M1.3, spatial
 * since M2.2). Sends an army at a CONCRETE barbarian village on the world map,
 * resolves the battle on arrival, and hauls loot home. Pure functions of a single
 * {@link Village} (+ the {@link World} for target lookup and the catalogues); the
 * only mutating ones are {@link advanceMarches} (the per-tick clock, called by
 * simulate — since M2.4 it also erodes a conquered target's loyalty in the
 * {@link World} and returns the {@link ConquestEvent}s for the tick to apply) and
 * {@link sendAttack} (dispatch). Node-safe (no DOM/clock/RNG).
 *
 * Since M2.2 a march targets a specific {@link BarbarianVillage} by id, and travel
 * time comes from the EUCLIDEAN distance between the source village and the target
 * (see {@link marchTime} / world.ts). Combat & loot are unchanged: both still read
 * the camp tier via barbarianTarget(level); the march snapshots the target's level
 * AND map coordinates at dispatch so a world regenerated/edited later can never
 * retroactively perturb an army already in flight.
 *
 * Since M2.1 the run is multi-village: every function operates on ONE village's
 * economy (its `resources` / `units` / `marches`), never the whole GameState. The
 * battle log is GLOBAL, so the two combat-resolving entry points ({@link sendAttack}
 * and {@link advanceMarches}) take it as an explicit `log: BattleReport[]` argument
 * and tag each report with the originating village id ({@link Village.id}).
 *
 * Convention (see {@link March}): `village.units` = ALL living owned units (home +
 * away). A march's `units` is the away subset, still counted in `village.units`.
 * "At home" is derived as {@link stationedUnits}. Dispatch does NOT touch
 * `village.units`; casualties are subtracted from it at resolution. This keeps the
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
 * Append a battle report to the GLOBAL log, trimming to the most recent
 * {@link BATTLE_LOG_MAX}. Operates on the passed-in list (the global
 * `state.battleLog`, threaded in by the tick) rather than reaching into any state —
 * exported so raids.ts shares the exact same cap/trim behaviour.
 */
export function pushBattleReport(log: BattleReport[], report: BattleReport): void {
  log.push(report)
  if (log.length > BATTLE_LOG_MAX) {
    log.splice(0, log.length - BATTLE_LOG_MAX)
  }
}

/**
 * Units currently AT HOME = the village's owned roster minus everything out on a
 * march. Returns a fresh complete record, clamped non-negative per type (defensive
 * against any hand-edited save where march counts exceed the roster).
 */
export function stationedUnits(v: Village): Record<UnitId, number> {
  const home = emptyUnits()
  for (const id of UNIT_IDS) home[id] = v.units[id] ?? 0
  for (const m of v.marches) {
    for (const id of UNIT_IDS) home[id] -= m.units[id] ?? 0
  }
  for (const id of UNIT_IDS) if (home[id] < 0) home[id] = 0
  return home
}

/**
 * One-way travel time (seconds) for `units` marching from `v` to a map point
 * `target` ({x, y}). Distance is the EUCLIDEAN separation between the two villages
 * (world.ts `distance`), so the same formula serves the outbound leg (target = the
 * barbarian village) and the return leg (target = the dispatch snapshot
 * {x: m.targetX, y: m.targetY}). The SLOWEST unit governs the pace: since
 * `UnitDef.speed` is minutes-per-field (lower = faster), the slowest unit is the one
 * with the MAX speed value. (The brief's "min speed" wording is inverted relative to
 * that data convention — using min would let a fast unit speed up a slow stack, so we
 * take the slowest, the standard TW rule.) Returns 0 for an empty army. There-and-back
 * is symmetric: the return leg reuses the snapshotted target geometry, so survivors
 * never travel home faster than they came.
 *
 * `mods` (M3.2) carry the aggregated tech "logistics" reduction: the base travel time
 * is scaled by `(1 - mods.marchSpeedFrac)` (a fraction in [0, 0.75], already clamped by
 * aggregateTechMods). Defaults to {@link NO_TECH_MODS} (frac 0 → no change), so callers
 * that do not thread tech reproduce the pure-distance time byte-for-byte. Because
 * outbound and return both call this with the SAME `mods`, the legs stay symmetric.
 */
export function marchTime(
  v: Village,
  target: { x: number; y: number },
  units: Record<UnitId, number>,
  mods: TechModifiers = NO_TECH_MODS,
): number {
  let slowest = 0
  for (const id of UNIT_IDS) {
    if ((units[id] ?? 0) > 0) slowest = Math.max(slowest, UNITS[id].speed)
  }
  if (slowest <= 0) return 0
  return (
    distance(v.x, v.y, target.x, target.y) *
    slowest *
    MARCH_TIME_SCALE *
    (1 - mods.marchSpeedFrac)
  )
}

/**
 * Whether an attack from `v` against the concrete barbarian village `target` can be
 * launched right now, with a PL reason when not. Gates on: the barracks (the
 * military unlock), a valid camp tier (the target's `level` must be in
 * [1, MAX_TARGET_LEVEL]), integer non-negative per-type counts that do not exceed
 * the units AT HOME, and a non-empty army.
 */
export function canAttack(
  v: Village,
  target: BarbarianVillage,
  units: Record<UnitId, number>,
): { ok: boolean; reason?: string } {
  if (!barracksUnlocked(v)) return { ok: false, reason: 'Wymaga koszar (poziom 1).' }
  if (
    !Number.isInteger(target.level) ||
    target.level < 1 ||
    target.level > MAX_TARGET_LEVEL
  ) {
    return { ok: false, reason: 'Niepoprawny cel.' }
  }
  const home = stationedUnits(v)
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
 * Dispatch an attack from `v` at the barbarian village `targetId` (looked up in
 * `world`). No-op returning false when the target is absent (e.g. a stale id) or
 * {@link canAttack} rejects. Records the march as a snapshot — the dispatched army,
 * the target's id, its camp tier (`targetLevel`) and its map coordinates
 * (`targetX`/`targetY`) — WITHOUT debiting `v.units`: those units remain owned (and
 * population-counted) while away; {@link stationedUnits} subtracts them so they
 * can't be sent twice. Freezing the level + coordinates here means a world
 * regenerated/edited later never perturbs an army already in flight. The global
 * battle `log` is taken explicitly (unused on dispatch; resolution happens in
 * {@link advanceMarches}) to keep the combat-entry-point signatures uniform.
 */
export function sendAttack(
  v: Village,
  world: World,
  _log: BattleReport[],
  targetId: string,
  units: Record<UnitId, number>,
  mods: TechModifiers = NO_TECH_MODS,
): boolean {
  const target = barbarianById(world, targetId)
  if (target === undefined) return false
  if (!canAttack(v, target, units).ok) return false
  const sent = emptyUnits()
  for (const id of UNIT_IDS) sent[id] = units[id] ?? 0
  v.marches.push({
    targetId: target.id,
    targetLevel: target.level,
    targetX: target.x,
    targetY: target.y,
    units: sent,
    phase: 'outbound',
    remaining: marchTime(v, target, sent, mods),
    loot: emptyLoot(),
  })
  return true
}

/**
 * Loot actually hauled: min(effective carry, total camp loot), split proportionally,
 * floored. The army's raw carry capacity is scaled by `mods.lootMult` (M3.2 tech
 * "plunder" multiplier, >= 1; {@link NO_TECH_MODS} = 1 = no bonus), so plunder perks let
 * the SAME survivors haul more — still capped by what the camp actually holds
 * (totalTarget), so it never invents resources. Deterministic.
 */
function computeLoot(
  survivors: Record<UnitId, number>,
  targetLevel: number,
  mods: TechModifiers,
): ResourceMap {
  const target = barbarianTarget(targetLevel)
  const carry = D(armyCarry(survivors)).mul(mods.lootMult)
  const totalTarget = target.loot.wood.add(target.loot.clay).add(target.loot.iron)
  if (carry.lte(0) || totalTarget.lte(0)) return emptyLoot()
  const haul: Decimal = carry.lt(totalTarget) ? carry : totalTarget
  const loot = {} as ResourceMap
  for (const id of RESOURCE_IDS) {
    loot[id] = haul.mul(target.loot[id]).div(totalTarget).floor()
  }
  return loot
}

/** Add loot to the village's resources, clamped to its storage cap (overflow spilled). */
function deliverLoot(v: Village, loot: ResourceMap): void {
  for (const id of RESOURCE_IDS) {
    let next = v.resources[id].add(loot[id])
    if (next.gt(v.storageCap)) next = v.storageCap
    v.resources[id] = next
  }
}

/** Subtract casualties (before − after, per type) from the village's owned roster. */
function applyCasualties(
  v: Village,
  before: Record<UnitId, number>,
  after: Record<UnitId, number>,
): number {
  let dead = 0
  for (const id of UNIT_IDS) {
    const lost = (before[id] ?? 0) - (after[id] ?? 0)
    if (lost > 0) {
      v.units[id] -= lost
      if (v.units[id] < 0) v.units[id] = 0
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
 * Advance every in-flight march of `v` by `dtSeconds`, mutating `v` (and appending
 * any resolved-battle reports to the GLOBAL `log`). `mods` (M3.2) carry the aggregated
 * tech bonuses applied at RESOLUTION: `mods.attackMult` scales the army's attack power
 * (combat.ts), `mods.lootMult` the haul (computeLoot), and `mods.marchSpeedFrac` the
 * return-leg travel time. They default to {@link NO_TECH_MODS} (all identity) so a sim /
 * caller without tech replays byte-for-byte. Reads `world` to resolve the
 * concrete target and, since M2.4, to erode its loyalty when a noble survives a won
 * attack; returns the {@link ConquestEvent}s (target reached zero loyalty) for the
 * tick to apply AFTER every village has advanced (so a capture mutates the world
 * exactly once, deterministically). Deterministic and Node-safe; returns an empty
 * list when there are no marches. Each march can cross MULTIPLE phase boundaries in
 * a single `dt` (e.g. arrive, resolve, and fully return within one large offline
 * step):
 *
 *  - outbound completes  → resolve the battle (battleOutcome of the army's attack
 *    power vs the camp's defence). Casualties leave `v.units` immediately. On a
 *    win with survivors: erode the target's loyalty by nobleCount(survivors) ×
 *    {@link LOYALTY_NOBLE_HIT} (queuing a {@link ConquestEvent} if it hits 0), stash
 *    carry-capped loot, flip to `returning` with a symmetric travel time, and log
 *    the result now (loot lands on return). On a win with no survivors (attrition
 *    floored the army to 0) or a loss: log and drop the march (nothing returns).
 *  - returning completes → deliver the loot (clamped) and drop the march. Survivors
 *    were never removed from `v.units`, so there is nothing to add back.
 *
 * Every report is tagged with `villageId: v.id`. Iterates back-to-front so a
 * completed march can be spliced without disturbing the indices still to process.
 */
export function advanceMarches(
  v: Village,
  world: World,
  log: BattleReport[],
  dtSeconds: number,
  mods: TechModifiers = NO_TECH_MODS,
): ConquestEvent[] {
  const events: ConquestEvent[] = []
  if (!(dtSeconds > 0)) return events
  const marches = v.marches
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
        deliverLoot(v, m.loot)
        marches.splice(i, 1)
        break
      }

      // Outbound complete → resolve the engagement.
      const target = barbarianTarget(m.targetLevel)
      const outcome = battleOutcome(armyAttackPower(m.units, mods), target.defensePower)
      const sent = m.units

      if (!outcome.attackerWins) {
        const survivors = applyLosses(sent, 1) // total wipe
        const losses = applyCasualties(v, sent, survivors)
        pushBattleReport(log, {
          kind: 'attack',
          villageId: v.id,
          targetLevel: m.targetLevel,
          won: false,
          lootSum: '0',
          losses,
        })
        marches.splice(i, 1)
        break
      }

      const survivors = applyLosses(sent, outcome.attackerLossFrac)
      const losses = applyCasualties(v, sent, survivors)
      const loot = computeLoot(survivors, m.targetLevel, mods)

      // Conquest (M2.4): a won fight whose survivors still include a noble erodes
      // the LIVE target's loyalty in the world. Look it up by the snapshotted id —
      // it may already be gone (captured by an earlier event this sub-step, or a
      // stale id), in which case there is nothing to erode. Loyalty is clamped to 0
      // here; once it bottoms out we queue a ConquestEvent for the tick to apply
      // (capture happens once, after every village's marches have advanced). Done
      // BEFORE logging so the attack report can carry the progress it made (the
      // actual loyalty removed + the value left), making "postęp" visible in the log.
      let loyaltyHit: number | undefined
      let loyaltyAfter: number | undefined
      const nobles = nobleCount(survivors)
      if (nobles > 0) {
        const barb = barbarianById(world, m.targetId)
        if (barb !== undefined) {
          const before = barb.loyalty
          barb.loyalty -= nobles * LOYALTY_NOBLE_HIT
          if (barb.loyalty <= 0) {
            barb.loyalty = 0
            events.push({ barbId: m.targetId, attackerVillageId: v.id })
          }
          // The CLAMPED drop (before − after) and the resulting loyalty, for the report.
          loyaltyHit = before - barb.loyalty
          loyaltyAfter = barb.loyalty
        }
      }

      const report: BattleReport = {
        kind: 'attack',
        villageId: v.id,
        targetLevel: m.targetLevel,
        won: true,
        lootSum: lootSum(loot),
        losses,
      }
      // Attach conquest progress only when a surviving noble actually hit a live target
      // (otherwise the optional fields stay absent — a plain victory card).
      if (loyaltyHit !== undefined) report.loyaltyHit = loyaltyHit
      if (loyaltyAfter !== undefined) report.loyaltyAfter = loyaltyAfter
      pushBattleReport(log, report)

      if (totalUnits(survivors) <= 0) {
        // Won but the whole army attrited to zero — no one carries the loot home.
        marches.splice(i, 1)
        break
      }

      // Symmetric return: travel time from the SNAPSHOTTED target coordinates back
      // to `v` for the originally dispatched stack, so survivors don't teleport home
      // faster than they came (and so a world edited mid-flight can't change it).
      const returnTime = marchTime(v, { x: m.targetX, y: m.targetY }, sent, mods)
      m.units = survivors
      m.loot = loot
      m.phase = 'returning'
      m.remaining = returnTime
      // loop continues: a large dt may also complete the return leg this step.
    }
  }
  return events
}
