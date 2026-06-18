import { describe, it, expect } from 'vitest'
import {
  createInitialState,
  NO_TECH_MODS,
  type GameState,
  type TechModifiers,
} from '../src/engine/state'
import {
  MAX_PALADIN_LEVEL,
  XP_BASE,
  XP_EXP,
  AURA_PER_LEVEL,
  XP_PER_SQRT_DEFENSE,
  PALADIN_ABILITY,
  xpForLevel,
  paladinAuraMult,
  xpFromBattle,
} from '../src/content/paladin'
import {
  paladinUnlocked,
  paladinLevel,
  gainPaladinXp,
  paladinMods,
  canActivateAbility,
  activateAbility,
  advancePaladin,
} from '../src/systems/paladin'
import { effectiveMods, ascend, pendingPrestigePoints } from '../src/systems/prestige'
import {
  serialize,
  deserialize,
  exportSave,
  importSave,
  migrate,
  validateState,
  SAVE_VERSION,
} from '../src/engine/save'

/**
 * M16 PALADYN tests (content/paladin.ts + systems/paladin.ts + the effectiveMods fold + the
 * v25->v26 save step). The paladin is the FIRST hero that grows DIRECTLY from the PvE loop: it
 * earns XP from WON battles, levels up, radiates a scaling AURA (a GLOBAL attack+defence
 * multiplier), and fires the game's FIRST player-triggered, cooldown-gated ABILITY. These prove
 * the contracts the design leans on:
 *  (1) the curve/aura/ability data are PURE + finite (xpForLevel rising integer, paladinAuraMult
 *      identity at level 0, xpFromBattle deterministic);
 *  (2) gainPaladinXp promotes on the cumulative threshold, caps at MAX_PALADIN_LEVEL and is a
 *      strict NO-OP without a Pałac (so the main run never mutates state.paladin — byte-identity);
 *  (3) paladinMods is the IDENTITY bag (byte-equal NO_TECH_MODS) with no Palace / level 0 / no
 *      buff, and overlays the aura (and the active-ability surge) otherwise;
 *  (4) canActivateAbility / activateAbility gate + arm the cooldown, and advancePaladin burns the
 *      timers on the tick grid (signalling expiry) while being inert without a Palace;
 *  (5) effectiveMods reflects the aura by EXACTLY paladinAuraMult and is untouched without a Palace;
 *  (6) the v25->v26 migration backfills the zero paladin + counter + building key and validateState
 *      rejects a corrupt level/xp/timer; and
 *  (7) a state carrying a live paladin survives serialize/deserialize + export/import, the run is
 *      deterministic, and an ascend resets the paladin (per-run progress) to zero.
 */

/** NO_TECH_MODS with selected fields overridden — a terse way to build an expected bag. */
function bagWith(partial: Partial<TechModifiers>): TechModifiers {
  return { ...NO_TECH_MODS, ...partial }
}

/** A fresh capital with a Pałac paladyna built (the unlock gate ON) at `palaceLevel`. */
function capitalWithPaladin(palaceLevel = 1, seed = 'paladin'): GameState {
  const s = createInitialState(seed, 0)
  s.villages.v0.buildings.paladin = palaceLevel
  return s
}

describe('paladin catalogue — pure, finite curve + aura + battle XP', () => {
  it('xpForLevel is 0 at level 0, a strictly rising non-negative INTEGER, matching the formula', () => {
    // Level 0 (and any <= 0 / NaN defensively) is the start — no XP required.
    expect(xpForLevel(0)).toBe(0)
    expect(xpForLevel(-3)).toBe(0)
    expect(xpForLevel(Number.NaN)).toBe(0)

    let prev = xpForLevel(0)
    for (let lvl = 1; lvl <= MAX_PALADIN_LEVEL; lvl++) {
      const want = Math.round(XP_BASE * Math.pow(lvl, XP_EXP))
      expect(xpForLevel(lvl)).toBe(want)
      expect(Number.isInteger(xpForLevel(lvl))).toBe(true)
      // Strictly rising: each level costs progressively more wins.
      expect(xpForLevel(lvl)).toBeGreaterThan(prev)
      prev = xpForLevel(lvl)
    }
    // Concrete pins for the provisional knobs (round(120 * level^2)).
    expect(xpForLevel(1)).toBe(120)
    expect(xpForLevel(10)).toBe(12000)
  })

  it('paladinAuraMult is EXACTLY 1.0 at level 0 (identity), adding AURA_PER_LEVEL each level', () => {
    // Level 0 — and any <= 0 / NaN defensively — is the identity, which is what keeps paladinMods
    // byte-identical to NO_TECH_MODS while the paladin has not yet levelled.
    expect(paladinAuraMult(0)).toBe(1)
    expect(paladinAuraMult(-2)).toBe(1)
    expect(paladinAuraMult(Number.NaN)).toBe(1)
    for (let lvl = 1; lvl <= MAX_PALADIN_LEVEL; lvl++) {
      expect(paladinAuraMult(lvl)).toBeCloseTo(1 + lvl * AURA_PER_LEVEL, 12)
    }
    // The documented +3% / level → a maxed paladin is +30% attack/defence.
    expect(AURA_PER_LEVEL).toBeCloseTo(0.03, 12)
    expect(paladinAuraMult(MAX_PALADIN_LEVEL)).toBeCloseTo(1.3, 12)
  })

  it('xpFromBattle is deterministic, SUBLINEAR (sqrt) in defeated defence, >= 1 for a win, 0 otherwise', () => {
    expect(xpFromBattle(0)).toBe(0)
    expect(xpFromBattle(-50)).toBe(0)
    // A near-zero positive win still trains the paladin a little (clamped to >= 1, where the
    // sqrt term rounds below 1).
    expect(xpFromBattle(0.001)).toBe(1)
    // sqrt-scaled by XP_PER_SQRT_DEFENSE: round(k * sqrt(defence)).
    expect(xpFromBattle(1000)).toBe(Math.max(1, Math.round(XP_PER_SQRT_DEFENSE * Math.sqrt(1000))))
    expect(xpFromBattle(1000)).toBe(253)
    // SUBLINEAR: QUADRUPLING the wall only DOUBLES the XP (sqrt(4) = 2) — the geometric camp
    // ladder can never outrun the finite XP ladder, so every tier needs many wins.
    expect(xpFromBattle(4000)).toBe(2 * xpFromBattle(1000))
    // Pure: identical inputs give identical outputs (no RNG, no clock).
    expect(xpFromBattle(777)).toBe(xpFromBattle(777))
  })

  it('the active ability is a short, strong, cooldown-gated attack surge touching only attack', () => {
    expect(PALADIN_ABILITY.durationSecs).toBeGreaterThan(0)
    // A burst is much shorter than its lock (a timed window, not an always-on bonus).
    expect(PALADIN_ABILITY.cooldownSecs).toBeGreaterThan(PALADIN_ABILITY.durationSecs)
    expect(PALADIN_ABILITY.minLevel).toBeGreaterThanOrEqual(1)
    // v1 overlays ONLY the in-flight attack axis (a strong multiplier > 1).
    expect(Object.keys(PALADIN_ABILITY.mods)).toEqual(['attackMult'])
    expect(PALADIN_ABILITY.mods.attackMult).toBeGreaterThan(1)
  })
})

describe('gainPaladinXp — promotes on the cumulative threshold, caps, and is inert without a Palace', () => {
  it('promotes as far as the accrued XP clears and bumps the lifetime counter', () => {
    const s = capitalWithPaladin()
    expect(paladinLevel(s)).toBe(0)
    // xpForLevel(3) = 1080 clears the level 1/2/3 thresholds (120/480/1080) but not 4 (1920).
    gainPaladinXp(s, xpForLevel(3))
    expect(s.paladin.level).toBe(3)
    expect(paladinLevel(s)).toBe(3)
    expect(s.stats.paladinLevelUps).toBe(3)
    expect(s.paladin.xp).toBe(xpForLevel(3))
  })

  it('caps at MAX_PALADIN_LEVEL however much XP is poured in', () => {
    const s = capitalWithPaladin()
    gainPaladinXp(s, xpForLevel(MAX_PALADIN_LEVEL) * 100)
    expect(s.paladin.level).toBe(MAX_PALADIN_LEVEL)
    expect(s.stats.paladinLevelUps).toBe(MAX_PALADIN_LEVEL)
    // More XP past the ceiling accrues but never promotes again (level + counter frozen).
    gainPaladinXp(s, xpForLevel(MAX_PALADIN_LEVEL) * 100)
    expect(s.paladin.level).toBe(MAX_PALADIN_LEVEL)
    expect(s.stats.paladinLevelUps).toBe(MAX_PALADIN_LEVEL)
  })

  it('ignores a non-finite / non-positive amount (no movement)', () => {
    const s = capitalWithPaladin()
    const snap = serialize(s)
    gainPaladinXp(s, 0)
    gainPaladinXp(s, -100)
    gainPaladinXp(s, Number.NaN)
    gainPaladinXp(s, Number.POSITIVE_INFINITY)
    expect(serialize(s)).toBe(snap)
  })

  it('is a strict NO-OP without a Pałac (byte-identical — the main-run identity gate)', () => {
    const s = createInitialState('no-palace', 0)
    expect(paladinUnlocked(s)).toBe(false)
    const before = serialize(s)
    gainPaladinXp(s, 999_999)
    expect(s.paladin).toEqual({ xp: 0, level: 0, abilityRemaining: 0, cooldownRemaining: 0 })
    expect(s.stats.paladinLevelUps).toBe(0)
    expect(serialize(s)).toBe(before)
  })
})

describe('paladinMods — identity gate + aura + ability overlay', () => {
  it('returns a FRESH identity bag (no aliasing of NO_TECH_MODS) without a Palace', () => {
    const s = createInitialState('no-palace', 0)
    expect(paladinUnlocked(s)).toBe(false)
    const bag = paladinMods(s)
    expect(bag).toEqual(NO_TECH_MODS)
    // Mutating the result must never bleed into the shared constant or a later call.
    bag.attackMult = 99
    bag.productionMult.wood = 99
    bag.automations.build = true
    expect(NO_TECH_MODS.attackMult).toBe(1)
    expect(NO_TECH_MODS.productionMult.wood).toBe(1)
    expect(NO_TECH_MODS.automations.build).toBe(false)
    expect(paladinMods(s)).toEqual(NO_TECH_MODS)
  })

  it('is identity with a Palace but level 0 and no active ability', () => {
    const s = capitalWithPaladin()
    expect(paladinUnlocked(s)).toBe(true)
    expect(s.paladin.level).toBe(0)
    expect(s.paladin.abilityRemaining).toBe(0)
    expect(paladinMods(s)).toEqual(NO_TECH_MODS)
  })

  it('lays the aura on attack AND defence by exactly paladinAuraMult(level)', () => {
    for (const lvl of [1, 3, 7, MAX_PALADIN_LEVEL]) {
      const s = capitalWithPaladin()
      s.paladin.level = lvl
      const bag = paladinMods(s)
      const aura = paladinAuraMult(lvl)
      // attackMult/defenseMult are computed by the SAME expression, so exact equality holds.
      expect(bag.attackMult).toBe(aura)
      expect(bag.defenseMult).toBe(aura)
      // The rest of the bag stays identity (no other axis is touched by the aura).
      expect(bag).toEqual(bagWith({ attackMult: aura, defenseMult: aura }))
    }
  })

  it('MULTIPLIES the active-ability surge onto the aura (attack only) while it runs', () => {
    const s = capitalWithPaladin()
    s.paladin.level = 3
    s.paladin.abilityRemaining = 30 // ability in flight
    const aura = paladinAuraMult(3)
    const surge = PALADIN_ABILITY.mods.attackMult!
    const bag = paladinMods(s)
    // attack = aura × surge; defence = bare aura (the ability touches only attackMult).
    expect(bag.attackMult).toBe(aura * surge)
    expect(bag.defenseMult).toBe(aura)
    expect(bag).toEqual(bagWith({ attackMult: aura * surge, defenseMult: aura }))
  })
})

describe('canActivateAbility / activateAbility — the player action + cooldown lock', () => {
  it('is false without a Palace, and below the ability minLevel', () => {
    const noPalace = createInitialState('no-palace', 0)
    noPalace.paladin.level = 5
    expect(canActivateAbility(noPalace)).toBe(false)

    const tooLow = capitalWithPaladin()
    expect(tooLow.paladin.level).toBeLessThan(PALADIN_ABILITY.minLevel)
    expect(canActivateAbility(tooLow)).toBe(false)
  })

  it('arms the buff + the cooldown and returns true when ready', () => {
    const s = capitalWithPaladin()
    s.paladin.level = PALADIN_ABILITY.minLevel
    expect(canActivateAbility(s)).toBe(true)

    expect(activateAbility(s)).toBe(true)
    expect(s.paladin.abilityRemaining).toBe(PALADIN_ABILITY.durationSecs)
    expect(s.paladin.cooldownRemaining).toBe(PALADIN_ABILITY.cooldownSecs)
  })

  it('is a no-op (false) while already active or on cooldown', () => {
    // Already active.
    const active = capitalWithPaladin()
    active.paladin.level = 2
    active.paladin.abilityRemaining = 10
    expect(canActivateAbility(active)).toBe(false)
    const snapA = serialize(active)
    expect(activateAbility(active)).toBe(false)
    expect(serialize(active)).toBe(snapA)

    // On cooldown (not active).
    const cooling = capitalWithPaladin()
    cooling.paladin.level = 2
    cooling.paladin.cooldownRemaining = 120
    expect(canActivateAbility(cooling)).toBe(false)
    const snapC = serialize(cooling)
    expect(activateAbility(cooling)).toBe(false)
    expect(serialize(cooling)).toBe(snapC)
  })

  it('is a no-op (false) without a Palace, leaving the paladin untouched', () => {
    const s = createInitialState('no-palace', 0)
    s.paladin.level = 5
    const before = serialize(s)
    expect(activateAbility(s)).toBe(false)
    expect(serialize(s)).toBe(before)
  })
})

describe('advancePaladin — burns the timers on the tick grid', () => {
  it('counts the cooldown down toward ready (clamped at 0) and returns false', () => {
    const s = capitalWithPaladin()
    s.paladin.level = 2
    s.paladin.cooldownRemaining = 100
    expect(advancePaladin(s, 30)).toBe(false)
    expect(s.paladin.cooldownRemaining).toBe(70)
    // Overshoot clamps to exactly 0 (never negative).
    expect(advancePaladin(s, 999)).toBe(false)
    expect(s.paladin.cooldownRemaining).toBe(0)
  })

  it('burns the active buff down and returns TRUE (the re-aggregation signal) on expiry', () => {
    const s = capitalWithPaladin()
    s.paladin.level = 2
    s.paladin.abilityRemaining = 50
    s.paladin.cooldownRemaining = 200
    // Still alive: decremented, no expiry signal.
    expect(advancePaladin(s, 20)).toBe(false)
    expect(s.paladin.abilityRemaining).toBe(30)
    expect(s.paladin.cooldownRemaining).toBe(180)
    // Expires (overshoot to <= 0): cleared to exactly 0 and signalled.
    expect(advancePaladin(s, 40)).toBe(true)
    expect(s.paladin.abilityRemaining).toBe(0)
    // Once cleared a further advance neither re-signals nor revives it.
    expect(advancePaladin(s, 10)).toBe(false)
    expect(s.paladin.abilityRemaining).toBe(0)
  })

  it('is a pure NO-OP without a Palace (no timer move, returns false — byte-identity)', () => {
    const s = createInitialState('no-palace', 0)
    // Even with (defensively) set timers, the gate freezes everything.
    s.paladin.abilityRemaining = 50
    s.paladin.cooldownRemaining = 100
    const before = serialize(s)
    expect(advancePaladin(s, 30)).toBe(false)
    expect(serialize(s)).toBe(before)
  })
})

describe('effectiveMods — folds the paladin aura as the 7th source', () => {
  it('is unchanged by a not-unlocked paladin (the bag folds to identity)', () => {
    const s = createInitialState('eff', 0)
    const before = effectiveMods(s)
    // gainPaladinXp is gated, so a no-Palace state never levels and the bag stays identity.
    gainPaladinXp(s, 999_999)
    expect(s.paladin.level).toBe(0)
    expect(paladinMods(s)).toEqual(NO_TECH_MODS)
    expect(effectiveMods(s)).toEqual(before)
  })

  it('lifts attack AND defence by EXACTLY the aura once the paladin is unlocked & levelled', () => {
    const s = createInitialState('eff2', 0)
    const before = effectiveMods(s)
    s.villages.v0.buildings.paladin = 1
    s.paladin.level = 4
    const aura = paladinAuraMult(4)
    const during = effectiveMods(s)
    expect(during.attackMult).toBeCloseTo(before.attackMult * aura, 10)
    expect(during.defenseMult).toBeCloseTo(before.defenseMult * aura, 10)
    expect(during.attackMult).toBeGreaterThan(before.attackMult)
    expect(during.defenseMult).toBeGreaterThan(before.defenseMult)
  })

  it('stacks the active-ability surge onto the aura in effectiveMods, reverting on expiry', () => {
    const s = capitalWithPaladin()
    s.paladin.level = 4
    const auraOnly = effectiveMods(s).attackMult
    s.paladin.abilityRemaining = 30
    const surge = PALADIN_ABILITY.mods.attackMult!
    expect(effectiveMods(s).attackMult).toBeCloseTo(auraOnly * surge, 10)
    // Burn it down past its life; attack falls back to the bare aura.
    expect(advancePaladin(s, 30)).toBe(true)
    expect(effectiveMods(s).attackMult).toBeCloseTo(auraOnly, 10)
  })
})

/**
 * A v25-shaped raw save (pre-paladin). Built by serialising a real current-version state and
 * DOWNGRADING it: drop the `paladin` state, the `stats.paladinLevelUps` counter and the `paladin`
 * building key off every village, then stamp version 25. Tracking the live shape this way keeps
 * the fixture from drifting; deserialize hands back real Decimals.
 */
function rawV25(seed = 'paladin-v25'): Record<string, any> {
  const fresh = createInitialState(seed, 4242)
  const raw = deserialize(serialize(fresh)) as unknown as Record<string, any>
  delete raw.paladin
  delete raw.stats.paladinLevelUps
  for (const id of raw.villageOrder) {
    delete raw.villages[id].buildings.paladin
  }
  raw.version = 25
  return raw
}

describe('paladin save — v25 -> v26 migration backfill (M16)', () => {
  it('backfills the zero paladin, paladinLevelUps 0 and paladin:0 on every village, then validates', () => {
    const raw = rawV25()
    // Precondition: the v25 save genuinely lacks all three new bits.
    expect('paladin' in raw).toBe(false)
    expect('paladinLevelUps' in raw.stats).toBe(false)
    expect('paladin' in raw.villages.v0.buildings).toBe(false)

    const m = migrate(raw)
    expect(m.version).toBe(26)
    expect(m.version).toBe(SAVE_VERSION)

    expect(m.paladin).toEqual({ xp: 0, level: 0, abilityRemaining: 0, cooldownRemaining: 0 })
    expect(m.stats.paladinLevelUps).toBe(0)
    expect(m.villages.v0.buildings.paladin).toBe(0)

    // And the whole migrated save validates.
    expect(validateState(m).version).toBe(SAVE_VERSION)
  })

  it('preserves a paladin state + counter a forward-compat v25 save already carries', () => {
    const raw = rawV25()
    raw.paladin = { xp: 500, level: 2, abilityRemaining: 10, cooldownRemaining: 100 }
    raw.stats.paladinLevelUps = 2

    const m = migrate(raw)
    expect(m.paladin).toEqual({ xp: 500, level: 2, abilityRemaining: 10, cooldownRemaining: 100 })
    expect(m.stats.paladinLevelUps).toBe(2)
    expect(validateState(m).version).toBe(SAVE_VERSION)
  })

  it('importSave of a v25 export migrates to v26 and validates', () => {
    const restored = importSave(exportSave(rawV25() as never))
    expect(restored.version).toBe(SAVE_VERSION)
    expect(restored.paladin).toEqual({ xp: 0, level: 0, abilityRemaining: 0, cooldownRemaining: 0 })
    expect(restored.stats.paladinLevelUps).toBe(0)
    expect(restored.villages.v0.buildings.paladin).toBe(0)
  })
})

describe('paladin save — validateState rejects a corrupt paladin', () => {
  it('rejects an out-of-band / fractional level', () => {
    const high = createInitialState('bad', 0) as unknown as Record<string, any>
    high.paladin.level = MAX_PALADIN_LEVEL + 1
    expect(() => validateState(high)).toThrow(/paladin level/)

    const neg = createInitialState('bad', 0) as unknown as Record<string, any>
    neg.paladin.level = -1
    expect(() => validateState(neg)).toThrow(/paladin level/)

    const frac = createInitialState('bad', 0) as unknown as Record<string, any>
    frac.paladin.level = 1.5
    expect(() => validateState(frac)).toThrow(/paladin level/)
  })

  it('rejects a negative / non-finite xp', () => {
    const neg = createInitialState('bad', 0) as unknown as Record<string, any>
    neg.paladin.xp = -1
    expect(() => validateState(neg)).toThrow(/paladin xp/)

    const nan = createInitialState('bad', 0) as unknown as Record<string, any>
    nan.paladin.xp = Number.NaN
    expect(() => validateState(nan)).toThrow(/paladin xp/)
  })

  it('rejects a negative / non-finite ability or cooldown timer', () => {
    const ability = createInitialState('bad', 0) as unknown as Record<string, any>
    ability.paladin.abilityRemaining = -5
    expect(() => validateState(ability)).toThrow(/paladin abilityRemaining/)

    const cooldown = createInitialState('bad', 0) as unknown as Record<string, any>
    cooldown.paladin.cooldownRemaining = Number.POSITIVE_INFINITY
    expect(() => validateState(cooldown)).toThrow(/paladin cooldownRemaining/)
  })

  it('rejects a missing paladin object', () => {
    const s = createInitialState('bad', 0) as unknown as Record<string, any>
    delete s.paladin
    expect(() => validateState(s)).toThrow(/paladin/)
  })

  it('accepts a well-formed paladin (level within band, finite non-negative xp/timers)', () => {
    const s = createInitialState('ok', 0)
    s.paladin = { xp: 1080, level: 3, abilityRemaining: 12.5, cooldownRemaining: 300 }
    s.stats.paladinLevelUps = 3
    expect(validateState(s)).toBe(s)
  })
})

/**
 * A current-version state carrying a LIVE paladin: a built Pałac, a levelled hero mid-XP, an
 * active ability and a running cooldown, plus a non-zero lifetime counter. Built fresh per test so
 * mutations never leak between cases.
 */
function paladinState(seed = 'paladin-rt'): GameState {
  const s = createInitialState(seed, 1717)
  s.villages.v0.buildings.paladin = 4
  s.paladin = { xp: 1500, level: 3, abilityRemaining: 42, cooldownRemaining: 480 }
  s.stats.paladinLevelUps = 3
  return s
}

describe('paladin save — round-trip with a live paladin', () => {
  it('serialize/deserialize preserves the paladin state, building level and the counter', () => {
    const s = paladinState()
    const json = serialize(s)
    const back = deserialize(json)

    expect(back.version).toBe(SAVE_VERSION)
    expect(back.paladin).toEqual(s.paladin)
    expect(back.villages.v0.buildings.paladin).toBe(4)
    expect(back.stats.paladinLevelUps).toBe(3)
    // serialize is idempotent across the round-trip (stable key order).
    expect(serialize(back)).toBe(json)
  })

  it('exportSave/importSave preserves the live paladin byte-identically and validates', () => {
    const s = paladinState()
    const restored = importSave(exportSave(s))

    expect(restored.paladin).toEqual(s.paladin)
    expect(restored.stats.paladinLevelUps).toBe(3)
    // Byte-identical: the Pałac's defense_bonus is not a serialized derived field.
    expect(serialize(restored)).toBe(serialize(s))
    expect(validateState(restored)).toBe(restored)
  })
})

describe('paladin determinism + reset on ascend', () => {
  it('the same seed + same actions is byte-identical (deterministic, RNG-free)', () => {
    const run = (): GameState => {
      const s = capitalWithPaladin(4, 'paladin-det')
      gainPaladinXp(s, xpForLevel(2))
      activateAbility(s)
      advancePaladin(s, 15)
      gainPaladinXp(s, xpForLevel(5))
      return s
    }
    expect(serialize(run())).toBe(serialize(run()))
  })

  it('ascend resets the per-run paladin to zero while the lifetime counter survives', () => {
    const s = capitalWithPaladin(4, 'paladin-ascend')
    s.paladin = { xp: 1500, level: 3, abilityRemaining: 30, cooldownRemaining: 200 }
    s.stats.paladinLevelUps = 3
    // A fresh capital already banks pending PP, so the ascend genuinely fires.
    expect(pendingPrestigePoints(s)).toBeGreaterThan(0)

    ascend(s)

    // The paladin is per-run progress (gated by the per-run Pałac the reset rebuilds at level 0),
    // so it clears to the pristine zero state; the lifetime trophy counter persists.
    expect(s.paladin).toEqual({ xp: 0, level: 0, abilityRemaining: 0, cooldownRemaining: 0 })
    expect(paladinUnlocked(s)).toBe(false)
    expect(s.stats.paladinLevelUps).toBe(3)
    // The reset state is fully valid and immediately playable.
    expect(validateState(s)).toBe(s)
  })
})
