import { Decimal } from '../engine/decimal'
import { RNG } from '../engine/rng'
import { RESOURCE_IDS, EVENT_INTERVAL, EVENT_TTL, type GameState } from '../engine/state'
import { WORLD_EVENTS, WORLD_EVENTS_BY_ID, type WorldEventDef } from '../content/events'

/**
 * World-events engine (M13) — the time-limited windfall OFFERS that liven up the idle loop.
 *
 * Gated by the manually-built WATCHTOWER (the `watchtower` building, autoBuildable:false). The
 * gate is the IDENTITY guarantee: {@link advanceEvents} early-returns when no village has a
 * watchtower, so without one the event timer never moves, the events RNG stream never advances and
 * `active` stays null — the main run and the combat-luck stream stay BYTE-IDENTICAL to pre-M13. The
 * sim bot / auto-build never build autoBuildable:false buildings, so the main balance run never
 * gates events in (no change needed to bot.ts).
 *
 * Determinism: events draw from their OWN seeded RNG stream ({@link GameState.events}.rngState,
 * seeded from `seed + '::events'`) — NEVER the combat-luck stream (GameState.rngState). The stream
 * is touched ONLY at offer spawn (one weighted pick + one roll), mirroring how resolveHorde draws
 * exactly once per resolution. advanceEvents runs on the fixed TICK_RATE sub-step grid (the tick
 * feeds it uniform sub-steps in a pinned position), so online / offline / sim stay byte-identical;
 * {@link claimEvent} is a PLAYER action (never the tick), like the market exchange.
 */

/** True when ANY owned village has a watchtower at level >= 1 — the gate for the whole mechanic. */
export function watchtowerBuilt(state: GameState): boolean {
  for (const id of state.villageOrder) {
    if (state.villages[id].buildings.watchtower >= 1) return true
  }
  return false
}

/**
 * Deterministic weighted pick over the event catalogue: draws ONE float from `rng` and walks the
 * cumulative weights. Pure aside from advancing `rng`. Falls back to the last def for any float
 * rounding at the top of the range (cannot normally happen — weights are all > 0).
 */
function pickWeighted(defs: readonly WorldEventDef[], rng: RNG): WorldEventDef {
  let total = 0
  for (const d of defs) total += d.weight
  let r = rng.next() * total
  for (const d of defs) {
    r -= d.weight
    if (r < 0) return d
  }
  return defs[defs.length - 1]
}

/**
 * Advance the GLOBAL world-events clock by `dt` seconds. The IDENTITY gate comes first: with no
 * watchtower this is a pure no-op (no timer change, no RNG draw, active stays null), so the main
 * run and combat stream are byte-identical to pre-M13.
 *
 * With a watchtower: while an offer is `active`, only its TTL counts down (the spawn timer is
 * FROZEN) — when the TTL lapses the unclaimed offer is discarded and the spawn timer re-armed. When
 * idle, the spawn timer counts down; on elapse exactly ONE offer is spawned — a weighted pick + a
 * sizing roll, both drawn from the SEPARATE events RNG stream — and the timer re-armed to
 * {@link EVENT_INTERVAL}. Draws from the events stream ONLY here, ONLY at spawn (mirrors
 * resolveHorde drawing once per resolution); never touches the combat stream. Node-safe, no clock.
 */
export function advanceEvents(state: GameState, dt: number): void {
  if (!watchtowerBuilt(state)) return // GATE — the byte-identity guarantee (no draws, no timer move)
  const ev = state.events
  if (ev.active) {
    // An offer is on the table: only its TTL ticks (the spawn timer is frozen). On lapse the
    // unclaimed offer is discarded and the spawn clock re-armed a full interval out.
    ev.active.ttl -= dt
    if (ev.active.ttl <= 0) {
      ev.active = null
      ev.timer = EVENT_INTERVAL
    }
    return
  }
  ev.timer -= dt
  if (ev.timer > 0) return
  // Spawn: draw the weighted def + sizing roll from the SEPARATE events stream, then persist it.
  const rng = new RNG(ev.rngState)
  const def = pickWeighted(WORLD_EVENTS, rng)
  const roll = rng.next()
  ev.rngState = rng.getState()
  ev.active = { defId: def.id, ttl: EVENT_TTL, roll }
  ev.timer = EVENT_INTERVAL
}

/**
 * CLAIM the active offer (a PLAYER action — never runs in the tick, like the market exchange).
 * No-op returning false when there is no watchtower, no active offer or an unknown def id;
 * otherwise grants the BOUNDED windfall (def.grant(roll, capital.storageCap)) to the CAPITAL
 * (villageOrder[0], deterministic), each resource CLAMPED to the storage cap (overflow spilled,
 * mirroring deliverLoot / the market exchange), bumps {@link import('../engine/state').Stats}.
 * eventsResolved, clears the offer, re-arms the spawn timer and returns true. Draws no RNG.
 */
export function claimEvent(state: GameState): boolean {
  if (!watchtowerBuilt(state)) return false
  const ev = state.events
  if (!ev.active) return false
  const def = WORLD_EVENTS_BY_ID[ev.active.defId]
  if (!def) return false
  const v = state.villages[state.villageOrder[0]]
  const grant = def.grant(ev.active.roll, v.storageCap)
  for (const r of RESOURCE_IDS) {
    v.resources[r] = Decimal.min(v.storageCap, v.resources[r].add(grant[r]))
  }
  state.stats.eventsResolved += 1
  ev.active = null
  ev.timer = EVENT_INTERVAL
  return true
}
