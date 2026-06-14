import { ZERO, isFiniteDecimal, type Decimal } from '../src/engine/decimal'
import { serialize, deserialize } from '../src/engine/save'
import { simulate } from '../src/engine/tick'
import { applyOffline } from '../src/engine/offline'
import { createInitialState, RESOURCE_IDS, type GameState } from '../src/engine/state'
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

/**
 * No-softlock: at every sample there must be *some* available progress — either
 * total resources grew since the previous sample, or the bot has an action to
 * take. A bare "production > 0" proxy is intentionally NOT used: production can
 * be positive while every resource is pinned at the cap (a real softlock), which
 * this delta-based check correctly flags. Required by SKILL.md / CLAUDE.md gates.
 */
export function checkNoSoftlock(state: GameState, prevTotal: Decimal): InvariantResult {
  const grew = totalResources(state).gt(prevTotal)
  const hasAction = chooseAction(state) !== null
  const ok = grew || hasAction
  return {
    name: 'no-softlock',
    ok,
    detail: ok ? undefined : 'no available progress action: resources stalled and bot has no action',
  }
}

/**
 * Offline catch-up must equal live stepping for the same elapsed time, so the
 * idle game's core (offline progress) never diverges from online play. We credit
 * a fixed span two ways — one big simulate() step vs the chunked offline path —
 * and require the serialized states to be byte-identical. This guards against a
 * big-step-vs-many-small-steps split once production becomes nonlinear (M1+).
 */
export function checkOfflineDeterminism(seed: string, seconds: number): InvariantResult {
  const big = createInitialState(seed, 0)
  simulate(big, seconds)
  big.lastSeen = seconds * 1000 // mirror the bookkeeping applyOffline performs

  const chunked = createInitialState(seed, 0)
  applyOffline(chunked, seconds * 1000) // lastSeen starts at 0

  const a = serialize(big)
  const b = serialize(chunked)
  const ok = a === b
  return {
    name: 'offline-determinism',
    ok,
    detail: ok ? undefined : 'chunked offline catch-up diverged from a single-step simulate',
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
