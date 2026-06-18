import type { Decimal } from '../engine/decimal'
import { RESOURCE_IDS, type ResourceId, type TechModifiers } from '../engine/state'

/**
 * World-events catalogue (M13 + M14) — PURE DATA (no engine logic lives here).
 *
 * A world event is a time-limited OFFER the player claims. Two KINDS share the same offer/claim
 * plumbing but resolve differently (discriminated by {@link WorldEventDef.kind}):
 *  - `windfall` (M13) — an immediate, BOUNDED grant of resources to the capital. Touches no
 *    world / combat / unit state and can never destabilise the economy.
 *  - `buff` (M14) — a TIMED global modifier: claiming installs a single {@link import('../engine/state').ActiveBuff}
 *    that, while it lasts, folds a small {@link TechModifiers} bag onto the effective mods via
 *    aggregateEventBuffMods (systems/events.ts). v1 buffs touch ONLY the multipliers READ IN
 *    FLIGHT by the tick (attackMult / lootMult / marchSpeedFrac) — never the cached production/
 *    storage/pop axes — so the buff needs no recomputeDerived, only the existing re-aggregation
 *    signal on expiry.
 *
 * The engine (systems/events.ts) is data-driven: adding or rebalancing an event is an edit to
 * this file, never to the engine.
 *
 * Import discipline: this module imports only the erased TYPES `ResourceId` / `TechModifiers`
 * plus the `Decimal` / `RESOURCE_IDS` values from state.ts. The values are used ONLY inside
 * function bodies (the grant closures / the windfall helper), never at module top level, so even
 * though state.ts sits upstream this can never trigger an initialisation cycle (mirrors
 * content/buildings.ts). `TechModifiers` is erased at runtime, so it adds no edge at all.
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

/** Fields shared by every world-event KIND (M14): the offer's identity + selection weight. */
export interface WorldEventBase {
  /** Stable id — what an {@link import('../engine/state').ActiveEvent}.defId / ActiveBuff.defId points at. */
  id: string
  /** Display name (PL). */
  name: string
  /** Short flavour description (PL). */
  desc: string
  /** Deterministic selection weight (relative to the other events' weights). > 0. */
  weight: number
}

/**
 * A WINDFALL offer (M13): claiming grants a BOUNDED resource cache to the capital, once.
 */
export interface WindfallEvent extends WorldEventBase {
  kind: 'windfall'
  /**
   * PURE, BOUNDED grant: the resources awarded for a spawn `roll` in [0,1) given the claiming
   * village's `storageCap`. The TOTAL value is <= {@link WINDFALL_MAX_FRAC} × storageCap and each
   * per-resource amount <= storageCap. No side effects, no RNG, no clock — deterministic for a
   * given (roll, storageCap).
   */
  grant: (roll: number, storageCap: Decimal) => Record<ResourceId, Decimal>
}

/**
 * A BUFF offer (M14): claiming installs a single TIMED global modifier. While the buff lasts
 * (`duration` seconds, counted down on the tick grid), aggregateEventBuffMods folds {@link mods}
 * onto the effective mods. v1 buffs touch ONLY the in-flight multipliers (attackMult / lootMult /
 * marchSpeedFrac) — never the cached production/storage/pop axes — so no recomputeDerived is
 * needed; the existing threaded-mods re-aggregation on expiry reverts the effect cleanly.
 */
export interface BuffEvent extends WorldEventBase {
  kind: 'buff'
  /** How long the buff lasts, in seconds (counted down on the fixed tick grid). > 0. */
  duration: number
  /**
   * The modifier bag the buff applies WHILE ACTIVE — a Partial of {@link TechModifiers}: only the
   * fields it touches are present, and aggregateEventBuffMods lays them over a copy of NO_TECH_MODS
   * (identity). v1 sets ONLY the in-flight axes (attackMult / lootMult as >= 1 multipliers,
   * marchSpeedFrac as a [0, cap] fraction), so a buff never perturbs a cached derived stat.
   */
  mods: Partial<TechModifiers>
}

/**
 * A world event the player can be offered (M14): a WINDFALL (immediate resource cache) or a BUFF
 * (timed global modifier). Discriminated by `kind`; both share {@link WorldEventBase}. The
 * weighted pick (systems/events.ts) draws across the whole catalogue regardless of kind.
 */
export type WorldEventDef = WindfallEvent | BuffEvent

/**
 * The world-events catalogue: three BOUNDED resource windfalls (M13) plus three TIMED buffs
 * (M14). Windfall sizes scale with the spawn roll (10%..25% of the storage cap total). Buffs are
 * SHORT and BOUNDED, touching only the in-flight combat/logistics axes. APPENDED-only (stable
 * order) so the deterministic weighted pick stays reproducible across saves.
 */
export const WORLD_EVENTS: readonly WorldEventDef[] = [
  {
    id: 'karawana',
    kind: 'windfall',
    name: 'Karawana kupiecka',
    desc: 'Wędrowni kupcy oferują zrównoważony ładunek wszystkich trzech surowców.',
    weight: 3,
    // Balanced: an equal third of the windfall in each resource.
    grant: (roll, cap) => windfall(roll, cap, { wood: 1 / 3, clay: 1 / 3, iron: 1 / 3 }),
  },
  {
    id: 'zyla_zelaza',
    kind: 'windfall',
    name: 'Żyła żelaza',
    desc: 'Odkryto bogatą żyłę rudy — windfall przeważa w żelazie.',
    weight: 2,
    // Iron-leaning: the bulk in iron, a little wood/clay to haul it.
    grant: (roll, cap) => windfall(roll, cap, { wood: 0.15, clay: 0.15, iron: 0.7 }),
  },
  {
    id: 'dary_lasu',
    kind: 'windfall',
    name: 'Dary lasu',
    desc: 'Obfite zbiory z lasu i gliniska — windfall w drewnie i glinie.',
    weight: 2,
    // Wood + clay leaning: the bulk split between them, a sliver of iron.
    grant: (roll, cap) => windfall(roll, cap, { wood: 0.45, clay: 0.45, iron: 0.1 }),
  },
  // --- M14 TIMED BUFFS — short, bounded, in-flight axes only ------------------------------------
  {
    id: 'piesn_wojenna',
    kind: 'buff',
    name: 'Pieśń wojenna',
    desc: 'Bardowie podnoszą morale — armie biją mocniej przez krótki czas.',
    weight: 2,
    duration: 300,
    // +60% siły ataku WYŁĄCZNIE w trakcie marszów (czytane w locie przez combat.ts).
    mods: { attackMult: 1.6 },
  },
  {
    id: 'lowcy_lupow',
    kind: 'buff',
    name: 'Łowcy łupów',
    desc: 'Doświadczeni zwiadowcy obładowują wozy — wracające armie przywożą więcej łupu.',
    weight: 2,
    duration: 300,
    // +60% łupu, czytane w locie przez deliverLoot/marches.ts.
    mods: { lootMult: 1.6 },
  },
  {
    id: 'forsowny_marsz',
    kind: 'buff',
    name: 'Forsowny marsz',
    desc: 'Wojska maszerują dzień i noc — krótsze czasy przemarszu.',
    weight: 2,
    duration: 300,
    // -35% czasu marszu (frakcja [0, cap]), czytane w locie przez marches.ts.
    mods: { marchSpeedFrac: 0.35 },
  },
]

/** Lookup by id (built from {@link WORLD_EVENTS}). Used by claimEvent and the save validator. */
export const WORLD_EVENTS_BY_ID: Record<string, WorldEventDef> = Object.fromEntries(
  WORLD_EVENTS.map((e) => [e.id, e]),
)
