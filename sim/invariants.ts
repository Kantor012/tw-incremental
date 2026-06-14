import { D, ZERO, isFiniteDecimal, type Decimal } from '../src/engine/decimal'
import { serialize, deserialize } from '../src/engine/save'
import { simulate } from '../src/engine/tick'
import { applyOffline } from '../src/engine/offline'
import { createInitialState, recomputeDerived, RESOURCE_IDS, type GameState } from '../src/engine/state'
import { BUILDINGS, BUILDING_IDS } from '../src/content/buildings'
import { UNITS, UNIT_IDS } from '../src/content/units'
import { freePopulation, recruit } from '../src/systems/recruitment'
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
 * The M1.2 "content frontier": the milestone's entire content ceiling is consumed.
 * Two structural conditions, both permanent once reached (no new content exists to
 * lift them this milestone):
 *
 *  1. every building is at maxLevel — no upgrade remains, AND
 *  2. there is no population room to train even the smallest unit — and since the
 *     farm is maxed (condition 1), popCap can never grow again, so recruitment is
 *     permanently closed too.
 *
 * At that point a resource stall is the EXPECTED end-of-content state, not a bug:
 * the next sink (combat / expansion / prestige) arrives in a later milestone.
 * {@link checkNoSoftlock} treats this as a non-fatal "content-frontier" rather than
 * a hard softlock, exactly per the honest-softlock philosophy (CLAUDE.md): we do
 * NOT mask the boundary by inflating caps / per-level values — we report it.
 */
export function contentConsumed(state: GameState): boolean {
  if (!allBuildingsMaxed(state)) return false
  const minPop = Math.min(...UNIT_IDS.map((id) => UNITS[id].pop))
  return freePopulation(state).lt(minPop)
}

/**
 * No-softlock: at every sample there must be *some* real progress. Three signals
 * are accepted, and a stall is flagged only when ALL are absent:
 *
 *  1. `grew`   — total resources rose since the previous sample (idle accrual), OR
 *  2. `acted`  — at least one progress action (build OR recruit) happened in the
 *               window, OR
 *  3. `hasAction` — some action (an affordable non-maxed building, or a trainable
 *               unit) is available right now via {@link chooseAction}.
 *
 * Signal 2 is essential once a *spending* bot exists: a buyer converts resources
 * into building levels and units, so the instantaneous resource sum can DROP
 * across a window even though the run is clearly progressing. Counting the spend as
 * progress prevents it from reading as a softlock.
 *
 * Honest-softlock philosophy (CLAUDE.md): when all three signals are absent the run
 * has stalled — but a stall is a HARD failure ONLY if it happens BEFORE the
 * milestone's content is consumed. Once {@link contentConsumed} holds (every
 * building maxed AND population permanently full), the stall is the EXPECTED M1.2
 * content frontier: `ok` stays true (no commit blocker) and the detail flags it as
 * the content ceiling. The frontier tick is surfaced as a warning by the runner /
 * report — never masked by inflating caps. A stall before the frontier remains a
 * genuine softlock and fails the run.
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
  if (grew || actedInWindow || hasAction) {
    return { name: 'no-softlock', ok: true }
  }
  // Stalled. The expected M1.2 content frontier is NOT a hard failure; a stall
  // before the frontier is a genuine softlock and a commit blocker.
  const frontier = contentConsumed(state)
  return {
    name: 'no-softlock',
    ok: frontier,
    detail: frontier
      ? 'content-frontier: all buildings maxed and population permanently full — expected M1.2 ceiling; next sink lands with combat/expansion'
      : 'softlock: resources stalled (capped?), no action taken this window, and nothing buildable/trainable — BEFORE content consumed',
  }
}

/**
 * Put a fresh state into an identical, NON-EMPTY recruitment state so the
 * step-size-sensitive training clock is actually exercised by
 * {@link checkOfflineDeterminism}. Without this both branches keep an empty queue,
 * so only the trivially split-invariant linear production path is compared and the
 * guarantee passes VACUOUSLY for recruitment — a genuine offline/online recruitment
 * divergence would go uncaught. The batch is larger than the check window can finish
 * (perUnit ~76s × 100 = 7600s > 3600s), so an order is still in flight at the end:
 * its `remaining` and the minted-unit count both probe exactly the split the check
 * claims to guard. Resources / popCap are set directly (mirroring the unit tests'
 * `armed` helper) to decouple from building prices.
 */
function seedRecruitment(state: GameState): void {
  state.resources = { wood: D(1e6), clay: D(1e6), iron: D(1e6) }
  state.buildings.barracks = 1
  recomputeDerived(state)
  state.popCap = D(1000) // headroom: queued units count toward used population
  recruit(state, 'spearman', 100)
}

/**
 * Offline catch-up must equal live stepping for the same elapsed time, so the
 * idle game's core (offline progress) never diverges from online play. We credit
 * a fixed span two ways — one big simulate() step vs the chunked offline path —
 * and require the serialized states to be byte-identical.
 *
 * Both branches start from the SAME non-empty recruitment queue ({@link
 * seedRecruitment}) so the step-size-sensitive subsystem — the only one a
 * big-step-vs-many-small-steps split can break — is genuinely compared, not just
 * the split-invariant linear production. simulate() advancing recruitment on the
 * fixed TICK_RATE grid (see tick.ts) is what makes the big step reproduce the
 * chunked path here even with an order in flight.
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
      : 'chunked offline catch-up diverged from a single-step simulate (recruitment timeline)',
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
