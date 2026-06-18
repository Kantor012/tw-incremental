import { RNG } from '../engine/rng'
import {
  createVillage,
  recomputeDerived,
  RESOURCE_IDS,
  HORDE_INTERVAL,
  EVENT_INTERVAL,
  type GameState,
  type ResourceId,
  type TechModifiers,
} from '../engine/state'
import { generateWorld, WORLD_CENTER } from './world'
import { ERA_NODES, ERA_NODE_IDS, ERA_ROOTS } from '../content/era'
// VALUE import of the dynasty (M6.2) roll-ups — used ONLY inside function bodies below
// (`pendingEraPoints`, `newEra`), never at module top level, so the systems/dynasty.ts <->
// here cycle stays benign exactly like the state.ts edge: by the time any of these run, both
// modules are fully evaluated. dynasty.ts does NOT import back from this module. The
// signature `dynastyEpMult` scales EP gain (so each new dynasty accelerates the era loop),
// and `dynastyStartResourceBonus` extends the run head-start.
import { dynastyEpMult, dynastyStartResourceBonus } from './dynasty'

/**
 * Era engine (M6.1) — the SECOND meta-layer, sitting ABOVE prestige/ascension.
 *
 * Pure functions over a {@link GameState} + the {@link ERA_NODES} catalogue; Node-safe
 * (no DOM, no clock, no Math.random — the only RNG is the seeded {@link RNG}), so the
 * sim and tests can drive it headless and reproducibly. Adding or rebalancing a node is
 * an edit to src/content/era.ts — never to this file. Mirrors systems/prestige.ts.
 *
 * Three responsibilities:
 *  1. EFFECT roll-up. {@link aggregateEraMods} folds every purchased era node's
 *     MULTIPLICATIVE effect into a {@link TechModifiers} bag (same shape as the tech /
 *     prestige bags). systems/prestige.ts `effectiveMods` then COMBINEs that onto the
 *     tech × prestige bag, so all THREE trees fold into every village's derived stats.
 *     The era-only `start_resources` kind is summed by {@link eraStartResourceBonus} and
 *     applied to the capital on reset; the signature `pp_mult` kind is summed by
 *     {@link eraPpMult} and multiplies prestige-point gain. Neither is a multiplier, so
 *     both are SKIPPED by {@link aggregateEraMods}.
 *  2. PURCHASE. Nodes cost ERA POINTS (EP), a plain number banked on
 *     {@link GameState.era}. {@link purchaseEra} spends EP, bumps the node level and
 *     re-derives every village so the new (permanent) multiplier takes effect.
 *  3. THE GREAT RESET. {@link newEra} banks {@link pendingEraPoints}, then WIPES the
 *     ENTIRE prestige account (PP, prestige nodes, ascensions) AND resets the run
 *     deterministically (fresh capital, regenerated world + rng from a per-era seed,
 *     cleared tech/log) while the era account (points, totals, era count, node levels) —
 *     and the lifetime stats/achievements — SURVIVE. The permanent era start-resource
 *     head-start is applied to the new capital.
 *
 * Determinism: every order-sensitive pass iterates {@link ERA_NODE_IDS} (stable source
 * order); the reset draws world + rngState from `seed + ':era' + N`, so a run is
 * byte-identical across replays. The EP curve is integer arithmetic over a CUBE ROOT of
 * the progress score (prestige uses a square root, so EP is rarer than PP), and never
 * depends on float-iteration order.
 *
 * Import discipline (cycle note, mirrors systems/prestige.ts): this module value-imports
 * `recomputeDerived` / `createVillage` / `RESOURCE_IDS` from state.ts (which itself
 * value-imports `effectiveMods` from systems/prestige.ts, which value-imports the era
 * roll-ups from HERE — a benign cycle, because every cross-module value is referenced
 * ONLY inside a function BODY, never at module top level). It does NOT import
 * systems/prestige.ts directly. The reset additionally pulls in `generateWorld` /
 * `WORLD_CENTER` (systems/world) and the seeded {@link RNG} (engine/rng), again read
 * only inside `newEra`. All exports are hoisted `function` declarations, so by the time
 * any runs both modules are fully evaluated regardless of load order. The pure-data era
 * catalogue adds no edge back into this module.
 */

/**
 * Global EP yield scale. `pendingEraPoints = floor(cbrt(eraScore) * EP_SCALE)`. The
 * cube root makes EP markedly rarer than PP (sqrt), so an era is a major, deliberate
 * milestone rather than a frequent reset. The single EP balance knob (the Balance phase
 * / sim tunes it here).
 */
export const EP_SCALE = 1

/**
 * Weight of one ascension in {@link eraScore}. An ascension is a whole prestige run
 * collapsed to a single act, so it is worth far more raw score than a single banked PP —
 * heavy enough that the player who ascends repeatedly (the intended prestige loop) earns
 * EP meaningfully faster than one who only hoards points.
 */
export const ERA_ASC_WEIGHT = 10

/** Clamp `x` into the inclusive range [lo, hi]. */
function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x
}

/**
 * Roll up the purchased era nodes into a {@link TechModifiers} bag — same shape as the
 * tech / prestige bags, so `combine` (systems/prestige.ts) can fold the three. Iterates
 * {@link ERA_NODE_IDS} (stable order) and ignores any unknown / non-positive /
 * non-finite key, so the result is fully deterministic and robust to a stray key.
 *
 * Per kind it sums `effect.perLevel * level` into the matching field: the eight global
 * multiplicative kinds become a `1 + Σ` factor (production applies to ALL resources),
 * and the three reductions become a FRACTION clamped to the combine caps (cost 0.9,
 * recruit/march 0.75). The era-only `start_resources` and `pp_mult` kinds are NOT
 * multipliers and are SKIPPED here (see {@link eraStartResourceBonus} / {@link eraPpMult}).
 *
 * IDENTITY: on an empty map this returns the identity bag (all factors 1, all fractions
 * 0, automations false), so `combine(x, aggregateEraMods({}))` === `x` byte-for-byte —
 * a no-era save is unchanged.
 */
export function aggregateEraMods(nodes: Record<string, number>): TechModifiers {
  const productionMult: Record<ResourceId, number> = { wood: 1, clay: 1, iron: 1 }
  let storageMult = 1
  let popMult = 1
  let costReduction = 0
  let recruitSpeedFrac = 0
  let marchSpeedFrac = 0
  let attackSum = 0
  let defenseSum = 0
  let lootSum = 0

  for (const id of ERA_NODE_IDS) {
    const level = nodes[id]
    if (!(typeof level === 'number') || !Number.isFinite(level) || level <= 0) continue
    const effect = ERA_NODES[id].effect
    const amount = effect.perLevel * level
    switch (effect.kind) {
      case 'production_mult':
        productionMult.wood += amount
        productionMult.clay += amount
        productionMult.iron += amount
        break
      case 'storage_mult':
        storageMult += amount
        break
      case 'pop_mult':
        popMult += amount
        break
      case 'cost_reduction':
        costReduction += amount
        break
      case 'recruit_speed':
        recruitSpeedFrac += amount
        break
      case 'march_speed':
        marchSpeedFrac += amount
        break
      case 'attack_mult':
        attackSum += amount
        break
      case 'defense_mult':
        defenseSum += amount
        break
      case 'loot_mult':
        lootSum += amount
        break
      case 'start_resources':
        break // not a multiplier — consumed by eraStartResourceBonus / newEra
      case 'pp_mult':
        break // not a multiplier — consumed by eraPpMult (scales PP gain)
    }
  }

  return {
    productionMult,
    storageMult,
    popMult,
    costReduction: clamp(costReduction, 0, 0.9),
    recruitSpeedFrac: clamp(recruitSpeedFrac, 0, 0.75),
    marchSpeedFrac: clamp(marchSpeedFrac, 0, 0.75),
    attackMult: 1 + attackSum,
    defenseMult: 1 + defenseSum,
    lootMult: 1 + lootSum,
    // The era tree does NOT unlock idle automations — that gate lives only on the tech
    // tree. Always false here; `combine` ORs it with the other bags' flags.
    automations: { build: false, recruit: false, attack: false },
  }
}

/**
 * The signature era multiplier: prestige-point gain is scaled by `1 + Σ (pp_mult.perLevel
 * * level)` over every purchased era node. Read by systems/prestige.ts `pendingPrestigePoints`
 * so each new era accelerates the whole prestige loop. Defensive: a partial/hand-edited
 * state with no `era` folds to 1 (no bonus) rather than throwing.
 */
export function eraPpMult(state: GameState): number {
  const nodes = state.era ? state.era.nodes : {}
  let sum = 0
  for (const id of ERA_NODE_IDS) {
    const level = nodes[id]
    if (!(typeof level === 'number') || !Number.isFinite(level) || level <= 0) continue
    const effect = ERA_NODES[id].effect
    if (effect.kind === 'pp_mult') sum += effect.perLevel * level
  }
  return 1 + sum
}

/**
 * Total starter resources granted to the capital at the start of a fresh run from the
 * ERA tree: the sum of `start_resources.perLevel * level` over every purchased era node.
 * Applied (alongside the prestige head-start) to EACH resource by {@link newEra} and by
 * systems/prestige.ts `ascend`. Permanent (read from the surviving era nodes), so a
 * deeper era tree means a faster restart every era AND every ascension. Defensive: a
 * state with no `era` folds to 0.
 */
export function eraStartResourceBonus(state: GameState): number {
  const nodes = state.era ? state.era.nodes : {}
  let bonus = 0
  for (const id of ERA_NODE_IDS) {
    const level = nodes[id]
    if (!(typeof level === 'number') || !Number.isFinite(level) || level <= 0) continue
    const effect = ERA_NODES[id].effect
    if (effect.kind === 'start_resources') bonus += effect.perLevel * level
  }
  return bonus
}

/**
 * Deterministic measure of WHOLE-ACCOUNT prestige progress, driving the EP yield. Sums
 * the lifetime PP ever earned + `ascensions * ERA_ASC_WEIGHT` + every purchased prestige
 * node's level. Pure integer-ish addition, so it is order-independent and reproducible.
 * Defensive: a state with no `prestige` scores 0. (The era reset wipes prestige, so the
 * score collapses to 0 immediately after a Nowa Era — EP is earned by rebuilding the
 * prestige account again.)
 */
export function eraScore(state: GameState): number {
  const prestige = state.prestige
  if (!prestige) return 0
  let score = 0
  if (typeof prestige.totalEarned === 'number' && Number.isFinite(prestige.totalEarned)) {
    score += prestige.totalEarned
  }
  if (typeof prestige.ascensions === 'number' && Number.isFinite(prestige.ascensions)) {
    score += prestige.ascensions * ERA_ASC_WEIGHT
  }
  const nodes = prestige.nodes ?? {}
  for (const lvl of Object.values(nodes)) {
    if (typeof lvl === 'number' && Number.isFinite(lvl) && lvl > 0) score += lvl
  }
  return score
}

/**
 * EP awarded for starting a Nowa Era RIGHT NOW: `floor(cbrt(eraScore) * EP_SCALE *
 * dynastyEpMult)`, always >= 0 (0 only when there is no prestige progress to bank). The
 * cube root makes each successive era worth proportionally less per unit of raw prestige
 * progress, and is harsher than the prestige sqrt — EP is the rare, top-tier currency. The
 * dynasty tree's signature `ep_mult` (M6.2) scales the whole yield, so each new dynasty
 * accelerates the era loop. With no dynasty nodes `dynastyEpMult` is 1, a no-op (so M6.1 era
 * behaviour is byte-identical).
 */
export function pendingEraPoints(state: GameState): number {
  const score = eraScore(state)
  if (!(score > 0)) return 0
  return Math.floor(Math.cbrt(score) * EP_SCALE * dynastyEpMult(state))
}

/** Purchased level of era node `id` (absent / non-positive / non-finite = 0). */
export function eraNodeLevel(state: GameState, id: string): number {
  const nodes = state.era ? state.era.nodes : {}
  const level = nodes[id]
  return typeof level === 'number' && Number.isFinite(level) && level > 0 ? level : 0
}

/** True when every prerequisite of `id` is owned at level >= 1 (or it has none). */
function eraPrereqsMet(state: GameState, id: string): boolean {
  const node = ERA_NODES[id]
  if (!node) return false
  for (const pre of node.prerequisites) {
    if (eraNodeLevel(state, pre) < 1) return false
  }
  return true
}

/** True when `id` is unlockable AND not yet maxed (prereqs met, level < maxLevel). */
export function eraNodeAvailable(state: GameState, id: string): boolean {
  const node = ERA_NODES[id]
  if (!node) return false
  if (eraNodeLevel(state, id) >= node.maxLevel) return false
  return eraPrereqsMet(state, id)
}

/**
 * EP cost of the `level` -> `level + 1` step of `id`: `ceil(baseCost * costFactor^level)`.
 * A plain number (EP is not on Decimal — node levels are bounded by maxLevel <= 10, far
 * within Number range) and rounded UP so a level never costs less than its formula
 * (mirrors prestigeNodeCost). Unknown `id` -> 0.
 */
export function eraNodeCost(id: string, level: number): number {
  const node = ERA_NODES[id]
  if (!node) return 0
  return Math.ceil(node.baseCost * Math.pow(node.costFactor, level))
}

/**
 * Whether the next level of `id` can be bought right now, with a UI-facing `reason`
 * when not: the node must exist, not be maxed, have its prerequisites met, and the
 * banked EP must cover {@link eraNodeCost} of the current level.
 */
export function canPurchaseEra(state: GameState, id: string): { ok: boolean; reason?: string } {
  const node = ERA_NODES[id]
  if (!node) return { ok: false, reason: 'Nieznany węzeł' }

  const level = eraNodeLevel(state, id)
  if (level >= node.maxLevel) return { ok: false, reason: 'Poziom maksymalny' }
  if (!eraPrereqsMet(state, id)) return { ok: false, reason: 'Wymagania niespełnione' }

  const cost = eraNodeCost(id, level)
  const points = state.era ? state.era.points : 0
  if (!(points >= cost)) return { ok: false, reason: 'Za mało punktów ery' }
  return { ok: true }
}

/**
 * Buy one level of `id`. Returns false (no mutation) when {@link canPurchaseEra} fails.
 * Otherwise deducts the EP, bumps the node level by one, then calls `recomputeDerived`
 * so the fresh PERMANENT multiplier folds into every village's derived stats immediately.
 * Returns true.
 */
export function purchaseEra(state: GameState, id: string): boolean {
  if (!canPurchaseEra(state, id).ok) return false

  const level = eraNodeLevel(state, id)
  const cost = eraNodeCost(id, level)

  state.era.points -= cost
  state.era.nodes[id] = level + 1
  recomputeDerived(state)
  return true
}

/**
 * NOWA ERA: bank the pending EP and perform THE GREAT RESET — the era account survives,
 * the prestige account does NOT.
 *
 * No-op (returns 0, NO mutation) when {@link pendingEraPoints} is 0, so the player can
 * never throw away their prestige progress for nothing. Otherwise:
 *  - bank `ep`: `era.points += ep`, `era.totalEarned += ep`, `era.eras += 1`;
 *  - WIPE the entire prestige account: `prestige = { points:0, totalEarned:0,
 *    ascensions:0, nodes:{} }`;
 *  - rebuild the run from a per-era seed `seed + ':era' + eras` (DETERMINISTIC): a single
 *    fresh capital at the world centre, the barbarian world regenerated from that seed,
 *    and `rngState` reset to `RNG.fromString(thatSeed)`;
 *  - clear the transient run state: `tech = {}`, `battleLog = []`;
 *  - apply the PERMANENT era head-start: `+eraStartResourceBonus` to EACH resource of the
 *    new capital (read from the surviving era nodes).
 *
 * `era.nodes/points/totalEarned/eras` PERSIST, and so do `stats` / `achievements` (the
 * lifetime career record). `seed`, `createdAt` and `lastSeen` are left untouched —
 * `newEra` takes no clock, so it stays fully deterministic (no Date) and the base run
 * seed is stable across eras. Returns the EP awarded.
 */
export function newEra(state: GameState): number {
  const ep = pendingEraPoints(state)
  if (ep <= 0) return 0

  state.era.points += ep
  state.era.totalEarned += ep
  state.era.eras += 1

  // The great reset wipes the ENTIRE prestige account back to its zero state.
  state.prestige = { points: 0, totalEarned: 0, ascensions: 0, nodes: {} }

  // Per-era seed: distinct world + rng stream each era, fully reproducible.
  const eraSeed = state.seed + ':era' + state.era.eras

  // Fresh single capital at the world centre (mirrors createInitialState's 'v0').
  const capital = createVillage('v0', 'Stolica', WORLD_CENTER.x, WORLD_CENTER.y)
  // Permanent head-start from the era AND dynasty (M6.2) trees: +bonus to EACH starting
  // resource. With no dynasty nodes dynastyStartResourceBonus is 0, so M6.1 era behaviour is
  // unchanged.
  const bonus = eraStartResourceBonus(state) + dynastyStartResourceBonus(state)
  if (bonus > 0) {
    for (const r of RESOURCE_IDS) capital.resources[r] = capital.resources[r].add(bonus)
  }

  state.villages = { v0: capital }
  state.villageOrder = ['v0']
  state.world = generateWorld(eraSeed)
  state.rngState = RNG.fromString(eraSeed).getState()
  state.tech = {}
  state.battleLog = []
  // Re-arm the GLOBAL horde schedule too (M7.2), exactly as createInitialState seeds it: a
  // fresh, defenceless capital must meet a fresh horde clock (timer re-armed, escalation
  // level back to 0). Otherwise the accumulated escalation would wipe the level-1 capital.
  state.horde = { timer: HORDE_INTERVAL, level: 0 }
  // Re-seed the GLOBAL world-events schedule too (M13), mirroring the horde re-arm AND the
  // combat-stream re-seed above: each era gets a fresh, idle event clock whose RNG stream is
  // reproducible from THIS era's own seed (`eraSeed + '::events'`, the same per-run seed family
  // as `rngState`). Without this a stale offer would survive the great reset into a free windfall
  // once the player rebuilds the watchtower, and the events stream would be the lone source of
  // randomness not replayable from the per-run seed.
  state.events = {
    rngState: RNG.fromString(eraSeed + '::events').getState(),
    timer: EVENT_INTERVAL,
    active: null,
    // M14: a fresh era starts with no timed buff in force.
    buff: null,
  }

  // Reconcile derived stats with the surviving era multipliers (prestige is now empty).
  recomputeDerived(state)
  return ep
}

// --- harness / validation helpers (static topology checks, no GameState) -------

/**
 * True if the prerequisite graph contains a cycle (it must NOT — the tree is a DAG).
 * White/gray/black DFS over {@link ERA_NODE_IDS}; a back-edge to a GRAY node is a cycle.
 * Unknown prereq ids are ignored (caught by {@link orphanEraNodes}).
 */
export function eraHasCycle(): boolean {
  const WHITE = 0
  const GRAY = 1
  const BLACK = 2
  const color: Record<string, number> = {}
  for (const id of ERA_NODE_IDS) color[id] = WHITE
  let cycle = false

  const visit = (id: string): void => {
    if (cycle) return
    color[id] = GRAY
    for (const pre of ERA_NODES[id].prerequisites) {
      if (!(pre in color)) continue // unknown id: not a real edge in this graph
      if (color[pre] === GRAY) {
        cycle = true
        return
      }
      if (color[pre] === WHITE) visit(pre)
    }
    color[id] = BLACK
  }

  for (const id of ERA_NODE_IDS) {
    if (color[id] === WHITE) visit(id)
    if (cycle) break
  }
  return cycle
}

/**
 * Node ids NOT reachable from {@link ERA_ROOTS} by following prerequisite edges in the
 * unlock direction (prereq -> dependent). Empty means every node is purchasable via some
 * path from a root. Returned in stable {@link ERA_NODE_IDS} order.
 */
export function orphanEraNodes(): string[] {
  const children: Record<string, string[]> = {}
  for (const id of ERA_NODE_IDS) children[id] = []
  for (const id of ERA_NODE_IDS) {
    for (const pre of ERA_NODES[id].prerequisites) {
      if (pre in children) children[pre].push(id)
    }
  }

  const reachable = new Set<string>()
  const stack: string[] = []
  for (const r of ERA_ROOTS) {
    if (r in children && !reachable.has(r)) {
      reachable.add(r)
      stack.push(r)
    }
  }
  while (stack.length > 0) {
    const id = stack.pop() as string
    for (const c of children[id]) {
      if (!reachable.has(c)) {
        reachable.add(c)
        stack.push(c)
      }
    }
  }

  return ERA_NODE_IDS.filter((id) => !reachable.has(id))
}

/**
 * Node ids with no real effect — a missing effect or `perLevel <= 0` (a "dead perk").
 * Empty means every node grants a bonus when levelled. Stable {@link ERA_NODE_IDS} order.
 */
export function deadEraNodes(): string[] {
  return ERA_NODE_IDS.filter((id) => {
    const effect = ERA_NODES[id].effect
    return !effect || typeof effect.perLevel !== 'number' || effect.perLevel <= 0
  })
}
