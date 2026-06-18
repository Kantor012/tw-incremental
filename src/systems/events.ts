import { Decimal } from '../engine/decimal'
import { RNG } from '../engine/rng'
import {
  RESOURCE_IDS,
  EVENT_INTERVAL,
  EVENT_TTL,
  NO_TECH_MODS,
  type GameState,
  type TechModifiers,
} from '../engine/state'
import { WORLD_EVENTS, WORLD_EVENTS_BY_ID, type WorldEventDef } from '../content/events'

/**
 * World-events engine (M13 windfalls + M14 timed buffs) — the time-limited OFFERS that liven up
 * the idle loop.
 *
 * Gated by the manually-built WATCHTOWER (the `watchtower` building, autoBuildable:false). The
 * gate is the IDENTITY guarantee: {@link advanceEvents} early-returns when no village has a
 * watchtower, so without one the event timer never moves, the events RNG stream never advances,
 * `active`/`buff` stay null and {@link aggregateEventBuffMods} returns the identity bag — the main
 * run and the combat-luck stream stay BYTE-IDENTICAL to pre-M13/M14. The sim bot / auto-build
 * never build autoBuildable:false buildings, so the main balance run never gates events in (no
 * change needed to bot.ts).
 *
 * Determinism: events draw from their OWN seeded RNG stream ({@link GameState.events}.rngState,
 * seeded from `seed + '::events'`) — NEVER the combat-luck stream (GameState.rngState). The stream
 * is touched ONLY at offer spawn (one weighted pick + one roll), mirroring how resolveHorde draws
 * exactly once per resolution. advanceEvents runs on the fixed TICK_RATE sub-step grid (the tick
 * feeds it uniform sub-steps in a pinned position), so online / offline / sim stay byte-identical;
 * {@link claimEvent} is a PLAYER action (never the tick), like the market exchange. Buffs (M14)
 * need NO RNG — a buff is just a `remaining` countdown on the same tick grid.
 */

/** True when ANY owned village has a watchtower at level >= 1 — the gate for the whole mechanic. */
export function watchtowerBuilt(state: GameState): boolean {
  for (const id of state.villageOrder) {
    if (state.villages[id].buildings.watchtower >= 1) return true
  }
  return false
}

/**
 * A FRESH identity {@link TechModifiers} bag — a DEEP copy of {@link NO_TECH_MODS} (its nested
 * `productionMult` / `automations` cloned so the caller never aliases the shared constant). It is
 * exactly the neutral element of `combine` (multipliers 1, fractions 0, automations all false), so
 * `combine(x, identityBag()) === x` byte-for-byte — the basis of the M14 byte-identity guarantee.
 */
function identityBag(): TechModifiers {
  return {
    productionMult: { ...NO_TECH_MODS.productionMult },
    storageMult: NO_TECH_MODS.storageMult,
    popMult: NO_TECH_MODS.popMult,
    costReduction: NO_TECH_MODS.costReduction,
    recruitSpeedFrac: NO_TECH_MODS.recruitSpeedFrac,
    marchSpeedFrac: NO_TECH_MODS.marchSpeedFrac,
    attackMult: NO_TECH_MODS.attackMult,
    defenseMult: NO_TECH_MODS.defenseMult,
    lootMult: NO_TECH_MODS.lootMult,
    automations: { ...NO_TECH_MODS.automations },
  }
}

/**
 * Roll up the ACTIVE timed buff (M14) into a {@link TechModifiers} bag for {@link effectiveMods}'s
 * combine fold — the SIXTH source, layered after tech × prestige × era × dynasty × challenge.
 *
 * Returns the IDENTITY bag (so `combine(x, …)` is a byte-identical no-op) whenever there is no
 * temporary modifier to apply: no watchtower (the gate), no active buff, or a buff whose `defId`
 * is unknown / is not actually a `kind: 'buff'` def (defensive — a windfall id must never act as a
 * buff). Otherwise it starts from a fresh identity bag and lays the buff def's `mods`
 * (Partial<TechModifiers>) over the matching fields: multipliers (production/storage/pop/attack/
 * defense/loot) and fractions (cost/recruit/march) are SET to the def value (the def is authored
 * as the final factor, e.g. attackMult 1.6), and combine then multiplies/adds it onto the rest.
 *
 * v1 buffs touch ONLY the in-flight axes (attackMult / lootMult / marchSpeedFrac), which the tick
 * reads from the threaded bag at the moment of use — so a buff needs NO recomputeDerived and
 * reverts cleanly the instant {@link advanceEvents} clears it (the tick re-aggregates `mods`, see
 * tick.ts). Pure, no RNG, no clock.
 */
export function aggregateEventBuffMods(state: GameState): TechModifiers {
  const bag = identityBag()
  if (!watchtowerBuilt(state)) return bag // GATE — identity, byte-identical to pre-M14
  const buff = state.events.buff
  if (buff === null) return bag
  const def = WORLD_EVENTS_BY_ID[buff.defId]
  if (!def || def.kind !== 'buff') return bag // defensive: unknown id / non-buff def -> identity
  const mods = def.mods
  // Overlay each PRESENT field of the Partial onto the identity copy. v1 sets only the three
  // in-flight axes below, but the merge stays general so a future buff can touch any field.
  if (mods.productionMult) bag.productionMult = { ...bag.productionMult, ...mods.productionMult }
  if (mods.storageMult !== undefined) bag.storageMult = mods.storageMult
  if (mods.popMult !== undefined) bag.popMult = mods.popMult
  if (mods.costReduction !== undefined) bag.costReduction = mods.costReduction
  if (mods.recruitSpeedFrac !== undefined) bag.recruitSpeedFrac = mods.recruitSpeedFrac
  if (mods.marchSpeedFrac !== undefined) bag.marchSpeedFrac = mods.marchSpeedFrac
  if (mods.attackMult !== undefined) bag.attackMult = mods.attackMult
  if (mods.defenseMult !== undefined) bag.defenseMult = mods.defenseMult
  if (mods.lootMult !== undefined) bag.lootMult = mods.lootMult
  if (mods.automations) bag.automations = { ...bag.automations, ...mods.automations }
  return bag
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
 * Advance the GLOBAL world-events clock by `dt` seconds. RETURNS whether an active timed buff
 * (M14) EXPIRED in this call — the signal the tick uses to re-aggregate the threaded `mods` so the
 * buff's effect reverts byte-identically on the next sub-step (mirrors the challenge-completion
 * signal). The IDENTITY gate comes first: with no watchtower this is a pure no-op (no timer change,
 * no RNG draw, active/buff stay null), returning false, so the main run and combat stream are
 * byte-identical to pre-M13/M14.
 *
 * With a watchtower the BUFF countdown comes FIRST, INDEPENDENTLY of the offer state: the buff
 * burns down whenever the watchtower stands, so an unclaimed offer sitting `active` can NEVER
 * freeze a running buff (the contract: decrement before the active-branch early return). On expiry
 * the buff slot is cleared and `true` returned.
 *
 * Then the offer clock, unchanged from M13: while an offer is `active`, only its TTL counts down
 * (the spawn timer is FROZEN) — on lapse the unclaimed offer is discarded and the spawn timer
 * re-armed. When idle, the spawn timer counts down; on elapse exactly ONE offer is spawned — a
 * weighted pick + a sizing roll, both drawn from the SEPARATE events RNG stream — and the timer
 * re-armed to {@link EVENT_INTERVAL}. Draws from the events stream ONLY here, ONLY at spawn
 * (mirrors resolveHorde drawing once per resolution); never touches the combat stream. Node-safe,
 * no clock.
 */
export function advanceEvents(state: GameState, dt: number): boolean {
  if (!watchtowerBuilt(state)) return false // GATE — byte-identity (no draws, no timer move, no buff)
  const ev = state.events
  // BUFF countdown FIRST and INDEPENDENT of the offer: a buff ticks whenever the watchtower stands,
  // so an active offer (handled below via an early return) can never stall it. On expiry signal a
  // re-aggregation so the buff's in-flight multipliers fall back to the unbuffed bag.
  let buffExpired = false
  if (ev.buff) {
    ev.buff.remaining -= dt
    if (ev.buff.remaining <= 0) {
      ev.buff = null
      buffExpired = true
    }
  }
  if (ev.active) {
    // An offer is on the table: only its TTL ticks (the spawn timer is frozen). On lapse the
    // unclaimed offer is discarded and the spawn clock re-armed a full interval out.
    ev.active.ttl -= dt
    if (ev.active.ttl <= 0) {
      ev.active = null
      ev.timer = EVENT_INTERVAL
    }
    return buffExpired
  }
  ev.timer -= dt
  if (ev.timer > 0) return buffExpired
  // Spawn: draw the weighted def + sizing roll from the SEPARATE events stream, then persist it.
  const rng = new RNG(ev.rngState)
  const def = pickWeighted(WORLD_EVENTS, rng)
  const roll = rng.next()
  ev.rngState = rng.getState()
  ev.active = { defId: def.id, ttl: EVENT_TTL, roll }
  ev.timer = EVENT_INTERVAL
  return buffExpired
}

/**
 * CLAIM the active offer (a PLAYER action — never runs in the tick, like the market exchange).
 * No-op returning false when there is no watchtower, no active offer or an unknown def id.
 * Otherwise it RESOLVES the offer by kind (M14):
 *  - `windfall` (M13): grants the BOUNDED windfall (def.grant(roll, capital.storageCap)) to the
 *    CAPITAL (villageOrder[0], deterministic), each resource CLAMPED to the storage cap (overflow
 *    spilled, mirroring deliverLoot / the market exchange);
 *  - `buff` (M14): installs a single TIMED buff (`events.buff = { defId, remaining: duration }`).
 *    A SINGLE slot — a new buff REPLACES any active one. The buff then folds into effectiveMods via
 *    {@link aggregateEventBuffMods} until {@link advanceEvents} counts it down to expiry.
 * In BOTH cases it bumps {@link import('../engine/state').Stats}.eventsResolved, clears the offer
 * and re-arms the spawn timer, then returns true. Draws no RNG.
 */
export function claimEvent(state: GameState): boolean {
  if (!watchtowerBuilt(state)) return false
  const ev = state.events
  if (!ev.active) return false
  const def = WORLD_EVENTS_BY_ID[ev.active.defId]
  if (!def) return false
  if (def.kind === 'windfall') {
    const v = state.villages[state.villageOrder[0]]
    const grant = def.grant(ev.active.roll, v.storageCap)
    for (const r of RESOURCE_IDS) {
      v.resources[r] = Decimal.min(v.storageCap, v.resources[r].add(grant[r]))
    }
  } else {
    // M14: single buff slot — claiming a new buff overwrites any one still running.
    ev.buff = { defId: def.id, remaining: def.duration }
  }
  state.stats.eventsResolved += 1
  ev.active = null
  ev.timer = EVENT_INTERVAL
  return true
}
