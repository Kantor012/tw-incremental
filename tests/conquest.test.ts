import { describe, it, expect } from 'vitest'
import {
  createInitialState,
  createVillage,
  recomputeDerived,
  type GameState,
  type BarbarianVillage,
  type World,
} from '../src/engine/state'
import { type UnitId } from '../src/content/units'
import {
  nobleCount,
  advanceWorldLoyalty,
  applyConquest,
  LOYALTY_MAX,
  LOYALTY_NOBLE_HIT,
  LOYALTY_REGEN_PER_SEC,
} from '../src/systems/conquest'
import { sendAttack, advanceMarches, marchTime } from '../src/systems/marches'
import { unitUnlocked } from '../src/systems/recruitment'
import { barbarianById } from '../src/systems/world'

/**
 * Conquest engine tests (M2.4 — the loyalty → capture pipeline).
 *
 * Covers the four pure pieces the contract pins:
 *  - {@link nobleCount}: count the noble in a roster, defensive ?? 0 for partial saves.
 *  - {@link advanceWorldLoyalty}: slow per-second regen, clamped up to {@link LOYALTY_MAX}.
 *  - {@link advanceMarches}: a WON attack carrying a surviving noble erodes the live
 *    target's loyalty by nobleCount(survivors)·{@link LOYALTY_NOBLE_HIT}, and queues a
 *    conquest event (returned for the tick to apply) once loyalty bottoms out at <= 0.
 *  - {@link applyConquest}: removes the camp, mints a player village in place, logs a
 *    `'conquer'` report, and is idempotent on a stale id (second call → null no-op).
 *  - {@link unitUnlocked}: the noble is gated by the academy (Pałac), the triad by the
 *    barracks.
 *
 * All states/worlds here are CONTROLLED (a single camp placed at a known offset from
 * the capital), so combat/march timing reproduce exactly and the assertions stay
 * deterministic. Survivor-dependent assertions read the actual surviving roster off the
 * resolved march rather than hard-coding the combat formula, so they hold under future
 * combat retuning while still proving the loyalty arithmetic.
 */

/** A full (all UnitId present) roster snapshot — `noble` last, matching UNIT_IDS. */
function army(spearman = 0, swordsman = 0, axeman = 0, noble = 0): Record<UnitId, number> {
  return { spearman, swordsman, axeman, noble }
}

/** A barbarian village descriptor at a chosen tier, position and loyalty. */
function barb(
  id: string,
  level: number,
  x: number,
  y: number,
  loyalty: number = LOYALTY_MAX,
): BarbarianVillage {
  return { id, x, y, level, name: `Wioska barbarzyńska (poz. ${level})`, loyalty }
}

/**
 * A state whose capital ('v0', "Stolica") has the barracks (attacks allowed) AND the
 * academy (nobles allowed) at level 1. We set the levels directly + recompute (what
 * `build` does minus the cost) so these tests stay decoupled from the building prices.
 * The seed-generated world is left in place; individual tests REPLACE `s.world` with a
 * single controlled camp at a known offset from the capital.
 */
function armed(seed = 'c'): GameState {
  const s = createInitialState(seed, 0)
  const v = s.villages.v0
  v.buildings.barracks = 1
  v.buildings.academy = 1
  recomputeDerived(s)
  return s
}

/**
 * Send `units` from v0 at the single controlled camp 'b0', advance EXACTLY the outbound
 * travel time so the battle resolves but the return leg does not start, and return the
 * conquest events the march produced. After a win the march is left in its `returning`
 * phase with `m.units` = the survivors.
 */
function attackOnce(
  s: GameState,
  units: Record<UnitId, number>,
): ReturnType<typeof advanceMarches> {
  const v = s.villages.v0
  v.units = units
  const target = barbarianById(s.world, 'b0')!
  const t = marchTime(v, { x: target.x, y: target.y }, units)
  expect(sendAttack(v, s.world, s.battleLog, 'b0', units)).toBe(true)
  return advanceMarches(v, s.world, s.battleLog, t)
}

describe('nobleCount', () => {
  it('reads the noble count from a complete roster', () => {
    expect(nobleCount(army(1, 2, 3, 4))).toBe(4)
    expect(nobleCount(army(5, 0, 9, 0))).toBe(0)
  })

  it('defaults to 0 when the noble key is absent (an old partial roster)', () => {
    const partial = { spearman: 1, swordsman: 0, axeman: 2 } as unknown as Record<UnitId, number>
    expect(nobleCount(partial)).toBe(0)
  })
})

describe('advanceWorldLoyalty', () => {
  it('regenerates every camp by REGEN·dt, clamped up to LOYALTY_MAX', () => {
    const world: World = {
      barbarians: [
        barb('b0', 1, 1, 1, 50),
        barb('b1', 2, 2, 2, 99.5),
        barb('b2', 3, 3, 3, LOYALTY_MAX),
      ],
    }
    advanceWorldLoyalty(world, 100) // + LOYALTY_REGEN_PER_SEC * 100

    expect(world.barbarians[0].loyalty).toBeCloseTo(50 + LOYALTY_REGEN_PER_SEC * 100, 9)
    // 99.5 + 2 = 101.5 → clamped down to the ceiling.
    expect(world.barbarians[1].loyalty).toBe(LOYALTY_MAX)
    // Already full stays full (clamp, never overshoot).
    expect(world.barbarians[2].loyalty).toBe(LOYALTY_MAX)
  })

  it('never exceeds LOYALTY_MAX even for a huge dt', () => {
    const world: World = { barbarians: [barb('b0', 1, 1, 1, 1)] }
    advanceWorldLoyalty(world, 1e9)
    expect(world.barbarians[0].loyalty).toBe(LOYALTY_MAX)
    expect(world.barbarians[0].loyalty).toBeLessThanOrEqual(LOYALTY_MAX)
  })

  it('is a no-op on an empty world (no captured camps to regenerate)', () => {
    const world: World = { barbarians: [] }
    expect(() => advanceWorldLoyalty(world, 100)).not.toThrow()
    expect(world.barbarians.length).toBe(0)
  })
})

describe('advanceMarches — noble erodes loyalty / queues a capture', () => {
  it('a won attack with a surviving noble erodes the live target loyalty', () => {
    const s = armed()
    s.world = { barbarians: [barb('b0', 1, 203, 200, LOYALTY_MAX)] }
    recomputeDerived(s)

    const events = attackOnce(s, army(0, 0, 30, 2)) // crushing win, a noble survives
    const v = s.villages.v0

    // Won → march now returning, its `units` are the survivors.
    const m = v.marches[0]
    expect(m.phase).toBe('returning')
    const nobles = nobleCount(m.units)
    expect(nobles).toBeGreaterThan(0)

    // Loyalty dropped by exactly nobleCount(survivors) · LOYALTY_NOBLE_HIT, no capture.
    const after = barbarianById(s.world, 'b0')!
    expect(after.loyalty).toBe(LOYALTY_MAX - nobles * LOYALTY_NOBLE_HIT)
    expect(after.loyalty).toBeGreaterThan(0)
    expect(events.length).toBe(0)
  })

  it('a won attack WITHOUT a noble leaves loyalty untouched', () => {
    const s = armed()
    s.world = { barbarians: [barb('b0', 1, 203, 200, LOYALTY_MAX)] }
    recomputeDerived(s)

    const events = attackOnce(s, army(0, 0, 10, 0)) // pure axeman win, no noble
    expect(events.length).toBe(0)
    expect(barbarianById(s.world, 'b0')!.loyalty).toBe(LOYALTY_MAX)
  })

  it('drives a low-loyalty camp to <= 0 and returns one conquest event (clamped to 0)', () => {
    const s = armed()
    // Loyalty below a single noble hit, so one surviving noble bottoms it out.
    s.world = { barbarians: [barb('b0', 1, 203, 200, LOYALTY_NOBLE_HIT - 5)] }
    recomputeDerived(s)

    const events = attackOnce(s, army(0, 0, 30, 2))

    expect(events.length).toBe(1)
    expect(events[0].barbId).toBe('b0')
    expect(events[0].attackerVillageId).toBe('v0')
    // Loyalty is clamped to 0 (never negative), and the camp still EXISTS — capture is
    // applied later by the tick via applyConquest, not by advanceMarches itself.
    const after = barbarianById(s.world, 'b0')!
    expect(after.loyalty).toBe(0)
  })

  it('a LOST attack with a noble does not erode loyalty (no win, no event)', () => {
    const s = armed()
    s.world = { barbarians: [barb('b0', 1, 203, 200, LOYALTY_MAX)] }
    recomputeDerived(s)

    // 1 noble alone (atk 30) cannot beat a level-1 wall (def 30 → tie loses).
    const events = attackOnce(s, army(0, 0, 0, 1))
    expect(events.length).toBe(0)
    expect(barbarianById(s.world, 'b0')!.loyalty).toBe(LOYALTY_MAX)
  })
})

describe('applyConquest', () => {
  it('captures the camp into a player village at its coordinates and logs a report', () => {
    const s = armed()
    s.world = { barbarians: [barb('b0', 2, 210, 195, 0)] }
    const villagesBefore = s.villageOrder.length

    const newId = applyConquest(s, 'b0', 'v0')

    expect(newId).not.toBeNull()
    expect(newId).toBe('v1') // first free id after the capital

    // The camp is removed from the world.
    expect(barbarianById(s.world, 'b0')).toBeUndefined()
    expect(s.world.barbarians.length).toBe(0)

    // A brand-new player village sits at the camp's exact map coordinates.
    const nv = s.villages[newId!]
    expect(nv).toBeDefined()
    expect(nv.id).toBe(newId)
    expect(nv.x).toBe(210)
    expect(nv.y).toBe(195)
    expect(typeof nv.name).toBe('string')
    expect(nv.name.length).toBeGreaterThan(0)

    // Registered in the stable iteration order exactly once.
    expect(s.villageOrder).toContain(newId)
    expect(s.villageOrder.length).toBe(villagesBefore + 1)

    // A 'conquer' report is appended, crediting the attacker and naming the target.
    const report = s.battleLog[s.battleLog.length - 1]
    expect(report.kind).toBe('conquer')
    if (report.kind === 'conquer') {
      expect(report.villageId).toBe('v0')
      expect(report.targetName).toBe('Wioska barbarzyńska (poz. 2)')
      expect(report.newVillageId).toBe(newId)
    }
  })

  it('is idempotent — a second capture of the same (now stale) id is a null no-op', () => {
    const s = armed()
    s.world = { barbarians: [barb('b0', 1, 205, 200, 0)] }

    const first = applyConquest(s, 'b0', 'v0')
    expect(first).toBe('v1')

    const villagesAfterFirst = s.villageOrder.length
    const logAfterFirst = s.battleLog.length

    const second = applyConquest(s, 'b0', 'v0')
    expect(second).toBeNull()
    // No second village minted, no extra report — the stale event is harmless.
    expect(s.villageOrder.length).toBe(villagesAfterFirst)
    expect(s.battleLog.length).toBe(logAfterFirst)
    expect(Object.keys(s.villages).length).toBe(villagesAfterFirst)
  })

  it('returns null for an unknown id without mutating state', () => {
    const s = armed()
    s.world = { barbarians: [barb('b0', 1, 205, 200, 100)] }
    const villagesBefore = s.villageOrder.length
    const logBefore = s.battleLog.length

    expect(applyConquest(s, 'does-not-exist', 'v0')).toBeNull()
    expect(s.world.barbarians.length).toBe(1) // untouched
    expect(s.villageOrder.length).toBe(villagesBefore)
    expect(s.battleLog.length).toBe(logBefore)
  })
})

describe('unitUnlocked — the noble is gated by the academy (Pałac)', () => {
  it('the noble unlocks only once the academy exists', () => {
    const v = createVillage('vt', 'Test', 0, 0)
    expect(v.buildings.academy).toBe(0)
    expect(unitUnlocked(v, 'noble')).toBe(false)

    v.buildings.academy = 1
    expect(unitUnlocked(v, 'noble')).toBe(true)
  })

  it('the infantry triad stays gated by the barracks, never the academy', () => {
    const v = createVillage('vt', 'Test', 0, 0)
    expect(unitUnlocked(v, 'spearman')).toBe(false)
    expect(unitUnlocked(v, 'swordsman')).toBe(false)
    expect(unitUnlocked(v, 'axeman')).toBe(false)

    v.buildings.barracks = 1
    expect(unitUnlocked(v, 'spearman')).toBe(true)
    expect(unitUnlocked(v, 'swordsman')).toBe(true)
    expect(unitUnlocked(v, 'axeman')).toBe(true)
    // The barracks alone does NOT unlock the noble (separate building).
    expect(unitUnlocked(v, 'noble')).toBe(false)

    v.buildings.academy = 1
    expect(unitUnlocked(v, 'noble')).toBe(true)
  })
})
