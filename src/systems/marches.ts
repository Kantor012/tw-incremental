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
  type Stats,
} from '../engine/state'
import { UNIT_IDS, UNITS, type UnitId } from '../content/units'
import { barbarianTarget, MAX_TARGET_LEVEL } from '../content/barbarians'
import { fortressTarget } from '../content/fortresses'
import {
  battleOutcome,
  armyAttackPower,
  armyCarry,
  applyLosses,
  ramDefenseFactor,
  catapultLevelDamage,
  luckFactor,
} from './combat'
import { RNG } from '../engine/rng'
import { barracksUnlocked } from './recruitment'
import { distance, barbarianById, fortressById } from './world'
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
 * Since M5.2 the same mover also carries SCOUT marches (see {@link MarchKind}): a
 * `scout` march travels and returns on the identical clock/geometry but, on arrival,
 * merely flips the target's {@link BarbarianVillage.scouted} flag — it fights nothing,
 * loots nothing, loses no scouts and never touches conquest/loyalty. Dispatch is
 * {@link sendScout} / gate {@link canScout}; resolution lives in the same
 * {@link advanceMarches} loop, branched on `march.kind`.
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
 * produce byte-identical state. The only RNG input is combat LUCK (M5.5): each
 * RESOLVED attack draws one {@link luckFactor} from the per-subStep {@link RNG}
 * the tick threads in (seeded from the persisted `rngState`). Because the draw
 * happens exactly once per resolved attack — never for scouts or still-travelling
 * marches — on that same fixed grid, the count and order of draws is invariant to
 * how `dt` is chopped, so `rngState` (and every outcome) still replays identically.
 */

/** Re-exported so `March` / `MarchKind` can be imported from the system that owns their logic. */
export type { March, MarchKind } from '../engine/state'

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
 * Shared army gate for a dispatch: every per-type count is a non-negative integer that
 * does not exceed the units AT HOME ({@link stationedUnits}), and the army is non-empty.
 * The barracks / target-specific guards are checked by the caller FIRST (so each target
 * kind orders its own reasons), keeping {@link canAttack} (camp) and
 * {@link canAttackFortress} (M7) from duplicating this roster validation.
 */
function homeArmyOk(
  v: Village,
  units: Record<UnitId, number>,
): { ok: boolean; reason?: string } {
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
 * Whether an attack from `v` against the concrete barbarian village `target` can be
 * launched right now, with a PL reason when not. Gates on: the barracks (the
 * military unlock), a valid camp tier (the target's `level` must be in
 * [1, MAX_TARGET_LEVEL]), and the shared roster gate ({@link homeArmyOk}: integer
 * non-negative per-type counts within the units AT HOME, and a non-empty army).
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
  return homeArmyOk(v, units)
}

/**
 * Whether a FORTRESS assault from `v` against `fortress` (M7) can be launched right now,
 * with a PL reason when not. Mirrors {@link canAttack} but for the boss target: gates on
 * the barracks, the fortress NOT being razed (a razed fortress is permanently out of
 * play), and the same shared roster gate ({@link homeArmyOk}). There is deliberately NO
 * camp-tier ceiling — a fortress sits beyond MAX_TARGET_LEVEL — and no scouting/loyalty
 * gate (a fortress is never scouted or conquered).
 */
export function canAttackFortress(
  v: Village,
  fortress: { razed: boolean },
  units: Record<UnitId, number>,
): { ok: boolean; reason?: string } {
  if (!barracksUnlocked(v)) return { ok: false, reason: 'Wymaga koszar (poziom 1).' }
  if (fortress.razed) return { ok: false, reason: 'Forteca już zniszczona.' }
  return homeArmyOk(v, units)
}

/**
 * Whether a SCOUT march from `v` against the barbarian village `targetId` (M5.2) can
 * be launched right now, with a PL reason when not. Pure recon, so the gate is light:
 * the target must EXIST in `world` (a stale/invalid id is rejected) and `scoutCount`
 * must be a positive integer not exceeding the scouts currently AT HOME
 * ({@link stationedUnits}). No barracks check is needed — owning a scout already
 * implies the barracks was built — and there is no level/army-power gate because a
 * scout never fights. `mods` is accepted for signature symmetry with {@link sendScout}
 * (recon validation does not depend on tech), hence the underscore. Pure / Node-safe.
 */
export function canScout(
  v: Village,
  world: World,
  targetId: string,
  scoutCount: number,
  _mods: TechModifiers = NO_TECH_MODS,
): { ok: boolean; reason?: string } {
  const target = barbarianById(world, targetId)
  if (target === undefined) return { ok: false, reason: 'Niepoprawny cel.' }
  if (!Number.isInteger(scoutCount) || scoutCount <= 0) {
    return { ok: false, reason: 'Wskaż liczbę zwiadowców.' }
  }
  const home = stationedUnits(v)
  if (scoutCount > (home.scout ?? 0)) {
    return { ok: false, reason: 'Za mało zwiadowców w domu.' }
  }
  return { ok: true }
}

/**
 * Dispatch an attack from `v` at the target `targetId` (looked up in `world`). The
 * trailing `targetType` (M7) selects the target class: `'camp'` (default — so EVERY
 * existing caller is unchanged) looks up a {@link BarbarianVillage} and gates with
 * {@link canAttack}; `'fortress'` looks up a {@link Fortress} and gates with
 * {@link canAttackFortress} (rejecting a razed/missing fortress). No-op returning false
 * when the target is absent (e.g. a stale id), a fortress is already razed, or the gate
 * rejects. Records the march as a snapshot — the dispatched army, the target's id, the
 * resolved `targetType`, the target tier (`targetLevel`) and its map coordinates
 * (`targetX`/`targetY`) — WITHOUT debiting `v.units`: those units remain owned (and
 * population-counted) while away; {@link stationedUnits} subtracts them so they can't be
 * sent twice. Freezing the type + level + coordinates here means a world regenerated/
 * edited later never perturbs an army already in flight. The global battle `log` is taken
 * explicitly (unused on dispatch; resolution happens in {@link advanceMarches}) to keep
 * the combat-entry-point signatures uniform.
 */
export function sendAttack(
  v: Village,
  world: World,
  _log: BattleReport[],
  targetId: string,
  units: Record<UnitId, number>,
  mods: TechModifiers = NO_TECH_MODS,
  targetType: 'camp' | 'fortress' = 'camp',
): boolean {
  // Resolve the concrete target to its common geometry/tier and apply the kind-specific
  // gate. A missing camp, or a missing/razed fortress, is a silent no-op (no march).
  let target: { id: string; level: number; x: number; y: number }
  if (targetType === 'fortress') {
    const fortress = fortressById(world, targetId)
    if (fortress === undefined || fortress.razed) return false
    if (!canAttackFortress(v, fortress, units).ok) return false
    target = fortress
  } else {
    const barb = barbarianById(world, targetId)
    if (barb === undefined) return false
    if (!canAttack(v, barb, units).ok) return false
    target = barb
  }
  const sent = emptyUnits()
  for (const id of UNIT_IDS) sent[id] = units[id] ?? 0
  v.marches.push({
    kind: 'attack',
    targetType,
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
 * Dispatch a SCOUT march from `v` at the barbarian village `targetId` (M5.2). No-op
 * returning false when the target is absent (stale id) or {@link canScout} rejects.
 * Mirrors {@link sendAttack}'s snapshot discipline — it records the dispatched scouts,
 * the target's id, its camp tier and its map coordinates WITHOUT debiting `v.units`
 * (the scouts stay owned and {@link stationedUnits} subtracts them so they can't be
 * sent twice) — but the march is tagged `kind: 'scout'` and carries an EMPTY loot map:
 * recon never hauls anything. Resolution (reveal + unharmed return) happens in
 * {@link advanceMarches}. The global battle `log` is taken explicitly (unused here —
 * scouting logs nothing) to keep the dispatch signatures uniform. `mods` scales the
 * (symmetric) travel time via {@link marchTime}, exactly like an attack.
 */
export function sendScout(
  v: Village,
  world: World,
  _log: BattleReport[],
  targetId: string,
  scoutCount: number,
  mods: TechModifiers = NO_TECH_MODS,
): boolean {
  const target = barbarianById(world, targetId)
  if (target === undefined) return false
  if (!canScout(v, world, targetId, scoutCount, mods).ok) return false
  const sent = emptyUnits()
  sent.scout = scoutCount
  v.marches.push({
    kind: 'scout',
    // Scouting is camp-only (M7): a fortress is never scouted (no fog — always revealed).
    targetType: 'camp',
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
 * Loot actually hauled: min(effective carry, total target loot), split proportionally,
 * floored. Takes the TARGET's total loot map directly — `barbarianTarget(level).loot` for
 * a camp or `fortressTarget(level).loot` for a fortress (M7) — so the SAME carry-cap
 * maths serves both classes. The army's raw carry capacity is scaled by `mods.lootMult`
 * (M3.2 tech "plunder" multiplier, >= 1; {@link NO_TECH_MODS} = 1 = no bonus), so plunder
 * perks let the SAME survivors haul more — still capped by what the target actually holds
 * (totalTarget), so it never invents resources. Deterministic.
 */
function computeLoot(
  survivors: Record<UnitId, number>,
  targetLoot: ResourceMap,
  mods: TechModifiers,
): ResourceMap {
  const carry = D(armyCarry(survivors)).mul(mods.lootMult)
  const totalTarget = targetLoot.wood.add(targetLoot.clay).add(targetLoot.iron)
  if (carry.lte(0) || totalTarget.lte(0)) return emptyLoot()
  const haul: Decimal = carry.lt(totalTarget) ? carry : totalTarget
  const loot = {} as ResourceMap
  for (const id of RESOURCE_IDS) {
    loot[id] = haul.mul(targetLoot[id]).div(totalTarget).floor()
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
 *    power — scaled by the M5.5 LUCK roll, see below — vs the camp's EFFECTIVE
 *    defence, its base defence scaled down by any rams in the dispatched stack,
 *    {@link ramDefenseFactor}, so a ram column can crack a camp a same-size ramless
 *    army could not). Casualties leave `v.units` immediately.
 *    On a win, catapults in the dispatched stack ({@link catapultLevelDamage} > 0)
 *    PERMANENTLY raze the live target's tier (`barb.level`, clamped >= 1), shrinking
 *    its future defence and loot; the snapshot `m.targetLevel` is left untouched so
 *    THIS battle's loot/losses still resolve from the tier captured at dispatch. On a
 *    win with survivors: erode the target's loyalty by nobleCount(survivors) ×
 *    {@link LOYALTY_NOBLE_HIT} (queuing a {@link ConquestEvent} if it hits 0), stash
 *    carry-capped loot, flip to `returning` with a symmetric travel time, and log
 *    the result now (loot lands on return). On a win with no survivors (attrition
 *    floored the army to 0) or a loss: log and drop the march (nothing returns).
 *  - returning completes → deliver the loot (clamped) and drop the march. Survivors
 *    were never removed from `v.units`, so there is nothing to add back.
 *
 * SCOUT marches (M5.2, `kind === 'scout'`) share the loop but resolve differently:
 * outbound completion sets the LIVE target's {@link BarbarianVillage.scouted} flag
 * true (no battle, no casualties, no loot, no conquest event) and flips to the return
 * leg; returning completion simply drops the march (the scouts, still counted in
 * `v.units`, are home). No battle report is logged for a scout.
 *
 * FORTRESS marches (M7, `targetType === 'fortress'`) resolve through the SAME battle
 * maths as a camp attack — fortressTarget supplies a much higher defence + a much bigger
 * loot cache, rams crack the wall and luck applies identically — but on a WIN they raze
 * the {@link Fortress} PERMANENTLY (`razed = true`, one-time), bump `stats.fortressesRazed`
 * and haul the carry-capped cache home; there is NO catapult tier-razing, NO loyalty/
 * conquest and NO scouting (a fortress is a finite boss, not a grindable/conquerable camp).
 * On a LOSS the army is wiped exactly like a camp loss. A camp attack stays byte-identical.
 *
 * Every report is tagged with `villageId: v.id`. Iterates back-to-front so a
 * completed march can be spliced without disturbing the indices still to process.
 *
 * `stats` (M5.4, OPTIONAL) is the mutable lifetime-counter record. When threaded in
 * (the tick passes `state.stats`), this function bumps it ON THE SAME DETERMINISTIC
 * RESOLUTION PATH it already runs — so the counters grow byte-identically online /
 * offline / sim and never from the UI: `attacksWon` / `attacksLost` on a battle
 * resolving, `campsRazed` when catapults actually knock a target's tier down (>= 1
 * level removed), `lootHauled` (Decimal) by the haul delivered on a successful attack
 * return, and `scoutsReturned` when a scout march completes its return leg. Left
 * undefined by callers that don't track stats (tests, the recon/forecast mirrors),
 * who get the exact pre-M5.4 behaviour.
 *
 * `rng` (M5.5, OPTIONAL) is the per-subStep {@link RNG} the tick seeds from the
 * persisted `rngState` and threads through every village in a FIXED order. When
 * present, each RESOLVED attack draws ONE {@link luckFactor} (a symmetric +/-25%
 * multiplier, mean 1.0) and applies it to the army's attack power BEFORE
 * {@link battleOutcome} — so the same fight can swing on luck — recording the roll
 * on the report (`report.luck`). The draw happens exactly once per resolved attack:
 * NOT for scouts and NOT for marches that don't complete their outbound leg this
 * `dt`, which keeps the number/order of draws invariant to how `dt` is chopped (the
 * key to identical `rngState` online / offline / sim). When `rng` is undefined
 * (tests, the forecast mirrors), no luck is drawn — attack power is taken straight,
 * `report.luck` is omitted, and resolution replays byte-for-byte as it did pre-M5.5.
 */
export function advanceMarches(
  v: Village,
  world: World,
  log: BattleReport[],
  dtSeconds: number,
  mods: TechModifiers = NO_TECH_MODS,
  stats?: Stats,
  rng?: RNG,
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
        // Attacks deliver their carry-capped haul; scouts carry nothing (and their
        // survivors were never removed from v.units), so a scout's return leg just
        // retires the march. Either way the march is done.
        if (m.kind === 'attack') {
          deliverLoot(v, m.loot)
          // M5.4: credit the lifetime haul (on Decimal) with the resources this march
          // actually brought home. Done here, on the deterministic return path, so the
          // lifetime total grows identically online / offline / sim.
          if (stats !== undefined) {
            for (const id of RESOURCE_IDS) stats.lootHauled = stats.lootHauled.add(m.loot[id])
          }
        } else if (stats !== undefined) {
          // A scout completed its round trip and is home (M5.4).
          stats.scoutsReturned += 1
        }
        marches.splice(i, 1)
        break
      }

      // Outbound complete → resolve the arrival.

      // SCOUT (M5.2): pure recon. REVEAL the camp (its defence/loot stop showing as
      // '?' in the UI), then turn straight around. The target may already be gone
      // (captured earlier this sub-step, or a stale/edited id) — then there is simply
      // nothing to reveal — but the scouts ALWAYS head home: no battle, no losses, no
      // loot, no conquest/loyalty. The return leg reuses the snapshotted geometry so
      // the symmetric travel time matches the outbound leg.
      if (m.kind === 'scout') {
        const barb = barbarianById(world, m.targetId)
        if (barb !== undefined) barb.scouted = true
        m.phase = 'returning'
        m.remaining = marchTime(v, { x: m.targetX, y: m.targetY }, m.units, mods)
        // m.loot stays the empty map; loop continues so a large dt may also complete
        // the return leg this step.
        continue
      }

      // ATTACK → resolve the engagement. Pick the target's curves by kind (M7): a camp
      // resolves via barbarianTarget, a FORTRESS (boss) via fortressTarget — both expose
      // the same { defensePower, loot } shape, so the rest of the resolution is shared.
      // Rams (M5.3) crack EITHER wall: the base defence is scaled down by
      // ramDefenseFactor(m.units) (clamped, ramless = ×1) for THIS battle only, so a stack
      // carrying rams can break a tier a same-size ramless army would lose to. Loot/losses
      // still derive from the snapshotted tier.
      const isFortress = m.targetType === 'fortress'
      const target = isFortress
        ? fortressTarget(m.targetLevel)
        : barbarianTarget(m.targetLevel)
      const effDef = target.defensePower * ramDefenseFactor(m.units)
      // LUCK (M5.5): when the tick threads in an RNG, draw exactly ONE symmetric
      // +/-25% multiplier for THIS resolved attack and apply it to the army's power
      // BEFORE battleOutcome (which stays RNG-free). Drawn here — past the scout
      // branch and only on a completed outbound leg — so the draw count/order is
      // invariant to dt chunking. Without an RNG (tests / forecast mirrors) luck is
      // undefined → power is taken straight (×1) and the report omits `luck`,
      // reproducing the pre-M5.5 resolution byte-for-byte.
      const luck = rng !== undefined ? luckFactor(rng) : undefined
      const effAtk = armyAttackPower(m.units, mods) * (luck ?? 1)
      const outcome = battleOutcome(effAtk, effDef)
      const sent = m.units

      if (!outcome.attackerWins) {
        const survivors = applyLosses(sent, 1) // total wipe
        const losses = applyCasualties(v, sent, survivors)
        if (stats !== undefined) stats.attacksLost += 1 // M5.4: lifetime counter
        const lossReport: BattleReport = {
          kind: 'attack',
          villageId: v.id,
          targetLevel: m.targetLevel,
          won: false,
          lootSum: '0',
          losses,
        }
        if (luck !== undefined) lossReport.luck = luck // M5.5: record the roll
        pushBattleReport(log, lossReport)
        marches.splice(i, 1)
        break
      }

      const survivors = applyLosses(sent, outcome.attackerLossFrac)
      const losses = applyCasualties(v, sent, survivors)
      if (stats !== undefined) stats.attacksWon += 1 // M5.4: lifetime counter

      if (isFortress) {
        // FORTRESS WIN (M7): raze the boss PERMANENTLY (one-time — a razed fortress is
        // never attackable again), bump the lifetime trophy counter, and log the victory.
        // No catapult tier-razing, no loyalty/conquest, no scouting — a fortress is a
        // FINITE boss, not a grindable/conquerable camp.
        const fortress = fortressById(world, m.targetId)
        // The one-time cache is gated on the raze TRANSITION: ONLY the army that flips razed
        // false->true hauls it. The send-time gate blocks a fresh assault on an ALREADY-razed
        // fortress, but not several stacks dispatched at the same un-razed fortress before any
        // resolves — so without this, every winning stack would haul a full cache and the prize
        // could be multiplied N-fold. A stack arriving after the boss is already razed (another
        // army cracked it earlier this sub-step) still wins and returns its survivors, but with
        // an EMPTY haul (no cache, no lootHauled credit).
        let cache = emptyLoot()
        if (fortress !== undefined && !fortress.razed) {
          fortress.razed = true
          if (stats !== undefined) stats.fortressesRazed += 1
          cache = computeLoot(survivors, target.loot, mods)
        }
        const fortressReport: BattleReport = {
          kind: 'attack',
          villageId: v.id,
          targetLevel: m.targetLevel,
          won: true,
          lootSum: lootSum(cache),
          losses,
        }
        if (luck !== undefined) fortressReport.luck = luck // M5.5: record the roll
        pushBattleReport(log, fortressReport)
        if (totalUnits(survivors) <= 0) {
          // Won but the whole army attrited to zero — no one carries the cache home.
          marches.splice(i, 1)
          break
        }
        // Symmetric return (see the camp path below): survivors haul the cache home (empty
        // when this stack did not flip the raze, so nothing is double-delivered).
        m.units = survivors
        m.loot = cache
        m.phase = 'returning'
        m.remaining = marchTime(v, { x: m.targetX, y: m.targetY }, sent, mods)
        continue
      }

      // CAMP WIN: the carry-capped haul (computed only on the camp path now — the fortress
      // branch above computes its cache conditionally on the one-time raze).
      const loot = computeLoot(survivors, target.loot, mods)

      // Siege razing (M5.3): on a WON attack, catapults in the DISPATCHED stack
      // permanently lower the live target's camp tier by catapultLevelDamage(m.units),
      // clamped to >= 1 so a camp can never be razed out of existence. This shrinks the
      // camp's FUTURE defence and loot (both derive from barbarianTarget(barb.level)),
      // but deliberately does NOT touch the snapshot m.targetLevel — this battle's own
      // loot/losses already resolved from the tier captured at dispatch. The target may
      // already be gone (captured/edited away earlier this sub-step), in which case
      // there is nothing to raze. Deterministic; uses the same id-snapshot discipline
      // as the loyalty erosion below.
      const razeLevels = catapultLevelDamage(m.units)
      if (razeLevels > 0) {
        const barb = barbarianById(world, m.targetId)
        if (barb !== undefined) {
          const beforeLevel = barb.level
          barb.level = Math.max(1, barb.level - razeLevels)
          // M5.4: count one razing only when the tier ACTUALLY dropped (a camp already
          // at level 1 is clamped, so nothing was removed and it doesn't count).
          if (stats !== undefined && barb.level < beforeLevel) stats.campsRazed += 1
        }
      }

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
      if (luck !== undefined) report.luck = luck // M5.5: record the roll
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
