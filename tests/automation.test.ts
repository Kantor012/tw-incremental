import { describe, it, expect } from 'vitest'
import { D, type Decimal } from '../src/engine/decimal'
import {
  createInitialState,
  createVillage,
  recomputeDerived,
  recomputeVillageDerived,
  NO_TECH_MODS,
  type AutomationSettings,
  type GameState,
  type TechModifiers,
  type Village,
} from '../src/engine/state'
import { serialize } from '../src/engine/save'
import {
  autoBuildOnce,
  autoRecruitOnce,
  autoAttackOnce,
  runAutomation,
} from '../src/systems/automation'
import { aggregateTechMods } from '../src/systems/tech'
import { aggregatePrestigeMods, effectiveMods } from '../src/systems/prestige'
import { nextCostAffordable } from '../src/systems/buildings'
import { canRecruit } from '../src/systems/recruitment'
import { sendAttack, stationedUnits, canAttack } from '../src/systems/marches'
import { armyAttackPower } from '../src/systems/combat'
import { targetsByDistance } from '../src/systems/world'
import { BUILDING_IDS, BUILDINGS, type BuildingId } from '../src/content/buildings'
import { barbarianTarget } from '../src/content/barbarians'

/**
 * M5.1 — idle automations as tech UNLOCKS + player TOGGLES. These tests pin the
 * contract of the data-driven engine (systems/automation.ts), the unlock gate
 * (aggregateTechMods.automations / effectiveMods OR), the v9->v10 save shape and
 * the determinism the whole "idle" layer rests on:
 *  - autoBuildOnce: builds the cheapest AFFORDABLE non-maxed building, no-op otherwise;
 *  - autoRecruitOnce: tops up the chosen unit to its target (deficit / afford / pop
 *    capped, counting the queue), no-op when unaffordable / met / no unit / no barracks;
 *  - autoAttackOnce: throws the whole idle COMBAT army (NEVER nobles) at the nearest
 *    WIN-SAFE barbarian without an in-flight march, no-op when too weak / no army /
 *    already marching (self-limiting);
 *  - runAutomation: a routine fires ONLY when its tech gate is unlocked AND its toggle
 *    is on (the AND gate), in a stable order, deterministically.
 *
 * The economy is on Decimal; counts are plain integers. Determinism is asserted by
 * comparing the serialized state byte-for-byte across two independent runs.
 */

/** A mods bag with every automation routine UNLOCKED (else identical to NO_TECH_MODS). */
const ALL_UNLOCKED: TechModifiers = {
  ...NO_TECH_MODS,
  automations: { build: true, recruit: true, attack: true },
}

/** The win-margin auto-attack demands (mirrors WIN_MARGIN in systems/automation.ts). */
const WIN_MARGIN = 1.25

// --- autoBuildOnce ----------------------------------------------------------------

describe('autoBuildOnce', () => {
  it('builds the cheapest AFFORDABLE non-maxed building, raising exactly that one level', () => {
    const v = createVillage('v0', 'Stolica', 0, 0)
    v.resources = { wood: D(1e7), clay: D(1e7), iron: D(1e7) }

    // Independently work out the expected pick using the real cost function: the lowest
    // total (wood+clay+iron) next-level cost among affordable, non-maxed buildings, ties
    // broken by BUILDING_IDS order (strict `<` keeps the first).
    let bestId: BuildingId | null = null
    let bestTotal: Decimal | null = null
    for (const id of BUILDING_IDS) {
      const { cost, affordable, maxed } = nextCostAffordable(v, id, NO_TECH_MODS)
      if (maxed || !affordable) continue
      const total = cost.wood.add(cost.clay).add(cost.iron)
      if (bestTotal === null || total.lt(bestTotal)) {
        bestTotal = total
        bestId = id
      }
    }
    expect(bestId).not.toBe(null)

    const before = { ...v.buildings }
    expect(autoBuildOnce(v, NO_TECH_MODS)).toBe(true)
    for (const id of BUILDING_IDS) {
      expect(v.buildings[id]).toBe(before[id] + (id === bestId ? 1 : 0))
    }
  })

  it('is a no-op (false) when the village cannot afford any building', () => {
    const v = createVillage('v0', 'Stolica') // fresh: 50/50/50, too little for any level
    const anyAffordable = BUILDING_IDS.some((id) => {
      const { affordable, maxed } = nextCostAffordable(v, id, NO_TECH_MODS)
      return affordable && !maxed
    })
    expect(anyAffordable).toBe(false)

    const before = { ...v.buildings }
    expect(autoBuildOnce(v, NO_TECH_MODS)).toBe(false)
    expect(v.buildings).toEqual(before)
  })

  it('is a no-op when every building is already maxed (even with infinite resources)', () => {
    const v = createVillage('v0', 'Stolica')
    for (const id of BUILDING_IDS) v.buildings[id] = BUILDINGS[id].maxLevel
    v.resources = { wood: D(1e9), clay: D(1e9), iron: D(1e9) }
    const before = { ...v.buildings }
    expect(autoBuildOnce(v, NO_TECH_MODS)).toBe(false)
    expect(v.buildings).toEqual(before)
  })

  it('spends the village local resources for the level it builds', () => {
    const v = createVillage('v0', 'Stolica')
    v.resources = { wood: D(1e7), clay: D(1e7), iron: D(1e7) }
    const woodBefore = v.resources.wood
    expect(autoBuildOnce(v, NO_TECH_MODS)).toBe(true)
    // A level was bought -> at least one resource pool dropped.
    const dropped =
      v.resources.wood.lt(woodBefore) ||
      v.resources.clay.lt(D(1e7)) ||
      v.resources.iron.lt(D(1e7))
    expect(dropped).toBe(true)
  })
})

// --- autoRecruitOnce --------------------------------------------------------------

/** A barracks village with deep farm headroom and a large resource pool. */
function recruitVillage(): Village {
  const v = createVillage('v0', 'Stolica')
  v.buildings.barracks = 1
  v.buildings.farm = 10 // popCap = 10 + 12*10 = 130 -> population is not the limit
  recomputeVillageDerived(v)
  v.resources = { wood: D(1e6), clay: D(1e6), iron: D(1e6) }
  return v
}

/** Total of `unit` currently queued for training in `v`. */
function queuedOf(v: Village, unit: string): number {
  return v.recruitQueue.reduce((n, o) => n + (o.unitId === unit ? o.count : 0), 0)
}

function settings(patch: Partial<AutomationSettings>): AutomationSettings {
  return {
    build: false,
    recruit: true,
    attack: false,
    recruitUnit: null,
    recruitTarget: 0,
    ...patch,
  }
}

describe('autoRecruitOnce', () => {
  it('queues exactly the deficit when resources and population allow', () => {
    const v = recruitVillage()
    const s = settings({ recruitUnit: 'spearman', recruitTarget: 5 })
    expect(autoRecruitOnce(v, s, NO_TECH_MODS)).toBe(true)
    expect(queuedOf(v, 'spearman')).toBe(5)
    // Target met counting the queue -> a second call does nothing.
    expect(autoRecruitOnce(v, s, NO_TECH_MODS)).toBe(false)
    expect(queuedOf(v, 'spearman')).toBe(5)
  })

  it('counts BOTH the live roster and the queue toward the target', () => {
    const v = recruitVillage()
    v.units.spearman = 3
    const s = settings({ recruitUnit: 'spearman', recruitTarget: 5 })
    expect(autoRecruitOnce(v, s, NO_TECH_MODS)).toBe(true)
    // only the 2-unit deficit (5 - 3 already owned) is queued.
    expect(queuedOf(v, 'spearman')).toBe(2)
  })

  it('caps the batch at free population', () => {
    const v = createVillage('v0', 'Stolica')
    v.buildings.barracks = 1
    recomputeVillageDerived(v) // farm level 1 -> popCap 22
    v.resources = { wood: D(1e6), clay: D(1e6), iron: D(1e6) }
    const s = settings({ recruitUnit: 'spearman', recruitTarget: 1000 })
    expect(autoRecruitOnce(v, s, NO_TECH_MODS)).toBe(true)
    // popCap 22, spearman pop 1 -> at most 22 queued in one batch.
    expect(queuedOf(v, 'spearman')).toBe(22)
  })

  it('caps the batch at what the village can afford', () => {
    const v = createVillage('v0', 'Stolica')
    v.buildings.barracks = 1
    v.buildings.farm = 10
    recomputeVillageDerived(v) // popCap 130 (not the binding limit)
    v.resources = { wood: D(120), clay: D(1e6), iron: D(1e6) } // spearman wood cost 50
    const s = settings({ recruitUnit: 'spearman', recruitTarget: 1000 })
    expect(autoRecruitOnce(v, s, NO_TECH_MODS)).toBe(true)
    // floor(120 / 50) = 2.
    expect(queuedOf(v, 'spearman')).toBe(2)
  })

  it('is a no-op when no unit is chosen', () => {
    const v = recruitVillage()
    const s = settings({ recruitUnit: null, recruitTarget: 5 })
    expect(autoRecruitOnce(v, s, NO_TECH_MODS)).toBe(false)
    expect(v.recruitQueue).toHaveLength(0)
  })

  it('is a no-op when the target is already met', () => {
    const v = recruitVillage()
    v.units.spearman = 5
    const s = settings({ recruitUnit: 'spearman', recruitTarget: 5 })
    expect(autoRecruitOnce(v, s, NO_TECH_MODS)).toBe(false)
    expect(v.recruitQueue).toHaveLength(0)
  })

  it('is a no-op when the village cannot afford even one unit', () => {
    const v = createVillage('v0', 'Stolica')
    v.buildings.barracks = 1
    recomputeVillageDerived(v)
    v.resources = { wood: D(0), clay: D(0), iron: D(0) }
    const s = settings({ recruitUnit: 'spearman', recruitTarget: 5 })
    expect(canRecruit(v, 'spearman', 1).ok).toBe(false)
    expect(autoRecruitOnce(v, s, NO_TECH_MODS)).toBe(false)
  })

  it('is a no-op when the required building (barracks) is missing', () => {
    const v = createVillage('v0', 'Stolica') // barracks 0
    v.resources = { wood: D(1e6), clay: D(1e6), iron: D(1e6) }
    const s = settings({ recruitUnit: 'spearman', recruitTarget: 5 })
    expect(autoRecruitOnce(v, s, NO_TECH_MODS)).toBe(false)
    expect(v.recruitQueue).toHaveLength(0)
  })
})

// --- autoAttackOnce ---------------------------------------------------------------

/** A fresh run whose capital has barracks (the attack unlock). */
function attackState(seed = 'auto-attack'): GameState {
  const s = createInitialState(seed, 0)
  s.villages.v0.buildings.barracks = 1
  return s
}

/** The nearest WIN-SAFE, canAttack-ok target for `v`'s idle army, or null. */
function nearestBeatable(v: Village, s: GameState): { id: string; level: number } | null {
  const idle = stationedUnits(v)
  idle.noble = 0
  const power = armyAttackPower(idle, NO_TECH_MODS)
  for (const b of targetsByDistance(v, s.world)) {
    const def = barbarianTarget(b.level).defensePower
    if (power < def * WIN_MARGIN) continue
    if (!canAttack(v, b, idle).ok) continue
    return b
  }
  return null
}

describe('autoAttackOnce', () => {
  it('sends the whole idle combat army at the nearest beatable barbarian', () => {
    const s = attackState()
    const v = s.villages.v0
    v.units.axeman = 10 // attack power 400 — clears the nearby low tiers

    const expected = nearestBeatable(v, s)
    expect(expected).not.toBe(null)

    expect(autoAttackOnce(v, s.world, s.battleLog, NO_TECH_MODS)).toBe(true)
    expect(v.marches).toHaveLength(1)
    const m = v.marches[0]
    expect(m.targetId).toBe(expected?.id)
    // the whole idle combat army marched (10 axemen)…
    expect(m.units.axeman).toBe(10)
    // …and NEVER a noble.
    expect(m.units.noble).toBe(0)
  })

  it('NEVER sends nobles, even when present at home', () => {
    const s = attackState()
    const v = s.villages.v0
    v.units.axeman = 10
    v.units.noble = 5
    expect(autoAttackOnce(v, s.world, s.battleLog, NO_TECH_MODS)).toBe(true)
    expect(v.marches[0].units.noble).toBe(0)
    // nobles stayed home (not dispatched, roster untouched).
    expect(stationedUnits(v).noble).toBe(5)
  })

  it('is a no-op when the idle army is too weak for any target', () => {
    const s = attackState()
    const v = s.villages.v0
    v.units.spearman = 1 // power 10 < level-1 defence (30) * 1.25
    expect(autoAttackOnce(v, s.world, s.battleLog, NO_TECH_MODS)).toBe(false)
    expect(v.marches).toHaveLength(0)
  })

  it('is a no-op when there is no army at all', () => {
    const s = attackState()
    const v = s.villages.v0
    expect(autoAttackOnce(v, s.world, s.battleLog, NO_TECH_MODS)).toBe(false)
    expect(v.marches).toHaveLength(0)
  })

  it('is self-limiting: with the army in flight, a second call sends nothing', () => {
    const s = attackState()
    const v = s.villages.v0
    v.units.axeman = 10
    expect(autoAttackOnce(v, s.world, s.battleLog, NO_TECH_MODS)).toBe(true)
    expect(v.marches).toHaveLength(1)
    // the whole idle army is now away -> no idle army -> no second dispatch.
    expect(autoAttackOnce(v, s.world, s.battleLog, NO_TECH_MODS)).toBe(false)
    expect(v.marches).toHaveLength(1)
  })

  it('skips a target that already has a march in flight', () => {
    const s = attackState()
    const v = s.villages.v0
    v.units.axeman = 20

    const nearest = nearestBeatable(v, s)
    expect(nearest).not.toBe(null)

    // Manually march a single axeman at the nearest beatable camp, leaving an idle army.
    expect(
      sendAttack(
        v,
        s.world,
        s.battleLog,
        nearest!.id,
        { spearman: 0, swordsman: 0, axeman: 1, noble: 0, scout: 0 },
        NO_TECH_MODS,
      ),
    ).toBe(true)
    expect(v.marches).toHaveLength(1)

    // Auto-attack must skip the camp that already has a march and pick a different one.
    expect(autoAttackOnce(v, s.world, s.battleLog, NO_TECH_MODS)).toBe(true)
    expect(v.marches).toHaveLength(2)
    expect(v.marches[1].targetId).not.toBe(nearest!.id)
  })

  it('NEVER sends scouts: a scout-only garrison is treated as no combat army (M5.2)', () => {
    const s = attackState()
    const v = s.villages.v0
    v.units.scout = 50 // recon-only: attack 0, so the idle COMBAT army is empty
    expect(autoAttackOnce(v, s.world, s.battleLog, NO_TECH_MODS)).toBe(false)
    expect(v.marches).toHaveLength(0)
    expect(stationedUnits(v).scout).toBe(50) // every scout stayed home
  })

  it('leaves scouts home when it dispatches the combat army (scouts excluded from the stack)', () => {
    const s = attackState()
    const v = s.villages.v0
    v.units.axeman = 10 // a beatable combat army…
    v.units.scout = 8 // …alongside scouts that must NOT be swept into the attack
    expect(autoAttackOnce(v, s.world, s.battleLog, NO_TECH_MODS)).toBe(true)
    expect(v.marches).toHaveLength(1)
    const m = v.marches[0]
    expect(m.kind).toBe('attack')
    expect(m.units.axeman).toBe(10) // the whole combat army marched…
    expect(m.units.scout).toBe(0) // …but no scout was dispatched
    expect(m.units.noble).toBe(0)
    // The scouts (and only the scouts) remain at home, unharmed.
    expect(stationedUnits(v).scout).toBe(8)
  })
})

// --- runAutomation (the unlock AND toggle gate) -----------------------------------

/** A capital where build, recruit AND attack would all act if enabled. */
function automatableState(seed = 'run-auto'): GameState {
  const s = createInitialState(seed, 0)
  const v = s.villages.v0
  v.buildings.barracks = 1
  v.buildings.farm = 10
  recomputeDerived(s)
  v.resources = { wood: D(1e7), clay: D(1e7), iron: D(1e7) }
  v.units.axeman = 10 // gives auto-attack a beatable, idle army
  s.automation = {
    build: true,
    recruit: true,
    attack: true,
    recruitUnit: 'spearman',
    recruitTarget: 10,
  }
  return s
}

describe('runAutomation — unlock AND toggle gating', () => {
  it('fires every routine when each is BOTH unlocked and toggled on', () => {
    const s = automatableState()
    const v = s.villages.v0
    const buildingsBefore = { ...v.buildings }

    runAutomation(s, ALL_UNLOCKED, 1)

    expect(BUILDING_IDS.some((id) => v.buildings[id] > buildingsBefore[id])).toBe(true)
    expect(queuedOf(v, 'spearman')).toBeGreaterThan(0)
    expect(v.marches.length).toBeGreaterThan(0)
  })

  it('does NOTHING when the routines are unlocked but every toggle is OFF', () => {
    const s = automatableState()
    s.automation = {
      build: false,
      recruit: false,
      attack: false,
      recruitUnit: 'spearman',
      recruitTarget: 10,
    }
    const snapshot = serialize(s)
    runAutomation(s, ALL_UNLOCKED, 1)
    expect(serialize(s)).toBe(snapshot)
  })

  it('does NOTHING when the toggles are ON but no routine is unlocked', () => {
    const s = automatableState() // toggles all on
    const snapshot = serialize(s)
    runAutomation(s, NO_TECH_MODS, 1) // gate locked
    expect(serialize(s)).toBe(snapshot)
  })

  it('fires only the individually unlocked-and-enabled routine', () => {
    const s = automatableState()
    s.automation = {
      build: true,
      recruit: false,
      attack: false,
      recruitUnit: 'spearman',
      recruitTarget: 10,
    }
    const mods: TechModifiers = {
      ...NO_TECH_MODS,
      automations: { build: true, recruit: false, attack: false },
    }
    const v = s.villages.v0
    const before = { ...v.buildings }

    runAutomation(s, mods, 1)

    expect(BUILDING_IDS.some((id) => v.buildings[id] > before[id])).toBe(true)
    expect(v.recruitQueue).toHaveLength(0)
    expect(v.marches).toHaveLength(0)
  })

  it('requires BOTH the gate and the toggle: a locked-but-toggled routine stays idle', () => {
    const s = automatableState()
    s.automation = {
      build: true, // toggled on…
      recruit: true,
      attack: false,
      recruitUnit: 'spearman',
      recruitTarget: 10,
    }
    const mods: TechModifiers = {
      ...NO_TECH_MODS,
      automations: { build: false, recruit: true, attack: false }, // …but build LOCKED
    }
    const v = s.villages.v0
    const before = { ...v.buildings }

    runAutomation(s, mods, 1)

    // build locked -> no building changed, despite the toggle being on.
    expect(v.buildings).toEqual(before)
    // recruit unlocked + on -> it ran.
    expect(queuedOf(v, 'spearman')).toBeGreaterThan(0)
  })

  it('is deterministic: two independent runs from the same state stay byte-identical', () => {
    const a = automatableState('det')
    const b = automatableState('det')
    expect(serialize(a)).toBe(serialize(b)) // identical starting points

    for (let i = 0; i < 5; i++) {
      runAutomation(a, ALL_UNLOCKED, 1)
      runAutomation(b, ALL_UNLOCKED, 1)
    }
    expect(serialize(a)).toBe(serialize(b))
  })
})

// --- the unlock gate: aggregateTechMods + effectiveMods OR ------------------------

describe('automation unlock gate (aggregate + combine OR)', () => {
  it('aggregateTechMods flips the matching gate per automation_unlock node', () => {
    expect(aggregateTechMods({}).automations).toEqual({
      build: false,
      recruit: false,
      attack: false,
    })
    expect(aggregateTechMods({ con_automation: 1 }).automations.build).toBe(true)
    expect(aggregateTechMods({ tra_automation: 1 }).automations.recruit).toBe(true)
    expect(aggregateTechMods({ mil_automation: 1 }).automations.attack).toBe(true)
  })

  it('aggregatePrestigeMods never unlocks an automation (prestige does not gate them in v1)', () => {
    expect(aggregatePrestigeMods({}).automations).toEqual({
      build: false,
      recruit: false,
      attack: false,
    })
    // even a purchased prestige node leaves the automation gates locked on the prestige side.
    expect(aggregatePrestigeMods({ prosperity_root: 3 }).automations).toEqual({
      build: false,
      recruit: false,
      attack: false,
    })
  })

  it('effectiveMods ORs the tech gates with the (always-false) prestige gates', () => {
    const s = createInitialState('eff-auto', 0)
    expect(effectiveMods(s).automations).toEqual({
      build: false,
      recruit: false,
      attack: false,
    })

    // unlock build + attack via tech; recruit stays locked.
    s.tech = { con_automation: 1, mil_automation: 1 }
    expect(effectiveMods(s).automations).toEqual({
      build: true,
      recruit: false,
      attack: true,
    })

    // unlock all three.
    s.tech = { con_automation: 1, tra_automation: 1, mil_automation: 1 }
    expect(effectiveMods(s).automations).toEqual({
      build: true,
      recruit: true,
      attack: true,
    })
  })
})
