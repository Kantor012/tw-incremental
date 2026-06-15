import type { Decimal } from '../engine/decimal'
import {
  NO_TECH_MODS,
  RESOURCE_IDS,
  type AutomationSettings,
  type BattleReport,
  type GameState,
  type TechModifiers,
  type Village,
  type World,
} from '../engine/state'
import { UNITS, UNIT_IDS, type UnitId } from '../content/units'
import { BUILDING_IDS, type BuildingId } from '../content/buildings'
import { barbarianTarget } from '../content/barbarians'
import { build, nextCostAffordable } from './buildings'
import { canRecruit, freePopulation, recruit, recruitCost } from './recruitment'
import { canAttack, sendAttack, stationedUnits } from './marches'
import { applyLosses, armyAttackPower } from './combat'
import { targetsByDistance } from './world'

/**
 * Idle-automation engine (M5.1) — the routines the player can UNLOCK (a binary
 * `automation_unlock` tech gate, surfaced as {@link TechModifiers.automations}) and
 * TOGGLE on ({@link GameState.automation}) so the game plays its own routine while
 * idle: auto-build the cheapest affordable building, keep a chosen unit topped up,
 * and throw the standing army at the nearest beatable barbarian.
 *
 * HARD GUARANTEES (CLAUDE.md):
 *  - DETERMINISTIC & RNG-FREE here: every choice is a pure function of the village /
 *    world state on a STABLE iteration order ({@link BUILDING_IDS},
 *    {@link UNIT_IDS}, {@link targetsByDistance}'s distance+id ordering). The only
 *    randomness the game has (none in combat yet) would come from the systems these
 *    helpers call, never from this module — no `Date`, no `Math.random`. Because
 *    {@link runAutomation} runs inside the fixed-grid sub-step (tick.ts), online,
 *    offline and the sim harness stay byte-identical with automation ON.
 *  - SELF-LIMITING (no infinite loops / no softlock): each `*Once` helper performs at
 *    most ONE action per call and is naturally bounded by the village's resources,
 *    population and in-flight marches — auto-build stops when nothing is affordable,
 *    auto-recruit stops at the target count, auto-attack sends the idle army once and
 *    then has none left until it returns.
 *  - BALANCE-NEUTRAL when off: the toggles default OFF and the gate defaults locked
 *    ({@link NO_TECH_MODS}), so a run that never unlocks/enables automation takes the
 *    exact same path as pre-M5.1 — the 17 balance goals are untouched.
 *
 * Import discipline: this module sits ABOVE the per-system engines (buildings /
 * recruitment / marches / combat / world) and the data leaves; none of them import it
 * back, so it can never take part in an initialisation cycle. tick.ts imports
 * {@link runAutomation} from here.
 */

/**
 * First gate auto-attack demands before committing the army: its attack power must be
 * at least this multiple of the camp's defence, so the fight is a guaranteed WIN
 * (`battleOutcome` needs power strictly > defence, and 1.25x clears that with headroom
 * for the attrition curve). Note this only secures the VICTORY, not that the army
 * survives it — a lone/marginal stack can win yet attrit to zero (see the per-type
 * floor in combat.ts). autoAttackOnce therefore pairs this with an exact survivor
 * check so the routine never feeds the army into a loss. Balance knob.
 */
const WIN_MARGIN = 1.25

/**
 * AUTO-BUILD one level: pick the NON-maxed building this village can currently afford
 * from its OWN resources with the LOWEST total (wood+clay+iron) next-level cost — ties
 * broken by {@link BUILDING_IDS} order — and build it. Returns true iff a level was
 * bought. A no-op (false) when every building is maxed or unaffordable, so it can be
 * called every sub-step without ever stalling.
 *
 * Costs/affordability fold in the account-wide tech multipliers `mods` (same path as
 * a manual build), so the routine charges exactly what the UI would. Mirrors the
 * manual build: spends LOCAL village resources via {@link build}.
 */
export function autoBuildOnce(v: Village, mods: TechModifiers = NO_TECH_MODS): boolean {
  let bestId: BuildingId | null = null
  let bestCost: Decimal | null = null
  for (const id of BUILDING_IDS) {
    const { cost, affordable, maxed } = nextCostAffordable(v, id, mods)
    if (maxed || !affordable) continue
    const total = cost.wood.add(cost.clay).add(cost.iron)
    // Strict `<` keeps the FIRST building in BUILDING_IDS order on a cost tie.
    if (bestCost === null || total.lt(bestCost)) {
      bestCost = total
      bestId = id
    }
  }
  if (bestId === null) return false
  return build(v, bestId, mods)
}

/** Units of `unit` still waiting in `v`'s training queue (across all orders). */
function queuedCount(v: Village, unit: UnitId): number {
  let n = 0
  for (const o of v.recruitQueue) if (o.unitId === unit) n += o.count
  return n
}

/**
 * AUTO-RECRUIT one batch: if a unit is chosen and the village is below its target
 * standing count (counting both the live roster AND what is already queued), enqueue
 * as many as it can in one deterministic batch — the smallest of the remaining
 * DEFICIT, what the village can AFFORD, and what fits in FREE POPULATION. Returns
 * true iff something was queued.
 *
 * Gated by {@link canRecruit} for a single unit first (so unlock / a positive
 * affordable+pop floor are honoured); since that guarantees room for >= 1 and the
 * deficit is >= 1 when we get here, the computed batch is always >= 1. A no-op
 * (false) when no unit is chosen, the target is already met, or one unit is
 * unaffordable / has no population room — never partial-spends or over-commits.
 */
export function autoRecruitOnce(
  v: Village,
  settings: AutomationSettings,
  mods: TechModifiers = NO_TECH_MODS,
): boolean {
  const unit = settings.recruitUnit
  if (unit === null) return false

  const have = (v.units[unit] ?? 0) + queuedCount(v, unit)
  const deficit = settings.recruitTarget - have
  if (deficit <= 0) return false

  // Single-unit gate: unlock + affordable + population headroom for at least one.
  if (!canRecruit(v, unit, 1).ok) return false

  // Largest batch we can both afford and feed, never above the deficit. cost1 is the
  // PER-UNIT cost; resources/population scale linearly, so floor(balance / per-unit)
  // is the cap. We start at `deficit` (finite, <= recruitTarget) and only ever shrink,
  // so each `.toNumber()` reads a Decimal already known to be below a finite bound.
  let batch = deficit
  const cost1 = recruitCost(unit, 1)
  for (const r of RESOURCE_IDS) {
    const per = cost1[r]
    if (per.gt(0)) {
      const maxR = v.resources[r].div(per).floor()
      if (maxR.lt(batch)) batch = maxR.toNumber()
    }
  }
  const popPer = UNITS[unit].pop
  if (popPer > 0) {
    const maxPop = freePopulation(v).div(popPer).floor()
    if (maxPop.lt(batch)) batch = maxPop.toNumber()
  }

  // canRecruit(…,1) passed and deficit >= 1, so batch is >= 1 here; clamp defensively
  // so a rounding edge can never call recruit() with a non-positive count.
  if (batch < 1) batch = 1
  return recruit(v, unit, batch, mods)
}

/** True when `v` already has a march (outbound or returning) aimed at barbarian `id`. */
function hasMarchTo(v: Village, id: string): boolean {
  for (const m of v.marches) if (m.targetId === id) return true
  return false
}

/**
 * AUTO-ATTACK once: send the village's whole IDLE COMBAT army (everything at home
 * MINUS nobles — conquest stays manual —, scouts — recon-only, attack 0/no loot — and
 * siege units — ram/catapult are a manual, target-specific decision, excluded
 * data-driven via {@link UnitDef.siege})
 * at the NEAREST barbarian it is WIN-SAFE
 * against and has no march already flying at. "Nearest" is Euclidean with the id
 * index as a deterministic tiebreaker ({@link targetsByDistance}); "win-safe" means
 * BOTH that the army's attack power (with `mods`) clears {@link WIN_MARGIN}x the camp's
 * defence (a guaranteed win) AND that, replaying combat.ts's exact per-type attrition
 * floor, at least one unit survives to march home — so the routine never trades the
 * army for a victory it can't carry back. Returns true iff an attack was dispatched.
 *
 * NEVER sends nobles, scouts or siege. Self-limiting: the dispatched army moves into `v.marches`, so
 * {@link stationedUnits} no longer counts it and the target gets a march — the same
 * stack is never re-sent until it returns. A no-op (false) when there is no idle
 * combat army or no reachable beatable target.
 */
export function autoAttackOnce(
  v: Village,
  world: World,
  log: BattleReport[],
  mods: TechModifiers = NO_TECH_MODS,
): boolean {
  // Idle combat army = units at home (roster − marches), with nobles, scouts AND
  // siege zeroed out: nobles stay manual (conquest), scouts are recon-only (attack 0,
  // no loot, they must never be fed into a fight) and siege (ram/catapult) is a
  // deliberate, target-specific play (a ram only earns its keep cracking a stronger
  // camp's defence; a catapult is spent to permanently raze a camp's level), so none
  // of them belongs in the idle auto-attack stack. Siege is excluded data-driven via
  // UnitDef.siege, so any future siege unit auto-drops from auto-attack with no edit.
  const idle = stationedUnits(v)
  idle.noble = 0
  idle.scout = 0
  for (const id of UNIT_IDS) if (UNITS[id].siege) idle[id] = 0
  let total = 0
  for (const id of UNIT_IDS) total += idle[id]
  if (total <= 0) return false

  const power = armyAttackPower(idle, mods)
  for (const b of targetsByDistance(v, world)) {
    if (hasMarchTo(v, b.id)) continue
    const def = barbarianTarget(b.level).defensePower
    if (power < def * WIN_MARGIN) continue
    // WIN-SAFE in the strict sense: winning is NOT enough — the army must also come
    // home alive. combat.ts floors survivors PER UNIT TYPE (applyLosses) with
    // lossFrac = (def/power)^1.5, and advanceMarches DROPS the march entirely (army
    // gone, zero loot) when totalUnits(survivors) <= 0. A lone or marginal stack can
    // win yet attrit to nothing (e.g. 1 axeman power40 vs def30 → floor(1·0.35)=0), so
    // mirror that exact resolution and refuse any target that would annihilate the
    // dispatched army. The stack then stays home until it regroups into a survivable
    // force — auto-attack never bleeds the army it just trained.
    const lossFrac = power > def ? (def > 0 ? Math.pow(def / power, 1.5) : 0) : 1
    const after = applyLosses(idle, lossFrac)
    let survivors = 0
    for (const id of UNIT_IDS) survivors += after[id]
    if (survivors < 1) continue
    if (!canAttack(v, b, idle).ok) continue
    return sendAttack(v, world, log, b.id, idle, mods)
  }
  return false
}

/**
 * Run every UNLOCKED-and-ENABLED automation once for every village, in
 * {@link GameState.villageOrder} (stable). A routine fires only when BOTH its tech
 * gate is unlocked (`mods.automations[kind]`) AND the player's switch is on
 * (`state.automation[kind]`), so with the gate locked or the toggle off this is a
 * pure no-op and the run is byte-identical to pre-M5.1 play. The per-village action
 * order (build → recruit → attack) is fixed for determinism.
 *
 * Called from the deterministic sub-step (tick.ts) with the SAME `mods` the rest of
 * the step uses. `dt` is accepted for symmetry with the other sub-step advancers and
 * in case a future routine needs to gate on elapsed time; the current actions are
 * instant and self-limiting, so it is unused.
 */
export function runAutomation(state: GameState, mods: TechModifiers, _dt: number): void {
  for (const id of state.villageOrder) {
    const v = state.villages[id]
    if (!v) continue
    if (mods.automations.build && state.automation.build) autoBuildOnce(v, mods)
    if (mods.automations.recruit && state.automation.recruit) {
      autoRecruitOnce(v, state.automation, mods)
    }
    if (mods.automations.attack && state.automation.attack) {
      autoAttackOnce(v, state.world, state.battleLog, mods)
    }
  }
}
