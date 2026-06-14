import { describe, it, expect } from 'vitest'
import { D, Decimal } from '../src/engine/decimal'
import {
  createInitialState,
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
import { WORLD_CENTER } from '../src/systems/world'

/**
 * `migrate` always chains a raw save all the way up to {@link SAVE_VERSION} (now
 * v6, the spatial-world shape). So every legacy save — v1, v2, v3, v4, v5 — ends
 * as a v6 GameState: the global header (version/seed/rng/timestamps) at the top
 * level, the per-village economy wrapped under `villages.v0` (the "Stolica"
 * capital, since old saves only ever had the one village) — now carrying integer
 * map coordinates (the capital pinned to WORLD_CENTER) — a bijective `villageOrder`
 * `['v0']`, a seed-generated barbarian `world`, and a GLOBAL `battleLog` whose every
 * report is stamped `villageId 'v0'`. These tests assert each migration backfills
 * its own fields AND that the v4->v5 wrap lands every per-village field under
 * `villages.v0`, while the v5->v6 step adds coords + world and upgrades any carried
 * march to the 'legacy' spatial shape.
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
  it('migrate() chains v1->...->v6: seeds buildings, popCap, units, queue, combat, coords + world and wraps into villages.v0', () => {
    const migrated = migrate(rawV1())

    expect(migrated.version).toBe(6)
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
    // Pre-existing recruitment state is carried through untouched into the village.
    expect(v0.units).toEqual({ spearman: 2, swordsman: 0, axeman: 1 })
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

    expect(m.version).toBe(6)
    expect(m.version).toBe(SAVE_VERSION)
    // Bijective single-village order: exactly one ordered id, exactly one village.
    expect(m.villageOrder).toEqual(['v0'])
    expect(Object.keys(m.villages)).toEqual(['v0'])

    const v0 = m.villages.v0
    expect(v0.id).toBe('v0')
    expect(v0.name).toBe('Stolica')

    // The nine per-village fields moved VERBATIM from the v4 top level into v0.
    expect(v0.buildings).toEqual(rawV4().buildings)
    expect(v0.units).toEqual({ spearman: 5, swordsman: 0, axeman: 3 })
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

    expect(m.version).toBe(6)
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
    state.villages.v0.units = { spearman: 4, swordsman: 0, axeman: 6 }
    // A returning march carrying loot (Decimals) + an outbound march with zero loot.
    // Both carry the M2.2 spatial snapshot (targetId + targetX/targetY geometry).
    state.villages.v0.marches = [
      {
        targetId: 'b12',
        targetLevel: 3,
        targetX: 209,
        targetY: 198,
        units: { spearman: 0, swordsman: 0, axeman: 5 },
        phase: 'returning',
        remaining: 42.5,
        loot: { wood: D(120), clay: D(80), iron: D(15) },
      },
      {
        targetId: 'b3',
        targetLevel: 1,
        targetX: 197,
        targetY: 203,
        units: { spearman: 2, swordsman: 0, axeman: 0 },
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
    expect(rv0.marches[0].units).toEqual({ spearman: 0, swordsman: 0, axeman: 5 })
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
