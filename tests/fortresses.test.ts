import { describe, it, expect } from 'vitest'
import { D } from '../src/engine/decimal'
import {
  createInitialState,
  recomputeDerived,
  NO_TECH_MODS,
  type GameState,
  type BarbarianVillage,
  type Fortress,
} from '../src/engine/state'
import { type UnitId } from '../src/content/units'
import { sendAttack, advanceMarches, canAttackFortress } from '../src/systems/marches'
import {
  generateWorld,
  fortressById,
  distance,
  WORLD_CENTER,
  WORLD_SIZE,
} from '../src/systems/world'
import {
  FORTRESS_COUNT,
  FORTRESS_LEVELS,
  fortressTarget,
  fortressName,
} from '../src/content/fortresses'
import { barbarianTarget } from '../src/content/barbarians'
import {
  armyAttackPower,
  ramDefenseFactor,
  battleOutcome,
  applyLosses,
  armyCarry,
} from '../src/systems/combat'
import { checkAchievements } from '../src/systems/achievements'
import { ACHIEVEMENTS } from '../src/content/achievements'

/**
 * M7 fortress tests — the FINITE, one-time boss targets. They pin the behaviour that
 * makes a fortress DISTINCT from a grindable barbarian camp: a fortress is generated
 * deterministically on a SEPARATE rng stream (so the barbarian world stays byte-
 * identical — additivity), needs a real siege army to crack, RAZES permanently on a
 * win (one-time, never re-attacked, never conquered), hauls a big carry-capped cache
 * and bumps the lifetime trophy stat. Fortresses are referenced GENERICALLY (iterate
 * world.fortresses / use fortressById / FORTRESS_COUNT / FORTRESS_LEVELS) so content
 * retuning of the per-index level scheme cannot rot these tests.
 */

/** A full (all UnitId present) roster snapshot, mirroring marches.test.ts `army`. */
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

/** A barbarian camp descriptor at a chosen tier and map position (full loyalty, unscouted). */
function barb(id: string, level: number, x: number, y: number): BarbarianVillage {
  return { id, x, y, level, name: `Wioska barbarzyńska (poz. ${level})`, loyalty: 100, scouted: false }
}

/** A fortress descriptor at a chosen tier and map position (fresh, unrazed). */
function fort(id: string, level: number, x: number, y: number): Fortress {
  return { id, x, y, level, name: fortressName(level), razed: false }
}

/**
 * A state whose capital ('v0') has the barracks unlocked, empty coffers and a CONTROLLED
 * world holding one camp ('b0') and one fortress ('f0'), each exactly 3 fields from the
 * capital (distinct cells). Mirrors marches.test.ts `armed` so timing/loot/casualty maths
 * reproduce, but lets us pick a SMALL fortress tier so the boss numbers stay testable (the
 * real ladder sits at FORTRESS_LEVELS, far out of band). Resources start at 0 so a haul is
 * read straight off the delivered loot.
 */
function armedFort(fortressLevel = 1, seed = 'fort'): GameState {
  const s = createInitialState(seed, 0)
  const v = s.villages.v0
  v.resources = { wood: D(0), clay: D(0), iron: D(0) }
  v.buildings.barracks = 1
  s.world = {
    barbarians: [barb('b0', 1, v.x, v.y + 3)],
    fortresses: [fort('f0', fortressLevel, v.x + 3, v.y)],
  }
  recomputeDerived(s)
  return s
}

/**
 * A small Decimal -> plain-number bridge for comparing modest, in-range haul figures.
 * break_infinity stores the mantissa in a float, so two values that both PRINT "990" can
 * carry tiny representational drift (one built via `.add`, the other via `.mul`) and
 * compare unequal with `.eq`. Going through the canonical decimal string sidesteps that
 * (the codebase idiom is to assert Decimals via `.toString()`); these haul totals are far
 * below 2^53, so the round-trip is exact.
 */
function num(d: ReturnType<typeof D>): number {
  return Number(d.toString())
}

// =====================================================================
// GENERATION — deterministic, well-shaped, additive (barbarians unchanged).
// =====================================================================
describe('generateWorld — fortresses (M7)', () => {
  it('produces exactly FORTRESS_COUNT well-shaped, unrazed fortresses', () => {
    const world = generateWorld('fort-gen')
    expect(world.fortresses.length).toBe(FORTRESS_COUNT)
    world.fortresses.forEach((f, i) => {
      // Stable sequential ids f0..f(n-1) in level-ascending order, matching FORTRESS_LEVELS.
      expect(f.id).toBe('f' + i)
      expect(f.level).toBe(FORTRESS_LEVELS[i])
      expect(Number.isInteger(f.level)).toBe(true)
      expect(f.level).toBeGreaterThanOrEqual(1)
      expect(typeof f.name).toBe('string')
      expect(f.name.length).toBeGreaterThan(0)
      // Fresh fortresses are never razed (mutable one-shot, unlike loyalty/scouted).
      expect(f.razed).toBe(false)
      // Coordinates are finite integers clamped to the map.
      expect(Number.isInteger(f.x)).toBe(true)
      expect(Number.isInteger(f.y)).toBe(true)
      expect(f.x).toBeGreaterThanOrEqual(0)
      expect(f.x).toBeLessThanOrEqual(WORLD_SIZE)
      expect(f.y).toBeGreaterThanOrEqual(0)
      expect(f.y).toBeLessThanOrEqual(WORLD_SIZE)
    })
  })

  it('is byte-for-byte deterministic for the same seed (fortresses AND barbarians)', () => {
    const a = generateWorld('determinism')
    const b = generateWorld('determinism')
    expect(a.fortresses).toEqual(b.fortresses)
    expect(a.barbarians).toEqual(b.barbarians)
    expect(a).toEqual(b) // the whole world round-trips identically
  })

  it('GOLDEN: pins the barbarian list for a fixed seed — a perturbed ":world" stream trips this', () => {
    // Frozen from the SHIPPING code for seed 'golden'. The M7 contract is that fortresses are
    // ADDITIVE: generated from a SEPARATE ':fortress' rng stream AFTER the barbarians, so the barbarian
    // list stays BYTE-IDENTICAL to a pre-M7 world. The a==b determinism checks (here and in
    // checkFortressDeterminism) cannot catch a perturbation that hits BOTH calls identically — only a
    // baseline snapshot like this can. If a refactor reorders/interleaves fortress draws into the
    // ':world' stream (or advances it), these coordinates shift and this test fails — exactly the
    // regression the additive contract forbids. Update ONLY with a deliberate, documented world-gen
    // change (and bump the save version / migration if the live world shape moves).
    const w = generateWorld('golden')
    expect(w.barbarians.length).toBe(125)
    const pick = (b: BarbarianVillage) => ({ id: b.id, x: b.x, y: b.y, level: b.level })
    expect(pick(w.barbarians[0])).toEqual({ id: 'b0', x: 201, y: 201, level: 1 })
    expect(pick(w.barbarians[62])).toEqual({ id: 'b62', x: 218, y: 176, level: 10 })
    expect(pick(w.barbarians[124])).toEqual({ id: 'b124', x: 230, y: 114, level: 30 })
    // Fortresses ARE generated for this seed — their existence must not have moved the camps above.
    expect(w.fortresses.map((f) => f.level)).toEqual([35, 40, 45, 50])
  })

  it('places fortresses far out, beyond the camp tiers', () => {
    const world = generateWorld('far-rings')
    const farthestCamp = Math.max(
      ...world.barbarians.map((b) => distance(WORLD_CENTER.x, WORLD_CENTER.y, b.x, b.y)),
    )
    for (const f of world.fortresses) {
      const d = distance(WORLD_CENTER.x, WORLD_CENTER.y, f.x, f.y)
      // Fortress tiers (FORTRESS_LEVELS) sit above MAX_TARGET_LEVEL, so even the nearest
      // fortress is farther than the farthest camp.
      expect(d).toBeGreaterThan(farthestCamp)
    }
  })

  it('is ADDITIVE: fortresses never collide with camps or each other, and ids are disjoint', () => {
    const world = generateWorld('additive')
    const cell = (x: number, y: number) => x + ',' + y
    const occupied = new Set<string>()
    for (const b of world.barbarians) occupied.add(cell(b.x, b.y))
    occupied.add(cell(WORLD_CENTER.x, WORLD_CENTER.y)) // the capital cell
    const fortressCells = new Set<string>()
    for (const f of world.fortresses) {
      // No fortress shares a field with a camp / the capital ...
      expect(occupied.has(cell(f.x, f.y))).toBe(false)
      // ... nor with another fortress.
      expect(fortressCells.has(cell(f.x, f.y))).toBe(false)
      fortressCells.add(cell(f.x, f.y))
      // Disjoint id namespace: fortress ids are 'f*', camp ids are 'b*'.
      expect(f.id.startsWith('f')).toBe(true)
      expect(world.barbarians.some((b) => b.id === f.id)).toBe(false)
    }
  })

  it("draws fortresses from a SEPARATE stream — a new seed reshuffles them but leaves the COUNT/levels fixed", () => {
    const a = generateWorld('seed-a')
    const b = generateWorld('seed-b')
    expect(a.fortresses.length).toBe(b.fortresses.length)
    expect(a.fortresses.map((f) => f.level)).toEqual(b.fortresses.map((f) => f.level))
    // Different seed -> different placement (random angle/radius on its own stream).
    expect(a.fortresses.map((f) => f.x + ',' + f.y)).not.toEqual(
      b.fortresses.map((f) => f.x + ',' + f.y),
    )
  })
})

// =====================================================================
// CONTENT — fortressTarget is a true boss: far higher wall, far bigger cache.
// =====================================================================
describe('content/fortresses — fortressTarget curves', () => {
  it('mirrors barbarianTarget shape but is a boss at the same tier (>> defence, >> loot)', () => {
    const level = 10
    const camp = barbarianTarget(level)
    const boss = fortressTarget(level)
    // Same { level, name, defensePower, loot, distance } shape; loot keyed over the resources.
    expect(typeof boss.defensePower).toBe('number')
    expect(boss.loot.wood).toBeDefined()
    expect(boss.loot.clay).toBeDefined()
    expect(boss.loot.iron).toBeDefined()
    // A fortress wall is much harder and its cache much richer than a same-tier camp.
    expect(boss.defensePower).toBeGreaterThan(camp.defensePower)
    expect(boss.loot.wood.gt(camp.loot.wood)).toBe(true)
  })
})

// =====================================================================
// COMBAT — siege wins raze (one-time, big cache), weak armies lose, camp path unchanged.
// =====================================================================
describe('fortress assault — a sufficient army+siege razes the fortress', () => {
  it('flips razed true, hauls a carry-capped cache home, bumps the trophy stat and logs the win', () => {
    const level = 1
    const s = armedFort(level)
    const v = s.villages.v0
    const fortress = fortressById(s.world, 'f0')!
    const sent = army(0, 0, 100, 0, 0, 2) // 100 axemen + 2 rams (siege)
    v.units = { ...sent }

    expect(sendAttack(v, s.world, s.battleLog, 'f0', sent, NO_TECH_MODS, 'fortress')).toBe(true)
    const m = v.marches[0]
    expect(m.targetType).toBe('fortress')
    expect(m.targetId).toBe('f0')
    expect(m.targetLevel).toBe(level)

    // Re-derive the EXPECTED resolution from the same exported helpers the engine uses
    // (no RNG threaded -> no luck), so the assertions are exact yet content-agnostic.
    const target = fortressTarget(level)
    const effDef = target.defensePower * ramDefenseFactor(sent)
    const effAtk = armyAttackPower(sent, NO_TECH_MODS)
    const outcome = battleOutcome(effAtk, effDef)
    expect(outcome.attackerWins).toBe(true)
    const survivors = applyLosses(sent, outcome.attackerLossFrac)
    const carry = D(armyCarry(survivors))
    const totalCache = target.loot.wood.add(target.loot.clay).add(target.loot.iron)
    const haul = carry.lt(totalCache) ? carry : totalCache
    const expectedEach = haul.mul(target.loot.wood).div(totalCache).floor()

    // One big dt completes BOTH the outbound (battle + raze) and the return (deliver) legs.
    const events = advanceMarches(v, s.world, s.battleLog, 100000, NO_TECH_MODS, s.stats)
    // Fortresses are never conquered: a win yields no ConquestEvent.
    expect(events).toEqual([])

    // Razed PERMANENTLY + the lifetime trophy counter ticked once.
    expect(fortress.razed).toBe(true)
    expect(s.stats.fortressesRazed).toBe(1)
    expect(s.stats.attacksWon).toBe(1)

    // The march is done (delivered + retired); survivors stayed owned (carry the cache).
    expect(v.marches.length).toBe(0)
    expect(v.units.axeman).toBe(survivors.axeman)
    expect(v.units.ram).toBe(survivors.ram)
    expect(survivors.axeman).toBeGreaterThan(0) // someone survived to haul it home

    // The carry-capped cache landed in the coffers (started empty), capped below the full cache.
    expect(v.resources.wood.toString()).toBe(expectedEach.toString())
    expect(v.resources.clay.toString()).toBe(expectedEach.toString())
    expect(v.resources.iron.toString()).toBe(expectedEach.toString())
    const deliveredTotal = num(v.resources.wood) + num(v.resources.clay) + num(v.resources.iron)
    expect(deliveredTotal).toBeLessThan(num(totalCache)) // carry was the binding cap
    expect(deliveredTotal).toBeLessThanOrEqual(num(carry))
    expect(deliveredTotal).toBeGreaterThan(0) // a real (big) cache landed
    expect(s.stats.lootHauled.toString()).toBe(expectedEach.mul(3).toString())

    // The win is logged as an attack from this village.
    expect(s.battleLog.length).toBe(1)
    const report = s.battleLog[0]
    expect(report.kind).toBe('attack')
    expect(report.villageId).toBe('v0')
    if (report.kind === 'attack') {
      expect(report.won).toBe(true)
      expect(report.lootSum).toBe(expectedEach.mul(3).toString())
    }
  })
})

describe('fortress assault — a razed fortress cannot be attacked again', () => {
  it('rejects a fresh assault once razed (sendAttack false, canAttackFortress false, no march)', () => {
    const s = armedFort(1)
    const v = s.villages.v0
    const sent = army(0, 0, 100, 0, 0, 2)
    v.units = { ...sent }
    sendAttack(v, s.world, s.battleLog, 'f0', sent, NO_TECH_MODS, 'fortress')
    advanceMarches(v, s.world, s.battleLog, 100000, NO_TECH_MODS, s.stats)
    const fortress = fortressById(s.world, 'f0')!
    expect(fortress.razed).toBe(true)

    // A second wave finds nothing to raze: the gate rejects, no march is created.
    v.units = { ...sent }
    expect(canAttackFortress(v, fortress, sent).ok).toBe(false)
    expect(sendAttack(v, s.world, s.battleLog, 'f0', sent, NO_TECH_MODS, 'fortress')).toBe(false)
    expect(v.marches.length).toBe(0)
  })

  it('rejects an assault on a missing fortress id', () => {
    const s = armedFort(1)
    const v = s.villages.v0
    v.units = army(0, 0, 100)
    expect(sendAttack(v, s.world, s.battleLog, 'f404', army(0, 0, 100), NO_TECH_MODS, 'fortress')).toBe(false)
    expect(v.marches.length).toBe(0)
  })
})

describe('fortress assault — the one-time cache cannot be double-collected', () => {
  it('two stacks sent before either resolves: only the raze-flipping stack hauls a cache, the other returns empty', () => {
    const s = armedFort(1)
    const v = s.villages.v0
    const one = army(0, 0, 100, 0, 0, 2) // a winning siege stack
    // Field TWO such stacks at home so both can be dispatched before either resolves.
    v.units = army(0, 0, 200, 0, 0, 4)
    const fortress = fortressById(s.world, 'f0')!

    // Re-derive the SINGLE-cache haul one stack carries (content-agnostic, no luck threaded).
    const target = fortressTarget(1)
    const outcome = battleOutcome(
      armyAttackPower(one, NO_TECH_MODS),
      target.defensePower * ramDefenseFactor(one),
    )
    expect(outcome.attackerWins).toBe(true)
    const survivors = applyLosses(one, outcome.attackerLossFrac)
    const carry = D(armyCarry(survivors))
    const totalCache = target.loot.wood.add(target.loot.clay).add(target.loot.iron)
    const haul = carry.lt(totalCache) ? carry : totalCache
    const expectedEach = haul.mul(target.loot.wood).div(totalCache).floor()

    // Dispatch BOTH at the same UN-razed fortress: the send-time gate only blocks re-attacking an
    // ALREADY-razed fortress, not two stacks dispatched before any of them resolves.
    expect(sendAttack(v, s.world, s.battleLog, 'f0', one, NO_TECH_MODS, 'fortress')).toBe(true)
    expect(sendAttack(v, s.world, s.battleLog, 'f0', one, NO_TECH_MODS, 'fortress')).toBe(true)
    expect(v.marches.length).toBe(2)

    // One big dt resolves BOTH (battle + raze + return) in the same pass.
    advanceMarches(v, s.world, s.battleLog, 100000, NO_TECH_MODS, s.stats)

    // One-time: razed once, trophy ticks exactly once — even though BOTH armies won the fight.
    expect(fortress.razed).toBe(true)
    expect(s.stats.fortressesRazed).toBe(1)
    expect(s.stats.attacksWon).toBe(2)

    // Exactly ONE cache landed (not two) — the second stack hauled nothing.
    expect(v.resources.wood.toString()).toBe(expectedEach.toString())
    expect(v.resources.clay.toString()).toBe(expectedEach.toString())
    expect(v.resources.iron.toString()).toBe(expectedEach.toString())
    expect(s.stats.lootHauled.toString()).toBe(expectedEach.mul(3).toString())

    // Both wins are logged, but only one carries a non-zero haul.
    const wins = s.battleLog.filter((r) => r.kind === 'attack' && r.won)
    expect(wins.length).toBe(2)
    const nonEmpty = wins.filter((r) => r.kind === 'attack' && r.lootSum !== '0')
    expect(nonEmpty.length).toBe(1)
  })
})

describe('fortress assault — a too-weak army loses', () => {
  it('takes casualties, does NOT raze, bumps attacksLost and logs the loss', () => {
    const s = armedFort(1)
    const v = s.villages.v0
    const sent = army(0, 0, 1) // a single axeman (atk 40) cannot beat a fortress wall
    v.units = { ...sent }
    const fortress = fortressById(s.world, 'f0')!

    // Sanity: the engagement is a genuine loss for this army.
    const target = fortressTarget(1)
    const effAtk = armyAttackPower(sent, NO_TECH_MODS)
    expect(battleOutcome(effAtk, target.defensePower * ramDefenseFactor(sent)).attackerWins).toBe(false)

    sendAttack(v, s.world, s.battleLog, 'f0', sent, NO_TECH_MODS, 'fortress')
    advanceMarches(v, s.world, s.battleLog, 100000, NO_TECH_MODS, s.stats)

    // The army is wiped, the fortress survives untouched, nothing is hauled or trophied.
    expect(v.units.axeman).toBe(0)
    expect(fortress.razed).toBe(false)
    expect(s.stats.fortressesRazed).toBe(0)
    expect(s.stats.attacksWon).toBe(0)
    expect(s.stats.attacksLost).toBe(1)
    expect(v.resources.wood.toString()).toBe('0')
    expect(v.marches.length).toBe(0) // a loss returns nothing
    expect(s.battleLog.length).toBe(1)
    const report = s.battleLog[0]
    if (report.kind === 'attack') {
      expect(report.won).toBe(false)
      expect(report.losses).toBeGreaterThan(0)
    }
  })
})

describe('fortress assault — never conquered (no loyalty)', () => {
  it('a winning army carrying a noble razes the fortress without conquering it', () => {
    const s = armedFort(1)
    const v = s.villages.v0
    const sent = army(0, 0, 100, 1, 0, 0) // axemen + a noble (which conquers CAMPS, never fortresses)
    v.units = { ...sent }
    const fortress = fortressById(s.world, 'f0')!

    sendAttack(v, s.world, s.battleLog, 'f0', sent, NO_TECH_MODS, 'fortress')
    const events = advanceMarches(v, s.world, s.battleLog, 100000, NO_TECH_MODS, s.stats)

    // Razed, not conquered: no ConquestEvent, no extra village, no 'conquer' report, no loyalty.
    expect(fortress.razed).toBe(true)
    expect(events).toEqual([])
    expect(s.villageOrder.length).toBe(1)
    expect(s.stats.villagesConquered).toBe(0)
    expect((fortress as { loyalty?: number }).loyalty).toBeUndefined()
    expect(s.battleLog.some((r) => r.kind === 'conquer')).toBe(false)
  })
})

describe('camp attack path stays byte-identical alongside fortresses', () => {
  it('a default sendAttack is a camp attack that uses barbarianTarget and never touches fortresses', () => {
    const s = armedFort(1)
    const v = s.villages.v0
    const sent = army(0, 0, 100) // same offensive army, but aimed at the camp
    v.units = { ...sent }
    const fortress = fortressById(s.world, 'f0')!

    // No trailing targetType -> a camp attack (the default), exactly as every pre-M7 caller.
    expect(sendAttack(v, s.world, s.battleLog, 'b0', sent)).toBe(true)
    expect(v.marches[0].targetType).toBe('camp')

    advanceMarches(v, s.world, s.battleLog, 100000, NO_TECH_MODS, s.stats)

    // The fortress is untouched and the trophy stat never moved — a camp win is camp-only.
    expect(fortress.razed).toBe(false)
    expect(s.stats.fortressesRazed).toBe(0)
    expect(s.stats.attacksWon).toBe(1)

    // Loot is the camp's (barbarianTarget) cache, not the fortress's — carry (990) exceeds the
    // small level-1 camp cache, so the FULL camp loot lands: floor(total * each / total) = each.
    const camp = barbarianTarget(1)
    expect(v.resources.wood.toString()).toBe(camp.loot.wood.toString())
  })
})

// =====================================================================
// ACHIEVEMENTS — fortress trophies unlock on their thresholds.
// =====================================================================
describe('fortress achievements', () => {
  it('a fresh state (4 unrazed fortresses, fortressesRazed 0) unlocks no fortress trophy', () => {
    const s = createInitialState('ach-fresh', 0)
    expect(ACHIEVEMENTS.first_fortress.condition(s, s.stats)).toBe(false)
    expect(ACHIEVEMENTS.fortress_breaker.condition(s, s.stats)).toBe(false)
    expect(ACHIEVEMENTS.fortress_purge.condition(s, s.stats)).toBe(false)
  })

  it('first_fortress unlocks at fortressesRazed >= 1, fortress_breaker at >= 3', () => {
    const s = createInitialState('ach-count', 0)
    s.stats.fortressesRazed = 1
    expect(checkAchievements(s)).toEqual(['first_fortress'])

    s.stats.fortressesRazed = 3
    expect(checkAchievements(s)).toEqual(['fortress_breaker'])
    // Monotonic: nothing new on a repeat pass.
    expect(checkAchievements(s)).toEqual([])
  })

  it('fortress_purge unlocks only when EVERY fortress in the world is razed', () => {
    const s = createInitialState('ach-purge', 0)
    expect(s.world.fortresses.length).toBe(FORTRESS_COUNT)

    // Raze all but one -> not yet a clean sweep.
    s.world.fortresses.forEach((f, i) => (f.razed = i > 0))
    expect(ACHIEVEMENTS.fortress_purge.condition(s, s.stats)).toBe(false)

    // Raze the last one -> the sweep is complete (reads the live world, not the stat).
    for (const f of s.world.fortresses) f.razed = true
    expect(checkAchievements(s)).toEqual(['fortress_purge'])
  })

  it('fortress_purge stays locked for a world that holds NO fortresses, even with the stat high', () => {
    const s = createInitialState('ach-empty', 0)
    s.world.fortresses = []
    s.stats.fortressesRazed = 10
    // An empty world is never a "cleared them all" sweep ...
    expect(ACHIEVEMENTS.fortress_purge.condition(s, s.stats)).toBe(false)
    // ... but the lifetime-count trophies still fire off the stat.
    expect(checkAchievements(s)).toEqual(['first_fortress', 'fortress_breaker'])
  })
})
