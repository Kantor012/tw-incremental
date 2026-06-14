import { D, ZERO, isFiniteDecimal, type Decimal } from '../src/engine/decimal'
import { serialize, deserialize } from '../src/engine/save'
import { simulate } from '../src/engine/tick'
import { applyOffline } from '../src/engine/offline'
import {
  createInitialState,
  recomputeDerived,
  RESOURCE_IDS,
  INITIAL_BUILDINGS,
  type GameState,
  type Village,
  type World,
  type BarbarianVillage,
} from '../src/engine/state'
import { BUILDINGS, BUILDING_IDS } from '../src/content/buildings'
import { UNITS, UNIT_IDS, type UnitId } from '../src/content/units'
import { MAX_TARGET_LEVEL } from '../src/content/barbarians'
import { freePopulation, recruit } from '../src/systems/recruitment'
import { sendAttack } from '../src/systems/marches'
import { WORLD_SIZE } from '../src/systems/world'
import { chooseAction } from './bot'

/**
 * Hard invariants asserted during and after a run. A single FAIL is a commit
 * blocker (see CLAUDE.md quality gates). Everything here is Node-safe: no DOM,
 * no clock reads, pure functions of the passed state.
 *
 * Since M2.1 the state is multi-village: the per-village checks (resources, army
 * consistency, no-softlock) iterate {@link GameState.villageOrder} and report a
 * single aggregated PASS/FAIL per check (the detail names the offending village),
 * while the GLOBAL battle log and the whole-state serialization checks (round-trip,
 * determinism, offline) stay state-wide. With the single M2.1 village every result
 * is identical to the old single-village harness.
 */
export interface InvariantResult {
  name: string
  ok: boolean
  detail?: string
}

/** The first (capital) village — the one the bot drives. */
function firstVillage(state: GameState): Village {
  return state.villages[state.villageOrder[0]]
}

/**
 * Deterministically pick a barbarian village of camp tier `level` from `world` — the
 * FIRST in generation order (ids are tier-ascending, so this is stable and identical
 * across both branches of a determinism check), falling back to the first village of
 * any tier if that exact level is absent. generateWorld always spawns >= 1 village per
 * tier 1..MAX, so the fallback never fires for an in-range level; it only guards a
 * hand-edited world. Used by the seeded combat tests below to target a CONCRETE camp
 * (M2.2) instead of an abstract level.
 */
function targetOfLevel(world: World, level: number): BarbarianVillage {
  return world.barbarians.find((b) => b.level === level) ?? world.barbarians[0]
}

/**
 * Resource-level sanity checks, aggregated over EVERY village in villageOrder:
 *  - every resource is a finite Decimal (no NaN / Infinity),
 *  - no resource is negative,
 *  - no resource exceeds that village's storage cap.
 * Each offending entry is reported as `<villageId>.<resource>`.
 */
export function runInvariants(state: GameState): InvariantResult[] {
  const nonFinite: string[] = []
  const negative: string[] = []
  const overCap: string[] = []

  for (const vid of state.villageOrder) {
    const v = state.villages[vid]
    for (const r of RESOURCE_IDS) {
      const res = v.resources[r]
      if (!isFiniteDecimal(res)) nonFinite.push(`${vid}.${r}`)
      if (res.lt(0)) negative.push(`${vid}.${r}=${res.toString()}`)
      if (res.gt(v.storageCap)) {
        overCap.push(`${vid}.${r}=${res.toString()} (cap ${v.storageCap.toString()})`)
      }
    }
  }

  return [
    {
      name: 'resources-finite',
      ok: nonFinite.length === 0,
      detail: nonFinite.length ? `non-finite: ${nonFinite.join(', ')}` : undefined,
    },
    {
      name: 'resources-non-negative',
      ok: negative.length === 0,
      detail: negative.length ? `negative: ${negative.join(', ')}` : undefined,
    },
    {
      name: 'resources-within-cap',
      ok: overCap.length === 0,
      detail: overCap.length ? `over cap: ${overCap.join(', ')}` : undefined,
    },
  ]
}

/**
 * Army / combat-state structural invariants (M1.3), checked PER VILLAGE over
 * villageOrder and aggregated. A single FAIL is a commit blocker: it means a battle,
 * march or raid corrupted a village's roster or an in-transit army. Per village:
 *  - every owned unit count is a finite non-negative integer,
 *  - every march is well-formed: integer targetLevel >= 1, finite remaining >= 0,
 *    finite non-negative integer per-type counts,
 *  - NO PHANTOM UNITS: the units committed to that village's marches never exceed its
 *    owned roster (Σ march.units[id] <= village.units[id]) — an army on the road is
 *    always a subset of what the village owns, so units cannot be sent twice or
 *    conjured, and home = owned − away stays non-negative,
 *  - raidTimer is a finite non-negative number.
 *
 * This is the "units do not vanish / appear inconsistently" guard: every count
 * change must flow through recruitment (mint), casualties (battle/raid) — loot is
 * resources, never units — and this snapshot proves the books balance in EVERY
 * village. Each issue is prefixed with the village id.
 */
export function checkArmyConsistency(state: GameState): InvariantResult {
  const issues: string[] = []

  for (const vid of state.villageOrder) {
    const v = state.villages[vid]

    const onMarch = {} as Record<UnitId, number>
    for (const id of UNIT_IDS) onMarch[id] = 0

    for (const id of UNIT_IDS) {
      const n = v.units[id]
      if (!Number.isInteger(n) || n < 0) issues.push(`${vid}.units.${id}=${n}`)
    }

    for (const m of v.marches) {
      if (!Number.isFinite(m.remaining) || m.remaining < 0) {
        issues.push(`${vid}.march.remaining=${m.remaining}`)
      }
      if (!Number.isInteger(m.targetLevel) || m.targetLevel < 1) {
        issues.push(`${vid}.march.targetLevel=${m.targetLevel}`)
      }
      // M2.2: a march carries a target id and SNAPSHOT coordinates (for the return
      // leg + drawn line). They must always be well-formed — a non-finite targetX/Y
      // would yield a NaN return-leg time and strand the army.
      if (typeof m.targetId !== 'string' || m.targetId.length === 0) {
        issues.push(`${vid}.march.targetId=${String(m.targetId)}`)
      }
      if (!Number.isFinite(m.targetX) || !Number.isFinite(m.targetY)) {
        issues.push(`${vid}.march.target=(${m.targetX},${m.targetY})`)
      }
      if (m.phase !== 'outbound' && m.phase !== 'returning') {
        issues.push(`${vid}.march.phase=${m.phase}`)
      }
      for (const id of UNIT_IDS) {
        const c = m.units[id]
        if (!Number.isInteger(c) || c < 0) issues.push(`${vid}.march.units.${id}=${c}`)
        else onMarch[id] += c
      }
    }

    for (const id of UNIT_IDS) {
      if (onMarch[id] > (v.units[id] ?? 0)) {
        issues.push(`${vid} phantom ${id}: on-march ${onMarch[id]} > owned ${v.units[id]}`)
      }
    }

    if (!Number.isFinite(v.raidTimer) || v.raidTimer < 0) {
      issues.push(`${vid}.raidTimer=${v.raidTimer}`)
    }
  }

  return {
    name: 'army-consistency',
    ok: issues.length === 0,
    detail: issues.length ? issues.join('; ') : undefined,
  }
}

/**
 * World structural invariants (M2.2). The seed-generated barbarian map must be sane
 * and serialize-stable, since marches target it by id and read it for travel time:
 *  - `world.barbarians` exists and is NON-EMPTY (there is always something to attack;
 *    an empty world would softlock the combat loop),
 *  - every entry has a non-empty string id, FINITE integer-or-float-but-finite x/y,
 *    and a camp tier in [1, MAX_TARGET_LEVEL] (so barbarianTarget never clamps it),
 *  - NO TWO villages share a map cell, AND no barbarian sits on a player village's
 *    cell — generateWorld reserves the capital and nudges collisions, so a duplicate
 *    would mean a generation/migration bug (and an ambiguous click target on the map).
 *
 * Static for a run (the world never changes after generation), but cheap to assert,
 * so the runner samples it like the other per-state checks; round-trip then proves it
 * survives save/load byte-identically.
 */
export function checkWorldConsistency(state: GameState): InvariantResult {
  const world: World | undefined = state.world
  if (world === undefined || !Array.isArray(world.barbarians)) {
    return {
      name: 'world-consistency',
      ok: false,
      detail: 'state.world missing or world.barbarians is not an array',
    }
  }

  const issues: string[] = []
  if (world.barbarians.length === 0) issues.push('no barbarian villages (combat loop would softlock)')

  const occupied = new Map<string, string>()
  // Reserve every player village's cell first, so a barbarian sharing it is flagged.
  for (const vid of state.villageOrder) {
    const v = state.villages[vid]
    occupied.set(v.x + ',' + v.y, vid)
  }

  for (const b of world.barbarians as BarbarianVillage[]) {
    if (typeof b.id !== 'string' || b.id.length === 0) issues.push(`bad id ${String(b.id)}`)
    if (!Number.isFinite(b.x) || !Number.isFinite(b.y)) {
      issues.push(`${b.id} non-finite coords (${b.x},${b.y})`)
    }
    if (!Number.isInteger(b.level) || b.level < 1 || b.level > MAX_TARGET_LEVEL) {
      issues.push(`${b.id} level=${b.level}`)
    }
    if (typeof b.name !== 'string' || b.name.length === 0) issues.push(`${b.id} empty name`)
    const key = b.x + ',' + b.y
    const prev = occupied.get(key)
    if (prev !== undefined) issues.push(`${b.id} shares cell ${key} with ${prev}`)
    occupied.set(key, b.id)
  }

  return {
    name: 'world-consistency',
    ok: issues.length === 0,
    detail: issues.length ? issues.join('; ') : undefined,
  }
}

/**
 * Player-village placement invariant (M2.3). Founding plants brand-new owned villages
 * on the map, so the empire's own footprint must stay sane exactly as the barbarian map
 * must (see {@link checkWorldConsistency}, which only guards the barbarian side and the
 * barbarian↔player overlap — it does NOT catch two OWNED villages colliding, because it
 * overwrites duplicate keys). Over villageOrder this asserts:
 *  - every village has FINITE INTEGER coordinates inside the map [0, WORLD_SIZE],
 *  - NO TWO owned villages share a map cell (a founded village must take a free tile),
 *  - NO owned village sits on a barbarian's cell (founding must avoid occupied tiles).
 *
 * Together with {@link canFound}'s spacing/range gates this proves the founding engine
 * never produces an ambiguous or overlapping settlement, however many villages a run
 * accumulates. Each offending entry names the village id.
 */
export function checkVillagePlacement(state: GameState): InvariantResult {
  const issues: string[] = []

  const owned = new Map<string, string>()
  for (const vid of state.villageOrder) {
    const v = state.villages[vid]
    if (!Number.isInteger(v.x) || !Number.isInteger(v.y)) {
      issues.push(`${vid} non-integer coords (${v.x},${v.y})`)
      continue
    }
    if (v.x < 0 || v.y < 0 || v.x > WORLD_SIZE || v.y > WORLD_SIZE) {
      issues.push(`${vid} off-map (${v.x},${v.y})`)
    }
    const key = v.x + ',' + v.y
    const prev = owned.get(key)
    if (prev !== undefined) issues.push(`${vid} shares cell ${key} with ${prev}`)
    else owned.set(key, vid)
  }

  for (const b of state.world.barbarians) {
    const hit = owned.get(b.x + ',' + b.y)
    if (hit !== undefined) issues.push(`${hit} shares cell ${b.x},${b.y} with barbarian ${b.id}`)
  }

  return {
    name: 'village-placement',
    ok: issues.length === 0,
    detail: issues.length ? issues.join('; ') : undefined,
  }
}

/** Sum of all resources across EVERY village — the coarse "have I made progress?" measure. */
export function totalResources(state: GameState): Decimal {
  let total = ZERO
  for (const vid of state.villageOrder) {
    const v = state.villages[vid]
    for (const r of RESOURCE_IDS) total = total.add(v.resources[r])
  }
  return total
}

/** Every building of `v` at its data-defined maxLevel — the M1.2 building ceiling. */
export function allBuildingsMaxed(v: Village): boolean {
  return BUILDING_IDS.every((id) => v.buildings[id] >= BUILDINGS[id].maxLevel)
}

/**
 * Whether a village's M1.3 combat loop is live — i.e. there is a perpetual unit SINK
 * that keeps freeing population. Mirrors raids.ts's `raidsActive` (private there): a
 * march is in flight, OR the village owns any unit, OR it has grown past its starting
 * footprint. Once true, incoming raids fire on a timer and attrite the home garrison
 * while marches take casualties, so population is never PERMANENTLY full — the
 * recruit -> attack/lose -> recruit loop always has a next action.
 */
function combatLoopActive(v: Village): boolean {
  if (v.marches.length > 0) return true
  for (const id of UNIT_IDS) if (v.units[id] > 0) return true
  let initSum = 0
  let sum = 0
  for (const id of BUILDING_IDS) {
    initSum += INITIAL_BUILDINGS[id]
    sum += v.buildings[id]
  }
  return sum > initSum
}

/**
 * The M1.2 "content frontier" for a single village: every building maxed AND no
 * population room left to train even the smallest unit. In M1.2 that was a PERMANENT
 * end-of-content stall (farm maxed -> popCap frozen -> recruitment closed forever)
 * and {@link checkNoSoftlock} exempted it as the expected ceiling.
 *
 * M1.3 DISSOLVES that frontier: combat is a perpetual unit sink + loot source.
 * Incoming raids continuously kill home units (freeing population) and marches take
 * casualties, so once {@link combatLoopActive} the bot can always recruit -> attack
 * -> loot -> recruit without bound. We therefore report the frontier as NOT reached
 * whenever the combat loop is live. The narrow M1.2 condition is only ever "true" in
 * the degenerate, combat-free pre-units state — which no real run sits in.
 */
export function villageContentConsumed(v: Village): boolean {
  if (!allBuildingsMaxed(v)) return false
  if (combatLoopActive(v)) return false
  const minPop = Math.min(...UNIT_IDS.map((id) => UNITS[id].pop))
  return freePopulation(v).lt(minPop)
}

/**
 * The whole game has consumed its content only when EVERY village has (each maxed +
 * population permanently full + combat loop dead). With the single M2.1 village this
 * is exactly the capital's {@link villageContentConsumed}. No caps/values are inflated
 * to hide anything; in M1.3 the boundary genuinely no longer exists.
 */
export function contentConsumed(state: GameState): boolean {
  return state.villageOrder.every((id) => villageContentConsumed(state.villages[id]))
}

/**
 * No-softlock: at every sample there must be *some* real progress somewhere in the
 * game. Four signals are accepted, and a stall is flagged only when ALL are absent:
 *
 *  1. `grew`   — total resources (summed across all villages) rose since the previous
 *               sample (idle accrual), OR
 *  2. `acted`  — at least one progress action (build, recruit OR attack) happened in
 *               the window, OR
 *  3. `hasAction` — some action (an affordable non-maxed building, a trainable unit,
 *               or a winnable attack) is available right now in SOME village via
 *               {@link chooseAction}, OR
 *  4. `inFlight` — a training order or a march is still in progress in SOME village:
 *               units are being minted, or an army is travelling and will return with
 *               loot / free population on its casualties. Pending progress, not a stall.
 *
 * Signal 2 is essential once a *spending* bot exists: a buyer converts resources
 * into building levels and units, so the instantaneous resource sum can DROP across a
 * window even though the run is clearly progressing. Signal 4 is essential in M1.3:
 * when the whole home army is out on a march and population is momentarily full, no
 * instantaneous action exists — but the march WILL resolve (loot + freed population),
 * so it is progress in flight, not a stall.
 *
 * Honest-softlock philosophy (CLAUDE.md): when all four signals are absent the run
 * has stalled, which in M1.3 is ALWAYS a hard failure — combat dissolved the M1.2
 * content frontier (see {@link contentConsumed}), so there is no longer an exempt
 * ceiling. The {@link contentConsumed} branch is retained for completeness but only
 * fires in the degenerate combat-free pre-units state no real run sits in.
 *
 * A bare "production > 0" proxy is intentionally NOT used: production stays positive
 * even when every resource is pinned at the cap with nothing to spend it on — the
 * genuine softlock this check must catch.
 */
export function checkNoSoftlock(
  state: GameState,
  prevTotal: Decimal,
  actedInWindow: boolean,
): InvariantResult {
  const grew = totalResources(state).gt(prevTotal)

  let hasAction = false
  let inFlight = false
  for (const vid of state.villageOrder) {
    const v = state.villages[vid]
    if (!hasAction && chooseAction(v, state.world) !== null) hasAction = true
    if (!inFlight && (v.recruitQueue.length > 0 || v.marches.length > 0)) inFlight = true
  }

  if (grew || actedInWindow || hasAction || inFlight) {
    return { name: 'no-softlock', ok: true }
  }
  // Stalled with nothing in flight in any village. In M1.3 combat dissolved the
  // content frontier, so this is a genuine softlock and a commit blocker (the frontier
  // branch only fires in the degenerate combat-free state — see contentConsumed).
  const frontier = contentConsumed(state)
  return {
    name: 'no-softlock',
    ok: frontier,
    detail: frontier
      ? 'content-frontier: degenerate combat-free state (no units, no growth) — not reachable by a real M1.3 run'
      : 'softlock: resources stalled (capped?), nothing acted/buildable/trainable/attackable, and no march or training in flight',
  }
}

/**
 * Put the first village of a fresh state into an identical, NON-EMPTY combat state so
 * EVERY step-size-sensitive clock — recruitment AND marches AND raids — is actually
 * exercised by {@link checkOfflineDeterminism}. Without this both branches keep empty
 * queues, so only the trivially split-invariant linear production path is compared and
 * the guarantee passes VACUOUSLY — a genuine offline/online divergence in any of those
 * subsystems would go uncaught.
 *
 * Seeds three live subsystems on the capital (`villageOrder[0]`):
 *  - a TRAINING queue larger than the window can finish (perUnit ~76s × 100 = 7600s
 *    > 3600s), so an order is still in flight at the end;
 *  - an in-flight MARCH (a home stack is placed, then part of it dispatched), so
 *    advanceMarches crosses outbound -> battle -> returning -> loot-delivery
 *    boundaries within the window — the combat clock the brief requires;
 *  - because units now exist, raids become active too, so advanceRaids fires several
 *    times across the span.
 *
 * All three must replay byte-identically whether the span is taken as one big
 * simulate() or many TICK_RATE chunks. Resources / popCap are set directly (mirroring
 * the unit tests' `armed` helper) to decouple from building prices.
 */
function seedRecruitment(state: GameState): void {
  const v = firstVillage(state)
  v.resources = { wood: D(1e6), clay: D(1e6), iron: D(1e6) }
  v.buildings.barracks = 1
  recomputeDerived(state)
  v.popCap = D(1000) // headroom: queued + trained + away units all count
  // Live training queue (recruitment clock).
  recruit(v, 'spearman', 100)
  // Live march (combat clock): place a home stack, then send part of it at a CONCRETE
  // tier-6 camp on the world map (M2.2) — a clean win whose there-and-back resolves
  // inside the window, so advanceMarches crosses every phase boundary either way.
  v.units.axeman = 60
  const army = {} as Record<UnitId, number>
  for (const id of UNIT_IDS) army[id] = 0
  army.axeman = 40
  sendAttack(v, state.world, state.battleLog, targetOfLevel(state.world, 6).id, army)
}

/**
 * Offline catch-up must equal live stepping for the same elapsed time, so the
 * idle game's core (offline progress) never diverges from online play. We credit
 * a fixed span two ways — one big simulate() step vs the chunked offline path —
 * and require the serialized states to be byte-identical.
 *
 * Both branches start from the SAME non-empty combat state ({@link seedRecruitment}:
 * a live training queue, an in-flight march AND active raids on the capital) so all
 * the step-size-sensitive subsystems a big-step-vs-many-small-steps split could break
 * are genuinely compared, not just the split-invariant linear production. simulate()
 * advancing every village's recruitment, marches and raids on the fixed TICK_RATE grid
 * (see tick.ts) is what makes the big step reproduce the chunked path even with an
 * order and an army in flight.
 */
export function checkOfflineDeterminism(seed: string, seconds: number): InvariantResult {
  const big = createInitialState(seed, 0)
  seedRecruitment(big)
  simulate(big, seconds)
  big.lastSeen = seconds * 1000 // mirror the bookkeeping applyOffline performs

  const chunked = createInitialState(seed, 0)
  seedRecruitment(chunked)
  applyOffline(chunked, seconds * 1000) // lastSeen starts at 0

  const a = serialize(big)
  const b = serialize(chunked)
  const ok = a === b
  return {
    name: 'offline-determinism',
    ok,
    detail: ok
      ? undefined
      : 'chunked offline catch-up diverged from a single-step simulate (recruitment / march / raid timeline)',
  }
}

/**
 * Marches TERMINATE: a dispatched army always resolves and clears out (it is never
 * stuck in flight forever, and `remaining` stays finite >= 0 throughout). Dispatches
 * one over-powered attack from the capital on a fresh state (so the engagement is a
 * clean win) and steps it forward well past a full there-and-back round trip; by the
 * horizon the village's march array MUST be empty (returned with loot, or dropped on a
 * wipe) and no march may ever show a non-finite / negative `remaining`. No bot
 * involved, so the only change to the village's marches is the seeded army draining —
 * nothing is added.
 */
export function checkMarchesTerminate(seed: string): InvariantResult {
  const state = createInitialState(seed, 0)
  const v = firstVillage(state)
  v.resources = { wood: D(1e7), clay: D(1e7), iron: D(1e7) }
  v.buildings.barracks = 1
  recomputeDerived(state)
  v.popCap = D(10000)
  v.units.axeman = 200

  const army = {} as Record<UnitId, number>
  for (const id of UNIT_IDS) army[id] = 0
  army.axeman = 100
  // Target a CONCRETE tier-10 camp on the world map (M2.2). Its ring radius is
  // ~10·DISTANCE_PER_LEVEL (= 30) ± a one-ring jitter, so the Euclidean distance from
  // the central capital is ~27..33 fields — a clean over-powered win that returns well
  // inside the horizon below.
  if (!sendAttack(v, state.world, state.battleLog, targetOfLevel(state.world, 10).id, army)) {
    return { name: 'marches-terminate', ok: false, detail: 'could not dispatch the test march' }
  }

  const CHUNK = 30
  // >> a full round trip: tier-10 distance ~30 fields × speed 18 ≈ 540s each way.
  const HORIZON = 6000
  let bad: string | null = null
  for (let t = 0; t < HORIZON && v.marches.length > 0; t += CHUNK) {
    simulate(state, CHUNK)
    for (const m of v.marches) {
      if (!Number.isFinite(m.remaining) || m.remaining < 0) {
        bad = `remaining=${m.remaining}`
        break
      }
    }
    if (bad) break
  }

  const ok = bad === null && v.marches.length === 0
  return {
    name: 'marches-terminate',
    ok,
    detail: ok ? undefined : (bad ?? `march still in flight after ${HORIZON}s`),
  }
}

/**
 * Round-trip faithfulness: serialize → deserialize → serialize must be byte-for
 * -byte identical, proving the save schema is loss-free and idempotent.
 */
export function checkRoundTrip(state: GameState): InvariantResult {
  const once = serialize(state)
  const twice = serialize(deserialize(once))
  const ok = once === twice
  return {
    name: 'round-trip',
    ok,
    detail: ok ? undefined : 'serialize(deserialize(serialize(s))) !== serialize(s)',
  }
}
