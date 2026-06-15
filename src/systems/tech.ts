import { D, type Decimal } from '../engine/decimal'
import {
  recomputeDerived,
  RESOURCE_IDS,
  type GameState,
  type ResourceId,
  type ResourceMap,
  type TechModifiers,
} from '../engine/state'
import { TECH_NODES, TECH_NODE_IDS, TECH_ROOTS } from '../content/tech'
import type { ResourceCost } from '../content/buildings'

/**
 * Tech (passive tree) engine — generic, data-driven purchase + roll-up logic for
 * the global, account-wide constellation (M3.1). Pure functions over a
 * {@link GameState} + the {@link TECH_NODES} catalogue; Node-safe (no DOM / clock /
 * RNG), so the sim and tests can drive it headless. Adding or rebalancing a node is
 * an edit to src/content/tech.ts — never to this file.
 *
 * Two responsibilities:
 *  1. ECONOMY roll-up: {@link aggregateTechMods} folds every purchased node's
 *     economic effect into a single {@link TechModifiers} bag, which
 *     `recomputeDerived` (state.ts) threads into every village's derived stats. This
 *     is the ONLY place tech touches the simulation in M3.1 (combat/marches untouched).
 *  2. PURCHASE: nodes cost resources drawn from the GLOBAL pool (summed across all
 *     villages); {@link purchaseTech} spends greedily across villages and bumps the
 *     node's level, then re-derives every village so the new multiplier takes effect.
 *
 * Determinism: every order-sensitive pass iterates a STABLE order —
 * {@link TECH_NODE_IDS} for nodes, {@link GameState.villageOrder} for villages — so
 * the roll-up and the greedy spend are byte-identical across replays.
 *
 * Import discipline (cycle note): state.ts value-imports `aggregateTechMods` from
 * here, and this module value-imports `recomputeDerived` back from state.ts — a
 * 2-way edge. It is SAFE from an initialisation cycle because each cross-module
 * value is referenced ONLY inside a function BODY (never at module top level):
 * `recomputeDerived` is used only inside {@link purchaseTech}, `aggregateTechMods`
 * only inside `recomputeDerived`. By the time either runs, both modules are fully
 * evaluated regardless of load order. Everything else here is types (erased) or the
 * pure-data {@link TECH_NODES} / Decimal helpers, which never depend back on the engine.
 */

/** Purchased level of `nodeId` (absent / non-positive / non-finite key = 0). */
export function nodeLevel(state: GameState, nodeId: string): number {
  const level = state.tech[nodeId]
  return typeof level === 'number' && Number.isFinite(level) && level > 0 ? level : 0
}

/**
 * Cost of the level `level` -> `level + 1` step of `nodeId`, per resource:
 * `ceil(baseCost[r] * costFactor ^ level)`. On Decimal (scales past 2^53) and
 * rounded UP so a level never costs less than its formula — mirrors `buildingCost`.
 * Assumes `nodeId` is a real node (callers gate via {@link canPurchaseTech}).
 */
export function techCost(nodeId: string, level: number): ResourceCost {
  const node = TECH_NODES[nodeId]
  const growth = D(node.costFactor).pow(level)
  return {
    wood: D(node.baseCost.wood).mul(growth).ceil(),
    clay: D(node.baseCost.clay).mul(growth).ceil(),
    iron: D(node.baseCost.iron).mul(growth).ceil(),
  }
}

/**
 * Roll up the whole purchased tree into the GLOBAL {@link TechModifiers}. Iterates
 * {@link TECH_NODE_IDS} (stable order) and ignores any unknown / non-positive key in
 * `tech`, so the result is fully deterministic and robust to a stray key.
 *
 * Per kind it sums `effect.perLevel * level` and folds it into the matching field:
 *  - production_mult / storage_mult / pop_mult -> `1 + Σ` factor (no `resource` on a
 *    production node = all three resources).
 *  - cost_reduction -> `costReduction`, a FRACTION clamped to [0, 0.8].
 *  - recruit_speed  -> `recruitSpeedFrac`, a FRACTION clamped to [0, 0.75].
 *  - march_speed    -> `marchSpeedFrac`, a FRACTION clamped to [0, 0.75].
 *  - attack_mult / defense_mult / loot_mult -> `1 + Σ` factor (>= 1).
 *
 * The fractional caps bound how far time/cost can be reduced (so a tree can never make
 * builds free or marches instant); the multiplicative fields are unbounded but grow
 * only via small per-level fractions in the data, kept in check by the Balance phase.
 */
export function aggregateTechMods(tech: Record<string, number>): TechModifiers {
  const productionMult: Record<ResourceId, number> = { wood: 1, clay: 1, iron: 1 }
  let storageMult = 1
  let popMult = 1
  let costReduction = 0
  let recruitSpeedFrac = 0
  let marchSpeedFrac = 0
  let attackSum = 0
  let defenseSum = 0
  let lootSum = 0
  const automations = { build: false, recruit: false, attack: false }

  for (const id of TECH_NODE_IDS) {
    const level = tech[id]
    if (!(typeof level === 'number') || !Number.isFinite(level) || level <= 0) continue
    const effect = TECH_NODES[id].effect
    // `automation_unlock` is a BINARY effect with no `perLevel` — guard the numeric
    // roll-up so accessing `effect.perLevel` is type-safe (it is unused for that kind).
    const amount = effect.kind === 'automation_unlock' ? 0 : effect.perLevel * level
    switch (effect.kind) {
      case 'production_mult':
        if (effect.resource) {
          productionMult[effect.resource] += amount
        } else {
          productionMult.wood += amount
          productionMult.clay += amount
          productionMult.iron += amount
        }
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
      case 'automation_unlock':
        // BINARY unlock: any owned level (>= 1, guaranteed by the level filter above)
        // flips the routine's gate on. No scaling — `target` selects the routine.
        automations[effect.target] = true
        break
    }
  }

  const clamp = (x: number, lo: number, hi: number): number => (x < lo ? lo : x > hi ? hi : x)

  return {
    productionMult,
    storageMult,
    popMult,
    costReduction: clamp(costReduction, 0, 0.8),
    recruitSpeedFrac: clamp(recruitSpeedFrac, 0, 0.75),
    marchSpeedFrac: clamp(marchSpeedFrac, 0, 0.75),
    attackMult: 1 + attackSum,
    defenseMult: 1 + defenseSum,
    lootMult: 1 + lootSum,
    automations,
  }
}

/** True when every prerequisite of `nodeId` is owned at level >= 1 (or it has none). */
export function prerequisitesMet(state: GameState, nodeId: string): boolean {
  const node = TECH_NODES[nodeId]
  if (!node) return false
  for (const pre of node.prerequisites) {
    if (nodeLevel(state, pre) < 1) return false
  }
  return true
}

/** True when `nodeId` is unlockable AND not yet maxed (prereqs met, level < maxLevel). */
export function nodeAvailable(state: GameState, nodeId: string): boolean {
  const node = TECH_NODES[nodeId]
  if (!node) return false
  if (nodeLevel(state, nodeId) >= node.maxLevel) return false
  return prerequisitesMet(state, nodeId)
}

/**
 * The GLOBAL resource pool tech is bought from: the per-resource sum of every
 * village's resources, in {@link GameState.villageOrder} (stable). On Decimal.
 */
export function globalResources(state: GameState): ResourceMap {
  const total: ResourceMap = { wood: D(0), clay: D(0), iron: D(0) }
  for (const vid of state.villageOrder) {
    const v = state.villages[vid]
    if (!v) continue
    for (const r of RESOURCE_IDS) {
      total[r] = total[r].add(v.resources[r])
    }
  }
  return total
}

/**
 * Whether the next level of `nodeId` can be bought right now, with a UI-facing
 * `reason` when not: the node must exist, not be maxed, have its prerequisites met,
 * and the GLOBAL pool must cover {@link techCost} of the current level.
 */
export function canPurchaseTech(state: GameState, nodeId: string): { ok: boolean; reason?: string } {
  const node = TECH_NODES[nodeId]
  if (!node) return { ok: false, reason: 'Nieznany węzeł' }

  const level = nodeLevel(state, nodeId)
  if (level >= node.maxLevel) return { ok: false, reason: 'Poziom maksymalny' }
  if (!prerequisitesMet(state, nodeId)) return { ok: false, reason: 'Wymagania niespełnione' }

  const cost = techCost(nodeId, level)
  const pool = globalResources(state)
  if (pool.wood.lt(cost.wood) || pool.clay.lt(cost.clay) || pool.iron.lt(cost.iron)) {
    return { ok: false, reason: 'Za mało surowców' }
  }
  return { ok: true }
}

/**
 * Buy one level of `nodeId`. Returns false (no mutation) when {@link canPurchaseTech}
 * fails. Otherwise spends the cost from the GLOBAL pool — GREEDY across villages in
 * {@link GameState.villageOrder}, taking `min(remaining need, village balance)` per
 * resource (never driving a village below 0) until the cost is covered — bumps the
 * node's level by one, then calls `recomputeDerived` so the fresh multiplier folds
 * into every village's derived stats. Returns true.
 */
export function purchaseTech(state: GameState, nodeId: string): boolean {
  if (!canPurchaseTech(state, nodeId).ok) return false

  const level = nodeLevel(state, nodeId)
  const cost = techCost(nodeId, level)

  // Greedy drain across villages, per resource. canPurchaseTech guarantees the pool
  // covers the cost, so each `need` reaches 0 within the loop.
  for (const r of RESOURCE_IDS) {
    let need: Decimal = cost[r]
    for (const vid of state.villageOrder) {
      if (need.lte(0)) break
      const v = state.villages[vid]
      if (!v) continue
      const have = v.resources[r]
      const take = have.gte(need) ? need : have
      if (take.gt(0)) {
        v.resources[r] = have.sub(take)
        need = need.sub(take)
      }
    }
  }

  state.tech[nodeId] = level + 1
  recomputeDerived(state)
  return true
}

// --- harness / validation helpers (static topology checks, no GameState) -------

/**
 * True if the prerequisite graph contains a cycle (it must NOT — the tree is a DAG).
 * Iterative-free DFS with white/gray/black colouring over {@link TECH_NODE_IDS};
 * a back-edge to a GRAY node is a cycle. Unknown prereq ids are ignored (they are
 * caught by {@link orphanNodes}, not treated as cycle edges).
 */
export function techHasCycle(): boolean {
  const WHITE = 0
  const GRAY = 1
  const BLACK = 2
  const color: Record<string, number> = {}
  for (const id of TECH_NODE_IDS) color[id] = WHITE
  let cycle = false

  const visit = (id: string): void => {
    if (cycle) return
    color[id] = GRAY
    for (const pre of TECH_NODES[id].prerequisites) {
      if (!(pre in color)) continue // unknown id: not a real edge in this graph
      if (color[pre] === GRAY) {
        cycle = true
        return
      }
      if (color[pre] === WHITE) visit(pre)
    }
    color[id] = BLACK
  }

  for (const id of TECH_NODE_IDS) {
    if (color[id] === WHITE) visit(id)
    if (cycle) break
  }
  return cycle
}

/**
 * Node ids NOT reachable from {@link TECH_ROOTS} by following prerequisite edges in
 * the unlock direction (prereq -> dependent). Empty means every node is purchasable
 * via some path from a root. Returned in stable {@link TECH_NODE_IDS} order.
 */
export function orphanNodes(): string[] {
  // Forward adjacency: an edge prereq -> node (the direction the player unlocks).
  const children: Record<string, string[]> = {}
  for (const id of TECH_NODE_IDS) children[id] = []
  for (const id of TECH_NODE_IDS) {
    for (const pre of TECH_NODES[id].prerequisites) {
      if (pre in children) children[pre].push(id)
    }
  }

  const reachable = new Set<string>()
  const stack: string[] = []
  for (const r of TECH_ROOTS) {
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

  return TECH_NODE_IDS.filter((id) => !reachable.has(id))
}

/**
 * Node ids with no real effect — a missing effect or `perLevel <= 0` (a "dead perk").
 * Empty means every node grants a bonus when levelled. Stable {@link TECH_NODE_IDS} order.
 *
 * `automation_unlock` is a BINARY effect (no `perLevel`) that DOES grant a real bonus
 * (it unlocks an idle routine), so it is treated as valid explicitly rather than failing
 * the `perLevel > 0` test (M5.1) — see the kind's note in src/content/tech.ts.
 */
export function deadPerkNodes(): string[] {
  return TECH_NODE_IDS.filter((id) => {
    const effect = TECH_NODES[id].effect
    if (!effect) return true
    if (effect.kind === 'automation_unlock') return false
    return typeof effect.perLevel !== 'number' || effect.perLevel <= 0
  })
}
