import { describe, it, expect } from 'vitest'
import { D } from '../src/engine/decimal'
import {
  createInitialState,
  RAID_BASE_INTERVAL,
  type BattleReport,
  type GameState,
} from '../src/engine/state'
import { type UnitId } from '../src/content/units'
import { simulate } from '../src/engine/tick'
import { applyOffline } from '../src/engine/offline'
import { serialize } from '../src/engine/save'

/**
 * M5.5 — combat LUCK is the FIRST consumer of the persisted `rngState` in the tick.
 * `subStep` seeds one RNG from `state.rngState`, threads it through every village's
 * marches+raids (in `villageOrder`), draws one luckFactor per RESOLVED engagement, and
 * writes the advanced state back to `state.rngState`. These tests pin the three
 * guarantees that rests on:
 *
 *  - rngState ADVANCES when (and only when) a battle resolves, and is otherwise left
 *    untouched (a pure-economy span draws nothing);
 *  - LUCK actually VARIES the run: two different `rngState`s roll different luck;
 *  - DETERMINISM: identical states replay byte-for-byte, and one big `simulate()` equals
 *    the chunked offline path (same grid) — including the evolved `rngState` — on 3 seeds.
 */

/** A full (all UnitId present) roster snapshot. */
function army(
  spearman = 0,
  swordsman = 0,
  axeman = 0,
  noble = 0,
  scout = 0,
  ram = 0,
  catapult = 0,
): Record<UnitId, number> {
  return { spearman, swordsman, axeman, noble, scout, ram, catapult }
}

/**
 * A capital that WILL be raided: a 3-spearman garrison (so the village is "worth
 * raiding" and a raid resolves inside RAID_BASE_INTERVAL) with a stocked treasury. The
 * raid is a knife-edge at this size, so its outcome genuinely turns on the luck roll.
 */
function raidingState(seed: string): GameState {
  const s = createInitialState(seed, 0)
  const v = s.villages.v0
  v.units = army(3)
  v.resources = { wood: D(100), clay: D(100), iron: D(100) }
  return s
}

/** The luck recorded on the most recent attack/raid report, or undefined if none/absent. */
function lastLuck(s: GameState): number | undefined {
  for (let i = s.battleLog.length - 1; i >= 0; i--) {
    const r: BattleReport = s.battleLog[i]
    if (r.kind === 'attack' || r.kind === 'raid') return r.luck
  }
  return undefined
}

describe('subStep — rngState evolves with combat luck (M5.5)', () => {
  it('advances state.rngState once a battle resolves (a luck draw was consumed)', () => {
    const s = raidingState('rng-evolve')
    const before = s.rngState
    simulate(s, RAID_BASE_INTERVAL + 50) // long enough for one raid to fire
    expect(s.battleLog.length).toBeGreaterThan(0) // a raid actually resolved…
    expect(s.rngState).not.toBe(before) // …so the luck stream advanced
    expect(lastLuck(s)).toBeTypeOf('number') // and the roll was recorded
  })

  it('leaves state.rngState untouched across a pure-economy span (no draws)', () => {
    // A bare hamlet (no units / starting footprint) is not yet worth raiding and has no
    // marches, so nothing resolves and no luck is drawn — rngState must read back identical.
    const s = createInitialState('rng-quiet', 0)
    const before = s.rngState
    simulate(s, 100) // well under the raid interval; production only
    expect(s.battleLog.length).toBe(0)
    expect(s.rngState).toBe(before)
  })
})

describe('combat luck genuinely varies the run (LUCK-VARIES, M5.5)', () => {
  it('two different rngState seeds roll different luck on the same battle', () => {
    // Same village, same fight — only the seeded luck stream differs. The recorded rolls
    // (and thus, on a knife-edge raid, potentially the verdict) must differ.
    const a = raidingState('vary')
    a.rngState = 7 // first luck draw ≈ 0.756 (pech)
    const b = raidingState('vary')
    b.rngState = 1 // first luck draw ≈ 1.064 (lucky)

    simulate(a, RAID_BASE_INTERVAL + 50)
    simulate(b, RAID_BASE_INTERVAL + 50)

    const la = lastLuck(a)
    const lb = lastLuck(b)
    expect(la).toBeTypeOf('number')
    expect(lb).toBeTypeOf('number')
    expect(la).not.toBe(lb) // luck depends on the rngState — it is not a constant
  })
})

describe('determinism with combat luck (M5.5)', () => {
  it('two identical states simulate byte-identically (rngState included)', () => {
    const a = raidingState('det')
    const b = raidingState('det')
    expect(serialize(a)).toBe(serialize(b)) // identical starting points
    simulate(a, RAID_BASE_INTERVAL + 50)
    simulate(b, RAID_BASE_INTERVAL + 50)
    expect(serialize(a)).toBe(serialize(b))
    expect(a.rngState).toBe(b.rngState)
  })

  it('one big simulate() equals the chunked offline path, rngState and all, on 3 seeds', () => {
    const seconds = 1300 // covers a raid at 900 (luck drawn) within the span
    for (const seed of ['seed-a', 'seed-b', 'seed-c']) {
      const big = raidingState(seed)
      const startRng = big.rngState
      simulate(big, seconds)
      big.lastSeen = seconds * 1000 // mirror applyOffline's bookkeeping

      const chunked = raidingState(seed)
      applyOffline(chunked, seconds * 1000) // drives simulate(TICK_RATE) repeatedly

      // Byte-identical serialized state proves the luck stream evolved in lockstep across
      // the two decompositions of the span (the dt-chunk-invariance guarantee).
      expect(serialize(big)).toBe(serialize(chunked))
      expect(big.rngState).toBe(chunked.rngState)
      // Sanity: a battle fired (so the equality is about luck, not a quiet economy) and the
      // luck stream actually advanced past its seed.
      expect(big.battleLog.length).toBeGreaterThan(0)
      expect(big.rngState).not.toBe(startRng)
    }
  })
})
