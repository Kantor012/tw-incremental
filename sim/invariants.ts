import { D, ZERO, isFiniteDecimal, type Decimal } from '../src/engine/decimal'
import { serialize, deserialize } from '../src/engine/save'
import { simulate } from '../src/engine/tick'
import { applyOffline } from '../src/engine/offline'
import {
  createInitialState,
  recomputeDerived,
  RESOURCE_IDS,
  INITIAL_BUILDINGS,
  type GameState,
  type Stats,
  type Village,
  type World,
  type BarbarianVillage,
} from '../src/engine/state'
import { BUILDINGS, BUILDING_IDS } from '../src/content/buildings'
import { UNITS, UNIT_IDS, type UnitId } from '../src/content/units'
import { barbarianTarget, MAX_TARGET_LEVEL } from '../src/content/barbarians'
import { TECH_NODES, TECH_NODE_IDS, TECH_ROOTS } from '../src/content/tech'
import {
  PRESTIGE_NODES,
  PRESTIGE_NODE_IDS,
  PRESTIGE_ROOTS,
  type PrestigeArchetype,
} from '../src/content/prestige'
import { ACHIEVEMENT_IDS } from '../src/content/achievements'
import { checkAchievements } from '../src/systems/achievements'
import { freePopulation, recruit } from '../src/systems/recruitment'
import { sendAttack, sendScout } from '../src/systems/marches'
import {
  armyAttackPower,
  battleOutcome,
  ramDefenseFactor,
  catapultLevelDamage,
  luckFactor,
  COMBAT_LUCK,
  WORST_LUCK,
  BEST_LUCK,
} from '../src/systems/combat'
import { autoAttackOnce } from '../src/systems/automation'
import { advanceRaids } from '../src/systems/raids'
import { RNG } from '../src/engine/rng'
import { villageDefenseMult } from '../src/systems/buildings'
import { WORLD_SIZE } from '../src/systems/world'
import { LOYALTY_MAX } from '../src/systems/conquest'
import {
  techHasCycle,
  orphanNodes,
  deadPerkNodes,
  nodeLevel,
  prerequisitesMet,
} from '../src/systems/tech'
import {
  effectiveMods,
  prestigeHasCycle,
  orphanPrestigeNodes,
  deadPrestigeNodes,
  prestigeNodeLevel,
} from '../src/systems/prestige'
import { layoutTree, techEdges, layoutNodes, nodeEdges } from '../src/systems/techLayout'
import { chooseAction } from './bot'

/**
 * Hard invariants asserted during and after a run. A single FAIL is a commit
 * blocker (see CLAUDE.md quality gates). Everything here is Node-safe: no DOM,
 * no clock reads, pure functions of the passed state.
 *
 * Since M2.1 the state is multi-village: the per-village checks (resources, army
 * consistency, no-softlock) iterate {@link GameState.villageOrder} and report a
 * single aggregated PASS/FAIL per check (the detail names the offending village),
 * while the GLOBAL battle log and the whole-state serialization checks (round-trip,
 * determinism, offline) stay state-wide. With the single M2.1 village every result
 * is identical to the old single-village harness.
 */
export interface InvariantResult {
  name: string
  ok: boolean
  detail?: string
}

/** The first (capital) village — the one the bot drives. */
function firstVillage(state: GameState): Village {
  return state.villages[state.villageOrder[0]]
}

/**
 * Deterministically pick a barbarian village of camp tier `level` from `world` — the
 * FIRST in generation order (ids are tier-ascending, so this is stable and identical
 * across both branches of a determinism check), falling back to the first village of
 * any tier if that exact level is absent. generateWorld always spawns >= 1 village per
 * tier 1..MAX, so the fallback never fires for an in-range level; it only guards a
 * hand-edited world. Used by the seeded combat tests below to target a CONCRETE camp
 * (M2.2) instead of an abstract level.
 */
function targetOfLevel(world: World, level: number): BarbarianVillage {
  return world.barbarians.find((b) => b.level === level) ?? world.barbarians[0]
}

/**
 * Resource-level sanity checks, aggregated over EVERY village in villageOrder:
 *  - every resource is a finite Decimal (no NaN / Infinity),
 *  - no resource is negative,
 *  - no resource exceeds that village's storage cap.
 * Each offending entry is reported as `<villageId>.<resource>`.
 */
export function runInvariants(state: GameState): InvariantResult[] {
  const nonFinite: string[] = []
  const negative: string[] = []
  const overCap: string[] = []

  for (const vid of state.villageOrder) {
    const v = state.villages[vid]
    for (const r of RESOURCE_IDS) {
      const res = v.resources[r]
      if (!isFiniteDecimal(res)) nonFinite.push(`${vid}.${r}`)
      if (res.lt(0)) negative.push(`${vid}.${r}=${res.toString()}`)
      if (res.gt(v.storageCap)) {
        overCap.push(`${vid}.${r}=${res.toString()} (cap ${v.storageCap.toString()})`)
      }
    }
  }

  return [
    {
      name: 'resources-finite',
      ok: nonFinite.length === 0,
      detail: nonFinite.length ? `non-finite: ${nonFinite.join(', ')}` : undefined,
    },
    {
      name: 'resources-non-negative',
      ok: negative.length === 0,
      detail: negative.length ? `negative: ${negative.join(', ')}` : undefined,
    },
    {
      name: 'resources-within-cap',
      ok: overCap.length === 0,
      detail: overCap.length ? `over cap: ${overCap.join(', ')}` : undefined,
    },
  ]
}

/**
 * Army / combat-state structural invariants (M1.3), checked PER VILLAGE over
 * villageOrder and aggregated. A single FAIL is a commit blocker: it means a battle,
 * march or raid corrupted a village's roster or an in-transit army. Per village:
 *  - every owned unit count is a finite non-negative integer,
 *  - every march is well-formed: integer targetLevel >= 1, finite remaining >= 0,
 *    finite non-negative integer per-type counts,
 *  - NO PHANTOM UNITS: the units committed to that village's marches never exceed its
 *    owned roster (Σ march.units[id] <= village.units[id]) — an army on the road is
 *    always a subset of what the village owns, so units cannot be sent twice or
 *    conjured, and home = owned − away stays non-negative,
 *  - raidTimer is a finite non-negative number.
 *
 * This is the "units do not vanish / appear inconsistently" guard: every count
 * change must flow through recruitment (mint), casualties (battle/raid) — loot is
 * resources, never units — and this snapshot proves the books balance in EVERY
 * village. Each issue is prefixed with the village id.
 */
export function checkArmyConsistency(state: GameState): InvariantResult {
  const issues: string[] = []

  for (const vid of state.villageOrder) {
    const v = state.villages[vid]

    const onMarch = {} as Record<UnitId, number>
    for (const id of UNIT_IDS) onMarch[id] = 0

    for (const id of UNIT_IDS) {
      const n = v.units[id]
      if (!Number.isInteger(n) || n < 0) issues.push(`${vid}.units.${id}=${n}`)
    }

    for (const m of v.marches) {
      if (!Number.isFinite(m.remaining) || m.remaining < 0) {
        issues.push(`${vid}.march.remaining=${m.remaining}`)
      }
      if (!Number.isInteger(m.targetLevel) || m.targetLevel < 1) {
        issues.push(`${vid}.march.targetLevel=${m.targetLevel}`)
      }
      // M2.2: a march carries a target id and SNAPSHOT coordinates (for the return
      // leg + drawn line). They must always be well-formed — a non-finite targetX/Y
      // would yield a NaN return-leg time and strand the army.
      if (typeof m.targetId !== 'string' || m.targetId.length === 0) {
        issues.push(`${vid}.march.targetId=${String(m.targetId)}`)
      }
      if (!Number.isFinite(m.targetX) || !Number.isFinite(m.targetY)) {
        issues.push(`${vid}.march.target=(${m.targetX},${m.targetY})`)
      }
      if (m.phase !== 'outbound' && m.phase !== 'returning') {
        issues.push(`${vid}.march.phase=${m.phase}`)
      }
      for (const id of UNIT_IDS) {
        const c = m.units[id]
        if (!Number.isInteger(c) || c < 0) issues.push(`${vid}.march.units.${id}=${c}`)
        else onMarch[id] += c
      }
    }

    for (const id of UNIT_IDS) {
      if (onMarch[id] > (v.units[id] ?? 0)) {
        issues.push(`${vid} phantom ${id}: on-march ${onMarch[id]} > owned ${v.units[id]}`)
      }
    }

    if (!Number.isFinite(v.raidTimer) || v.raidTimer < 0) {
      issues.push(`${vid}.raidTimer=${v.raidTimer}`)
    }
  }

  return {
    name: 'army-consistency',
    ok: issues.length === 0,
    detail: issues.length ? issues.join('; ') : undefined,
  }
}

/**
 * World structural invariants (M2.2). The seed-generated barbarian map must be sane
 * and serialize-stable, since marches target it by id and read it for travel time:
 *  - `world.barbarians` exists and is NON-EMPTY (there is always something to attack;
 *    an empty world would softlock the combat loop),
 *  - every entry has a non-empty string id, FINITE integer-or-float-but-finite x/y,
 *    and a camp tier in [1, MAX_TARGET_LEVEL] (so barbarianTarget never clamps it),
 *  - NO TWO villages share a map cell, AND no barbarian sits on a player village's
 *    cell — generateWorld reserves the capital and nudges collisions, so a duplicate
 *    would mean a generation/migration bug (and an ambiguous click target on the map).
 *
 * Static for a run (the world never changes after generation), but cheap to assert,
 * so the runner samples it like the other per-state checks; round-trip then proves it
 * survives save/load byte-identically.
 */
export function checkWorldConsistency(state: GameState): InvariantResult {
  const world: World | undefined = state.world
  if (world === undefined || !Array.isArray(world.barbarians)) {
    return {
      name: 'world-consistency',
      ok: false,
      detail: 'state.world missing or world.barbarians is not an array',
    }
  }

  const issues: string[] = []
  if (world.barbarians.length === 0) issues.push('no barbarian villages (combat loop would softlock)')

  const occupied = new Map<string, string>()
  // Reserve every player village's cell first, so a barbarian sharing it is flagged.
  for (const vid of state.villageOrder) {
    const v = state.villages[vid]
    occupied.set(v.x + ',' + v.y, vid)
  }

  for (const b of world.barbarians as BarbarianVillage[]) {
    if (typeof b.id !== 'string' || b.id.length === 0) issues.push(`bad id ${String(b.id)}`)
    if (!Number.isFinite(b.x) || !Number.isFinite(b.y)) {
      issues.push(`${b.id} non-finite coords (${b.x},${b.y})`)
    }
    if (!Number.isInteger(b.level) || b.level < 1 || b.level > MAX_TARGET_LEVEL) {
      issues.push(`${b.id} level=${b.level}`)
    }
    if (typeof b.name !== 'string' || b.name.length === 0) issues.push(`${b.id} empty name`)
    const key = b.x + ',' + b.y
    const prev = occupied.get(key)
    if (prev !== undefined) issues.push(`${b.id} shares cell ${key} with ${prev}`)
    occupied.set(key, b.id)
  }

  return {
    name: 'world-consistency',
    ok: issues.length === 0,
    detail: issues.length ? issues.join('; ') : undefined,
  }
}

/**
 * Player-village placement invariant (M2.3). Founding plants brand-new owned villages
 * on the map, so the empire's own footprint must stay sane exactly as the barbarian map
 * must (see {@link checkWorldConsistency}, which only guards the barbarian side and the
 * barbarian↔player overlap — it does NOT catch two OWNED villages colliding, because it
 * overwrites duplicate keys). Over villageOrder this asserts:
 *  - every village has FINITE INTEGER coordinates inside the map [0, WORLD_SIZE],
 *  - NO TWO owned villages share a map cell (a founded village must take a free tile),
 *  - NO owned village sits on a barbarian's cell (founding must avoid occupied tiles).
 *
 * Together with {@link canFound}'s spacing/range gates this proves the founding engine
 * never produces an ambiguous or overlapping settlement, however many villages a run
 * accumulates. Each offending entry names the village id.
 */
export function checkVillagePlacement(state: GameState): InvariantResult {
  const issues: string[] = []

  const owned = new Map<string, string>()
  for (const vid of state.villageOrder) {
    const v = state.villages[vid]
    if (!Number.isInteger(v.x) || !Number.isInteger(v.y)) {
      issues.push(`${vid} non-integer coords (${v.x},${v.y})`)
      continue
    }
    if (v.x < 0 || v.y < 0 || v.x > WORLD_SIZE || v.y > WORLD_SIZE) {
      issues.push(`${vid} off-map (${v.x},${v.y})`)
    }
    const key = v.x + ',' + v.y
    const prev = owned.get(key)
    if (prev !== undefined) issues.push(`${vid} shares cell ${key} with ${prev}`)
    else owned.set(key, vid)
  }

  for (const b of state.world.barbarians) {
    const hit = owned.get(b.x + ',' + b.y)
    if (hit !== undefined) issues.push(`${hit} shares cell ${b.x},${b.y} with barbarian ${b.id}`)
  }

  return {
    name: 'village-placement',
    ok: issues.length === 0,
    detail: issues.length ? issues.join('; ') : undefined,
  }
}

/**
 * Conquest-loyalty invariant (M2.4). Every barbarian village's `loyalty` must be a
 * FINITE number inside the [0, {@link LOYALTY_MAX}] band at every sample — the engine
 * clamps it on both ends (regen caps at LOYALTY_MAX in advanceWorldLoyalty; a noble hit
 * that drives it <= 0 is pinned to 0 and the camp captured in advanceMarches), so a
 * value outside the band, NaN or a non-number would mean the loyalty arithmetic or the
 * save round-trip corrupted it — which would mis-drive (or never fire) capture. Captured
 * camps are removed from `world.barbarians`, so only still-besieged camps are checked.
 * Each offending entry names the barbarian id.
 */
export function checkLoyalty(state: GameState): InvariantResult {
  const issues: string[] = []
  for (const b of state.world.barbarians) {
    if (typeof b.loyalty !== 'number' || !Number.isFinite(b.loyalty)) {
      issues.push(`${b.id}.loyalty=${String(b.loyalty)}`)
    } else if (b.loyalty < 0 || b.loyalty > LOYALTY_MAX) {
      issues.push(`${b.id}.loyalty=${b.loyalty} out of [0,${LOYALTY_MAX}]`)
    }
  }
  return {
    name: 'loyalty-range',
    ok: issues.length === 0,
    detail: issues.length ? issues.join('; ') : undefined,
  }
}

/**
 * Smallest centre-to-centre distance two DISTINCT node positions may have in the computed
 * layout before it counts as a "gross overlap". The radial layout keeps real neighbours
 * far apart (the measured minimum across the M3.1 tree is 64 layout units), so this
 * generous floor never false-fails the current data yet trips immediately if a topology /
 * algorithm change ever stacks two nodes on the same spot.
 */
const TECH_MIN_NODE_SEP = 24

/**
 * STATIC tech-tree invariants (M3.1) — pure functions of the {@link TECH_NODES} catalogue
 * + the computed {@link layoutTree}, independent of any {@link GameState}, so the runner
 * asserts them ONCE per run (like determinism) rather than per sample. A single FAIL is a
 * commit blocker: a malformed passive tree would mis-drive the whole tech economy and the
 * constellation view. Checks (each aggregated to one PASS/FAIL):
 *  - tech-acyclic:        the prerequisite graph is a DAG (no cycle) — {@link techHasCycle}.
 *  - tech-no-orphans:     every node is reachable from a {@link TECH_ROOTS} root via
 *                         prerequisite edges (nothing is unbuyable) — {@link orphanNodes}.
 *  - tech-no-dead-perks:  every node has a real effect with perLevel > 0 — {@link deadPerkNodes}.
 *  - tech-maxlevel-range: every maxLevel is an integer in [1, 10] (CLAUDE.md tree rule).
 *  - tech-archetype-band: maxLevel matches the archetype band (gateway 1 / notable 2-3 /
 *                         minor 7-10) — the authoring guard behind the level rule.
 *  - tech-roots:          TECH_ROOTS is non-empty and every root exists and truly has no
 *                         prerequisite (an always-available category entry).
 *  - tech-layout-complete: {@link layoutTree} returns a FINITE position for every node id.
 *  - tech-layout-no-overlap: no two distinct node centres are closer than
 *                         {@link TECH_MIN_NODE_SEP} (no gross overlap in the constellation).
 *  - tech-edges-valid:    every {@link techEdges} endpoint is a known node and the edge
 *                         count equals the total number of (known) prerequisite links.
 */
export function checkTechTree(): InvariantResult[] {
  const results: InvariantResult[] = []

  const cycle = techHasCycle()
  results.push({
    name: 'tech-acyclic',
    ok: !cycle,
    detail: cycle ? 'prerequisite graph contains a cycle (must be a DAG)' : undefined,
  })

  const orphans = orphanNodes()
  results.push({
    name: 'tech-no-orphans',
    ok: orphans.length === 0,
    detail: orphans.length ? `unreachable from roots: ${orphans.join(', ')}` : undefined,
  })

  const dead = deadPerkNodes()
  results.push({
    name: 'tech-no-dead-perks',
    ok: dead.length === 0,
    detail: dead.length ? `no effect / perLevel<=0: ${dead.join(', ')}` : undefined,
  })

  const badLevel: string[] = []
  const badBand: string[] = []
  for (const id of TECH_NODE_IDS) {
    const node = TECH_NODES[id]
    const m = node.maxLevel
    if (!Number.isInteger(m) || m < 1 || m > 10) badLevel.push(`${id}=${m}`)
    const okBand =
      node.archetype === 'gateway'
        ? m === 1
        : node.archetype === 'notable'
          ? m >= 2 && m <= 3
          : m >= 7 && m <= 10 // minor
    if (!okBand) badBand.push(`${id}(${node.archetype})=${m}`)
  }
  results.push({
    name: 'tech-maxlevel-range',
    ok: badLevel.length === 0,
    detail: badLevel.length ? `maxLevel out of [1,10]: ${badLevel.join(', ')}` : undefined,
  })
  results.push({
    name: 'tech-archetype-band',
    ok: badBand.length === 0,
    detail: badBand.length ? `maxLevel off archetype band: ${badBand.join(', ')}` : undefined,
  })

  const rootIssues: string[] = []
  if (TECH_ROOTS.length === 0) rootIssues.push('no roots')
  for (const id of TECH_ROOTS) {
    const node = TECH_NODES[id]
    if (!node) rootIssues.push(`unknown root ${id}`)
    else if (node.prerequisites.length > 0) rootIssues.push(`root ${id} has prerequisites`)
  }
  results.push({
    name: 'tech-roots',
    ok: rootIssues.length === 0,
    detail: rootIssues.length ? rootIssues.join('; ') : undefined,
  })

  // Layout: a finite position for every node, and no two centres grossly overlapping.
  const pos = layoutTree()
  const missing: string[] = []
  for (const id of TECH_NODE_IDS) {
    const p = pos[id]
    if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) missing.push(id)
  }
  results.push({
    name: 'tech-layout-complete',
    ok: missing.length === 0,
    detail: missing.length ? `no finite position for: ${missing.join(', ')}` : undefined,
  })

  let overlap: string | null = null
  let minDist = Infinity
  for (let i = 0; i < TECH_NODE_IDS.length && overlap === null; i++) {
    const a = pos[TECH_NODE_IDS[i]]
    if (!a) continue
    for (let j = i + 1; j < TECH_NODE_IDS.length; j++) {
      const b = pos[TECH_NODE_IDS[j]]
      if (!b) continue
      const d = Math.hypot(a.x - b.x, a.y - b.y)
      if (d < minDist) minDist = d
      if (d < TECH_MIN_NODE_SEP) {
        overlap = `${TECH_NODE_IDS[i]} & ${TECH_NODE_IDS[j]} only ${d.toFixed(1)} apart`
        break
      }
    }
  }
  results.push({
    name: 'tech-layout-no-overlap',
    ok: overlap === null,
    detail: overlap ?? undefined,
  })

  // Edges: every endpoint known, and the count matches the total prerequisite links.
  let expectedEdges = 0
  for (const id of TECH_NODE_IDS) {
    for (const pre of TECH_NODES[id].prerequisites) if (pre in TECH_NODES) expectedEdges += 1
  }
  const edges = techEdges()
  const badEdge = edges.find((e) => !(e.from in TECH_NODES) || !(e.to in TECH_NODES))
  const edgeOk = badEdge === undefined && edges.length === expectedEdges
  results.push({
    name: 'tech-edges-valid',
    ok: edgeOk,
    detail: edgeOk
      ? undefined
      : badEdge
        ? `edge with unknown endpoint ${badEdge.from}->${badEdge.to}`
        : `edge count ${edges.length} != prerequisite links ${expectedEdges}`,
  })

  return results
}

/**
 * Runtime tech-state invariant (M3.1), checked per sample like the resource / army guards.
 * The purchased-level map {@link GameState.tech} must stay structurally sound however the
 * bot buys and however the save round-trips:
 *  - it is an object,
 *  - every KEY is a known node id (no stray keys leak in),
 *  - every level is an INTEGER in [0, node.maxLevel] (a purchase never overshoots the
 *    ceiling, never goes negative, never turns fractional / NaN),
 *  - every OWNED node (level >= 1) has its prerequisites met — a node can never be bought
 *    out of order, so the unlock DAG is always respected in the live state.
 *
 * Pairs with resources-non-negative (which catches the greedy global spend ever driving a
 * village below 0): together they prove {@link import('../src/systems/tech').purchaseTech}
 * keeps the books balanced. Each offending entry names the node.
 */
export function checkTechState(state: GameState): InvariantResult {
  const tech = state.tech as Record<string, number> | undefined
  if (tech === undefined || typeof tech !== 'object' || tech === null) {
    return { name: 'tech-state', ok: false, detail: 'state.tech missing or not an object' }
  }

  const issues: string[] = []
  for (const key of Object.keys(tech)) {
    const node = TECH_NODES[key]
    if (!node) {
      issues.push(`unknown ${key}`)
      continue
    }
    const lvl = tech[key]
    if (!Number.isInteger(lvl) || lvl < 0 || lvl > node.maxLevel) {
      issues.push(`${key}=${String(lvl)} (max ${node.maxLevel})`)
    }
  }
  // Owned nodes must respect the unlock DAG (prerequisites at level >= 1).
  for (const id of TECH_NODE_IDS) {
    if (nodeLevel(state, id) >= 1 && !prerequisitesMet(state, id)) {
      issues.push(`${id} owned with unmet prerequisites`)
    }
  }

  return {
    name: 'tech-state',
    ok: issues.length === 0,
    detail: issues.length ? issues.join('; ') : undefined,
  }
}

/**
 * Smallest centre-to-centre distance two DISTINCT prestige-node positions may have in the
 * computed layout before it counts as a gross overlap. The prestige tree (3 branches, 33
 * nodes) is laid out by the SAME radial algorithm as the tech tree, so it inherits the
 * same generous floor (mirrors {@link TECH_MIN_NODE_SEP}); it trips immediately if a
 * topology / algorithm change ever stacks two prestige nodes on the same spot.
 */
const PRESTIGE_MIN_NODE_SEP = 24

/** The maxLevel band each prestige archetype must sit in (CLAUDE.md tree rule, mirrors tech). */
function prestigeBandOk(archetype: PrestigeArchetype, maxLevel: number): boolean {
  return archetype === 'gateway'
    ? maxLevel === 1
    : archetype === 'notable'
      ? maxLevel >= 2 && maxLevel <= 3
      : maxLevel >= 7 && maxLevel <= 10 // minor
}

/**
 * STATIC prestige-tree invariants (M4.1) — pure functions of the {@link PRESTIGE_NODES}
 * catalogue + the generic {@link layoutNodes} layout, independent of any {@link GameState},
 * so the runner asserts them ONCE per run (like {@link checkTechTree}). A single FAIL is a
 * commit blocker: a malformed prestige tree would mis-drive the permanent meta-layer and
 * the constellation view. Mirrors checkTechTree exactly, bound to the prestige data:
 *  - prestige-acyclic:        the prerequisite graph is a DAG — {@link prestigeHasCycle}.
 *  - prestige-no-orphans:     every node reachable from a {@link PRESTIGE_ROOTS} root —
 *                             {@link orphanPrestigeNodes}.
 *  - prestige-no-dead-perks:  every node has a real effect (perLevel > 0) —
 *                             {@link deadPrestigeNodes}.
 *  - prestige-maxlevel-range: every maxLevel is an integer in [1, 10].
 *  - prestige-archetype-band: maxLevel matches the archetype band (gateway 1 / notable 2-3
 *                             / minor 7-10).
 *  - prestige-roots:          PRESTIGE_ROOTS non-empty; every root exists and truly has no
 *                             prerequisite (an always-available category entry).
 *  - prestige-layout-complete:   a FINITE position for every node id.
 *  - prestige-layout-no-overlap: no two distinct centres closer than {@link PRESTIGE_MIN_NODE_SEP}.
 *  - prestige-edges-valid:    every edge endpoint is a known node and the edge count equals
 *                             the total number of (known) prerequisite links.
 */
export function checkPrestigeTree(): InvariantResult[] {
  const results: InvariantResult[] = []

  const cycle = prestigeHasCycle()
  results.push({
    name: 'prestige-acyclic',
    ok: !cycle,
    detail: cycle ? 'prerequisite graph contains a cycle (must be a DAG)' : undefined,
  })

  const orphans = orphanPrestigeNodes()
  results.push({
    name: 'prestige-no-orphans',
    ok: orphans.length === 0,
    detail: orphans.length ? `unreachable from roots: ${orphans.join(', ')}` : undefined,
  })

  const dead = deadPrestigeNodes()
  results.push({
    name: 'prestige-no-dead-perks',
    ok: dead.length === 0,
    detail: dead.length ? `no effect / perLevel<=0: ${dead.join(', ')}` : undefined,
  })

  const badLevel: string[] = []
  const badBand: string[] = []
  for (const id of PRESTIGE_NODE_IDS) {
    const node = PRESTIGE_NODES[id]
    const m = node.maxLevel
    if (!Number.isInteger(m) || m < 1 || m > 10) badLevel.push(`${id}=${m}`)
    if (!prestigeBandOk(node.archetype, m)) badBand.push(`${id}(${node.archetype})=${m}`)
  }
  results.push({
    name: 'prestige-maxlevel-range',
    ok: badLevel.length === 0,
    detail: badLevel.length ? `maxLevel out of [1,10]: ${badLevel.join(', ')}` : undefined,
  })
  results.push({
    name: 'prestige-archetype-band',
    ok: badBand.length === 0,
    detail: badBand.length ? `maxLevel off archetype band: ${badBand.join(', ')}` : undefined,
  })

  const rootIssues: string[] = []
  if (PRESTIGE_ROOTS.length === 0) rootIssues.push('no roots')
  for (const id of PRESTIGE_ROOTS) {
    const node = PRESTIGE_NODES[id]
    if (!node) rootIssues.push(`unknown root ${id}`)
    else if (node.prerequisites.length > 0) rootIssues.push(`root ${id} has prerequisites`)
  }
  results.push({
    name: 'prestige-roots',
    ok: rootIssues.length === 0,
    detail: rootIssues.length ? rootIssues.join('; ') : undefined,
  })

  const pos = layoutNodes(PRESTIGE_NODES, PRESTIGE_NODE_IDS)
  const missing: string[] = []
  for (const id of PRESTIGE_NODE_IDS) {
    const p = pos[id]
    if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) missing.push(id)
  }
  results.push({
    name: 'prestige-layout-complete',
    ok: missing.length === 0,
    detail: missing.length ? `no finite position for: ${missing.join(', ')}` : undefined,
  })

  let overlap: string | null = null
  for (let i = 0; i < PRESTIGE_NODE_IDS.length && overlap === null; i++) {
    const a = pos[PRESTIGE_NODE_IDS[i]]
    if (!a) continue
    for (let j = i + 1; j < PRESTIGE_NODE_IDS.length; j++) {
      const b = pos[PRESTIGE_NODE_IDS[j]]
      if (!b) continue
      const d = Math.hypot(a.x - b.x, a.y - b.y)
      if (d < PRESTIGE_MIN_NODE_SEP) {
        overlap = `${PRESTIGE_NODE_IDS[i]} & ${PRESTIGE_NODE_IDS[j]} only ${d.toFixed(1)} apart`
        break
      }
    }
  }
  results.push({
    name: 'prestige-layout-no-overlap',
    ok: overlap === null,
    detail: overlap ?? undefined,
  })

  let expectedEdges = 0
  for (const id of PRESTIGE_NODE_IDS) {
    for (const pre of PRESTIGE_NODES[id].prerequisites) if (pre in PRESTIGE_NODES) expectedEdges += 1
  }
  const edges = nodeEdges(PRESTIGE_NODES, PRESTIGE_NODE_IDS)
  const badEdge = edges.find((e) => !(e.from in PRESTIGE_NODES) || !(e.to in PRESTIGE_NODES))
  const edgeOk = badEdge === undefined && edges.length === expectedEdges
  results.push({
    name: 'prestige-edges-valid',
    ok: edgeOk,
    detail: edgeOk
      ? undefined
      : badEdge
        ? `edge with unknown endpoint ${badEdge.from}->${badEdge.to}`
        : `edge count ${edges.length} != prerequisite links ${expectedEdges}`,
  })

  return results
}

/**
 * Runtime prestige-state invariant (M4.1), checked at every prestige-run sample (and right
 * after each ascension). The PERMANENT account state {@link GameState.prestige} must stay
 * structurally sound however the bot ascends / buys and however the save round-trips:
 *  - it is an object with finite, non-negative `points` / `totalEarned` and an integer,
 *    non-negative `ascensions` (the banked PP and lifetime totals can never go NaN/negative),
 *  - `nodes` is an object; every KEY is a known prestige-node id (no stray keys),
 *  - every level is an INTEGER in [0, node.maxLevel] (a buy never overshoots / goes negative
 *    / turns fractional),
 *  - every OWNED node (level >= 1) has its prerequisites met — the unlock DAG is respected
 *    in the live state, so a node can never be bought out of order even across a reset.
 *
 * Mirrors {@link checkTechState}; pairs with resources-non-negative to prove ascend /
 * purchasePrestige keep the books balanced. Each offending entry names the field / node.
 */
export function checkPrestigeState(state: GameState): InvariantResult {
  const prestige = state.prestige as
    | { points?: unknown; totalEarned?: unknown; ascensions?: unknown; nodes?: unknown }
    | undefined
  if (prestige === undefined || typeof prestige !== 'object' || prestige === null) {
    return { name: 'prestige-state', ok: false, detail: 'state.prestige missing or not an object' }
  }

  const issues: string[] = []
  const num = (k: 'points' | 'totalEarned' | 'ascensions', requireInt: boolean): void => {
    const v = prestige[k]
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || (requireInt && !Number.isInteger(v))) {
      issues.push(`${k}=${String(v)}`)
    }
  }
  num('points', false)
  num('totalEarned', false)
  num('ascensions', true)

  const nodes = prestige.nodes
  if (typeof nodes !== 'object' || nodes === null) {
    issues.push('nodes not an object')
  } else {
    const map = nodes as Record<string, unknown>
    for (const key of Object.keys(map)) {
      const node = PRESTIGE_NODES[key]
      if (!node) {
        issues.push(`unknown ${key}`)
        continue
      }
      const lvl = map[key]
      if (typeof lvl !== 'number' || !Number.isInteger(lvl) || lvl < 0 || lvl > node.maxLevel) {
        issues.push(`${key}=${String(lvl)} (max ${node.maxLevel})`)
      }
    }
    // Owned nodes must respect the unlock DAG (prerequisites at level >= 1).
    for (const id of PRESTIGE_NODE_IDS) {
      if (prestigeNodeLevel(state, id) >= 1) {
        for (const pre of PRESTIGE_NODES[id].prerequisites) {
          if (prestigeNodeLevel(state, pre) < 1) {
            issues.push(`${id} owned with unmet prerequisite ${pre}`)
            break
          }
        }
      }
    }
  }

  return {
    name: 'prestige-state',
    ok: issues.length === 0,
    detail: issues.length ? issues.join('; ') : undefined,
  }
}

/**
 * Post-ascension playability invariant (M4.1): right after {@link import('../src/systems/prestige').ascend}
 * the reset run MUST be a valid, playable single-capital state — never a softlock or a
 * corrupt ledger. Asserts the structural facts unique to the reset (the broader resource /
 * army / world / round-trip / no-softlock checks are sampled alongside this one):
 *  - at least one ascension was actually recorded (`prestige.ascensions >= 1`),
 *  - the village ledger is consistent: `villageOrder` non-empty, every id in it resolves to
 *    a village, and `villages` has no key missing from / extra to the order,
 *  - the regenerated world is NON-EMPTY (there is always a barbarian to attack — the combat
 *    loop is reopened, not softlocked),
 *  - the capital's resources are all finite and non-negative (the start-resource head-start,
 *    if any, was applied sanely).
 *
 * This is the "ascend leaves the game grywalny" guard the brief calls for. Pure function of
 * the post-ascend state.
 */
export function checkAscendValid(state: GameState): InvariantResult {
  const issues: string[] = []

  if (!(state.prestige?.ascensions >= 1)) issues.push(`ascensions=${String(state.prestige?.ascensions)}`)

  const order = state.villageOrder
  if (!Array.isArray(order) || order.length === 0) {
    issues.push('villageOrder empty')
  } else {
    for (const id of order) {
      if (!state.villages[id]) issues.push(`villageOrder id ${id} has no village`)
    }
    const orderSet = new Set(order)
    if (orderSet.size !== order.length) issues.push('villageOrder has duplicates')
    for (const id of Object.keys(state.villages)) {
      if (!orderSet.has(id)) issues.push(`village ${id} missing from villageOrder`)
    }
  }

  if (!state.world || !Array.isArray(state.world.barbarians) || state.world.barbarians.length === 0) {
    issues.push('world has no barbarians (combat loop would softlock)')
  }

  const capital = state.villages[state.villageOrder[0]]
  if (capital) {
    for (const r of RESOURCE_IDS) {
      const res = capital.resources[r]
      if (!isFiniteDecimal(res) || res.lt(0)) issues.push(`capital.${r}=${res?.toString?.() ?? String(res)}`)
    }
  } else {
    issues.push('no capital village')
  }

  return {
    name: 'ascend-valid',
    ok: issues.length === 0,
    detail: issues.length ? issues.join('; ') : undefined,
  }
}

/** Sum of all resources across EVERY village — the coarse "have I made progress?" measure. */
export function totalResources(state: GameState): Decimal {
  let total = ZERO
  for (const vid of state.villageOrder) {
    const v = state.villages[vid]
    for (const r of RESOURCE_IDS) total = total.add(v.resources[r])
  }
  return total
}

/** Every building of `v` at its data-defined maxLevel — the M1.2 building ceiling. */
export function allBuildingsMaxed(v: Village): boolean {
  return BUILDING_IDS.every((id) => v.buildings[id] >= BUILDINGS[id].maxLevel)
}

/**
 * Whether a village's M1.3 combat loop is live — i.e. there is a perpetual unit SINK
 * that keeps freeing population. Mirrors raids.ts's `raidsActive` (private there): a
 * march is in flight, OR the village owns any unit, OR it has grown past its starting
 * footprint. Once true, incoming raids fire on a timer and attrite the home garrison
 * while marches take casualties, so population is never PERMANENTLY full — the
 * recruit -> attack/lose -> recruit loop always has a next action.
 */
function combatLoopActive(v: Village): boolean {
  if (v.marches.length > 0) return true
  for (const id of UNIT_IDS) if (v.units[id] > 0) return true
  let initSum = 0
  let sum = 0
  for (const id of BUILDING_IDS) {
    initSum += INITIAL_BUILDINGS[id]
    sum += v.buildings[id]
  }
  return sum > initSum
}

/**
 * The M1.2 "content frontier" for a single village: every building maxed AND no
 * population room left to train even the smallest unit. In M1.2 that was a PERMANENT
 * end-of-content stall (farm maxed -> popCap frozen -> recruitment closed forever)
 * and {@link checkNoSoftlock} exempted it as the expected ceiling.
 *
 * M1.3 DISSOLVES that frontier: combat is a perpetual unit sink + loot source.
 * Incoming raids continuously kill home units (freeing population) and marches take
 * casualties, so once {@link combatLoopActive} the bot can always recruit -> attack
 * -> loot -> recruit without bound. We therefore report the frontier as NOT reached
 * whenever the combat loop is live. The narrow M1.2 condition is only ever "true" in
 * the degenerate, combat-free pre-units state — which no real run sits in.
 */
export function villageContentConsumed(v: Village): boolean {
  if (!allBuildingsMaxed(v)) return false
  if (combatLoopActive(v)) return false
  const minPop = Math.min(...UNIT_IDS.map((id) => UNITS[id].pop))
  return freePopulation(v).lt(minPop)
}

/**
 * The whole game has consumed its content only when EVERY village has (each maxed +
 * population permanently full + combat loop dead). With the single M2.1 village this
 * is exactly the capital's {@link villageContentConsumed}. No caps/values are inflated
 * to hide anything; in M1.3 the boundary genuinely no longer exists.
 */
export function contentConsumed(state: GameState): boolean {
  return state.villageOrder.every((id) => villageContentConsumed(state.villages[id]))
}

/**
 * No-softlock: at every sample there must be *some* real progress somewhere in the
 * game. Four signals are accepted, and a stall is flagged only when ALL are absent:
 *
 *  1. `grew`   — total resources (summed across all villages) rose since the previous
 *               sample (idle accrual), OR
 *  2. `acted`  — at least one progress action (build, recruit OR attack) happened in
 *               the window, OR
 *  3. `hasAction` — some action (an affordable non-maxed building, a trainable unit,
 *               or a winnable attack) is available right now in SOME village via
 *               {@link chooseAction}, OR
 *  4. `inFlight` — a training order or a march is still in progress in SOME village:
 *               units are being minted, or an army is travelling and will return with
 *               loot / free population on its casualties. Pending progress, not a stall.
 *
 * Signal 2 is essential once a *spending* bot exists: a buyer converts resources
 * into building levels and units, so the instantaneous resource sum can DROP across a
 * window even though the run is clearly progressing. Signal 4 is essential in M1.3:
 * when the whole home army is out on a march and population is momentarily full, no
 * instantaneous action exists — but the march WILL resolve (loot + freed population),
 * so it is progress in flight, not a stall.
 *
 * Honest-softlock philosophy (CLAUDE.md): when all four signals are absent the run
 * has stalled, which in M1.3 is ALWAYS a hard failure — combat dissolved the M1.2
 * content frontier (see {@link contentConsumed}), so there is no longer an exempt
 * ceiling. The {@link contentConsumed} branch is retained for completeness but only
 * fires in the degenerate combat-free pre-units state no real run sits in.
 *
 * A bare "production > 0" proxy is intentionally NOT used: production stays positive
 * even when every resource is pinned at the cap with nothing to spend it on — the
 * genuine softlock this check must catch.
 */
export function checkNoSoftlock(
  state: GameState,
  prevTotal: Decimal,
  actedInWindow: boolean,
): InvariantResult {
  const grew = totalResources(state).gt(prevTotal)

  // M3.2/M4.1: the probe must judge availability with the SAME effective bonuses the bot
  // uses, so a build affordable only at the discounted price (or an attack winnable only
  // with the military bonus) still counts as an available action. effectiveMods folds tech
  // WITH the permanent prestige tree; for a prestige-empty state it equals the tech bag
  // exactly, so the M1–M3 runs are unchanged. Pure function of state.tech + state.prestige.
  const mods = effectiveMods(state)

  let hasAction = false
  let inFlight = false
  for (const vid of state.villageOrder) {
    const v = state.villages[vid]
    if (!hasAction && chooseAction(v, state.world, mods) !== null) hasAction = true
    if (!inFlight && (v.recruitQueue.length > 0 || v.marches.length > 0)) inFlight = true
  }

  if (grew || actedInWindow || hasAction || inFlight) {
    return { name: 'no-softlock', ok: true }
  }
  // Stalled with nothing in flight in any village. In M1.3 combat dissolved the
  // content frontier, so this is a genuine softlock and a commit blocker (the frontier
  // branch only fires in the degenerate combat-free state — see contentConsumed).
  const frontier = contentConsumed(state)
  return {
    name: 'no-softlock',
    ok: frontier,
    detail: frontier
      ? 'content-frontier: degenerate combat-free state (no units, no growth) — not reachable by a real M1.3 run'
      : 'softlock: resources stalled (capped?), nothing acted/buildable/trainable/attackable, and no march or training in flight',
  }
}

/**
 * Put the first village of a fresh state into an identical, NON-EMPTY combat state so
 * EVERY step-size-sensitive clock — recruitment AND marches AND raids — is actually
 * exercised by {@link checkOfflineDeterminism}. Without this both branches keep empty
 * queues, so only the trivially split-invariant linear production path is compared and
 * the guarantee passes VACUOUSLY — a genuine offline/online divergence in any of those
 * subsystems would go uncaught.
 *
 * Seeds three live subsystems on the capital (`villageOrder[0]`):
 *  - a TRAINING queue larger than the window can finish (perUnit ~76s × 100 = 7600s
 *    > 3600s), so an order is still in flight at the end;
 *  - an in-flight MARCH (a home stack is placed, then part of it dispatched), so
 *    advanceMarches crosses outbound -> battle -> returning -> loot-delivery
 *    boundaries within the window — the combat clock the brief requires;
 *  - because units now exist, raids become active too, so advanceRaids fires several
 *    times across the span.
 *
 * All three must replay byte-identically whether the span is taken as one big
 * simulate() or many TICK_RATE chunks. Resources / popCap are set directly (mirroring
 * the unit tests' `armed` helper) to decouple from building prices.
 */
function seedRecruitment(state: GameState): void {
  const v = firstVillage(state)
  v.resources = { wood: D(1e6), clay: D(1e6), iron: D(1e6) }
  v.buildings.barracks = 1
  // M4.1: seed a PERMANENT prestige multiplier too, so the offline-determinism check folds
  // the SAME effectiveMods (tech × prestige) production the live engine uses — proving
  // offline catch-up stays byte-identical with prestige active (prestige is in the v9 save).
  // Both the big-step and chunked branches seed this identically, so the equality still
  // isolates a real offline/online split rather than masking one.
  state.prestige.nodes.prosperity_root = 2
  recomputeDerived(state)
  v.popCap = D(1000) // headroom: queued + trained + away units all count
  // Live training queue (recruitment clock).
  recruit(v, 'spearman', 100)
  // Live march (combat clock): place a home stack, then send part of it at a CONCRETE
  // tier-6 camp on the world map (M2.2) — a clean win whose there-and-back resolves
  // inside the window, so advanceMarches crosses every phase boundary either way.
  v.units.axeman = 60
  const army = {} as Record<UnitId, number>
  for (const id of UNIT_IDS) army[id] = 0
  army.axeman = 40
  sendAttack(v, state.world, state.battleLog, targetOfLevel(state.world, 6).id, army)
}

/**
 * Offline catch-up must equal live stepping for the same elapsed time, so the
 * idle game's core (offline progress) never diverges from online play. We credit
 * a fixed span two ways — one big simulate() step vs the chunked offline path —
 * and require the serialized states to be byte-identical.
 *
 * Both branches start from the SAME non-empty combat state ({@link seedRecruitment}:
 * a live training queue, an in-flight march AND active raids on the capital) so all
 * the step-size-sensitive subsystems a big-step-vs-many-small-steps split could break
 * are genuinely compared, not just the split-invariant linear production. simulate()
 * advancing every village's recruitment, marches and raids on the fixed TICK_RATE grid
 * (see tick.ts) is what makes the big step reproduce the chunked path even with an
 * order and an army in flight.
 */
export function checkOfflineDeterminism(seed: string, seconds: number): InvariantResult {
  const big = createInitialState(seed, 0)
  seedRecruitment(big)
  simulate(big, seconds)
  big.lastSeen = seconds * 1000 // mirror the bookkeeping applyOffline performs

  const chunked = createInitialState(seed, 0)
  seedRecruitment(chunked)
  applyOffline(chunked, seconds * 1000) // lastSeen starts at 0

  const a = serialize(big)
  const b = serialize(chunked)
  const ok = a === b
  return {
    name: 'offline-determinism',
    ok,
    detail: ok
      ? undefined
      : 'chunked offline catch-up diverged from a single-step simulate (recruitment / march / raid timeline)',
  }
}

/**
 * Marches TERMINATE: a dispatched army always resolves and clears out (it is never
 * stuck in flight forever, and `remaining` stays finite >= 0 throughout). Dispatches
 * one over-powered attack from the capital on a fresh state (so the engagement is a
 * clean win) and steps it forward well past a full there-and-back round trip; by the
 * horizon the village's march array MUST be empty (returned with loot, or dropped on a
 * wipe) and no march may ever show a non-finite / negative `remaining`. No bot
 * involved, so the only change to the village's marches is the seeded army draining —
 * nothing is added.
 */
export function checkMarchesTerminate(seed: string): InvariantResult {
  const state = createInitialState(seed, 0)
  const v = firstVillage(state)
  v.resources = { wood: D(1e7), clay: D(1e7), iron: D(1e7) }
  v.buildings.barracks = 1
  recomputeDerived(state)
  v.popCap = D(10000)
  v.units.axeman = 200

  const army = {} as Record<UnitId, number>
  for (const id of UNIT_IDS) army[id] = 0
  army.axeman = 100
  // Target a CONCRETE tier-10 camp on the world map (M2.2). Its ring radius is
  // ~10·DISTANCE_PER_LEVEL (= 30) ± a one-ring jitter, so the Euclidean distance from
  // the central capital is ~27..33 fields — a clean over-powered win that returns well
  // inside the horizon below.
  if (!sendAttack(v, state.world, state.battleLog, targetOfLevel(state.world, 10).id, army)) {
    return { name: 'marches-terminate', ok: false, detail: 'could not dispatch the test march' }
  }

  const CHUNK = 30
  // >> a full round trip: tier-10 distance ~30 fields × speed 18 ≈ 540s each way.
  const HORIZON = 6000
  let bad: string | null = null
  for (let t = 0; t < HORIZON && v.marches.length > 0; t += CHUNK) {
    simulate(state, CHUNK)
    for (const m of v.marches) {
      if (!Number.isFinite(m.remaining) || m.remaining < 0) {
        bad = `remaining=${m.remaining}`
        break
      }
    }
    if (bad) break
  }

  const ok = bad === null && v.marches.length === 0
  return {
    name: 'marches-terminate',
    ok,
    detail: ok ? undefined : (bad ?? `march still in flight after ${HORIZON}s`),
  }
}

/**
 * Round-trip faithfulness: serialize → deserialize → serialize must be byte-for
 * -byte identical, proving the save schema is loss-free and idempotent.
 */
export function checkRoundTrip(state: GameState): InvariantResult {
  const once = serialize(state)
  const twice = serialize(deserialize(once))
  const ok = once === twice
  return {
    name: 'round-trip',
    ok,
    detail: ok ? undefined : 'serialize(deserialize(serialize(s))) !== serialize(s)',
  }
}

/**
 * Put a fresh state into the M5.1 idle-automation scenario: every routine UNLOCKED and
 * TOGGLED ON, on a matured single capital that gives all three something to do from the
 * very first sub-step. Used by both the automation-determinism check below and the
 * separate progress coverage run (runner.runAutomationCoverage). Pure, Node-safe and
 * deterministic — applied identically to every branch, so the only thing it can ever
 * reveal is a genuine online/offline split or a stalled routine, never seeding noise.
 *
 * The three gateways are unlocked by setting their tech levels directly:
 * {@link import('../src/systems/tech').aggregateTechMods} flips
 * `TechModifiers.automations[*]` on at level >= 1 and reads ONLY the `automation_unlock`
 * nodes' own levels (not their prerequisites) — and `automation_unlock` is a binary
 * effect with no economic roll-up — so the three gates alone unlock the routines with
 * zero side effect on production / cost / combat. (The unmet prerequisites are irrelevant
 * here; the save layer validates node ids + level bounds, not the prerequisite DAG, so the
 * state still serialises / round-trips cleanly — this coverage deliberately does not run
 * checkTechState, whose DAG check is exercised by the main run instead.)
 *
 * Toggles all ON with an auto-recruit policy of `recruitTarget` axemen: the axeman is the
 * offensive workhorse, so it doubles as the auto-attack stack — the recruit -> attack idle
 * loop the routine is meant to drive. A standing axeman garrison is seeded so auto-attack
 * has an idle army to dispatch immediately; nobles stay at 0 (the routine must never march
 * them). Resources are filled to the freshly-derived storage cap so auto-build can buy on
 * step one, capped EXACTLY at storageCap so the resources-within-cap invariant holds from
 * the first sample.
 */
export function seedAutomation(state: GameState): void {
  state.tech.con_automation = 1 // -> automations.build
  state.tech.tra_automation = 1 // -> automations.recruit
  state.tech.mil_automation = 1 // -> automations.attack

  state.automation = {
    build: true,
    recruit: true,
    attack: true,
    recruitUnit: 'axeman',
    recruitTarget: 80,
  }

  const v = firstVillage(state)
  v.buildings.hq = 5
  v.buildings.sawmill = 10
  v.buildings.clay_pit = 10
  v.buildings.iron_mine = 10
  v.buildings.warehouse = 12 // cap = 1000 + 12·3000 = 37000 — ample build headroom
  v.buildings.farm = 15 // popCap = 10 + 15·12 = 190 — ample recruit headroom
  v.buildings.barracks = 5 // unlocks recruit/attack, speeds training
  // Fold the new levels (with the economy-neutral automation tech) into production /
  // storageCap / popCap exactly as the engine would, THEN top resources up to the cap.
  recomputeDerived(state)
  for (const r of RESOURCE_IDS) v.resources[r] = v.storageCap
  v.units.axeman = 30
}

/**
 * AUTOMATION offline/online parity (M5.1): the idle routines run inside the fixed-grid
 * sub-step ({@link import('../src/engine/tick').simulate} → subStep → runAutomation), so
 * crediting a span as one big {@link simulate} (online catch-up) must be byte-identical to
 * the chunked offline path ({@link applyOffline}) WITH automation ON. Mirrors
 * {@link checkOfflineDeterminism} but seeds the full automation scenario first, so the
 * build / recruit / attack mutations the routine makes every sub-step are exercised in BOTH
 * branches and proven to replay identically — the determinism guarantee the brief requires.
 *
 * Both branches start from the SAME {@link seedAutomation} state and credit the same span,
 * so any divergence is a real automation/offline split, not seeding noise. `seconds` must
 * stay within {@link import('../src/engine/offline').MAX_OFFLINE_SECONDS} (the callers use
 * an hour, well inside the cap) so applyOffline credits the whole span.
 */
export function checkAutomationDeterminism(seed: string, seconds: number): InvariantResult {
  const big = createInitialState(seed, 0)
  seedAutomation(big)
  simulate(big, seconds)
  big.lastSeen = seconds * 1000 // mirror the bookkeeping applyOffline performs

  const chunked = createInitialState(seed, 0)
  seedAutomation(chunked)
  applyOffline(chunked, seconds * 1000) // lastSeen starts at 0

  const a = serialize(big)
  const b = serialize(chunked)
  const ok = a === b
  return {
    name: 'automation-determinism',
    ok,
    detail: ok
      ? undefined
      : 'chunked offline catch-up diverged from a single-step simulate WITH automation ON (auto build/recruit/attack)',
  }
}

// --- M5.2 wall (defensive building) + scouts (recon unit) coverage ------------------------
//
// Three deterministic proof-of-mechanic checks for the M5.2 additions, mirroring how the
// automation coverage proves each idle routine fires. All are pure functions of a freshly
// seeded scenario (no bot, no clock, no RNG) so a regression that breaks the wall's raid
// mitigation, the scout's reveal, or the offline/online parity WITH a wall + scout in flight
// is a hard failure that blocks the commit. The MAIN run is untouched (the 17 balance goals
// stay measured on the bot's own path — the bot already builds the wall there; it never
// recruits scouts, so the scout path is exercised here instead).

/**
 * How many spearmen the wall-mitigation scenario garrisons. Chosen with the building sum
 * below so the SAME raid is a marginal WIN against the wall-less garrison (it is wiped) but
 * a clean REPEL once a maxed wall hardens it — see {@link checkWallMitigation}'s arithmetic.
 */
const WALL_TEST_GARRISON = 10

/**
 * MUR (wall) mitigates raids (M5.2): the SAME deterministic raid does strictly LESS damage to
 * a walled village than to an otherwise-identical wall-less one. Builds two copies of the same
 * seeded scenario ({@link WALL_TEST_GARRISON} spearmen, a fixed 27-level non-wall footprint
 * so {@link raidPower} is the same in both copies, primed raid timer) differing ONLY in wall
 * level — 0 vs the wall's
 * maxLevel — fires exactly one raid at each via the real {@link advanceRaids} path, and asserts:
 *
 *  - the walled village's effective defence ({@link villageDefenseMult} > 1) exceeds the bare
 *    one's (mult 1), AND
 *  - the walled village loses STRICTLY fewer units to the raid (with these numbers the bare
 *    garrison is overrun and wiped while the wall repels the raid for zero losses).
 *
 * With the chosen numbers: raidPower = 10 + 3·buildingSum + 0.4·(garrison·15). Bare (wall 0,
 * sum 27): 151 > defence 150 → raid wins → 10 lost. Walled (wall 10, sum 37): raidPower 181 <
 * defence 150·1.5 = 225 → repelled → 0 lost. The check is value-driven, not hard-coded to
 * those totals: it just requires walledLosses < bareLosses, so a Balance retune of the wall
 * perLevel still passes as long as the wall genuinely mitigates. Pure / deterministic — re-run
 * twice to confirm RNG-freeness.
 */
export function checkWallMitigation(seed: string): InvariantResult {
  const issues: string[] = []

  // Resolve one raid against a fresh garrison with the given wall level; return its losses
  // and the village's effective defence multiplier.
  const resolveOne = (wallLevel: number): { losses: number; mult: number } => {
    const state = createInitialState(seed, 0)
    const v = firstVillage(state)
    // Non-wall footprint (identical in both copies) → buildingLevelSum 27 without the wall.
    v.buildings.sawmill = 10
    v.buildings.warehouse = 10
    v.buildings.farm = 4
    v.buildings.wall = wallLevel
    recomputeDerived(state)
    v.resources = { wood: D(1000), clay: D(1000), iron: D(1000) }
    for (const id of UNIT_IDS) v.units[id] = 0
    v.units.spearman = WALL_TEST_GARRISON
    v.raidTimer = 1 // next advanceRaids(…, 1) fires exactly one raid
    const log: GameState['battleLog'] = []
    advanceRaids(v, log, 1)
    const report = log[log.length - 1]
    const losses = report && report.kind === 'raid' ? report.losses : -1
    return { losses, mult: villageDefenseMult(v) }
  }

  const bare = resolveOne(0)
  const walled = resolveOne(BUILDINGS.wall.maxLevel)
  // Determinism: the raid resolution is RNG-free, so a repeat must match byte-for-byte.
  const bareAgain = resolveOne(0)

  if (bare.losses < 0 || walled.losses < 0) {
    issues.push('raid produced no report')
  }
  if (bare.losses !== bareAgain.losses) {
    issues.push(`non-deterministic raid losses ${bare.losses} != ${bareAgain.losses}`)
  }
  if (!(walled.mult > bare.mult)) {
    issues.push(`wall defence mult ${walled.mult} !> bare ${bare.mult}`)
  }
  if (!(walled.losses < bare.losses)) {
    issues.push(`walled losses ${walled.losses} !< bare losses ${bare.losses}`)
  }

  return {
    name: 'wall-mitigates',
    ok: issues.length === 0,
    detail:
      issues.length === 0
        ? `wall cut raid losses ${bare.losses} -> ${walled.losses} (defence mult ${bare.mult} -> ${walled.mult})`
        : issues.join('; '),
  }
}

/**
 * ZWIAD (scout) reveals a camp (M5.2): a dispatched scout march flips the target's
 * {@link BarbarianVillage.scouted} flag false → true and brings every scout home unharmed
 * WITHOUT fighting or looting. Seeds a fresh capital with a small scout garrison, a raid timer
 * pushed far out (so no raid perturbs the recon window), dispatches a {@link sendScout} at the
 * nearest barbarian, advances the real {@link import('../src/engine/tick').simulate} clock past
 * a full there-and-back, and asserts:
 *
 *  - the target was UNSCOUTED before dispatch (scouted === false), and
 *  - the scout march was created with `kind: 'scout'` carrying only scouts, and
 *  - after the round trip the target is SCOUTED (scouted === true), the march has cleared, the
 *    scouts are ALL home (none lost — recon never fights), and
 *  - NOTHING was logged (a scout neither battles nor raids — no battle report), and
 *  - the capital's resources stayed finite / non-negative and the army books balance
 *    (no NaN / negative / phantom units introduced by the scout path).
 *
 * The reveal count (1 here) backs the contract's `scout-reveals >= 1` goal. Pure /
 * deterministic — no bot, no RNG, raids frozen out of the window.
 */
export function checkScoutReveals(seed: string): InvariantResult {
  const issues: string[] = []
  const state = createInitialState(seed, 0)
  const v = firstVillage(state)
  v.buildings.barracks = 1
  recomputeDerived(state)
  v.resources = { wood: D(1000), clay: D(1000), iron: D(1000) }
  v.popCap = D(1000)
  for (const id of UNIT_IDS) v.units[id] = 0
  v.units.scout = 5
  // Push the raid clock well past the recon window so no raid touches the home scouts —
  // isolating the scout mechanic (a returned scout garrison would otherwise be a raid target).
  v.raidTimer = 1e9

  const target = state.world.barbarians[0]
  if (target === undefined) {
    return { name: 'scout-reveals', ok: false, detail: 'world has no barbarian to scout' }
  }
  if (target.scouted !== false) issues.push('target already scouted before dispatch')

  const logLenBefore = state.battleLog.length
  const dispatched = sendScout(v, state.world, state.battleLog, target.id, 3)
  if (!dispatched) issues.push('sendScout returned false')
  const march = v.marches[v.marches.length - 1]
  if (!march || march.kind !== 'scout') issues.push('no scout march created')
  else if (march.units.scout !== 3) issues.push(`scout march carries ${march.units.scout} scouts, expected 3`)

  // Advance well past a there-and-back (nearest tier-1 camp ≈ 3 fields × scout speed 9 ≈ 54s
  // round trip; 600s is comfortably beyond, and the raid clock is frozen).
  simulate(state, 600)

  if (target.scouted !== true) issues.push('target not scouted after the scout returned')
  if (v.marches.length !== 0) issues.push(`scout march still in flight (${v.marches.length})`)
  if (v.units.scout !== 5) issues.push(`scouts not all home: ${v.units.scout}/5 (recon must not fight)`)
  if (state.battleLog.length !== logLenBefore) {
    issues.push(`scout logged ${state.battleLog.length - logLenBefore} report(s) — it must not fight`)
  }

  // No NaN / negative resources and balanced army books introduced by the scout path.
  for (const r of RESOURCE_IDS) {
    const res = v.resources[r]
    if (!isFiniteDecimal(res) || res.lt(0)) issues.push(`capital.${r}=${res.toString()}`)
  }
  const army = checkArmyConsistency(state)
  if (!army.ok) issues.push(`army-consistency: ${army.detail ?? 'failed'}`)

  return {
    name: 'scout-reveals',
    ok: issues.length === 0,
    detail:
      issues.length === 0
        ? `scout revealed ${target.id} (scouted false -> true), 5/5 scouts home, nothing fought/looted`
        : issues.join('; '),
  }
}

/**
 * Put a fresh state into the M5.2 offline-parity scenario: a WALL standing (so the raid path
 * folds {@link villageDefenseMult}), a mixed home garrison (raids fire against it across the
 * span) AND an in-flight SCOUT march (so the scout reveal + unharmed return cross the
 * offline/online boundary). Applied identically to both branches of
 * {@link checkM52Determinism}, so the only thing it can reveal is a genuine wall/scout
 * online-vs-offline split. Mirrors {@link seedRecruitment}'s discipline (resources/popCap set
 * directly to decouple from prices).
 */
function seedM52(state: GameState): void {
  const v = firstVillage(state)
  v.resources = { wood: D(1e6), clay: D(1e6), iron: D(1e6) }
  v.buildings.barracks = 1
  v.buildings.wall = 5 // a standing wall → villageDefenseMult 1.25 in the raid path
  recomputeDerived(state)
  v.popCap = D(1000)
  v.units.spearman = 20
  v.units.axeman = 30
  v.units.scout = 10
  // In-flight scout at the nearest camp: its reveal + unharmed return must replay identically
  // whether the span is one big step or many chunks.
  sendScout(v, state.world, state.battleLog, state.world.barbarians[0].id, 5)
}

/**
 * M5.2 offline/online parity: crediting a span as one big {@link import('../src/engine/tick').simulate}
 * (online catch-up) must be byte-identical to the chunked offline path
 * ({@link applyOffline}) WITH a wall standing and a scout march in flight. Mirrors
 * {@link checkOfflineDeterminism} / {@link checkAutomationDeterminism} but seeds the
 * {@link seedM52} scenario, so the wall's raid mitigation AND the scout's reveal/return are
 * exercised in BOTH branches and proven to replay identically — the determinism guarantee the
 * brief requires for the new mechanics. `seconds` stays within
 * {@link import('../src/engine/offline').MAX_OFFLINE_SECONDS} (the caller uses an hour).
 */
export function checkM52Determinism(seed: string, seconds: number): InvariantResult {
  const big = createInitialState(seed, 0)
  seedM52(big)
  simulate(big, seconds)
  big.lastSeen = seconds * 1000 // mirror the bookkeeping applyOffline performs

  const chunked = createInitialState(seed, 0)
  seedM52(chunked)
  applyOffline(chunked, seconds * 1000) // lastSeen starts at 0

  const a = serialize(big)
  const b = serialize(chunked)
  const ok = a === b
  return {
    name: 'm52-determinism',
    ok,
    detail: ok
      ? undefined
      : 'chunked offline catch-up diverged from a single-step simulate WITH a wall + scout march in flight',
  }
}

// --- M5.3 siege (ram + catapult) coverage -------------------------------------------------
//
// Three deterministic proof-of-mechanic checks for the M5.3 siege engines, mirroring the M5.2
// wall/scout coverage. All are pure functions of a freshly seeded scenario (no bot, no clock,
// no RNG) so a regression that breaks the ram's wall-cracking, the catapult's permanent level
// razing, or the offline/online parity WITH a siege march in flight is a hard failure that
// blocks the commit. The MAIN run is untouched (the bot never fields siege — it is gated behind
// the academy and is never the cheapest recruit, and auto-attack explicitly excludes ram /
// catapult), so the 17 balance goals stay measured on the pre-M5.3 path; the siege paths are
// exercised here instead.

/** A fresh complete zero roster (every UnitId present) for the siege coverage scenarios. */
function zeroArmy(): Record<UnitId, number> {
  const r = {} as Record<UnitId, number>
  for (const id of UNIT_IDS) r[id] = 0
  return r
}

/** Camp tier the ram-crack scenario assaults — high enough that the win band below is wide. */
const RAM_CRACK_LEVEL = 13
/** Rams fielded by the crack scenario: ramDefenseFactor(25) = 1 − 25·0.02 = 0.5 (−50% wall). */
const RAM_CRACK_RAMS = 25
/** Horizon (game-seconds) a siege attack is simulated for — well past a tier-13 round trip. */
const SIEGE_HORIZON = 6000

/**
 * Resolve a single siege attack carrying `army` at a camp of tier `level` through the REAL
 * engine ({@link sendAttack} + {@link simulate}), on a fresh seeded capital with raids frozen
 * out so the ONLY battle report is this attack. Returns whether the engine resolved a WIN and
 * the live target's camp level before dispatch / after the dust settles — so the ram check can
 * read `won` and the catapult check can read the `before -> after` level delta off the very
 * same path the player would drive. Units are seeded directly (bypassing recruitment), so the
 * scenario does not depend on prices; the academy/barracks are set only so the dispatch gate
 * (canAttack) passes. Pure / deterministic — no bot, no RNG.
 */
function resolveSiegeAttack(
  seed: string,
  level: number,
  army: Record<UnitId, number>,
): { won: boolean; before: number; after: number; sane: boolean; sanity?: string } {
  const state = createInitialState(seed, 0)
  const v = firstVillage(state)
  v.buildings.barracks = 1
  v.buildings.academy = 1 // the siege gate (units seeded directly, but keep the scenario honest)
  recomputeDerived(state)
  v.resources = { wood: D(1e7), clay: D(1e7), iron: D(1e7) }
  v.popCap = D(1e5)
  v.raidTimer = 1e9 // freeze raids so the only report is this attack
  for (const id of UNIT_IDS) v.units[id] = army[id] ?? 0

  const target = targetOfLevel(state.world, level)
  const before = target.level
  const logBefore = state.battleLog.length
  const dispatched = sendAttack(v, state.world, state.battleLog, target.id, army)
  if (dispatched) simulate(state, SIEGE_HORIZON)

  let sawAttack = false
  let lastWon = false
  for (const rep of state.battleLog.slice(logBefore)) {
    if (rep.kind === 'attack') {
      sawAttack = true
      lastWon = rep.won
    }
  }

  // State sanity AFTER the siege path ran (no NaN / negative loot, books balance, camp level in
  // range): the siege code (ram reduction, catapult raze + clamp, loot haul) must never strand
  // the state. Cheap to assert here so a regression surfaces on the siege-exercised state itself,
  // not just the bot-driven main run (which never fields siege).
  const sanity: string[] = []
  for (const r of RESOURCE_IDS) {
    const res = v.resources[r]
    if (!isFiniteDecimal(res) || res.lt(0) || res.gt(v.storageCap)) sanity.push(`capital.${r}=${res.toString()}`)
  }
  if (!Number.isInteger(target.level) || target.level < 1 || target.level > MAX_TARGET_LEVEL) {
    sanity.push(`camp level out of range: ${target.level}`)
  }
  const army0 = checkArmyConsistency(state)
  if (!army0.ok) sanity.push(`army-consistency: ${army0.detail ?? 'failed'}`)

  // target is the LIVE world object the engine mutates in place, so its level now reflects any
  // catapult razing applied at resolution.
  return {
    won: dispatched && sawAttack && lastWon,
    before,
    after: target.level,
    sane: sanity.length === 0,
    sanity: sanity.length ? sanity.join('; ') : undefined,
  }
}

/**
 * TARAN cracks a wall (M5.3): an attack carrying rams beats a camp that the SAME army WITHOUT
 * rams cannot, purely because the rams lower the camp's EFFECTIVE defence
 * ({@link ramDefenseFactor}). Builds an axeman core sized so its attack power — even with the
 * rams' own (small) attack ADDED — stays at or below the camp's FULL wall, so the only thing
 * that can flip a loss into a win is the defence reduction, not the rams' attack. Then asserts,
 * both as a pure deterministic {@link battleOutcome} comparison AND through the real engine:
 *
 *  - the ram factor genuinely lowers the wall (effDef < fullDef), AND
 *  - the ramless core LOSES at full defence (battleOutcome attackerWins false), AND
 *  - the ram column would STILL lose at full defence (isolation: its win is not its attack), AND
 *  - the ram column WINS once the wall is reduced (battleOutcome attackerWins true), AND
 *  - the engine resolves a WON attack for the ram column but a LOST one for the ramless core.
 *
 * Value-driven: the band is derived from the LIVE camp defence, so a Balance retune of the
 * camp / ram curves still passes as long as a ram column genuinely cracks a wall the ramless
 * army can't. Pure / deterministic — no bot, no RNG.
 */
export function checkRamCracks(seed: string): InvariantResult {
  const issues: string[] = []

  const ref = createInitialState(seed, 0)
  const target = targetOfLevel(ref.world, RAM_CRACK_LEVEL)
  const fullDef = barbarianTarget(target.level).defensePower
  const axeAtk = UNITS.axeman.attack
  const ramAtk = UNITS.ram.attack

  // core·axeAtk + RAM_CRACK_RAMS·ramAtk <= fullDef  ⇒  even the ram stack loses at FULL defence,
  // so a win can only come from the wall reduction. Math.max guards a (here-impossible) tiny camp.
  const core = Math.max(1, Math.floor((fullDef - RAM_CRACK_RAMS * ramAtk) / axeAtk))
  const ramArmy = zeroArmy()
  ramArmy.axeman = core
  ramArmy.ram = RAM_CRACK_RAMS
  const coreArmy = zeroArmy()
  coreArmy.axeman = core

  const factor = ramDefenseFactor(ramArmy)
  const effDef = fullDef * factor

  // Pure deterministic effDef proof (RNG-free, mirrors the engine's resolution arithmetic).
  const ramlessWinsFull = battleOutcome(armyAttackPower(coreArmy), fullDef).attackerWins
  const ramWinsFull = battleOutcome(armyAttackPower(ramArmy), fullDef).attackerWins
  const ramWinsReduced = battleOutcome(armyAttackPower(ramArmy), effDef).attackerWins
  if (!(factor < 1 && effDef < fullDef)) {
    issues.push(`ram factor did not lower the wall (effDef ${effDef} !< fullDef ${fullDef})`)
  }
  if (ramlessWinsFull) issues.push('ramless core unexpectedly beat the full wall')
  if (ramWinsFull) issues.push('ram column would win at full defence too — win not attributable to the wall reduction')
  if (!ramWinsReduced) issues.push('ram column did not crack the reduced wall')

  // Engine proof: the SAME two armies, resolved through sendAttack + simulate.
  const engineRam = resolveSiegeAttack(seed, RAM_CRACK_LEVEL, ramArmy)
  const engineCore = resolveSiegeAttack(seed, RAM_CRACK_LEVEL, coreArmy)
  if (!engineRam.won) issues.push('engine: ram column failed to take the camp')
  if (engineCore.won) issues.push('engine: ramless core unexpectedly took the camp')
  if (!engineRam.sane) issues.push(`ram-column state unsound: ${engineRam.sanity}`)
  if (!engineCore.sane) issues.push(`ramless-core state unsound: ${engineCore.sanity}`)

  return {
    name: 'ram-cracks',
    ok: issues.length === 0,
    detail:
      issues.length === 0
        ? `${core} axemen + ${RAM_CRACK_RAMS} rams cracked tier-${target.level} (wall ${fullDef} -> ${Math.round(effDef)}); same army ramless loses`
        : issues.join('; '),
  }
}

/** Camp tier razed (well above 1 so before > after is unambiguous). */
const CATA_RAZE_LEVEL = 10
/** Catapults that raze the tier above: floor(10 / CATA_PER_LEVEL=5) = 2 levels (< the cap). */
const CATA_RAZE_CATS = 10
/** Low camp + an OVER-cap catapult column to drive the >= 1 clamp (raw damage would go below 1). */
const CATA_CLAMP_LEVEL = 2
/** floor(20 / 5) = 4 → capped at CATA_MAX_LEVELS = 3 → level 2 − 3 = −1 → clamped to 1. */
const CATA_CLAMP_CATS = 20
/** A winning core that beats every tier used here with room to spare (100·40 = 4000 attack). */
const CATA_WIN_CORE = 100

/**
 * KATAPULTA razes a camp (M5.3): a WON attack carrying catapults PERMANENTLY lowers the live
 * target's camp level by {@link catapultLevelDamage}, clamped to >= 1 (never razed out of
 * existence), while a catapult-LESS win and a LOST attack leave the level untouched. Drives
 * four real-engine scenarios through {@link resolveSiegeAttack} and asserts:
 *
 *  - RAZE:  a won catapult attack on a tier-{@link CATA_RAZE_LEVEL} camp drops its level by
 *           exactly catapultLevelDamage(catapults) (before > after), AND
 *  - CLAMP: an over-cap catapult column on a low camp lands the level at exactly 1 (never < 1)
 *           even though the raw damage would push it below, AND
 *  - CONTROL (no raze on a catapult-less win): an identical winning army with NO catapults
 *           leaves the camp level unchanged, AND
 *  - CONTROL (no raze on a loss): an attack that LOSES leaves the level unchanged (razing is
 *           win-only).
 *
 * Value-driven (the expected drop is read from {@link catapultLevelDamage}, not hard-coded), so
 * a Balance retune of CATA_PER_LEVEL / CATA_MAX_LEVELS still passes. Pure / deterministic.
 */
export function checkCatapultRazes(seed: string): InvariantResult {
  const issues: string[] = []

  const dmg = catapultLevelDamage({ ...zeroArmy(), catapult: CATA_RAZE_CATS })

  // RAZE: a won catapult attack lowers the camp level by exactly `dmg`.
  const razeArmy = zeroArmy()
  razeArmy.axeman = CATA_WIN_CORE
  razeArmy.catapult = CATA_RAZE_CATS
  const raze = resolveSiegeAttack(seed, CATA_RAZE_LEVEL, razeArmy)
  if (!raze.won) issues.push('catapult attack did not win (a loss cannot raze)')
  if (!(raze.before > raze.after)) issues.push(`raze did not lower the level (${raze.before} -> ${raze.after})`)
  if (raze.after !== raze.before - dmg) {
    issues.push(`razed ${raze.before - raze.after} levels, expected ${dmg}`)
  }

  // CLAMP: an over-cap column on a low camp lands at exactly 1, never below.
  const clampArmy = zeroArmy()
  clampArmy.axeman = CATA_WIN_CORE
  clampArmy.catapult = CATA_CLAMP_CATS
  const clamp = resolveSiegeAttack(seed, CATA_CLAMP_LEVEL, clampArmy)
  if (!clamp.won) issues.push('clamp scenario did not win')
  if (clamp.after < 1) issues.push(`camp razed below 1 (level ${clamp.after}) — clamp failed`)
  if (clamp.after !== 1) issues.push(`clamp expected level 1, got ${clamp.after}`)
  if (!(clamp.before > clamp.after)) issues.push('clamp scenario did not lower the level')

  // CONTROL: an identical WIN with no catapults must NOT raze.
  const noCatArmy = zeroArmy()
  noCatArmy.axeman = CATA_WIN_CORE
  const noCat = resolveSiegeAttack(seed, CATA_RAZE_LEVEL, noCatArmy)
  if (!noCat.won) issues.push('catapult-less control did not win')
  if (noCat.after !== noCat.before) issues.push(`a catapult-less win changed the level (${noCat.before} -> ${noCat.after})`)

  // CONTROL: a LOSS (catapults alone, far too weak) must NOT raze.
  const lossArmy = zeroArmy()
  lossArmy.catapult = CATA_RAZE_CATS
  const loss = resolveSiegeAttack(seed, CATA_RAZE_LEVEL, lossArmy)
  if (loss.won) issues.push('loss control unexpectedly won')
  if (loss.after !== loss.before) issues.push(`a LOST attack razed the level (${loss.before} -> ${loss.after})`)

  // No scenario may leave the state unsound (NaN / negative / over-cap loot, unbalanced army,
  // or a camp level driven out of range by the raze/clamp).
  for (const [label, res] of [
    ['raze', raze],
    ['clamp', clamp],
    ['no-catapult', noCat],
    ['loss', loss],
  ] as const) {
    if (!res.sane) issues.push(`${label} state unsound: ${res.sanity}`)
  }

  return {
    name: 'catapult-razes',
    ok: issues.length === 0,
    detail:
      issues.length === 0
        ? `won attack razed tier ${raze.before} -> ${raze.after} (−${dmg}); clamp held at ${clamp.after}; catapult-less/lost attacks left the level intact`
        : issues.join('; '),
  }
}

/**
 * Put a fresh state into the M5.3 siege offline-parity scenario: a barracks + academy standing,
 * a mixed home garrison (so raids fire across the span), AND an in-flight SIEGE attack carrying
 * BOTH rams and catapults at a mid-tier camp whose round trip fits the offline window — so the
 * ram wall-crack at resolution AND the catapult level-raze cross the offline/online boundary.
 * Applied identically to both branches of {@link checkM53Determinism}, so the only thing it can
 * reveal is a genuine siege online-vs-offline split. Mirrors {@link seedM52}'s discipline.
 */
function seedM53(state: GameState): void {
  const v = firstVillage(state)
  v.resources = { wood: D(1e6), clay: D(1e6), iron: D(1e6) }
  v.buildings.barracks = 1
  v.buildings.academy = 1
  recomputeDerived(state)
  v.popCap = D(1000)
  v.units.spearman = 20
  v.units.axeman = 60
  v.units.ram = 15
  v.units.catapult = 10
  // In-flight siege at the nearest mid-tier camp: rams crack its wall and catapults raze its
  // level at resolution — both must replay identically whether the span is one step or many.
  const army = zeroArmy()
  army.axeman = 40
  army.ram = 15
  army.catapult = 10
  sendAttack(v, state.world, state.battleLog, targetOfLevel(state.world, 5).id, army)
}

/**
 * M5.3 offline/online parity: crediting a span as one big {@link simulate} (online catch-up)
 * must be byte-identical to the chunked offline path ({@link applyOffline}) WITH a siege march
 * (rams + catapults) in flight. Mirrors {@link checkM52Determinism} but seeds {@link seedM53},
 * so the ram wall-reduction AND the catapult level-raze (a permanent world mutation) are
 * exercised in BOTH branches and proven to replay identically — the determinism the brief
 * requires for the new mechanics. `seconds` stays within
 * {@link import('../src/engine/offline').MAX_OFFLINE_SECONDS} (the caller uses an hour, ample
 * for the tier-5 round trip to resolve in both branches).
 */
export function checkM53Determinism(seed: string, seconds: number): InvariantResult {
  const big = createInitialState(seed, 0)
  seedM53(big)
  simulate(big, seconds)
  big.lastSeen = seconds * 1000 // mirror the bookkeeping applyOffline performs

  const chunked = createInitialState(seed, 0)
  seedM53(chunked)
  applyOffline(chunked, seconds * 1000) // lastSeen starts at 0

  const a = serialize(big)
  const b = serialize(chunked)
  const ok = a === b
  return {
    name: 'm53-determinism',
    ok,
    detail: ok
      ? undefined
      : 'chunked offline catch-up diverged from a single-step simulate WITH a siege march (rams + catapults) in flight',
  }
}

// --- M5.4 lifetime stats + achievements coverage -----------------------------------------
//
// The lifetime {@link Stats} counters and the {@link GameState.achievements} unlock map are
// bumped / evaluated ONLY on the deterministic tick path (systems bump state.stats; tick.ts's
// subStep runs checkAchievements last), never from the UI — so they grow byte-identically
// online / offline / sim. These checks cover the M5.4 brief: (a) the counters actually
// ACCUMULATE over a run and are well-formed (no NaN / negative / non-integer; lootHauled a
// finite non-negative Decimal); (b) a sensible NUMBER of achievements unlock; (c) the
// counters + unlocks are IDENTICAL online vs chunked-offline (and, via the existing whole-state
// `determinism` / `save-load-continuation` checks run on three seeds, across seeds), with the
// unlock set SETTLED (every satisfied condition already stamped). Achievements grant no gameplay
// bonus in v1, so none of this can move the 17 balance goals — the bot's main run is untouched.

/**
 * The eight INTEGER lifetime counters of {@link Stats} (everything except the Decimal
 * `lootHauled`). Listed once so {@link checkStats} and {@link statsSnapshot} agree on exactly
 * which fields are plain non-negative-integer counters. `lootHauled` is validated / snapshotted
 * separately because it is a big-number Decimal.
 */
const STAT_COUNTER_KEYS = [
  'attacksWon',
  'attacksLost',
  'raidsRepelled',
  'raidsLost',
  'campsRazed',
  'scoutsReturned',
  'villagesFounded',
  'villagesConquered',
] as const satisfies readonly (keyof Stats)[]

/**
 * Lifetime {@link Stats} are WELL-FORMED (M5.4): every integer counter is a finite,
 * non-negative integer and `lootHauled` is a finite, non-negative Decimal. A FAIL means a
 * counter went NaN / negative / fractional (e.g. a bad decrement, or a Decimal haul that
 * overflowed to Infinity) — the lifetime record must never be corrupt, since achievements read
 * it. Sampled like {@link checkRoundTrip} throughout the run and at the end.
 */
export function checkStats(state: GameState): InvariantResult {
  const issues: string[] = []
  const s = state.stats
  for (const k of STAT_COUNTER_KEYS) {
    const n = s[k]
    if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) issues.push(`${k}=${n}`)
  }
  if (!isFiniteDecimal(s.lootHauled) || s.lootHauled.lt(0)) {
    issues.push(`lootHauled=${s.lootHauled.toString()}`)
  }
  return {
    name: 'stats-valid',
    ok: issues.length === 0,
    detail: issues.length ? `invalid lifetime stat(s): ${issues.join(', ')}` : undefined,
  }
}

/**
 * The {@link GameState.achievements} map is WELL-FORMED and SETTLED (M5.4):
 *  - every KEY is a known {@link ACHIEVEMENT_IDS} id (an unknown id means something other than
 *    checkAchievements wrote the map — the save validator rejects these too);
 *  - every VALUE is a finite positive integer (the deterministic 1-based unlock ordinal);
 *  - SETTLED: re-running {@link checkAchievements} on a CLONE (via the save round-trip, so the
 *    real state is never mutated) unlocks NOTHING new — i.e. every achievement whose pure
 *    condition holds for the final (state, stats) is ALREADY stamped. This proves the tick path
 *    keeps the unlock set in lock-step with the conditions (no satisfied-but-unlocked gap), and
 *    that the conditions are total (none threw) on a real, mature state.
 */
export function checkAchievementsValid(state: GameState): InvariantResult {
  const issues: string[] = []
  const known = new Set<string>(ACHIEVEMENT_IDS)
  for (const id of Object.keys(state.achievements)) {
    if (!known.has(id)) issues.push(`unknown id "${id}"`)
    const marker = state.achievements[id]
    if (!Number.isFinite(marker) || !Number.isInteger(marker) || marker < 1) {
      issues.push(`${id} marker=${marker}`)
    }
  }
  // SETTLED: a satisfied condition must already be unlocked. Clone first so this stays a pure
  // read of `state` (checkAchievements mutates the achievements map it is given).
  const late = checkAchievements(deserialize(serialize(state)))
  if (late.length > 0) issues.push(`unsettled (condition holds but not unlocked): ${late.join(', ')}`)
  return {
    name: 'achievements-valid',
    ok: issues.length === 0,
    detail: issues.length ? issues.join('; ') : undefined,
  }
}

/**
 * Lifetime counters ACTUALLY ACCUMULATED over a run (M5.4): the self-propelling combat loop
 * GUARANTEES the bot wins attacks (a loot source), hauls resources home, and weathers raids, so
 * a finished MAIN run must show attacksWon > 0, lootHauled > 0 and at least one raid resolved.
 * A FAIL means the deterministic stat path never fired — the counters are not being bumped on
 * the tick path (or the loop stopped producing combat), which the brief flags as a regression.
 * Only the loop-guaranteed counters are asserted hard here; scout / siege / expansion counters
 * are exercised by {@link checkM54Determinism} (siege+scout) and the cross-check in the runner
 * (founding / conquest), since the bot does not field scouts or siege.
 */
export function checkStatsAccumulated(state: GameState): InvariantResult {
  const s = state.stats
  const raidsResolved = s.raidsRepelled + s.raidsLost
  const issues: string[] = []
  if (!(s.attacksWon > 0)) issues.push('attacksWon == 0')
  if (!s.lootHauled.gt(0)) issues.push('lootHauled == 0')
  if (!(raidsResolved > 0)) issues.push('no raids resolved')
  return {
    name: 'stats-accumulated',
    ok: issues.length === 0,
    detail: issues.length
      ? `lifetime counters did not accumulate over the run: ${issues.join(', ')}`
      : `attacksWon=${s.attacksWon} lootHauled=${s.lootHauled.toString()} raidsResolved=${raidsResolved}`,
  }
}

/**
 * A SENSIBLE number of achievements unlocked over a run (M5.4): a mature MAIN run builds deep,
 * wins many battles, hauls loot, expands and buys far into the tech tree, so it must cross at
 * least `min` of the 30 thresholds. A proof-of-mechanic floor (like the automation floors), set
 * well below a healthy run's measured count, so normal play passes but a broken achievement
 * engine / catalogue (nothing unlocks) fails the run.
 */
export function checkAchievementsUnlocked(state: GameState, min: number): InvariantResult {
  const n = Object.keys(state.achievements).length
  return {
    name: 'achievements-unlocked',
    ok: n >= min,
    detail: `unlocked ${n}/${ACHIEVEMENT_IDS.length} achievement(s) (target >= ${min})`,
  }
}

/**
 * Put a fresh capital into a deterministic scenario that drives EVERY lifetime-stat path the
 * bot's own run does not — used by {@link checkM54Determinism}. One catapult-bearing attack at a
 * winnable mid-tier camp (a WON fight that hauls loot AND razes a level → attacksWon + lootHauled
 * + campsRazed), one scout round-trip (scoutsReturned), and — because units are present — active
 * raids (raidsRepelled / raidsLost). Units / resources are seeded directly (price-independent);
 * barracks+academy are set only so the dispatch gates pass. Pure, Node-safe, deterministic; applied
 * identically to both branches so the only thing it can reveal is a genuine online/offline split.
 */
function seedM54(state: GameState): void {
  const v = firstVillage(state)
  v.resources = { wood: D(1e7), clay: D(1e7), iron: D(1e7) }
  v.buildings.barracks = 1
  v.buildings.academy = 1 // siege gate (units seeded directly, but keep the scenario honest)
  recomputeDerived(state)
  v.popCap = D(1e5)
  v.units.axeman = 150
  v.units.catapult = 12
  v.units.scout = 6
  // Catapult column at a winnable tier-6 camp: a clean WIN that delivers loot on return and
  // permanently razes a level off the camp — attacksWon, lootHauled and campsRazed all bump.
  const army = zeroArmy()
  army.axeman = 120
  army.catapult = 12
  sendAttack(v, state.world, state.battleLog, targetOfLevel(state.world, 6).id, army)
  // A scout round-trip at a nearer low camp → scoutsReturned (no fight, no loot, no losses).
  sendScout(v, state.world, state.battleLog, targetOfLevel(state.world, 3).id, 6)
}

/**
 * A stable, JSON string of JUST the lifetime stats + achievements of `state` — the Decimal
 * `lootHauled` as its exact string, the integer counters in {@link STAT_COUNTER_KEYS} order, and
 * the achievements map with its keys sorted (so iteration order can never make two equal maps
 * compare unequal). {@link checkM54Determinism} compares this across the online and offline
 * branches to isolate a stats/achievements divergence specifically.
 */
function statsSnapshot(state: GameState): string {
  const s = state.stats
  const stats: Record<string, string | number> = { lootHauled: s.lootHauled.toString() }
  for (const k of STAT_COUNTER_KEYS) stats[k] = s[k]
  const ach: Record<string, number> = {}
  for (const id of Object.keys(state.achievements).sort()) ach[id] = state.achievements[id]
  return JSON.stringify({ stats, ach })
}

/**
 * M5.4 offline/online parity for the lifetime stats + achievements: the counters are bumped in
 * the systems and the unlock pass runs in subStep, so crediting a span as one big {@link simulate}
 * (online catch-up) must leave the SAME counters and the SAME unlock set as the chunked offline
 * path ({@link applyOffline}). Both branches start from the identical {@link seedM54} scenario, so
 * any divergence is a real online/offline split. The check ALSO asserts NON-VACUITY — the scenario
 * must have driven every stat path (a win + loot + a raze + a scout + a resolved raid + >= 1
 * unlock) — so "identical" can never pass by both branches doing nothing. `seconds` stays within
 * {@link import('../src/engine/offline').MAX_OFFLINE_SECONDS} (the caller uses an hour, ample for
 * both the attack and the scout to complete their round trips in either branch).
 */
export function checkM54Determinism(seed: string, seconds: number): InvariantResult {
  const big = createInitialState(seed, 0)
  seedM54(big)
  simulate(big, seconds)
  big.lastSeen = seconds * 1000 // mirror the bookkeeping applyOffline performs

  const chunked = createInitialState(seed, 0)
  seedM54(chunked)
  applyOffline(chunked, seconds * 1000) // lastSeen starts at 0

  const equal = statsSnapshot(big) === statsSnapshot(chunked)

  // Non-vacuity: the scenario must actually have moved every path, else equality is meaningless.
  // Asserted on the big-step branch (== chunked once equality holds).
  const s = big.stats
  const unlocked = Object.keys(big.achievements).length
  const drove =
    s.attacksWon > 0 &&
    s.lootHauled.gt(0) &&
    s.campsRazed > 0 &&
    s.scoutsReturned > 0 &&
    s.raidsRepelled + s.raidsLost > 0 &&
    unlocked > 0

  const ok = equal && drove
  return {
    name: 'm54-determinism',
    ok,
    detail: ok
      ? `stats+achievements identical online vs chunked-offline (won ${s.attacksWon}, loot ${s.lootHauled.toString()}, razed ${s.campsRazed}, scouts ${s.scoutsReturned}, raids ${s.raidsRepelled + s.raidsLost}, ${unlocked} achievement(s))`
      : !equal
        ? 'lifetime stats / achievements diverged between a single-step simulate and chunked offline catch-up'
        : 'M5.4 scenario failed to drive every stat path (vacuous determinism check)',
  }
}

// --- M5.5 combat luck (variance + auto-attack safety + determinism) coverage ---------------
//
// Combat LUCK (M5.5) multiplies the ATTACKER's power by one symmetric +/-COMBAT_LUCK roll on
// every RESOLVED engagement (player attack in advanceMarches, incoming raid in advanceRaids),
// drawn EXACTLY ONCE per resolution from the persisted, seeded `rngState` advanced on the fixed
// tick grid (see tick.ts subStep) — so it adds real variance yet stays fully deterministic.
// These four deterministic proof-of-mechanic checks cover the M5.5 brief:
//   (a) luck-distribution / luck-varies — luck IS the contracted +/-25% band (mean ~1.0) and
//       it genuinely changes outcomes (the same attack wins or loses depending on the roll);
//   (b) auto-attack-luck-safe — auto-attack NEVER loses its army to bad luck (it plans against
//       WORST_LUCK), while a luck-losable army is correctly refused;
//   (c) luck-determinism — the luck-driven combat replays byte-identically online vs
//       chunked-offline with rngState advancing in lock-step (run per seed → across-seed too).
// The MAIN bot run is untouched: luck is symmetric (mean 1.0) and the bot keeps a worst-luck-safe
// loss margin, so the 17 balance goals stay measured exactly (verified by the balance warnings).

/** How many luckFactor draws the distribution check samples (a stable, deterministic spread). */
const LUCK_SAMPLES = 4000

/**
 * luckFactor's DISTRIBUTION is the contracted symmetric +/-{@link COMBAT_LUCK} band (M5.5): every
 * draw lands in [{@link WORST_LUCK}, {@link BEST_LUCK}], the sample mean is ~1.0 (so over many
 * fights luck nets out and the 17 balance goals hold), and BOTH halves (below and above 1.0) are
 * actually produced. Also re-asserts the +/-25% knob. Pure: draws from one seeded RNG, per seed.
 */
export function checkLuckDistribution(seed: string): InvariantResult {
  const rng = RNG.fromString(seed + ':luckdist')
  let min = Infinity
  let max = -Infinity
  let sum = 0
  let below = 0
  let above = 0
  let outOfBand = 0
  for (let i = 0; i < LUCK_SAMPLES; i++) {
    const f = luckFactor(rng)
    if (!Number.isFinite(f) || f < WORST_LUCK || f > BEST_LUCK) outOfBand += 1
    if (f < min) min = f
    if (f > max) max = f
    if (f < 1) below += 1
    if (f > 1) above += 1
    sum += f
  }
  const mean = sum / LUCK_SAMPLES
  const issues: string[] = []
  if (outOfBand > 0) issues.push(`${outOfBand} draw(s) outside [${WORST_LUCK}, ${BEST_LUCK}]`)
  if (!(below > 0 && above > 0)) issues.push(`one-sided spread (below ${below}, above ${above})`)
  if (Math.abs(mean - 1) > 0.02) issues.push(`mean ${mean.toFixed(4)} not ~1.0 (luck must net out)`)
  if (Math.abs(COMBAT_LUCK - 0.25) > 1e-9) issues.push(`COMBAT_LUCK ${COMBAT_LUCK} != 0.25 (+/-25%)`)
  return {
    name: 'luck-distribution',
    ok: issues.length === 0,
    detail:
      issues.length === 0
        ? `${LUCK_SAMPLES} draws in [${min.toFixed(3)}, ${max.toFixed(3)}], mean ${mean.toFixed(4)} (+/-${(COMBAT_LUCK * 100).toFixed(0)}%)`
        : issues.join('; '),
  }
}

/** Horizon (game-seconds) a luck-coverage attack is simulated for — past any tier round trip. */
const LUCK_HORIZON = 6000

/**
 * Resolve ONE attack carrying `army` at a tier-`level` camp on a fresh seeded capital with the
 * persisted luck stream pinned to `rngState`, raids frozen out so the attack is the ONLY luck
 * draw (so the recorded `luck` is exactly the first draw of RNG(rngState)). Returns the engine's
 * verdict (`won`) and the luck it rolled off the report, or null if the dispatch failed. Pure /
 * deterministic for a given (seed, rngState).
 */
function resolveLuckAttack(
  seed: string,
  rngState: number,
  level: number,
  army: Record<UnitId, number>,
): { won: boolean; luck: number } | null {
  const state = createInitialState(seed, 0)
  const v = firstVillage(state)
  v.buildings.barracks = 1
  recomputeDerived(state)
  v.resources = { wood: D(1e7), clay: D(1e7), iron: D(1e7) }
  v.popCap = D(1e5)
  v.raidTimer = 1e9 // freeze raids → the attack is the ONLY luck draw this run
  for (const id of UNIT_IDS) v.units[id] = army[id] ?? 0
  state.rngState = rngState >>> 0
  const target = targetOfLevel(state.world, level)
  const logBefore = state.battleLog.length
  if (!sendAttack(v, state.world, state.battleLog, target.id, army)) return null
  simulate(state, LUCK_HORIZON)
  for (let i = state.battleLog.length - 1; i >= logBefore; i--) {
    const r = state.battleLog[i]
    if (r.kind === 'attack') return { won: r.won, luck: r.luck ?? 1 }
  }
  return null
}

/** Camp tier the variance check assaults — mid-tier so a power≈wall army straddles the luck band. */
const LUCK_VARY_LEVEL = 8
/** rngStates the variance check sweeps — enough to all-but-certainly hit both halves of the band. */
const LUCK_VARY_SWEEP = 48

/**
 * Combat luck genuinely CHANGES outcomes (M5.5): the SAME dispatched attack — a MARGINAL army
 * whose power ≈ the camp's wall, so a +/-25% roll straddles the win line — WINS on a lucky roll
 * and LOSES on an unlucky one. Sweeps {@link LUCK_VARY_SWEEP} rngStates through the real engine
 * ({@link resolveLuckAttack}) and asserts: at least one win AND one loss occurred (outcome
 * varies), every recorded luck is in band, the rolls actually varied, and — the monotone sanity
 * — the LUCKIEST roll won while the UNLUCKIEST lost. Value-driven (the army is sized from the
 * live wall), so a balance retune still passes. Pure / deterministic.
 */
export function checkLuckVaries(seed: string): InvariantResult {
  const level = LUCK_VARY_LEVEL
  const def = barbarianTarget(level).defensePower
  // armyAttackPower(core axemen) ≈ def → the luck multiplier decides the fight.
  const core = Math.max(1, Math.round(def / UNITS.axeman.attack))
  const army = zeroArmy()
  army.axeman = core

  let wins = 0
  let losses = 0
  let outOfBand = 0
  let dispatched = 0
  const lucks: number[] = []
  let best: { won: boolean; luck: number } | null = null
  let worst: { won: boolean; luck: number } | null = null
  for (let k = 0; k < LUCK_VARY_SWEEP; k++) {
    const rngState = RNG.fromString(`${seed}:luckvary:${k}`).getState()
    const res = resolveLuckAttack(seed, rngState, level, army)
    if (res === null) continue
    dispatched += 1
    lucks.push(res.luck)
    if (res.won) wins += 1
    else losses += 1
    if (!Number.isFinite(res.luck) || res.luck < WORST_LUCK || res.luck > BEST_LUCK) outOfBand += 1
    if (best === null || res.luck > best.luck) best = res
    if (worst === null || res.luck < worst.luck) worst = res
  }
  const distinct = new Set(lucks.map((l) => l.toFixed(6))).size

  const issues: string[] = []
  if (dispatched === 0) issues.push('no attack dispatched (scenario invalid)')
  if (!(wins > 0 && losses > 0)) issues.push(`outcome did not vary (wins ${wins}, losses ${losses})`)
  if (outOfBand > 0) issues.push(`${outOfBand} luck roll(s) out of band`)
  if (distinct < 2) issues.push(`luck did not vary (${distinct} distinct value(s))`)
  if (best !== null && !best.won) issues.push(`luckiest roll (${best.luck.toFixed(3)}) still lost`)
  if (worst !== null && worst.won) issues.push(`unluckiest roll (${worst.luck.toFixed(3)}) still won`)

  return {
    name: 'luck-varies',
    ok: issues.length === 0,
    detail:
      issues.length === 0
        ? `same ${core}-axeman attack on tier-${level} (wall ${Math.round(def)}): ${wins} win / ${losses} loss over ${dispatched} rolls in [${worst!.luck.toFixed(3)}, ${best!.luck.toFixed(3)}]`
        : issues.join('; '),
  }
}

/**
 * Build a CONTROLLED auto-attack scenario on a fresh seeded capital: `axemen` idle at home, raids
 * frozen (so the ONLY thing that can change `v.units` is the auto-attack's own casualties), and
 * the generated world REPLACED by a SINGLE camp of tier `level` three fields east of the capital
 * — unambiguously the nearest (and only) target, so {@link autoAttackOnce} commits to it iff it
 * is worst-luck-safe. Pure / Node-safe; the bot never runs here, only the engine's idle routine.
 */
function seedAutoAttackWorld(seed: string, axemen: number, level: number): GameState {
  const state = createInitialState(seed, 0)
  const v = firstVillage(state)
  v.buildings.barracks = 1
  recomputeDerived(state)
  v.resources = { wood: D(1e7), clay: D(1e7), iron: D(1e7) }
  v.popCap = D(1e5)
  v.raidTimer = 1e9
  for (const id of UNIT_IDS) v.units[id] = 0
  v.units.axeman = axemen
  const cx = Math.min(WORLD_SIZE, v.x + 3)
  state.world.barbarians = [
    { id: 'lt', x: cx, y: v.y, level, name: 'Próba', loyalty: LOYALTY_MAX, scouted: true },
  ]
  return state
}

/** Σ owned units across the capital roster (units stay owned while marching — only casualties drop it). */
function capitalArmy(state: GameState): number {
  const v = firstVillage(state)
  let n = 0
  for (const id of UNIT_IDS) n += v.units[id]
  return n
}

/** Camp tier the auto-attack safety check assaults (mid-tier so the threshold army is non-trivial). */
const AUTOATTACK_LUCK_LEVEL = 8
/** rngStates the auto-attack safety check sweeps (covers the band down to near WORST_LUCK). */
const AUTOATTACK_LUCK_SWEEP = 64

/**
 * AUTO-ATTACK is luck-SAFE (M5.5): the idle auto-attack routine NEVER loses its army to bad luck,
 * because it vets every target against {@link WORST_LUCK} (the unluckiest roll) before committing.
 * Three deterministic legs against a controlled tier-{@link AUTOATTACK_LUCK_LEVEL} camp:
 *
 *  - THRESHOLD: find the smallest axeman stack the guard will COMMIT ({@link autoAttackOnce} is
 *    RNG-free, so this is stable), then sweep {@link AUTOATTACK_LUCK_SWEEP} rngStates through the
 *    real engine. EVERY roll must WIN and bring at least one survivor home — across the whole luck
 *    band, down to near worst luck (non-vacuity) — so the committed army is never lost.
 *  - REFUSAL: a luck-LOSABLE army (power ≈ the wall → it loses at worst luck, wins at best) must be
 *    REFUSED by the guard (no march), proving the plan is worst-case, not average-case.
 *  - DANGER (non-vacuity of the refusal): force-dispatching that SAME refused army through the
 *    engine LOSES the army on at least one unlucky roll (and wins on at least one lucky one) — so
 *    the refusal averted a real loss, not a phantom one.
 *
 * A regression that planned against AVERAGE luck would lower the threshold and the THRESHOLD sweep
 * would then record a bad-luck loss — failing the run. Value-driven; pure / deterministic.
 */
export function checkAutoAttackLuckSafe(seed: string): InvariantResult {
  const level = AUTOATTACK_LUCK_LEVEL
  const def = barbarianTarget(level).defensePower
  const axeAtk = UNITS.axeman.attack
  const issues: string[] = []

  // THRESHOLD: smallest committed army (the guard's worst-luck-safe floor). RNG-free decision.
  let nMin = 0
  for (let n = 1; n <= 200; n++) {
    const s = seedAutoAttackWorld(seed, n, level)
    if (autoAttackOnce(firstVillage(s), s.world, s.battleLog)) {
      nMin = n
      break
    }
  }
  if (nMin === 0) {
    return {
      name: 'auto-attack-luck-safe',
      ok: false,
      detail: `auto-attack never committed even at 200 axemen vs tier-${level} (guard too strict / unwinnable)`,
    }
  }

  // THRESHOLD sweep: the committed army must survive EVERY luck roll.
  let safeDispatched = 0
  let safeLost = 0
  let safeWiped = 0
  let safeMin = Infinity
  let safeMax = -Infinity
  for (let k = 0; k < AUTOATTACK_LUCK_SWEEP; k++) {
    const s = seedAutoAttackWorld(seed, nMin, level)
    const v = firstVillage(s)
    s.rngState = RNG.fromString(`${seed}:autoluck:${k}`).getState()
    const before = capitalArmy(s)
    if (!autoAttackOnce(v, s.world, s.battleLog)) continue
    const march = v.marches[v.marches.length - 1]
    let dispatchedTotal = 0
    for (const id of UNIT_IDS) dispatchedTotal += march.units[id]
    simulate(s, LUCK_HORIZON)
    safeDispatched += 1
    let won = false
    let luck = 1
    for (let i = s.battleLog.length - 1; i >= 0; i--) {
      const r = s.battleLog[i]
      if (r.kind === 'attack') {
        won = r.won
        luck = r.luck ?? 1
        break
      }
    }
    if (luck < safeMin) safeMin = luck
    if (luck > safeMax) safeMax = luck
    // survivors = owned_after − (owned_before − dispatched); with raids frozen the only delta to
    // v.units is the attack's casualties, so this is the dispatched stack's survivor count.
    const survivors = capitalArmy(s) - (before - dispatchedTotal)
    if (!won) safeLost += 1
    if (survivors < 1) safeWiped += 1
  }
  if (safeDispatched === 0) issues.push('threshold army never dispatched in the sweep')
  if (safeLost > 0) issues.push(`${safeLost}/${safeDispatched} committed auto-attacks LOST the army`)
  if (safeWiped > 0) issues.push(`${safeWiped}/${safeDispatched} committed auto-attacks attrited the army to zero`)
  if (!(safeMin <= WORST_LUCK + 0.05)) issues.push(`sweep never reached worst luck (min ${safeMin.toFixed(3)})`)

  // REFUSAL + DANGER: a luck-losable army (power ≈ wall) must be refused, and is genuinely risky.
  const dangerAxe = Math.max(1, Math.round(def / axeAtk)) // power ≈ def → worst loses, best wins
  const dref = seedAutoAttackWorld(seed, dangerAxe, level)
  if (autoAttackOnce(firstVillage(dref), dref.world, dref.battleLog)) {
    issues.push(`guard COMMITTED a luck-losable ${dangerAxe}-axeman army (power ≈ wall ${Math.round(def)})`)
  }
  const dangerArmy = zeroArmy()
  dangerArmy.axeman = dangerAxe
  let dangerLoss = 0
  let dangerWin = 0
  for (let k = 0; k < AUTOATTACK_LUCK_SWEEP; k++) {
    const rngState = RNG.fromString(`${seed}:autodanger:${k}`).getState()
    const res = resolveLuckAttack(seed, rngState, level, dangerArmy)
    if (res === null) continue
    if (res.won) dangerWin += 1
    else dangerLoss += 1
  }
  if (dangerLoss === 0) issues.push('force-dispatched luck-losable army never lost (refusal would be vacuous)')
  if (dangerWin === 0) issues.push('force-dispatched marginal army never won (not actually luck-marginal)')

  return {
    name: 'auto-attack-luck-safe',
    ok: issues.length === 0,
    detail:
      issues.length === 0
        ? `committed ${nMin}-axeman auto-attack survived all ${safeDispatched} luck rolls [${safeMin.toFixed(3)}, ${safeMax.toFixed(3)}]; guard refused the ${dangerAxe}-axeman marginal army (forced: ${dangerLoss} loss / ${dangerWin} win)`
        : issues.join('; '),
  }
}

/**
 * Put a fresh capital into the M5.5 luck-determinism scenario: a home garrison so RAIDS fire
 * across the span (each draws one luck) PLUS an in-flight ATTACK that resolves within the window
 * (its resolution draws one luck) — so the persisted `rngState` genuinely advances and battle
 * reports carry `luck`. Applied identically to both branches of {@link checkLuckDeterminism}, so
 * the only thing it can reveal is a genuine luck online-vs-offline split. Mirrors
 * {@link seedRecruitment}'s discipline (resources / popCap set directly).
 */
function seedLuckCombat(state: GameState): void {
  const v = firstVillage(state)
  v.resources = { wood: D(1e6), clay: D(1e6), iron: D(1e6) }
  v.buildings.barracks = 1
  recomputeDerived(state)
  v.popCap = D(1000)
  v.units.axeman = 80 // home garrison → raids active across the span
  const army = {} as Record<UnitId, number>
  for (const id of UNIT_IDS) army[id] = 0
  army.axeman = 40
  sendAttack(v, state.world, state.battleLog, targetOfLevel(state.world, 6).id, army)
}

/**
 * M5.5 luck DETERMINISM: the luck stream is drawn only from the persisted, seeded `rngState`
 * advanced on the fixed tick grid (tick.ts subStep), so crediting a span as one big
 * {@link simulate} (online catch-up) must be byte-identical to the chunked offline path
 * ({@link applyOffline}) — same rngState, same outcomes. Mirrors {@link checkOfflineDeterminism}
 * but on the luck-driven {@link seedLuckCombat} scenario, and ALSO asserts NON-VACUITY: the
 * rngState actually ADVANCED (luck was drawn), at least one report carries a finite `luck`, and
 * the two branches' rngState match — so "identical" can never pass by drawing nothing. Run per
 * seed by the runner, covering the determinism-across-seeds clause. `seconds` stays within
 * {@link import('../src/engine/offline').MAX_OFFLINE_SECONDS} (the caller uses an hour).
 */
export function checkLuckDeterminism(seed: string, seconds: number): InvariantResult {
  const big = createInitialState(seed, 0)
  seedLuckCombat(big)
  const rng0 = big.rngState
  simulate(big, seconds)
  big.lastSeen = seconds * 1000 // mirror the bookkeeping applyOffline performs

  const chunked = createInitialState(seed, 0)
  seedLuckCombat(chunked)
  applyOffline(chunked, seconds * 1000) // lastSeen starts at 0

  const equal = serialize(big) === serialize(chunked)
  const advanced = big.rngState !== rng0
  const luckReports = big.battleLog.filter(
    (r) => (r.kind === 'attack' || r.kind === 'raid') && typeof r.luck === 'number' && Number.isFinite(r.luck),
  ).length
  const hasLuck = luckReports > 0
  const rngMatches = big.rngState === chunked.rngState
  const ok = equal && advanced && hasLuck && rngMatches
  return {
    name: 'luck-determinism',
    ok,
    detail: ok
      ? `luck stream identical online vs chunked-offline (rngState ${rng0} -> ${big.rngState}, ${luckReports} luck-tagged report(s))`
      : !equal
        ? 'chunked offline catch-up diverged from a single-step simulate WITH luck-driven combat (rngState / outcomes split)'
        : !advanced
          ? 'rngState never advanced — no luck was drawn (vacuous determinism check)'
          : !hasLuck
            ? 'no battle report carried a luck roll (luck not exercised)'
            : `rngState diverged online (${big.rngState}) vs offline (${chunked.rngState})`,
  }
}
