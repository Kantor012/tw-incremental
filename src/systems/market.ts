import { D, type Decimal } from '../engine/decimal'
import {
  RESOURCE_IDS,
  type GameState,
  type Village,
  type VillageId,
  type ResourceId,
  type ResourceMap,
} from '../engine/state'
import { distance } from './world'

/**
 * Market engine — the GENERIC, deterministic mover for MERCHANT transports between a
 * player's OWN villages (M9 rynek). Mirrors {@link import('./marches')} in spirit: pure
 * functions over the state, the only mutating ones being {@link sendShipment} (dispatch)
 * and {@link advanceShipments} (the per-tick clock, called by the tick). Node-safe — draws
 * NO rng and reads NO clock.
 *
 * Transport CONSERVES resources: cargo leaves the SOURCE immediately at dispatch (debited
 * from its resource pool and held in transit, occupying its merchant capacity), travels for
 * a time derived from the Euclidean map distance between the two villages, and is delivered
 * to the DESTINATION on arrival — clamped to the destination's storage cap, overflow spilled
 * (mirroring marches' deliverLoot). Nothing is ever created; v1 is TRANSPORT ONLY (no
 * resource-type exchange/conversion).
 *
 * It is a PLAYER-INITIATED action (like sendAttack): it does NOT run automatically in the
 * tick and does NOT fold into effectiveMods, so a run that never transports is BYTE-IDENTICAL
 * to pre-M9 and every existing balance target is untouched. The merchant_capacity building
 * effect touches NO production/storage/pop/combat stat, so derived production/storageCap/popCap
 * stay byte-identical when the market is at level 0.
 *
 * Determinism: shipments advance on the SAME fixed TICK_RATE grid as marches/recruitment
 * (the tick feeds {@link advanceShipments} uniform sub-steps), so online / offline / sim
 * produce byte-identical state. See {@link Shipment} for the "cargo in transit / debited at
 * dispatch" convention.
 */

/** Re-exported so `Shipment` can be imported from the system that owns its logic. */
export type { Shipment } from '../engine/state'

/**
 * Time-compression scale for merchant travel: travel seconds = distance(fields) × this.
 * Merchants have a single FIXED pace (no per-unit speed, unlike a march), so one constant
 * suffices. Provisional (the Balance phase retunes transport duration without touching the
 * formula); kept as a named constant mirroring marches' MARCH_TIME_SCALE.
 */
const MARKET_TIME_SCALE = 1

/** A fresh zero-cargo map (every resource at Decimal 0). */
function emptyCargo(): ResourceMap {
  const cargo = {} as ResourceMap
  for (const id of RESOURCE_IDS) cargo[id] = D(0)
  return cargo
}

/**
 * One-way merchant travel time (seconds) from `from` to `to`: the Euclidean map distance
 * scaled by {@link MARKET_TIME_SCALE}. Always >= 0 (distance is non-negative; two villages
 * sharing a cell would give 0, an instant delivery). Mirrors marches' distance() usage.
 */
export function shipmentTime(from: Village, to: Village): number {
  return distance(from.x, from.y, to.x, to.y) * MARKET_TIME_SCALE
}

/**
 * Merchant capacity currently IN USE at `v`: the summed cargo (all three resources) of every
 * shipment dispatched from `v` and still in flight. On Decimal (the economy rule). Zero when
 * the village has no shipments.
 */
export function merchantCapacityInUse(v: Village): Decimal {
  let used = D(0)
  for (const s of v.shipments) {
    for (const r of RESOURCE_IDS) used = used.add(s.cargo[r])
  }
  return used
}

/**
 * Merchant capacity still AVAILABLE at `v` = max(0, merchantCapacity − in-use). Clamped at 0
 * so a hand-edited save where in-flight cargo exceeds the (possibly shrunk) cap never reports
 * negative headroom.
 */
export function availableCapacity(v: Village): Decimal {
  const free = v.merchantCapacity.sub(merchantCapacityInUse(v))
  return free.gt(0) ? free : D(0)
}

/**
 * Whether a transport from `fromId` to `toId` carrying `cargo` can be dispatched right now,
 * with a PL reason when not. Gates (in order):
 *  - the source exists and has a market at level >= 1;
 *  - the destination is a DIFFERENT, existing own village;
 *  - every cargo amount is finite >= 0 and the source actually holds it (cargo[r] <= resources[r]);
 *  - the total cargo is > 0;
 *  - the total cargo fits the source's AVAILABLE merchant capacity.
 * Pure / Node-safe — the panel reads this itself for the disabled cue; the callback (sendShipment)
 * is the commit, not the validation.
 */
export function canTransport(
  state: GameState,
  fromId: VillageId,
  toId: VillageId,
  cargo: Record<ResourceId, number>,
): { ok: boolean; reason?: string } {
  const from = state.villages[fromId]
  if (from === undefined) return { ok: false, reason: 'Niepoprawna wioska źródłowa.' }
  if (!(from.buildings.market >= 1)) {
    return { ok: false, reason: 'Zbuduj Rynek, aby wysyłać kupców.' }
  }
  if (toId === fromId) return { ok: false, reason: 'Wybierz inną wioskę docelową.' }
  const to = state.villages[toId]
  if (to === undefined) return { ok: false, reason: 'Niepoprawna wioska docelowa.' }

  // Per-resource validity + source coverage, accumulating the total as Decimal. An absent
  // amount counts as 0 (you simply did not ask to send that resource).
  let total = D(0)
  for (const r of RESOURCE_IDS) {
    const amt = cargo[r] ?? 0
    if (!Number.isFinite(amt) || amt < 0) {
      return { ok: false, reason: 'Niepoprawna ilość surowców.' }
    }
    const want = D(amt)
    if (want.gt(from.resources[r])) {
      return { ok: false, reason: 'Za mało surowców w wiosce źródłowej.' }
    }
    total = total.add(want)
  }
  if (!total.gt(0)) return { ok: false, reason: 'Wskaż surowce do wysłania.' }
  if (total.gt(availableCapacity(from))) {
    return { ok: false, reason: 'Za mała ładowność kupców.' }
  }
  return { ok: true }
}

/**
 * Dispatch a merchant transport from `fromId` to `toId` carrying `cargo`. No-op returning
 * false when {@link canTransport} rejects; otherwise DEBITS the cargo from the source's
 * resources (Decimal), pushes a {@link Shipment} (cargo copied to Decimal, `remaining` =
 * {@link shipmentTime}) onto the source's `shipments`, and returns true. The resources leave
 * the source immediately and are held in transit (occupying its merchant capacity) until
 * {@link advanceShipments} delivers them on arrival.
 */
export function sendShipment(
  state: GameState,
  fromId: VillageId,
  toId: VillageId,
  cargo: Record<ResourceId, number>,
): boolean {
  if (!canTransport(state, fromId, toId, cargo).ok) return false
  const from = state.villages[fromId]
  const to = state.villages[toId]
  // Build the Decimal cargo copy and debit the source in one pass. canTransport already
  // guaranteed cargo[r] <= resources[r], so the subtraction never drives a pool negative.
  const carried = emptyCargo()
  for (const r of RESOURCE_IDS) {
    const amt = D(cargo[r] ?? 0)
    carried[r] = amt
    from.resources[r] = from.resources[r].sub(amt)
  }
  from.shipments.push({
    fromVillageId: fromId,
    toVillageId: toId,
    cargo: carried,
    remaining: shipmentTime(from, to),
  })
  return true
}

/**
 * Advance every in-flight shipment by `dtSeconds`, mutating `state`. Iterates
 * {@link GameState.villageOrder} deterministically; for each village it decrements every
 * shipment's `remaining` by `dt`. An arrival (`remaining <= 0`) is REMOVED from the source
 * and its cargo COLLECTED into a deferred delivery list (mirroring the conquests pattern in
 * tick.ts), so delivery order is deterministic and a just-arrived cargo is not advanced
 * again this step. After the loop, deliveries are applied IN COLLECTION ORDER (villageOrder,
 * then per-village shipment order): each cargo is added to its destination, clamped to the
 * destination's storage cap (overflow spilled — mirrors deliverLoot). Defensive: a delivery
 * whose destination no longer exists drops its cargo (cannot happen — villages are only ever
 * added, never removed — but transport must never throw or leak resources). Draws NO rng;
 * Node-safe. A no-op when there are no shipments, so the steady state stays cheap.
 */
export function advanceShipments(state: GameState, dtSeconds: number): void {
  if (!(dtSeconds > 0)) return
  const deliveries: { toVillageId: VillageId; cargo: ResourceMap }[] = []
  for (const id of state.villageOrder) {
    const v = state.villages[id]
    const shipments = v.shipments
    if (shipments.length === 0) continue
    const surviving: typeof shipments = []
    for (const s of shipments) {
      s.remaining -= dtSeconds
      if (s.remaining <= 0) {
        // Arrived: pull it off the source and queue its cargo for deferred delivery.
        deliveries.push({ toVillageId: s.toVillageId, cargo: s.cargo })
      } else {
        surviving.push(s)
      }
    }
    v.shipments = surviving
  }
  // Apply deliveries once, in deterministic collection order (mirrors deliverLoot's clamp).
  for (const d of deliveries) {
    const dest = state.villages[d.toVillageId]
    if (dest === undefined) continue
    for (const r of RESOURCE_IDS) {
      let next = dest.resources[r].add(d.cargo[r])
      if (next.gt(dest.storageCap)) next = dest.storageCap
      dest.resources[r] = next
    }
  }
}

/* ─────────────────────────── Rynek: WYMIANA surowców (M9.2) ─────────────────────────── */

/**
 * Exchange-rate floor (level 1 with no per-level bonus would give BASE + PER_LEVEL). The rate
 * is the SPREAD: you receive `input × rate` of the other resource, so a rate < 1 always returns
 * LESS value than you put in.
 */
const EXCHANGE_RATE_BASE = 0.5
/** Per market-level improvement to the exchange rate (a second progression purpose for the Rynek). */
const EXCHANGE_RATE_PER_LEVEL = 0.02
/**
 * Hard ceiling on the exchange rate. STRICTLY < 1 by construction (0.9), which is what guarantees
 * the core invariant below: no attainable market level can ever push the rate to 1, so a round-trip
 * (wood→clay→wood) always nets a strict LOSS and exchange can never mint resources.
 */
const EXCHANGE_RATE_CAP = 0.9

/**
 * Market exchange rate at `marketLevel`: 0 with no market (level < 1, nothing to exchange),
 * otherwise min(CAP, BASE + PER_LEVEL × marketLevel). It improves with the market level (a second
 * progression reason to upgrade the Rynek) but is ALWAYS strictly < 1 — because EXCHANGE_RATE_CAP
 * is 0.9 < 1 and clamps the sum from above at every level. INVARIANT (relied on everywhere): the
 * received value is `input × rate < input`, so a wood→clay→wood round-trip strictly LOSES and the
 * exchange is a convenience / surplus sink, never an arbitrage exploit. Pure / Node-safe — draws no
 * rng and reads no clock.
 */
export function exchangeRate(marketLevel: number): number {
  if (marketLevel < 1) return 0
  return Math.min(EXCHANGE_RATE_CAP, EXCHANGE_RATE_BASE + EXCHANGE_RATE_PER_LEVEL * marketLevel)
}

/**
 * Whether `amount` of `fromRes` can be exchanged into `toRes` AT village `villageId` right now,
 * with a PL reason when not. Gates (in order):
 *  - the village exists and has a market at level >= 1;
 *  - the two resources DIFFER (you cannot exchange a resource for itself);
 *  - `amount` is finite and > 0;
 *  - the village actually holds it (amount <= resources[fromRes]).
 * Pure / Node-safe — the panel reads this itself for the disabled cue; {@link exchangeResources}
 * is the commit, not the validation. Mirrors {@link canTransport} in spirit.
 */
export function canExchange(
  state: GameState,
  villageId: VillageId,
  fromRes: ResourceId,
  toRes: ResourceId,
  amount: number,
): { ok: boolean; reason?: string } {
  const v = state.villages[villageId]
  if (v === undefined) return { ok: false, reason: 'Niepoprawna wioska.' }
  if (!(v.buildings.market >= 1)) {
    return { ok: false, reason: 'Zbuduj Rynek, aby wymieniać surowce.' }
  }
  if (fromRes === toRes) return { ok: false, reason: 'Wybierz dwa różne surowce.' }
  if (!Number.isFinite(amount) || !(amount > 0)) {
    return { ok: false, reason: 'Niepoprawna ilość surowców.' }
  }
  if (D(amount).gt(v.resources[fromRes])) {
    return { ok: false, reason: 'Za mało surowców w wiosce.' }
  }
  return { ok: true }
}

/**
 * Exchange `amount` of `fromRes` into `toRes` AT village `villageId`, INSTANTLY, at the market.
 * No-op returning false when {@link canExchange} rejects; otherwise DEBITS `amount` of `fromRes`
 * (Decimal) and CREDITS the floored received amount — `floor(amount × exchangeRate(marketLevel))`
 * of `toRes` — CLAMPED to the village storage cap (overflow spilled, mirroring deliverLoot). Bumps
 * {@link import('../engine/state').Stats.resourcesExchanged} by the GROSS input traded away (Decimal,
 * like lootHauled). Returns true.
 *
 * Because the rate is ALWAYS strictly < 1 (see {@link exchangeRate}), the received value is strictly
 * less than the input — exchange can NEVER create net resources. No derived stat is affected (only the
 * resource pools change), so no recompute is needed. Player-initiated like {@link sendShipment}:
 * deterministic, draws no rng and reads no clock.
 */
export function exchangeResources(
  state: GameState,
  villageId: VillageId,
  fromRes: ResourceId,
  toRes: ResourceId,
  amount: number,
): boolean {
  if (!canExchange(state, villageId, fromRes, toRes, amount).ok) return false
  const v = state.villages[villageId]
  // DEBIT the input. canExchange already guaranteed input <= resources[fromRes], so this
  // subtraction never drives the pool negative.
  const input = D(amount)
  v.resources[fromRes] = v.resources[fromRes].sub(input)
  // CREDIT the floored received amount (always < input — rate < 1), clamped to the storage cap
  // with overflow spilled (mirrors deliverLoot / advanceShipments).
  const received = input.mul(exchangeRate(v.buildings.market)).floor()
  let next = v.resources[toRes].add(received)
  if (next.gt(v.storageCap)) next = v.storageCap
  v.resources[toRes] = next
  // Lifetime gross input traded away (Decimal, the economy rule — like lootHauled).
  state.stats.resourcesExchanged = state.stats.resourcesExchanged.add(input)
  return true
}
