import { NO_TECH_MODS, type GameState, type TechModifiers } from '../engine/state'
import {
  MAX_PALADIN_LEVEL,
  PALADIN_ABILITY,
  paladinAuraMult,
  xpForLevel,
} from '../content/paladin'

/**
 * Paladin system (M16 PALADYN) — the engine side of the FIRST hero that grows DIRECTLY from
 * the PvE loop: it earns XP from WON attacks, levels up, radiates a scaling AURA (a global
 * attack+defence multiplier), and can fire a player-triggered, cooldown-gated ABILITY.
 *
 * The Pałac paladyna building (content/buildings.paladin, autoBuildable:false) is the GATE:
 * once any village has one, the paladin unlocks. Its level/aura/XP/timers live on
 * {@link GameState.paladin}; the aura's combat effect folds into effectiveMods via
 * {@link paladinMods} (a global multiplier, like a tree bag — NOT a per-unit one), and XP
 * accretion happens at battle RESOLUTION (gated on {@link paladinUnlocked}).
 *
 * IDENTITY guarantee: with no Palace {@link paladinUnlocked} is false, so {@link paladinMods}
 * returns a fresh identity bag (`combine(x, identity) === x` byte-for-byte), {@link advancePaladin}
 * is a pure no-op (no timer move), and the XP-accretion call sites short-circuit — so the main
 * run never mutates `state.paladin` and stays BYTE-IDENTICAL to pre-M16. The sim bot / auto-build
 * never build autoBuildable:false buildings, so the main balance run never gates the paladin in.
 *
 * Determinism: the paladin is PURELY DETERMINISTIC — XP, levels, aura and the cooldown draw NO
 * RNG and read NO clock. {@link activateAbility} is a PLAYER action (like claimEvent / upgradeUnit),
 * never the tick; {@link advancePaladin} runs on the fixed TICK_RATE sub-step grid so online /
 * offline / sim stay byte-identical.
 *
 * Import discipline: depends only on the GameState/TechModifiers TYPES + the NO_TECH_MODS value
 * (engine/state) and the pure paladin data leaf (content/paladin). It does NOT import
 * systems/prestige (which imports {@link paladinMods} from HERE), mirroring how systems/events.ts
 * is imported by prestige without a cycle — every cross-module value is used only inside a function
 * body, so the benign state.ts <-> prestige.ts edge is never widened.
 */

/** Whether ANY village has a Pałac paladyna at level >= 1 — the unlock gate for the whole hero. */
export function paladinUnlocked(state: GameState): boolean {
  for (const id of state.villageOrder) {
    if ((state.villages[id]?.buildings.paladin ?? 0) >= 1) return true
  }
  return false
}

/** Current paladin level (0 when not yet promoted / not unlocked). */
export function paladinLevel(state: GameState): number {
  return state.paladin.level
}

/**
 * A FRESH identity {@link TechModifiers} bag — a DEEP copy of {@link NO_TECH_MODS} (its nested
 * `productionMult` / `automations` cloned so the caller never aliases the shared constant). It is
 * exactly the neutral element of `combine` (multipliers 1, fractions 0, automations all false), so
 * `combine(x, identityBag()) === x` byte-for-byte — the basis of the M16 byte-identity guarantee
 * (mirrors systems/events.ts identityBag).
 */
function identityBag(): TechModifiers {
  return {
    productionMult: { ...NO_TECH_MODS.productionMult },
    storageMult: NO_TECH_MODS.storageMult,
    popMult: NO_TECH_MODS.popMult,
    costReduction: NO_TECH_MODS.costReduction,
    recruitSpeedFrac: NO_TECH_MODS.recruitSpeedFrac,
    marchSpeedFrac: NO_TECH_MODS.marchSpeedFrac,
    attackMult: NO_TECH_MODS.attackMult,
    defenseMult: NO_TECH_MODS.defenseMult,
    lootMult: NO_TECH_MODS.lootMult,
    automations: { ...NO_TECH_MODS.automations },
  }
}

/**
 * Grant `amount` battle XP to the paladin and promote it as far as the XP allows. NO-OP unless
 * {@link paladinUnlocked} (so the main run never mutates `state.paladin` — byte-identity) and
 * `amount` is a finite positive number. Each promotion bumps `state.paladin.level` (capped at
 * {@link MAX_PALADIN_LEVEL}) and the lifetime `stats.paladinLevelUps` counter. Deterministic,
 * RNG-free; called at battle RESOLUTION (see systems/marches.advanceMarches).
 */
export function gainPaladinXp(state: GameState, amount: number): void {
  if (!paladinUnlocked(state)) return // GATE — no Palace → no mutation → byte-identical
  if (!Number.isFinite(amount) || amount <= 0) return
  const p = state.paladin
  p.xp += amount
  // Promote while the accumulated XP clears the next level's cumulative threshold and we are
  // below the finite ceiling. A pure integer loop — deterministic, order-independent.
  while (p.level < MAX_PALADIN_LEVEL && p.xp >= xpForLevel(p.level + 1)) {
    p.level += 1
    state.stats.paladinLevelUps += 1
  }
}

/**
 * Roll up the paladin's contribution into a {@link TechModifiers} bag for {@link import('./prestige').effectiveMods}'s
 * combine fold — the SEVENTH and final source, layered after tech × prestige × era × dynasty ×
 * challenge × event-buff.
 *
 * Returns the IDENTITY bag (so `combine(x, …)` is a byte-identical no-op) whenever there is
 * nothing to apply: no Palace (the gate), OR level 0 with no active ability. Otherwise it starts
 * from a fresh identity bag, lays the AURA on attack AND defence (`paladinAuraMult(level)`), and —
 * while the active ability is running (`abilityRemaining > 0`) — MULTIPLIES the ability's mods on
 * top (so the surge stacks onto the aura). v1 the ability touches only `attackMult`, but the merge
 * stays general so a future ability can touch any in-flight axis. Pure, no RNG, no clock.
 *
 * BYTE-IDENTITY: at aura = 1.0 (level 0) AND no active ability, the bag is exactly
 * {@link NO_TECH_MODS}, so a no-Palace / not-yet-levelled paladin folds to the pre-M16 value.
 */
export function paladinMods(state: GameState): TechModifiers {
  const bag = identityBag()
  if (!paladinUnlocked(state)) return bag // GATE — identity, byte-identical to pre-M16
  const p = state.paladin
  const abilityActive = p.abilityRemaining > 0
  if (p.level === 0 && !abilityActive) return bag // nothing to apply yet — identity
  // AURA: one factor on attack AND defence. At level 0 this is 1.0 (identity), which only
  // happens here when the ability is active at level 0 (canActivateAbility blocks that, so it
  // is purely defensive); for level >= 1 it is the real bonus.
  const aura = paladinAuraMult(p.level)
  bag.attackMult = aura
  bag.defenseMult = aura
  if (abilityActive) {
    // ACTIVE ability: MULTIPLY its multiplier axes onto the aura, ADD its fraction axes. v1
    // sets only attackMult, but the overlay stays general (mirrors aggregateEventBuffMods, but
    // multiplicative so the surge stacks onto the aura rather than replacing it).
    const m = PALADIN_ABILITY.mods
    if (m.productionMult) {
      for (const r of ['wood', 'clay', 'iron'] as const) {
        if (m.productionMult[r] !== undefined) bag.productionMult[r] *= m.productionMult[r]
      }
    }
    if (m.storageMult !== undefined) bag.storageMult *= m.storageMult
    if (m.popMult !== undefined) bag.popMult *= m.popMult
    if (m.attackMult !== undefined) bag.attackMult *= m.attackMult
    if (m.defenseMult !== undefined) bag.defenseMult *= m.defenseMult
    if (m.lootMult !== undefined) bag.lootMult *= m.lootMult
    if (m.costReduction !== undefined) bag.costReduction += m.costReduction
    if (m.recruitSpeedFrac !== undefined) bag.recruitSpeedFrac += m.recruitSpeedFrac
    if (m.marchSpeedFrac !== undefined) bag.marchSpeedFrac += m.marchSpeedFrac
    if (m.automations) bag.automations = { ...bag.automations, ...m.automations }
  }
  return bag
}

/**
 * Whether the paladin's ACTIVE ability can be fired RIGHT NOW: the Palace stands, the paladin has
 * reached the ability's `minLevel`, the cooldown is up (`cooldownRemaining <= 0`) and it is not
 * already running (`abilityRemaining <= 0`). Pure read — the UI uses it for the disabled cue;
 * {@link activateAbility} is the commit, not the validation.
 */
export function canActivateAbility(state: GameState): boolean {
  if (!paladinUnlocked(state)) return false
  const p = state.paladin
  if (p.level < PALADIN_ABILITY.minLevel) return false
  if (p.cooldownRemaining > 0) return false
  if (p.abilityRemaining > 0) return false
  return true
}

/**
 * PLAYER ACTION (M16): fire the paladin's active ability. No-op returning false when
 * {@link canActivateAbility} rejects (no Palace / too low level / on cooldown / already active);
 * otherwise arms the buff (`abilityRemaining = durationSecs`) and the lock
 * (`cooldownRemaining = cooldownSecs`), returning true. Called from the UI callback, NOT the tick —
 * draws no RNG, reads no clock. No derived-stat change (the ability's effect is read on demand at
 * combat resolution via paladinMods), so no recompute is needed.
 */
export function activateAbility(state: GameState): boolean {
  if (!canActivateAbility(state)) return false
  const p = state.paladin
  p.abilityRemaining = PALADIN_ABILITY.durationSecs
  p.cooldownRemaining = PALADIN_ABILITY.cooldownSecs
  return true
}

/**
 * Advance the paladin's ability timers by `dt` seconds on the fixed tick grid. RETURNS whether the
 * active ability EXPIRED in this call — the signal the tick uses to re-aggregate the threaded
 * `mods` so the surge's in-flight attack multiplier falls back to the bare aura byte-identically
 * (mirrors the M14 buff-expiry signal). The IDENTITY gate comes first: with no Palace this is a
 * pure no-op (no timer change), returning false, so the main run is byte-identical to pre-M16.
 *
 * The cooldown always burns down (toward "ready"); the active buff burns down only while running,
 * and on expiry its slot is cleared to 0 and `true` returned. Deterministic, no RNG, no clock.
 */
export function advancePaladin(state: GameState, dt: number): boolean {
  if (!paladinUnlocked(state)) return false // GATE — byte-identity (no timer move)
  const p = state.paladin
  if (p.cooldownRemaining > 0) {
    p.cooldownRemaining -= dt
    if (p.cooldownRemaining < 0) p.cooldownRemaining = 0
  }
  let abilityExpired = false
  if (p.abilityRemaining > 0) {
    p.abilityRemaining -= dt
    if (p.abilityRemaining <= 0) {
      p.abilityRemaining = 0
      abilityExpired = true
    }
  }
  return abilityExpired
}
