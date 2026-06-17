import { describe, it, expect } from 'vitest'
import { createInitialState, type GameState, type BattleReport } from '../src/engine/state'
import { D } from '../src/engine/decimal'
import { tabVisible } from '../src/ui/tab-visibility'

/**
 * M12.2 — PROGRESSIVE DISCLOSURE. {@link tabVisible} is a PURE, read-only predicate
 * over {@link GameState}: each sidebar tab appears only once the player reaches the
 * game stage that makes it relevant. These tests pin the milestone's hard contract:
 *  - a FRESH run shows only the early tabs (buildings + save), with the late/meta tabs
 *    still hidden — a calmer onboarding;
 *  - buildings + save are NEVER hidden (the no-softlock invariant), for fresh AND for
 *    any mutated state;
 *  - reaching a stage REVEALS the matching tab (barracks -> army + map, a battle ->
 *    reports, a market -> market, growth past the tech threshold -> tech + codex);
 *  - an unknown id fails OPEN (true) so a future tab never silently disappears.
 *
 * Every state is built by mutating a fresh {@link createInitialState} copy with the
 * REAL field shapes, so the tests track the actual save schema (v22) and stay
 * deterministic (the seed + a fixed `now`, no Date.now / Math.random).
 */

/** A fresh, deterministic run (fixed seed + epoch) — the early-game baseline. */
function fresh(): GameState {
  return createInitialState('tab-visibility-seed', 0)
}

/** The capital village ('v0') of a state — the one every fresh run owns. */
function capital(s: GameState) {
  return s.villages[s.villageOrder[0]]
}

/** The late/meta tabs that a fresh run must keep hidden (the onboarding contract). */
const LATE_TABS = [
  'prestige',
  'era',
  'dynasty',
  'automation',
  'challenges',
  'reports',
] as const

describe('tabVisible — fresh run (progressive disclosure baseline)', () => {
  it('keeps the core loop + safety net (buildings, save) visible', () => {
    const s = fresh()
    expect(tabVisible('buildings', s)).toBe(true)
    expect(tabVisible('save', s)).toBe(true)
  })

  it('hides every late/meta tab', () => {
    const s = fresh()
    for (const id of LATE_TABS) {
      expect(tabVisible(id, s), `expected '${id}' hidden on a fresh run`).toBe(false)
    }
  })

  it('confirms the gate inputs for the hidden meta tabs are below threshold', () => {
    // Sanity on the derivation, not just the booleans: a fresh run has banked no
    // prestige/era/dynasty progress, so the meta ladder cannot be open yet.
    const s = fresh()
    expect(s.prestige.ascensions).toBe(0)
    expect(s.era.eras).toBe(0)
    expect(s.dynasty.dynasties).toBe(0)
    expect(s.challenge.activeId).toBeNull()
    expect(Object.keys(s.challenge.completed).length).toBe(0)
    expect(s.battleLog.length).toBe(0)
  })
})

describe('tabVisible — no-softlock invariant (buildings + save never hidden)', () => {
  it('shows buildings + save on a fresh run', () => {
    const s = fresh()
    expect(tabVisible('buildings', s)).toBe(true)
    expect(tabVisible('save', s)).toBe(true)
  })

  it('shows buildings + save on a heavily mutated state', () => {
    const s = fresh()
    // Drive many unrelated gates open at once — the no-softlock tabs must be immune.
    const v = capital(s)
    v.buildings.barracks = 5
    v.buildings.market = 3
    v.buildings.warehouse = 10
    v.units.spearman = 50
    s.prestige.ascensions = 7
    s.prestige.totalEarned = 99
    s.era.eras = 4
    s.dynasty.dynasties = 2
    s.challenge.activeId = 'some-challenge'
    s.challenge.completed = { foo: 1 }
    s.stats.attacksWon = 12
    s.battleLog.push({
      kind: 'raid',
      villageId: v.id,
      won: false,
      looted: '0',
      losses: 3,
    })
    expect(tabVisible('buildings', s)).toBe(true)
    expect(tabVisible('save', s)).toBe(true)
  })

  it('shows buildings + save across several independently mutated states', () => {
    // A small matrix of mutators: whatever else changes, the two anchor tabs hold.
    const mutators: Array<(s: GameState) => void> = [
      () => {},
      (s) => {
        capital(s).buildings.barracks = 1
      },
      (s) => {
        s.prestige.ascensions = 3
      },
      (s) => {
        s.battleLog.push({ kind: 'attack', villageId: 'v0', targetLevel: 1, won: true, lootSum: '0', losses: 0 })
      },
      (s) => {
        capital(s).buildings.warehouse = 20
      },
    ]
    for (const mutate of mutators) {
      const s = fresh()
      mutate(s)
      expect(tabVisible('buildings', s)).toBe(true)
      expect(tabVisible('save', s)).toBe(true)
    }
  })
})

describe('tabVisible — revealing transitions (reach a stage, get the tab)', () => {
  it('reveals army + map once a village owns a barracks', () => {
    const s = fresh()
    // Hidden before the player builds anything military.
    expect(tabVisible('army', s)).toBe(false)
    expect(tabVisible('map', s)).toBe(false)

    capital(s).buildings.barracks = 1
    expect(tabVisible('army', s)).toBe(true)
    expect(tabVisible('map', s)).toBe(true)
  })

  it('reveals reports once a battle is logged', () => {
    const s = fresh()
    expect(tabVisible('reports', s)).toBe(false)

    s.battleLog.push({
      kind: 'attack',
      villageId: 'v0',
      targetLevel: 1,
      won: true,
      lootSum: '0',
      losses: 0,
    } satisfies BattleReport)
    expect(tabVisible('reports', s)).toBe(true)
  })

  it('reveals reports once a battle stat is recorded', () => {
    const s = fresh()
    expect(tabVisible('reports', s)).toBe(false)

    s.stats.attacksWon = 1
    expect(tabVisible('reports', s)).toBe(true)
  })

  it('reveals market once a village owns a market building', () => {
    const s = fresh()
    expect(tabVisible('market', s)).toBe(false)

    capital(s).buildings.market = 1
    expect(tabVisible('market', s)).toBe(true)
  })

  it('reveals tech once building levels pass the >= 9 economy gate', () => {
    const s = fresh()
    // A fresh capital holds 6 building levels — below the >= 9 disclosure gate.
    expect(tabVisible('tech', s)).toBe(false)

    // Bump warehouse 1 -> 4 (total building levels 6 -> 9) to cross the gate.
    capital(s).buildings.warehouse = 4
    expect(tabVisible('tech', s)).toBe(true)
  })
})

describe('tabVisible — villages (monotonic founding-readiness, no affordability flicker)', () => {
  it('hides villages on a fresh run', () => {
    expect(tabVisible('villages', fresh())).toBe(false)
  })

  it('does NOT reveal villages from a transient resource spike (the anti-flicker fix)', () => {
    const s = fresh()
    // Pile resources well past the 3000/3000/2000 founding cost: visibility must NOT
    // depend on the live balance (which oscillates every tick), so the tab stays hidden.
    const v = capital(s)
    v.resources.wood = D(99999)
    v.resources.clay = D(99999)
    v.resources.iron = D(99999)
    expect(tabVisible('villages', s)).toBe(false)
  })

  it('reveals villages once the building economy reaches the founding-ready threshold (20)', () => {
    const s = fresh()
    // Fresh total is 6 (warehouse 1); warehouse 1 -> 15 lifts the sum to 20.
    capital(s).buildings.warehouse = 15
    expect(tabVisible('villages', s)).toBe(true)
  })

  it('keeps villages visible via the lifetime founding stat (survives every reset)', () => {
    const s = fresh()
    s.stats.villagesFounded = 1
    expect(tabVisible('villages', s)).toBe(true)
  })

  it('reveals villages once a second village exists', () => {
    const s = fresh()
    s.villageOrder.push('v1')
    expect(tabVisible('villages', s)).toBe(true)
  })
})

describe('tabVisible — automation reads the raw unlock nodes (the one re-locking tab)', () => {
  it('hides automation with no unlock node owned', () => {
    expect(tabVisible('automation', fresh())).toBe(false)
  })

  it('reveals automation once a tech automation gateway is owned', () => {
    const s = fresh()
    s.tech['con_automation'] = 1
    expect(tabVisible('automation', s)).toBe(true)
  })

  it('reveals automation once the dynasty sovereignty gateway is owned', () => {
    const s = fresh()
    s.dynasty.nodes['sovereignty_automation'] = 1
    expect(tabVisible('automation', s)).toBe(true)
  })

  it('re-locks automation when the tech gateway resets (e.g. an ascension wipes tech)', () => {
    const s = fresh()
    s.tech['con_automation'] = 1
    expect(tabVisible('automation', s)).toBe(true)
    s.tech = {} // ascend() clears tech
    expect(tabVisible('automation', s)).toBe(false)
  })
})

describe('tabVisible — era reveals only after real prestige depth', () => {
  it('stays hidden one ascension in (the old over-eager >= 2 gate)', () => {
    const s = fresh()
    // After the FIRST ascension eraScore = ascensions*10 = 10 -> cbrt 10 ~ 2.15 -> 2.
    // The old gate (>= 2) revealed era here; the raised gate (>= 4) must keep it hidden.
    s.prestige.ascensions = 1
    expect(tabVisible('era', s)).toBe(false)
  })

  it('reveals era once prestige depth crosses the cbrt-64 gate', () => {
    const s = fresh()
    // eraScore = totalEarned(20) + ascensions(6)*10 = 80 -> cbrt 80 ~ 4.3 -> 4 >= 4.
    s.prestige.ascensions = 6
    s.prestige.totalEarned = 20
    expect(tabVisible('era', s)).toBe(true)
  })

  it('keeps era visible forever once an era has been performed', () => {
    const s = fresh()
    s.era.eras = 1
    expect(tabVisible('era', s)).toBe(true)
  })
})

describe('tabVisible — codex reveals once there is a story (not at 3 upgrades)', () => {
  it('stays hidden at the tech-early 9-level mark (nothing to show yet)', () => {
    const s = fresh()
    capital(s).buildings.warehouse = 4 // total 9 — enough for tech, NOT for codex
    expect(tabVisible('tech', s)).toBe(true)
    expect(tabVisible('codex', s)).toBe(false)
  })

  it('reveals codex once a battle has been fought', () => {
    const s = fresh()
    expect(tabVisible('codex', s)).toBe(false)
    s.stats.attacksWon = 1
    expect(tabVisible('codex', s)).toBe(true)
  })

  it('reveals codex once building levels reach the foundations threshold (25)', () => {
    const s = fresh()
    capital(s).buildings.warehouse = 20 // total 25
    expect(tabVisible('codex', s)).toBe(true)
  })
})

describe('tabVisible — meta tabs survive an era/dynasty reset (monotonic, not re-locking)', () => {
  it('keeps prestige/tech/codex visible right after a Nowa Era despite a wiped prestige account', () => {
    // newEra() zeroes prestige + rebuilds a fresh 6-level capital, but banks era.eras.
    const s = fresh()
    s.era.eras = 1
    s.prestige.ascensions = 0
    s.prestige.totalEarned = 0
    expect(tabVisible('prestige', s)).toBe(true)
    expect(tabVisible('tech', s)).toBe(true)
    expect(tabVisible('codex', s)).toBe(true)
  })

  it('keeps tech/codex visible after a dynasty even with a fresh economy', () => {
    const s = fresh()
    s.dynasty.dynasties = 1
    expect(tabVisible('tech', s)).toBe(true)
    expect(tabVisible('codex', s)).toBe(true)
  })
})

describe('tabVisible — unknown id fails open', () => {
  it('returns true for an unrecognised tab id (safe default)', () => {
    expect(tabVisible('totally-unknown-id', fresh())).toBe(true)
  })
})
