import { D, ZERO, isFiniteDecimal, type Decimal } from '../src/engine/decimal'
import { serialize, deserialize, exportSave, importSave, migrate } from '../src/engine/save'
import { simulate } from '../src/engine/tick'
import { applyOffline } from '../src/engine/offline'
import {
  createInitialState,
  recomputeDerived,
  RESOURCE_IDS,
  INITIAL_BUILDINGS,
  NO_TECH_MODS,
  HORDE_INTERVAL,
  EVENT_INTERVAL,
  EVENT_TTL,
  type GameState,
  type Stats,
  type Village,
  type World,
  type BarbarianVillage,
  type Fortress,
  type TechModifiers,
} from '../src/engine/state'
import { BUILDINGS, BUILDING_IDS } from '../src/content/buildings'
import { UNITS, UNIT_IDS, type UnitId } from '../src/content/units'
import { barbarianTarget, MAX_TARGET_LEVEL } from '../src/content/barbarians'
import { FORTRESS_COUNT, fortressTarget } from '../src/content/fortresses'
import { TECH_NODES, TECH_NODE_IDS, TECH_ROOTS } from '../src/content/tech'
import {
  PRESTIGE_NODES,
  PRESTIGE_NODE_IDS,
  PRESTIGE_ROOTS,
  type PrestigeArchetype,
} from '../src/content/prestige'
import {
  ERA_NODES,
  ERA_NODE_IDS,
  ERA_ROOTS,
  type EraArchetype,
} from '../src/content/era'
import { ACHIEVEMENT_IDS } from '../src/content/achievements'
import { checkAchievements } from '../src/systems/achievements'
import { freePopulation, recruit, canRecruit, unitUnlocked } from '../src/systems/recruitment'
import { sendAttack, sendScout } from '../src/systems/marches'
import {
  armyAttackPower,
  armyDefensePower,
  battleOutcome,
  ramDefenseFactor,
  catapultLevelDamage,
  luckFactor,
  COMBAT_LUCK,
  WORST_LUCK,
  BEST_LUCK,
} from '../src/systems/combat'
import {
  forgeBuilt,
  effectiveMaxUpgrade,
  unitUpgradeLevel,
  canUpgrade,
  upgradeUnit,
} from '../src/systems/forge'
import { unitUpgradeMult } from '../src/content/forge'
import { autoAttackOnce } from '../src/systems/automation'
import { advanceRaids } from '../src/systems/raids'
import { advanceHorde } from '../src/systems/hordes'
import { RNG } from '../src/engine/rng'
import { villageDefenseMult } from '../src/systems/buildings'
import { WORLD_SIZE, generateWorld } from '../src/systems/world'
import { LOYALTY_MAX } from '../src/systems/conquest'
import {
  techHasCycle,
  orphanNodes,
  deadPerkNodes,
  nodeLevel,
  prerequisitesMet,
} from '../src/systems/tech'
import {
  ascend,
  effectiveMods,
  prestigeHasCycle,
  orphanPrestigeNodes,
  deadPrestigeNodes,
  prestigeNodeLevel,
} from '../src/systems/prestige'
import { eraHasCycle, orphanEraNodes, deadEraNodes, newEra } from '../src/systems/era'
import {
  dynastyHasCycle,
  orphanDynastyNodes,
  deadDynastyNodes,
  newDynasty,
} from '../src/systems/dynasty'
import { startChallenge, checkChallengeCompletion } from '../src/systems/challenges'
import { CHALLENGES, CHALLENGE_IDS, type ChallengeMods } from '../src/content/challenges'
import {
  sendShipment,
  merchantCapacityInUse,
  canExchange,
  exchangeResources,
  exchangeRate,
} from '../src/systems/market'
import { foundVillage, findFoundingSpot } from '../src/systems/villages'
import { watchtowerBuilt, advanceEvents, claimEvent, aggregateEventBuffMods } from '../src/systems/events'
import { WORLD_EVENTS, WORLD_EVENTS_BY_ID } from '../src/content/events'
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

/**
 * Smallest centre-to-centre distance two DISTINCT era-node positions may have in the computed
 * layout before it counts as a gross overlap. The era tree is laid out by the SAME generic
 * radial algorithm as the tech / prestige trees, so it inherits the same generous floor
 * (mirrors {@link PRESTIGE_MIN_NODE_SEP}); it trips immediately if a topology / algorithm
 * change ever stacks two era nodes on the same spot.
 */
const ERA_MIN_NODE_SEP = 24

/** The maxLevel band each era archetype must sit in (CLAUDE.md tree rule, mirrors prestige). */
function eraBandOk(archetype: EraArchetype, maxLevel: number): boolean {
  return archetype === 'gateway'
    ? maxLevel === 1
    : archetype === 'notable'
      ? maxLevel >= 2 && maxLevel <= 3
      : maxLevel >= 7 && maxLevel <= 10 // minor
}

/**
 * STATIC era-tree invariants (M6.1) — pure functions of the {@link ERA_NODES} catalogue + the
 * generic {@link layoutNodes} layout, independent of any {@link GameState}, so the runner
 * asserts them ONCE per run (like {@link checkPrestigeTree}). A single FAIL is a commit
 * blocker: a malformed era tree would mis-drive the second meta-layer and the constellation
 * view. Mirrors checkPrestigeTree exactly, bound to the era data:
 *  - era-acyclic:        the prerequisite graph is a DAG — {@link eraHasCycle}.
 *  - era-no-orphans:     every node reachable from an {@link ERA_ROOTS} root — {@link orphanEraNodes}.
 *  - era-no-dead-perks:  every node has a real effect (perLevel > 0) — {@link deadEraNodes}.
 *  - era-maxlevel-range: every maxLevel is an integer in [1, 10].
 *  - era-archetype-band: maxLevel matches the archetype band (gateway 1 / notable 2-3 / minor 7-10).
 *  - era-roots:          ERA_ROOTS non-empty; every root exists and truly has no prerequisite.
 *  - era-layout-complete:   a FINITE position for every node id.
 *  - era-layout-no-overlap: no two distinct centres closer than {@link ERA_MIN_NODE_SEP}.
 *  - era-edges-valid:    every edge endpoint is a known node and the edge count equals the
 *                        total number of (known) prerequisite links.
 */
export function checkEraTree(): InvariantResult[] {
  const results: InvariantResult[] = []

  const cycle = eraHasCycle()
  results.push({
    name: 'era-acyclic',
    ok: !cycle,
    detail: cycle ? 'prerequisite graph contains a cycle (must be a DAG)' : undefined,
  })

  const orphans = orphanEraNodes()
  results.push({
    name: 'era-no-orphans',
    ok: orphans.length === 0,
    detail: orphans.length ? `unreachable from roots: ${orphans.join(', ')}` : undefined,
  })

  const dead = deadEraNodes()
  results.push({
    name: 'era-no-dead-perks',
    ok: dead.length === 0,
    detail: dead.length ? `no effect / perLevel<=0: ${dead.join(', ')}` : undefined,
  })

  const badLevel: string[] = []
  const badBand: string[] = []
  for (const id of ERA_NODE_IDS) {
    const node = ERA_NODES[id]
    const m = node.maxLevel
    if (!Number.isInteger(m) || m < 1 || m > 10) badLevel.push(`${id}=${m}`)
    if (!eraBandOk(node.archetype, m)) badBand.push(`${id}(${node.archetype})=${m}`)
  }
  results.push({
    name: 'era-maxlevel-range',
    ok: badLevel.length === 0,
    detail: badLevel.length ? `maxLevel out of [1,10]: ${badLevel.join(', ')}` : undefined,
  })
  results.push({
    name: 'era-archetype-band',
    ok: badBand.length === 0,
    detail: badBand.length ? `maxLevel off archetype band: ${badBand.join(', ')}` : undefined,
  })

  const rootIssues: string[] = []
  if (ERA_ROOTS.length === 0) rootIssues.push('no roots')
  for (const id of ERA_ROOTS) {
    const node = ERA_NODES[id]
    if (!node) rootIssues.push(`unknown root ${id}`)
    else if (node.prerequisites.length > 0) rootIssues.push(`root ${id} has prerequisites`)
  }
  results.push({
    name: 'era-roots',
    ok: rootIssues.length === 0,
    detail: rootIssues.length ? rootIssues.join('; ') : undefined,
  })

  const pos = layoutNodes(ERA_NODES, ERA_NODE_IDS)
  const missing: string[] = []
  for (const id of ERA_NODE_IDS) {
    const p = pos[id]
    if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) missing.push(id)
  }
  results.push({
    name: 'era-layout-complete',
    ok: missing.length === 0,
    detail: missing.length ? `no finite position for: ${missing.join(', ')}` : undefined,
  })

  let overlap: string | null = null
  for (let i = 0; i < ERA_NODE_IDS.length && overlap === null; i++) {
    const a = pos[ERA_NODE_IDS[i]]
    if (!a) continue
    for (let j = i + 1; j < ERA_NODE_IDS.length; j++) {
      const b = pos[ERA_NODE_IDS[j]]
      if (!b) continue
      const d = Math.hypot(a.x - b.x, a.y - b.y)
      if (d < ERA_MIN_NODE_SEP) {
        overlap = `${ERA_NODE_IDS[i]} & ${ERA_NODE_IDS[j]} only ${d.toFixed(1)} apart`
        break
      }
    }
  }
  results.push({
    name: 'era-layout-no-overlap',
    ok: overlap === null,
    detail: overlap ?? undefined,
  })

  let expectedEdges = 0
  for (const id of ERA_NODE_IDS) {
    for (const pre of ERA_NODES[id].prerequisites) if (pre in ERA_NODES) expectedEdges += 1
  }
  const edges = nodeEdges(ERA_NODES, ERA_NODE_IDS)
  const badEdge = edges.find((e) => !(e.from in ERA_NODES) || !(e.to in ERA_NODES))
  const edgeOk = badEdge === undefined && edges.length === expectedEdges
  results.push({
    name: 'era-edges-valid',
    ok: edgeOk,
    detail: edgeOk
      ? undefined
      : badEdge
        ? `edge with unknown endpoint ${badEdge.from}->${badEdge.to}`
        : `edge count ${edges.length} != prerequisite links ${expectedEdges}`,
  })

  return results
}

/** True when two era node maps hold the same keys at the same levels (order-independent). */
function sameEraNodes(a: Record<string, number>, b: Record<string, number>): boolean {
  const ak = Object.keys(a)
  const bk = Object.keys(b)
  if (ak.length !== bk.length) return false
  for (const k of ak) if (a[k] !== b[k]) return false
  return true
}

/**
 * Era round-trip (M6.1): the PERMANENT era account ({@link GameState.era} — EP balance,
 * lifetime totals, era count and the purchased era-tree levels) must survive the real
 * export/import (base64) path byte-for-byte. The whole-state {@link checkRoundTrip} already
 * proves serialize/deserialize is loss-free; this is the targeted proof that the v15 save
 * carries the era account specifically — the bit that SURVIVES every era reset (CLAUDE.md hard
 * rule #3). Compares the four fields (nodes order-independently). Pure function of the state.
 */
export function checkEraRoundTrip(state: GameState): InvariantResult {
  const restored = importSave(exportSave(state))
  const a = state.era
  const b = restored.era
  const ok =
    a.points === b.points &&
    a.totalEarned === b.totalEarned &&
    a.eras === b.eras &&
    sameEraNodes(a.nodes, b.nodes)
  return {
    name: 'era-round-trip',
    ok,
    detail: ok
      ? undefined
      : `era account changed across export/import: ` +
        `{points:${a.points},totalEarned:${a.totalEarned},eras:${a.eras}} -> ` +
        `{points:${b.points},totalEarned:${b.totalEarned},eras:${b.eras}}`,
  }
}

/**
 * newEra determinism (M6.1): the GREAT RESET takes no clock and draws its regenerated world +
 * rngState from a per-era seed (`seed + ':era' + N`), so two identical accounts performing a
 * Nowa Era must yield a byte-identical state — surviving era account, wiped prestige account,
 * regenerated world AND rngState all in lock-step. Mirrors the run-level 'determinism' /
 * 'prestige-determinism' checks but for the era primitive: two fresh states are seeded with the
 * SAME prestige progress (so {@link pendingEraPoints} > 0 and the reset actually fires), then
 * {@link newEra}'d and serialized; a divergence means newEra introduced hidden nondeterminism
 * (a clock read or an unseeded RNG). Self-contained (no runner import), Node-safe.
 */
export function checkNewEraDeterminism(seed: string): InvariantResult {
  const seedAccount = (s: GameState): void => {
    // Identical prestige progress on both copies so the EP yield (and thus the reset) is real.
    s.prestige.totalEarned = 100
    s.prestige.ascensions = 4
    s.prestige.nodes = { prosperity_root: 2 }
  }
  const a = createInitialState(seed, 0)
  const b = createInitialState(seed, 0)
  seedAccount(a)
  seedAccount(b)
  const epA = newEra(a)
  const epB = newEra(b)

  const serA = serialize(a)
  const serB = serialize(b)
  const ok = epA > 0 && epA === epB && serA === serB
  return {
    name: 'era-determinism',
    ok,
    detail: ok
      ? undefined
      : epA <= 0
        ? 'newEra banked no EP from the seeded prestige account (cannot test the reset)'
        : 'two newEra resets from the same seed diverged (era account / wiped prestige / world / rngState)',
  }
}

/**
 * Game-seconds the post-era capital is advanced by idle production before it MUST offer a
 * progress action, and the coarse step between availability probes. A just-reset capital starts
 * at the bare starting pool (50/50/50, EXACTLY like a fresh {@link createInitialState} start),
 * which is below even the cheapest build — so it has NOTHING affordable at the very instant and
 * only unlocks its first action after a few seconds of accrual (empirically ~4s on every seed).
 * The horizon is a generous, bounded multiple of that, so the guard still catches a PERMANENT
 * dead-end (an action that never appears) while never reading a FALSE stall on the normal
 * "wait for the first tick of production" instant — the exact trap {@link import('./runner')}'s
 * runEra documents when it skips the just-reset tick.
 */
const ERA_PLAYABILITY_HORIZON = 600
const ERA_PLAYABILITY_STEP = 5

/**
 * No softlock after a Nowa Era (M6.1): the great reset rebuilds the run as ONE fresh capital
 * (mirroring a fresh {@link createInitialState} start, which runContinuous already proves
 * playable), so it must never land in a PERMANENT stall. Seeds enough prestige progress that
 * {@link newEra} banks EP and fires, then asserts the reset run reaches a state with at least
 * one available progress action ({@link chooseAction} non-null) under the EFFECTIVE mods
 * (tech × prestige × era).
 *
 * Crucially it does NOT probe the BARE just-reset instant: a just-reset capital has accrued
 * nothing yet and sits at the bare starting pool, below the cheapest build, so NO action is
 * affordable for the first few seconds — exactly like a brand-new game, and exactly the FALSE
 * stall runner.runEra calls out (which is why it skips the just-reset tick). Instead we advance
 * the reset run by idle production over a BOUNDED horizon ({@link ERA_PLAYABILITY_HORIZON}) and
 * pass the moment an action appears; only a capital that NEVER unlocks one within the horizon is
 * a genuine softlock. The surviving era multipliers can only HELP (production accrues faster),
 * so this is the "a Nowa Era leaves the game grywalny" guard the era layer needs. Deterministic
 * (the advance draws only the seeded rngState newEra installed) and self-contained — no clock.
 */
export function checkEraNoSoftlock(seed: string): InvariantResult {
  const state = createInitialState(seed, 0)
  // Enough account-wide prestige progress that a Nowa Era can actually be banked.
  state.prestige.totalEarned = 100
  state.prestige.ascensions = 4
  const ep = newEra(state)
  if (ep <= 0) {
    return {
      name: 'era-no-softlock',
      ok: false,
      detail: 'newEra banked no EP from a seeded prestige account (cannot test post-era playability)',
    }
  }

  // True iff SOME village offers a progress action right now under the effective mods.
  const hasAction = (): boolean => {
    const mods = effectiveMods(state)
    for (const vid of state.villageOrder) {
      if (chooseAction(state.villages[vid], state.world, mods) !== null) return true
    }
    return false
  }

  // Probe immediately (an era start-resource head-start can make it playable at once), then let
  // idle production accrue in coarse steps until an action unlocks or the horizon is exhausted.
  let ok = hasAction()
  for (let t = 0; !ok && t < ERA_PLAYABILITY_HORIZON; t += ERA_PLAYABILITY_STEP) {
    simulate(state, ERA_PLAYABILITY_STEP)
    ok = hasAction()
  }

  return {
    name: 'era-no-softlock',
    ok,
    detail: ok
      ? undefined
      : `fresh post-era capital has no available build/recruit/attack action within ${ERA_PLAYABILITY_HORIZON}s of idle production`,
  }
}

// --- M6.2 dynasty (great-great reset / third meta-layer) invariants ----------------------------

/**
 * STATIC dynasty-tree TOPOLOGY (M6.2) — pure functions of the {@link import('../src/content/dynasty').DYNASTY_NODES}
 * catalogue, independent of any {@link GameState}, so the runner asserts it ONCE per run (like
 * {@link checkEraTree}). A single FAIL is a commit blocker: a malformed dynasty tree would
 * mis-drive the third meta-layer. Aggregates the three structural facts into one PASS/FAIL,
 * mirroring the era topology helpers:
 *  - acyclic:       the prerequisite graph is a DAG (no cycle) — {@link dynastyHasCycle}.
 *  - no orphans:    every node reachable from a {@link import('../src/content/dynasty').DYNASTY_ROOTS}
 *                   root via prerequisite edges — {@link orphanDynastyNodes}.
 *  - no dead perks: every node has a real effect ({@link deadDynastyNodes} treats the binary
 *                   `automation_unlock` gateway as a REAL effect, not dead).
 */
export function checkDynastyTopology(): InvariantResult {
  const issues: string[] = []
  if (dynastyHasCycle()) issues.push('prerequisite graph contains a cycle (must be a DAG)')
  const orphans = orphanDynastyNodes()
  if (orphans.length) issues.push(`unreachable from roots: ${orphans.join(', ')}`)
  const dead = deadDynastyNodes()
  if (dead.length) issues.push(`no effect / perLevel<=0: ${dead.join(', ')}`)
  return {
    name: 'dynasty-topology',
    ok: issues.length === 0,
    detail: issues.length ? issues.join('; ') : undefined,
  }
}

/** True when two dynasty node maps hold the same keys at the same levels (order-independent). */
function sameDynastyNodes(a: Record<string, number>, b: Record<string, number>): boolean {
  const ak = Object.keys(a)
  const bk = Object.keys(b)
  if (ak.length !== bk.length) return false
  for (const k of ak) if (a[k] !== b[k]) return false
  return true
}

/**
 * Dynasty round-trip (M6.2): the PERMANENT dynasty account ({@link GameState.dynasty} — DP
 * balance, lifetime totals, dynasty count and the purchased dynasty-tree levels) must survive the
 * real export/import (base64) path byte-for-byte. The whole-state {@link checkRoundTrip} already
 * proves serialize/deserialize is loss-free; this is the targeted proof that the v16 save carries
 * the dynasty account specifically — the bit that SURVIVES every reset of any kind (CLAUDE.md hard
 * rule #3). Compares the four fields (nodes order-independently). Mirrors {@link checkEraRoundTrip}.
 */
export function checkDynastyRoundTrip(state: GameState): InvariantResult {
  const restored = importSave(exportSave(state))
  const a = state.dynasty
  const b = restored.dynasty
  const ok =
    a.points === b.points &&
    a.totalEarned === b.totalEarned &&
    a.dynasties === b.dynasties &&
    sameDynastyNodes(a.nodes, b.nodes)
  return {
    name: 'dynasty-round-trip',
    ok,
    detail: ok
      ? undefined
      : `dynasty account changed across export/import: ` +
        `{points:${a.points},totalEarned:${a.totalEarned},dynasties:${a.dynasties}} -> ` +
        `{points:${b.points},totalEarned:${b.totalEarned},dynasties:${b.dynasties}}`,
  }
}

/**
 * Game-seconds the post-dynasty capital is advanced by idle production before it MUST offer a
 * progress action, and the coarse step between availability probes. Mirrors the era playability
 * horizon: a just-reset capital starts at the bare starting pool, below even the cheapest build,
 * so it only unlocks its first action after a few seconds of accrual — the horizon is a generous,
 * bounded multiple of that, catching a PERMANENT dead-end without reading a FALSE stall on the
 * normal "wait for the first tick of production" instant.
 */
const DYNASTY_PLAYABILITY_HORIZON = 600
const DYNASTY_PLAYABILITY_STEP = 5

/**
 * No softlock after a Nowa Dynastia (M6.2): the great-great reset rebuilds the run as ONE fresh
 * capital (mirroring a fresh {@link createInitialState} start, which runContinuous already proves
 * playable), so it must never land in a PERMANENT stall. Seeds enough ERA-account progress that
 * {@link newDynasty} banks DP and fires, then asserts the reset run reaches a state with at least
 * one available progress action ({@link chooseAction} non-null) under the EFFECTIVE mods (tech ×
 * prestige × era × dynasty).
 *
 * Crucially it does NOT probe the BARE just-reset instant: a just-reset capital has accrued nothing
 * yet and sits at the bare starting pool, below the cheapest build, so NO action is affordable for
 * the first few seconds — exactly like a brand-new game and exactly the FALSE stall the runner's
 * runDynasty skips. Instead we advance the reset run by idle production over a BOUNDED horizon
 * ({@link DYNASTY_PLAYABILITY_HORIZON}) and pass the moment an action appears; only a capital that
 * NEVER unlocks one within the horizon is a genuine softlock. The surviving dynasty multipliers can
 * only HELP (production accrues faster, and the automation gate — if owned — would also drive it),
 * so this is the "a Nowa Dynastia leaves the game grywalny" guard the dynasty layer needs.
 * Deterministic (the advance draws only the seeded rngState newDynasty installed) and self-contained.
 * Mirrors {@link checkEraNoSoftlock}.
 */
export function checkDynastyNoSoftlock(seed: string): InvariantResult {
  const state = createInitialState(seed, 0)
  // Enough account-wide era progress that a Nowa Dynastia can actually be banked.
  state.era.totalEarned = 100
  state.era.eras = 4
  const dp = newDynasty(state)
  if (dp <= 0) {
    return {
      name: 'dynasty-no-softlock',
      ok: false,
      detail: 'newDynasty banked no DP from a seeded era account (cannot test post-dynasty playability)',
    }
  }

  // True iff SOME village offers a progress action right now under the effective mods.
  const hasAction = (): boolean => {
    const mods = effectiveMods(state)
    for (const vid of state.villageOrder) {
      if (chooseAction(state.villages[vid], state.world, mods) !== null) return true
    }
    return false
  }

  // Probe immediately (a dynasty start-resource head-start can make it playable at once), then let
  // idle production accrue in coarse steps until an action unlocks or the horizon is exhausted.
  let ok = hasAction()
  for (let t = 0; !ok && t < DYNASTY_PLAYABILITY_HORIZON; t += DYNASTY_PLAYABILITY_STEP) {
    simulate(state, DYNASTY_PLAYABILITY_STEP)
    ok = hasAction()
  }

  return {
    name: 'dynasty-no-softlock',
    ok,
    detail: ok
      ? undefined
      : `fresh post-dynasty capital has no available build/recruit/attack action within ${DYNASTY_PLAYABILITY_HORIZON}s of idle production`,
  }
}

// --- M8 challenge (WYZWANIA — constrained run for a one-time permanent reward) invariants -------
//
// Deterministic proof-of-mechanic checks for the challenge layer (no bot, no clock, only the seeded
// world startChallenge installs). They isolate the challenge primitive's own guarantees: a started
// challenge resets the run reproducibly, its CONSTRAINT actually lowers the constrained stat, COMPLETION
// is one-time, the earned REWARD folds into every future run, the constrained run never softlocks, and
// the { activeId, completed } record survives the real save/load path. The MAIN + meta runs never start
// a challenge, so aggregateChallengeMods folds to identity there and their targets stay byte-identical
// to pre-M8 — these checks (and the SEPARATE runner.runChallenge) are where the feature is exercised.

/** Total production/second across every village + resource (Decimal) — the M8 economy probe. */
function totalProductionOf(state: GameState): Decimal {
  let total = ZERO
  for (const vid of state.villageOrder) {
    const v = state.villages[vid]
    for (const r of RESOURCE_IDS) total = total.add(v.production[r])
  }
  return total
}

/**
 * The issues where a {@link ChallengeMods} REWARD's present multiplicative axes are NOT strictly
 * raised in `post` vs `base`. An empty list = every present reward axis folded into effectiveMods
 * (the reward is live). Mirrors the per-axis shape of {@link ChallengeMods}; the reduction fractions
 * and automation flags are never used by a v1 challenge, so they are not checked.
 */
function challengeRewardRaised(base: TechModifiers, post: TechModifiers, reward: ChallengeMods): string[] {
  const issues: string[] = []
  if (reward.productionMult !== undefined) {
    for (const r of RESOURCE_IDS) {
      if (!(post.productionMult[r] > base.productionMult[r])) {
        issues.push(`productionMult.${r} ${base.productionMult[r]} !> ${post.productionMult[r]}`)
      }
    }
  }
  if (reward.storageMult !== undefined && !(post.storageMult > base.storageMult)) {
    issues.push(`storageMult ${base.storageMult} !> ${post.storageMult}`)
  }
  if (reward.popMult !== undefined && !(post.popMult > base.popMult)) {
    issues.push(`popMult ${base.popMult} !> ${post.popMult}`)
  }
  if (reward.attackMult !== undefined && !(post.attackMult > base.attackMult)) {
    issues.push(`attackMult ${base.attackMult} !> ${post.attackMult}`)
  }
  if (reward.defenseMult !== undefined && !(post.defenseMult > base.defenseMult)) {
    issues.push(`defenseMult ${base.defenseMult} !> ${post.defenseMult}`)
  }
  if (reward.lootMult !== undefined && !(post.lootMult > base.lootMult)) {
    issues.push(`lootMult ${base.lootMult} !> ${post.lootMult}`)
  }
  return issues
}

/**
 * startChallenge determinism (M8): STARTING a challenge takes no clock and draws its regenerated world
 * + rngState from a per-challenge seed (`seed + ':chal:' + id`), so two identical states starting the
 * SAME challenge must reset to a byte-identical run — same regenerated world, same installed rngState,
 * same whole serialized state. Mirrors {@link checkNewEraDeterminism} but for the challenge primitive:
 * a divergence means startChallenge introduced hidden nondeterminism (a clock read or an unseeded RNG).
 * Self-contained (no runner import), Node-safe.
 */
export function checkChallengeDeterminism(seed: string): InvariantResult {
  const id = CHALLENGE_IDS[0]
  const a = createInitialState(seed, 0)
  const b = createInitialState(seed, 0)
  const okA = startChallenge(a, id)
  const okB = startChallenge(b, id)
  const worldEq = JSON.stringify(a.world) === JSON.stringify(b.world)
  const rngEq = a.rngState === b.rngState
  const serEq = serialize(a) === serialize(b)
  const ok = okA && okB && worldEq && rngEq && serEq
  return {
    name: 'challenge-determinism',
    ok,
    detail: ok
      ? undefined
      : !okA || !okB
        ? `startChallenge refused to start ${id}`
        : !worldEq
          ? 'two startChallenge resets from the same seed produced different worlds'
          : !rngEq
            ? 'two startChallenge resets from the same seed produced different rngState'
            : 'two startChallenge resets from the same seed produced different serialized state',
  }
}

/**
 * The active challenge CONSTRAINT actually LOWERS the constrained stat (M8). Picks a challenge whose
 * constraint carries a production penalty (productionMult < 1), starts it on a fresh state (which RESETS
 * the run to a fresh capital under the constraint), and asserts both the effectiveMods production
 * multiplier on EVERY resource AND the recomputed total production/sec are strictly below an identical
 * UNCONSTRAINED fresh capital's. Both copies are fresh capitals with empty meta accounts, so the only
 * difference is the active constraint — a strictly lower value proves the constraint folds into the
 * economy via the same `combine` pipeline. Pure / deterministic (the only RNG is the seeded world).
 */
export function checkChallengeConstraint(seed: string): InvariantResult {
  const chal = CHALLENGES.find(
    (c) => typeof c.constraint.productionMult === 'number' && c.constraint.productionMult < 1,
  )
  if (!chal) {
    return { name: 'challenge-constraint', ok: false, detail: 'no challenge has a production-penalty constraint to test' }
  }
  const base = createInitialState(seed, 0)
  const constrained = createInitialState(seed, 0)
  if (!startChallenge(constrained, chal.id)) {
    return { name: 'challenge-constraint', ok: false, detail: `startChallenge refused ${chal.id}` }
  }
  const baseMods = effectiveMods(base)
  const constrainedMods = effectiveMods(constrained)
  const baseProd = totalProductionOf(base)
  const constrainedProd = totalProductionOf(constrained)
  const multLower = RESOURCE_IDS.every((r) => constrainedMods.productionMult[r] < baseMods.productionMult[r])
  const prodLower = constrainedProd.lt(baseProd)
  const ok = multLower && prodLower
  return {
    name: 'challenge-constraint',
    ok,
    detail: ok
      ? `${chal.id} constraint cut production ${baseProd.toString()} -> ${constrainedProd.toString()} (x${chal.constraint.productionMult})`
      : !multLower
        ? `${chal.id} constraint did not lower the production multiplier on every resource`
        : `${chal.id} constraint did not lower total production (${baseProd.toString()} -> ${constrainedProd.toString()})`,
  }
}

/**
 * Challenge completion is ONE-TIME (M8): with the goal met, {@link checkChallengeCompletion} fires
 * exactly once — it bumps `completed[id]` to 1, clears `activeId` (so the constraint switches off and
 * the reward on), and a SECOND call (now that `activeId` is null) is a no-op that never double-grants.
 * Picks a production-goal challenge, starts it, drives the goal trivially by maxing the capital's
 * buildings + recomputing (production >> target), then asserts the single-completion contract. Pure /
 * deterministic (no bot, only the seeded world startChallenge installs).
 */
export function checkChallengeCompletionOnce(seed: string): InvariantResult {
  const chal = CHALLENGES.find((c) => c.goal.kind === 'production')
  if (!chal) {
    return { name: 'challenge-completion-once', ok: false, detail: 'no production-goal challenge to test completion' }
  }
  const state = createInitialState(seed, 0)
  if (!startChallenge(state, chal.id)) {
    return { name: 'challenge-completion-once', ok: false, detail: `startChallenge refused ${chal.id}` }
  }
  // Drive the production goal to met: max every building and recompute so production >> the target.
  const v = state.villages[state.villageOrder[0]]
  for (const id of BUILDING_IDS) v.buildings[id] = BUILDINGS[id].maxLevel
  recomputeDerived(state)

  const issues: string[] = []
  const first = checkChallengeCompletion(state)
  if (!first) issues.push('first checkChallengeCompletion did not fire with the goal met')
  if (state.challenge.activeId !== null) issues.push(`activeId not cleared after completion (=${String(state.challenge.activeId)})`)
  if (state.challenge.completed[chal.id] !== 1) {
    issues.push(`completed[${chal.id}]=${String(state.challenge.completed[chal.id])} after one completion (expected 1)`)
  }
  // Idempotent: a second call (activeId already cleared) must NOT fire again / bump the count.
  const second = checkChallengeCompletion(state)
  if (second) issues.push('second checkChallengeCompletion fired again (double-grant)')
  if (state.challenge.completed[chal.id] !== 1) issues.push(`completed[${chal.id}] bumped past 1 on a second call`)
  return {
    name: 'challenge-completion-once',
    ok: issues.length === 0,
    detail: issues.length ? issues.join('; ') : `${chal.id} completed exactly once, activeId cleared, no double-grant`,
  }
}

/**
 * The earned REWARD folds into a FRESH post-completion run (M8). Completes a production-goal challenge
 * through the REAL lifecycle (start -> max economy -> {@link checkChallengeCompletion}), then proves
 * the permanent reward is live on a FRESH run carrying only the resulting `completed` map: every
 * present multiplicative axis of the challenge's reward must be strictly raised in
 * `effectiveMods(fresh + completed)` vs a no-challenge baseline. This is the "an earned challenge makes
 * every future run stronger forever" guarantee (mirrors prestige-production-uplift). Pure / deterministic.
 */
export function checkChallengeRewardFolds(seed: string): InvariantResult {
  const chal = CHALLENGES.find((c) => c.goal.kind === 'production')
  if (!chal) {
    return { name: 'challenge-reward-folds', ok: false, detail: 'no production-goal challenge to test the reward' }
  }
  const state = createInitialState(seed, 0)
  startChallenge(state, chal.id)
  const v = state.villages[state.villageOrder[0]]
  for (const id of BUILDING_IDS) v.buildings[id] = BUILDINGS[id].maxLevel
  recomputeDerived(state)
  if (!checkChallengeCompletion(state)) {
    return { name: 'challenge-reward-folds', ok: false, detail: `could not complete ${chal.id} to earn its reward` }
  }
  // Fresh post-completion run: a fresh capital carrying ONLY the completed map (no active challenge),
  // so the bag folded into effectiveMods is the reward alone (the constraint is off).
  const base = createInitialState(seed, 0)
  const post = createInitialState(seed, 0)
  post.challenge.completed = { ...state.challenge.completed }
  const issues = challengeRewardRaised(effectiveMods(base), effectiveMods(post), chal.reward)
  return {
    name: 'challenge-reward-folds',
    ok: issues.length === 0,
    detail: issues.length ? issues.join('; ') : `${chal.id} reward folds into a fresh post-completion run (${chal.rewardText})`,
  }
}

/**
 * Earned rewards STACK across DISTINCT completions (M8 — the contract's "earned challenge bonuses
 * stack" clause). Completes a production-goal challenge through the REAL lifecycle, then INJECTS a
 * SECOND distinct completed id, and proves a fresh run carrying BOTH completed entries folds BOTH
 * rewards into effectiveMods AT ONCE — every present multiplicative axis of EACH reward is strictly
 * raised vs a no-challenge baseline (not just the first completed id; a regression that stopped after
 * one entry would leave the other's axis at the baseline and trip this). Hardens the single-reward
 * {@link checkChallengeRewardFolds} on the stacking side. Pure / deterministic (only the seeded world).
 */
export function checkChallengeRewardStacks(seed: string): InvariantResult {
  const first = CHALLENGES.find((c) => c.goal.kind === 'production')
  // A SECOND, distinct challenge whose reward carries at least one multiplicative axis.
  const second = CHALLENGES.find(
    (c) => (!first || c.id !== first.id) && Object.values(c.reward).some((x) => typeof x === 'number'),
  )
  if (!first || !second) {
    return { name: 'challenge-reward-stacks', ok: false, detail: 'need two distinct rewarding challenges to test stacking' }
  }
  // Complete the first challenge through the real lifecycle (start -> max economy -> completion).
  const state = createInitialState(seed, 0)
  startChallenge(state, first.id)
  const v = state.villages[state.villageOrder[0]]
  for (const id of BUILDING_IDS) v.buildings[id] = BUILDINGS[id].maxLevel
  recomputeDerived(state)
  if (!checkChallengeCompletion(state)) {
    return { name: 'challenge-reward-stacks', ok: false, detail: `could not complete ${first.id} to earn its reward` }
  }
  // Fresh post-completion run carrying BOTH completed ids (the second injected, mirroring a prior
  // completion). With no active challenge the folded bag is BOTH rewards (no constraint).
  const base = createInitialState(seed, 0)
  const post = createInitialState(seed, 0)
  post.challenge.completed = { ...state.challenge.completed, [second.id]: 1 }
  const baseMods = effectiveMods(base)
  const postMods = effectiveMods(post)
  // BOTH rewards must fold simultaneously: each reward's present axes strictly raised vs baseline.
  const issues = [
    ...challengeRewardRaised(baseMods, postMods, first.reward),
    ...challengeRewardRaised(baseMods, postMods, second.reward),
  ]
  return {
    name: 'challenge-reward-stacks',
    ok: issues.length === 0,
    detail: issues.length
      ? issues.join('; ')
      : `${first.id} + ${second.id} rewards both fold into one fresh run (stack)`,
  }
}

/**
 * Game-seconds the constrained capital is advanced by idle production before it MUST offer a progress
 * action, and the coarse step between probes. Mirrors {@link ERA_PLAYABILITY_HORIZON}: a just-started
 * challenge capital is a fresh {@link createInitialState} start under a multiplicative penalty, so it
 * accrues a touch slower but still unlocks its first action in a few seconds — the horizon is a
 * generous, bounded multiple of that, catching a PERMANENT dead-end without reading a FALSE stall.
 */
const CHALLENGE_PLAYABILITY_HORIZON = 600
const CHALLENGE_PLAYABILITY_STEP = 5

/**
 * No softlock under an active challenge (M8): STARTING a challenge rebuilds the run as ONE fresh capital
 * under a CONSTRAINT (penalty multipliers), so — like a fresh start or a meta reset — it must never land
 * in a PERMANENT stall. Starts the most punishing constraint ({@link CHALLENGES}[0]) and asserts the
 * constrained run reaches a state with at least one available progress action ({@link chooseAction}
 * non-null) under the EFFECTIVE mods (tech × prestige × era × dynasty × the constraint). The constraint
 * only LOWERS the economy (production still > 0), so accrual is merely slower, never zero — a challenge
 * run is a normal run under a multiplier penalty, so progress is always possible. Does NOT probe the
 * bare just-started instant (a fresh capital sits below the cheapest build for the first few seconds —
 * the FALSE stall the era/dynasty checks also skip); instead it advances idle production over a bounded
 * horizon and passes the moment an action appears. Deterministic + self-contained. Mirrors
 * {@link checkEraNoSoftlock}.
 */
export function checkChallengeNoSoftlock(seed: string): InvariantResult {
  const chal = CHALLENGES[0]
  const state = createInitialState(seed, 0)
  if (!startChallenge(state, chal.id)) {
    return { name: 'challenge-no-softlock', ok: false, detail: `startChallenge refused ${chal.id}` }
  }

  // True iff SOME village offers a progress action right now under the effective (constrained) mods.
  const hasAction = (): boolean => {
    const mods = effectiveMods(state)
    for (const vid of state.villageOrder) {
      if (chooseAction(state.villages[vid], state.world, mods) !== null) return true
    }
    return false
  }

  let ok = hasAction()
  for (let t = 0; !ok && t < CHALLENGE_PLAYABILITY_HORIZON; t += CHALLENGE_PLAYABILITY_STEP) {
    simulate(state, CHALLENGE_PLAYABILITY_STEP)
    ok = hasAction()
  }

  return {
    name: 'challenge-no-softlock',
    ok,
    detail: ok
      ? undefined
      : `fresh constrained ${chal.id} capital has no available action within ${CHALLENGE_PLAYABILITY_HORIZON}s of idle production`,
  }
}

/**
 * Challenge round-trip (M8): the { activeId, completed } record ({@link GameState.challenge}) must
 * survive the real export/import (base64) path byte-for-byte — the part that SURVIVES every reset of
 * any kind (CLAUDE.md hard rule #3): an ACTIVE challenge resumes after a load, and the COMPLETED map
 * (keying the permanent rewards) is never lost. The whole-state {@link checkRoundTrip} already proves
 * serialize/deserialize is loss-free; this is the targeted proof for the v19 challenge node. Compares
 * `activeId` and the completed map (order-independently). Mirrors {@link checkEraRoundTrip}.
 */
export function checkChallengeRoundTrip(state: GameState): InvariantResult {
  const restored = importSave(exportSave(state))
  const a = state.challenge
  const b = restored.challenge
  const ak = Object.keys(a.completed)
  const bk = Object.keys(b.completed)
  let mapEq = ak.length === bk.length
  if (mapEq) {
    for (const k of ak) {
      if (a.completed[k] !== b.completed[k]) {
        mapEq = false
        break
      }
    }
  }
  const ok = a.activeId === b.activeId && mapEq
  return {
    name: 'challenge-round-trip',
    ok,
    detail: ok
      ? undefined
      : `challenge record changed across export/import: ` +
        `{activeId:${String(a.activeId)},completed:${JSON.stringify(a.completed)}} -> ` +
        `{activeId:${String(b.activeId)},completed:${JSON.stringify(b.completed)}}`,
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

// --- M7 fortress (finite boss targets) coverage ------------------------------------------
//
// Fortresses are an ADDITIVE, FINITE class of far-ring boss targets drawn from a SEPARATE
// ':fortress' rng stream, so the barbarian world stays BYTE-IDENTICAL to pre-M7. A victorious
// assault razes a fortress ONCE and for good (razed = true, never re-attackable) and hauls a big
// one-time loot cache home — there is no loyalty / scouting / catapult tier-razing. These
// deterministic proof-of-mechanic checks (no bot, no Math.random) mirror the M5.3 siege coverage:
// the fortress world is well-shaped + deterministic from the seed, a (razed) fortress survives
// save/load, and a winning assault razes the boss exactly once, refuses any second assault, and
// never strands the run.

/** Rams the fortress raze-once scenario fields — >= 30 floors {@link ramDefenseFactor} at 0.4 (-60% wall). */
const FORTRESS_RAZE_RAMS = 40
/** Safety multiple over the bare worst-luck win threshold for the raze-once axeman core (a comfortable win on any roll). */
const FORTRESS_RAZE_MARGIN = 2
/** Horizon (game-seconds) the raze-once assault is simulated for — well past a far-ring round trip. */
const FORTRESS_HORIZON = 30000

/**
 * The WEAKEST (lowest-level, nearest) fortress of a world — the boss the raze-once scenario
 * assaults so the seeded army stays a manageable size. Reads the level (rather than assuming
 * 'f0') to stay robust to a data reorder. generateWorld always spawns {@link FORTRESS_COUNT}.
 */
function weakestFortress(world: World): Fortress {
  return world.fortresses.reduce((a, b) => (b.level < a.level ? b : a))
}

/**
 * Fortress world is WELL-SHAPED (M7), checked per sample like {@link checkWorldConsistency}. Over
 * `world.fortresses` it asserts each fortress has a non-empty string id, FINITE coordinates, an
 * INTEGER level >= 1, a non-empty name and a BOOLEAN razed flag, and that NO TWO fortresses share
 * a map cell — so a razing (razed flips true) or a save round-trip can never corrupt the boss list.
 * (The fresh-world placement correctness — count, far rings, off every camp/capital cell — is the
 * stronger one-shot {@link checkFortressDeterminism}; this guards the LIVE list as it mutates.)
 */
export function checkFortressConsistency(state: GameState): InvariantResult {
  const world: World | undefined = state.world
  if (world === undefined || !Array.isArray(world.fortresses)) {
    return {
      name: 'fortress-consistency',
      ok: false,
      detail: 'state.world.fortresses missing or not an array',
    }
  }
  const issues: string[] = []
  const occupied = new Map<string, string>()
  for (const f of world.fortresses as Fortress[]) {
    if (typeof f.id !== 'string' || f.id.length === 0) issues.push(`bad id ${String(f.id)}`)
    if (!Number.isFinite(f.x) || !Number.isFinite(f.y)) issues.push(`${f.id} non-finite coords (${f.x},${f.y})`)
    if (!Number.isInteger(f.level) || f.level < 1) issues.push(`${f.id} level=${f.level}`)
    if (typeof f.name !== 'string' || f.name.length === 0) issues.push(`${f.id} empty name`)
    if (typeof f.razed !== 'boolean') issues.push(`${f.id} razed=${String(f.razed)}`)
    const key = f.x + ',' + f.y
    const prev = occupied.get(key)
    if (prev !== undefined) issues.push(`${f.id} shares cell ${key} with ${prev}`)
    occupied.set(key, f.id)
  }
  return {
    name: 'fortress-consistency',
    ok: issues.length === 0,
    detail: issues.length ? issues.join('; ') : undefined,
  }
}

/**
 * Fortresses are DETERMINISTIC from the seed (M7): two {@link generateWorld} calls on the same seed
 * must agree on BOTH the fortress list AND the barbarian list (the latter confirms the barbarian list
 * stays reproducible WITH fortress generation in the same call). NOTE: this a==b comparison proves
 * determinism only, NOT byte-identity to the PRE-M7 baseline — if fortress generation DID perturb the
 * ':world' stream, both a and b would be perturbed identically and still match. The against-baseline
 * byte-identity guarantee (the additive contract) is pinned by the golden-snapshot test in
 * tests/fortresses.test.ts; here we also assert the FINITE shape of a fresh world: exactly
 * {@link FORTRESS_COUNT} fortresses, each well-shaped, born un-razed, on far rings BEYOND the camp
 * ladder ({@link MAX_TARGET_LEVEL}), no two sharing a cell. Pure / self-contained — no clock, no bot.
 */
export function checkFortressDeterminism(seed: string): InvariantResult {
  const issues: string[] = []
  const a = generateWorld(seed)
  const b = generateWorld(seed)

  if (JSON.stringify(a.fortresses) !== JSON.stringify(b.fortresses)) {
    issues.push('two generateWorld(seed) produced different fortresses')
  }
  if (JSON.stringify(a.barbarians) !== JSON.stringify(b.barbarians)) {
    issues.push('two generateWorld(seed) produced different barbarians (generation not deterministic)')
  }
  if (a.fortresses.length !== FORTRESS_COUNT) {
    issues.push(`fortress count ${a.fortresses.length} != FORTRESS_COUNT ${FORTRESS_COUNT}`)
  }

  const occupied = new Map<string, string>()
  for (const f of a.fortresses) {
    if (typeof f.id !== 'string' || f.id.length === 0) issues.push(`bad id ${String(f.id)}`)
    if (!Number.isFinite(f.x) || !Number.isFinite(f.y)) issues.push(`${f.id} non-finite coords (${f.x},${f.y})`)
    if (!Number.isInteger(f.level) || f.level <= MAX_TARGET_LEVEL) {
      issues.push(`${f.id} level ${f.level} not beyond the camp ladder (> ${MAX_TARGET_LEVEL})`)
    }
    if (typeof f.name !== 'string' || f.name.length === 0) issues.push(`${f.id} empty name`)
    if (f.razed !== false) issues.push(`${f.id} born razed`)
    const key = f.x + ',' + f.y
    const prev = occupied.get(key)
    if (prev !== undefined) issues.push(`${f.id} shares cell ${key} with ${prev}`)
    occupied.set(key, f.id)
  }

  return {
    name: 'fortress-determinism',
    ok: issues.length === 0,
    detail:
      issues.length === 0
        ? `${a.fortresses.length} fortresses (levels ${a.fortresses.map((f) => f.level).join('/')}, all > ${MAX_TARGET_LEVEL}); both lists deterministic (baseline byte-identity pinned by the golden snapshot)`
        : issues.join('; '),
  }
}

/**
 * Fortress save/load round-trip (M7): the fortress list — INCLUDING a razed fortress (the bit that
 * survives the run) — must ride the real export/import (base64) path byte-for-byte. The whole-state
 * {@link checkRoundTrip} proves serialize/deserialize is loss-free; this is the targeted proof that
 * the v17 save carries `world.fortresses` (and the razed flag) specifically. Mirrors
 * {@link checkEraRoundTrip}. Pure function of a fresh seeded state.
 */
export function checkFortressSaveLoad(seed: string): InvariantResult {
  const state = createInitialState(seed, 0)
  if (state.world.fortresses.length === 0) {
    return { name: 'fortress-save-load', ok: false, detail: 'fresh world has no fortresses to round-trip' }
  }
  // Raze one so the round-trip must also carry the FLIPPED flag, not just the as-generated list.
  state.world.fortresses[0].razed = true
  const restored = importSave(exportSave(state))
  const a = JSON.stringify(state.world.fortresses)
  const b = JSON.stringify(restored.world.fortresses)
  const razedSurvived = restored.world.fortresses.some((f) => f.razed)
  const ok = a === b && razedSurvived
  return {
    name: 'fortress-save-load',
    ok,
    detail: ok
      ? `${restored.world.fortresses.length} fortresses (incl. a razed one) survived export/import byte-identically`
      : a !== b
        ? 'fortresses changed across export/import'
        : 'the razed flag did not survive export/import',
  }
}

/**
 * A winning fortress assault RAZES the boss exactly ONCE (M7), and a razed fortress is permanently
 * out of play. Drives the REAL engine ({@link sendAttack}(…, 'fortress') + {@link simulate}) on a
 * fresh seeded capital with raids frozen out, fielding rams (to floor the wall) plus an axeman core
 * sized to win even at WORST luck, and asserts:
 *
 *  - the assault WINS and sets `fortress.razed = true`, bumping `stats.fortressesRazed` by exactly 1, AND
 *  - a SECOND dispatch at the same fortress is REFUSED ({@link sendAttack} returns false — one-time), AND
 *  - further simulation leaves it razed with the counter unchanged (it never re-fires), AND
 *  - razing introduces NO SOFTLOCK ({@link chooseAction} still offers a progress action), AND
 *  - the state stays sound (no NaN / negative / over-cap resources, the army books balance).
 *
 * Value-driven: the core is sized from the LIVE fortress defence, so a Balance retune of the
 * fortress curves still passes as long as the seeded army can crack it. Pure / deterministic — no bot.
 */
export function checkFortressRazeOnce(seed: string): InvariantResult {
  const state = createInitialState(seed, 0)
  if (state.world.fortresses.length === 0) {
    return { name: 'fortress-raze-once', ok: false, detail: 'fresh world has no fortresses to assault' }
  }
  const v = firstVillage(state)
  v.buildings.barracks = 1
  v.buildings.academy = 1 // the siege (Taran) gate
  recomputeDerived(state)
  v.resources = { wood: D(1e9), clay: D(1e9), iron: D(1e9) }
  v.popCap = D(1e12)
  v.raidTimer = 1e9 // freeze raids so the ONLY report is this assault

  const fortress = weakestFortress(state.world)
  const target = fortressTarget(fortress.level)

  // Rams floor the wall; size an axeman core that wins even on the unluckiest roll, with margin.
  const army = zeroArmy()
  army.ram = FORTRESS_RAZE_RAMS
  const effDef = target.defensePower * ramDefenseFactor(army)
  army.axeman = Math.ceil(effDef / (WORST_LUCK * UNITS.axeman.attack)) * FORTRESS_RAZE_MARGIN
  for (const id of UNIT_IDS) v.units[id] = army[id]

  const issues: string[] = []
  const before = state.stats.fortressesRazed
  const dispatched = sendAttack(v, state.world, state.battleLog, fortress.id, army, NO_TECH_MODS, 'fortress')
  if (!dispatched) {
    return { name: 'fortress-raze-once', ok: false, detail: 'could not dispatch the fortress assault' }
  }
  simulate(state, FORTRESS_HORIZON)

  if (!fortress.razed) issues.push('fortress not razed after a winning assault')
  if (state.stats.fortressesRazed !== before + 1) {
    issues.push(`fortressesRazed ${before} -> ${state.stats.fortressesRazed} (expected +1)`)
  }

  // ONE-TIME: a razed fortress can never be attacked again — a fresh dispatch is refused outright.
  const reArmy = zeroArmy()
  reArmy.ram = FORTRESS_RAZE_RAMS
  reArmy.axeman = army.axeman
  for (const id of UNIT_IDS) v.units[id] = reArmy[id]
  if (sendAttack(v, state.world, state.battleLog, fortress.id, reArmy, NO_TECH_MODS, 'fortress')) {
    issues.push('a razed fortress accepted a second assault (must be one-time)')
  }
  simulate(state, FORTRESS_HORIZON)
  if (!fortress.razed) issues.push('razed fortress lost its razed flag after the re-attempt')
  if (state.stats.fortressesRazed !== before + 1) {
    issues.push(`fortressesRazed re-fired after razing: now ${state.stats.fortressesRazed}`)
  }

  // NO SOFTLOCK: razing a fortress must never strand the run — a progress action still exists.
  if (chooseAction(v, state.world, effectiveMods(state)) === null) {
    issues.push('no progress action available after razing the fortress (softlock)')
  }

  // State sanity: no NaN / negative / over-cap resources, balanced army books.
  for (const r of RESOURCE_IDS) {
    const res = v.resources[r]
    if (!isFiniteDecimal(res) || res.lt(0) || res.gt(v.storageCap)) issues.push(`capital.${r}=${res.toString()}`)
  }
  const ac = checkArmyConsistency(state)
  if (!ac.ok) issues.push(`army-consistency: ${ac.detail ?? 'failed'}`)

  return {
    name: 'fortress-raze-once',
    ok: issues.length === 0,
    detail:
      issues.length === 0
        ? `razed ${fortress.name} (wall ${target.defensePower}) once; a razed fortress refuses re-assault and never re-fires`
        : issues.join('; '),
  }
}

// --- M7.2 hordes (telegraphed, escalating capital invasion) coverage -----------------------
// Self-contained proof-of-mechanic checks for the horde engine (systems/hordes.ts), mirroring
// the fortress checks above: no bot, the only randomness the seeded combat luck. A horde is an
// ALWAYS-ON new pressure, so unlike the additive opt-in fortresses these DO touch the main run —
// but these checks isolate the guarantees the brief pins for the horde primitive itself:
// escalation only ever rises, a forced BREACH leaves the capital playable (never a softlock), the
// single GLOBAL horde schedule survives the real save/load path, AND the meta resets re-arm it.
// The dt-chunk determinism (one big simulate == chunked offline, rngState and all) WITH a horde
// actually FIRING is proven at integration level by {@link checkHordeDeterminism}, which arms the
// clock to resolve a horde inside the window — the existing offline checks
// ({@link checkOfflineDeterminism} et al.) run hordes through the same tick sub-step but on a 1h
// horizon that never reaches HORDE_INTERVAL, so no horde resolves there.

/** Hordes resolved by the escalation check — enough to span early repels AND, as the level climbs, breaches. */
const HORDE_ESCALATION_RESOLVES = 12

/**
 * Horde escalation MONOTONICITY (M7.2): `state.horde.level` rises by EXACTLY 1 after every
 * resolved horde — repelled OR breached — and never falls. Drives the REAL engine
 * ({@link advanceHorde}) on a fresh seeded capital with a modest defensive garrison (so the early,
 * low-level hordes are repelled and the later, geometrically-escalated ones breach — both paths
 * exercised), resolving one horde at a time (dt == the remaining timer fires exactly one, then
 * advanceHorde re-arms it) and asserting the level steps +1 each time. Also cross-checks that the
 * resolution count equals repelled + breached, i.e. every horde resolved exactly once.
 * Deterministic (one seeded luck draw per resolved horde); pure of the bot.
 */
export function checkHordeEscalation(seed: string): InvariantResult {
  const state = createInitialState(seed, 0)
  const v = firstVillage(state)
  v.units.spearman = 50 // a modest garrison: early hordes repel, the escalated ones breach
  recomputeDerived(state)
  const rng = RNG.fromString(seed + ':horde-escalation')

  const issues: string[] = []
  let prev = state.horde.level
  if (prev !== 0) issues.push(`fresh horde level ${prev} (expected 0)`)
  for (let i = 0; i < HORDE_ESCALATION_RESOLVES; i++) {
    // dt == the remaining timer resolves EXACTLY one horde, then advanceHorde re-arms it.
    advanceHorde(state, state.battleLog, state.horde.timer, NO_TECH_MODS, state.stats, rng)
    const now = state.horde.level
    if (now !== prev + 1) issues.push(`level ${prev} -> ${now} (expected +1 per resolved horde)`)
    prev = now
  }
  const resolved = state.stats.hordesRepelled + state.stats.hordesBreached
  if (resolved !== HORDE_ESCALATION_RESOLVES) {
    issues.push(
      `resolved ${resolved} != ${HORDE_ESCALATION_RESOLVES} ` +
        `(repelled ${state.stats.hordesRepelled} + breached ${state.stats.hordesBreached})`,
    )
  }

  return {
    name: 'horde-escalation',
    ok: issues.length === 0,
    detail:
      issues.length === 0
        ? `level rose 0 -> ${state.horde.level} across ${HORDE_ESCALATION_RESOLVES} hordes ` +
          `(${state.stats.hordesRepelled} repelled / ${state.stats.hordesBreached} breached), +1 each`
        : issues.join('; '),
  }
}

/**
 * Horde escalation level used by the forced-breach check — high enough that hordePower (geometric
 * in the level) dwarfs any seeded capital defence at ANY luck roll, so the single resolved horde is
 * a GUARANTEED breach whatever the seed draws. The assertion below confirms the breach actually
 * fired, so this stays robust even if the hordePower curve is retuned.
 */
const HORDE_FORCED_BREACH_LEVEL = 100

/**
 * A horde BREACH never SOFTLOCKS (M7.2): a breached horde steals a large slice of EACH capital
 * resource and a chunk of the garrison, but NEVER destroys a building and never drives a pool /
 * roster negative, so the capital stays playable and the loss is always recoverable. Drives the
 * REAL engine ({@link advanceHorde}) on a fresh seeded capital — resources pinned at the cap, a
 * standing garrison, and the escalation level forced sky-high so a breach is guaranteed on any roll
 * — then asserts:
 *  - the breach actually FIRED (stats.hordesBreached === 1), AND
 *  - each resource fell but stayed FINITE, non-negative and within cap (a recoverable ~40% loss), AND
 *  - the garrison fell but every count stayed a non-negative integer (a recoverable ~30% loss), AND
 *  - NO building level changed (a breach never razes structures — the anti-softlock guarantee), AND
 *  - the capital is still PLAYABLE: a progress action is available now, OR it still has resources +
 *    production to accrue one (mirrors {@link checkNoSoftlock}'s philosophy), AND
 *  - the army books still balance ({@link checkArmyConsistency}).
 * Pure / deterministic — no bot.
 */
export function checkHordeBreachNoSoftlock(seed: string): InvariantResult {
  const state = createInitialState(seed, 0)
  const v = firstVillage(state)
  recomputeDerived(state)
  // Resources pinned at the cap (a within-cap, affordable pool) and a real garrison to lose a slice of.
  for (const r of RESOURCE_IDS) v.resources[r] = v.storageCap
  v.units.spearman = 100
  state.horde.level = HORDE_FORCED_BREACH_LEVEL // guarantee a breach on any luck roll

  const resBefore: Record<string, Decimal> = {}
  for (const r of RESOURCE_IDS) resBefore[r] = v.resources[r]
  const garrisonBefore = UNIT_IDS.reduce((s, id) => s + v.units[id], 0)
  const buildingsBefore = BUILDING_IDS.map((id) => v.buildings[id])

  const rng = RNG.fromString(seed + ':horde-breach')
  advanceHorde(state, state.battleLog, state.horde.timer, NO_TECH_MODS, state.stats, rng)

  const issues: string[] = []
  if (state.stats.hordesBreached !== 1) {
    issues.push(
      `expected exactly 1 breach, got hordesBreached=${state.stats.hordesBreached} ` +
        `(repelled ${state.stats.hordesRepelled})`,
    )
  }

  // Resources: dropped, but finite / non-negative / within cap (recoverable, not corrupt).
  for (const r of RESOURCE_IDS) {
    const res = v.resources[r]
    if (!isFiniteDecimal(res) || res.lt(0) || res.gt(v.storageCap)) {
      issues.push(`capital.${r}=${res.toString()} (cap ${v.storageCap.toString()})`)
    } else if (!res.lt(resBefore[r])) {
      issues.push(`capital.${r} did not fall on a breach (${resBefore[r].toString()} -> ${res.toString()})`)
    }
  }

  // Garrison: dropped, but every count stayed a non-negative integer (recoverable).
  for (const id of UNIT_IDS) {
    if (!Number.isInteger(v.units[id]) || v.units[id] < 0) issues.push(`units.${id}=${v.units[id]}`)
  }
  const garrisonAfter = UNIT_IDS.reduce((s, id) => s + v.units[id], 0)
  if (!(garrisonAfter < garrisonBefore)) {
    issues.push(`garrison did not fall on a breach (${garrisonBefore} -> ${garrisonAfter})`)
  }

  // No building destroyed — the anti-softlock guarantee (a breach must never raze structures).
  BUILDING_IDS.forEach((id, i) => {
    if (v.buildings[id] !== buildingsBefore[i]) {
      issues.push(`building ${id} changed ${buildingsBefore[i]} -> ${v.buildings[id]} (a breach must never raze structures)`)
    }
  })

  // Still playable: an action now, OR resources + production to accrue one (no softlock).
  const mods = effectiveMods(state)
  const hasAction = chooseAction(v, state.world, mods) !== null
  const hasResources = RESOURCE_IDS.some((r) => v.resources[r].gt(0))
  const hasProduction = RESOURCE_IDS.some((r) => v.production[r].gt(0))
  if (!hasAction && !(hasResources && hasProduction)) {
    issues.push('capital not playable after a breach (no action, and no resources/production to recover)')
  }

  const ac = checkArmyConsistency(state)
  if (!ac.ok) issues.push(`army-consistency: ${ac.detail ?? 'failed'}`)

  return {
    name: 'horde-breach-no-softlock',
    ok: issues.length === 0,
    detail:
      issues.length === 0
        ? `breach took a slice of each resource + a chunk of the garrison (${garrisonBefore} -> ${garrisonAfter}), ` +
          `razed no building, left the capital playable`
        : issues.join('; '),
  }
}

/**
 * Horde save/load round-trip (M7.2): the single GLOBAL horde schedule ({@link GameState.horde} —
 * the countdown `timer` + the escalation `level`) must ride the real export/import (base64) path
 * byte-for-byte. The whole-state {@link checkRoundTrip} proves serialize/deserialize is loss-free;
 * this is the targeted proof that the v18 save carries `state.horde` specifically — the bit that
 * persists the in-flight countdown AND the accumulated escalation across a save (CLAUDE.md hard
 * rule #3). Mirrors {@link checkFortressSaveLoad} / {@link checkEraRoundTrip}. Pure function of a
 * fresh seeded state.
 */
export function checkHordeSaveLoad(seed: string): InvariantResult {
  const state = createInitialState(seed, 0)
  // Distinctive, non-default values so the round-trip must carry BOTH fields, not just the seed default.
  state.horde.timer = 1234.5
  state.horde.level = 7
  const restored = importSave(exportSave(state))
  const a = state.horde
  const b = restored.horde
  const ok = a.timer === b.timer && a.level === b.level
  return {
    name: 'horde-save-load',
    ok,
    detail: ok
      ? `horde schedule {timer:${a.timer},level:${a.level}} survived export/import byte-identically`
      : `horde schedule changed across export/import: {timer:${a.timer},level:${a.level}} -> {timer:${b.timer},level:${b.level}}`,
  }
}

/**
 * Seconds-from-now the horde determinism check arms the capital's horde clock at. Well
 * INSIDE the determinism window (the runner uses an hour) so a horde RESOLVES through the
 * real tick within the span — without this the default {@link HORDE_INTERVAL} (4h) would
 * leave the clock counting down but never firing, making the integration determinism check
 * vacuous (the gap {@link checkHordeDeterminism} closes). The clock re-arms to the full
 * HORDE_INTERVAL after firing, so exactly one horde resolves in the window.
 */
const HORDE_DETERMINISM_TIMER = 1800

/**
 * Put a fresh state into the SAME live combat scenario as {@link seedRecruitment} (a
 * training queue, an in-flight march AND active raids on the capital) and ADDITIONALLY arm
 * the GLOBAL horde clock to fire mid-window. So a horde resolution — its single seeded luck
 * draw, the LAST rng consumer in the sub-step — is sandwiched between the raid/march draws,
 * which means a regression that draws the WRONG number of luck values per resolved horde
 * (two, or a draw on a non-resolving step) would shift the persisted rngState and desync the
 * downstream raid/march timeline, breaking the byte-identity the determinism check asserts.
 */
function seedHordeDue(state: GameState): void {
  seedRecruitment(state)
  // A garrison home so the capital actually has a defence to resolve the horde against (a
  // repel or a breach — either way EXACTLY one luck draw); irrelevant to the dt-invariance,
  // present only so the resolution is a meaningful battle, not a 0-vs-0 edge case.
  firstVillage(state).units.spearman = 80
  state.horde.timer = HORDE_DETERMINISM_TIMER
}

/**
 * Horde DETERMINISM at INTEGRATION level (M7.2): a horde resolving inside the deterministic
 * tick sub-step draws its luck only from the persisted, seeded `rngState` on the fixed tick
 * grid, so crediting a span as one big {@link simulate} (online catch-up) must be
 * byte-identical to the chunked offline path ({@link applyOffline}) — same rngState, same
 * outcomes — EVEN with a horde firing in the window. Mirrors {@link checkOfflineDeterminism} /
 * {@link checkLuckDeterminism} but on {@link seedHordeDue}, which arms the horde clock to fire
 * mid-span: unlike the existing offline checks (whose 1h horizon never reaches the 4h horde
 * interval, so no horde ever resolves), this one GUARANTEES >= 1 horde resolves through the
 * real tick. Also asserts NON-VACUITY: the rngState ADVANCED, a horde report landed AND the
 * lifetime horde counters actually moved (>= 1 resolved), so "identical" can never pass by
 * drawing nothing. `seconds` stays within
 * {@link import('../src/engine/offline').MAX_OFFLINE_SECONDS} (the caller uses an hour).
 */
export function checkHordeDeterminism(seed: string, seconds: number): InvariantResult {
  const big = createInitialState(seed, 0)
  seedHordeDue(big)
  const rng0 = big.rngState
  simulate(big, seconds)
  big.lastSeen = seconds * 1000 // mirror the bookkeeping applyOffline performs

  const chunked = createInitialState(seed, 0)
  seedHordeDue(chunked)
  applyOffline(chunked, seconds * 1000) // lastSeen starts at 0

  const equal = serialize(big) === serialize(chunked)
  const advanced = big.rngState !== rng0
  const rngMatches = big.rngState === chunked.rngState
  const resolved = big.stats.hordesRepelled + big.stats.hordesBreached
  const hordeReports = big.battleLog.filter((r) => r.kind === 'horde').length
  const fired = resolved >= 1 && hordeReports >= 1
  const ok = equal && advanced && rngMatches && fired
  return {
    name: 'horde-determinism',
    ok,
    detail: ok
      ? `horde stream identical online vs chunked-offline (${resolved} horde(s) resolved, rngState ${rng0} -> ${big.rngState})`
      : !fired
        ? `no horde resolved in the window (resolved ${resolved}, reports ${hordeReports}) — vacuous determinism check`
        : !equal
          ? 'chunked offline catch-up diverged from a single-step simulate WITH a horde firing (rngState / outcomes split)'
          : !advanced
            ? 'rngState never advanced — no luck was drawn (vacuous determinism check)'
            : `rngState diverged online (${big.rngState}) vs offline (${chunked.rngState})`,
  }
}

/**
 * Meta resets CLEAR the GLOBAL horde schedule (M7.2 balance invariant): a Wniebowstąpienie
 * ({@link ascend}), a Nowa Era ({@link newEra}) and a Nowa Dynastia ({@link newDynasty}) each
 * rebuild the run as ONE fresh, defenceless capital — and so they MUST re-arm the horde clock
 * to its createInitialState seed `{timer: HORDE_INTERVAL, level: 0}`, exactly as they reset the
 * per-village raid clock, the world and the rngState. If the escalation `level` (or the
 * mid-countdown `timer`) survived a reset, the previous run's accumulated escalation would bear
 * down on a level-1 capital with no garrison — a guaranteed-breach wipe that contradicts the
 * "a normally-progressing player REPELS hordes" balance contract (the threat scales with the
 * surviving level, the defence with the now-wiped progress). Drives each REAL reset on a seeded,
 * dirtied horde state and asserts it lands back at the fresh-start schedule. Deterministic;
 * pure of the bot.
 */
export function checkMetaResetClearsHorde(seed: string): InvariantResult {
  const issues: string[] = []
  // A distinctive non-default horde state, so the assertion proves the reset CLEARED it (not
  // that it merely happened to already sit at the default).
  const dirty = (s: GameState): void => {
    s.horde = { timer: 4321.5, level: 9 }
  }
  const assertReset = (s: GameState, what: string): void => {
    if (s.horde.timer !== HORDE_INTERVAL || s.horde.level !== 0) {
      issues.push(
        `${what} left horde {timer:${s.horde.timer},level:${s.horde.level}} ` +
          `(expected {timer:${HORDE_INTERVAL},level:0})`,
      )
    }
  }

  // Wniebowstąpienie: a fresh capital already scores enough to bank PP, but boost a building so
  // the yield is unambiguously > 0 on every seed.
  {
    const s = createInitialState(seed, 0)
    firstVillage(s).buildings.hq = 30
    recomputeDerived(s)
    dirty(s)
    if (ascend(s) <= 0) issues.push('ascend banked no PP (cannot test horde reset)')
    else assertReset(s, 'ascend')
  }
  // Nowa Era: seed enough account-wide prestige progress that newEra banks EP (mirrors checkEraNoSoftlock).
  {
    const s = createInitialState(seed, 0)
    s.prestige.totalEarned = 100
    s.prestige.ascensions = 4
    dirty(s)
    if (newEra(s) <= 0) issues.push('newEra banked no EP (cannot test horde reset)')
    else assertReset(s, 'newEra')
  }
  // Nowa Dynastia: seed enough account-wide era progress that newDynasty banks DP (mirrors checkDynastyNoSoftlock).
  {
    const s = createInitialState(seed, 0)
    s.era.totalEarned = 100
    s.era.eras = 4
    dirty(s)
    if (newDynasty(s) <= 0) issues.push('newDynasty banked no DP (cannot test horde reset)')
    else assertReset(s, 'newDynasty')
  }

  return {
    name: 'meta-reset-clears-horde',
    ok: issues.length === 0,
    detail:
      issues.length === 0
        ? `ascend / newEra / newDynasty each re-armed the horde to {timer:${HORDE_INTERVAL},level:0}`
        : issues.join('; '),
  }
}

// --- M9 market (RYNEK — merchant transport between own villages) coverage ----------------------
// Self-contained proof-of-mechanic checks for the market engine (systems/market.ts), mirroring the
// fortress/horde checks above: no bot, and — unlike combat — NO randomness at all (transport draws no
// rng). Transport is a PLAYER-INITIATED action (like sendAttack) that never runs in the tick and never
// folds into effectiveMods, so a run that never transports is BYTE-IDENTICAL to pre-M9; these checks
// isolate the guarantees the brief pins for the transport primitive itself: it CONSERVES resources
// (never creates any), it never exceeds merchant capacity, it replays byte-identically online vs
// chunked-offline with cargo in flight, it never strands a run (cargo always arrives in bounded time),
// and an in-flight shipment survives the real save/load path.

/** Travel-time horizon (seconds) the market checks step within — far past any two-adjacent-village hop. */
const MARKET_DELIVERY_HORIZON = 100000

/**
 * Set up a fresh state for a transport: a maxed Rynek + full warehouse on the capital (the source) and
 * a SECOND village founded nearby with a maxed warehouse (so a delivery never overflows its cap — the
 * dispatched cargo lands in full, transport conserving it). Returns the two ids; `fromId === toId` means
 * no valid founding site was found (the caller fails the check rather than testing a degenerate scenario).
 * Built directly (the dedicated-helper pattern), so it is deterministic and bot-free.
 */
function seedMarket(state: GameState): { fromId: string; toId: string } {
  const fromId = state.villageOrder[0]
  const from = state.villages[fromId]
  // Proven economy on the source: every building at its data max, so the Rynek grants its full merchant
  // capacity and the warehouse holds the coffers we load.
  for (const id of BUILDING_IDS) from.buildings[id] = BUILDINGS[id].maxLevel
  recomputeDerived(state)
  from.resources = { wood: from.storageCap, clay: from.storageCap, iron: from.storageCap }

  const spot = findFoundingSpot(state, fromId)
  if (spot !== null) foundVillage(state, fromId, spot.x, spot.y)
  const toId = state.villageOrder[1] ?? fromId
  if (toId !== fromId) {
    const to = state.villages[toId]
    // Maxed warehouse → a delivery never overflows the destination's cap; start it empty so the
    // delivered cargo is the only thing in its pool.
    for (const id of BUILDING_IDS) to.buildings[id] = BUILDINGS[id].maxLevel
    recomputeDerived(state)
    to.resources = { wood: ZERO, clay: ZERO, iron: ZERO }
  }
  return { fromId, toId }
}

/**
 * Transport CONSERVES resources (M9): the empire-wide resource total immediately AFTER a delivery
 * equals the total immediately BEFORE dispatch (no resource is created), and never exceeds it. Drives
 * the REAL engine ({@link sendShipment} + {@link simulate}'s advanceShipments) on a seeded two-village
 * scenario with EVERY other resource flux frozen — production zeroed, raids + the global horde frozen —
 * so the transport is the SOLE resource mover and the before/after totals are directly comparable. The
 * destination has a maxed warehouse so the cargo lands without spilling (the no-overflow case the
 * contract pins for the equality). Deterministic; pure of the bot.
 */
export function checkMarketConservation(seed: string): InvariantResult {
  const state = createInitialState(seed, 0)
  const { fromId, toId } = seedMarket(state)
  if (fromId === toId) {
    return { name: 'market-conservation', ok: false, detail: 'could not found a second village to transport to' }
  }
  // Freeze every flux that is NOT the transport: zero production (so totals only move via the shipment),
  // freeze raids + the global horde so nothing is stolen. Then transport is the sole resource mover.
  for (const vid of state.villageOrder) {
    const v = state.villages[vid]
    v.production = { wood: ZERO, clay: ZERO, iron: ZERO }
    v.raidTimer = MARKET_DELIVERY_HORIZON * 1e3
  }
  state.horde.timer = MARKET_DELIVERY_HORIZON * 1e3

  const before = totalResources(state)
  if (!sendShipment(state, fromId, toId, { wood: 10000, clay: 10000, iron: 10000 })) {
    return { name: 'market-conservation', ok: false, detail: 'sendShipment refused a valid transport' }
  }
  const from = state.villages[fromId]
  const CHUNK = 5
  let t = 0
  for (; t < MARKET_DELIVERY_HORIZON && from.shipments.length > 0; t += CHUNK) simulate(state, CHUNK)

  const delivered = from.shipments.length === 0
  const after = totalResources(state)
  const conserved = after.eq(before)
  const neverExceeds = after.lte(before)
  const ok = delivered && conserved && neverExceeds
  return {
    name: 'market-conservation',
    ok,
    detail: ok
      ? `transport conserved the empire total (${before.toString()} == ${after.toString()}, no overflow) and created nothing`
      : !delivered
        ? `shipment never arrived within ${MARKET_DELIVERY_HORIZON}s (stranded in transit)`
        : !neverExceeds
          ? `total ROSE across transport (${before.toString()} -> ${after.toString()}) — transport created resources`
          : `total changed across transport (${before.toString()} -> ${after.toString()}) — not conserved`,
  }
}

/**
 * Merchant capacity is NEVER exceeded (M9): for EVERY village, the cargo currently in flight from it
 * ({@link merchantCapacityInUse}) stays within its {@link import('../src/engine/state').Village.merchantCapacity},
 * and every in-flight shipment is well-formed (finite non-negative `remaining`, finite non-negative
 * Decimal cargo — a corrupt shipment would leak resources). A per-STATE check (like
 * {@link checkArmyConsistency}), so the market run can sample it at every step a shipment is in flight
 * ("every village every sampled step"). Pure / Node-safe.
 */
export function checkMarketCapacity(state: GameState): InvariantResult {
  const issues: string[] = []
  for (const vid of state.villageOrder) {
    const v = state.villages[vid]
    const used = merchantCapacityInUse(v)
    if (used.gt(v.merchantCapacity)) {
      issues.push(`${vid}: in-use ${used.toString()} > capacity ${v.merchantCapacity.toString()}`)
    }
    for (const s of v.shipments) {
      if (!Number.isFinite(s.remaining) || s.remaining < 0) issues.push(`${vid}: shipment.remaining=${s.remaining}`)
      for (const r of RESOURCE_IDS) {
        const amt = s.cargo[r]
        if (!isFiniteDecimal(amt) || amt.lt(0)) issues.push(`${vid}: shipment.cargo.${r}=${amt.toString()}`)
      }
    }
  }
  return {
    name: 'market-capacity',
    ok: issues.length === 0,
    detail: issues.length ? issues.join('; ') : undefined,
  }
}

/**
 * Put a fresh state into the SAME live scenario as {@link seedRecruitment} (a training queue, an
 * in-flight march AND active raids on the capital) and ADDITIONALLY found a second village and dispatch a
 * merchant shipment to it, so the dt-chunk determinism is tested WITH a transport crossing the window.
 * advanceShipments draws no rng, but it advances on the fixed TICK_RATE grid alongside the rng-drawing
 * raid/march clocks, so a regression that resolves a shipment on the wrong sub-step (or off-grid) would
 * desync the persisted state — exactly what the byte-identity check below catches. Both branches seed
 * this identically. RETURNS the number of shipments actually dispatched (>= 1 on success, 0 if the
 * second village could not be founded or sendShipment refused) so the caller can prove non-vacuity.
 */
function seedMarketDue(state: GameState): number {
  const fromId = state.villageOrder[0]
  const from = state.villages[fromId]
  // A maxed Rynek (merchant capacity) + a barracks for the live training/march clocks, a prestige
  // multiplier so effectiveMods is non-trivial, and stocked coffers (set directly, mirroring
  // seedRecruitment — decoupled from building prices).
  from.buildings.market = BUILDINGS.market.maxLevel
  from.buildings.barracks = 1
  state.prestige.nodes.prosperity_root = 2
  from.resources = { wood: D(1e6), clay: D(1e6), iron: D(1e6) }
  const spot = findFoundingSpot(state, fromId)
  if (spot !== null) foundVillage(state, fromId, spot.x, spot.y)
  const toId = state.villageOrder[1] ?? fromId
  if (toId !== fromId) {
    state.villages[toId].buildings.warehouse = BUILDINGS.warehouse.maxLevel
  }
  recomputeDerived(state)
  from.popCap = D(1000) // headroom: queued + trained + away units all count

  // Live clocks (mirror seedRecruitment): a training queue + an in-flight march at a concrete tier-6 camp.
  recruit(from, 'spearman', 100)
  from.units.axeman = 60
  const army = {} as Record<UnitId, number>
  for (const id of UNIT_IDS) army[id] = 0
  army.axeman = 40
  sendAttack(from, state.world, state.battleLog, targetOfLevel(state.world, 6).id, army)
  // A merchant shipment in flight (the M9 path under test): cargo well within the maxed Rynek's
  // capacity, crossing the window so advanceShipments resolves it on the fixed grid in both branches.
  if (toId !== fromId && sendShipment(state, fromId, toId, { wood: 5000, clay: 5000, iron: 5000 })) {
    return from.shipments.length // >= 1: positive evidence a transport was dispatched
  }
  return 0
}

/**
 * Transport DETERMINISM at INTEGRATION level (M9): a shipment resolving inside the deterministic tick
 * sub-step advances on the fixed TICK_RATE grid, so crediting a span as one big {@link simulate} (online
 * catch-up) must be byte-identical to the chunked offline path ({@link applyOffline}) — even with a
 * shipment in flight. Mirrors {@link checkOfflineDeterminism} / {@link checkHordeDeterminism} but on
 * {@link seedMarketDue}. Asserts NON-VACUITY with POSITIVE evidence (mirroring
 * {@link checkHordeDeterminism}'s `>= 1` discipline): seedMarketDue ACTUALLY dispatched >= 1 shipment
 * (captured BEFORE simulate) AND the source's shipments then cleared — sent-then-delivered, not
 * never-sent — so "identical" can never pass by leaving the transport untouched (e.g. if founding the
 * second village or sendShipment ever failed, dispatched would be 0 and the check fails loudly instead
 * of vacuously). `seconds` stays within
 * {@link import('../src/engine/offline').MAX_OFFLINE_SECONDS} (the caller uses an hour).
 */
export function checkMarketDeterminism(seed: string, seconds: number): InvariantResult {
  const big = createInitialState(seed, 0)
  const dispatched = seedMarketDue(big) // >= 1 iff a transport was actually launched
  simulate(big, seconds)
  big.lastSeen = seconds * 1000 // mirror the bookkeeping applyOffline performs

  const chunked = createInitialState(seed, 0)
  seedMarketDue(chunked)
  applyOffline(chunked, seconds * 1000) // lastSeen starts at 0

  const equal = serialize(big) === serialize(chunked)
  const fromBig = big.villages[big.villageOrder[0]]
  const inFlight = fromBig?.shipments.length ?? -1
  const resolved = dispatched >= 1 && inFlight === 0 // sent-then-cleared, never the never-sent case
  const ok = equal && resolved
  return {
    name: 'market-determinism',
    ok,
    detail: ok
      ? `transport stream identical online vs chunked-offline (${dispatched} shipment(s) delivered on the fixed grid)`
      : !resolved
        ? `no shipment dispatched-then-resolved in the window (dispatched ${dispatched}, in-flight ${inFlight}) — vacuous determinism check`
        : 'chunked offline catch-up diverged from a single-step simulate WITH a shipment in flight',
  }
}

/**
 * A market run never SOFTLOCKS (M9): with cargo in transit, (a) the resources always arrive within a
 * bounded idle horizon (in-flight cargo is never stranded), and (b) at every step SOME village still
 * offers a progress action. Drives the REAL engine on a seeded two-village scenario, dispatches a
 * shipment, and steps it to delivery asserting both. Deterministic; pure of the bot beyond the
 * {@link chooseAction} availability probe.
 */
export function checkMarketNoSoftlock(seed: string): InvariantResult {
  const state = createInitialState(seed, 0)
  const { fromId, toId } = seedMarket(state)
  if (fromId === toId) {
    return { name: 'market-no-softlock', ok: false, detail: 'could not found a second village to transport to' }
  }
  if (!sendShipment(state, fromId, toId, { wood: 10000, clay: 10000, iron: 10000 })) {
    return { name: 'market-no-softlock', ok: false, detail: 'sendShipment refused a valid transport' }
  }
  const from = state.villages[fromId]
  const hasAction = (): boolean => {
    const mods = effectiveMods(state)
    for (const vid of state.villageOrder) {
      if (chooseAction(state.villages[vid], state.world, mods) !== null) return true
    }
    return false
  }

  const issues: string[] = []
  if (!hasAction()) issues.push('no progress action available with a shipment in flight (softlock)')
  const CHUNK = 30
  let t = 0
  for (; t < MARKET_DELIVERY_HORIZON && from.shipments.length > 0; t += CHUNK) {
    simulate(state, CHUNK)
    if (!hasAction()) {
      issues.push(`no progress action at t=${t}s (softlock)`)
      break
    }
  }
  if (from.shipments.length > 0) issues.push(`shipment still in flight after ${MARKET_DELIVERY_HORIZON}s (stranded cargo)`)

  return {
    name: 'market-no-softlock',
    ok: issues.length === 0,
    detail:
      issues.length === 0
        ? `shipment arrived within ${t}s and a progress action was always available`
        : issues.join('; '),
  }
}

/**
 * A market save/load ROUND-TRIPS with shipments in flight (M9, CLAUDE.md hard rule #3): the per-village
 * `shipments` array — each with its Decimal cargo and its partial `remaining` clock — must survive the
 * real export/import (base64) path byte-for-byte, so a mid-transit save resumes losslessly. Dispatches
 * TWO shipments (so the array is multi-entry), advances a little so `remaining` is a partial value, then
 * compares serialize(state) vs serialize(import(export(state))) AND asserts the cargo is still in flight
 * after the round-trip. Mirrors {@link checkFortressSaveLoad} / {@link checkHordeSaveLoad}.
 */
export function checkMarketSaveLoad(seed: string): InvariantResult {
  const state = createInitialState(seed, 0)
  const { fromId, toId } = seedMarket(state)
  if (fromId === toId) {
    return { name: 'market-save-load', ok: false, detail: 'could not found a second village to transport to' }
  }
  sendShipment(state, fromId, toId, { wood: 7000, clay: 3000, iron: 1000 })
  sendShipment(state, fromId, toId, { wood: 1000, clay: 2000, iron: 4000 })
  // Advance one step so `remaining` is a partial (non-initial) value — the load must resume mid-flight.
  simulate(state, 1)

  const restored = importSave(exportSave(state))
  const a = serialize(state)
  const b = serialize(restored)
  const from = restored.villages[fromId]
  const inFlight = from !== undefined && from.shipments.length >= 1
  const ok = a === b && inFlight
  return {
    name: 'market-save-load',
    ok,
    detail: ok
      ? `${from.shipments.length} in-flight shipment(s) (cargo + remaining) survived export/import byte-identically`
      : a !== b
        ? 'state with in-flight shipments changed across export/import'
        : 'in-flight shipments did not survive export/import',
  }
}

// --- M10 cavalry (KAWALERIA — Stajnia-gated mounted units) proof-of-mechanic checks --------------
//
// Deterministic, self-contained checks for the M10 cavalry pair (light_cavalry / heavy_cavalry),
// each gated behind the new Stajnia (stable). They isolate the guarantees the contract pins for the
// addition: the cavalry is GATED on the Stajnia (no Stajnia → unrecruitable, Stajnia → recruitable),
// the keys are INERT in a no-Stajnia run (a pre-M10-shaped save round-trips to byte-identical state),
// the cavalry's population upkeep is counted exactly, and a roster + in-flight march carrying cavalry
// survives the real save/load path. No bot, no clock, no RNG (beyond the seeded world) — pure of the
// main run, so the 17 core + meta targets stay byte-identical to pre-M10.

/** The two M10 cavalry unit ids (Stajnia-gated). Local so a catalogue edit never desyncs these checks. */
const CAVALRY_IDS = ['light_cavalry', 'heavy_cavalry'] as const

/**
 * The cavalry is GATED on the Stajnia (M10): from one fixed, well-stocked capital that differs ONLY by
 * the Stajnia level, each cavalry unit must be UNRECRUITABLE with no Stajnia (stable level 0 — a fresh
 * capital) and RECRUITABLE once a Stajnia stands (stable level 1). Resources + population are set far
 * above any unit's cost so the ONLY thing that can gate recruitment is `unit.requires` resolving the
 * Stajnia — exactly the gate the MAIN run never opens (the bot/auto-build never build the Stajnia, which
 * is autoBuildable:false), keeping a no-Stajnia run byte-identical to pre-M10. Pure / deterministic.
 */
export function checkCavalryGated(seed: string): InvariantResult {
  const state = createInitialState(seed, 0)
  const v = firstVillage(state)
  // Stock coffers + population headroom so the Stajnia is the SOLE gate (not money / pop).
  v.resources = { wood: D(1e6), clay: D(1e6), iron: D(1e6) }
  v.popCap = D(1000)

  const issues: string[] = []
  // No Stajnia (a fresh capital has stable:0) — the cavalry must be locked AND unrecruitable.
  if (v.buildings.stable !== 0) issues.push(`fresh capital has stable=${v.buildings.stable} (expected 0)`)
  for (const id of CAVALRY_IDS) {
    if (unitUnlocked(v, id)) issues.push(`${id} unlocked with NO Stajnia`)
    if (canRecruit(v, id, 1).ok) issues.push(`${id} recruitable with NO Stajnia (gate open)`)
  }
  // Raise the Stajnia to level 1 — the gate opens and the cavalry becomes recruitable.
  v.buildings.stable = 1
  for (const id of CAVALRY_IDS) {
    if (!unitUnlocked(v, id)) issues.push(`${id} still locked WITH a Stajnia`)
    const can = canRecruit(v, id, 1)
    if (!can.ok) issues.push(`${id} not recruitable WITH a Stajnia: ${can.reason ?? 'unknown'}`)
  }

  return {
    name: 'cavalry-gated',
    ok: issues.length === 0,
    detail:
      issues.length === 0
        ? 'cavalry locked at Stajnia level 0 and unlocked at level 1 (the gate the main run never opens)'
        : issues.join('; '),
  }
}

/**
 * The M10 additions are INERT in a no-Stajnia run (CLAUDE.md hard rule #3 / the contract's byte-identity
 * pin): a state that never builds the Stajnia nor trains cavalry carries the three appended keys
 * (`buildings.stable`, `units.light_cavalry`, `units.heavy_cavalry` — in every village AND every in-flight
 * march) at their inert zero defaults, so removing them yields exactly the PRE-M10 save shape. Proven two
 * ways on a realistic state ({@link seedRecruitment}: a live training queue + an in-flight (non-cavalry)
 * march + active raids, advanced a little):
 *  - INERTNESS: every appended key is 0 across all villages and marches, AND
 *  - ROUND-TRIP EQUALITY: serialize → strip the three appended keys → stamp version 20 (the pre-M10 save
 *    shape) → {@link migrate} (the real v20→v21 backfill re-adds them at 0) → re-serialize must be
 *    byte-identical to the original M10 serialization, proving the additions are EXACTLY the inert
 *    zero-backfill at the tail of the id arrays and nothing more.
 * Pure / deterministic.
 */
export function checkCavalryInert(seed: string): InvariantResult {
  const state = createInitialState(seed, 0)
  seedRecruitment(state) // a live army + in-flight march + queue, NO Stajnia, NO cavalry
  simulate(state, 120) // advance the clocks while the (far) tier-6 march is still outbound

  // INERTNESS: the appended keys stayed at their zero defaults everywhere (no Stajnia, no cavalry).
  const issues: string[] = []
  for (const vid of state.villageOrder) {
    const v = state.villages[vid]
    if (v.buildings.stable !== 0) issues.push(`${vid}.buildings.stable=${v.buildings.stable}`)
    for (const id of CAVALRY_IDS) {
      if (v.units[id] !== 0) issues.push(`${vid}.units.${id}=${v.units[id]}`)
      for (const m of v.marches) {
        if ((m.units[id] ?? 0) !== 0) issues.push(`${vid}.march.units.${id}=${m.units[id]}`)
      }
    }
  }

  // ROUND-TRIP EQUALITY: build the pre-M10 save shape (strip the appended keys, stamp v20), migrate it
  // (the v20→v21 zero-backfill), and require the re-serialization to be byte-identical to the M10 form.
  const full = serialize(state)
  const obj = JSON.parse(full) as {
    version: number
    villageOrder: string[]
    villages: Record<string, { buildings: Record<string, number>; units: Record<string, number>; marches: { units: Record<string, number> }[] }>
  }
  obj.version = 20
  for (const vid of obj.villageOrder) {
    const v = obj.villages[vid]
    delete v.buildings.stable
    for (const id of CAVALRY_IDS) {
      delete v.units[id]
      for (const m of v.marches) delete m.units[id]
    }
  }
  const preM10 = JSON.stringify(obj)
  // Re-serialize through the SAME Decimal-tagging serializer as `full` (serialize, not a raw
  // JSON.stringify): migrate runs on a reviver-free parse, so the M9.2 v21->v22 step backfills
  // a REAL Decimal (`stats.resourcesExchanged = new Decimal(0)`) that only serialize() tags back
  // to its `{ $d }` wire shape — a plain JSON.stringify would emit a bare "0" and spuriously
  // diverge from `full`. Every other (untouched) Decimal is already in `{ $d }` form and passes
  // through serialize unchanged, so the comparison stays byte-exact.
  const migrated = serialize(migrate(JSON.parse(preM10)))
  // The stripped (pre-M10) form must not mention the appended keys anywhere, and the migrated form must
  // be byte-identical to the M10 serialization.
  const strippedClean = !CAVALRY_IDS.some((id) => preM10.includes(`"${id}"`)) && !preM10.includes('"stable"')
  const roundTripOk = migrated === full

  const ok = issues.length === 0 && strippedClean && roundTripOk
  return {
    name: 'cavalry-inert',
    ok,
    detail: ok
      ? 'no-Stajnia state carries the cavalry/stable keys at inert 0; the pre-M10-stripped save migrates back byte-identically'
      : issues.length > 0
        ? `appended keys not inert: ${issues.join('; ')}`
        : !strippedClean
          ? 'stripped pre-M10 save still references the cavalry/stable keys'
          : 'pre-M10-stripped save did NOT migrate back to a byte-identical M10 state',
  }
}

/**
 * Cavalry population upkeep is COUNTED (M10): recruiting cavalry must drop a village's free population by
 * exactly `Σ unit.pop × count` (trained OR still queued — {@link usedPopulation} counts both), so the
 * heavy mounts genuinely draw on the farm budget like every other unit. From a Stajnia-unlocked,
 * well-stocked capital, measures {@link freePopulation} before and after recruiting both cavalry units and
 * requires the drop to equal the exact pop sum. Pure / deterministic — uses the real {@link recruit}.
 */
export function checkCavalryUpkeep(seed: string): InvariantResult {
  const state = createInitialState(seed, 0)
  const v = firstVillage(state)
  v.buildings.stable = 1 // unlock the cavalry
  v.resources = { wood: D(1e6), clay: D(1e6), iron: D(1e6) }
  v.popCap = D(1000)

  const N_LIGHT = 5
  const N_HEAVY = 3
  const before = freePopulation(v)
  const okLight = recruit(v, 'light_cavalry', N_LIGHT)
  const okHeavy = recruit(v, 'heavy_cavalry', N_HEAVY)
  const after = freePopulation(v)
  const expectedDrop = D(UNITS.light_cavalry.pop * N_LIGHT + UNITS.heavy_cavalry.pop * N_HEAVY)
  const actualDrop = before.sub(after)
  const ok = okLight && okHeavy && actualDrop.eq(expectedDrop)

  return {
    name: 'cavalry-upkeep',
    ok,
    detail: ok
      ? `recruiting ${N_LIGHT} light + ${N_HEAVY} heavy cavalry drew ${actualDrop.toString()} population (= Σ pop×count)`
      : !okLight || !okHeavy
        ? 'recruit refused a valid cavalry order (gate / cost / population)'
        : `free population dropped ${actualDrop.toString()}, expected ${expectedDrop.toString()}`,
  }
}

/**
 * A roster + in-flight march carrying cavalry SURVIVES save/load (M10, CLAUDE.md hard rule #3): from a
 * Stajnia-unlocked capital with cavalry owned, an attack INCLUDING cavalry is dispatched at a barbarian
 * camp (so the march's `units` carry the new keys), advanced one step so `remaining` is partial, then the
 * real export/import (base64) path must reproduce a byte-identical state with cavalry still in BOTH the
 * standing roster AND the in-flight march. Mirrors {@link checkMarketSaveLoad} / {@link checkFortressSaveLoad}.
 */
export function checkCavalrySaveLoad(seed: string): InvariantResult {
  const state = createInitialState(seed, 0)
  const vid = state.villageOrder[0]
  const v = state.villages[vid]
  // Proven economy (mirrors seedMarket): every building at its data max — which BUILDS the Stajnia
  // (unlocking the cavalry) and the barracks (canAttack gates on it), and leaves the DERIVED stats
  // (storageCap / popCap) consistent with the levels so importSave's recomputeDerived reproduces them
  // and the round-trip stays byte-identical. Resources at the (now maxed) cap; popCap easily holds the stack.
  for (const id of BUILDING_IDS) v.buildings[id] = BUILDINGS[id].maxLevel
  recomputeDerived(state)
  v.resources = { wood: v.storageCap, clay: v.storageCap, iron: v.storageCap }
  // Own a cavalry stack directly, then send a cavalry-bearing attack at a low camp it crushes.
  v.units.light_cavalry = 20
  v.units.heavy_cavalry = 10
  const army = zeroArmy()
  army.light_cavalry = 10
  army.heavy_cavalry = 5
  if (!sendAttack(v, state.world, state.battleLog, targetOfLevel(state.world, 2).id, army)) {
    return { name: 'cavalry-save-load', ok: false, detail: 'sendAttack refused a valid cavalry attack' }
  }
  simulate(state, 1) // advance one step so the march's `remaining` is a partial (non-initial) value

  const restored = importSave(exportSave(state))
  const a = serialize(state)
  const b = serialize(restored)
  const rv = restored.villages[vid]
  const rosterOk = rv !== undefined && rv.units.light_cavalry >= 1 && rv.units.heavy_cavalry >= 1
  const marchOk =
    rv !== undefined &&
    rv.marches.some((m) => (m.units.light_cavalry ?? 0) + (m.units.heavy_cavalry ?? 0) >= 1)
  const ok = a === b && rosterOk && marchOk

  return {
    name: 'cavalry-save-load',
    ok,
    detail: ok
      ? 'cavalry in the roster AND in an in-flight march survived export/import byte-identically'
      : a !== b
        ? 'state with cavalry (roster + in-flight march) changed across export/import'
        : 'cavalry did not survive export/import in the roster and/or the in-flight march',
  }
}

// --- M9.2 market EXCHANGE (RYNEK — wymiana surowców) proof-of-mechanic checks --------------------
//
// Deterministic, self-contained checks for the M9.2 resource exchange (convert one resource type into
// another AT THE SAME village, instantly, paying a spread). They isolate the guarantees the contract
// pins: the exchange STRICTLY LOSES value (received = floor(input × rate) with rate < 1, so a
// wood→clay→wood round-trip can never net resources and the empire total never rises), it is GATED on
// the Rynek (no market → refused, market → allowed), it is DETERMINISTIC (no rng / clock — same inputs
// yield byte-identical state), and a no-exchange run is BYTE-IDENTICAL to pre-M9.2 (the inert
// resourcesExchanged=0 counter strips back to the v21 save shape). No bot, no clock, no RNG — pure of
// the main run, so the existing core + meta targets stay byte-identical (the bot never exchanges).

/**
 * Exchange STRICTLY LOSES value (M9.2 — the key anti-arbitrage invariant): the received amount is exactly
 * `floor(input × rate)` with the rate ALWAYS < 1, so received is strictly less than the input, and the
 * empire-wide resource total never RISES across an exchange. Driven on the REAL engine
 * ({@link exchangeResources}) from a maxed-Rynek capital (the BEST attainable rate — if even that loses,
 * every level does) with a maxed warehouse (huge cap so credits land without spilling) and a clean
 * single-resource bankroll. Proves both a single leg AND a full wood→clay→wood round trip: the wood
 * recovered after the loop is STRICTLY less than the wood put in, and the total never grows on either leg
 * — exchange can never mint resources. Pure / deterministic.
 */
export function checkExchangeLoses(seed: string): InvariantResult {
  const state = createInitialState(seed, 0)
  const v = firstVillage(state)
  const vid = state.villageOrder[0]
  // Maxed economy: a maxed Rynek (best rate) + maxed warehouse (huge cap → credits land, no spill), then a
  // clean single-resource bankroll so the floored credit and the round-trip loss are exactly readable.
  for (const id of BUILDING_IDS) v.buildings[id] = BUILDINGS[id].maxLevel
  recomputeDerived(state)
  v.resources = { wood: D(100000), clay: ZERO, iron: ZERO }

  const rate = exchangeRate(v.buildings.market)
  const issues: string[] = []
  if (!(rate < 1)) issues.push(`exchangeRate(${v.buildings.market})=${rate} is not < 1 (exchange could mint resources)`)

  // Leg 1: wood → clay. received must equal floor(input × rate), be strictly < input, and never raise
  // the empire-wide total.
  const input1 = 100000
  const totalBefore = totalResources(state)
  const clayBefore = v.resources.clay
  if (!exchangeResources(state, vid, 'wood', 'clay', input1)) {
    return { name: 'exchange-loses', ok: false, detail: 'exchangeResources refused a valid exchange (cannot test the loss)' }
  }
  const received1 = v.resources.clay.sub(clayBefore)
  const expected1 = D(input1).mul(rate).floor()
  const total1 = totalResources(state)
  if (!received1.eq(expected1)) issues.push(`received ${received1.toString()} != floor(${input1}×${rate})=${expected1.toString()}`)
  if (!received1.lt(input1)) issues.push(`received ${received1.toString()} not < input ${input1} (no spread)`)
  if (total1.gt(totalBefore)) issues.push(`empire total ROSE ${totalBefore.toString()} -> ${total1.toString()} on a single exchange`)

  // Leg 2: clay → wood. The wood recovered must be STRICTLY less than the wood originally put in (a
  // wood→clay→wood round trip can never break even), and the total must not rise on the return leg.
  const input2 = received1.toNumber()
  const woodBefore = v.resources.wood // 0 after spending the whole bankroll on leg 1
  if (!exchangeResources(state, vid, 'clay', 'wood', input2)) {
    return { name: 'exchange-loses', ok: false, detail: 'exchangeResources refused the return leg (cannot test the round trip)' }
  }
  const received2 = v.resources.wood.sub(woodBefore)
  const total2 = totalResources(state)
  if (!received2.lt(input1)) issues.push(`round trip recovered ${received2.toString()} >= original ${input1} wood (arbitrage)`)
  if (total2.gt(total1)) issues.push(`empire total ROSE ${total1.toString()} -> ${total2.toString()} on the return leg`)

  return {
    name: 'exchange-loses',
    ok: issues.length === 0,
    detail:
      issues.length === 0
        ? `wood→clay→wood at rate ${rate} lost value on every leg (${input1} wood -> ${received2.toString()} wood; empire total never rose)`
        : issues.join('; '),
  }
}

/**
 * Exchange is GATED on the Rynek (M9.2): from one fixed, well-stocked capital that differs ONLY by the
 * market level, an exchange must be REFUSED with no market (level 0 — a fresh capital) and ALLOWED once a
 * Rynek stands (level 1). Resources are set far above the amount so the ONLY gate that can bite is the
 * market level — exactly the gate the MAIN run never opens (the bot never exchanges). Also asserts the
 * other ordered {@link canExchange} gates (same-resource, zero / negative amount) are refused even WITH a
 * market. Pure / deterministic.
 */
export function checkExchangeGated(seed: string): InvariantResult {
  const state = createInitialState(seed, 0)
  const v = firstVillage(state)
  const vid = state.villageOrder[0]
  v.resources = { wood: D(1e6), clay: D(1e6), iron: D(1e6) }

  const issues: string[] = []
  // No Rynek (a fresh capital has market:0) — exchange must be refused (validation AND commit).
  if (v.buildings.market !== 0) issues.push(`fresh capital has market=${v.buildings.market} (expected 0)`)
  if (canExchange(state, vid, 'wood', 'clay', 1000).ok) issues.push('canExchange ok with NO market (gate open)')
  if (exchangeResources(state, vid, 'wood', 'clay', 1000)) issues.push('exchangeResources succeeded with NO market')

  // Build a Rynek — the gate opens and a valid exchange is accepted.
  v.buildings.market = 1
  const withMarket = canExchange(state, vid, 'wood', 'clay', 1000)
  if (!withMarket.ok) issues.push(`canExchange refused WITH a market: ${withMarket.reason ?? 'unknown'}`)
  // The other ordered gates still bite even with a market: same resource, zero, negative amount.
  if (canExchange(state, vid, 'wood', 'wood', 1000).ok) issues.push('canExchange ok for a same-resource exchange')
  if (canExchange(state, vid, 'wood', 'clay', 0).ok) issues.push('canExchange ok for a zero amount')
  if (canExchange(state, vid, 'wood', 'clay', -5).ok) issues.push('canExchange ok for a negative amount')
  if (!exchangeResources(state, vid, 'wood', 'clay', 1000)) issues.push('exchangeResources refused WITH a market')

  return {
    name: 'exchange-gated',
    ok: issues.length === 0,
    detail:
      issues.length === 0
        ? 'exchange refused at market level 0 and allowed at level 1 (the Rynek gate the main run never opens)'
        : issues.join('; '),
  }
}

/**
 * Exchange is DETERMINISTIC (M9.2): it draws no rng and reads no clock, so two identical exchanges from
 * the SAME seed must yield byte-identical state. Mirrors {@link checkExchangeLoses}'s setup on two fresh
 * copies, performs the SAME exchange on each, and compares {@link serialize}. A divergence would mean a
 * hidden clock read / unseeded RNG slipped into the exchange path. Self-contained, Node-safe.
 */
export function checkExchangeDeterminism(seed: string): InvariantResult {
  const setup = (s: GameState): void => {
    const v = firstVillage(s)
    v.buildings.market = BUILDINGS.market.maxLevel
    v.resources = { wood: D(123456), clay: D(7000), iron: D(50) }
  }
  const a = createInitialState(seed, 0)
  const b = createInitialState(seed, 0)
  setup(a)
  setup(b)
  const okA = exchangeResources(a, a.villageOrder[0], 'wood', 'iron', 54321)
  const okB = exchangeResources(b, b.villageOrder[0], 'wood', 'iron', 54321)
  const serA = serialize(a)
  const serB = serialize(b)
  const ok = okA && okB && serA === serB
  return {
    name: 'exchange-determinism',
    ok,
    detail: ok
      ? 'identical exchanges from the same seed produced byte-identical state (no rng / clock)'
      : !okA || !okB
        ? 'exchangeResources refused a valid exchange (cannot test determinism)'
        : 'two identical exchanges from the same seed diverged (hidden nondeterminism)',
  }
}

/**
 * A no-exchange run is BYTE-IDENTICAL to pre-M9.2 (CLAUDE.md hard rule #3 / the contract's identity pin):
 * a state that never exchanges carries the single appended `stats.resourcesExchanged` Decimal at its inert
 * zero default, so stripping it yields exactly the PRE-M9.2 (v21) save shape. Proven two ways on a
 * realistic live state ({@link seedRecruitment}: a training queue + an in-flight march + active raids,
 * advanced a little):
 *  - INERTNESS: resourcesExchanged stayed at 0 (the bot/tick never exchange), AND
 *  - ROUND-TRIP EQUALITY: serialize → strip resourcesExchanged → stamp version 21 (the pre-M9.2 save
 *    shape) → {@link migrate} (the real v21→v22 backfill re-adds it at Decimal 0) → re-serialize must be
 *    byte-identical to the original M9.2 serialization, proving the addition is EXACTLY the inert
 *    zero-backfill of one stat and nothing more.
 * Mirrors {@link checkCavalryInert}. Pure / deterministic.
 */
export function checkExchangeInert(seed: string): InvariantResult {
  const state = createInitialState(seed, 0)
  seedRecruitment(state) // a live army + in-flight march + queue, NEVER exchanging
  simulate(state, 120) // advance the clocks while the (far) tier-6 march is still outbound

  const issues: string[] = []
  // INERTNESS: a run that never exchanges leaves the counter at its zero default.
  if (!state.stats.resourcesExchanged.eq(0)) {
    issues.push(`stats.resourcesExchanged=${state.stats.resourcesExchanged.toString()} (expected 0)`)
  }

  // Build the genuine pre-M9.2 (v21) save shape: strip the one new counter and stamp v21.
  const full = serialize(state)
  const preObj = JSON.parse(full) as { version: number; stats: Record<string, unknown> }
  preObj.version = 21
  delete preObj.stats.resourcesExchanged
  const preM92 = JSON.stringify(preObj)
  const strippedClean = !preM92.includes('"resourcesExchanged"')

  // Migrate it forward (the real v21→v22 zero-backfill). The migration must (a) re-ADD resourcesExchanged
  // at Decimal 0 and (b) change NOTHING else. The v21→v22 step APPENDS the counter to `stats` (whereas a
  // fresh state has it 4th), so a raw byte-string compare of the migrated vs original serialization would
  // diverge on key ORDER alone — not a real difference. So prove (b) ORDER-INDEPENDENTLY: strip the counter
  // from BOTH the migrated and the original M9.2 serialization (restoring the same key set/order on each)
  // and require byte-identity, and prove (a) by reading the backfilled counter back as Decimal 0. Re-
  // serialize through the SAME Decimal-tagging serializer as `full` (migrate runs on a reviver-free parse,
  // so the backfilled `new Decimal(0)` is only tagged to its `{ $d }` wire shape by serialize()).
  const migrated = migrate(JSON.parse(preM92))
  const backfillZero =
    isFiniteDecimal(migrated.stats?.resourcesExchanged) && migrated.stats.resourcesExchanged.eq(0)
  const migratedObj = JSON.parse(serialize(migrated)) as { stats: Record<string, unknown> }
  const fullObj = JSON.parse(full) as { stats: Record<string, unknown> }
  delete migratedObj.stats.resourcesExchanged
  delete fullObj.stats.resourcesExchanged
  const restIdentical = JSON.stringify(fullObj) === JSON.stringify(migratedObj)

  const ok = issues.length === 0 && strippedClean && backfillZero && restIdentical
  return {
    name: 'exchange-inert',
    ok,
    detail: ok
      ? 'a no-exchange run carries resourcesExchanged at inert 0; the pre-M9.2-stripped save migrates forward identical bar the zero counter'
      : issues.length > 0
        ? `counter not inert: ${issues.join('; ')}`
        : !strippedClean
          ? 'stripped pre-M9.2 save still references resourcesExchanged'
          : !backfillZero
            ? 'the v21→v22 migration did NOT backfill resourcesExchanged at Decimal 0'
            : 'pre-M9.2-stripped save migrated with changes beyond the zero-counter backfill',
  }
}

// --- M13 world events (time-limited windfall OFFERS) coverage -----------------------------------
//
// World events are an ADDITIVE, OPT-IN mechanic gated by the MANUALLY-built Wieża strażnicza
// (watchtower, autoBuildable:false). The gate is the IDENTITY guarantee: with no watchtower
// advanceEvents early-returns — the event timer never moves, the SEPARATE events RNG stream
// (events.rngState, seeded from `seed + '::events'`) never advances and `active` stays null — so the
// MAIN run and the combat-luck stream (state.rngState) stay BYTE-IDENTICAL to pre-M13. The sim bot /
// auto-build never raise an autoBuildable:false building, so the main run never opens the gate (no
// change to bot.ts). These deterministic proof-of-mechanic checks (no bot) mirror the M7 fortress /
// M10 cavalry coverage: a no-watchtower run leaves the events stream INERT (events-inert), an offer
// spawning through the tick replays byte-identically online vs chunked-offline (events-determinism),
// and a state carrying an injected ACTIVE offer survives the real save/load path (events-save-load).

/**
 * World events are INERT in a no-watchtower run (M13 — the byte-identity guarantee): after a normal
 * MAIN run (the bot never builds the autoBuildable:false Wieża, so {@link watchtowerBuilt} is false
 * throughout), {@link advanceEvents} was a pure no-op every sub-step — so the SEPARATE events RNG
 * stream still sits at its fresh `RNG.fromString(seed + '::events')` value, no offer ever spawned
 * (`active` null), the spawn timer never moved off {@link EVENT_INTERVAL}, and `stats.eventsResolved`
 * is still 0. This is exactly what keeps the combat-luck stream + the whole run byte-identical to
 * pre-M13: the events clock never draws, so it can never perturb the run. Takes the PRIMARY run's
 * final `state` (mirrors {@link checkStatsAccumulated}) — pure, no clock.
 */
export function checkEventsInert(state: GameState, seed: string): InvariantResult {
  const issues: string[] = []
  // The gate must have stayed shut for the whole run — otherwise inertness would be vacuous.
  if (watchtowerBuilt(state)) issues.push('a village built the Wieża (gate opened) — inert check is not meaningful')
  const ev = state.events
  const freshRng = RNG.fromString(seed + '::events').getState()
  if (ev.rngState !== freshRng) issues.push(`events.rngState=${ev.rngState} (expected fresh ${freshRng}) — the events stream advanced`)
  if (ev.active !== null) issues.push(`events.active=${JSON.stringify(ev.active)} (expected null) — an offer spawned`)
  if (ev.timer !== EVENT_INTERVAL) issues.push(`events.timer=${ev.timer} (expected ${EVENT_INTERVAL}) — the spawn clock moved`)
  if (state.stats.eventsResolved !== 0) issues.push(`stats.eventsResolved=${state.stats.eventsResolved} (expected 0)`)
  const ok = issues.length === 0
  return {
    name: 'events-inert',
    ok,
    detail: ok
      ? `no-watchtower run left the events stream fully inert (rngState fresh, no spawn, timer ${EVENT_INTERVAL}, 0 resolved) — byte-identical to pre-M13`
      : issues.join('; '),
  }
}

/**
 * Put a fresh state into the world-events scenario: build the Wieża (OPEN the gate so
 * {@link advanceEvents} runs) and arm the spawn clock to fire WELL inside the determinism window so
 * >= 1 offer spawns through the real tick. Both branches of the determinism check seed this
 * identically, so the equality isolates a real online/offline split rather than masking one.
 */
function seedEventsDue(state: GameState): void {
  const v = firstVillage(state)
  v.buildings.watchtower = 1 // OPEN the gate (autoBuildable:false — the main run never does this)
  recomputeDerived(state)
  // Short arm: with EVENT_TTL = 300 between spawns, several offers spawn-and-lapse across an hour
  // window (the tick never claims — claim is a player action), so the events stream advances repeatedly.
  state.events.timer = 300
}

/**
 * World-events DETERMINISM at INTEGRATION level (M13): an offer spawning inside the deterministic tick
 * sub-step draws ONLY from the persisted, seeded events RNG stream on the fixed tick grid, so crediting a
 * span as one big {@link simulate} (online catch-up) must be byte-identical to the chunked offline path
 * ({@link applyOffline}) — same events.rngState, same spawned offers. Mirrors {@link checkHordeDeterminism}
 * but on {@link seedEventsDue}, which arms the events clock to fire mid-span (the existing offline checks
 * never build a watchtower, so advanceEvents is a no-op there and no offer ever spawns). Also asserts
 * NON-VACUITY: the events stream ACTUALLY advanced (>= 1 spawn), so "identical" can never pass by drawing
 * nothing. `seconds` stays within {@link import('../src/engine/offline').MAX_OFFLINE_SECONDS} (the caller
 * uses an hour). NOTE: the tick never claims, so `eventsResolved` stays 0 in BOTH branches (equal) — the
 * lock-step proof is the events.rngState + the spawned `active` offer riding the serialization identically.
 */
export function checkEventsDeterminism(seed: string, seconds: number): InvariantResult {
  const big = createInitialState(seed, 0)
  seedEventsDue(big)
  const rng0 = big.events.rngState
  simulate(big, seconds)
  big.lastSeen = seconds * 1000 // mirror the bookkeeping applyOffline performs

  const chunked = createInitialState(seed, 0)
  seedEventsDue(chunked)
  applyOffline(chunked, seconds * 1000) // lastSeen starts at 0

  const equal = serialize(big) === serialize(chunked)
  const advanced = big.events.rngState !== rng0
  const rngMatches = big.events.rngState === chunked.events.rngState
  const ok = equal && advanced && rngMatches
  return {
    name: 'events-determinism',
    ok,
    detail: ok
      ? `events stream identical online vs chunked-offline (rngState ${rng0} -> ${big.events.rngState}, active ${big.events.active ? big.events.active.defId : 'null'})`
      : !advanced
        ? 'events stream never advanced — no offer spawned in the window (vacuous determinism check)'
        : !equal
          ? 'chunked offline catch-up diverged from a single-step simulate WITH an offer spawning (events stream / timer split)'
          : `events.rngState diverged online (${big.events.rngState}) vs offline (${chunked.events.rngState})`,
  }
}

/**
 * A pending world-event offer SURVIVES save/load (M13, CLAUDE.md hard rule #3): the {@link GameState.events}
 * stream — the SEPARATE events `rngState`, the spawn `timer` AND a live `active` offer (defId / ttl / roll)
 * — must ride the real export/import (base64) path byte-for-byte. The whole-state {@link checkRoundTrip}
 * proves serialize/deserialize is loss-free; this is the targeted proof that the v23 save carries
 * `state.events` (incl. an unclaimed offer) specifically, so a player who saves mid-offer reloads to the
 * SAME offer with the SAME countdown. Injects a distinctive offer + dirtied stream (so the round-trip must
 * carry every field, not the seed defaults) and runs it through the validating importSave. Mirrors
 * {@link checkHordeSaveLoad} / {@link checkFortressSaveLoad}. Pure function of a fresh seeded state.
 */
export function checkEventsSaveLoad(seed: string): InvariantResult {
  const state = createInitialState(seed, 0)
  // Distinctive, valid non-default values (defId in the catalogue, ttl >= 0, roll in [0,1]) so the
  // round-trip must carry BOTH the active offer AND the dirtied stream/counter — not just the defaults.
  const defId = WORLD_EVENTS[0].id
  state.events.active = { defId, ttl: 123.5, roll: 0.4242 }
  state.events.timer = 777.5
  state.events.rngState = 987654
  state.stats.eventsResolved = 5

  const restored = importSave(exportSave(state))
  const a = serialize(state)
  const b = serialize(restored)
  const ra = restored.events.active
  const activeSurvived =
    ra !== null && ra.defId === defId && ra.ttl === 123.5 && ra.roll === 0.4242
  const streamSurvived =
    restored.events.timer === 777.5 &&
    restored.events.rngState === 987654 &&
    restored.stats.eventsResolved === 5
  const ok = a === b && activeSurvived && streamSurvived
  return {
    name: 'events-save-load',
    ok,
    detail: ok
      ? `a pending "${defId}" offer (ttl 123.5, roll 0.4242) + the events stream survived export/import byte-identically`
      : a !== b
        ? 'state with a pending offer changed across export/import'
        : !activeSurvived
          ? 'the active offer did not survive export/import intact'
          : 'the events stream (timer / rngState / eventsResolved) did not survive export/import',
  }
}

// --- M14 timed event buffs (the first TEMPORARY modifier) coverage ------------------------------
//
// A timed buff is the game's FIRST temporary modifier: claiming a `kind: 'buff'` world event installs
// a single {@link import('../src/engine/state').ActiveBuff} that, while it lasts, folds a small bag
// onto the effective mods via aggregateEventBuffMods (systems/events.ts) — the SIXTH combine source,
// layered after tech × prestige × era × dynasty × challenge. It is gated by the SAME watchtower as the
// M13 offers, so the byte-identity guarantee is preserved: with no watchtower aggregateEventBuffMods
// returns the IDENTITY bag and advanceEvents never counts a buff down, so the MAIN run + combat-luck
// stream stay BYTE-IDENTICAL to pre-M14 (buff-inert). v1 buffs touch ONLY the in-flight axes
// (attackMult / lootMult / marchSpeedFrac) read from the threaded bag at the moment of use, so a buff
// needs NO recomputeDerived — it folds in on claim and reverts on expiry via the existing re-
// aggregation signal (advanceEvents returns true on the expiry step; the tick re-threads `mods`).
// These deterministic proof-of-mechanic checks mirror the M13 events-* coverage (no bot, no RNG).

/** A fresh seeded state with the watchtower built (gate OPEN) and a chosen buff OFFER ready to claim. */
function seedBuffOffer(seed: string, defId: string): GameState {
  const state = createInitialState(seed, 0)
  const v = firstVillage(state)
  v.buildings.watchtower = 1 // OPEN the gate — a buff only folds in / counts down with a watchtower
  recomputeDerived(state)
  state.events.active = { defId, ttl: EVENT_TTL, roll: 0.5 } // a buff offer the player can claim
  return state
}

/** True iff `bag` is field-for-field the identity {@link NO_TECH_MODS} (no temporary modifier). */
function buffBagIsIdentity(bag: TechModifiers): boolean {
  for (const r of RESOURCE_IDS) if (bag.productionMult[r] !== NO_TECH_MODS.productionMult[r]) return false
  return (
    bag.storageMult === NO_TECH_MODS.storageMult &&
    bag.popMult === NO_TECH_MODS.popMult &&
    bag.costReduction === NO_TECH_MODS.costReduction &&
    bag.recruitSpeedFrac === NO_TECH_MODS.recruitSpeedFrac &&
    bag.marchSpeedFrac === NO_TECH_MODS.marchSpeedFrac &&
    bag.attackMult === NO_TECH_MODS.attackMult &&
    bag.defenseMult === NO_TECH_MODS.defenseMult &&
    bag.lootMult === NO_TECH_MODS.lootMult &&
    bag.automations.build === NO_TECH_MODS.automations.build &&
    bag.automations.recruit === NO_TECH_MODS.automations.recruit &&
    bag.automations.attack === NO_TECH_MODS.automations.attack
  )
}

/** The attack buff (`piesn_wojenna`, mods.attackMult 1.6) — the buff used by the apply/expiry/determinism proofs. */
const BUFF_ATTACK_ID = 'piesn_wojenna'

/**
 * Claiming a buff FOLDS its mods into effectiveMods (M14, buff-applies): with the watchtower built and an
 * attack-buff offer on the table, {@link claimEvent} installs `events.buff`, and the next
 * {@link effectiveMods} must reflect the buff's `attackMult` as the sixth combine source — strictly above
 * the pre-claim value, and EXACTLY `before × def.mods.attackMult` (the buff is authored as the final
 * factor). Pure, no RNG, no clock. Deterministic for a given seed.
 */
export function checkBuffApplies(seed: string): InvariantResult {
  const def = WORLD_EVENTS_BY_ID[BUFF_ATTACK_ID]
  const factor = def && def.kind === 'buff' ? def.mods.attackMult ?? 1 : 1
  const state = seedBuffOffer(seed, BUFF_ATTACK_ID)
  const before = effectiveMods(state).attackMult // identity-from-buff (no buff installed yet)
  const claimed = claimEvent(state) // installs events.buff via the real player-action path
  const installed = state.events.buff !== null && state.events.buff.defId === BUFF_ATTACK_ID
  const after = effectiveMods(state).attackMult // buff now folded into the combine chain
  const ok =
    claimed && installed && factor > 1 && after > before && Math.abs(after - before * factor) < 1e-9
  return {
    name: 'buff-applies',
    ok,
    detail: ok
      ? `claiming "${BUFF_ATTACK_ID}" raised effectiveMods.attackMult ${before} -> ${after} (×${factor}, the 6th combine source)`
      : !claimed
        ? 'claimEvent did not install the buff (gate / offer issue)'
        : !installed
          ? 'events.buff was not set to the claimed buff'
          : `attackMult did not reflect the buff: ${before} -> ${after} (expected ×${factor})`,
  }
}

/**
 * A buff COUNTS DOWN on the tick grid and REVERTS effectiveMods byte-identically on expiry (M14,
 * buff-expires-reverts). After claiming the attack buff (effectiveMods.attackMult strictly up),
 * stepping {@link advanceEvents} on the fixed grid past the buff's `duration` must clear `events.buff`,
 * make advanceEvents RETURN the expiry signal (so the tick re-aggregates the threaded `mods`), and leave
 * effectiveMods.attackMult EXACTLY back at the pre-buff baseline (`reverted === base` — the v1 in-flight
 * axes need no recomputeDerived). The spawn clock, re-armed a full {@link EVENT_INTERVAL} out by the
 * claim, cannot fire inside this short window, so the only buff change is its expiry. Pure, no RNG.
 */
export function checkBuffExpiresReverts(seed: string): InvariantResult {
  const def = WORLD_EVENTS_BY_ID[BUFF_ATTACK_ID]
  const duration = def && def.kind === 'buff' ? def.duration : 0
  const state = seedBuffOffer(seed, BUFF_ATTACK_ID)
  const base = effectiveMods(state).attackMult // pre-buff baseline (identity)
  claimEvent(state)
  const buffed = effectiveMods(state).attackMult
  const dt = 1
  const limit = Math.ceil(duration / dt) + 5
  let signalled = false
  for (let t = 0; t < limit && state.events.buff !== null; t++) {
    if (advanceEvents(state, dt)) signalled = true // advanceEvents returns true on the expiry step
  }
  const expired = state.events.buff === null
  const reverted = effectiveMods(state).attackMult
  const ok = buffed > base && expired && signalled && reverted === base
  return {
    name: 'buff-expires-reverts',
    ok,
    detail: ok
      ? `"${BUFF_ATTACK_ID}" attackMult ${base} ->(buff) ${buffed} ->(expiry after ${duration}s) ${reverted} — reverted byte-identically; advanceEvents signalled re-aggregation`
      : !(buffed > base)
        ? `buff never raised attackMult (base ${base}, buffed ${buffed})`
        : !expired
          ? `buff did not expire within ${limit} ticks`
          : !signalled
            ? 'advanceEvents never returned the expiry signal'
            : `attackMult did not revert: base ${base}, after expiry ${reverted}`,
  }
}

/**
 * Buff countdown is DETERMINISTIC online vs chunked-offline (M14, buff-determinism). A watchtower'd state
 * carrying a LIVE buff (remaining = its full duration) plus an armed spawn clock must produce a
 * byte-identical {@link serialize} whether the span is credited as one big {@link simulate} (online
 * catch-up) or chunked through {@link applyOffline}: the buff burns down on the SAME tick grid and the
 * events RNG stream draws spawning offers in lock-step. Asserts NON-VACUITY — the buff was installed and
 * actually expired in the window — so "identical" can never pass by doing nothing. `seconds` stays within
 * the offline cap (the caller uses an hour). Mirrors {@link checkEventsDeterminism} with a buff added.
 */
export function checkBuffDeterminism(seed: string, seconds: number): InvariantResult {
  const def = WORLD_EVENTS_BY_ID[BUFF_ATTACK_ID]
  const duration = def && def.kind === 'buff' ? def.duration : 0
  const make = (): GameState => {
    const s = createInitialState(seed, 0)
    const v = firstVillage(s)
    v.buildings.watchtower = 1 // OPEN the gate (the main run never does — autoBuildable:false)
    recomputeDerived(s)
    // A live buff expiring WELL inside the window (both paths must count it down on the grid) + an armed
    // spawn clock so offers also spawn-and-lapse — a combined buff + offer determinism proof.
    s.events.buff = { defId: BUFF_ATTACK_ID, remaining: duration }
    s.events.timer = 300
    return s
  }
  const big = make()
  const startedBuffed = big.events.buff !== null
  simulate(big, seconds)
  big.lastSeen = seconds * 1000 // mirror the bookkeeping applyOffline performs

  const chunked = make()
  applyOffline(chunked, seconds * 1000) // lastSeen starts at 0

  const equal = serialize(big) === serialize(chunked)
  const expired = big.events.buff === null // the buff actually counted down (non-vacuity)
  const ok = equal && startedBuffed && expired
  return {
    name: 'buff-determinism',
    ok,
    detail: ok
      ? `a live "${BUFF_ATTACK_ID}" buff (${duration}s) + spawning offers replayed identically online vs chunked-offline (buff expired on the grid)`
      : !startedBuffed
        ? 'buff was not installed (setup issue)'
        : !expired
          ? 'buff did not expire within the window (vacuous determinism check)'
          : 'online single-step simulate diverged from chunked offline catch-up (buff.remaining / events stream split)',
  }
}

/**
 * Buffs are INERT in a no-watchtower run (M14 — the byte-identity guarantee, extends events-inert): after
 * a normal MAIN run the bot never builds the autoBuildable:false Wieża, so a buff can NEVER be installed
 * ({@link claimEvent} no-ops without one) — `events.buff` stays null — AND {@link aggregateEventBuffMods}
 * returns the IDENTITY bag, so `combine(x, identity) === x` leaves effectiveMods byte-identical to the
 * five-source pre-M14 chain. Reads the PRIMARY run's final state (mirrors {@link checkEventsInert}). Pure.
 */
export function checkBuffInert(state: GameState, seed: string): InvariantResult {
  const issues: string[] = []
  if (watchtowerBuilt(state)) issues.push('a village built the Wieża (gate opened) — buff-inert is not meaningful')
  if (state.events.buff !== null)
    issues.push(`events.buff=${JSON.stringify(state.events.buff)} (expected null) — a buff was installed without a watchtower`)
  if (!buffBagIsIdentity(aggregateEventBuffMods(state)))
    issues.push('aggregateEventBuffMods returned a non-identity bag with no watchtower (would perturb effectiveMods)')
  const ok = issues.length === 0
  void seed // kept for signature symmetry with checkEventsInert (no per-seed state to read here)
  return {
    name: 'buff-inert',
    ok,
    detail: ok
      ? 'no-watchtower run kept events.buff null with an identity buff bag — effectiveMods byte-identical to pre-M14'
      : issues.join('; '),
  }
}

// --- M15 forge (KUŹNIA — permanent account-wide per-unit upgrades) coverage ---------------------
//
// The Kuźnia is the game's FIRST per-unit-type modifier (the tech/prestige trees only ever grant
// GLOBAL attack/defense multipliers). It is an ADDITIVE, OPT-IN mechanic gated by the MANUALLY-built
// Kuźnia (content/buildings.forge, autoBuildable:false). The gate is the IDENTITY guarantee: with no
// Kuźnia the upgrade map {@link GameState.forge} stays EMPTY, so the OPTIONAL `forge` param threaded
// into armyAttackPower / armyDefensePower is undefined → unitUpgradeMult(0) = ×1.0 → every combat
// resolution is BYTE-IDENTICAL to pre-M15. The sim bot / auto-build never raise an autoBuildable:false
// building (MAIN_BUILD_IDS), so the main run never opens the gate (no change to bot.ts). These
// deterministic proof-of-mechanic checks (no bot, no RNG — upgrades are a pure player action) mirror
// the M13 events-* / M10 cavalry coverage: a no-Kuźnia run leaves the forge map inert AND migrates
// back to a byte-identical pre-M15 save (forge-inert), each upgrade scales attack AND defense by exactly
// unitUpgradeMult (upgrade-applies), the same upgrades replay byte-identically (upgrade-determinism),
// and a state carrying a forge map survives the v25 save/load path (upgrade-save-load).

/**
 * Unit upgrades are INERT in a no-Kuźnia run (M15 — the byte-identity guarantee): after a normal MAIN
 * run the bot never builds the autoBuildable:false Kuźnia, so the upgrade map {@link GameState.forge}
 * was never written ({@link upgradeUnit} no-ops without one — {@link canUpgrade} gates on a built
 * Kuźnia), the lifetime `stats.unitsUpgraded` counter is still 0, and no village raised a Kuźnia. With
 * an EMPTY forge map the optional `forge` combat param is a pure ×1.0 no-op, so the with-forge and
 * without-forge powers are byte-equal for EVERY village roster — exactly what keeps the run identical to
 * pre-M15. Finally, the STRONGEST identity proof (mirrors {@link checkCavalryInert}): strip the forge
 * BUILDING key, the forge map and the unitsUpgraded counter, stamp the save back to v24, and require the
 * v24→v25 migration to reproduce a BYTE-IDENTICAL v25 serialization — proof a no-Kuźnia run never left
 * pre-M15 ground. Reads the PRIMARY run's final `state` (mirrors {@link checkEventsInert}). Pure, no clock.
 */
export function checkForgeInert(state: GameState, seed: string): InvariantResult {
  const issues: string[] = []
  // The gate must have stayed shut for the whole run, else inertness would be vacuous.
  if (forgeBuilt(state)) issues.push('a village built the Kuźnia (gate opened) — forge-inert is not meaningful')
  // INERTNESS: the forge map is empty, the counter is 0, no village raised a Kuźnia.
  const keys = Object.keys(state.forge)
  if (keys.length !== 0) issues.push(`state.forge not empty: ${keys.join(', ')}`)
  if (state.stats.unitsUpgraded !== 0) issues.push(`stats.unitsUpgraded=${state.stats.unitsUpgraded} (expected 0)`)
  for (const vid of state.villageOrder) {
    const fl = state.villages[vid].buildings.forge
    if (fl !== 0) issues.push(`${vid}.buildings.forge=${fl}`)
  }

  // POWER IDENTITY: with an empty forge map the optional `forge` param is a pure ×1.0 no-op — the
  // with-forge and without-forge powers must be byte-equal for every roster (the combat-identity guarantee).
  const mods = effectiveMods(state)
  for (const vid of state.villageOrder) {
    const u = state.villages[vid].units
    if (armyAttackPower(u, mods) !== armyAttackPower(u, mods, state.forge)) {
      issues.push(`${vid} attack power differs with the empty forge map`)
    }
    if (armyDefensePower(u, mods) !== armyDefensePower(u, mods, state.forge)) {
      issues.push(`${vid} defense power differs with the empty forge map`)
    }
  }

  // ROUND-TRIP EQUALITY: build the pre-M15 save shape (strip the forge building key, the forge map and the
  // unitsUpgraded counter, stamp v24), migrate it (the v24→v25 empty/zero backfill) and require the re-
  // serialization to be byte-identical to the M15 form. The 24→25 step backfills only PLAIN values
  // (forge:{}, unitsUpgraded:0 — no Decimal), and createInitialState places `forge` LAST at the top level
  // and `unitsUpgraded` LAST in stats, exactly where the spread-then-assign migration re-adds them, so the
  // key order matches byte-for-byte. Re-serialize through the SAME Decimal-tagging serializer (mirrors
  // checkCavalryInert) for consistency.
  const full = serialize(state)
  const obj = JSON.parse(full) as {
    version: number
    villageOrder: string[]
    villages: Record<string, { buildings: Record<string, number> }>
    forge?: unknown
    stats: Record<string, unknown>
  }
  obj.version = 24
  for (const vid of obj.villageOrder) delete obj.villages[vid].buildings.forge
  delete obj.forge
  delete obj.stats.unitsUpgraded
  const preM15 = JSON.stringify(obj)
  const migrated = serialize(migrate(JSON.parse(preM15)))
  const strippedClean = !preM15.includes('"forge"') && !preM15.includes('"unitsUpgraded"')
  const roundTripOk = migrated === full

  void seed // kept for signature symmetry with checkEventsInert / checkBuffInert (no per-seed state read here)
  const ok = issues.length === 0 && strippedClean && roundTripOk
  return {
    name: 'forge-inert',
    ok,
    detail: ok
      ? 'no-Kuźnia run kept the forge map empty (×1.0 combat identity); the pre-M15-stripped save migrates back byte-identically'
      : issues.length > 0
        ? `forge not inert: ${issues.join('; ')}`
        : !strippedClean
          ? 'stripped pre-M15 save still references the forge keys'
          : 'pre-M15-stripped save did NOT migrate back to a byte-identical M15 state',
  }
}

/**
 * An upgrade SCALES a unit type's attack AND defense by EXACTLY {@link unitUpgradeMult} (M15,
 * upgrade-applies): from a Kuźnia-built capital (gate open, full depth cap), upgrading a SINGLE type
 * step-by-step toward its effective cap must lift a single-type army's attack and defense to EXACTLY
 * `base × unitUpgradeMult(level)` at every level — the one shared multiplier the smith grants to both
 * weapon and armour. Drives the REAL {@link upgradeUnit} (a player action), refilling the capital so the
 * rising sink is always affordable, and asserts the exact ratio after each level (so the proof is the
 * precise per-level scaling, not just "went up"). Pure / deterministic — upgrades draw no rng / clock.
 */
export function checkUpgradeApplies(seed: string): InvariantResult {
  const state = createInitialState(seed, 0)
  const v = firstVillage(state)
  // Max every building (builds the Kuźnia to its depth cap + a maxed warehouse so the rising sink fits
  // under the storage cap), then refill — exactly the dedicated-run economy (mirrors checkCavalrySaveLoad).
  for (const id of BUILDING_IDS) v.buildings[id] = BUILDINGS[id].maxLevel
  recomputeDerived(state)
  v.resources = { wood: v.storageCap, clay: v.storageCap, iron: v.storageCap }
  const mods = effectiveMods(state)

  // A single-type army so the per-type multiplier is isolated (no other type contributes).
  const unitId: UnitId = 'axeman'
  const army = zeroArmy()
  army[unitId] = 100
  const base = armyAttackPower(army, mods) // level 0, no forge param = ×1.0 baseline
  const defBase = armyDefensePower(army, mods)

  const cap = effectiveMaxUpgrade(state, unitId)
  const fails: string[] = []
  let levels = 0
  for (let target = 1; target <= cap; target++) {
    v.resources = { wood: v.storageCap, clay: v.storageCap, iron: v.storageCap } // refill the rising sink
    if (!upgradeUnit(state, unitId)) {
      fails.push(`upgrade to L${target} refused`)
      break
    }
    levels += 1
    const lvl = unitUpgradeLevel(state, unitId)
    const m = unitUpgradeMult(lvl)
    const att = armyAttackPower(army, mods, state.forge)
    const def = armyDefensePower(army, mods, state.forge)
    if (Math.abs(att - base * m) > 1e-6) fails.push(`L${lvl} attack ${att} != base ${base} × ${m}`)
    if (Math.abs(def - defBase * m) > 1e-6) fails.push(`L${lvl} defense ${def} != base ${defBase} × ${m}`)
  }

  const finalAtt = armyAttackPower(army, mods, state.forge)
  const ok =
    levels >= 1 &&
    fails.length === 0 &&
    finalAtt > base &&
    state.stats.unitsUpgraded === levels
  return {
    name: 'upgrade-applies',
    ok,
    detail: ok
      ? `upgrading ${unitId} L1..L${levels} scaled attack ${base.toFixed(0)} -> ${finalAtt.toFixed(0)} and defense by exactly unitUpgradeMult at every level`
      : levels < 1
        ? 'upgradeUnit refused the first valid upgrade (gate / cost / cap)'
        : fails.join('; '),
  }
}

/**
 * Unit upgrades are DETERMINISTIC (M15, upgrade-determinism): {@link upgradeUnit} draws NO rng and reads
 * NO clock, so two identical Kuźnia-built capitals driven through the SAME upgrade sequence must produce a
 * byte-identical {@link serialize}. Upgrades every upgradeable type to its effective cap on both (refilling
 * so the rising sink is affordable), then compares the serializations. Asserts NON-VACUITY (>= 1 upgrade
 * actually happened) so "identical" can never pass by doing nothing. Pure function of the seed.
 */
export function checkUpgradeDeterminism(seed: string): InvariantResult {
  const make = (): GameState => {
    const s = createInitialState(seed, 0)
    const v = firstVillage(s)
    for (const id of BUILDING_IDS) v.buildings[id] = BUILDINGS[id].maxLevel
    recomputeDerived(s)
    for (const id of UNIT_IDS) {
      const cap = effectiveMaxUpgrade(s, id)
      for (let t = 0; t < cap; t++) {
        v.resources = { wood: v.storageCap, clay: v.storageCap, iron: v.storageCap }
        if (!upgradeUnit(s, id)) break
      }
    }
    return s
  }
  const a = make()
  const b = make()
  const equal = serialize(a) === serialize(b)
  const upgraded = a.stats.unitsUpgraded
  const ok = equal && upgraded >= 1
  return {
    name: 'upgrade-determinism',
    ok,
    detail: ok
      ? `two identical upgrade runs of seed "${seed}" produced byte-identical state (${upgraded} upgrades each)`
      : !(upgraded >= 1)
        ? 'no upgrade happened (vacuous determinism check)'
        : 'two identical upgrade sequences of the same seed diverged',
  }
}

/**
 * A forge map SURVIVES save/load (M15, CLAUDE.md hard rule #3): from a Kuźnia-built capital, upgrading
 * several DISTINCT types to DISTINCT levels (so the {@link GameState.forge} map carries real, varied data —
 * not the empty default), the real export/import (base64, validating) path must reproduce a byte-identical
 * state with every upgrade level AND the lifetime `unitsUpgraded` counter intact. The whole-state
 * {@link checkRoundTrip} proves serialize/deserialize is loss-free; this is the targeted proof that the v25
 * save carries `state.forge` specifically. Mirrors {@link checkCavalrySaveLoad} / {@link checkEventsSaveLoad}.
 */
export function checkUpgradeSaveLoad(seed: string): InvariantResult {
  const state = createInitialState(seed, 0)
  const v = firstVillage(state)
  for (const id of BUILDING_IDS) v.buildings[id] = BUILDINGS[id].maxLevel
  recomputeDerived(state)

  // Upgrade three distinct types to three distinct levels (each <= the effective cap), refilling so each
  // rising-cost level is affordable. Distinct levels make the round-trip carry real per-type data.
  const plan: Array<{ id: UnitId; to: number }> = [
    { id: 'axeman', to: 3 },
    { id: 'spearman', to: 2 },
    { id: 'light_cavalry', to: 1 },
  ]
  for (const { id, to } of plan) {
    for (let t = 0; t < to; t++) {
      v.resources = { wood: v.storageCap, clay: v.storageCap, iron: v.storageCap }
      if (!upgradeUnit(state, id)) break
    }
  }

  const restored = importSave(exportSave(state))
  const a = serialize(state)
  const b = serialize(restored)
  const forgeSurvived = plan.every(({ id }) => (restored.forge[id] ?? 0) === (state.forge[id] ?? 0))
  const someUpgraded = plan.some(({ id }) => (restored.forge[id] ?? 0) >= 1)
  const statSurvived = restored.stats.unitsUpgraded === state.stats.unitsUpgraded
  const ok = a === b && forgeSurvived && someUpgraded && statSurvived
  return {
    name: 'upgrade-save-load',
    ok,
    detail: ok
      ? `forge map {${plan.map(({ id }) => `${id}:${state.forge[id] ?? 0}`).join(', ')}} (unitsUpgraded=${state.stats.unitsUpgraded}) survived export/import byte-identically`
      : a !== b
        ? 'state with a forge map changed across export/import'
        : !someUpgraded
          ? 'no upgrade was recorded (setup issue — nothing to round-trip)'
          : 'the forge map / unitsUpgraded did not survive export/import intact',
  }
}

/**
 * Kuźnia upgrades RESET on prestige/era (M15, forge-resets-on-ascend): unit upgrades are a per-RUN sink
 * (bought with the capital's wood/clay/iron in {@link upgradeUnit}) gated per-run by the Kuźnia building,
 * which BOTH resets rebuild at level 0 (fresh createVillage capital). So the {@link GameState.forge} map must
 * be wiped by {@link ascend}, {@link newEra}, {@link newDynasty} AND {@link startChallenge} exactly like
 * state.tech (EVERY meta reset rebuilds a level-0 capital) — otherwise the next run keeps
 * permanent ×mult upgrades for free, with a level-0 Kuźnia and zero resources spent, and combat would apply
 * upgrade levels above effectiveMaxUpgrade (= min(catalog, forgeLevel 0) = 0). Drives the REAL resets from a
 * Kuźnia-built, upgraded capital and asserts the map is empty afterwards, that the bank fired (non-vacuous),
 * and that the ×1.0 combat identity is restored. Pure / deterministic — resets take no clock and the only
 * RNG is the seeded stream. The lifetime `unitsUpgraded` trophy is deliberately NOT checked here (it survives).
 */
export function checkForgeResetsOnAscend(seed: string): InvariantResult {
  const fails: string[] = []

  // A Kuźnia-built capital with a few types upgraded, so state.forge carries real (non-empty) data.
  const buildAndUpgrade = (s: GameState): void => {
    const v = firstVillage(s)
    for (const id of BUILDING_IDS) v.buildings[id] = BUILDINGS[id].maxLevel
    recomputeDerived(s)
    for (const id of ['axeman', 'spearman'] as UnitId[]) {
      const cap = effectiveMaxUpgrade(s, id)
      for (let t = 0; t < cap; t++) {
        v.resources = { wood: v.storageCap, clay: v.storageCap, iron: v.storageCap }
        if (!upgradeUnit(s, id)) break
      }
    }
  }

  // A non-trivial army so the ×1.0 combat-identity assertion is meaningful (a zero army would pass vacuously).
  const army = zeroArmy()
  army.axeman = 100
  army.spearman = 50

  // ASCEND: a non-empty forge map must be wiped (the reset rebuilds the Kuźnia at level 0).
  const a = createInitialState(seed, 0)
  buildAndUpgrade(a)
  if (Object.keys(a.forge).length === 0) fails.push('setup: forge map empty before ascend')
  const pp = ascend(a)
  if (pp <= 0) fails.push('ascend banked no PP (cannot test the reset)')
  if (Object.keys(a.forge).length !== 0) fails.push(`forge not cleared by ascend: ${Object.keys(a.forge).join(', ')}`)
  const modsA = effectiveMods(a)
  if (armyAttackPower(army, modsA) !== armyAttackPower(army, modsA, a.forge)) {
    fails.push('ascend: attack ×1.0 identity broken (forge map not empty)')
  }
  if (armyDefensePower(army, modsA) !== armyDefensePower(army, modsA, a.forge)) {
    fails.push('ascend: defense ×1.0 identity broken (forge map not empty)')
  }

  // NOWA ERA (the great reset): must wipe the forge map too. Seed a positive era score first.
  const e = createInitialState(seed, 0)
  buildAndUpgrade(e)
  e.prestige = { points: 0, totalEarned: 300, ascensions: 5, nodes: {} }
  if (Object.keys(e.forge).length === 0) fails.push('setup: forge map empty before newEra')
  const ep = newEra(e)
  if (ep <= 0) fails.push('newEra banked no EP (cannot test the reset)')
  if (Object.keys(e.forge).length !== 0) fails.push(`forge not cleared by newEra: ${Object.keys(e.forge).join(', ')}`)

  // NOWA DYNASTIA (the great-great reset): must wipe the forge map too. Seed a positive era account
  // so pendingDynastyPoints fires (DP is measured from era progress — dynastyScore >= totalEarned).
  const d = createInitialState(seed, 0)
  buildAndUpgrade(d)
  d.era = { points: 0, totalEarned: 1000, eras: 1, nodes: {} }
  if (Object.keys(d.forge).length === 0) fails.push('setup: forge map empty before newDynasty')
  const dp = newDynasty(d)
  if (dp <= 0) fails.push('newDynasty banked no DP (cannot test the reset)')
  if (Object.keys(d.forge).length !== 0) fails.push(`forge not cleared by newDynasty: ${Object.keys(d.forge).join(', ')}`)

  // START WYZWANIA (resets the run mirroring ascend): must wipe the forge map too — a challenge is a
  // clean-slate run, so carried-over upgrades would grant free power AND break the run's determinism.
  const c = createInitialState(seed, 0)
  buildAndUpgrade(c)
  if (Object.keys(c.forge).length === 0) fails.push('setup: forge map empty before startChallenge')
  if (!startChallenge(c, CHALLENGE_IDS[0])) fails.push('startChallenge refused a valid id (cannot test the reset)')
  if (Object.keys(c.forge).length !== 0) fails.push(`forge not cleared by startChallenge: ${Object.keys(c.forge).join(', ')}`)

  const ok = fails.length === 0
  return {
    name: 'forge-resets-on-ascend',
    ok,
    detail: ok
      ? 'ascend, newEra, newDynasty and startChallenge all wipe the Kuźnia upgrade map (no free permanent upgrades survive any meta reset; ×1.0 combat identity restored)'
      : fails.join('; '),
  }
}
