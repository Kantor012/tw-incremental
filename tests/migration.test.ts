import { describe, it, expect } from 'vitest'
import { D, Decimal } from '../src/engine/decimal'
import {
  createInitialState,
  createInitialStats,
  HORDE_INTERVAL,
  INITIAL_BUILDINGS,
  INITIAL_UNITS,
  recomputeDerived,
} from '../src/engine/state'
import {
  serialize,
  deserialize,
  exportSave,
  importSave,
  migrate,
  validateState,
  SAVE_VERSION,
} from '../src/engine/save'
import { BUILDING_IDS } from '../src/content/buildings'
import { UNIT_IDS } from '../src/content/units'
import { barbarianTarget } from '../src/content/barbarians'
import { TECH_NODE_IDS } from '../src/content/tech'
import { PRESTIGE_NODE_IDS } from '../src/content/prestige'
import { WORLD_CENTER } from '../src/systems/world'

/**
 * `migrate` always chains a raw save all the way up to {@link SAVE_VERSION} (now
 * v9, the prestige/ascension shape). So every legacy save — v1, v2, v3, v4, v5, v6,
 * v7, v8 — ends as a v9 GameState: the global header (version/seed/rng/timestamps) at
 * the top level, the per-village economy wrapped under `villages.v0` (the "Stolica"
 * capital, since old saves only ever had the one village) — now carrying integer
 * map coordinates (the capital pinned to WORLD_CENTER) — a bijective `villageOrder`
 * `['v0']`, a seed-generated barbarian `world`, a GLOBAL `battleLog` whose every
 * report is stamped `villageId 'v0'`, a GLOBAL `tech` map and a permanent `prestige`
 * record. These tests assert each migration backfills its own fields AND that the
 * v4->v5 wrap lands every per-village field under `villages.v0`, the v5->v6 step adds
 * coords + world and upgrades any carried march to the 'legacy' spatial shape, the
 * v6->v7 step backfills the academy building, the noble unit (in the roster AND in
 * every in-flight march) and full barbarian loyalty, the v7->v8 step backfills the
 * empty account-wide `tech` map, and the v8->v9 step backfills the zero permanent
 * `prestige` (ascension) record.
 */

/**
 * A raw v1 save: the pre-buildings shape. It has flat production / storageCap but
 * no `buildings` and no `popCap` — exactly the fields the v1->v2 migration adds.
 * Decimals are real Decimal instances, as they would be after `deserialize`.
 */
function rawV1() {
  return {
    version: 1,
    seed: 'legacy',
    rngState: 12345,
    createdAt: 1000,
    lastSeen: 2000,
    resources: { wood: D(100), clay: D(200), iron: D(300) },
    production: { wood: D(1), clay: D(0.8), iron: D(0.5) },
    storageCap: D(1000),
  }
}

describe('migration v1 -> current', () => {
  it('migrate() chains v1->...->v8: seeds buildings, popCap, units, queue, combat, coords + world, nobles + loyalty, the tech map and wraps into villages.v0', () => {
    const migrated = migrate(rawV1())

    expect(migrated.version).toBe(24)
    expect(migrated.version).toBe(SAVE_VERSION)
    // v4->v5: the lone economy is wrapped under villages.v0 with a bijective order.
    expect(migrated.villageOrder).toEqual(['v0'])
    expect(Object.keys(migrated.villages)).toEqual(['v0'])
    const v0 = migrated.villages.v0
    expect(v0.id).toBe('v0')
    expect(v0.name).toBe('Stolica')

    // v5->v6 spatial fields: the capital lands at the world centre and the barbarian
    // world is generated from the seed (non-empty). v1 had no marches to upgrade.
    expect(v0.x).toBe(WORLD_CENTER.x)
    expect(v0.y).toBe(WORLD_CENTER.y)
    expect(Array.isArray(migrated.world.barbarians)).toBe(true)
    expect(migrated.world.barbarians.length).toBeGreaterThan(0)

    // v1->v2 fields, now living on the village.
    expect(v0.buildings).toEqual(INITIAL_BUILDINGS)
    expect(v0.popCap instanceof Decimal).toBe(true)
    expect(v0.popCap.toString()).toBe('0')
    // v2->v3 fields added by the chained migration.
    expect(v0.units).toEqual(INITIAL_UNITS)
    expect(v0.recruitQueue).toEqual([])
    // v3->v4 combat fields: marches live on the village, the log is now GLOBAL.
    expect(v0.marches).toEqual([])
    expect(migrated.battleLog).toEqual([])
    expect(typeof v0.raidTimer).toBe('number')
    expect(v0.raidTimer).toBeGreaterThan(0)
    // v7->v8: the empty account-wide passive-tree map is backfilled at the top level.
    expect(migrated.tech).toEqual({})
    // v8->v9: the zero permanent prestige (ascension) record is backfilled too.
    expect(migrated.prestige).toEqual({ points: 0, totalEarned: 0, ascensions: 0, nodes: {} })
    // v14->v15: the zero permanent era (second meta-layer) record is backfilled too.
    expect(migrated.era).toEqual({ points: 0, totalEarned: 0, eras: 0, nodes: {} })
    // v15->v16: the zero permanent dynasty (third meta-layer) record is backfilled too.
    expect(migrated.dynasty).toEqual({ points: 0, totalEarned: 0, dynasties: 0, nodes: {} })
    // v17->v18: the horde schedule is backfilled (first horde a full interval out, level 0).
    expect(migrated.horde).toEqual({ timer: HORDE_INTERVAL, level: 0 })
    // Pre-existing fields are carried through untouched.
    expect(migrated.seed).toBe('legacy')
    expect(v0.resources.wood.toString()).toBe('100')
    // The economy no longer hangs off the top level after the v4->v5 wrap.
    expect(migrated.buildings).toBeUndefined()
    expect(migrated.resources).toBeUndefined()
  })

  it('a migrated v1 save passes validateState', () => {
    const validated = validateState(migrate(rawV1()))
    expect(validated.version).toBe(SAVE_VERSION)
    for (const id of BUILDING_IDS) {
      expect(validated.villages.v0.buildings[id]).toBe(INITIAL_BUILDINGS[id])
    }
  })

  it('importSave of a v1 export re-derives production/cap from buildings', () => {
    // Encode the raw v1 object exactly as exportSave would (tagged Decimals).
    const b64 = exportSave(rawV1() as never)
    const state = importSave(b64)

    expect(state.version).toBe(SAVE_VERSION)
    const v0 = state.villages.v0
    expect(v0.buildings).toEqual(INITIAL_BUILDINGS)

    // recomputeDerived ran on import: cached fields match the level-1 buildings,
    // NOT the stale flat values baked into the v1 save.
    expect(v0.production.wood.toString()).toBe('1')
    expect(v0.production.clay.toString()).toBe('0.8')
    expect(v0.production.iron.toString()).toBe('0.5')
    expect(v0.storageCap.toString()).toBe('4000') // 1000 + 3000 (warehouse lvl 1)
    expect(v0.popCap.toString()).toBe('22') // 10 + 12 (farm lvl 1)

    // Independently recomputing the imported state changes nothing — it was already
    // consistent — which is the invariant importSave guarantees.
    const cap = state.villages.v0.storageCap.toString()
    recomputeDerived(state)
    expect(state.villages.v0.storageCap.toString()).toBe(cap)
  })
})

/**
 * A raw v2 save: the pre-units shape. Full buildings economy and popCap, but no
 * `units`, no `recruitQueue`, and — being from before the barracks existed — no
 * `barracks` key in `buildings`. Exactly what the v2->v3 migration must backfill.
 */
function rawV2() {
  return {
    version: 2,
    seed: 'v2',
    rngState: 999,
    createdAt: 1000,
    lastSeen: 2000,
    resources: { wood: D(10), clay: D(20), iron: D(30) },
    production: { wood: D(1), clay: D(0.8), iron: D(0.5) },
    storageCap: D(26000),
    popCap: D(22),
    buildings: { hq: 1, sawmill: 1, clay_pit: 1, iron_mine: 1, warehouse: 1, farm: 1 },
  }
}

describe('migration v2 -> current', () => {
  it('seeds empty units, an empty queue, the new barracks building, and wraps into villages.v0', () => {
    const m = migrate(rawV2())

    expect(m.version).toBe(SAVE_VERSION)
    expect(m.villageOrder).toEqual(['v0'])
    const v0 = m.villages.v0
    expect(v0.name).toBe('Stolica')
    expect(v0.units).toEqual(INITIAL_UNITS)
    expect(v0.recruitQueue).toEqual([])
    // Pre-existing levels preserved; the new building seeded at its initial level.
    expect(v0.buildings.sawmill).toBe(1)
    expect(v0.buildings.barracks).toBe(0)
  })

  it('a migrated v2 save passes validateState', () => {
    const v = validateState(migrate(rawV2()))
    expect(v.version).toBe(SAVE_VERSION)
    for (const id of UNIT_IDS) expect(v.villages.v0.units[id]).toBe(0)
    expect(Array.isArray(v.villages.v0.recruitQueue)).toBe(true)
  })
})

/**
 * A raw v3 save: full economy + recruitment, but from before combat existed — no
 * `marches`, no `battleLog`, no `raidTimer`. Exactly the fields the v3->v4
 * migration must backfill (before the v4->v5 wrap relocates them under v0).
 */
function rawV3() {
  return {
    version: 3,
    seed: 'v3',
    rngState: 7,
    createdAt: 1000,
    lastSeen: 2000,
    resources: { wood: D(10), clay: D(20), iron: D(30) },
    production: { wood: D(1), clay: D(0.8), iron: D(0.5) },
    storageCap: D(4000),
    popCap: D(22),
    buildings: { hq: 1, sawmill: 1, clay_pit: 1, iron_mine: 1, warehouse: 1, farm: 1, barracks: 1 },
    units: { spearman: 2, swordsman: 0, axeman: 1 },
    recruitQueue: [],
  }
}

describe('migration v3 -> current', () => {
  it('seeds empty marches, a global battle log, an armed raid timer and wraps into villages.v0', () => {
    const m = migrate(rawV3())

    expect(m.version).toBe(SAVE_VERSION)
    expect(m.villageOrder).toEqual(['v0'])
    const v0 = m.villages.v0
    expect(v0.marches).toEqual([])
    // The battle log is GLOBAL (top level), not a per-village field.
    expect(m.battleLog).toEqual([])
    expect(typeof v0.raidTimer).toBe('number')
    expect(v0.raidTimer).toBeGreaterThan(0)
    // Pre-existing recruitment state is carried through into the village; the v6->v7
    // step appends the noble:0 slot to the roster without touching the old counts.
    expect(v0.units).toEqual({ spearman: 2, swordsman: 0, axeman: 1, noble: 0, scout: 0, ram: 0, catapult: 0, light_cavalry: 0, heavy_cavalry: 0 })
    expect(v0.buildings.barracks).toBe(1)
  })

  it('a migrated v3 save passes validateState', () => {
    const v = validateState(migrate(rawV3()))
    expect(v.version).toBe(SAVE_VERSION)
    expect(Array.isArray(v.villages.v0.marches)).toBe(true)
    expect(Array.isArray(v.battleLog)).toBe(true)
    expect(v.villages.v0.raidTimer).toBeGreaterThanOrEqual(0)
  })
})

/**
 * A raw v4 save: the single-village shape right before M2.1. The whole economy —
 * all nine per-village fields — lives at the TOP LEVEL, alongside a GLOBAL-but-
 * untagged battle log whose reports carry NO `villageId` yet. Exactly what the
 * v4->v5 migration must wrap under `villages.v0` (stamping each report `'v0'`).
 */
function rawV4() {
  return {
    version: 4,
    seed: 'v4',
    rngState: 42,
    createdAt: 1000,
    lastSeen: 2000,
    resources: { wood: D(10), clay: D(20), iron: D(30) },
    production: { wood: D(2), clay: D(0.8), iron: D(0.5) },
    storageCap: D(4000),
    popCap: D(22),
    buildings: { hq: 1, sawmill: 2, clay_pit: 1, iron_mine: 1, warehouse: 1, farm: 1, barracks: 1 },
    units: { spearman: 5, swordsman: 0, axeman: 3 },
    recruitQueue: [{ unitId: 'spearman', count: 1, remaining: 20, perUnitSeconds: 76 }],
    marches: [
      {
        targetLevel: 2,
        units: { spearman: 0, swordsman: 0, axeman: 2 },
        phase: 'returning',
        remaining: 30,
        loot: { wood: D(50), clay: D(40), iron: D(10) },
      },
    ],
    battleLog: [
      { kind: 'attack', targetLevel: 2, won: true, lootSum: '100', losses: 0 },
      { kind: 'raid', won: false, looted: '25', losses: 1 },
    ],
    raidTimer: 500,
  }
}

describe('migration v4 -> current', () => {
  it('wraps the lone village under villages.v0 (Stolica) and globalises the battle log', () => {
    const m = migrate(rawV4())

    expect(m.version).toBe(24)
    expect(m.version).toBe(SAVE_VERSION)
    // Bijective single-village order: exactly one ordered id, exactly one village.
    expect(m.villageOrder).toEqual(['v0'])
    expect(Object.keys(m.villages)).toEqual(['v0'])

    const v0 = m.villages.v0
    expect(v0.id).toBe('v0')
    expect(v0.name).toBe('Stolica')

    // The nine per-village fields moved from the v4 top level into v0; the v6->v7
    // step then appends the conquest keys (academy:0 / noble:0) without clobbering the
    // carried levels/counts.
    expect(v0.buildings).toEqual({ ...INITIAL_BUILDINGS, ...rawV4().buildings })
    expect(v0.units).toEqual({ spearman: 5, swordsman: 0, axeman: 3, noble: 0, scout: 0, ram: 0, catapult: 0, light_cavalry: 0, heavy_cavalry: 0 })
    expect(v0.resources.wood.toString()).toBe('10')
    expect(v0.resources.clay.toString()).toBe('20')
    expect(v0.resources.iron.toString()).toBe('30')
    expect(v0.production.wood.toString()).toBe('2')
    expect(v0.storageCap.toString()).toBe('4000')
    expect(v0.popCap.toString()).toBe('22')
    expect(v0.recruitQueue).toEqual([
      { unitId: 'spearman', count: 1, remaining: 20, perUnitSeconds: 76 },
    ])
    expect(v0.marches.length).toBe(1)
    expect(v0.marches[0].targetLevel).toBe(2)
    expect(v0.marches[0].phase).toBe('returning')
    expect(v0.marches[0].loot.wood.toString()).toBe('50')
    expect(v0.raidTimer).toBe(500)

    // The chain now runs through v5->v6: the capital gains coords + a generated
    // world, and the carried march — which had no real target id — is upgraded to
    // the 'legacy' spatial shape with geometry reconstructed from the old distance
    // (placed due-"east" of the capital, preserving the source->target distance).
    expect(v0.x).toBe(WORLD_CENTER.x)
    expect(v0.y).toBe(WORLD_CENTER.y)
    expect(m.world.barbarians.length).toBeGreaterThan(0)
    expect(v0.marches[0].targetId).toBe('legacy')
    expect(v0.marches[0].targetX).toBe(WORLD_CENTER.x + barbarianTarget(2).distance)
    expect(v0.marches[0].targetY).toBe(WORLD_CENTER.y)

    // The battle log is now GLOBAL (top level), pruned of nothing here, and every
    // legacy report is stamped with the only village it could have come from.
    expect(Array.isArray(m.battleLog)).toBe(true)
    expect(m.battleLog).toHaveLength(2)
    for (const r of m.battleLog) expect(r.villageId).toBe('v0')
    expect(m.battleLog[0]).toMatchObject({
      kind: 'attack',
      targetLevel: 2,
      won: true,
      lootSum: '100',
      losses: 0,
      villageId: 'v0',
    })
    expect(m.battleLog[1]).toMatchObject({
      kind: 'raid',
      won: false,
      looted: '25',
      losses: 1,
      villageId: 'v0',
    })

    // The v4 top-level economy fields no longer live at the root after the wrap.
    expect(m.buildings).toBeUndefined()
    expect(m.resources).toBeUndefined()
    expect(m.marches).toBeUndefined()
    expect(m.raidTimer).toBeUndefined()
    // The global header is carried through untouched.
    expect(m.seed).toBe('v4')
    expect(m.rngState).toBe(42)
    expect(m.createdAt).toBe(1000)
    expect(m.lastSeen).toBe(2000)
  })

  it('tolerates a v4 save with a missing battle log (defaults to empty global log)', () => {
    const raw = rawV4()
    delete (raw as { battleLog?: unknown }).battleLog
    const m = migrate(raw)
    expect(m.version).toBe(SAVE_VERSION)
    expect(m.battleLog).toEqual([])
    expect(m.villages.v0.name).toBe('Stolica')
  })

  it('a migrated v4 save passes validateState', () => {
    const v = validateState(migrate(rawV4()))
    expect(v.version).toBe(SAVE_VERSION)
    expect(v.villageOrder).toEqual(['v0'])
    expect(v.villages.v0.name).toBe('Stolica')
    expect(v.battleLog.every((r) => r.villageId === 'v0')).toBe(true)
  })

  it('importSave of a v4 export wraps the village and re-derives its cached stats', () => {
    // Encode exactly as exportSave would (Decimals tagged); import migrates v4->v5.
    const b64 = exportSave(rawV4() as never)
    const state = importSave(b64)

    expect(state.version).toBe(SAVE_VERSION)
    const v0 = state.villages.v0
    expect(v0.name).toBe('Stolica')
    expect(v0.buildings.sawmill).toBe(2)
    // recomputeDerived ran on import: production is consistent with sawmill lvl 2.
    expect(v0.production.wood.toString()).toBe('2')
    // Loot Decimals survived the {$d} tag round-trip through the wrap.
    expect(v0.marches[0].loot.wood.toString()).toBe('50')
    // The global log survived and stays stamped to the capital.
    expect(state.battleLog).toHaveLength(2)
    expect(state.battleLog.every((r) => r.villageId === 'v0')).toBe(true)
  })
})

/**
 * A raw v5 save: the multi-village shape right before M2.2. The capital lives under
 * `villages.v0` but carries NO map coordinates (no x/y), there is NO spatial `world`
 * at the top level, and its in-flight march predates target ids — it has only a
 * `targetLevel` (no targetId / targetX / targetY). Exactly the three things the
 * v5->v6 migration must backfill: coords (capital -> WORLD_CENTER), a seed-generated
 * barbarian world, and the 'legacy' march geometry reconstructed from the old
 * per-level distance.
 */
function rawV5() {
  return {
    version: 5,
    seed: 'v5',
    rngState: 77,
    createdAt: 1000,
    lastSeen: 2000,
    villages: {
      v0: {
        id: 'v0',
        name: 'Stolica',
        // NB: no x / y yet — that is what v5->v6 adds.
        resources: { wood: D(10), clay: D(20), iron: D(30) },
        production: { wood: D(2), clay: D(0.8), iron: D(0.5) },
        storageCap: D(4000),
        popCap: D(22),
        buildings: { hq: 1, sawmill: 2, clay_pit: 1, iron_mine: 1, warehouse: 1, farm: 1, barracks: 1 },
        units: { spearman: 5, swordsman: 0, axeman: 3 },
        recruitQueue: [],
        marches: [
          {
            // Pre-M2.2 march: a targetLevel snapshot but NO targetId / targetX / targetY.
            targetLevel: 4,
            units: { spearman: 0, swordsman: 0, axeman: 2 },
            phase: 'returning',
            remaining: 30,
            loot: { wood: D(50), clay: D(40), iron: D(10) },
          },
        ],
        raidTimer: 500,
      },
    },
    villageOrder: ['v0'],
    // NB: no `world` yet — that is what v5->v6 generates from the seed.
    battleLog: [
      { kind: 'attack', villageId: 'v0', targetLevel: 4, won: true, lootSum: '100', losses: 0 },
    ],
  }
}

describe('migration v5 -> v6', () => {
  it('pins the capital to WORLD_CENTER, generates the barbarian world, and upgrades the legacy march', () => {
    const m = migrate(rawV5())

    expect(m.version).toBe(24)
    expect(m.version).toBe(SAVE_VERSION)
    // The multi-village shape is carried through untouched (still a single village).
    expect(m.villageOrder).toEqual(['v0'])
    expect(Object.keys(m.villages)).toEqual(['v0'])

    const v0 = m.villages.v0
    // Capital gets the world centre as its integer field coordinates.
    expect(v0.x).toBe(WORLD_CENTER.x)
    expect(v0.y).toBe(WORLD_CENTER.y)

    // A non-empty barbarian world is generated from the run seed.
    expect(m.world).toBeDefined()
    expect(Array.isArray(m.world.barbarians)).toBe(true)
    expect(m.world.barbarians.length).toBeGreaterThan(0)

    // The carried march is upgraded to the M2.2 spatial shape: 'legacy' target id,
    // its x reconstructed as capital.x + the OLD per-level distance (preserving the
    // source->target Euclidean distance, hence the return-leg travel time), its y on
    // the capital's row. The snapshot fields (targetLevel/phase/remaining/loot) are
    // left untouched.
    const march = v0.marches[0]
    expect(march.targetId).toBe('legacy')
    expect(march.targetX).toBe(WORLD_CENTER.x + barbarianTarget(4).distance)
    expect(march.targetY).toBe(WORLD_CENTER.y)
    expect(march.targetLevel).toBe(4)
    expect(march.phase).toBe('returning')
    expect(march.remaining).toBe(30)
    expect(march.loot.wood.toString()).toBe('50')

    // Pre-existing economy + header are carried through verbatim.
    expect(v0.buildings.sawmill).toBe(2)
    expect(v0.resources.wood.toString()).toBe('10')
    expect(v0.raidTimer).toBe(500)
    expect(m.seed).toBe('v5')
    expect(m.rngState).toBe(77)
    expect(m.battleLog).toHaveLength(1)
    expect(m.battleLog[0].villageId).toBe('v0')
  })

  it('a migrated v5 save passes validateState (coords, world and legacy march all valid)', () => {
    const v = validateState(migrate(rawV5()))
    expect(v.version).toBe(SAVE_VERSION)
    expect(v.villages.v0.x).toBe(WORLD_CENTER.x)
    expect(v.villages.v0.y).toBe(WORLD_CENTER.y)
    expect(v.world.barbarians.length).toBeGreaterThan(0)
    expect(v.villages.v0.marches[0].targetId).toBe('legacy')
    // Every generated barbarian is a well-formed, in-range descriptor.
    for (const b of v.world.barbarians) {
      expect(typeof b.id).toBe('string')
      expect(Number.isFinite(b.x)).toBe(true)
      expect(Number.isFinite(b.y)).toBe(true)
      expect(Number.isInteger(b.level)).toBe(true)
      expect(b.level).toBeGreaterThanOrEqual(1)
    }
  })

  it('world generation is deterministic from the seed (stable list, stable ids)', () => {
    const a = migrate(rawV5())
    const b = migrate(rawV5())
    // Same seed -> structurally identical world (no clock/Math.random in generation).
    expect(a.world).toEqual(b.world)
    // Ids are the stable 'b'+index sequence in generation order.
    expect(a.world.barbarians[0].id).toBe('b0')
  })

  it('importSave of a v5 export backfills coords, world and legacy march geometry, then re-derives stats', () => {
    // Encode exactly as exportSave would (Decimals tagged); import migrates v5->v6.
    const b64 = exportSave(rawV5() as never)
    const state = importSave(b64)

    expect(state.version).toBe(SAVE_VERSION)
    const v0 = state.villages.v0
    expect(v0.x).toBe(WORLD_CENTER.x)
    expect(v0.y).toBe(WORLD_CENTER.y)
    expect(state.world.barbarians.length).toBeGreaterThan(0)
    expect(v0.marches[0].targetId).toBe('legacy')
    expect(v0.marches[0].targetX).toBe(WORLD_CENTER.x + barbarianTarget(4).distance)
    // Loot Decimals survived the {$d} tag round-trip through the migration.
    expect(v0.marches[0].loot.wood.toString()).toBe('50')
    // recomputeDerived ran on import: production is consistent with sawmill lvl 2.
    expect(v0.production.wood.toString()).toBe('2')
  })
})

/**
 * A raw v6 save: the multi-village + spatial-world shape right before M2.4. The
 * capital carries its map coordinates and the barbarian `world` exists, but the
 * save predates the conquest content: its `buildings` has NO `academy` (Pałac), its
 * `units` has NO `noble` (Szlachcic), the in-flight march's dispatched subset has NO
 * `noble` slot either, and every barbarian has NO `loyalty`. Exactly the four things
 * the v6->v7 migration must backfill WITHOUT disturbing progress: academy:0 onto the
 * buildings, noble:0 onto the roster AND the march units, and loyalty=100 (full,
 * hardest to take) onto every barbarian.
 */
function rawV6() {
  return {
    version: 6,
    seed: 'v6',
    rngState: 123,
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
        // NB: no `academy` key yet — that is what v6->v7 adds (academy:0).
        buildings: { hq: 1, sawmill: 2, clay_pit: 1, iron_mine: 1, warehouse: 1, farm: 1, barracks: 1 },
        // NB: no `noble` key yet — that is what v6->v7 adds (noble:0).
        units: { spearman: 5, swordsman: 0, axeman: 3 },
        recruitQueue: [],
        marches: [
          {
            targetId: 'b7',
            targetLevel: 3,
            targetX: WORLD_CENTER.x + 9,
            targetY: WORLD_CENTER.y,
            // NB: the dispatched subset has no `noble` slot yet — added by v6->v7.
            units: { spearman: 0, swordsman: 0, axeman: 2 },
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
        // NB: no `loyalty` field yet — that is what v6->v7 adds (defaults to 100).
        { id: 'b0', x: 210, y: 198, level: 2, name: 'Obóz barbarzyńców (poz. 2)' },
        { id: 'b1', x: 190, y: 205, level: 5, name: 'Obóz barbarzyńców (poz. 5)' },
      ],
    },
    battleLog: [
      { kind: 'attack', villageId: 'v0', targetLevel: 3, won: true, lootSum: '100', losses: 0 },
    ],
  }
}

describe('migration v6 -> v7', () => {
  it('backfills the academy building, the noble unit (roster + marches) and full barbarian loyalty', () => {
    const m = migrate(rawV6())

    expect(m.version).toBe(24)
    expect(m.version).toBe(SAVE_VERSION)
    // The multi-village shape is carried through untouched (still a single village).
    expect(m.villageOrder).toEqual(['v0'])
    expect(Object.keys(m.villages)).toEqual(['v0'])

    const v0 = m.villages.v0
    // The new academy building is seeded at its initial level (0) WITHOUT clobbering
    // the player's existing levels — the whole BUILDING_IDS roster matches the seed
    // map merged over the carried levels.
    expect(v0.buildings).toEqual({ ...INITIAL_BUILDINGS, ...rawV6().villages.v0.buildings })
    expect(v0.buildings.academy).toBe(0)
    expect(v0.buildings.sawmill).toBe(2)
    expect(v0.buildings.barracks).toBe(1)
    for (const id of BUILDING_IDS) expect(typeof v0.buildings[id]).toBe('number')

    // The new noble unit is seeded at 0 in the village roster; existing counts kept.
    expect(v0.units).toEqual({ spearman: 5, swordsman: 0, axeman: 3, noble: 0, scout: 0, ram: 0, catapult: 0, light_cavalry: 0, heavy_cavalry: 0 })
    for (const id of UNIT_IDS) expect(typeof v0.units[id]).toBe('number')

    // The in-flight march's dispatched subset ALSO gains the noble:0 slot (over the
    // full zero roster), with the rest of the march snapshot left untouched.
    expect(v0.marches[0].units).toEqual({ spearman: 0, swordsman: 0, axeman: 2, noble: 0, scout: 0, ram: 0, catapult: 0, light_cavalry: 0, heavy_cavalry: 0 })
    expect(v0.marches[0].targetId).toBe('b7')
    expect(v0.marches[0].targetLevel).toBe(3)
    expect(v0.marches[0].phase).toBe('returning')
    expect(v0.marches[0].remaining).toBe(30)
    expect(v0.marches[0].loot.wood.toString()).toBe('50')

    // Every barbarian gains FULL loyalty (100 = hardest to take); other fields kept.
    expect(m.world.barbarians).toHaveLength(2)
    for (const b of m.world.barbarians) expect(b.loyalty).toBe(100)
    expect(m.world.barbarians[0].id).toBe('b0')
    expect(m.world.barbarians[0].level).toBe(2)
    expect(m.world.barbarians[1].id).toBe('b1')
    expect(m.world.barbarians[1].level).toBe(5)

    // Header + economy + log carried through verbatim.
    expect(m.seed).toBe('v6')
    expect(m.rngState).toBe(123)
    expect(m.createdAt).toBe(1000)
    expect(m.lastSeen).toBe(2000)
    expect(v0.x).toBe(WORLD_CENTER.x)
    expect(v0.y).toBe(WORLD_CENTER.y)
    expect(v0.resources.wood.toString()).toBe('10')
    expect(v0.raidTimer).toBe(500)
    expect(m.battleLog).toHaveLength(1)
    expect(m.battleLog[0].villageId).toBe('v0')
  })

  it('a migrated v6 save passes validateState (academy/noble keys + loyalty band)', () => {
    const v = validateState(migrate(rawV6()))
    expect(v.version).toBe(SAVE_VERSION)
    // The new keys are present and within their valid ranges everywhere they live.
    expect(v.villages.v0.buildings.academy).toBe(0)
    expect(v.villages.v0.units.noble).toBe(0)
    expect(v.villages.v0.marches[0].units.noble).toBe(0)
    // Loyalty is a finite number inside the [0, 100] band validateState enforces.
    for (const b of v.world.barbarians) {
      expect(Number.isFinite(b.loyalty)).toBe(true)
      expect(b.loyalty).toBeGreaterThanOrEqual(0)
      expect(b.loyalty).toBeLessThanOrEqual(100)
    }
  })

  it('preserves a loyalty value a forward-compat v6 save already carries', () => {
    // A save that already has a numeric loyalty keeps it (the default only fills a
    // missing/non-numeric one), so a hand-edited / newer save round-trips faithfully.
    const raw = rawV6()
    ;(raw.world.barbarians[0] as { loyalty?: number }).loyalty = 42
    const m = migrate(raw)
    expect(m.world.barbarians[0].loyalty).toBe(42)
    expect(m.world.barbarians[1].loyalty).toBe(100)
    // Still a valid state after the partial backfill.
    expect(validateState(m).version).toBe(SAVE_VERSION)
  })

  it('importSave of a v6 export backfills academy/noble/loyalty, then re-derives stats', () => {
    // Encode exactly as exportSave would (Decimals tagged); import migrates v6->v7.
    const b64 = exportSave(rawV6() as never)
    const state = importSave(b64)

    expect(state.version).toBe(SAVE_VERSION)
    const v0 = state.villages.v0
    expect(v0.buildings.academy).toBe(0)
    expect(v0.units.noble).toBe(0)
    expect(v0.marches[0].units.noble).toBe(0)
    expect(state.world.barbarians.every((b) => b.loyalty === 100)).toBe(true)
    // Loot Decimals survived the {$d} tag round-trip through the migration.
    expect(v0.marches[0].loot.wood.toString()).toBe('50')
    // recomputeDerived ran on import: production is consistent with sawmill lvl 2.
    expect(v0.production.wood.toString()).toBe('2')
  })
})

/**
 * A raw v7 save: the multi-village + conquest shape right before M3.1. It already
 * carries everything the v6->v7 migration added (the academy building, the noble unit
 * in the roster AND in every in-flight march, full barbarian loyalty) but predates the
 * GLOBAL, account-wide passive tree: there is NO `tech` field at the top level.
 * Exactly the one thing the v7->v8 migration must backfill — `tech: {}`, an empty
 * sparse `{ nodeId: level }` map (absent key = level 0) — without disturbing anything
 * else (the tree's economic multipliers are TRANSIENT, folded by recomputeDerived on
 * import, so nothing derived is stored or seeded by the migration).
 */
function rawV7() {
  return {
    version: 7,
    seed: 'v7',
    rngState: 555,
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
        buildings: { hq: 1, sawmill: 2, clay_pit: 1, iron_mine: 1, warehouse: 1, farm: 1, barracks: 1, academy: 0 },
        units: { spearman: 5, swordsman: 0, axeman: 3, noble: 0 },
        recruitQueue: [],
        marches: [
          {
            targetId: 'b7',
            targetLevel: 3,
            targetX: WORLD_CENTER.x + 9,
            targetY: WORLD_CENTER.y,
            units: { spearman: 0, swordsman: 0, axeman: 2, noble: 0 },
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
        { id: 'b0', x: 210, y: 198, level: 2, name: 'Obóz barbarzyńców (poz. 2)', loyalty: 100 },
        { id: 'b1', x: 190, y: 205, level: 5, name: 'Obóz barbarzyńców (poz. 5)', loyalty: 80 },
      ],
    },
    battleLog: [
      { kind: 'attack', villageId: 'v0', targetLevel: 3, won: true, lootSum: '100', losses: 0 },
    ],
    // NB: no `tech` field yet — that is what v7->v8 backfills (tech: {}).
  }
}

describe('migration v7 -> v8', () => {
  it('backfills the empty account-wide tech map and carries everything else through', () => {
    const m = migrate(rawV7())

    expect(m.version).toBe(24)
    expect(m.version).toBe(SAVE_VERSION)
    // The single new top-level field: an empty passive-tree map (absent key = level 0).
    expect(m.tech).toEqual({})

    // The multi-village shape + economy + conquest content all carried through verbatim.
    expect(m.villageOrder).toEqual(['v0'])
    expect(Object.keys(m.villages)).toEqual(['v0'])
    const v0 = m.villages.v0
    expect(v0.name).toBe('Stolica')
    expect(v0.x).toBe(WORLD_CENTER.x)
    expect(v0.y).toBe(WORLD_CENTER.y)
    expect(v0.buildings.academy).toBe(0)
    expect(v0.buildings.sawmill).toBe(2)
    expect(v0.units).toEqual({ spearman: 5, swordsman: 0, axeman: 3, noble: 0, scout: 0, ram: 0, catapult: 0, light_cavalry: 0, heavy_cavalry: 0 })
    expect(v0.marches[0].units.noble).toBe(0)
    expect(v0.marches[0].loot.wood.toString()).toBe('50')
    expect(v0.resources.wood.toString()).toBe('10')
    expect(v0.raidTimer).toBe(500)
    // Loyalty (a v6->v7 field) is untouched by the v7->v8 step.
    expect(m.world.barbarians.map((b: { loyalty: number }) => b.loyalty)).toEqual([100, 80])
    // Header carried through.
    expect(m.seed).toBe('v7')
    expect(m.rngState).toBe(555)
    expect(m.createdAt).toBe(1000)
    expect(m.lastSeen).toBe(2000)
    expect(m.battleLog).toHaveLength(1)
    expect(m.battleLog[0].villageId).toBe('v0')
  })

  it('a migrated v7 save passes validateState (an empty tech map is always valid)', () => {
    const v = validateState(migrate(rawV7()))
    expect(v.version).toBe(SAVE_VERSION)
    expect(v.tech).toEqual({})
  })

  it('preserves a tech map a forward-compat v7 save already carries (known node ids)', () => {
    // A save that already has an OBJECT `tech` keeps it verbatim — the default only fills
    // a missing/non-object one — so a hand-edited / newer save round-trips faithfully.
    const knownId = TECH_NODE_IDS[0]
    expect(typeof knownId).toBe('string')
    const raw = rawV7() as Record<string, unknown>
    raw.tech = { [knownId]: 2 }
    const m = migrate(raw)
    expect(m.version).toBe(SAVE_VERSION)
    expect(m.tech).toEqual({ [knownId]: 2 })
    // An in-band level on a KNOWN node id, so the carried map still validates.
    expect(validateState(m).version).toBe(SAVE_VERSION)
  })

  it('resets a non-object tech field to an empty map', () => {
    // A corrupt / wrongly-typed `tech` (string / number / null) is reset to {} rather
    // than carried through, so the migrated save always validates.
    for (const bad of ['nope', 5, null] as const) {
      const raw = rawV7() as Record<string, unknown>
      raw.tech = bad
      const m = migrate(raw)
      expect(m.version).toBe(SAVE_VERSION)
      expect(m.tech).toEqual({})
      expect(validateState(m).version).toBe(SAVE_VERSION)
    }
  })

  it('importSave of a v7 export backfills tech:{} and re-derives stats', () => {
    // Encode exactly as exportSave would (Decimals tagged); import migrates v7->v8.
    const b64 = exportSave(rawV7() as never)
    const state = importSave(b64)

    expect(state.version).toBe(SAVE_VERSION)
    expect(state.tech).toEqual({})
    // Loot Decimals survived the {$d} tag round-trip through the migration.
    expect(state.villages.v0.marches[0].loot.wood.toString()).toBe('50')
    // recomputeDerived ran on import (with the empty tech mods, an identity multiplier),
    // so production is consistent with sawmill lvl 2.
    expect(state.villages.v0.production.wood.toString()).toBe('2')
  })
})

/**
 * A raw v8 save: the multi-village + conquest + passive-tree shape right before M4.1.
 * It already carries everything the v7->v8 migration added (a top-level account-wide
 * `tech` map) but predates the PERMANENT prestige/ascension account: there is NO
 * `prestige` field at the top level. Exactly the one thing the v8->v9 migration must
 * backfill — `prestige: { points: 0, totalEarned: 0, ascensions: 0, nodes: {} }`, the
 * zero permanent record (the multipliers its nodes drive are TRANSIENT, folded by
 * aggregatePrestigeMods inside effectiveMods in recomputeDerived on import, so nothing
 * derived is stored or seeded by the migration) — without disturbing anything else.
 */
function rawV8() {
  return {
    version: 8,
    seed: 'v8',
    rngState: 4242,
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
        buildings: { hq: 1, sawmill: 2, clay_pit: 1, iron_mine: 1, warehouse: 1, farm: 1, barracks: 1, academy: 0 },
        units: { spearman: 5, swordsman: 0, axeman: 3, noble: 0 },
        recruitQueue: [],
        marches: [
          {
            targetId: 'b7',
            targetLevel: 3,
            targetX: WORLD_CENTER.x + 9,
            targetY: WORLD_CENTER.y,
            units: { spearman: 0, swordsman: 0, axeman: 2, noble: 0 },
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
        { id: 'b0', x: 210, y: 198, level: 2, name: 'Obóz barbarzyńców (poz. 2)', loyalty: 100 },
        { id: 'b1', x: 190, y: 205, level: 5, name: 'Obóz barbarzyńców (poz. 5)', loyalty: 80 },
      ],
    },
    battleLog: [
      { kind: 'attack', villageId: 'v0', targetLevel: 3, won: true, lootSum: '100', losses: 0 },
    ],
    // The v7->v8 field is already present (a non-empty account-wide tech map).
    tech: { eco_root: 2 },
    // NB: no `prestige` field yet — that is what v8->v9 backfills (the zero record).
  }
}

describe('migration v8 -> v9', () => {
  it('backfills the zero permanent prestige record and carries everything else through', () => {
    const m = migrate(rawV8())

    expect(m.version).toBe(24)
    expect(m.version).toBe(SAVE_VERSION)
    // The single new top-level field: the zero permanent prestige (ascension) record.
    expect(m.prestige).toEqual({ points: 0, totalEarned: 0, ascensions: 0, nodes: {} })

    // The v7->v8 tech map + multi-village shape + economy + conquest content all carried
    // through verbatim (the v8->v9 step touches nothing but `prestige` and `version`).
    expect(m.tech).toEqual({ eco_root: 2 })
    expect(m.villageOrder).toEqual(['v0'])
    expect(Object.keys(m.villages)).toEqual(['v0'])
    const v0 = m.villages.v0
    expect(v0.name).toBe('Stolica')
    expect(v0.x).toBe(WORLD_CENTER.x)
    expect(v0.y).toBe(WORLD_CENTER.y)
    expect(v0.buildings.academy).toBe(0)
    expect(v0.buildings.sawmill).toBe(2)
    expect(v0.units).toEqual({ spearman: 5, swordsman: 0, axeman: 3, noble: 0, scout: 0, ram: 0, catapult: 0, light_cavalry: 0, heavy_cavalry: 0 })
    expect(v0.marches[0].units.noble).toBe(0)
    expect(v0.marches[0].loot.wood.toString()).toBe('50')
    expect(v0.resources.wood.toString()).toBe('10')
    expect(v0.raidTimer).toBe(500)
    expect(m.world.barbarians.map((b: { loyalty: number }) => b.loyalty)).toEqual([100, 80])
    // Header carried through.
    expect(m.seed).toBe('v8')
    expect(m.rngState).toBe(4242)
    expect(m.createdAt).toBe(1000)
    expect(m.lastSeen).toBe(2000)
    expect(m.battleLog).toHaveLength(1)
    expect(m.battleLog[0].villageId).toBe('v0')
  })

  it('a migrated v8 save passes validateState (a zero prestige record is always valid)', () => {
    const v = validateState(migrate(rawV8()))
    expect(v.version).toBe(SAVE_VERSION)
    expect(v.prestige).toEqual({ points: 0, totalEarned: 0, ascensions: 0, nodes: {} })
  })

  it('preserves a prestige record a forward-compat v8 save already carries (known node ids)', () => {
    // A save that already has an OBJECT `prestige` keeps it verbatim — the default only
    // fills a missing/non-object one — so a hand-edited / newer save round-trips faithfully.
    const knownId = PRESTIGE_NODE_IDS[0]
    expect(typeof knownId).toBe('string')
    const raw = rawV8() as Record<string, unknown>
    raw.prestige = { points: 7, totalEarned: 12, ascensions: 2, nodes: { [knownId]: 1 } }
    const m = migrate(raw)
    expect(m.version).toBe(SAVE_VERSION)
    expect(m.prestige).toEqual({ points: 7, totalEarned: 12, ascensions: 2, nodes: { [knownId]: 1 } })
    // In-band counters + a level-1 KNOWN node id, so the carried record still validates.
    expect(validateState(m).version).toBe(SAVE_VERSION)
  })

  it('resets a non-object prestige field to the zero record', () => {
    // A corrupt / wrongly-typed `prestige` (string / number / null) is reset to the zero
    // record rather than carried through, so the migrated save always validates.
    for (const bad of ['nope', 5, null] as const) {
      const raw = rawV8() as Record<string, unknown>
      raw.prestige = bad
      const m = migrate(raw)
      expect(m.version).toBe(SAVE_VERSION)
      expect(m.prestige).toEqual({ points: 0, totalEarned: 0, ascensions: 0, nodes: {} })
      expect(validateState(m).version).toBe(SAVE_VERSION)
    }
  })

  it('importSave of a v8 export backfills the zero prestige record and re-derives stats', () => {
    // Encode exactly as exportSave would (Decimals tagged); import migrates v8->v9.
    const b64 = exportSave(rawV8() as never)
    const state = importSave(b64)

    expect(state.version).toBe(SAVE_VERSION)
    expect(state.prestige).toEqual({ points: 0, totalEarned: 0, ascensions: 0, nodes: {} })
    // The carried tech map survived the migration too.
    expect(state.tech).toEqual({ eco_root: 2 })
    // Loot Decimals survived the {$d} tag round-trip through the migration.
    expect(state.villages.v0.marches[0].loot.wood.toString()).toBe('50')
    // recomputeDerived ran on import (with empty prestige mods + the eco_root tech mod),
    // so production reflects sawmill lvl 2 (base 2) lifted by the +0.04 production
    // multiplier (eco_root level 2 → 1.04). The prestige bag is identity, so it adds nothing.
    expect(Number(state.villages.v0.production.wood.toString())).toBeCloseTo(2.08, 6)
  })
})

/**
 * A raw v9 save: the multi-village + conquest + tech + prestige shape right before M5.1.
 * It already carries everything through v8->v9 (a permanent `prestige` record) but
 * predates the idle-automation toggles + policy: there is NO `automation` field at the
 * top level. Exactly the one thing the v9->v10 migration must backfill —
 * `automation: { build: false, recruit: false, attack: false, recruitUnit: null,
 * recruitTarget: 0 }`, the all-off default (the routines are read straight from the
 * state each sub-step, so nothing derived is stored/seeded) — without disturbing
 * anything else. All-off means a migrated save plays EXACTLY like pre-M5.1.
 */
function rawV9() {
  return {
    version: 9,
    seed: 'v9',
    rngState: 777,
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
        buildings: { hq: 1, sawmill: 2, clay_pit: 1, iron_mine: 1, warehouse: 1, farm: 1, barracks: 1, academy: 0 },
        units: { spearman: 5, swordsman: 0, axeman: 3, noble: 0 },
        recruitQueue: [],
        marches: [],
        raidTimer: 500,
      },
    },
    villageOrder: ['v0'],
    world: {
      barbarians: [
        { id: 'b0', x: 210, y: 198, level: 2, name: 'Obóz barbarzyńców (poz. 2)', loyalty: 100 },
      ],
    },
    battleLog: [],
    tech: { eco_root: 2 },
    prestige: { points: 3, totalEarned: 5, ascensions: 1, nodes: {} },
    // NB: no `automation` field yet — that is what v9->v10 backfills (all-off default).
  }
}

describe('migration v9 -> v10', () => {
  it('backfills the all-off automation record and carries everything else through', () => {
    const m = migrate(rawV9())

    expect(m.version).toBe(24)
    expect(m.version).toBe(SAVE_VERSION)
    // The single new top-level field: the all-off automation toggles + empty policy.
    expect(m.automation).toEqual({
      build: false,
      recruit: false,
      attack: false,
      recruitUnit: null,
      recruitTarget: 0,
    })

    // Everything the earlier migrations produced carries through verbatim (v9->v10
    // touches nothing but `automation` and `version`).
    expect(m.tech).toEqual({ eco_root: 2 })
    expect(m.prestige).toEqual({ points: 3, totalEarned: 5, ascensions: 1, nodes: {} })
    expect(m.villageOrder).toEqual(['v0'])
    const v0 = m.villages.v0
    expect(v0.name).toBe('Stolica')
    expect(v0.buildings.barracks).toBe(1)
    expect(v0.units).toEqual({ spearman: 5, swordsman: 0, axeman: 3, noble: 0, scout: 0, ram: 0, catapult: 0, light_cavalry: 0, heavy_cavalry: 0 })
    expect(v0.resources.wood.toString()).toBe('10')
    expect(m.seed).toBe('v9')
    expect(m.rngState).toBe(777)
  })

  it('a migrated v9 save passes validateState (the all-off default is always valid)', () => {
    const v = validateState(migrate(rawV9()))
    expect(v.version).toBe(SAVE_VERSION)
    expect(v.automation).toEqual({
      build: false,
      recruit: false,
      attack: false,
      recruitUnit: null,
      recruitTarget: 0,
    })
  })

  it('preserves an automation record a forward-compat v9 save already carries', () => {
    // A save that already has an OBJECT `automation` keeps it verbatim — the default only
    // fills a missing/non-object one — so a hand-edited / newer save round-trips faithfully.
    const raw = rawV9() as Record<string, unknown>
    raw.automation = {
      build: true,
      recruit: true,
      attack: false,
      recruitUnit: 'spearman',
      recruitTarget: 25,
    }
    const m = migrate(raw)
    expect(m.version).toBe(SAVE_VERSION)
    expect(m.automation).toEqual({
      build: true,
      recruit: true,
      attack: false,
      recruitUnit: 'spearman',
      recruitTarget: 25,
    })
    // A known unit id + an in-range integer target, so the carried record validates.
    expect(validateState(m).version).toBe(SAVE_VERSION)
  })

  it('resets a non-object automation field to the all-off default', () => {
    // A corrupt / wrongly-typed `automation` (string / number / null) is reset to the
    // all-off default rather than carried through, so the migrated save always validates.
    for (const bad of ['nope', 5, null] as const) {
      const raw = rawV9() as Record<string, unknown>
      raw.automation = bad
      const m = migrate(raw)
      expect(m.version).toBe(SAVE_VERSION)
      expect(m.automation).toEqual({
        build: false,
        recruit: false,
        attack: false,
        recruitUnit: null,
        recruitTarget: 0,
      })
      expect(validateState(m).version).toBe(SAVE_VERSION)
    }
  })

  it('importSave of a v9 export backfills the default automation and re-derives stats', () => {
    // Encode exactly as exportSave would (Decimals tagged); import migrates v9->v10.
    const b64 = exportSave(rawV9() as never)
    const state = importSave(b64)

    expect(state.version).toBe(SAVE_VERSION)
    expect(state.automation).toEqual({
      build: false,
      recruit: false,
      attack: false,
      recruitUnit: null,
      recruitTarget: 0,
    })
    // The carried tech + prestige survived the migration too.
    expect(state.tech).toEqual({ eco_root: 2 })
    expect(state.prestige).toEqual({ points: 3, totalEarned: 5, ascensions: 1, nodes: {} })
    // recomputeDerived ran on import (eco_root level 2 → +0.04 production on sawmill lvl 2).
    expect(Number(state.villages.v0.production.wood.toString())).toBeCloseTo(2.08, 6)
  })
})

/**
 * A raw v10 save: the multi-village + conquest + tech + prestige + automation shape
 * right before M5.2. It predates FOUR new bits of state, all backfilled by v10->v11:
 *  - the 'wall' BUILDING key (every village's `buildings`) and the 'scout' UNIT key
 *    (every village's `units` AND every in-flight march's dispatched subset);
 *  - a `kind` discriminant on every march (defaulting to 'attack', the only pre-M5.2 kind);
 *  - a `scouted` flag on every barbarian (defaulting to false / undiscovered).
 * So its village has NO wall, NO scout, its march carries NO kind, and its barbarian
 * has NO scouted — exactly the four things the v10->v11 migration must add WITHOUT
 * disturbing anything else (all-default backfill ⇒ plays exactly like pre-M5.2).
 */
function rawV10() {
  return {
    version: 10,
    seed: 'v10',
    rngState: 999,
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
        buildings: { hq: 1, sawmill: 2, clay_pit: 1, iron_mine: 1, warehouse: 1, farm: 1, barracks: 1, academy: 0 },
        units: { spearman: 5, swordsman: 0, axeman: 3, noble: 0 },
        recruitQueue: [],
        marches: [
          {
            // No `kind` here (pre-M5.2) and no scout slot — both backfilled by v10->v11.
            targetId: 'b0',
            targetLevel: 2,
            targetX: 210,
            targetY: 198,
            units: { spearman: 0, swordsman: 0, axeman: 2, noble: 0 },
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
        // No `scouted` here (pre-M5.2) — backfilled false by v10->v11.
        { id: 'b0', x: 210, y: 198, level: 2, name: 'Obóz barbarzyńców (poz. 2)', loyalty: 100 },
      ],
    },
    battleLog: [],
    tech: { eco_root: 2 },
    prestige: { points: 3, totalEarned: 5, ascensions: 1, nodes: {} },
    automation: { build: false, recruit: false, attack: false, recruitUnit: null, recruitTarget: 0 },
  }
}

describe('migration v10 -> v11', () => {
  it('backfills wall (buildings), scout (units + marches), march kind and barbarian scouted', () => {
    const m = migrate(rawV10())

    expect(m.version).toBe(24)
    expect(m.version).toBe(SAVE_VERSION)

    const v0 = m.villages.v0
    // The new 'wall' building key lands at level 0 WITHOUT clobbering carried levels.
    expect(v0.buildings.wall).toBe(0)
    expect(v0.buildings.sawmill).toBe(2)
    expect(v0.buildings).toEqual({ ...INITIAL_BUILDINGS, ...rawV10().villages.v0.buildings })
    // The new 'scout' unit key lands at 0 (roster), carried counts preserved.
    expect(v0.units).toEqual({ spearman: 5, swordsman: 0, axeman: 3, noble: 0, scout: 0, ram: 0, catapult: 0, light_cavalry: 0, heavy_cavalry: 0 })
    // Every in-flight march gains kind:'attack' (the only pre-M5.2 kind) and a scout:0 slot.
    expect(v0.marches.length).toBe(1)
    expect(v0.marches[0].kind).toBe('attack')
    expect(v0.marches[0].units).toEqual({ spearman: 0, swordsman: 0, axeman: 2, noble: 0, scout: 0, ram: 0, catapult: 0, light_cavalry: 0, heavy_cavalry: 0 })
    // Loot Decimals are carried through untouched.
    expect(v0.marches[0].loot.wood.toString()).toBe('50')
    // Every barbarian gains scouted:false (undiscovered); loyalty is left intact.
    expect(m.world.barbarians.length).toBe(1)
    expect(m.world.barbarians[0].scouted).toBe(false)
    expect(m.world.barbarians[0].loyalty).toBe(100)
    // Everything else carries through verbatim (v10->v11 touches nothing but those four).
    expect(m.tech).toEqual({ eco_root: 2 })
    expect(m.automation).toEqual({
      build: false,
      recruit: false,
      attack: false,
      recruitUnit: null,
      recruitTarget: 0,
    })
    expect(m.seed).toBe('v10')
  })

  it('a migrated v10 save passes validateState (the new keys/flags are all valid defaults)', () => {
    const v = validateState(migrate(rawV10()))
    expect(v.version).toBe(SAVE_VERSION)
    expect(v.villages.v0.buildings.wall).toBe(0)
    expect(v.villages.v0.units.scout).toBe(0)
    expect(v.villages.v0.marches[0].kind).toBe('attack')
    expect(v.world.barbarians[0].scouted).toBe(false)
  })

  it('preserves a march kind / barbarian scouted a forward-compat v10 save already carries', () => {
    // A save that already carries a STRING kind / BOOLEAN scouted keeps them verbatim —
    // the default only fills a missing/wrong-typed one — so a newer/hand-edited save
    // round-trips faithfully (and still validates: 'scout' and true are both in-band).
    const raw = rawV10() as {
      villages: { v0: { marches: { kind?: string }[] } }
      world: { barbarians: { scouted?: boolean }[] }
    }
    raw.villages.v0.marches[0].kind = 'scout'
    raw.world.barbarians[0].scouted = true
    const m = migrate(raw)
    expect(m.version).toBe(SAVE_VERSION)
    expect(m.villages.v0.marches[0].kind).toBe('scout')
    expect(m.world.barbarians[0].scouted).toBe(true)
    expect(validateState(m).version).toBe(SAVE_VERSION)
  })

  it('importSave of a v10 export backfills wall/scout/kind/scouted and re-derives stats', () => {
    // Encode exactly as exportSave would (Decimals tagged); import migrates v10->v11.
    const b64 = exportSave(rawV10() as never)
    const state = importSave(b64)

    expect(state.version).toBe(SAVE_VERSION)
    expect(state.villages.v0.buildings.wall).toBe(0)
    expect(state.villages.v0.units.scout).toBe(0)
    expect(state.villages.v0.marches[0].kind).toBe('attack')
    expect(state.world.barbarians[0].scouted).toBe(false)
    // The carried tech survived the migration too.
    expect(state.tech).toEqual({ eco_root: 2 })
    // recomputeDerived ran on import (eco_root level 2 → +0.04 production on sawmill lvl 2).
    expect(Number(state.villages.v0.production.wood.toString())).toBeCloseTo(2.08, 6)
  })
})

describe('save v2 round-trip', () => {
  it('serialize(deserialize(serialize(s))) === serialize(s) for a fresh state', () => {
    const state = createInitialState('rt', 5000)
    const json = serialize(state)
    expect(serialize(deserialize(json))).toBe(json)
  })

  it('preserves building levels across export/import', () => {
    const state = createInitialState('levels', 7000)
    state.villages.v0.buildings.sawmill = 7
    state.villages.v0.buildings.warehouse = 3
    recomputeDerived(state)

    const restored = importSave(exportSave(state))
    expect(restored.villages.v0.buildings.sawmill).toBe(7)
    expect(restored.villages.v0.buildings.warehouse).toBe(3)
    expect(serialize(restored)).toBe(serialize(state))
  })

  it('faithfully round-trips a save with owned units and a non-empty queue', () => {
    const state = createInitialState('army', 9000)
    state.villages.v0.buildings.barracks = 2
    recomputeDerived(state)
    // Trained roster + an in-flight training order (snapshotted per-unit time).
    state.villages.v0.units.spearman = 3
    state.villages.v0.units.axeman = 1
    state.villages.v0.recruitQueue = [
      { unitId: 'spearman', count: 2, remaining: 40, perUnitSeconds: 76 },
      { unitId: 'swordsman', count: 1, remaining: 110, perUnitSeconds: 110 },
    ]

    // validateState accepts the populated units + queue (no throw).
    expect(validateState(state).version).toBe(SAVE_VERSION)

    const restored = importSave(exportSave(state))
    expect(restored.villages.v0.units).toEqual(state.villages.v0.units)
    expect(restored.villages.v0.recruitQueue).toEqual(state.villages.v0.recruitQueue)
    // Plain-number queue/units carry no Decimal tags, so the bytes match exactly.
    expect(serialize(restored)).toBe(serialize(state))
  })

  it('faithfully round-trips a save with active marches (Decimal loot) and a global battle log', () => {
    const state = createInitialState('combat', 11000)
    state.villages.v0.buildings.barracks = 1
    recomputeDerived(state)
    state.villages.v0.units = { spearman: 4, swordsman: 0, axeman: 6, noble: 0, scout: 0, ram: 0, catapult: 0, light_cavalry: 0, heavy_cavalry: 0 }
    // A returning march carrying loot (Decimals) + an outbound march with zero loot.
    // Both carry the M2.2 spatial snapshot (targetId + targetX/targetY geometry).
    state.villages.v0.marches = [
      {
        kind: 'attack',
        targetType: 'camp',
        targetId: 'b12',
        targetLevel: 3,
        targetX: 209,
        targetY: 198,
        units: { spearman: 0, swordsman: 0, axeman: 5, noble: 0, scout: 0, ram: 0, catapult: 0, light_cavalry: 0, heavy_cavalry: 0 },
        phase: 'returning',
        remaining: 42.5,
        loot: { wood: D(120), clay: D(80), iron: D(15) },
      },
      {
        kind: 'attack',
        targetType: 'camp',
        targetId: 'b3',
        targetLevel: 1,
        targetX: 197,
        targetY: 203,
        units: { spearman: 2, swordsman: 0, axeman: 0, noble: 0, scout: 0, ram: 0, catapult: 0, light_cavalry: 0, heavy_cavalry: 0 },
        phase: 'outbound',
        remaining: 18,
        loot: { wood: D(0), clay: D(0), iron: D(0) },
      },
    ]
    // Plain-JSON GLOBAL battle log (loot pre-summed to strings, every report tagged).
    state.battleLog = [
      { kind: 'attack', villageId: 'v0', targetLevel: 3, won: true, lootSum: '215', losses: 1 },
      { kind: 'raid', villageId: 'v0', won: false, looted: '60', losses: 2 },
    ]
    state.villages.v0.raidTimer = 333

    // validateState accepts the populated combat state (no throw).
    expect(validateState(state).version).toBe(SAVE_VERSION)

    const restored = importSave(exportSave(state))
    const rv0 = restored.villages.v0
    expect(rv0.marches.length).toBe(2)
    // Loot Decimals survive the {$d} tag round-trip.
    expect(rv0.marches[0].phase).toBe('returning')
    expect(rv0.marches[0].remaining).toBe(42.5)
    expect(rv0.marches[0].units).toEqual({ spearman: 0, swordsman: 0, axeman: 5, noble: 0, scout: 0, ram: 0, catapult: 0, light_cavalry: 0, heavy_cavalry: 0 })
    expect(rv0.marches[0].loot.wood.toString()).toBe('120')
    // The M2.2 spatial snapshot (target id + coords) round-trips as plain JSON.
    expect(rv0.marches[0].targetId).toBe('b12')
    expect(rv0.marches[0].targetX).toBe(209)
    expect(rv0.marches[0].targetY).toBe(198)
    expect(rv0.marches[1].targetId).toBe('b3')
    expect(rv0.marches[0].loot.clay.toString()).toBe('80')
    expect(rv0.marches[0].loot.iron.toString()).toBe('15')
    expect(rv0.marches[1].phase).toBe('outbound')
    expect(rv0.marches[1].loot.wood.toString()).toBe('0')
    // Battle log is plain JSON, so deep-equals exactly (villageId included).
    expect(restored.battleLog).toEqual(state.battleLog)
    expect(rv0.raidTimer).toBe(333)
    // Byte-identical round-trip: loot Decimals tagged, log/timers plain.
    expect(serialize(restored)).toBe(serialize(state))
  })
})

/**
 * A raw v11 save: the multi-village + conquest + tech + prestige + automation + wall +
 * scout shape right before M5.3. It predates the TWO new siege UNIT keys (ram, catapult,
 * appended to UNIT_IDS after 'scout'), so its village `units` and its in-flight march's
 * dispatched subset carry NO ram/catapult slot — exactly what the v11->v12 migration must
 * backfill (to 0) WITHOUT disturbing anything else. M5.3 adds no new building / march
 * kind / barbarian field, so everything else (the wall building, the scout unit, the
 * march kind, the barbarian scouted flag) is already present and must carry through.
 */
function rawV11() {
  return {
    version: 11,
    seed: 'v11',
    rngState: 4242,
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
        buildings: { hq: 1, sawmill: 2, clay_pit: 1, iron_mine: 1, warehouse: 1, farm: 1, barracks: 1, academy: 1, wall: 3 },
        // pre-M5.3 roster: NO ram/catapult keys (both backfilled to 0 by v11->v12).
        units: { spearman: 5, swordsman: 0, axeman: 3, noble: 1, scout: 2 },
        recruitQueue: [],
        marches: [
          {
            kind: 'attack',
            targetId: 'b0',
            targetLevel: 2,
            targetX: 210,
            targetY: 198,
            // pre-M5.3 dispatched subset: NO ram/catapult slots either.
            units: { spearman: 0, swordsman: 0, axeman: 2, noble: 0, scout: 0 },
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
    },
    battleLog: [],
    tech: { eco_root: 2 },
    prestige: { points: 3, totalEarned: 5, ascensions: 1, nodes: {} },
    automation: { build: false, recruit: false, attack: false, recruitUnit: null, recruitTarget: 0 },
  }
}

describe('migration v11 -> v12', () => {
  it('backfills the ram + catapult unit slots (roster + marches), preserving everything else', () => {
    const m = migrate(rawV11())

    expect(m.version).toBe(24)
    expect(m.version).toBe(SAVE_VERSION)

    const v0 = m.villages.v0
    // The two new unit keys land at 0 WITHOUT clobbering the carried counts.
    expect(v0.units).toEqual({
      spearman: 5,
      swordsman: 0,
      axeman: 3,
      noble: 1,
      scout: 2,
      ram: 0,
      catapult: 0,
      light_cavalry: 0,
      heavy_cavalry: 0,
    })
    // Every in-flight march's dispatched subset gains ram:0 / catapult:0 too.
    expect(v0.marches.length).toBe(1)
    expect(v0.marches[0].units).toEqual({
      spearman: 0,
      swordsman: 0,
      axeman: 2,
      noble: 0,
      scout: 0,
      ram: 0,
      catapult: 0,
      light_cavalry: 0,
      heavy_cavalry: 0,
    })
    // M5.3 adds NO building / march kind / barbarian field — all carry through verbatim.
    expect(v0.buildings.wall).toBe(3)
    expect(v0.marches[0].kind).toBe('attack')
    expect(v0.marches[0].loot.wood.toString()).toBe('50')
    expect(m.world.barbarians[0].scouted).toBe(true)
    expect(m.world.barbarians[0].level).toBe(2)
    expect(m.world.barbarians[0].loyalty).toBe(100)
    expect(m.tech).toEqual({ eco_root: 2 })
    expect(m.seed).toBe('v11')
  })

  it('a migrated v11 save passes validateState (the new unit keys are valid 0 defaults)', () => {
    const v = validateState(migrate(rawV11()))
    expect(v.version).toBe(SAVE_VERSION)
    expect(v.villages.v0.units.ram).toBe(0)
    expect(v.villages.v0.units.catapult).toBe(0)
    expect(v.villages.v0.marches[0].units.ram).toBe(0)
    expect(v.villages.v0.marches[0].units.catapult).toBe(0)
  })

  it('preserves ram/catapult counts a forward-compat v11 save already carries', () => {
    // A save that already carries the siege keys keeps them verbatim — the backfill only
    // fills a MISSING slot (INITIAL_UNITS is spread first, the save's own values win).
    const raw = rawV11() as unknown as {
      villages: {
        v0: { units: Record<string, number>; marches: { units: Record<string, number> }[] }
      }
    }
    raw.villages.v0.units.ram = 4
    raw.villages.v0.units.catapult = 2
    raw.villages.v0.marches[0].units.ram = 1

    const m = migrate(raw)
    expect(m.version).toBe(SAVE_VERSION)
    expect(m.villages.v0.units.ram).toBe(4)
    expect(m.villages.v0.units.catapult).toBe(2)
    expect(m.villages.v0.marches[0].units.ram).toBe(1)
    expect(m.villages.v0.marches[0].units.catapult).toBe(0) // the missing one still backfills
    expect(validateState(m).version).toBe(SAVE_VERSION)
  })

  it('importSave of a v11 export backfills ram/catapult and re-derives stats', () => {
    // Encode exactly as exportSave would (Decimals tagged); import migrates v11->v12.
    const b64 = exportSave(rawV11() as never)
    const state = importSave(b64)

    expect(state.version).toBe(SAVE_VERSION)
    expect(state.villages.v0.units.ram).toBe(0)
    expect(state.villages.v0.units.catapult).toBe(0)
    // The carried tech survived the migration too.
    expect(state.tech).toEqual({ eco_root: 2 })
    // recomputeDerived ran on import (eco_root level 2 → +0.04 production on sawmill lvl 2).
    expect(Number(state.villages.v0.production.wood.toString())).toBeCloseTo(2.08, 6)
  })
})

/**
 * A raw, fully-valid v13 save (multi-village + conquest + tech + prestige + automation +
 * siege + lifetime stats + achievements) right before M5.5. It already carries `rngState`
 * (serialized since v1) and a battle log, but predates the optional per-report `luck`
 * field. The v13->v14 migration is deliberately a TRIVIAL version bump (no data
 * transform): old reports without `luck` stay valid (absence = "luck unknown"), and any
 * report that already carries `luck` is preserved. The log here mixes both, so the test
 * proves the bump touches nothing but `version`.
 */
function rawV13() {
  return {
    version: 13,
    seed: 'v13',
    rngState: 314159,
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
        marches: [],
        raidTimer: 500,
      },
    },
    villageOrder: ['v0'],
    world: {
      barbarians: [
        { id: 'b0', x: 210, y: 198, level: 2, name: 'Obóz barbarzyńców (poz. 2)', loyalty: 100, scouted: true },
      ],
    },
    // A pre-M5.5 attack report (NO luck) AND a pre-M5.5 raid report (NO luck): both must
    // survive the bump untouched and stay valid (the field is optional in v14).
    battleLog: [
      { kind: 'attack', villageId: 'v0', targetLevel: 2, won: true, lootSum: '100', losses: 1 },
      { kind: 'raid', villageId: 'v0', won: true, looted: '0', losses: 0 },
    ],
    tech: { eco_root: 2 },
    prestige: { points: 3, totalEarned: 5, ascensions: 1, nodes: {} },
    automation: { build: false, recruit: false, attack: false, recruitUnit: null, recruitTarget: 0 },
    stats: createInitialStats(),
    achievements: { first_blood: 1 },
  }
}

describe('migration v13 -> v14', () => {
  it('is a trivial version bump: every field (incl. luck-less reports) carries through', () => {
    const m = migrate(rawV13())

    expect(m.version).toBe(24)
    expect(m.version).toBe(SAVE_VERSION)

    // rngState (the luck stream) is untouched — it already existed pre-M5.5.
    expect(m.rngState).toBe(314159)
    // The pre-M5.5 reports survive verbatim and gained NO luck field.
    expect(m.battleLog).toHaveLength(2)
    expect('luck' in m.battleLog[0]).toBe(false)
    expect('luck' in m.battleLog[1]).toBe(false)
    expect(m.battleLog[0]).toMatchObject({ kind: 'attack', villageId: 'v0', won: true })
    expect(m.battleLog[1]).toMatchObject({ kind: 'raid', villageId: 'v0', won: true })
    // Everything else is carried through unchanged.
    expect(m.seed).toBe('v13')
    expect(m.villages.v0.units.ram).toBe(1)
    expect(m.tech).toEqual({ eco_root: 2 })
    expect(m.achievements).toEqual({ first_blood: 1 })
    expect(m.stats.lootHauled.toString()).toBe('0')
  })

  it('a migrated v13 save (with luck-less reports) passes validateState', () => {
    const v = validateState(migrate(rawV13()))
    expect(v.version).toBe(SAVE_VERSION)
    // The old reports are accepted with no luck field present.
    expect(v.battleLog).toHaveLength(2)
    for (const r of v.battleLog) {
      if (r.kind === 'attack' || r.kind === 'raid') expect(r.luck).toBeUndefined()
    }
  })

  it('preserves a forward-compat v13 report that already carries a luck roll', () => {
    // A save that already recorded luck (forward-compat) keeps the value verbatim.
    const raw = rawV13() as unknown as { battleLog: Array<Record<string, unknown>> }
    raw.battleLog[0].luck = 1.12
    raw.battleLog[1].luck = 0.79

    const m = migrate(raw)
    expect(m.version).toBe(SAVE_VERSION)
    expect(m.battleLog[0].luck).toBe(1.12)
    expect(m.battleLog[1].luck).toBe(0.79)
    expect(validateState(m).version).toBe(SAVE_VERSION)
  })

  it('importSave of a v13 export migrates to v14, keeping the luck-less log valid', () => {
    const restored = importSave(exportSave(rawV13() as never))
    expect(restored.version).toBe(SAVE_VERSION)
    expect(restored.battleLog).toHaveLength(2)
    const atk = restored.battleLog[0]
    if (atk.kind !== 'attack') throw new Error('expected an attack report')
    expect(atk.luck).toBeUndefined()
  })
})
