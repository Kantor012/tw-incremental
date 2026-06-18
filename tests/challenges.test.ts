import { describe, it, expect } from 'vitest'
import { D } from '../src/engine/decimal'
import { RNG } from '../src/engine/rng'
import {
  createInitialState,
  createVillage,
  recomputeDerived,
  NO_TECH_MODS,
  HORDE_INTERVAL,
  EVENT_INTERVAL,
  type GameState,
  type TechModifiers,
} from '../src/engine/state'
import { generateWorld, WORLD_CENTER } from '../src/systems/world'
import { validateState } from '../src/engine/save'
import {
  aggregateChallengeMods,
  challengeById,
  challengeScore,
  challengeGoalValue,
  challengeGoalMet,
  challengeGoalProgress,
  canStartChallenge,
  startChallenge,
  checkChallengeCompletion,
  abandonChallenge,
} from '../src/systems/challenges'
import { effectiveMods, prestigeScore } from '../src/systems/prestige'
import { aggregateTechMods } from '../src/systems/tech'
import {
  CHALLENGES,
  CHALLENGE_IDS,
  type ChallengeDef,
  type ChallengeMods,
} from '../src/content/challenges'
import { TECH_NODE_IDS } from '../src/content/tech'

/**
 * M8 — WYZWANIA (challenge runs). These tests pin the contract of the data-driven
 * engine (systems/challenges.ts) and its interplay with the shared `combine` fold:
 *  - aggregateChallengeMods on a no-active-no-completed state IS the identity bag, so a
 *    no-challenge save's effectiveMods is byte-identical to the pre-M8 (tech × prestige ×
 *    era × dynasty) fold;
 *  - an ACTIVE challenge's CONSTRAINT folds into effectiveMods (it lowers the penalised
 *    multiplier), and a COMPLETED challenge's permanent REWARD raises it forever;
 *  - startChallenge RESETS the run mirroring ascend (fresh capital/world/tech/log, horde
 *    re-armed) deterministically (same seed+id → identical world + rngState) while the meta
 *    accounts (prestige/era/dynasty) and lifetime stats SURVIVE;
 *  - the goal metric (a CURRENT-RUN value) flips challengeGoalMet at the target;
 *    checkChallengeCompletion records completed[id] exactly once, clears activeId and grants
 *    the reward with no double-grant; abandonChallenge ends the run with no reward;
 *  - canStartChallenge rejects an unknown id and a second concurrent start.
 *
 * Challenges are referenced GENERICALLY (iterate CHALLENGES / CHALLENGE_IDS, branch on the
 * goal kind, walk the catalogue's own constraint/reward bags), so a content rename or a
 * rebalanced target cannot rot these tests.
 */

/** The six multiplicative axes a {@link ChallengeMods} bag can touch (= keyof ChallengeMods). */
const CHALLENGE_MOD_KEYS: (keyof ChallengeMods)[] = [
  'productionMult',
  'storageMult',
  'popMult',
  'attackMult',
  'defenseMult',
  'lootMult',
]

/** Read the effectiveMods axis a given {@link ChallengeMods} key maps onto (production via wood). */
function axisOf(mods: TechModifiers, key: keyof ChallengeMods): number {
  switch (key) {
    case 'productionMult':
      return mods.productionMult.wood
    case 'storageMult':
      return mods.storageMult
    case 'popMult':
      return mods.popMult
    case 'attackMult':
      return mods.attackMult
    case 'defenseMult':
      return mods.defenseMult
    case 'lootMult':
      return mods.lootMult
  }
}

describe('aggregateChallengeMods (identity when no active / none completed)', () => {
  it('returns the identity bag (equal to NO_TECH_MODS) for an empty state', () => {
    expect(aggregateChallengeMods({} as unknown as GameState)).toEqual(NO_TECH_MODS)
  })

  it('a fresh (no-challenge) state folds to the identity bag', () => {
    const s = createInitialState('chal-identity', 0)
    expect(aggregateChallengeMods(s)).toEqual(NO_TECH_MODS)
  })

  it('an empty challenge leaves effectiveMods byte-identical to the pre-M8 fold', () => {
    const s = createInitialState('chal-noop', 0)
    s.tech = { [TECH_NODE_IDS[0]]: 1 } // a non-trivial tech bag
    // prestige/era/dynasty are empty and the challenge is inactive/uncompleted, so
    // combine(x, identityBag) === x: effectiveMods is exactly the tech bag.
    expect(effectiveMods(s)).toEqual(aggregateTechMods(s.tech))
    // Dropping `challenge` entirely (defensive read → identity) yields the same result.
    const dropped = createInitialState('chal-noop', 0)
    dropped.tech = { [TECH_NODE_IDS[0]]: 1 }
    delete (dropped as { challenge?: unknown }).challenge
    expect(effectiveMods(dropped)).toEqual(effectiveMods(s))
  })
})

describe('an active challenge constraint folds into effectiveMods', () => {
  it('each penalty factor < 1 lowers exactly its axis; the rest stay at the baseline', () => {
    for (const def of CHALLENGES) {
      const s = createInitialState('chal-constraint:' + def.id, 0)
      const base = effectiveMods(s) // identity (no tech/prestige/era/dynasty/challenge)
      s.challenge.activeId = def.id
      const withC = effectiveMods(s)

      let penalised = 0
      for (const key of CHALLENGE_MOD_KEYS) {
        const factor = def.constraint[key]
        if (typeof factor === 'number') {
          expect(axisOf(withC, key)).toBeCloseTo(axisOf(base, key) * factor, 9)
          if (factor < 1) {
            expect(axisOf(withC, key)).toBeLessThan(axisOf(base, key))
            penalised++
          }
        } else {
          // An axis the constraint does not touch is unchanged (no completed rewards either).
          expect(axisOf(withC, key)).toBeCloseTo(axisOf(base, key), 9)
        }
      }
      // Every challenge is a real handicap: at least one axis is penalised below 1.
      expect(penalised).toBeGreaterThan(0)
    }
  })
})

/**
 * A fresh run with the meta accounts + lifetime stats deliberately dirtied (they must
 * SURVIVE a challenge start) and the run state dirtied too (tech/log/world/horde/extra
 * village — all WIPED/reset by startChallenge). Built fresh per call so mutations never
 * leak between cases.
 */
function dirtyState(seed: string): GameState {
  const s = createInitialState(seed, 12345)
  // Meta accounts that a challenge start must PRESERVE (a challenge banks/wipes nothing).
  s.prestige = { points: 5, totalEarned: 20, ascensions: 2, nodes: {} }
  s.era = { points: 3, totalEarned: 9, eras: 1, nodes: {} }
  s.dynasty = { points: 1, totalEarned: 4, dynasties: 1, nodes: {} }
  s.stats.attacksWon = 7
  // Run state that the start must RESET.
  s.tech = { [TECH_NODE_IDS[0]]: 1 }
  s.battleLog = [
    { kind: 'raid', villageId: 'v0', won: true, looted: '0', losses: 0 },
  ] as GameState['battleLog']
  s.horde = { timer: 5, level: 9 }
  // M15: a non-empty Kuźnia upgrade map that the reset must WIPE (a challenge is a clean-slate run).
  s.forge = { axeman: 2, spearman: 1 }
  s.villages.v1 = createVillage('v1', 'Wioska', WORLD_CENTER.x + 5, WORLD_CENTER.y + 5)
  s.villageOrder.push('v1')
  recomputeDerived(s)
  return s
}

describe('startChallenge (RESET mirroring ascend, meta preserved, deterministic)', () => {
  it('wipes the run to a single fresh capital, clears tech/log, re-arms the horde, flags active', () => {
    const id = CHALLENGE_IDS[0]
    const s = dirtyState('chal-start')
    expect(startChallenge(s, id)).toBe(true)

    // Single fresh capital at the world centre.
    expect(s.villageOrder).toEqual(['v0'])
    expect(Object.keys(s.villages)).toEqual(['v0'])
    expect(s.villages.v0.name).toBe('Stolica')
    expect(s.villages.v0.x).toBe(WORLD_CENTER.x)
    expect(s.villages.v0.y).toBe(WORLD_CENTER.y)

    // Transient run state cleared; horde clock re-armed exactly like a fresh state.
    expect(s.tech).toEqual({})
    expect(s.forge).toEqual({}) // M15: the per-run Kuźnia upgrade map is cleared like tech
    expect(s.battleLog).toEqual([])
    expect(s.horde).toEqual({ timer: HORDE_INTERVAL, level: 0 })

    // The challenge is now active, none completed.
    expect(s.challenge.activeId).toBe(id)
    expect(s.challenge.completed).toEqual({})

    // The reset state is fully valid and immediately playable (no softlock / corruption).
    expect(validateState(s)).toBe(s)
  })

  it('regenerates the world + rngState from the per-challenge seed (seed:chal:id)', () => {
    const id = CHALLENGE_IDS[0]
    const s = dirtyState('chal-seed')
    startChallenge(s, id)
    const chalSeed = 'chal-seed:chal:' + id
    expect(s.world).toEqual(generateWorld(chalSeed))
    expect(s.rngState).toBe(RNG.fromString(chalSeed).getState())
  })

  it('is deterministic: same base seed + id → byte-identical world + rng stream', () => {
    const id = CHALLENGE_IDS[1]
    const a = dirtyState('chal-det')
    const b = dirtyState('chal-det')
    startChallenge(a, id)
    startChallenge(b, id)
    expect(a.world).toEqual(b.world)
    expect(a.rngState).toBe(b.rngState)
  })

  it('PRESERVES the meta accounts (prestige/era/dynasty) and lifetime stats', () => {
    const s = dirtyState('chal-preserve')
    startChallenge(s, CHALLENGE_IDS[0])
    expect(s.prestige).toEqual({ points: 5, totalEarned: 20, ascensions: 2, nodes: {} })
    expect(s.era).toEqual({ points: 3, totalEarned: 9, eras: 1, nodes: {} })
    expect(s.dynasty).toEqual({ points: 1, totalEarned: 4, dynasties: 1, nodes: {} })
    expect(s.stats.attacksWon).toBe(7)
  })

  it('re-seeds the world-events schedule from the per-challenge seed (M13 — no stale offer survives)', () => {
    const id = CHALLENGE_IDS[0]
    const s = dirtyState('chal-events')
    // A stale ACTIVE offer + advanced events stream that MUST NOT leak into the challenge run.
    s.events = { rngState: 222333444, timer: 8, active: { defId: 'karawana', ttl: 30, roll: 0.9 }, buff: null }

    startChallenge(s, id)

    expect(s.events.active).toBeNull()
    expect(s.events.timer).toBe(EVENT_INTERVAL)
    // Reproducible from THIS challenge's own seed, mirroring the combat-stream re-seed.
    expect(s.events.rngState).toBe(RNG.fromString('chal-events:chal:' + id + '::events').getState())
  })
})

describe('challengeGoalValue / challengeGoalMet / challengeGoalProgress', () => {
  it('are inert (0 / false) with no active challenge', () => {
    const s = createInitialState('chal-goal-inert', 0)
    expect(challengeGoalValue(s)).toBe(0)
    expect(challengeScore(s)).toBe(0)
    expect(challengeGoalMet(s)).toBe(false)
    expect(challengeGoalProgress(s)).toBe(0)
  })

  it('challengeGoalMet flips when the current-run metric crosses the target', () => {
    for (const def of CHALLENGES) {
      const s = createInitialState('chal-goal:' + def.id, 0)
      s.challenge.activeId = def.id

      if (def.goal.kind === 'production') {
        // Below: no production at all → not met, progress 0.
        s.villages.v0.production = { wood: D(0), clay: D(0), iron: D(0) }
        expect(challengeGoalValue(s)).toBe(0)
        expect(challengeGoalMet(s)).toBe(false)
        expect(challengeGoalProgress(s)).toBe(0)
        // At target: total prod/sec == target → met (>=), progress clamps to 1.
        s.villages.v0.production = { wood: D(def.goal.target), clay: D(0), iron: D(0) }
        expect(challengeGoalValue(s)).toBe(def.goal.target)
        expect(challengeGoalMet(s)).toBe(true)
        expect(challengeGoalProgress(s)).toBe(1)
      } else {
        // prestige_score: a fresh single capital scores far below the (>=120) target.
        expect(challengeGoalValue(s)).toBe(prestigeScore(s))
        expect(challengeGoalValue(s)).toBeLessThan(def.goal.target)
        expect(challengeGoalMet(s)).toBe(false)
        expect(challengeGoalProgress(s)).toBeGreaterThanOrEqual(0)
        expect(challengeGoalProgress(s)).toBeLessThan(1)
        // prestigeScore sums every tech level (unconditionally), so a single synthetic
        // entry drives the run-metric across the target deterministically. effectiveMods
        // ignores the unknown key (aggregateTechMods iterates TECH_NODE_IDS), so nothing
        // else moves.
        s.tech = { ...s.tech, __test_score__: def.goal.target + 8 }
        expect(challengeGoalValue(s)).toBeGreaterThanOrEqual(def.goal.target)
        expect(challengeGoalMet(s)).toBe(true)
        expect(challengeGoalProgress(s)).toBe(1)
      }
    }
  })
})

/** Drive the active challenge's CURRENT-RUN goal metric across its target, in place. */
function driveGoalMet(s: GameState, def: ChallengeDef): void {
  if (def.goal.kind === 'production') {
    s.villages.v0.production = { wood: D(def.goal.target + 1), clay: D(0), iron: D(0) }
  } else {
    s.tech = { ...s.tech, __test_score__: def.goal.target + 8 }
  }
}

describe('checkChallengeCompletion (records once, grants the reward, no double-grant)', () => {
  it('records completed[id], clears activeId, and a fresh run then carries the permanent reward', () => {
    for (const def of CHALLENGES) {
      const s = createInitialState('chal-complete:' + def.id, 0)
      s.challenge.activeId = def.id
      driveGoalMet(s, def)

      // First check completes the challenge.
      expect(checkChallengeCompletion(s)).toBe(true)
      expect(s.challenge.completed[def.id]).toBe(1)
      expect(s.challenge.activeId).toBeNull()

      // A second tick must NOT double-grant (activeId already cleared).
      expect(checkChallengeCompletion(s)).toBe(false)
      expect(s.challenge.completed[def.id]).toBe(1)

      // The permanent reward folds into a FRESH run with no active challenge.
      const fresh = createInitialState('chal-reward:' + def.id, 0)
      const base = effectiveMods(fresh) // identity
      const rewarded = createInitialState('chal-reward:' + def.id, 0)
      rewarded.challenge = { activeId: null, completed: { [def.id]: 1 } }
      const mods = effectiveMods(rewarded)

      let raised = 0
      for (const key of CHALLENGE_MOD_KEYS) {
        const factor = def.reward[key]
        if (typeof factor === 'number') {
          expect(axisOf(mods, key)).toBeCloseTo(axisOf(base, key) * factor, 9)
          if (factor > 1) {
            expect(axisOf(mods, key)).toBeGreaterThan(axisOf(base, key))
            raised++
          }
        } else {
          expect(axisOf(mods, key)).toBeCloseTo(axisOf(base, key), 9)
        }
      }
      // Every reward is a real bonus: at least one axis is raised above 1.
      expect(raised).toBeGreaterThan(0)
    }
  })

  it('is a no-op when no challenge is active', () => {
    const s = createInitialState('chal-complete-inactive', 0)
    expect(checkChallengeCompletion(s)).toBe(false)
    expect(s.challenge.completed).toEqual({})
  })
})

describe('completed challenge rewards STACK (multiple distinct completions fold at once)', () => {
  it('folds TWO different completed rewards into effectiveMods simultaneously, multiplicatively', () => {
    // Two distinct challenges, each with a reward that raises at least one axis. The catalogue
    // assigns each reward its own axis today, so this also exercises two axes raised at once; the
    // per-axis product law asserted below would equally verify base*r1*r2 on a SHARED axis if a
    // future challenge ever reused one. Picked generically so a content rebalance can't rot it.
    const rewarding = CHALLENGES.filter((c) =>
      CHALLENGE_MOD_KEYS.some((k) => typeof c.reward[k] === 'number' && (c.reward[k] as number) > 1),
    )
    expect(rewarding.length).toBeGreaterThanOrEqual(2)
    const [a, b] = rewarding

    const base = effectiveMods(createInitialState('chal-stack-base', 0)) // identity (no completions)

    // Each reward folded ALONE (single completed id) — the single-completion bags for the product law.
    const onlyA = createInitialState('chal-stack', 0)
    onlyA.challenge = { activeId: null, completed: { [a.id]: 1 } }
    const modsA = effectiveMods(onlyA)

    const onlyB = createInitialState('chal-stack', 0)
    onlyB.challenge = { activeId: null, completed: { [b.id]: 1 } }
    const modsB = effectiveMods(onlyB)

    // BOTH rewards folded together (two distinct completed ids).
    const both = createInitialState('chal-stack', 0)
    both.challenge = { activeId: null, completed: { [a.id]: 1, [b.id]: 1 } }
    const modsBoth = effectiveMods(both)

    let raisedFromA = 0
    let raisedFromB = 0
    for (const key of CHALLENGE_MOD_KEYS) {
      const fa = a.reward[key]
      const fb = b.reward[key]
      const ra = typeof fa === 'number' ? fa : 1
      const rb = typeof fb === 'number' ? fb : 1
      // Multiplicative STACK: both rewards multiply onto the axis (base*ra*rb). On an axis only one
      // reward touches this is base*r; on a SHARED axis it is base*r1*r2 — the contract's stacking law.
      expect(axisOf(modsBoth, key)).toBeCloseTo(axisOf(base, key) * ra * rb, 9)
      // And the combined bag equals the PRODUCT of the two single-completion bags (over the identity
      // base) — the direct proof that stacking multiplies per axis rather than overwriting.
      expect(axisOf(modsBoth, key)).toBeCloseTo(
        (axisOf(modsA, key) * axisOf(modsB, key)) / axisOf(base, key),
        9,
      )
      // Each reward that raises an axis must raise it in the COMBINED bag too: a regression that
      // stopped folding after the first completed id would leave the other's axis at the baseline.
      if (typeof fa === 'number' && fa > 1) {
        expect(axisOf(modsBoth, key)).toBeGreaterThan(axisOf(base, key))
        raisedFromA++
      }
      if (typeof fb === 'number' && fb > 1) {
        expect(axisOf(modsBoth, key)).toBeGreaterThan(axisOf(base, key))
        raisedFromB++
      }
    }
    // BOTH rewards are real bonuses and BOTH folded in (not just the first completed id).
    expect(raisedFromA).toBeGreaterThan(0)
    expect(raisedFromB).toBeGreaterThan(0)
  })
})

describe('abandonChallenge (ends the run with no reward)', () => {
  it('clears activeId, banks nothing, and effectiveMods returns to identity', () => {
    const s = createInitialState('chal-abandon', 0)
    s.challenge.activeId = CHALLENGE_IDS[0]
    abandonChallenge(s)
    expect(s.challenge.activeId).toBeNull()
    expect(s.challenge.completed).toEqual({})
    // No constraint, no reward → the run continues unconstrained at the identity bag.
    expect(effectiveMods(s)).toEqual(NO_TECH_MODS)
  })
})

describe('canStartChallenge', () => {
  it('looks up a known challenge and rejects an unknown id', () => {
    expect(challengeById(CHALLENGE_IDS[0])).toBeDefined()
    expect(challengeById('not_a_real_challenge')).toBeUndefined()

    const s = createInitialState('chal-canstart', 0)
    expect(canStartChallenge(s, 'not_a_real_challenge')).toEqual({
      ok: false,
      reason: 'Nieznane wyzwanie',
    })
    expect(canStartChallenge(s, CHALLENGE_IDS[0])).toEqual({ ok: true })
  })

  it('rejects a second concurrent start while one challenge is already active', () => {
    const s = createInitialState('chal-concurrent', 0)
    expect(startChallenge(s, CHALLENGE_IDS[0])).toBe(true)
    expect(canStartChallenge(s, CHALLENGE_IDS[1])).toEqual({
      ok: false,
      reason: 'Wyzwanie już trwa',
    })
    // The start itself is a no-op (returns false) while a challenge runs.
    const activeBefore = s.challenge.activeId
    expect(startChallenge(s, CHALLENGE_IDS[1])).toBe(false)
    expect(s.challenge.activeId).toBe(activeBefore)
  })
})
