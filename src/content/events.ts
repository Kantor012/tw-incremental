import type { Decimal } from '../engine/decimal'
import { RESOURCE_IDS, type ResourceId } from '../engine/state'

/**
 * World-events catalogue (M13) — PURE DATA (no engine logic lives here).
 *
 * A world event is a time-limited OFFER the player claims for an immediate, BOUNDED windfall of
 * resources. The engine (systems/events.ts) is data-driven: adding or rebalancing an event is an
 * edit to this file, never to the engine. v1 events do EXACTLY one thing — grant resources to the
 * capital — so they touch no world / combat / unit state and can never destabilise the economy.
 *
 * Import discipline: this module imports only the erased TYPE `ResourceId` plus the `Decimal` /
 * `RESOURCE_IDS` values from state.ts. Those values are used ONLY inside function bodies (the
 * grant closures / the windfall helper), never at module top level, so even though state.ts sits
 * upstream this can never trigger an initialisation cycle (mirrors content/buildings.ts).
 */

/**
 * BOUNDED windfall ceiling: the TOTAL granted value (summed across all resources) never exceeds
 * this fraction of the village storage cap, and it scales with the spawn `roll` from
 * {@link WINDFALL_MIN_FRAC} (an unlucky roll) up to here (a lucky roll). Per-resource amounts are
 * additionally clamped to the storage cap by {@link import('../systems/events').claimEvent}. Kept
 * well below 1 so a single windfall is a meaningful boost, never a free warehouse refill.
 */
const WINDFALL_MAX_FRAC = 0.25
/** Floor of the windfall ceiling: even the unluckiest roll grants this fraction of the storage cap. */
const WINDFALL_MIN_FRAC = 0.1

/** Total windfall fraction of the storage cap for a given roll: WINDFALL_MIN_FRAC..WINDFALL_MAX_FRAC. */
function windfallFrac(roll: number): number {
  return WINDFALL_MIN_FRAC + (WINDFALL_MAX_FRAC - WINDFALL_MIN_FRAC) * roll
}

/**
 * Build a BOUNDED resource grant: distribute `windfallFrac(roll) × storageCap` across the three
 * resources by `weights` (which sum to 1), flooring each. Because the weights sum to 1 the TOTAL
 * is `windfallFrac(roll) × storageCap <= WINDFALL_MAX_FRAC × storageCap`, and each per-resource
 * share is <= the total, so nothing ever exceeds the cap (claimEvent clamps again, belt and
 * braces). All amounts are non-negative finite Decimals (storageCap is finite > 0, weights/roll
 * non-negative). Deterministic for a given (roll, storageCap, weights).
 */
function windfall(
  roll: number,
  storageCap: Decimal,
  weights: Record<ResourceId, number>,
): Record<ResourceId, Decimal> {
  const frac = windfallFrac(roll)
  const out = {} as Record<ResourceId, Decimal>
  for (const r of RESOURCE_IDS) {
    out[r] = storageCap.mul(frac * weights[r]).floor()
  }
  return out
}

export interface WorldEventDef {
  /** Stable id — what an {@link import('../engine/state').ActiveEvent}.defId points at. */
  id: string
  /** Display name (PL). */
  name: string
  /** Short flavour description (PL). */
  desc: string
  /** Deterministic selection weight (relative to the other events' weights). > 0. */
  weight: number
  /**
   * PURE, BOUNDED grant: the resources awarded for a spawn `roll` in [0,1) given the claiming
   * village's `storageCap`. The TOTAL value is <= {@link WINDFALL_MAX_FRAC} × storageCap and each
   * per-resource amount <= storageCap. No side effects, no RNG, no clock — deterministic for a
   * given (roll, storageCap).
   */
  grant: (roll: number, storageCap: Decimal) => Record<ResourceId, Decimal>
}

/**
 * The v1 world-events catalogue: three BOUNDED resource windfalls with different resource
 * leanings, for variety. Sizes scale with the spawn roll (10%..25% of the storage cap total).
 * APPENDED-only (stable order) so the deterministic weighted pick stays reproducible across saves.
 */
export const WORLD_EVENTS: readonly WorldEventDef[] = [
  {
    id: 'karawana',
    name: 'Karawana kupiecka',
    desc: 'Wędrowni kupcy oferują zrównoważony ładunek wszystkich trzech surowców.',
    weight: 3,
    // Balanced: an equal third of the windfall in each resource.
    grant: (roll, cap) => windfall(roll, cap, { wood: 1 / 3, clay: 1 / 3, iron: 1 / 3 }),
  },
  {
    id: 'zyla_zelaza',
    name: 'Żyła żelaza',
    desc: 'Odkryto bogatą żyłę rudy — windfall przeważa w żelazie.',
    weight: 2,
    // Iron-leaning: the bulk in iron, a little wood/clay to haul it.
    grant: (roll, cap) => windfall(roll, cap, { wood: 0.15, clay: 0.15, iron: 0.7 }),
  },
  {
    id: 'dary_lasu',
    name: 'Dary lasu',
    desc: 'Obfite zbiory z lasu i gliniska — windfall w drewnie i glinie.',
    weight: 2,
    // Wood + clay leaning: the bulk split between them, a sliver of iron.
    grant: (roll, cap) => windfall(roll, cap, { wood: 0.45, clay: 0.45, iron: 0.1 }),
  },
]

/** Lookup by id (built from {@link WORLD_EVENTS}). Used by claimEvent and the save validator. */
export const WORLD_EVENTS_BY_ID: Record<string, WorldEventDef> = Object.fromEntries(
  WORLD_EVENTS.map((e) => [e.id, e]),
)
