import { D } from '../engine/decimal'
import { RNG } from '../engine/rng'
import {
  createVillage,
  recomputeDerived,
  RESOURCE_IDS,
  HORDE_INTERVAL,
  EVENT_INTERVAL,
  type GameState,
  type TechModifiers,
} from '../engine/state'
import { generateWorld, WORLD_CENTER } from './world'
// VALUE import of prestigeScore (systems/prestige.ts) — used ONLY inside function bodies
// below (challengeGoalValue), never at module top level, so the prestige.ts <-> here cycle
// stays benign exactly like the era/dynasty edges: by the time any of these run, both
// modules are fully evaluated. prestige.ts value-imports `aggregateChallengeMods` from HERE
// (its `effectiveMods` folds the challenge bag), and this is the single edge back — a
// hoisted-function-only, body-use-only loop, so neither side reads an uninitialised binding.
import { prestigeScore } from './prestige'
import { CHALLENGES, CHALLENGE_IDS, type ChallengeDef, type ChallengeMods } from '../content/challenges'

/**
 * Challenge engine (M8 — WYZWANIA) — the run-modifier layer that plugs into the SAME
 * `combine` fold as the three meta-trees.
 *
 * Pure functions over a {@link GameState} + the {@link CHALLENGES} catalogue; Node-safe (no
 * DOM, no clock, no Math.random — the only RNG is the seeded {@link RNG}), so the sim and
 * tests can drive it headless and reproducibly. Adding or rebalancing a challenge is an
 * edit to src/content/challenges.ts — never to this file. Mirrors systems/era.ts.
 *
 * Three responsibilities:
 *  1. EFFECT roll-up. {@link aggregateChallengeMods} folds the ACTIVE challenge's
 *     constraint AND the permanent reward of every COMPLETED challenge into a
 *     {@link TechModifiers} bag (same shape as the tech / prestige / era / dynasty bags).
 *     systems/prestige.ts `effectiveMods` then COMBINEs that onto the tech × prestige × era
 *     × dynasty bag, so the challenge constraint/reward fold into every village's derived
 *     stats. Unlike the meta-trees (which SUM `perLevel * level` into a `1 + Σ` factor), a
 *     {@link ChallengeMods} field is a DIRECT multiplier and the contributing bags MULTIPLY
 *     together — a constraint factor is < 1, a reward factor > 1.
 *  2. GOAL tracking. {@link challengeGoalValue} reads the active challenge's current-run
 *     metric (prestige score, or total production/sec), {@link challengeGoalMet} compares it
 *     to the target, and {@link challengeGoalProgress} returns a 0..1 fraction for the UI.
 *  3. LIFECYCLE. {@link startChallenge} RESETS the run (mirroring ascend) and turns the
 *     constraint on; {@link checkChallengeCompletion} (called on the tick) records a met
 *     goal permanently and ends the active challenge with its reward; {@link abandonChallenge}
 *     ends it with no reward.
 *
 * IDENTITY: with no active challenge and none completed, {@link aggregateChallengeMods}
 * returns the IDENTITY bag, so `combine(x, aggregateChallengeMods(state)) === x`
 * byte-for-byte — a no-challenge save's derived stats are byte-identical to pre-M8.
 *
 * Determinism: every order-sensitive pass iterates {@link CHALLENGE_IDS} (stable source
 * order); {@link startChallenge} draws world + rngState from `seed + ':chal:' + id`, so a
 * challenge run is byte-identical across replays. No pass reads the clock or Math.random.
 *
 * Import discipline (cycle note, mirrors systems/era.ts): this module value-imports
 * `createVillage` / `recomputeDerived` / `RESOURCE_IDS` / `HORDE_INTERVAL` from state.ts,
 * `generateWorld` / `WORLD_CENTER` from systems/world, the seeded {@link RNG} from
 * engine/rng, and `prestigeScore` from systems/prestige — every one referenced ONLY inside
 * a function BODY, never at module top level. systems/prestige.ts value-imports
 * `aggregateChallengeMods` back from HERE (a benign cycle, body-use-only). All exports are
 * hoisted `function` declarations, so by the time any runs both modules are fully evaluated
 * regardless of load order. The pure-data challenge catalogue adds no edge back here.
 */

/** Lookup a challenge by id (undefined for an unknown id). */
export function challengeById(id: string): ChallengeDef | undefined {
  return CHALLENGES.find((c) => c.id === id)
}

/** The definition of the ACTIVE challenge, or undefined when none is running / the id is unknown. */
function activeChallengeDef(state: GameState): ChallengeDef | undefined {
  const ch = state && state.challenge ? state.challenge : null
  if (!ch || ch.activeId === null) return undefined
  return challengeById(ch.activeId)
}

/**
 * Multiply a {@link ChallengeMods} bag's present (finite) factors into the running
 * {@link TechModifiers} accumulator `acc`, in place. An absent / non-finite field is left
 * as "x1" (no change). `productionMult` scales all three resources at once. The reduction
 * fractions and automation flags are never touched (v1 challenges use only the six
 * multiplicative kinds).
 */
function applyChallengeMods(acc: TechModifiers, m: ChallengeMods): void {
  if (typeof m.productionMult === 'number' && Number.isFinite(m.productionMult)) {
    for (const r of RESOURCE_IDS) acc.productionMult[r] *= m.productionMult
  }
  if (typeof m.storageMult === 'number' && Number.isFinite(m.storageMult)) acc.storageMult *= m.storageMult
  if (typeof m.popMult === 'number' && Number.isFinite(m.popMult)) acc.popMult *= m.popMult
  if (typeof m.attackMult === 'number' && Number.isFinite(m.attackMult)) acc.attackMult *= m.attackMult
  if (typeof m.defenseMult === 'number' && Number.isFinite(m.defenseMult)) acc.defenseMult *= m.defenseMult
  if (typeof m.lootMult === 'number' && Number.isFinite(m.lootMult)) acc.lootMult *= m.lootMult
}

/**
 * Roll up the challenge constraint + completed rewards into a {@link TechModifiers} bag —
 * same shape as the tech / prestige / era / dynasty bags, so `combine` (systems/prestige.ts)
 * can fold it. Starts from the identity bag (all factors 1, fractions 0, automations false),
 * then MULTIPLIES in, in a FIXED order for determinism:
 *  (a) the ACTIVE challenge's constraint (if `state.challenge.activeId` is set + known), then
 *  (b) the permanent reward of every COMPLETED challenge (`completed[id] >= 1`), once each,
 *      iterated in {@link CHALLENGE_IDS} order.
 *
 * IDENTITY: with no active challenge and none completed this returns the identity bag, so
 * `combine(x, aggregateChallengeMods(state)) === x` byte-for-byte. Defensive: a partial /
 * hand-edited state with no `challenge` folds to identity rather than throwing.
 */
export function aggregateChallengeMods(state: GameState): TechModifiers {
  const acc: TechModifiers = {
    productionMult: { wood: 1, clay: 1, iron: 1 },
    storageMult: 1,
    popMult: 1,
    costReduction: 0,
    recruitSpeedFrac: 0,
    marchSpeedFrac: 0,
    attackMult: 1,
    defenseMult: 1,
    lootMult: 1,
    // Challenges never unlock idle automations — that gate lives only on the tech tree.
    automations: { build: false, recruit: false, attack: false },
  }

  const ch = state && state.challenge ? state.challenge : null
  if (!ch) return acc

  // (a) the active constraint (penalties), first.
  if (ch.activeId !== null) {
    const def = challengeById(ch.activeId)
    if (def) applyChallengeMods(acc, def.constraint)
  }

  // (b) the permanent reward of every completed challenge, once each, in stable order.
  const completed = ch.completed ?? {}
  for (const id of CHALLENGE_IDS) {
    const times = completed[id]
    if (!(typeof times === 'number') || !Number.isFinite(times) || times < 1) continue
    const def = challengeById(id)
    if (def) applyChallengeMods(acc, def.reward)
  }

  return acc
}

/**
 * The current value of the ACTIVE challenge's goal metric (0 when no challenge is active):
 * `prestige_score` reads {@link prestigeScore}; `production` sums the current production/sec
 * across every village and resource. On Decimal internally (the economy rule), returned as
 * a plain number for the threshold check / UI (a value past Number range collapses to
 * Infinity, which still correctly clears any finite target).
 */
export function challengeGoalValue(state: GameState): number {
  const def = activeChallengeDef(state)
  if (!def) return 0
  if (def.goal.kind === 'prestige_score') return prestigeScore(state)
  // 'production' — total production/sec across every village + resource.
  let sum = D(0)
  for (const vid of state.villageOrder) {
    const v = state.villages[vid]
    if (!v) continue
    for (const r of RESOURCE_IDS) sum = sum.add(v.production[r])
  }
  return sum.toNumber()
}

/** Alias of {@link challengeGoalValue} — the current value of the active challenge metric. */
export function challengeScore(state: GameState): number {
  return challengeGoalValue(state)
}

/** True when an active challenge's goal value has reached its target. */
export function challengeGoalMet(state: GameState): boolean {
  const def = activeChallengeDef(state)
  if (!def) return false
  return challengeGoalValue(state) >= def.goal.target
}

/** Goal progress of the active challenge as a 0..1 fraction (0 when none active / target <= 0). */
export function challengeGoalProgress(state: GameState): number {
  const def = activeChallengeDef(state)
  if (!def) return 0
  const target = def.goal.target
  if (!(target > 0)) return 0
  const p = challengeGoalValue(state) / target
  return p < 0 ? 0 : p > 1 ? 1 : p
}

/**
 * Whether challenge `id` can be STARTED right now, with a UI-facing `reason` when not: the
 * id must be known and no challenge may already be active (starting one resets the run).
 */
export function canStartChallenge(state: GameState, id: string): { ok: boolean; reason?: string } {
  if (!challengeById(id)) return { ok: false, reason: 'Nieznane wyzwanie' }
  const ch = state.challenge
  if (ch && ch.activeId !== null) return { ok: false, reason: 'Wyzwanie już trwa' }
  return { ok: true }
}

/**
 * START a challenge: RESET the run MIRRORING ascend — a single fresh capital at the world
 * centre, the barbarian world regenerated from a per-challenge seed `seed + ':chal:' + id`,
 * `rngState` reset to that seed, `tech = {}`, `battleLog = []` and the GLOBAL horde schedule
 * re-armed ({ timer: HORDE_INTERVAL, level: 0 }) — but BANK/WIPE NOTHING on the meta accounts
 * (prestige / era / dynasty) or the lifetime stats/achievements: they are PRESERVED. Then
 * flag the challenge active and reconcile derived stats (so the constraint penalty folds in).
 *
 * No-op (returns false, NO mutation) when {@link canStartChallenge} fails. `seed`,
 * `createdAt` and `lastSeen` are left untouched — `startChallenge` takes no clock, so it
 * stays fully deterministic (no Date). Returns true on a successful start.
 */
export function startChallenge(state: GameState, id: string): boolean {
  if (!canStartChallenge(state, id).ok) return false

  // Per-challenge seed: a distinct world + rng stream each challenge, fully reproducible.
  const chalSeed = state.seed + ':chal:' + id

  // Fresh single capital at the world centre (mirrors createInitialState's 'v0' / ascend).
  const capital = createVillage('v0', 'Stolica', WORLD_CENTER.x, WORLD_CENTER.y)

  state.villages = { v0: capital }
  state.villageOrder = ['v0']
  state.world = generateWorld(chalSeed)
  state.rngState = RNG.fromString(chalSeed).getState()
  state.tech = {}
  // M15: clear the Kuźnia upgrade map too (mirrors ascend — startChallenge resets the run). Unit
  // upgrades are a per-run sink gated by the per-run Kuźnia building, which the fresh level-0
  // capital resets; carrying state.forge into a challenge would grant free permanent ×mult upgrades
  // (combat applies them regardless of the rebuilt forgeLevel 0) and break the clean-slate contract.
  state.forge = {}
  state.battleLog = []
  // Re-arm the GLOBAL horde schedule, exactly as createInitialState / ascend seed it: a
  // fresh, defenceless capital must meet a fresh horde clock (timer re-armed, escalation 0).
  state.horde = { timer: HORDE_INTERVAL, level: 0 }
  // Re-seed the GLOBAL world-events schedule too (M13), mirroring the horde re-arm AND the
  // combat-stream re-seed above: a challenge run gets a fresh, idle event clock whose RNG stream
  // is reproducible from THIS challenge's own seed (`chalSeed + '::events'`, the same per-run seed
  // family as `rngState`). Without this a stale offer from the prior run would survive into a free
  // windfall once the player rebuilds the watchtower, and the events stream would be the lone
  // source of randomness not replayable from the per-run seed.
  state.events = {
    rngState: RNG.fromString(chalSeed + '::events').getState(),
    timer: EVENT_INTERVAL,
    active: null,
    // M14: a fresh challenge run starts with no timed buff in force.
    buff: null,
  }

  // Turn the challenge on (defensive: seed the record if a hand-edited save lacks it).
  if (!state.challenge) state.challenge = { activeId: null, completed: {} }
  state.challenge.activeId = id

  // Reconcile derived stats with the now-active constraint (and surviving meta multipliers).
  recomputeDerived(state)
  return true
}

/**
 * Check the ACTIVE challenge for completion (called once per sub-step from the tick). When a
 * challenge is active AND {@link challengeGoalMet}, record it permanently
 * (`completed[id] += 1`), END the active challenge (`activeId = null`, so its constraint
 * switches off and its reward switches on) and reconcile derived stats. Idempotent — once
 * `activeId` is cleared there is nothing to grant, so no double-grant is possible. Returns
 * true on a completion this call (so the tick can react), false otherwise.
 */
export function checkChallengeCompletion(state: GameState): boolean {
  const ch = state && state.challenge ? state.challenge : null
  if (!ch || ch.activeId === null) return false
  if (!challengeGoalMet(state)) return false

  const id = ch.activeId
  if (!ch.completed) ch.completed = {}
  ch.completed[id] = (ch.completed[id] || 0) + 1
  ch.activeId = null
  // The constraint is now off and the freshly earned reward is on — fold both in.
  recomputeDerived(state)
  return true
}

/**
 * ABANDON the active challenge: clear `activeId` (no reward) and reconcile derived stats, so
 * the constraint penalty switches off and the run simply continues unconstrained. No-op when
 * no challenge is active.
 */
export function abandonChallenge(state: GameState): void {
  const ch = state && state.challenge ? state.challenge : null
  if (!ch || ch.activeId === null) return
  ch.activeId = null
  recomputeDerived(state)
}
