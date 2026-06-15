import { TECH_NODES, TECH_NODE_IDS } from '../content/tech'

/**
 * Radial constellation LAYOUT — a pure, deterministic placement of a Path-of-Exile
 * style passive tree (M3.1: the tech tree; M4.1 onward: the prestige tree too),
 * computed ENTIRELY from the topology of a node set. There are NO hand-authored
 * coordinates anywhere: feed it the data and it derives a radial map (a central hub,
 * one arm per category, clusters marching outward along each arm, a notable in the
 * middle of every cluster with its minors ringed around it; a gateway that opens THIS
 * cluster sits at its hub-side junction, one that leads onward is pushed out toward
 * the next cluster).
 *
 * Generic core, thin wrappers: {@link layoutNodes} / {@link nodeEdges} take ANY node
 * set shaped like {@link LayoutNode} (category / cluster / archetype / prerequisites)
 * plus its stable id list, so the prestige tree reuses the exact same algorithm. The
 * tech-specific {@link layoutTree} / {@link techEdges} are now zero-cost wrappers that
 * pass TECH_NODES / TECH_NODE_IDS — their output is byte-for-byte unchanged.
 *
 * Why it lives in `systems/` (not the UI): the panel is a dumb renderer of points
 * and lines. layoutNodes()/nodeEdges() are the model; the SVG view (panels/tech.ts,
 * panels/treeView.ts) just frames the returned coordinates in a pan/zoom viewBox
 * exactly the way panels/map.ts frames world coordinates. The same pure output also
 * lets the sim harness assert "every id has a position" and "no gross overlaps"
 * without a DOM.
 *
 * Import discipline: this module imports ONLY the pure data from content/tech.ts
 * (no engine, no clock, no RNG, no Decimal), so it can never form an initialisation
 * cycle and its output is byte-identical across replays/platforms. The generic
 * functions take their data as arguments, so the prestige content adds no new import.
 *
 * Coordinate space: an abstract layout space centred on the hub at (0, 0); +x is
 * right, +y is DOWN (SVG convention), so the first arm — offset to -y — points up
 * on screen. Absolute scale is irrelevant: the panel computes its viewBox from the
 * bounds (see {@link layoutBounds}). Coordinates are rounded to 2dp so snapshot /
 * round-trip tests stay stable regardless of trig rounding across engines.
 *
 * ── ALGORITHM (manifest) ───────────────────────────────────────────────────────
 *  1. CATEGORIES → ARMS. Categories are discovered in first-appearance order over
 *     the supplied id list (stable). With K categories, arm k points at angle
 *     ARM_ANGLE0 + k·(2π/K) — evenly spread around the hub.
 *  2. NODE DEPTH. Shortest distance from a root (no-prereq node) along prerequisite
 *     edges, memoised; used to order clusters so unlocks flow OUTWARD from the hub.
 *  3. CLUSTERS → RADIAL SLOTS. Within an arm, clusters are ordered by (minDepth,
 *     first-appearance) and laid out at increasing radius. Spacing is ADAPTIVE: each
 *     cluster reserves an inner + outer extent sized to its own ring, and the next
 *     cluster starts a fixed gap beyond — so clusters of any size never overlap.
 *  4. NODES WITHIN A CLUSTER.
 *       • centre  = the cluster's notable (else its shallowest node) at the slot point.
 *       • minors  = a ring around the centre; the ring radius grows with the count so
 *                   neighbours keep a minimum separation. The ring STARTS on the hub
 *                   side, so the cluster's entry/prereq sits nearest the centre.
 *       • gateways = INWARD (hub-side junction, just before the centre) when the
 *                   gateway unlocks one of this cluster's own members; OUTWARD past
 *                   the ring when its dependents live in a deeper cluster. Either
 *                   side is fanned tangentially when it holds more than one.
 *  5. WEDGE FIT. The innermost band radius R0 is enlarged if needed so the widest
 *     cluster's angular half-width stays well inside its arm's share of the circle —
 *     so arms never bleed into each other (holds as more categories are added).
 *  6. EDGES. One edge per (prerequisite → node) pair, in stable id-list order.
 *
 * Everything is memoised per node set on first use (the data is static, keyed by the
 * data object's identity), so layoutNodes()/nodeEdges() for a given tree — and the
 * tech wrappers layoutTree(), techEdges(), layoutBounds() and TECH_HUB — all reflect
 * one consistent computation.
 */

/**
 * The minimal node shape the layout reads: its arm (category), its authoring unit
 * (cluster), its role (archetype: 'minor' | 'notable' | 'gateway' as plain strings)
 * and its prerequisite ids. A node's OWN id is the key in the `Record` / the id list,
 * never a field here — so both {@link TechNode} and {@link PrestigeNode} satisfy it.
 */
export interface LayoutNode {
  category: string
  cluster: string
  archetype: string
  prerequisites: string[]
}

export interface NodePos {
  x: number
  y: number
}

/** One directed edge in the constellation: the prerequisite unlocks the dependent. */
export interface TechEdge {
  from: string
  to: string
}

/** Axis-aligned bounds of all node centres (no node-radius margin — the view adds it). */
export interface LayoutBounds {
  minX: number
  minY: number
  maxX: number
  maxY: number
  width: number
  height: number
}

const TAU = Math.PI * 2
/** First arm's angle; -π/2 puts category #1 straight up on screen (SVG y is down). */
const ARM_ANGLE0 = -Math.PI / 2
/** Ring radius for a small cluster (1 minor); grows with the minor count beyond this. */
const BASE_RING = 64
/** Minimum centre-to-centre distance between two adjacent ring (minor) nodes. */
const MIN_SEP = 80
/** How far a gateway sits beyond the ring, outward (toward the next cluster). */
const GW_GAP = 64
/** Tangential spacing between fanned gateways of the same cluster. */
const GW_SPREAD = 70
/** Clear radial gap left between one cluster's outer edge and the next cluster's inner edge. */
const CLUSTER_GAP = 80
/** Minimum radius of the innermost cluster band (raised by the wedge-fit step if needed). */
const BASE_R0 = 280
/** A cluster may use at most this fraction of its arm's angular half-share (overlap guard). */
const WEDGE_SAFETY = 0.42
/** Fallback extent (≈ a node radius) for a lone-node cluster with no ring/gateway. */
const SOLO_EXTENT = 28

/** Round to 2dp so coordinates are tidy and cross-engine stable. */
function r2(n: number): number {
  return Math.round(n * 100) / 100
}

/** Cluster id for a node (falls back to the node's own id for a clusterless node). */
function clusterOf(node: LayoutNode, id: string): string {
  return node.cluster && node.cluster.length > 0 ? node.cluster : id
}

/** Ring radius for `n` minors: large enough that adjacent ones stay ≥ MIN_SEP apart. */
function ringRadius(n: number): number {
  if (n <= 1) return BASE_RING
  // adjacent chord on a circle of radius R = 2·R·sin(π/n); solve for R ≥ MIN_SEP.
  const need = MIN_SEP / (2 * Math.sin(Math.PI / n))
  return Math.max(BASE_RING, need)
}

interface ClusterInfo {
  id: string
  category: string
  /** All member node ids, in stable TECH_NODE_IDS order. */
  nodes: string[]
  /** Shallowest member depth (for radial ordering within the arm). */
  minDepth: number
  /** Index of the earliest member in TECH_NODE_IDS (stable tiebreak). */
  firstIdx: number
  centreNode: string
  ringNodes: string[]
  gatewayNodes: string[]
  /** Gateways that unlock a member of THIS cluster — placed inward (hub-side junction). */
  inwardGatewayNodes: string[]
  /** Gateways whose dependents live in a deeper cluster — placed outward past the ring. */
  outwardGatewayNodes: string[]
  ringR: number
  /** Inward reach from the cluster centre (towards the hub). */
  innerExtent: number
  /** Outward reach from the cluster centre (towards the next cluster). */
  outerExtent: number
  /** Maximum tangential reach (for the wedge-fit / arm-separation guard). */
  tangentialExtent: number
}

interface Computed {
  pos: Record<string, NodePos>
  edges: TechEdge[]
  bounds: LayoutBounds
}

/** Per-node-set memo (the topology is static), keyed by the data object's identity. */
const layoutCache = new WeakMap<object, Computed>()

/** Shortest prerequisite-distance from a root, memoised. Unknown prereqs are ignored. */
function computeDepths(
  nodes: Record<string, LayoutNode>,
  nodeIds: readonly string[],
): Record<string, number> {
  const memo: Record<string, number> = {}
  const visiting = new Set<string>()

  const depthOf = (id: string): number => {
    const cached = memo[id]
    if (cached !== undefined) return cached
    const node = nodes[id]
    if (!node || node.prerequisites.length === 0) {
      memo[id] = 0
      return 0
    }
    if (visiting.has(id)) return 0 // defensive: data is a DAG, but never loop forever
    visiting.add(id)
    let best = Infinity
    for (const pre of node.prerequisites) {
      if (!(pre in nodes)) continue
      best = Math.min(best, depthOf(pre) + 1)
    }
    visiting.delete(id)
    const d = Number.isFinite(best) ? best : 0
    memo[id] = d
    return d
  }

  for (const id of nodeIds) depthOf(id)
  return memo
}

/** Build the per-cluster bag (membership, centre/ring/gateway split, extents). */
function buildClusters(
  nodes: Record<string, LayoutNode>,
  nodeIds: readonly string[],
  depths: Record<string, number>,
): {
  categories: string[]
  byCategory: Map<string, ClusterInfo[]>
} {
  // Categories in first-appearance order (stable arm assignment).
  const categories: string[] = []
  const clusterMap = new Map<string, ClusterInfo>()

  for (let i = 0; i < nodeIds.length; i++) {
    const id = nodeIds[i]
    const node = nodes[id]
    if (!categories.includes(node.category)) categories.push(node.category)

    const cid = clusterOf(node, id)
    let info = clusterMap.get(cid)
    if (!info) {
      info = {
        id: cid,
        category: node.category,
        nodes: [],
        minDepth: Infinity,
        firstIdx: i,
        centreNode: id,
        ringNodes: [],
        gatewayNodes: [],
        inwardGatewayNodes: [],
        outwardGatewayNodes: [],
        ringR: BASE_RING,
        innerExtent: 0,
        outerExtent: 0,
        tangentialExtent: 0,
      }
      clusterMap.set(cid, info)
    }
    info.nodes.push(id)
    info.minDepth = Math.min(info.minDepth, depths[id] ?? 0)
  }

  // Resolve each cluster's centre / ring / gateway split and its extents.
  for (const info of clusterMap.values()) {
    // Centre: the first notable; otherwise the shallowest node (cluster entry).
    let centre = ''
    for (const id of info.nodes) {
      if (nodes[id].archetype === 'notable') {
        centre = id
        break
      }
    }
    if (centre === '') {
      let bestDepth = Infinity
      for (const id of info.nodes) {
        const d = depths[id] ?? 0
        if (d < bestDepth) {
          bestDepth = d
          centre = id
        }
      }
    }
    info.centreNode = centre

    for (const id of info.nodes) {
      if (id === centre) continue
      if (nodes[id].archetype === 'gateway') info.gatewayNodes.push(id)
      else info.ringNodes.push(id)
    }

    // Classify each gateway by which side of the cluster it belongs on. A gateway that
    // is a prerequisite of one of THIS cluster's own members (centre / ring) gates INTO
    // the cluster, so it must sit at the hub-side junction BEFORE the centre (inward).
    // A gateway whose dependents live elsewhere (a deeper cluster) keeps leading OUTWARD.
    for (const gid of info.gatewayNodes) {
      let gatesInward = false
      for (const member of info.nodes) {
        if (member === gid) continue
        if (nodes[member].prerequisites.includes(gid)) {
          gatesInward = true
          break
        }
      }
      if (gatesInward) info.inwardGatewayNodes.push(gid)
      else info.outwardGatewayNodes.push(gid)
    }

    info.ringR = ringRadius(info.ringNodes.length)
    const hasRing = info.ringNodes.length > 0
    const hasInwardGw = info.inwardGatewayNodes.length > 0
    const hasOutwardGw = info.outwardGatewayNodes.length > 0
    const baseExtent = hasRing ? info.ringR : SOLO_EXTENT
    // Reserve a gateway band on whichever side(s) actually carry a gateway, so radial
    // spacing holds whether the gate sits before (inward) or beyond (outward) the centre.
    info.innerExtent = baseExtent + (hasInwardGw ? GW_GAP : 0)
    info.outerExtent = baseExtent + (hasOutwardGw ? GW_GAP : 0)
    const fanCount = Math.max(info.inwardGatewayNodes.length, info.outwardGatewayNodes.length)
    const gwFanHalf = fanCount > 0 ? ((fanCount - 1) / 2) * GW_SPREAD : 0
    info.tangentialExtent = Math.max(baseExtent, gwFanHalf)
  }

  // Group clusters per category, ordered (minDepth, firstIdx) — a total deterministic
  // order, so the result does not depend on Array.sort stability.
  const byCategory = new Map<string, ClusterInfo[]>()
  for (const cat of categories) byCategory.set(cat, [])
  for (const info of clusterMap.values()) {
    byCategory.get(info.category)?.push(info)
  }
  for (const list of byCategory.values()) {
    list.sort((a, b) => a.minDepth - b.minDepth || a.firstIdx - b.firstIdx)
  }

  return { categories, byCategory }
}

function computeLayout(
  nodes: Record<string, LayoutNode>,
  nodeIds: readonly string[],
): Computed {
  const pos: Record<string, NodePos> = {}

  const depths = computeDepths(nodes, nodeIds)
  const { categories, byCategory } = buildClusters(nodes, nodeIds, depths)
  const K = categories.length

  // Wedge-fit: enlarge R0 so even the widest cluster's angular half-width stays inside
  // a safe fraction of its arm's half-share (π/K), keeping arms from bleeding together.
  let maxTangential = SOLO_EXTENT
  for (const list of byCategory.values()) {
    for (const info of list) maxTangential = Math.max(maxTangential, info.tangentialExtent)
  }
  let r0 = BASE_R0
  if (K > 0) {
    const safeHalfAngle = WEDGE_SAFETY * (Math.PI / K)
    // tan is positive and finite for safeHalfAngle in (0, π/2]; guard tiny values anyway.
    const t = Math.tan(safeHalfAngle)
    if (t > 1e-6) r0 = Math.max(BASE_R0, maxTangential / t)
  }

  for (let k = 0; k < K; k++) {
    const cat = categories[k]
    const theta = ARM_ANGLE0 + k * (TAU / Math.max(1, K))
    const ux = Math.cos(theta)
    const uy = Math.sin(theta)
    // Tangent (90° CCW): used to fan gateways and to spread ring nodes.
    const tx = -Math.sin(theta)
    const ty = Math.cos(theta)
    const inwardAngle = theta + Math.PI // ring start: nearest the hub

    const clusters = byCategory.get(cat) ?? []
    let boundary = r0 // running outer radius consumed so far along this arm

    for (const info of clusters) {
      const centreRadius = boundary + info.innerExtent
      const cx = centreRadius * ux
      const cy = centreRadius * uy
      boundary = centreRadius + info.outerExtent + CLUSTER_GAP

      // Centre node.
      pos[info.centreNode] = { x: r2(cx), y: r2(cy) }

      // Ring (minors): full circle around the centre, starting on the hub side.
      const n = info.ringNodes.length
      for (let i = 0; i < n; i++) {
        const a = inwardAngle + (n > 1 ? (i * TAU) / n : 0)
        pos[info.ringNodes[i]] = {
          x: r2(cx + info.ringR * Math.cos(a)),
          y: r2(cy + info.ringR * Math.sin(a)),
        }
      }

      // Gateways: an inward gateway sits at the hub-side junction BEFORE the centre
      // (sign -1); an outward one is pushed past the ring toward the next cluster
      // (sign +1). Either group is fanned tangentially when it holds more than one.
      const gwRadius = info.ringR + GW_GAP
      const placeGateways = (ids: string[], sign: number): void => {
        const count = ids.length
        for (let i = 0; i < count; i++) {
          const off = (i - (count - 1) / 2) * GW_SPREAD
          const bx = cx + sign * gwRadius * ux
          const by = cy + sign * gwRadius * uy
          pos[ids[i]] = {
            x: r2(bx + off * tx),
            y: r2(by + off * ty),
          }
        }
      }
      placeGateways(info.outwardGatewayNodes, 1)
      placeGateways(info.inwardGatewayNodes, -1)
    }
  }

  // Safety net: any node that somehow missed a cluster pass (shouldn't happen) still
  // gets a deterministic, non-overlapping position on a fallback ring around the hub.
  for (let i = 0; i < nodeIds.length; i++) {
    const id = nodeIds[i]
    if (pos[id]) continue
    const a = ARM_ANGLE0 + (i * TAU) / Math.max(1, nodeIds.length)
    pos[id] = { x: r2(BASE_R0 * Math.cos(a)), y: r2(BASE_R0 * Math.sin(a)) }
  }

  // Edges: one per (prerequisite → node), stable order, skipping unknown prereq ids.
  const edges: TechEdge[] = []
  for (const id of nodeIds) {
    for (const pre of nodes[id].prerequisites) {
      if (pre in nodes) edges.push({ from: pre, to: id })
    }
  }

  // Bounds over all node centres (the view adds its own node-radius margin).
  let minX = 0
  let minY = 0
  let maxX = 0
  let maxY = 0
  let first = true
  for (const id of nodeIds) {
    const p = pos[id]
    if (!p) continue
    if (first) {
      minX = maxX = p.x
      minY = maxY = p.y
      first = false
    } else {
      if (p.x < minX) minX = p.x
      if (p.x > maxX) maxX = p.x
      if (p.y < minY) minY = p.y
      if (p.y > maxY) maxY = p.y
    }
  }
  // Always include the hub at (0,0) so the constellation centre is in frame.
  minX = Math.min(minX, 0)
  minY = Math.min(minY, 0)
  maxX = Math.max(maxX, 0)
  maxY = Math.max(maxY, 0)
  const bounds: LayoutBounds = {
    minX,
    minY,
    maxX,
    maxY,
    width: maxX - minX,
    height: maxY - minY,
  }

  return { pos, edges, bounds }
}

/**
 * Lazily compute (and memoise) the layout for a given node set — the data is static,
 * so the first call for each distinct `nodes` object is cached by its identity.
 */
function computedFor(
  nodes: Record<string, LayoutNode>,
  nodeIds: readonly string[],
): Computed {
  const hit = layoutCache.get(nodes)
  if (hit) return hit
  const result = computeLayout(nodes, nodeIds)
  layoutCache.set(nodes, result)
  return result
}

/** The tech tree's memoised layout (preserves the original single-tree behaviour). */
function computed(): Computed {
  return computedFor(TECH_NODES, TECH_NODE_IDS)
}

/** The central hub of the constellation (decorative anchor; not a real node). */
export const TECH_HUB: NodePos = { x: 0, y: 0 }

/**
 * GENERIC radial placement: a deterministic position for EVERY id in `nodeIds`,
 * derived from the topology of `nodes` alone (see the algorithm manifest at the top
 * of this file). Works for any tree shaped like {@link LayoutNode} — the tech tree,
 * the prestige tree, anything. Returns a fresh shallow copy each call so a caller can
 * never mutate the memoised layout.
 */
export function layoutNodes(
  nodes: Record<string, LayoutNode>,
  nodeIds: readonly string[],
): Record<string, NodePos> {
  const src = computedFor(nodes, nodeIds).pos
  const out: Record<string, NodePos> = {}
  for (const id of nodeIds) {
    const p = src[id]
    out[id] = { x: p.x, y: p.y }
  }
  return out
}

/**
 * GENERIC edges: every (prerequisite → dependent) pair of `nodes`, in stable `nodeIds`
 * order, skipping prereqs that point at an unknown id. Returns a fresh array of fresh
 * pairs each call.
 */
export function nodeEdges(
  nodes: Record<string, LayoutNode>,
  nodeIds: readonly string[],
): TechEdge[] {
  return computedFor(nodes, nodeIds).edges.map((e) => ({ from: e.from, to: e.to }))
}

/**
 * Deterministic radial position for EVERY node id in {@link TECH_NODES} — a thin
 * wrapper over {@link layoutNodes} bound to the tech data. Output is byte-for-byte
 * unchanged from the pre-generic implementation.
 */
export function layoutTree(): Record<string, NodePos> {
  return layoutNodes(TECH_NODES, TECH_NODE_IDS)
}

/**
 * Every tech-constellation edge as a (prerequisite → dependent) pair, in stable
 * {@link TECH_NODE_IDS} order — a thin wrapper over {@link nodeEdges} bound to the
 * tech data. Returns a fresh array of fresh pairs each call.
 */
export function techEdges(): TechEdge[] {
  return nodeEdges(TECH_NODES, TECH_NODE_IDS)
}

/**
 * Bounds of all node centres (plus the hub), so the view can size its pan/zoom
 * viewBox without re-scanning. The renderer is expected to add its own node-radius
 * margin. Returns a fresh object each call.
 */
export function layoutBounds(): LayoutBounds {
  return { ...computed().bounds }
}
