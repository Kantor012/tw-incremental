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
import { aggregateTechMods } from './tech'
import { generateWorld, WORLD_CENTER } from './world'
import { PRESTIGE_NODES, PRESTIGE_NODE_IDS, PRESTIGE_ROOTS } from '../content/prestige'
// VALUE import of the era (M6.1) roll-ups — used ONLY inside function bodies below
// (`effectiveMods`, `pendingPrestigePoints`, `ascend`), never at module top level, so
// the systems/era.ts <-> here cycle stays benign exactly like the state.ts edge above:
// by the time any of these run, both modules are fully evaluated. era.ts does NOT import
// back from this module, so this is the single direction of the edge. The era bag
// COMBINES onto the tech × prestige bag (so all three trees fold into derived stats),
// `eraPpMult` scales PP gain, and `eraStartResourceBonus` extends the run head-start.
import { aggregateEraMods, eraPpMult, eraStartResourceBonus } from './era'
// VALUE import of the dynasty (M6.2) roll-ups — used ONLY inside function bodies below
// (`effectiveMods`, `ascend`), never at module top level, so the systems/dynasty.ts <->
// here cycle stays benign exactly like the era edge above: by the time any of these run,
// both modules are fully evaluated. dynasty.ts does NOT import back from this module, so
// this is the single direction of the edge. The dynasty bag COMBINES onto the tech ×
// prestige × era bag (so all four trees fold into derived stats, and its
// `automation_unlock` gateway is the one place automations are unlocked), and
// `dynastyStartResourceBonus` extends the run head-start.
import { aggregateDynastyMods, dynastyStartResourceBonus } from './dynasty'
// VALUE import of the challenge (M8) roll-up — used ONLY inside the body of `effectiveMods`
// below, never at module top level, so the systems/challenges.ts <-> here cycle stays benign
// exactly like the era/dynasty edges above: by the time it runs, both modules are fully
// evaluated. challenges.ts value-imports `prestigeScore` back from this module (its goal
// metric), the single edge back. The challenge bag COMBINES onto the tech × prestige × era ×
// dynasty bag — IDENTITY when no challenge is active and none completed, so a no-challenge
// save folds to exactly the pre-M8 value (every earlier balance target stays byte-identical).
import { aggregateChallengeMods } from './challenges'
// VALUE import of the M14 event-buff roll-up — the SIXTH and final source folded into
// effectiveMods. Used ONLY inside the body of `effectiveMods` below (never at module top level),
// so this is safe from an initialisation cycle. The edge is SINGLE-direction: systems/events.ts
// imports types/values from state.ts and content/events.ts but NOTHING from this module, so there
// is no cycle to keep benign. The buff bag is IDENTITY whenever no buff is in force (or no
// watchtower), so a buff-free run folds to exactly the pre-M14 value — byte-identical.
import { aggregateEventBuffMods } from './events'

/**
 * Prestige (ascension) engine (M4.1) — the PERMANENT meta-layer on top of tech.
 *
 * Pure functions over a {@link GameState} + the {@link PRESTIGE_NODES} catalogue;
 * Node-safe (no DOM, no clock, no Math.random — the only RNG is the seeded
 * {@link RNG}), so the sim and tests can drive it headless and reproducibly. Adding
 * or rebalancing a node is an edit to src/content/prestige.ts — never to this file.
 *
 * Three responsibilities:
 *  1. EFFECT roll-up. {@link aggregatePrestigeMods} folds every purchased prestige
 *     node's MULTIPLICATIVE effect into a {@link TechModifiers} bag (same shape as the
 *     tech bag). {@link effectiveMods} then {@link combine}s that with the tech bag —
 *     this is the single value state.ts imports and calls inside `recomputeDerived`,
 *     so BOTH trees fold into every village's derived stats. The prestige-only
 *     `start_resources` kind is NOT a multiplier; it is summed by
 *     {@link startResourceBonus} and applied to the capital by {@link ascend}.
 *  2. PURCHASE. Nodes cost PRESTIGE POINTS (PP), a plain number banked on
 *     {@link GameState.prestige}. {@link purchasePrestige} spends PP, bumps the node
 *     level and re-derives every village so the new (permanent) multiplier takes effect.
 *  3. ASCENSION. {@link ascend} banks {@link pendingPrestigePoints} and RESETS the run
 *     deterministically (fresh capital, regenerated world + rng from a per-ascension
 *     seed, cleared tech/log) while the prestige account (points, totals, node levels)
 *     SURVIVES — and applies the permanent start-resource head-start to the new capital.
 *
 * Determinism: every order-sensitive pass iterates {@link PRESTIGE_NODE_IDS} (stable
 * source order); the reset draws world + rngState from `seed + ':asc' + N`, so a run is
 * byte-identical across replays. The PP curve is integer arithmetic over a sqrt of the
 * progress score, so it never depends on float-iteration order.
 *
 * Import discipline (cycle note, mirrors systems/tech.ts): state.ts value-imports
 * {@link effectiveMods} from here, and this module value-imports `recomputeDerived` /
 * `createVillage` / `RESOURCE_IDS` back from state.ts — a benign 2-way edge, because
 * every cross-module value is referenced ONLY inside a function BODY (never at module
 * top level): `effectiveMods` runs only inside `recomputeDerived`, and the state.ts
 * values here run only inside `purchasePrestige` / `ascend`. All exports are hoisted
 * `function` declarations, so by the time any of them runs both modules are fully
 * evaluated regardless of load order. `aggregateTechMods` (systems/tech), the seeded
 * {@link RNG}, `generateWorld` (systems/world) and the pure-data prestige catalogue add
 * no edge back into this module.
 */

/**
 * Global PP yield scale. `pendingPrestigePoints = floor(sqrt(score) * PP_SCALE)`.
 * Tuned so a first ascension lands within reach in a reasonable session (a built-up
 * capital scores ~60-120 → ~8-11 PP, enough for several root levels at baseCost 1),
 * while the sqrt keeps later yields sub-linear so prestige never trivialises a run.
 * The single PP balance knob (the Balance phase / sim tunes it here).
 */
export const PP_SCALE = 1

/** Clamp `x` into the inclusive range [lo, hi]. */
function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x
}

/**
 * Roll up the purchased prestige nodes into a {@link TechModifiers} bag — same shape
 * as the tech bag, so {@link combine} can fold the two. Iterates
 * {@link PRESTIGE_NODE_IDS} (stable order) and ignores any unknown / non-positive /
 * non-finite key, so the result is fully deterministic and robust to a stray key.
 *
 * Per kind it sums `effect.perLevel * level` into the matching field: the eight global
 * multiplicative kinds become a `1 + Σ` factor (production applies to ALL resources —
 * there is no resource-specific prestige variant), and the three reductions become a
 * FRACTION clamped to the combine caps (cost 0.9, recruit/march 0.75). The
 * prestige-only `start_resources` kind is NOT a multiplier and is skipped here (see
 * {@link startResourceBonus}).
 */
export function aggregatePrestigeMods(nodes: Record<string, number>): TechModifiers {
  const productionMult: Record<ResourceId, number> = { wood: 1, clay: 1, iron: 1 }
  let storageMult = 1
  let popMult = 1
  let costReduction = 0
  let recruitSpeedFrac = 0
  let marchSpeedFrac = 0
  let attackSum = 0
  let defenseSum = 0
  let lootSum = 0

  for (const id of PRESTIGE_NODE_IDS) {
    const level = nodes[id]
    if (!(typeof level === 'number') || !Number.isFinite(level) || level <= 0) continue
    const effect = PRESTIGE_NODES[id].effect
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
        break // not a multiplier — consumed by startResourceBonus / ascend
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
    // Prestige does NOT unlock idle automations in v1 (M5.1) — that gate lives only on
    // the tech tree. Always false here; `combine` ORs it with the tech bag's flags.
    automations: { build: false, recruit: false, attack: false },
  }
}

/**
 * Fold the tech bag with the prestige bag into the EFFECTIVE multipliers consumed by
 * the whole simulation. Per CLAUDE.md / contract: the MULTIPLIERS
 * (production/storage/pop/attack/defense/loot) MULTIPLY (1.2× tech × 1.1× prestige =
 * 1.32×), while the FRACTIONS (cost/recruit/march reductions) ADD and re-clamp (cost
 * to 0.9, recruit/march to 0.75) so the two trees stack without ever making builds free
 * or marches instant.
 */
function combine(tech: TechModifiers, prestige: TechModifiers): TechModifiers {
  const productionMult: Record<ResourceId, number> = { wood: 1, clay: 1, iron: 1 }
  for (const r of RESOURCE_IDS) {
    productionMult[r] = tech.productionMult[r] * prestige.productionMult[r]
  }
  return {
    productionMult,
    storageMult: tech.storageMult * prestige.storageMult,
    popMult: tech.popMult * prestige.popMult,
    costReduction: clamp(tech.costReduction + prestige.costReduction, 0, 0.9),
    recruitSpeedFrac: clamp(tech.recruitSpeedFrac + prestige.recruitSpeedFrac, 0, 0.75),
    marchSpeedFrac: clamp(tech.marchSpeedFrac + prestige.marchSpeedFrac, 0, 0.75),
    attackMult: tech.attackMult * prestige.attackMult,
    defenseMult: tech.defenseMult * prestige.defenseMult,
    lootMult: tech.lootMult * prestige.lootMult,
    // Automation unlocks are a GATE, not a magnitude: OR the two bags so a routine is
    // unlocked when EITHER tree unlocks it (prestige is all-false in v1, so this is the
    // tech bag today, but the OR keeps it correct if prestige ever grants an unlock).
    automations: {
      build: tech.automations.build || prestige.automations.build,
      recruit: tech.automations.recruit || prestige.automations.recruit,
      attack: tech.automations.attack || prestige.automations.attack,
    },
  }
}

/**
 * The EFFECTIVE global multipliers = the tech bag COMBINED with the prestige bag. The
 * single call site is `recomputeDerived` (state.ts), inside its function body. Both
 * sub-maps are read defensively (a partial/hand-edited state with no `tech` / `prestige`
 * folds to the identity bag rather than throwing).
 */
export function effectiveMods(state: GameState): TechModifiers {
  const techMods = aggregateTechMods(state.tech ?? {})
  const prestigeNodes = state.prestige ? state.prestige.nodes : {}
  const eraNodes = state.era ? state.era.nodes : {}
  const dynastyNodes = state.dynasty ? state.dynasty.nodes : {}
  // Fold all FOUR trees plus the M8 challenge bag plus the M14 event-buff bag:
  // ((((tech × prestige) × era) × dynasty) × challenge) × buff. `combine(x, identityBag) === x`
  // byte-for-byte, and aggregateEraMods({}) / aggregateDynastyMods({}) / aggregateChallengeMods(
  // no-challenge state) / aggregateEventBuffMods(no-buff state) ARE the identity bag, so a
  // no-era / no-dynasty / no-challenge / no-buff save folds to exactly the pre-M6.x / pre-M8 /
  // pre-M14 value — the earlier balance targets stay byte-identical. The dynasty bag is the ONLY
  // one whose `automation_unlock` gateway can set the automation flags true (combine ORs them);
  // the challenge and buff bags' automations are always false. The challenge and buff bags are
  // read off the WHOLE state (the buff off events.buff, which is null without a watchtower), not a
  // node sub-map like the others. The buff is the only TEMPORARY source — it appears/vanishes on
  // the tick grid, and the tick re-aggregates `mods` on its expiry signal (see tick.ts).
  return combine(
    combine(
      combine(
        combine(combine(techMods, aggregatePrestigeMods(prestigeNodes)), aggregateEraMods(eraNodes)),
        aggregateDynastyMods(dynastyNodes),
      ),
      aggregateChallengeMods(state),
    ),
    aggregateEventBuffMods(state),
  )
}

/**
 * Deterministic measure of run progress, driving the PP yield. Sums every village's
 * building levels + every purchased tech level + `villageCount * 8` (so founding /
 * conquering a village — which also brings its own buildings — meaningfully rewards
 * military play). Pure integer addition, so it is order-independent and reproducible.
 */
export function prestigeScore(state: GameState): number {
  let score = 0
  for (const vid of state.villageOrder) {
    const v = state.villages[vid]
    if (!v) continue
    for (const lvl of Object.values(v.buildings)) {
      if (typeof lvl === 'number' && Number.isFinite(lvl) && lvl > 0) score += lvl
    }
  }
  for (const lvl of Object.values(state.tech)) {
    if (typeof lvl === 'number' && Number.isFinite(lvl) && lvl > 0) score += lvl
  }
  score += state.villageOrder.length * 8
  return score
}

/**
 * PP awarded for ascending RIGHT NOW: `floor(sqrt(prestigeScore) * PP_SCALE)`, always
 * >= 0 (0 only when there is no progress to bank). The sqrt makes each successive
 * ascension worth proportionally less per unit of raw progress — the classic prestige
 * curve — so resetting stays rewarding without runaway compounding.
 */
export function pendingPrestigePoints(state: GameState): number {
  const score = prestigeScore(state)
  if (!(score > 0)) return 0
  // The era tree's signature `pp_mult` (M6.1) scales the whole yield, so each new era
  // accelerates the prestige loop. With no era nodes `eraPpMult` is 1, a no-op.
  return Math.floor(Math.sqrt(score) * PP_SCALE * eraPpMult(state))
}

/**
 * Total starter resources granted to the capital at the start of a fresh run: the sum
 * of `start_resources.perLevel * level` over every purchased prestige node. Applied to
 * EACH resource by {@link ascend}. Permanent (read from the surviving prestige nodes),
 * so a deeper prestige tree means a faster restart every time.
 */
export function startResourceBonus(state: GameState): number {
  const nodes = state.prestige ? state.prestige.nodes : {}
  let bonus = 0
  for (const id of PRESTIGE_NODE_IDS) {
    const level = nodes[id]
    if (!(typeof level === 'number') || !Number.isFinite(level) || level <= 0) continue
    const effect = PRESTIGE_NODES[id].effect
    if (effect.kind === 'start_resources') bonus += effect.perLevel * level
  }
  return bonus
}

/** Purchased level of prestige node `id` (absent / non-positive / non-finite = 0). */
export function prestigeNodeLevel(state: GameState, id: string): number {
  const nodes = state.prestige ? state.prestige.nodes : {}
  const level = nodes[id]
  return typeof level === 'number' && Number.isFinite(level) && level > 0 ? level : 0
}

/** True when every prerequisite of `id` is owned at level >= 1 (or it has none). */
function prestigePrereqsMet(state: GameState, id: string): boolean {
  const node = PRESTIGE_NODES[id]
  if (!node) return false
  for (const pre of node.prerequisites) {
    if (prestigeNodeLevel(state, pre) < 1) return false
  }
  return true
}

/** True when `id` is unlockable AND not yet maxed (prereqs met, level < maxLevel). */
export function prestigeNodeAvailable(state: GameState, id: string): boolean {
  const node = PRESTIGE_NODES[id]
  if (!node) return false
  if (prestigeNodeLevel(state, id) >= node.maxLevel) return false
  return prestigePrereqsMet(state, id)
}

/**
 * PP cost of the `level` -> `level + 1` step of `id`: `ceil(baseCost * costFactor^level)`.
 * A plain number (PP is not on Decimal — node levels are bounded by maxLevel <= 10, far
 * within Number range) and rounded UP so a level never costs less than its formula
 * (mirrors techCost). Unknown `id` -> 0.
 */
export function prestigeNodeCost(id: string, level: number): number {
  const node = PRESTIGE_NODES[id]
  if (!node) return 0
  return Math.ceil(node.baseCost * Math.pow(node.costFactor, level))
}

/**
 * Whether the next level of `id` can be bought right now, with a UI-facing `reason`
 * when not: the node must exist, not be maxed, have its prerequisites met, and the
 * banked PP must cover {@link prestigeNodeCost} of the current level.
 */
export function canPurchasePrestige(
  state: GameState,
  id: string,
): { ok: boolean; reason?: string } {
  const node = PRESTIGE_NODES[id]
  if (!node) return { ok: false, reason: 'Nieznany węzeł' }

  const level = prestigeNodeLevel(state, id)
  if (level >= node.maxLevel) return { ok: false, reason: 'Poziom maksymalny' }
  if (!prestigePrereqsMet(state, id)) return { ok: false, reason: 'Wymagania niespełnione' }

  const cost = prestigeNodeCost(id, level)
  const points = state.prestige ? state.prestige.points : 0
  if (!(points >= cost)) return { ok: false, reason: 'Za mało punktów prestiżu' }
  return { ok: true }
}

/**
 * Buy one level of `id`. Returns false (no mutation) when {@link canPurchasePrestige}
 * fails. Otherwise deducts the PP, bumps the node level by one, then calls
 * `recomputeDerived` so the fresh PERMANENT multiplier folds into every village's
 * derived stats immediately. Returns true.
 */
export function purchasePrestige(state: GameState, id: string): boolean {
  if (!canPurchasePrestige(state, id).ok) return false

  const level = prestigeNodeLevel(state, id)
  const cost = prestigeNodeCost(id, level)

  state.prestige.points -= cost
  state.prestige.nodes[id] = level + 1
  recomputeDerived(state)
  return true
}

/**
 * ASCEND: bank the pending PP and RESET the run — the prestige account survives.
 *
 * No-op (returns 0, NO mutation) when {@link pendingPrestigePoints} is 0, so the player
 * can never throw away a run for nothing. Otherwise:
 *  - bank `pp`: `prestige.points += pp`, `totalEarned += pp`, `ascensions += 1`;
 *  - rebuild the run from a per-ascension seed `seed + ':asc' + ascensions`
 *    (DETERMINISTIC): a single fresh capital at the world centre, the barbarian world
 *    regenerated from that seed, and `rngState` reset to `RNG.fromString(thatSeed)`;
 *  - clear the transient run state: `tech = {}`, `battleLog = []`;
 *  - apply the PERMANENT head-start: `+startResourceBonus + eraStartResourceBonus` to
 *    EACH resource of the new capital (read from the surviving prestige + era nodes);
 *  - `recomputeDerived` so derived stats reflect the surviving prestige multipliers.
 *
 * `prestige.nodes/points/totalEarned/ascensions` PERSIST. `seed`, `createdAt` and
 * `lastSeen` are left untouched — `ascend` takes no clock, so it stays fully
 * deterministic (no Date) and the base run seed is stable across ascensions. Returns
 * the PP awarded.
 */
export function ascend(state: GameState): number {
  const pp = pendingPrestigePoints(state)
  if (pp <= 0) return 0

  state.prestige.points += pp
  state.prestige.totalEarned += pp
  state.prestige.ascensions += 1

  // Per-ascension seed: distinct world + rng stream each run, fully reproducible.
  const ascSeed = state.seed + ':asc' + state.prestige.ascensions

  // Fresh single capital at the world centre (mirrors createInitialState's 'v0').
  const capital = createVillage('v0', 'Stolica', WORLD_CENTER.x, WORLD_CENTER.y)
  // Permanent head-start from ALL THREE meta-trees: the prestige start-resources plus the
  // era (M6.1) and dynasty (M6.2) start-resources, so a deeper era / dynasty tree speeds up
  // every ordinary ascension too. With no era / dynasty nodes both bonuses are 0, so a
  // pre-M6.x run is unchanged.
  const bonus =
    startResourceBonus(state) + eraStartResourceBonus(state) + dynastyStartResourceBonus(state)
  if (bonus > 0) {
    for (const r of RESOURCE_IDS) capital.resources[r] = capital.resources[r].add(bonus)
  }

  state.villages = { v0: capital }
  state.villageOrder = ['v0']
  state.world = generateWorld(ascSeed)
  state.rngState = RNG.fromString(ascSeed).getState()
  state.tech = {}
  state.battleLog = []
  // Re-arm the GLOBAL horde schedule too (M7.2): a fresh, defenceless capital must meet a
  // fresh horde clock — re-arm the timer AND reset the escalation level to 0, exactly as
  // createInitialState seeds it. Without this the previous run's escalation (level) would
  // bear down on a level-1 capital with no garrison, a guaranteed-breach wipe (the threat
  // scales with the level, the defence with the now-wiped progress).
  state.horde = { timer: HORDE_INTERVAL, level: 0 }
  // Re-seed the GLOBAL world-events schedule too (M13), mirroring the horde re-arm AND the
  // combat-stream re-seed above: a fresh run gets a fresh, idle event clock whose RNG stream
  // is reproducible from THIS ascension's own seed (`ascSeed + '::events'`, the same per-run
  // seed family as `rngState`). Without this a stale offer (active != null) would survive the
  // reset and become a free windfall the moment the player rebuilds the watchtower, and the
  // events stream would be the one source of randomness NOT replayable from the per-run seed.
  state.events = {
    rngState: RNG.fromString(ascSeed + '::events').getState(),
    timer: EVENT_INTERVAL,
    active: null,
    // M14: a fresh ascension starts with no timed buff in force.
    buff: null,
  }

  // Reconcile derived stats with the surviving prestige multipliers.
  recomputeDerived(state)
  return pp
}

// --- harness / validation helpers (static topology checks, no GameState) -------

/**
 * True if the prerequisite graph contains a cycle (it must NOT — the tree is a DAG).
 * White/gray/black DFS over {@link PRESTIGE_NODE_IDS}; a back-edge to a GRAY node is a
 * cycle. Unknown prereq ids are ignored (caught by {@link orphanPrestigeNodes}).
 */
export function prestigeHasCycle(): boolean {
  const WHITE = 0
  const GRAY = 1
  const BLACK = 2
  const color: Record<string, number> = {}
  for (const id of PRESTIGE_NODE_IDS) color[id] = WHITE
  let cycle = false

  const visit = (id: string): void => {
    if (cycle) return
    color[id] = GRAY
    for (const pre of PRESTIGE_NODES[id].prerequisites) {
      if (!(pre in color)) continue // unknown id: not a real edge in this graph
      if (color[pre] === GRAY) {
        cycle = true
        return
      }
      if (color[pre] === WHITE) visit(pre)
    }
    color[id] = BLACK
  }

  for (const id of PRESTIGE_NODE_IDS) {
    if (color[id] === WHITE) visit(id)
    if (cycle) break
  }
  return cycle
}

/**
 * Node ids NOT reachable from {@link PRESTIGE_ROOTS} by following prerequisite edges in
 * the unlock direction (prereq -> dependent). Empty means every node is purchasable via
 * some path from a root. Returned in stable {@link PRESTIGE_NODE_IDS} order.
 */
export function orphanPrestigeNodes(): string[] {
  const children: Record<string, string[]> = {}
  for (const id of PRESTIGE_NODE_IDS) children[id] = []
  for (const id of PRESTIGE_NODE_IDS) {
    for (const pre of PRESTIGE_NODES[id].prerequisites) {
      if (pre in children) children[pre].push(id)
    }
  }

  const reachable = new Set<string>()
  const stack: string[] = []
  for (const r of PRESTIGE_ROOTS) {
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

  return PRESTIGE_NODE_IDS.filter((id) => !reachable.has(id))
}

/**
 * Node ids with no real effect — a missing effect or `perLevel <= 0` (a "dead perk").
 * Empty means every node grants a bonus when levelled. Stable {@link PRESTIGE_NODE_IDS}
 * order.
 */
export function deadPrestigeNodes(): string[] {
  return PRESTIGE_NODE_IDS.filter((id) => {
    const effect = PRESTIGE_NODES[id].effect
    return !effect || typeof effect.perLevel !== 'number' || effect.perLevel <= 0
  })
}
