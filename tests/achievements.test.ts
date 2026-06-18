import { describe, it, expect } from 'vitest'
import { D, Decimal } from '../src/engine/decimal'
import {
  createInitialState,
  createInitialStats,
  recomputeDerived,
  NO_TECH_MODS,
  type GameState,
  type BarbarianVillage,
  type Stats,
} from '../src/engine/state'
import { type UnitId } from '../src/content/units'
import { ACHIEVEMENTS, ACHIEVEMENT_IDS } from '../src/content/achievements'
import { checkAchievements, achievementUnlocked } from '../src/systems/achievements'
import { sendAttack, sendScout, advanceMarches } from '../src/systems/marches'
import { advanceRaids } from '../src/systems/raids'
import { applyConquest } from '../src/systems/conquest'
import { foundVillage, findFoundingSpot } from '../src/systems/villages'
import { barbarianById } from '../src/systems/world'
import { WORLD_CENTER } from '../src/systems/world'
import { simulate } from '../src/engine/tick'
import { applyOffline } from '../src/engine/offline'
import {
  SAVE_VERSION,
  migrate,
  validateState,
  serialize,
  deserialize,
  exportSave,
  importSave,
} from '../src/engine/save'

/**
 * M5.4 — lifetime Stats counters + data-driven Achievements.
 *
 * Three pillars are pinned here:
 *  - the catalogue is well-formed (ids match keys, every condition is pure/total),
 *  - checkAchievements unlocks on threshold, is monotonic (never cleared / re-marked)
 *    and deterministic (stable ACHIEVEMENT_IDS order, deterministic ordinal markers),
 *  - the Stats counters grow on the DETERMINISTIC tick/systems path (attacks won/lost,
 *    loot hauled, camps razed, scouts returned, raids repelled/lost, villages
 *    founded/conquered) — never from the UI — so they are identical online/offline/sim,
 *  - the v13 save round-trips the Decimal lootHauled + the achievements map, the
 *    v12->v13 migration backfills both, and validateState rejects a corrupt one.
 *
 * Helpers mirror marches.test.ts / conquest.test.ts so combat/march timing reproduces
 * exactly: a controlled single-camp world placed a known distance from the capital.
 */

/** A full (all UnitId present) roster snapshot — siege pair last, matching UNIT_IDS. */
function army(
  spearman = 0,
  swordsman = 0,
  axeman = 0,
  noble = 0,
  scout = 0,
  ram = 0,
  catapult = 0,
  light_cavalry = 0,
  heavy_cavalry = 0,
): Record<UnitId, number> {
  return { spearman, swordsman, axeman, noble, scout, ram, catapult, light_cavalry, heavy_cavalry }
}

/** A barbarian village descriptor at a chosen tier and map position (full loyalty, unscouted). */
function barb(id: string, level: number, x: number, y: number): BarbarianVillage {
  return {
    id,
    x,
    y,
    level,
    name: `Wioska barbarzyńska (poz. ${level})`,
    loyalty: 100,
    scouted: false,
  }
}

/**
 * A state whose capital ('v0') has the barracks unlocked and a controlled world holding
 * a single camp `level` exactly 3 fields east of the capital (distance 3, the legacy
 * timing). Mirrors marches.test.ts `armed`, so loot/casualty/timing numbers reproduce.
 */
function armed(level = 1, seed = 'ach'): GameState {
  const s = createInitialState(seed, 0)
  const v = s.villages.v0
  v.resources = { wood: D(50), clay: D(50), iron: D(50) }
  v.buildings.barracks = 1
  s.world = { fortresses: [], barbarians:[barb('b0', level, v.x + 3, v.y)] }
  recomputeDerived(s)
  return s
}

// =====================================================================
// CONTENT — the catalogue is well-formed and every condition is pure/total.
// =====================================================================
describe('content/achievements catalogue', () => {
  it('ACHIEVEMENT_IDS exactly equals the keys of ACHIEVEMENTS (in order)', () => {
    expect(ACHIEVEMENT_IDS).toEqual(Object.keys(ACHIEVEMENTS))
    // The contract asks for ~24-30; assert a healthy lower bound so a regression that
    // drops the catalogue is caught.
    expect(ACHIEVEMENT_IDS.length).toBeGreaterThanOrEqual(24)
  })

  it('every entry is self-consistent (def.id === key, has name/desc/category/condition)', () => {
    for (const id of ACHIEVEMENT_IDS) {
      const def = ACHIEVEMENTS[id]
      expect(def).toBeDefined()
      expect(def.id).toBe(id)
      expect(typeof def.name).toBe('string')
      expect(def.name.length).toBeGreaterThan(0)
      expect(typeof def.desc).toBe('string')
      expect(def.desc.length).toBeGreaterThan(0)
      expect(typeof def.category).toBe('string')
      expect(def.category.length).toBeGreaterThan(0)
      expect(typeof def.condition).toBe('function')
    }
  })

  it('no condition throws on a brand-new state, and a fresh state unlocks nothing', () => {
    const s = createInitialState('fresh', 0)
    for (const id of ACHIEVEMENT_IDS) {
      expect(() => ACHIEVEMENTS[id].condition(s, s.stats)).not.toThrow()
      // A fresh capital meets no threshold (1 village, all counters 0, no tech/prestige).
      expect(ACHIEVEMENTS[id].condition(s, s.stats)).toBe(false)
    }
    expect(checkAchievements(s)).toEqual([])
  })

  it('no condition throws on a richly-populated state', () => {
    const s = createInitialState('rich', 0)
    s.stats.attacksWon = 1000
    s.stats.lootHauled = D('1e30')
    s.stats.raidsRepelled = 99
    s.stats.campsRazed = 99
    s.stats.scoutsReturned = 99
    s.stats.villagesFounded = 50
    s.stats.villagesConquered = 50
    s.prestige.ascensions = 12
    s.prestige.totalEarned = 9999
    s.tech = { eco_root: 2 }
    for (const id of ACHIEVEMENT_IDS) {
      expect(() => ACHIEVEMENTS[id].condition(s, s.stats)).not.toThrow()
    }
  })
})

// =====================================================================
// ENGINE — checkAchievements: thresholds, monotonicity, determinism, markers.
// =====================================================================
describe('checkAchievements', () => {
  it('unlocks every newly-satisfied achievement and stamps a 1-based ordinal marker', () => {
    const s = createInitialState('chk', 0)
    s.stats.attacksWon = 10 // satisfies first_blood (>=1) AND warband (>=10), not warlord (>=50)

    const unlocked = checkAchievements(s)
    // Returned in stable ACHIEVEMENT_IDS (insertion) order: first_blood precedes warband.
    expect(unlocked).toEqual(['first_blood', 'warband'])
    expect(s.achievements.first_blood).toBe(1)
    expect(s.achievements.warband).toBe(2)
    expect(s.achievements.warlord).toBeUndefined()
    expect(achievementUnlocked(s, 'first_blood')).toBe(true)
    expect(achievementUnlocked(s, 'warlord')).toBe(false)
  })

  it('is monotonic: a second pass with no new progress unlocks nothing and re-marks nothing', () => {
    const s = createInitialState('mono', 0)
    s.stats.attacksWon = 1
    expect(checkAchievements(s)).toEqual(['first_blood'])
    expect(s.achievements.first_blood).toBe(1)
    // Idempotent: nothing new, existing marker untouched.
    expect(checkAchievements(s)).toEqual([])
    expect(s.achievements.first_blood).toBe(1)
  })

  it('never clears an unlock even if the condition would no longer hold', () => {
    const s = createInitialState('keep', 0)
    s.stats.attacksWon = 1
    checkAchievements(s)
    expect(achievementUnlocked(s, 'first_blood')).toBe(true)
    // Counters only ever grow in real play, but the unlock must survive ANY later state.
    s.stats.attacksWon = 0
    expect(checkAchievements(s)).toEqual([])
    expect(achievementUnlocked(s, 'first_blood')).toBe(true)
    expect(s.achievements.first_blood).toBe(1)
  })

  it('respects rising thresholds (10 then 50)', () => {
    const at9 = createInitialState('t9', 0)
    at9.stats.attacksWon = 9
    expect(checkAchievements(at9)).toEqual(['first_blood']) // warband needs 10
    expect(achievementUnlocked(at9, 'warband')).toBe(false)

    const at50 = createInitialState('t50', 0)
    at50.stats.attacksWon = 50
    const got = checkAchievements(at50)
    expect(got).toContain('first_blood')
    expect(got).toContain('warband')
    expect(got).toContain('warlord')
    // war_machine needs 250 — still locked at 50.
    expect(achievementUnlocked(at50, 'war_machine')).toBe(false)
  })

  it('markers stay a contiguous 1..N ordinal across separate unlock passes', () => {
    const s = createInitialState('ord', 0)
    s.stats.attacksWon = 10
    checkAchievements(s) // first_blood=1, warband=2
    s.stats.attacksWon = 50
    expect(checkAchievements(s)).toEqual(['warlord'])
    expect(s.achievements.warlord).toBe(3) // seeded from the 2 already unlocked
  })

  it('compares the Decimal lootHauled with .gte, not a lossy number cast', () => {
    const s = createInitialState('loot', 0)
    s.stats.lootHauled = D(999)
    expect(checkAchievements(s)).toEqual([]) // first_loot needs 1000
    s.stats.lootHauled = D(1000)
    expect(checkAchievements(s)).toContain('first_loot')
    // A haul far beyond 2^53 still resolves correctly (the whole point of Decimal).
    const big = createInitialState('bigloot', 0)
    big.stats.lootHauled = new Decimal('1e40')
    expect(checkAchievements(big)).toContain('treasure_hauler')
  })

  it('is deterministic: identical states unlock the identical achievements map', () => {
    const a = createInitialState('det', 0)
    const b = createInitialState('det', 0)
    a.stats.attacksWon = 50
    b.stats.attacksWon = 50
    a.stats.lootHauled = D(200000)
    b.stats.lootHauled = D(200000)
    checkAchievements(a)
    checkAchievements(b)
    expect(a.achievements).toEqual(b.achievements)
  })

  it('unlocks on-the-fly state conditions too (village count, not just stats)', () => {
    const s = armed()
    // Mint a second village so villageOrder.length becomes 2.
    s.villages.v1 = { ...s.villages.v0, id: 'v1' }
    s.villageOrder.push('v1')
    expect(checkAchievements(s)).toContain('second_village')
  })
})

// =====================================================================
// STATS — counters bump on the deterministic systems path (never the UI).
// =====================================================================
describe('Stats counters bump on the right events', () => {
  it('attacksWon + lootHauled on a won attack; loot is credited only on RETURN', () => {
    const s = armed(1)
    const v = s.villages.v0
    v.units = army(0, 0, 10)
    expect(sendAttack(v, s.world, s.battleLog, 'b0', army(0, 0, 5))).toBe(true)
    const stats = createInitialStats()

    // Advance exactly the outbound leg (axeman speed 18 × distance 3 = 54s): the battle
    // resolves but the haul has not been delivered yet.
    advanceMarches(v, s.world, s.battleLog, 54, NO_TECH_MODS, stats)
    expect(stats.attacksWon).toBe(1)
    expect(stats.attacksLost).toBe(0)
    expect(stats.lootHauled.toString()).toBe('0') // still on the road home

    // Complete the return leg → loot lands and the lifetime haul grows.
    advanceMarches(v, s.world, s.battleLog, 54, NO_TECH_MODS, stats)
    expect(stats.lootHauled.gt(0)).toBe(true)
  })

  it('attacksLost on a lost attack (and no loot)', () => {
    const s = armed(1)
    const v = s.villages.v0
    v.units = army(1) // one spearman (atk 10) cannot beat a level-1 camp (def 30)
    expect(sendAttack(v, s.world, s.battleLog, 'b0', army(1))).toBe(true)
    const stats = createInitialStats()

    advanceMarches(v, s.world, s.battleLog, 200, NO_TECH_MODS, stats)
    expect(stats.attacksLost).toBe(1)
    expect(stats.attacksWon).toBe(0)
    expect(stats.lootHauled.toString()).toBe('0')
  })

  it('campsRazed when catapults knock a tier down (>= 1 level removed)', () => {
    const s = armed(2) // a level-2 camp can actually drop a level
    const v = s.villages.v0
    v.units = army(0, 0, 10, 0, 0, 0, 5) // axemen for the win + 5 catapults (= 1 level)
    expect(sendAttack(v, s.world, s.battleLog, 'b0', army(0, 0, 5, 0, 0, 0, 5))).toBe(true)
    const stats = createInitialStats()

    advanceMarches(v, s.world, s.battleLog, 400, NO_TECH_MODS, stats)
    expect(stats.attacksWon).toBe(1)
    expect(stats.campsRazed).toBe(1)
    expect(barbarianById(s.world, 'b0')!.level).toBe(1) // razed 2 -> 1
  })

  it('campsRazed is NOT counted when a level-1 camp clamps (nothing removed)', () => {
    const s = armed(1)
    const v = s.villages.v0
    v.units = army(0, 0, 10, 0, 0, 0, 5)
    expect(sendAttack(v, s.world, s.battleLog, 'b0', army(0, 0, 5, 0, 0, 0, 5))).toBe(true)
    const stats = createInitialStats()

    advanceMarches(v, s.world, s.battleLog, 400, NO_TECH_MODS, stats)
    expect(stats.attacksWon).toBe(1)
    expect(stats.campsRazed).toBe(0) // max(1, 1-1) === 1, so the tier never dropped
    expect(barbarianById(s.world, 'b0')!.level).toBe(1)
  })

  it('scoutsReturned when a scout completes its round trip (and nothing else bumps)', () => {
    const s = armed(1)
    const v = s.villages.v0
    v.units = army(0, 0, 0, 0, 3) // 3 scouts
    expect(sendScout(v, s.world, s.battleLog, 'b0', 3)).toBe(true)
    const stats = createInitialStats()

    advanceMarches(v, s.world, s.battleLog, 400, NO_TECH_MODS, stats)
    expect(stats.scoutsReturned).toBe(1)
    expect(stats.attacksWon).toBe(0)
    expect(stats.attacksLost).toBe(0)
    expect(stats.lootHauled.toString()).toBe('0') // recon never loots
    expect(barbarianById(s.world, 'b0')!.scouted).toBe(true)
  })

  it('raidsRepelled when a strong garrison holds', () => {
    const s = createInitialState('rep', 0)
    const v = s.villages.v0
    v.units = army(2000) // overwhelming defence
    const stats = createInitialStats()

    advanceRaids(v, s.battleLog, 900, NO_TECH_MODS, stats)
    expect(stats.raidsRepelled).toBe(1)
    expect(stats.raidsLost).toBe(0)
    const last = s.battleLog[s.battleLog.length - 1]
    expect(last.kind).toBe('raid')
  })

  it('raidsLost when the garrison breaks', () => {
    const s = createInitialState('lost', 0)
    const v = s.villages.v0
    v.units = army(1) // a token garrison
    v.buildings.hq = 15 // a big building footprint inflates the incoming raid power
    const stats = createInitialStats()

    advanceRaids(v, s.battleLog, 900, NO_TECH_MODS, stats)
    expect(stats.raidsLost).toBe(1)
    expect(stats.raidsRepelled).toBe(0)
  })

  it('villagesFounded on a successful founding', () => {
    const s = createInitialState('found', 0)
    s.villages.v0.resources = { wood: D('1e9'), clay: D('1e9'), iron: D('1e9') }
    const spot = findFoundingSpot(s, 'v0')
    expect(spot).not.toBeNull()
    expect(s.stats.villagesFounded).toBe(0)

    const id = foundVillage(s, 'v0', spot!.x, spot!.y)
    expect(id).not.toBeNull()
    expect(s.stats.villagesFounded).toBe(1)

    // A REJECTED founding (broke geometry) does not bump the counter.
    expect(foundVillage(s, 'v0', s.villages.v0.x, s.villages.v0.y)).toBeNull()
    expect(s.stats.villagesFounded).toBe(1)
  })

  it('villagesConquered on applyConquest, and not again on the idempotent re-apply', () => {
    const s = createInitialState('conq', 0)
    const barbId = s.world.barbarians[0].id
    expect(s.stats.villagesConquered).toBe(0)

    const newId = applyConquest(s, barbId, 'v0')
    expect(newId).not.toBeNull()
    expect(s.stats.villagesConquered).toBe(1)

    // Second event for the same (now removed) camp is a no-op — the counter stays put.
    expect(applyConquest(s, barbId, 'v0')).toBeNull()
    expect(s.stats.villagesConquered).toBe(1)
  })
})

// =====================================================================
// TICK INTEGRATION — counters + unlocks are identical online vs chunked-offline.
// =====================================================================
describe('tick integration: stats + achievements are deterministic online vs offline', () => {
  /** A garrisoned capital with one attack already in flight at a controlled camp. */
  function scenario(seed: string): GameState {
    const s = armed(1, seed)
    const v = s.villages.v0
    v.units = army(20, 0, 20) // garrison + raider stock
    sendAttack(v, s.world, s.battleLog, 'b0', army(0, 0, 5))
    return s
  }

  it('one big simulate() equals the chunked offline path for stats AND achievements', () => {
    const seconds = 2000
    for (const seed of ['det-a', 'det-b', 'det-c']) {
      const big = scenario(seed)
      simulate(big, seconds)
      big.lastSeen = seconds * 1000 // mirror applyOffline's bookkeeping

      const chunked = scenario(seed)
      applyOffline(chunked, seconds * 1000) // lastSeen starts at 0 → drives the TICK_RATE grid

      // serialize() covers stats (incl. the {$d}-tagged Decimal lootHauled) AND the
      // achievements map, so byte-equality proves both replay identically.
      expect(serialize(big)).toBe(serialize(chunked))
      expect(big.achievements).toEqual(chunked.achievements)
    }
  })

  it('a real run accumulates stats and unlocks achievements via the tick path', () => {
    const s = scenario('accum')
    simulate(s, 2000)

    // The in-flight attack resolved as a win and hauled loot home, all on the tick path.
    expect(s.stats.attacksWon).toBeGreaterThanOrEqual(1)
    expect(s.stats.lootHauled.gt(0)).toBe(true)
    // first_blood (attacksWon >= 1) must have fired during the tick (never from the UI).
    expect(achievementUnlocked(s, 'first_blood')).toBe(true)
    expect(Object.keys(s.achievements).length).toBeGreaterThanOrEqual(1)
  })

  it('all counters remain finite, non-negative and integral (loot finite Decimal) after a run', () => {
    const s = scenario('inv')
    simulate(s, 3000)
    const intKeys: (keyof Stats)[] = [
      'attacksWon',
      'attacksLost',
      'raidsRepelled',
      'raidsLost',
      'campsRazed',
      'scoutsReturned',
      'villagesFounded',
      'villagesConquered',
    ]
    for (const k of intKeys) {
      const n = s.stats[k] as number
      expect(Number.isInteger(n)).toBe(true)
      expect(n).toBeGreaterThanOrEqual(0)
    }
    expect(s.stats.lootHauled.gte(0)).toBe(true)
    expect(Number.isNaN(Number(s.stats.lootHauled.toString()))).toBe(false)
    for (const id of Object.keys(s.achievements)) {
      const marker = s.achievements[id]
      expect(Number.isFinite(marker)).toBe(true)
      expect(marker).toBeGreaterThan(0)
      expect(ACHIEVEMENT_IDS).toContain(id)
    }
  })
})

// =====================================================================
// SAVE — round-trip of the Decimal stats + the achievements map.
// =====================================================================
describe('save round-trip: stats (Decimal) + achievements', () => {
  // A lifetime haul far beyond 2^53 — the reason lootHauled is a Decimal. break_infinity
  // is a magnitude type (it normalises to its stored representation), so a faithful
  // round-trip must reproduce THIS Decimal's own value, not an arbitrary literal.
  const HAUL = new Decimal('123456789012345678901234567890')

  /** A state carrying non-trivial lifetime stats and a couple of unlocked achievements. */
  function withProgress(): GameState {
    const s = createInitialState('rt', 0)
    s.stats.attacksWon = 42
    s.stats.attacksLost = 7
    s.stats.lootHauled = new Decimal(HAUL)
    s.stats.raidsRepelled = 5
    s.stats.raidsLost = 2
    s.stats.campsRazed = 3
    s.stats.scoutsReturned = 9
    s.stats.villagesFounded = 1
    s.stats.villagesConquered = 4
    s.achievements = { first_blood: 1, second_village: 2 }
    return s
  }

  it('serialize/deserialize is loss-free and idempotent for stats + achievements', () => {
    const s = withProgress()
    const once = serialize(s)
    const back = deserialize(once)

    expect(back.stats.lootHauled).toBeInstanceOf(Decimal)
    expect(back.stats.lootHauled.eq(HAUL)).toBe(true)
    expect(back.stats.lootHauled.toString()).toBe(HAUL.toString())
    expect(back.stats.attacksWon).toBe(42)
    expect(back.stats.villagesConquered).toBe(4)
    expect(back.achievements).toEqual({ first_blood: 1, second_village: 2 })
    // Idempotent: serialize(deserialize(x)) === x.
    expect(serialize(back)).toBe(once)
  })

  it('exportSave/importSave preserves the Decimal haul and the achievements map', () => {
    const s = withProgress()
    const restored = importSave(exportSave(s))

    expect(restored.version).toBe(SAVE_VERSION)
    expect(restored.stats.lootHauled).toBeInstanceOf(Decimal)
    expect(restored.stats.lootHauled.eq(HAUL)).toBe(true)
    expect(restored.stats.lootHauled.toString()).toBe(HAUL.toString())
    expect(restored.stats.attacksWon).toBe(42)
    expect(restored.stats.scoutsReturned).toBe(9)
    expect(restored.achievements).toEqual({ first_blood: 1, second_village: 2 })
  })
})

// =====================================================================
// MIGRATION v12 -> v13 — backfill stats + achievements without losing progress.
// =====================================================================

/**
 * A raw, fully-valid v12 save (multi-village + conquest + tech + prestige + automation +
 * wall + scout + siege) right before M5.4. It predates the two account-wide fields
 * `stats` and `achievements`, which the v12->v13 migration must backfill: `stats` to the
 * all-zero record (createInitialStats, lootHauled a Decimal 0) and `achievements` to {}.
 */
function rawV12() {
  return {
    version: 12,
    seed: 'v12',
    rngState: 7777,
    createdAt: 1000,
    lastSeen: 2000,
    villages: {
      v0: {
        id: 'v0',
        name: 'Stolica',
        x: WORLD_CENTER.x,
        y: WORLD_CENTER.y,
        resources: { wood: D(10), clay: D(20), iron: D(30) },
        production: { wood: D(2), clay: D(0.8), iron: D(0.5) },
        storageCap: D(4000),
        popCap: D(22),
        buildings: {
          hq: 3,
          sawmill: 2,
          clay_pit: 1,
          iron_mine: 1,
          warehouse: 1,
          farm: 1,
          barracks: 1,
          academy: 1,
          wall: 2,
        },
        units: { spearman: 5, swordsman: 0, axeman: 3, noble: 1, scout: 2, ram: 1, catapult: 1 },
        recruitQueue: [],
        marches: [
          {
            kind: 'attack',
            targetId: 'b0',
            targetLevel: 2,
            targetX: 210,
            targetY: 198,
            units: { spearman: 0, swordsman: 0, axeman: 2, noble: 0, scout: 0, ram: 0, catapult: 0 },
            phase: 'returning',
            remaining: 30,
            loot: { wood: D(50), clay: D(40), iron: D(10) },
          },
        ],
        raidTimer: 500,
      },
    },
    villageOrder: ['v0'],
    world: {
      barbarians: [
        { id: 'b0', x: 210, y: 198, level: 2, name: 'Obóz barbarzyńców (poz. 2)', loyalty: 100, scouted: true },
      ],
      fortresses: [],
    },
    battleLog: [],
    tech: {},
    prestige: { points: 3, totalEarned: 5, ascensions: 1, nodes: {} },
    automation: { build: false, recruit: false, attack: false, recruitUnit: null, recruitTarget: 0 },
  }
}

describe('migration v12 -> v13', () => {
  it('backfills an all-zero stats record + an empty achievements map, preserving everything else', () => {
    const m = migrate(rawV12())

    expect(m.version).toBe(26)
    expect(m.version).toBe(SAVE_VERSION)

    // stats: every counter zero, lootHauled a Decimal zero.
    expect(m.stats.attacksWon).toBe(0)
    expect(m.stats.attacksLost).toBe(0)
    expect(m.stats.raidsRepelled).toBe(0)
    expect(m.stats.raidsLost).toBe(0)
    expect(m.stats.campsRazed).toBe(0)
    expect(m.stats.scoutsReturned).toBe(0)
    expect(m.stats.villagesFounded).toBe(0)
    expect(m.stats.villagesConquered).toBe(0)
    expect(m.stats.lootHauled).toBeInstanceOf(Decimal)
    expect(m.stats.lootHauled.toString()).toBe('0')
    // achievements: empty.
    expect(m.achievements).toEqual({})

    // The carried-over progress is untouched by the migration.
    expect(m.seed).toBe('v12')
    expect(m.villages.v0.units.ram).toBe(1)
    expect(m.villages.v0.buildings.wall).toBe(2)
    expect(m.prestige.ascensions).toBe(1)
  })

  it('a migrated v12 save passes validateState', () => {
    const v = validateState(migrate(rawV12()))
    expect(v.version).toBe(SAVE_VERSION)
    expect(v.stats.lootHauled.toString()).toBe('0')
    expect(v.achievements).toEqual({})
  })

  it('preserves a stats/achievements object a forward-compat v12 save already carries', () => {
    const raw = rawV12() as Record<string, unknown>
    const carried = createInitialStats()
    carried.attacksWon = 7
    carried.lootHauled = D(500)
    raw.stats = carried
    raw.achievements = { first_blood: 1 }

    const m = migrate(raw)
    expect(m.version).toBe(SAVE_VERSION)
    expect(m.stats.attacksWon).toBe(7)
    expect(m.stats.lootHauled.toString()).toBe('500')
    expect(m.achievements).toEqual({ first_blood: 1 })
    expect(validateState(m).version).toBe(SAVE_VERSION)
  })

  it('importSave of a v12 export migrates to v13 with zeroed stats + empty achievements', () => {
    const restored = importSave(exportSave(rawV12() as never))
    expect(restored.version).toBe(SAVE_VERSION)
    expect(restored.stats.lootHauled).toBeInstanceOf(Decimal)
    expect(restored.stats.lootHauled.toString()).toBe('0')
    expect(restored.stats.attacksWon).toBe(0)
    expect(restored.achievements).toEqual({})
  })

  it('a fresh full save survives a migrate() no-op (already at SAVE_VERSION)', () => {
    const s = createInitialState('noop', 0)
    // Round-trip through the wire shape so migrate() sees a plain object, not live Decimals.
    const raw = deserialize(serialize(s)) as unknown
    const m = migrate(raw)
    expect(m.version).toBe(SAVE_VERSION)
    expect(validateState(m).version).toBe(SAVE_VERSION)
  })
})

// =====================================================================
// VALIDATION GUARDS — a corrupt stats/achievements payload is rejected loudly.
// =====================================================================
describe('validateState rejects a corrupt stats / achievements payload', () => {
  /** A fresh, fully-valid migrated v13 object to corrupt one field at a time. */
  function valid(): Record<string, any> {
    return migrate(rawV12()) as Record<string, any>
  }

  it('accepts the clean baseline', () => {
    expect(() => validateState(valid())).not.toThrow()
  })

  it('rejects a missing stats object', () => {
    const s = valid()
    delete s.stats
    expect(() => validateState(s)).toThrow(/stats/)
  })

  it('rejects a negative integer counter', () => {
    const s = valid()
    s.stats.attacksWon = -1
    expect(() => validateState(s)).toThrow(/stats attacksWon/)
  })

  it('rejects a non-integer counter', () => {
    const s = valid()
    s.stats.raidsRepelled = 1.5
    expect(() => validateState(s)).toThrow(/stats raidsRepelled/)
  })

  it('rejects a non-Decimal lootHauled', () => {
    const s = valid()
    s.stats.lootHauled = 1000 // plain number, must be a Decimal
    expect(() => validateState(s)).toThrow(/lootHauled/)
  })

  it('rejects a negative Decimal lootHauled', () => {
    const s = valid()
    s.stats.lootHauled = D(-5)
    expect(() => validateState(s)).toThrow(/lootHauled/)
  })

  it('rejects a non-object achievements map', () => {
    const s = valid()
    s.achievements = 5
    expect(() => validateState(s)).toThrow(/achievements/)
  })

  it('rejects an unknown achievement id', () => {
    const s = valid()
    s.achievements = { not_a_real_achievement: 1 }
    expect(() => validateState(s)).toThrow(/unknown achievement/)
  })

  it('rejects a non-numeric / negative unlock marker', () => {
    const bad1 = valid()
    bad1.achievements = { first_blood: 'x' }
    expect(() => validateState(bad1)).toThrow(/achievement marker/)

    const bad2 = valid()
    bad2.achievements = { first_blood: -1 }
    expect(() => validateState(bad2)).toThrow(/achievement marker/)
  })

  it('accepts a valid achievements map with a known id and a finite marker', () => {
    const s = valid()
    s.achievements = { first_blood: 1, second_village: 2 }
    expect(() => validateState(s)).not.toThrow()
  })
})
