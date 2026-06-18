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
import { DYNASTY_NODES, DYNASTY_NODE_IDS, DYNASTY_ROOTS } from '../content/dynasty'

/**
 * Dynasty engine (M6.2) — the THIRD meta-layer, sitting ABOVE era.
 *
 * Pure functions over a {@link GameState} + the {@link DYNASTY_NODES} catalogue; Node-safe
 * (no DOM, no clock, no Math.random — the only RNG is the seeded {@link RNG}), so the
 * sim and tests can drive it headless and reproducibly. Adding or rebalancing a node is an
 * edit to src/content/dynasty.ts — never to this file. Mirrors systems/era.ts.
 *
 * Three responsibilities:
 *  1. EFFECT roll-up. {@link aggregateDynastyMods} folds every purchased dynasty node's
 *     MULTIPLICATIVE effect into a {@link TechModifiers} bag (same shape as the tech /
 *     prestige / era bags). systems/prestige.ts `effectiveMods` then COMBINEs that onto the
 *     tech × prestige × era bag, so all FOUR trees fold into every village's derived stats.
 *     The dynasty-only `start_resources` kind is summed by {@link dynastyStartResourceBonus}
 *     and applied to the capital on reset; the signature `ep_mult` kind is summed by
 *     {@link dynastyEpMult} and multiplies era-point gain. Neither is a multiplier, so both
 *     are SKIPPED by {@link aggregateDynastyMods}. The binary `automation_unlock` gateway is
 *     the ONE exception that DOES affect the bag: it flips all three automation flags true —
 *     this aggregate is the ONLY one in the whole game that can unlock automations.
 *  2. PURCHASE. Nodes cost DYNASTY POINTS (DP), a plain number banked on
 *     {@link GameState.dynasty}. {@link purchaseDynasty} spends DP, bumps the node level and
 *     re-derives every village so the new (permanent) multiplier takes effect.
 *  3. THE GREAT-GREAT RESET. {@link newDynasty} banks {@link pendingDynastyPoints}, then
 *     WIPES the ENTIRE era account (EP, era nodes, eras) AND the ENTIRE prestige account
 *     (PP, prestige nodes, ascensions) AND resets the run deterministically (fresh capital,
 *     regenerated world + rng from a per-dynasty seed, cleared tech/log) while the dynasty
 *     account (points, totals, dynasty count, node levels) — and the lifetime
 *     stats/achievements — SURVIVE. The permanent dynasty start-resource head-start is
 *     applied to the new capital.
 *
 * Determinism: every order-sensitive pass iterates {@link DYNASTY_NODE_IDS} (stable source
 * order); the reset draws world + rngState from `seed + ':dyn' + N`, so a run is
 * byte-identical across replays. The DP curve is integer arithmetic over a CUBE ROOT of the
 * ERA account's progress score (dynasty progress is measured from the era account exactly as
 * era is measured from the prestige account), and never depends on float-iteration order.
 *
 * Import discipline (cycle note, mirrors systems/era.ts): this module value-imports
 * `recomputeDerived` / `createVillage` / `RESOURCE_IDS` from state.ts (which itself
 * value-imports `effectiveMods` from systems/prestige.ts, which value-imports the dynasty
 * roll-ups from HERE — a benign cycle, because every cross-module value is referenced ONLY
 * inside a function BODY, never at module top level). It does NOT import systems/prestige.ts
 * or systems/era.ts (era.ts imports the dynasty EP/start helpers the other way; this module
 * never imports back). The reset additionally pulls in `generateWorld` / `WORLD_CENTER`
 * (systems/world) and the seeded {@link RNG} (engine/rng), again read only inside
 * `newDynasty`. All exports are hoisted `function` declarations, so by the time any runs both
 * modules are fully evaluated regardless of load order. The pure-data dynasty catalogue adds
 * no edge back into this module.
 */

/**
 * Global DP yield scale. `pendingDynastyPoints = floor(cbrt(dynastyScore) * DP_SCALE)`. The
 * cube root makes DP markedly rare (it is measured from the whole ERA account, which is
 * itself a rare currency), so founding a dynasty is a top-tier, deliberate milestone. The
 * single DP balance knob (the Balance phase / sim tunes it here).
 */
export const DP_SCALE = 1

/**
 * Weight of one era in {@link dynastyScore}. An era is a whole era run collapsed to a single
 * act, so it is worth far more raw score than a single banked EP — heavy enough that the
 * player who starts eras repeatedly (the intended era loop) earns DP meaningfully faster than
 * one who only hoards points. Mirrors `ERA_ASC_WEIGHT`.
 */
export const DYN_ERA_WEIGHT = 10

/** Clamp `x` into the inclusive range [lo, hi]. */
function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x
}

/**
 * Roll up the purchased dynasty nodes into a {@link TechModifiers} bag — same shape as the
 * tech / prestige / era bags, so `combine` (systems/prestige.ts) can fold the four. Iterates
 * {@link DYNASTY_NODE_IDS} (stable order) and ignores any unknown / non-positive /
 * non-finite key, so the result is fully deterministic and robust to a stray key.
 *
 * Per kind it sums `effect.perLevel * level` into the matching field: the nine global
 * multiplicative kinds become a `1 + Σ` factor (production applies to ALL resources), and
 * the three reductions become a FRACTION clamped to the combine caps (cost 0.9, recruit/march
 * 0.75). The dynasty-only `start_resources` and `ep_mult` kinds are NOT multipliers and are
 * SKIPPED here (see {@link dynastyStartResourceBonus} / {@link dynastyEpMult}).
 *
 * The binary `automation_unlock` gateway is special: if ANY owned node carries it, ALL THREE
 * automation flags (build / recruit / attack) are set true — this is the ONLY aggregate in
 * the whole game that can unlock automations (the tech / prestige / era bags all leave them
 * false), so once a dynasty owns the gateway every idle routine is unlocked account-wide from
 * the start, permanently.
 *
 * IDENTITY: on an empty map this returns the identity bag (all factors 1, all fractions 0,
 * automations false), so `combine(x, aggregateDynastyMods({}))` === `x` byte-for-byte — a
 * no-dynasty save is unchanged.
 */
export function aggregateDynastyMods(nodes: Record<string, number>): TechModifiers {
  const productionMult: Record<ResourceId, number> = { wood: 1, clay: 1, iron: 1 }
  let storageMult = 1
  let popMult = 1
  let costReduction = 0
  let recruitSpeedFrac = 0
  let marchSpeedFrac = 0
  let attackSum = 0
  let defenseSum = 0
  let lootSum = 0
  let automationUnlocked = false

  for (const id of DYNASTY_NODE_IDS) {
    const level = nodes[id]
    if (!(typeof level === 'number') || !Number.isFinite(level) || level <= 0) continue
    const effect = DYNASTY_NODES[id].effect
    // The binary gateway has no `perLevel`; owning it (level >= 1) unlocks all automations.
    // Guard it out FIRST so the rest of the switch narrows to the magnitude-bearing kinds.
    if (effect.kind === 'automation_unlock') {
      automationUnlocked = true
      continue
    }
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
        break // not a multiplier — consumed by dynastyStartResourceBonus / newDynasty
      case 'ep_mult':
        break // not a multiplier — consumed by dynastyEpMult (scales EP gain)
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
    // The dynasty `automation_unlock` gateway is the ONE place automations are unlocked.
    // All three flags share the single gate; `combine` ORs them with the other bags' flags
    // (which are always false), so once the gateway is owned every routine is unlocked.
    automations: {
      build: automationUnlocked,
      recruit: automationUnlocked,
      attack: automationUnlocked,
    },
  }
}

/**
 * The signature dynasty multiplier: era-point gain is scaled by `1 + Σ (ep_mult.perLevel *
 * level)` over every purchased dynasty node. Read by systems/era.ts `pendingEraPoints` so
 * each new dynasty accelerates the whole era loop (mirrors `eraPpMult` on the PP yield).
 * Defensive: a partial/hand-edited state with no `dynasty` folds to 1 (no bonus).
 */
export function dynastyEpMult(state: GameState): number {
  const nodes = state.dynasty ? state.dynasty.nodes : {}
  let sum = 0
  for (const id of DYNASTY_NODE_IDS) {
    const level = nodes[id]
    if (!(typeof level === 'number') || !Number.isFinite(level) || level <= 0) continue
    const effect = DYNASTY_NODES[id].effect
    if (effect.kind === 'ep_mult') sum += effect.perLevel * level
  }
  return 1 + sum
}

/**
 * Total starter resources granted to the capital at the start of a fresh run from the
 * DYNASTY tree: the sum of `start_resources.perLevel * level` over every purchased dynasty
 * node. Applied (alongside the prestige + era head-starts) to EACH resource by
 * {@link newDynasty}, systems/era.ts `newEra` and systems/prestige.ts `ascend`. Permanent
 * (read from the surviving dynasty nodes), so a deeper dynasty tree means a faster restart
 * every reset of any kind. Defensive: a state with no `dynasty` folds to 0.
 */
export function dynastyStartResourceBonus(state: GameState): number {
  const nodes = state.dynasty ? state.dynasty.nodes : {}
  let bonus = 0
  for (const id of DYNASTY_NODE_IDS) {
    const level = nodes[id]
    if (!(typeof level === 'number') || !Number.isFinite(level) || level <= 0) continue
    const effect = DYNASTY_NODES[id].effect
    if (effect.kind === 'start_resources') bonus += effect.perLevel * level
  }
  return bonus
}

/**
 * Deterministic measure of WHOLE-ACCOUNT era progress, driving the DP yield. Sums the
 * lifetime EP ever earned + `eras * DYN_ERA_WEIGHT` + every purchased era node's level.
 * Dynasty progress is measured from the ERA account exactly as era is measured from the
 * prestige account. Pure integer-ish addition, so it is order-independent and reproducible.
 * Defensive: a state with no `era` scores 0. (The dynasty reset wipes the era account, so
 * the score collapses to 0 immediately after a Nowa Dynastia — DP is earned by rebuilding
 * the era account again.)
 */
export function dynastyScore(state: GameState): number {
  const era = state.era
  if (!era) return 0
  let score = 0
  if (typeof era.totalEarned === 'number' && Number.isFinite(era.totalEarned)) {
    score += era.totalEarned
  }
  if (typeof era.eras === 'number' && Number.isFinite(era.eras)) {
    score += era.eras * DYN_ERA_WEIGHT
  }
  const nodes = era.nodes ?? {}
  for (const lvl of Object.values(nodes)) {
    if (typeof lvl === 'number' && Number.isFinite(lvl) && lvl > 0) score += lvl
  }
  return score
}

/**
 * DP awarded for founding a Nowa Dynastia RIGHT NOW: `floor(cbrt(dynastyScore) * DP_SCALE)`,
 * always >= 0 (0 only when there is no era progress to bank). The cube root makes each
 * successive dynasty worth proportionally less per unit of raw era progress — DP is the rare,
 * top-most-tier currency.
 */
export function pendingDynastyPoints(state: GameState): number {
  const score = dynastyScore(state)
  if (!(score > 0)) return 0
  return Math.floor(Math.cbrt(score) * DP_SCALE)
}

/** Purchased level of dynasty node `id` (absent / non-positive / non-finite = 0). */
export function dynastyNodeLevel(state: GameState, id: string): number {
  const nodes = state.dynasty ? state.dynasty.nodes : {}
  const level = nodes[id]
  return typeof level === 'number' && Number.isFinite(level) && level > 0 ? level : 0
}

/** True when every prerequisite of `id` is owned at level >= 1 (or it has none). */
function dynastyPrereqsMet(state: GameState, id: string): boolean {
  const node = DYNASTY_NODES[id]
  if (!node) return false
  for (const pre of node.prerequisites) {
    if (dynastyNodeLevel(state, pre) < 1) return false
  }
  return true
}

/** True when `id` is unlockable AND not yet maxed (prereqs met, level < maxLevel). */
export function dynastyNodeAvailable(state: GameState, id: string): boolean {
  const node = DYNASTY_NODES[id]
  if (!node) return false
  if (dynastyNodeLevel(state, id) >= node.maxLevel) return false
  return dynastyPrereqsMet(state, id)
}

/**
 * DP cost of the `level` -> `level + 1` step of `id`: `ceil(baseCost * costFactor^level)`.
 * A plain number (DP is not on Decimal — node levels are bounded by maxLevel <= 10, far
 * within Number range) and rounded UP so a level never costs less than its formula (mirrors
 * eraNodeCost). Unknown `id` -> 0.
 */
export function dynastyNodeCost(id: string, level: number): number {
  const node = DYNASTY_NODES[id]
  if (!node) return 0
  return Math.ceil(node.baseCost * Math.pow(node.costFactor, level))
}

/**
 * Whether the next level of `id` can be bought right now, with a UI-facing `reason` when
 * not: the node must exist, not be maxed, have its prerequisites met, and the banked DP must
 * cover {@link dynastyNodeCost} of the current level.
 */
export function canPurchaseDynasty(
  state: GameState,
  id: string,
): { ok: boolean; reason?: string } {
  const node = DYNASTY_NODES[id]
  if (!node) return { ok: false, reason: 'Nieznany węzeł' }

  const level = dynastyNodeLevel(state, id)
  if (level >= node.maxLevel) return { ok: false, reason: 'Poziom maksymalny' }
  if (!dynastyPrereqsMet(state, id)) return { ok: false, reason: 'Wymagania niespełnione' }

  const cost = dynastyNodeCost(id, level)
  const points = state.dynasty ? state.dynasty.points : 0
  if (!(points >= cost)) return { ok: false, reason: 'Za mało punktów dynastii' }
  return { ok: true }
}

/**
 * Buy one level of `id`. Returns false (no mutation) when {@link canPurchaseDynasty} fails.
 * Otherwise deducts the DP, bumps the node level by one, then calls `recomputeDerived` so the
 * fresh PERMANENT multiplier folds into every village's derived stats immediately. Returns
 * true.
 */
export function purchaseDynasty(state: GameState, id: string): boolean {
  if (!canPurchaseDynasty(state, id).ok) return false

  const level = dynastyNodeLevel(state, id)
  const cost = dynastyNodeCost(id, level)

  state.dynasty.points -= cost
  state.dynasty.nodes[id] = level + 1
  recomputeDerived(state)
  return true
}

/**
 * NOWA DYNASTIA: bank the pending DP and perform THE GREAT-GREAT RESET — the dynasty account
 * survives, the era AND prestige accounts do NOT.
 *
 * No-op (returns 0, NO mutation) when {@link pendingDynastyPoints} is 0, so the player can
 * never throw away their era progress for nothing. Otherwise:
 *  - bank `dp`: `dynasty.points += dp`, `dynasty.totalEarned += dp`, `dynasty.dynasties += 1`;
 *  - WIPE the entire era account: `era = { points:0, totalEarned:0, eras:0, nodes:{} }`;
 *  - WIPE the entire prestige account: `prestige = { points:0, totalEarned:0, ascensions:0,
 *    nodes:{} }`;
 *  - rebuild the run from a per-dynasty seed `seed + ':dyn' + dynasties` (DETERMINISTIC): a
 *    single fresh capital at the world centre, the barbarian world regenerated from that
 *    seed, and `rngState` reset to `RNG.fromString(thatSeed)`;
 *  - clear the transient run state: `tech = {}`, `battleLog = []`;
 *  - apply the PERMANENT dynasty head-start: `+dynastyStartResourceBonus` to EACH resource of
 *    the new capital (read from the surviving dynasty nodes).
 *
 * `dynasty.nodes/points/totalEarned/dynasties` PERSIST, and so do `stats` / `achievements`
 * (the lifetime career record). `seed`, `createdAt` and `lastSeen` are left untouched —
 * `newDynasty` takes no clock, so it stays fully deterministic (no Date) and the base run
 * seed is stable across dynasties. Returns the DP awarded.
 */
export function newDynasty(state: GameState): number {
  const dp = pendingDynastyPoints(state)
  if (dp <= 0) return 0

  state.dynasty.points += dp
  state.dynasty.totalEarned += dp
  state.dynasty.dynasties += 1

  // The great-great reset wipes the ENTIRE era account AND the ENTIRE prestige account.
  state.era = { points: 0, totalEarned: 0, eras: 0, nodes: {} }
  state.prestige = { points: 0, totalEarned: 0, ascensions: 0, nodes: {} }

  // Per-dynasty seed: distinct world + rng stream each dynasty, fully reproducible.
  const dynSeed = state.seed + ':dyn' + state.dynasty.dynasties

  // Fresh single capital at the world centre (mirrors createInitialState's 'v0').
  const capital = createVillage('v0', 'Stolica', WORLD_CENTER.x, WORLD_CENTER.y)
  // Permanent head-start from the dynasty tree: +bonus to EACH starting resource.
  const bonus = dynastyStartResourceBonus(state)
  if (bonus > 0) {
    for (const r of RESOURCE_IDS) capital.resources[r] = capital.resources[r].add(bonus)
  }

  state.villages = { v0: capital }
  state.villageOrder = ['v0']
  state.world = generateWorld(dynSeed)
  state.rngState = RNG.fromString(dynSeed).getState()
  state.tech = {}
  // M15: clear the Kuźnia upgrade map alongside tech (same discipline as ascend / newEra). Unit
  // upgrades are a per-run sink bought with the capital's wood/clay/iron and gated by the per-run
  // Kuźnia building, which this fresh level-0 createVillage capital resets — leaving state.forge
  // intact would hand the new dynasty permanent ×mult upgrades for free, with a level-0 Kuźnia
  // (combat reads state.forge regardless of forgeLevel, so the stale levels would still apply).
  state.forge = {}
  state.battleLog = []
  // Re-arm the GLOBAL horde schedule too (M7.2), exactly as createInitialState seeds it: a
  // fresh, defenceless capital must meet a fresh horde clock (timer re-armed, escalation
  // level back to 0). Otherwise the accumulated escalation would wipe the level-1 capital.
  state.horde = { timer: HORDE_INTERVAL, level: 0 }
  // Re-seed the GLOBAL world-events schedule too (M13), mirroring the horde re-arm AND the
  // combat-stream re-seed above: each dynasty gets a fresh, idle event clock whose RNG stream is
  // reproducible from THIS dynasty's own seed (`dynSeed + '::events'`, the same per-run seed
  // family as `rngState`). Without this a stale offer would survive the great-great reset into a
  // free windfall once the player rebuilds the watchtower, and the events stream would be the lone
  // source of randomness not replayable from the per-run seed.
  state.events = {
    rngState: RNG.fromString(dynSeed + '::events').getState(),
    timer: EVENT_INTERVAL,
    active: null,
    // M14: a fresh dynasty starts with no timed buff in force.
    buff: null,
  }

  // Reconcile derived stats with the surviving dynasty multipliers (era + prestige empty).
  recomputeDerived(state)
  return dp
}

// --- harness / validation helpers (static topology checks, no GameState) -------

/**
 * True if the prerequisite graph contains a cycle (it must NOT — the tree is a DAG).
 * White/gray/black DFS over {@link DYNASTY_NODE_IDS}; a back-edge to a GRAY node is a cycle.
 * Unknown prereq ids are ignored (caught by {@link orphanDynastyNodes}).
 */
export function dynastyHasCycle(): boolean {
  const WHITE = 0
  const GRAY = 1
  const BLACK = 2
  const color: Record<string, number> = {}
  for (const id of DYNASTY_NODE_IDS) color[id] = WHITE
  let cycle = false

  const visit = (id: string): void => {
    if (cycle) return
    color[id] = GRAY
    for (const pre of DYNASTY_NODES[id].prerequisites) {
      if (!(pre in color)) continue // unknown id: not a real edge in this graph
      if (color[pre] === GRAY) {
        cycle = true
        return
      }
      if (color[pre] === WHITE) visit(pre)
    }
    color[id] = BLACK
  }

  for (const id of DYNASTY_NODE_IDS) {
    if (color[id] === WHITE) visit(id)
    if (cycle) break
  }
  return cycle
}

/**
 * Node ids NOT reachable from {@link DYNASTY_ROOTS} by following prerequisite edges in the
 * unlock direction (prereq -> dependent). Empty means every node is purchasable via some
 * path from a root. Returned in stable {@link DYNASTY_NODE_IDS} order.
 */
export function orphanDynastyNodes(): string[] {
  const children: Record<string, string[]> = {}
  for (const id of DYNASTY_NODE_IDS) children[id] = []
  for (const id of DYNASTY_NODE_IDS) {
    for (const pre of DYNASTY_NODES[id].prerequisites) {
      if (pre in children) children[pre].push(id)
    }
  }

  const reachable = new Set<string>()
  const stack: string[] = []
  for (const r of DYNASTY_ROOTS) {
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

  return DYNASTY_NODE_IDS.filter((id) => !reachable.has(id))
}

/**
 * Node ids with no real effect — a missing effect, or `perLevel <= 0` on a magnitude-bearing
 * kind (a "dead perk"). The binary `automation_unlock` gateway has NO `perLevel` yet is a
 * real effect, so it is NOT counted dead. Empty means every node grants a bonus when levelled.
 * Stable {@link DYNASTY_NODE_IDS} order.
 */
export function deadDynastyNodes(): string[] {
  return DYNASTY_NODE_IDS.filter((id) => {
    const effect = DYNASTY_NODES[id].effect
    if (!effect) return true
    if (effect.kind === 'automation_unlock') return false // binary gate is a real effect
    return typeof effect.perLevel !== 'number' || effect.perLevel <= 0
  })
}
