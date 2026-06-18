import { ZERO, type Decimal } from '../engine/decimal'
import {
  RESOURCE_IDS,
  HORDE_INTERVAL,
  NO_TECH_MODS,
  type GameState,
  type Village,
  type BattleReport,
  type TechModifiers,
  type Stats,
} from '../engine/state'
import { BUILDING_IDS } from '../content/buildings'
import { UNIT_IDS, type UnitId } from '../content/units'
import {
  hordePower as hordePowerCurve,
  HORDE_BREACH_RESOURCE_FRAC,
  HORDE_BREACH_ARMY_FRAC,
} from '../content/hordes'
import { armyDefensePower, luckFactor, WORST_LUCK, BEST_LUCK } from './combat'
import { villageDefenseMult } from './buildings'
import { pushBattleReport } from './marches'
import type { RNG } from '../engine/rng'

/** Horde report variant of {@link BattleReport}, narrowed so `luck` is settable. */
type HordeReport = Extract<BattleReport, { kind: 'horde' }>

/**
 * Horde engine (M7.2) — the TELEGRAPHED, ESCALATING, HIGH-STAKES invasion of the
 * CAPITAL. The active-defence counterpart to the silent raid drip (systems/raids.ts):
 * where a raid is a per-village timer that fires automatically and steals a little, a
 * horde is a SINGLE GLOBAL schedule ({@link GameState.horde}) the player SEES coming —
 * a visible countdown, a known projected strength and a 3-state defence FORECAST — so
 * they can prepare (build the wall, recruit, hold the army home) before it lands. Each
 * horde is harder than the last (the escalation `level` rises by 1 after EVERY horde),
 * a repel is rewarded (a lifetime trophy + achievements) and a breach costs much more
 * than a lost raid (a large fraction of EACH capital resource + a chunk of the standing
 * garrison) — but NEVER destroys a building and never drives a pool/roster negative, so
 * a breach is always recoverable (no softlock).
 *
 * DETERMINISTIC, EXACTLY like {@link advanceRaids}: the only mutating entry point is
 * {@link advanceHorde}, advanced on the SAME fixed tick grid as everything else
 * (simulate feeds it uniform sub-steps). The only randomness is combat LUCK — ONE
 * {@link luckFactor} draw per RESOLVED horde, taken from the per-subStep `rng` the tick
 * seeds from the persisted `rngState`. advanceHorde decomposes a big `dt` with a
 * while-loop (so a long offline catch-up resolves every horde that fell within the
 * window, in order) and draws EXACTLY ONCE per resolved horde, in a FIXED position in
 * the sub-step (the tick calls it once, after the per-village loop), so the number and
 * order of draws is invariant to how `dt` is chopped — the property that keeps online /
 * offline / sim byte-identical with hordes active.
 *
 * Mirrors raids' tech threading: the player's CAPITAL defence is hardened by
 * `mods.defenseMult` (via {@link armyDefensePower}) and the WALL shield
 * ({@link villageDefenseMult}); the incoming horde's strength is left on the
 * NO_TECH_MODS default on purpose (its army term is a progress proxy, not the player's
 * defence — scaling it by defenseMult would cancel the very bonus the player paid for).
 */

/** Sum of all building levels in a village — the structural part of the progress proxy. */
function buildingLevelSum(v: Village): number {
  let sum = 0
  for (const id of BUILDING_IDS) sum += v.buildings[id]
  return sum
}

/** The run's CAPITAL — villageOrder[0]. Always present (validateState guarantees a non-empty order). */
function capitalOf(state: GameState): Village {
  return state.villages[state.villageOrder[0]]
}

/**
 * Strength of the incoming horde at the current escalation level, scaling with the
 * CAPITAL's progress (summed building levels + a sub-weighted share of its army defence)
 * and the horde {@link GameState.horde}.level — the pure {@link hordePowerCurve} curve fed
 * the two plain numbers derived here. The army term uses the full owned roster
 * (`capital.units`) on the NO_TECH_MODS default: a coarse village-progress proxy, not the
 * player's defence (see the module docstring). Pure read — no mutation, no RNG.
 */
export function hordePower(state: GameState): number {
  const capital = capitalOf(state)
  return hordePowerCurve(state.horde.level, buildingLevelSum(capital), armyDefensePower(capital.units))
}

/**
 * The capital's effective defence against a horde: garrison (× tech, × Kuźnia unit upgrades)
 * × the wall shield. `forge` (M15) is OPTIONAL/last — undefined → ×1.0 per unit → byte-identical.
 */
function capitalDefense(
  capital: Village,
  mods: TechModifiers,
  forge?: Partial<Record<UnitId, number>>,
): number {
  return armyDefensePower(capital.units, mods, forge) * villageDefenseMult(capital)
}

/**
 * The three-state defence outlook for the UI (M7.2), mirroring ui/combatForecast but
 * from the DEFENDER's side: combat LUCK multiplies the HORDE's incoming power, so the
 * player's WORST case is the strongest horde (× {@link BEST_LUCK}) and their BEST case the
 * weakest (× {@link WORST_LUCK}). A repel happens when defence >= incoming, so:
 *  - `defended` (pewna obrona)  — holds even against the strongest roll: def >= incoming·BEST_LUCK.
 *  - `risky`    (ryzykowna)     — luck-dependent: holds on some rolls, breaches on others.
 *  - `doomed`   (pewna porażka) — breaches even against the weakest roll: def < incoming·WORST_LUCK.
 * The verdict is carried in WORDS (+ a glyph), never colour alone (WCAG 1.4.1) — `cls` is
 * only a supplementary tint. `mods` default to NO_TECH_MODS; the UI threads the real
 * effective mods AND (M15) the capital defends with `state.forge`, so the forecast matches
 * the defence the tick resolves with (resolveHorde) — no Kuźnia → forge {} → ×1.0. Pure read.
 */
export type HordeForecastKind = 'defended' | 'risky' | 'doomed'

export interface HordeForecast {
  kind: HordeForecastKind
  /** Glyph + worded verdict; the WORDS carry the meaning (never colour alone). */
  text: string
  /** Supplementary state class: green hold / red loss, '' = luck-dependent (neutral). */
  cls: '' | 'forecast-win' | 'forecast-lose'
}

export function hordeForecast(state: GameState, mods: TechModifiers = NO_TECH_MODS): HordeForecast {
  const capital = capitalOf(state)
  const incoming = hordePower(state)
  // M15: thread state.forge so the forecast defends with the SAME per-type Kuźnia upgrades
  // resolveHorde resolves with (capitalDefense(..., forge)); no Kuźnia → forge {} → ×1.0.
  const defence = capitalDefense(capital, mods, state.forge)
  // Holds even against the strongest (lucky) horde → a guaranteed defence.
  if (defence >= incoming * BEST_LUCK) {
    return { kind: 'defended', text: '✓︎ pewna obrona', cls: 'forecast-win' }
  }
  // Breaches even against the weakest (unlucky) horde → hopeless without more defence.
  if (defence < incoming * WORST_LUCK) {
    return { kind: 'doomed', text: '✗︎ pewna porażka', cls: 'forecast-lose' }
  }
  // In between → the roll decides.
  return { kind: 'risky', text: '⚠︎ ryzykowna obrona', cls: '' }
}

/**
 * Resolve ONE horde against the capital's current defence. Deterministic. Mirrors
 * resolveRaid: one {@link luckFactor} draw per resolved horde (absent rng → no draw,
 * luck = 1), the incoming power is luck-scaled, the capital defence is hardened by tech
 * (`mods.defenseMult`) AND the wall ({@link villageDefenseMult}). A repel (defence >=
 * incoming) bumps the lifetime trophy and logs a won horde report with nothing lost; a
 * breach steals {@link HORDE_BREACH_RESOURCE_FRAC} of EACH capital resource and loses
 * {@link HORDE_BREACH_ARMY_FRAC} of EACH garrison unit type (floored, never below zero),
 * bumps the breach counter and logs a lost horde report. In BOTH cases the escalation
 * level rises by 1 (the timer is re-armed by {@link advanceHorde}, mirroring raids).
 * NEVER destroys a building — a breach is always recoverable (no softlock).
 */
function resolveHorde(
  state: GameState,
  log: BattleReport[],
  mods: TechModifiers = NO_TECH_MODS,
  stats?: Stats,
  rng?: RNG,
  // M15: account-wide unit upgrades (state.forge), threaded into the CAPITAL defence at
  // resolution. OPTIONAL/last; undefined → ×1.0 per unit → byte-identical to pre-M15.
  forge?: Partial<Record<UnitId, number>>,
): void {
  const capital = capitalOf(state)
  // One luck draw per resolved horde (see docstring). Absent rng → no draw, luck = 1.
  const luck = rng !== undefined ? luckFactor(rng) : undefined
  const incoming = hordePower(state) * (luck ?? 1)
  const defence = capitalDefense(capital, mods, forge)

  if (defence >= incoming) {
    // Repelled: the capital holds, nothing lost (high-stakes reward = the lifetime trophy).
    if (stats !== undefined) stats.hordesRepelled += 1
    const report: HordeReport = {
      kind: 'horde',
      villageId: capital.id,
      won: true,
      looted: '0',
      losses: 0,
    }
    if (luck !== undefined) report.luck = luck
    pushBattleReport(log, report)
  } else {
    // Breached: a large slice of EACH resource is hauled off and a chunk of the garrison falls.
    if (stats !== undefined) stats.hordesBreached += 1

    let looted: Decimal = ZERO
    for (const id of RESOURCE_IDS) {
      let steal = capital.resources[id].mul(HORDE_BREACH_RESOURCE_FRAC).floor()
      if (steal.gt(capital.resources[id])) steal = capital.resources[id] // never negative
      capital.resources[id] = capital.resources[id].sub(steal)
      looted = looted.add(steal)
    }

    let losses = 0
    for (const id of UNIT_IDS) {
      const lost = Math.floor((capital.units[id] ?? 0) * HORDE_BREACH_ARMY_FRAC)
      if (lost > 0) {
        capital.units[id] -= lost
        if (capital.units[id] < 0) capital.units[id] = 0 // never below zero
        losses += lost
      }
    }

    const report: HordeReport = {
      kind: 'horde',
      villageId: capital.id,
      won: false,
      looted: looted.toString(),
      losses,
    }
    if (luck !== undefined) report.luck = luck
    pushBattleReport(log, report)
  }

  // Escalate: every horde — repelled or breached — makes the next one harder.
  state.horde.level += 1
}

/**
 * Advance the GLOBAL horde clock by `dtSeconds`, resolving one horde against the CAPITAL
 * each time it elapses. MIRRORS {@link advanceRaids} dt-handling EXACTLY: a single large
 * `dt` (long offline catch-up) resolves every horde that fell within the window, in
 * order, and the timer re-arms to {@link HORDE_INTERVAL} after each (the re-arm lives
 * here, the escalation in resolveHorde — exactly as raids split timer vs resolution).
 * Reports land on the shared global `log`. Deterministic and Node-safe.
 *
 * `mods` (the aggregated tech × prestige multipliers) harden the capital's defence;
 * `stats` (OPTIONAL) is bumped on this deterministic path (hordesRepelled / hordesBreached)
 * so the counters grow identically online / offline / sim, never from the UI; `rng`
 * (OPTIONAL, the per-subStep instance the tick threads in) is passed straight to
 * resolveHorde, which draws EXACTLY ONCE per resolved horde — so the draw count tracks the
 * number of hordes that actually resolve in the window and stays invariant to the `dt`
 * split (the determinism guarantee). Omitting stats/rng (tests/probes) keeps the
 * counter-free, luck-free resolution.
 */
export function advanceHorde(
  state: GameState,
  log: BattleReport[],
  dtSeconds: number,
  mods: TechModifiers = NO_TECH_MODS,
  stats?: Stats,
  rng?: RNG,
  // M15: account-wide unit upgrades (state.forge), passed straight to resolveHorde so the
  // capital defence enjoys the per-type Kuźnia bonus. OPTIONAL/last → byte-identical when omitted.
  forge?: Partial<Record<UnitId, number>>,
): void {
  if (!(dtSeconds > 0)) return
  let dt = dtSeconds
  while (dt > 0) {
    if (state.horde.timer > dt) {
      state.horde.timer -= dt
      break
    }
    dt -= state.horde.timer
    state.horde.timer = 0
    resolveHorde(state, log, mods, stats, rng, forge)
    state.horde.timer = HORDE_INTERVAL
  }
}
