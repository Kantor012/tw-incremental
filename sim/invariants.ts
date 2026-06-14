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
} from '../src/engine/state'
import { BUILDINGS, BUILDING_IDS } from '../src/content/buildings'
import { UNITS, UNIT_IDS, type UnitId } from '../src/content/units'
import { freePopulation, recruit } from '../src/systems/recruitment'
import { sendAttack } from '../src/systems/marches'
import { chooseAction } from './bot'

/**
 * Hard invariants asserted during and after a run. A single FAIL is a commit
 * blocker (see CLAUDE.md quality gates). Everything here is Node-safe: no DOM,
 * no clock reads, pure functions of the passed state.
 */
export interface InvariantResult {
  name: string
  ok: boolean
  detail?: string
}

/**
 * Resource-level sanity checks:
 *  - every resource is a finite Decimal (no NaN / Infinity),
 *  - no resource is negative,
 *  - no resource exceeds the storage cap.
 */
export function runInvariants(state: GameState): InvariantResult[] {
  const nonFinite = RESOURCE_IDS.filter((id) => !isFiniteDecimal(state.resources[id]))
  const negative = RESOURCE_IDS.filter((id) => state.resources[id].lt(0))
  const overCap = RESOURCE_IDS.filter((id) => state.resources[id].gt(state.storageCap))

  return [
    {
      name: 'resources-finite',
      ok: nonFinite.length === 0,
      detail: nonFinite.length ? `non-finite: ${nonFinite.join(', ')}` : undefined,
    },
    {
      name: 'resources-non-negative',
      ok: negative.length === 0,
      detail: negative.length
        ? `negative: ${negative.map((id) => `${id}=${state.resources[id].toString()}`).join(', ')}`
        : undefined,
    },
    {
      name: 'resources-within-cap',
      ok: overCap.length === 0,
      detail: overCap.length
        ? `over cap ${state.storageCap.toString()}: ${overCap
            .map((id) => `${id}=${state.resources[id].toString()}`)
            .join(', ')}`
        : undefined,
    },
  ]
}

/**
 * Army / combat-state structural invariants (M1.3). A single FAIL is a commit
 * blocker: it means a battle, march or raid corrupted the roster or an in-transit
 * army. Checks, over a pure snapshot of `state`:
 *  - every owned unit count is a finite non-negative integer,
 *  - every march is well-formed: integer targetLevel >= 1, finite remaining >= 0,
 *    finite non-negative integer per-type counts,
 *  - NO PHANTOM UNITS: the units committed to marches never exceed the owned roster
 *    (Σ march.units[id] <= state.units[id]) — i.e. an army on the road is always a
 *    subset of what is owned, so units cannot be sent twice or conjured, and home =
 *    owned − away stays non-negative,
 *  - raidTimer is a finite non-negative number.
 *
 * This is the "units do not vanish / appear inconsistently" guard: every count
 * change must flow through recruitment (mint), casualties (battle/raid) — loot is
 * resources, never units — and this snapshot proves the books always balance.
 */
export function checkArmyConsistency(state: GameState): InvariantResult {
  const issues: string[] = []

  const onMarch = {} as Record<UnitId, number>
  for (const id of UNIT_IDS) onMarch[id] = 0

  for (const id of UNIT_IDS) {
    const n = state.units[id]
    if (!Number.isInteger(n) || n < 0) issues.push(`units.${id}=${n}`)
  }

  for (const m of state.marches) {
    if (!Number.isFinite(m.remaining) || m.remaining < 0) issues.push(`march.remaining=${m.remaining}`)
    if (!Number.isInteger(m.targetLevel) || m.targetLevel < 1) issues.push(`march.targetLevel=${m.targetLevel}`)
    if (m.phase !== 'outbound' && m.phase !== 'returning') issues.push(`march.phase=${m.phase}`)
    for (const id of UNIT_IDS) {
      const c = m.units[id]
      if (!Number.isInteger(c) || c < 0) issues.push(`march.units.${id}=${c}`)
      else onMarch[id] += c
    }
  }

  for (const id of UNIT_IDS) {
    if (onMarch[id] > (state.units[id] ?? 0)) {
      issues.push(`phantom ${id}: on-march ${onMarch[id]} > owned ${state.units[id]}`)
    }
  }

  if (!Number.isFinite(state.raidTimer) || state.raidTimer < 0) {
    issues.push(`raidTimer=${state.raidTimer}`)
  }

  return {
    name: 'army-consistency',
    ok: issues.length === 0,
    detail: issues.length ? issues.join('; ') : undefined,
  }
}

/** Sum of all resources — the coarse "have I made progress?" measure. */
export function totalResources(state: GameState): Decimal {
  let total = ZERO
  for (const id of RESOURCE_IDS) total = total.add(state.resources[id])
  return total
}

/** Every building at its data-defined maxLevel — the M1.2 building ceiling. */
export function allBuildingsMaxed(state: GameState): boolean {
  return BUILDING_IDS.every((id) => state.buildings[id] >= BUILDINGS[id].maxLevel)
}

/**
 * Whether the M1.3 combat loop is live — i.e. there is a perpetual unit SINK that
 * keeps freeing population. Mirrors raids.ts's `raidsActive` (private there): a
 * march is in flight, OR the player owns any unit, OR the village has grown past its
 * starting footprint. Once true, incoming raids fire on a timer and attrite the home
 * garrison while marches take casualties, so population is never PERMANENTLY full —
 * the recruit -> attack/lose -> recruit loop always has a next action.
 */
function combatLoopActive(state: GameState): boolean {
  if (state.marches.length > 0) return true
  for (const id of UNIT_IDS) if (state.units[id] > 0) return true
  let initSum = 0
  let sum = 0
  for (const id of BUILDING_IDS) {
    initSum += INITIAL_BUILDINGS[id]
    sum += state.buildings[id]
  }
  return sum > initSum
}

/**
 * The M1.2 "content frontier": every building maxed AND no population room left to
 * train even the smallest unit. In M1.2 that was a PERMANENT end-of-content stall
 * (farm maxed -> popCap frozen -> recruitment closed forever) and {@link
 * checkNoSoftlock} exempted it as the expected ceiling.
 *
 * M1.3 DISSOLVES that frontier: combat is a perpetual unit sink + loot source.
 * Incoming raids continuously kill home units (freeing population) and marches take
 * casualties, so once {@link combatLoopActive} the bot can always recruit -> attack
 * -> loot -> recruit without bound. We therefore report the frontier as NOT reached
 * whenever the combat loop is live (the harness target asserts exactly this). The
 * narrow M1.2 condition is only ever "true" in the degenerate, combat-free pre-units
 * state — which no real run sits in. No caps/values are inflated to hide anything;
 * the boundary genuinely no longer exists.
 */
export function contentConsumed(state: GameState): boolean {
  if (!allBuildingsMaxed(state)) return false
  if (combatLoopActive(state)) return false
  const minPop = Math.min(...UNIT_IDS.map((id) => UNITS[id].pop))
  return freePopulation(state).lt(minPop)
}

/**
 * No-softlock: at every sample there must be *some* real progress. Four signals
 * are accepted, and a stall is flagged only when ALL are absent:
 *
 *  1. `grew`   — total resources rose since the previous sample (idle accrual), OR
 *  2. `acted`  — at least one progress action (build, recruit OR attack) happened in
 *               the window, OR
 *  3. `hasAction` — some action (an affordable non-maxed building, a trainable unit,
 *               or a winnable attack) is available right now via {@link chooseAction},
 *               OR
 *  4. `inFlight` — a training order or a march is still in progress: units are being
 *               minted, or an army is travelling and will return with loot / free
 *               population on its casualties. Pending progress, not a stall.
 *
 * Signal 2 is essential once a *spending* bot exists: a buyer converts resources
 * into building levels and units, so the instantaneous resource sum can DROP
 * across a window even though the run is clearly progressing. Signal 4 is essential
 * in M1.3: when the whole home army is out on a march and population is momentarily
 * full, no instantaneous action exists — but the march WILL resolve (loot + freed
 * population), so it is progress in flight, not a stall.
 *
 * Honest-softlock philosophy (CLAUDE.md): when all four signals are absent the run
 * has stalled, which in M1.3 is ALWAYS a hard failure — combat dissolved the M1.2
 * content frontier (see {@link contentConsumed}), so there is no longer an exempt
 * ceiling. The {@link contentConsumed} branch is retained for completeness but only
 * fires in the degenerate combat-free pre-units state no real run sits in. No
 * caps/values are inflated to mask anything.
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
  const hasAction = chooseAction(state) !== null
  const inFlight = state.recruitQueue.length > 0 || state.marches.length > 0
  if (grew || actedInWindow || hasAction || inFlight) {
    return { name: 'no-softlock', ok: true }
  }
  // Stalled with nothing in flight. In M1.3 combat dissolved the content frontier, so
  // this is a genuine softlock and a commit blocker (the frontier branch only fires
  // in the degenerate combat-free state — see contentConsumed).
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
 * Put a fresh state into an identical, NON-EMPTY combat state so EVERY step-size
 * -sensitive clock — recruitment AND marches AND raids — is actually exercised by
 * {@link checkOfflineDeterminism}. Without this both branches keep empty queues, so
 * only the trivially split-invariant linear production path is compared and the
 * guarantee passes VACUOUSLY — a genuine offline/online divergence in any of those
 * subsystems would go uncaught.
 *
 * Seeds three live subsystems:
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
  state.resources = { wood: D(1e6), clay: D(1e6), iron: D(1e6) }
  state.buildings.barracks = 1
  recomputeDerived(state)
  state.popCap = D(1000) // headroom: queued + trained + away units all count
  // Live training queue (recruitment clock).
  recruit(state, 'spearman', 100)
  // Live march (combat clock): place a home stack, then send part of it.
  state.units.axeman = 60
  const army = {} as Record<UnitId, number>
  for (const id of UNIT_IDS) army[id] = 0
  army.axeman = 40
  sendAttack(state, 6, army)
}

/**
 * Offline catch-up must equal live stepping for the same elapsed time, so the
 * idle game's core (offline progress) never diverges from online play. We credit
 * a fixed span two ways — one big simulate() step vs the chunked offline path —
 * and require the serialized states to be byte-identical.
 *
 * Both branches start from the SAME non-empty combat state ({@link seedRecruitment}:
 * a live training queue, an in-flight march AND active raids) so all the step-size
 * -sensitive subsystems a big-step-vs-many-small-steps split could break are
 * genuinely compared, not just the split-invariant linear production. simulate()
 * advancing recruitment, marches and raids on the fixed TICK_RATE grid (see tick.ts)
 * is what makes the big step reproduce the chunked path even with an order and an
 * army in flight.
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
 * one over-powered attack on a fresh state (so the engagement is a clean win) and
 * steps it forward well past a full there-and-back round trip; by the horizon the
 * march array MUST be empty (returned with loot, or dropped on a wipe) and no march
 * may ever show a non-finite / negative `remaining`. No bot involved, so the only
 * change to `state.marches` is the seeded army draining — nothing is added.
 */
export function checkMarchesTerminate(seed: string): InvariantResult {
  const state = createInitialState(seed, 0)
  state.resources = { wood: D(1e7), clay: D(1e7), iron: D(1e7) }
  state.buildings.barracks = 1
  recomputeDerived(state)
  state.popCap = D(10000)
  state.units.axeman = 200

  const army = {} as Record<UnitId, number>
  for (const id of UNIT_IDS) army[id] = 0
  army.axeman = 100
  if (!sendAttack(state, 10, army)) {
    return { name: 'marches-terminate', ok: false, detail: 'could not dispatch the test march' }
  }

  const CHUNK = 30
  const HORIZON = 6000 // >> round trip (level 10: distance 30 × speed 18 = 540s each way)
  let bad: string | null = null
  for (let t = 0; t < HORIZON && state.marches.length > 0; t += CHUNK) {
    simulate(state, CHUNK)
    for (const m of state.marches) {
      if (!Number.isFinite(m.remaining) || m.remaining < 0) {
        bad = `remaining=${m.remaining}`
        break
      }
    }
    if (bad) break
  }

  const ok = bad === null && state.marches.length === 0
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
