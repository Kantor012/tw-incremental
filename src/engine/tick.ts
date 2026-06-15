import type { GameState, TechModifiers } from './state'
import { RESOURCE_IDS } from './state'
import { isFiniteDecimal } from './decimal'
import { RNG } from './rng'
import { advanceRecruitment } from '../systems/recruitment'
import { advanceMarches } from '../systems/marches'
import { advanceRaids } from '../systems/raids'
import { applyConquest, advanceWorldLoyalty } from '../systems/conquest'
import { effectiveMods } from '../systems/prestige'
import { runAutomation } from '../systems/automation'
import { checkAchievements } from '../systems/achievements'

/**
 * Fixed simulation step shared by the live loop and offline catch-up: 20 ticks
 * per second. Kept here (the low-level sim module) so loop.ts and offline.ts can
 * advance in identical steps without importing the browser-only loop.
 */
export const TICK_RATE = 1 / 20

/**
 * One fixed sub-step of length `dt` (TICK_RATE, or a final sub-tick remainder).
 *
 * Since M2.1 the run is multi-village, so a sub-step is one pass over EVERY village
 * in {@link GameState.villageOrder}; per village it runs production → recruitment →
 * marches → raids in that fixed order. The iteration order is `villageOrder` (never
 * `Object.keys`, whose order is not guaranteed across engines/saves), so the whole
 * multi-village step is a pure function of state — the determinism the offline /
 * combat invariants assert. Each village owns its OWN economy (resources,
 * production, storageCap, …); the only shared structures are the GLOBAL battle log
 * (threaded explicitly into the combat advancers) and, since M2.4, the GLOBAL
 * {@link World} (`state.world`): marches read it to resolve targets and erode a
 * conquered camp's loyalty.
 *
 * Conquest (M2.4) is a TWO-PHASE step so a capture mutates the world exactly once,
 * never under the iterator: each {@link advanceMarches} RETURNS the captures its
 * village earned this sub-step; they are collected and applied via
 * {@link applyConquest} AFTER the village loop (a capture pushes onto `villages` /
 * `villageOrder`, which must not happen mid-iteration). Finally
 * {@link advanceWorldLoyalty} regenerates every surviving camp's loyalty ONCE per
 * sub-step — not per village — so balance and replay never depend on how many player
 * villages exist. Both the collection order (villageOrder, then push order) and the
 * single regen call keep the whole thing deterministic.
 *
 * EVERYTHING advances here for each village, not just the step-sensitive subsystems,
 * because combat (marches deliver loot, raids steal resources) READS AND WRITES the
 * same resource pool that production fills and the storage cap clamps. Once two
 * systems touch resources, the order in which production and combat interleave across
 * a span affects the clamped result — so production can no longer be a single
 * up-front `rate*dt` step (that would let a big `simulate(N)` clamp differently from
 * N small online steps). Sub-stepping production on the SAME grid as combat makes
 * every span decompose into one identical ordered list of sub-steps regardless of how
 * `dt` is sliced, which is exactly what keeps online / offline / sim byte-identical.
 * (Linear production summed over the grid still equals `rate*dt` exactly on Decimal —
 * the existing production tests hold.)
 */
function subStep(state: GameState, dt: number, mods: TechModifiers): void {
  // Combat LUCK (M5.5): seed ONE RNG from the persisted `rngState` at the start of the
  // sub-step and thread that SAME instance through every village's combat (marches then
  // raids, in villageOrder). Each RESOLVED attack / fired raid draws exactly one luckFactor
  // from it, so over the whole sub-step the draws form one fixed-order stream. Because the
  // sub-step itself runs on the fixed TICK_RATE grid (so the set and order of battles that
  // resolve is invariant to how `dt` is sliced), `rngState` evolves byte-identically online
  // / offline / sim. It is written back to `state.rngState` at the END of the sub-step
  // (after the only draws, which all happen inside the village loop below — runAutomation
  // plans against WORST_LUCK, a constant, and never draws), so the next sub-step resumes
  // the exact stream. World generation uses a SEPARATE seeded stream and never touches this.
  const rng = new RNG(state.rngState)
  // Captures (a surviving noble drove a target's loyalty to 0) are gathered across the
  // whole village loop and applied AFTER it — never mid-iteration, where minting a new
  // player village would resize villageOrder under the loop. Typed off advanceMarches'
  // return so this stays decoupled from where ConquestEvent is declared.
  const conquests: ReturnType<typeof advanceMarches> = []
  // The EFFECTIVE modifiers (tech × prestige) are a pure function of the GLOBAL tech +
  // prestige ledgers, which NO sub-step mutates (production / recruitment / marches /
  // raids / conquest / automation never touch state.tech or state.prestige.nodes), so
  // they are constant for the whole `simulate` span. `mods` is therefore aggregated ONCE
  // by the caller (simulate) and threaded in — same value every sub-step, byte-identical
  // regardless of how `dt` is sliced, and the per-substep effectiveMods roll-up (a scan
  // of all tech + prestige nodes) is kept off the hot loop. Threaded into the combat
  // advancers (marches/raids) where attack/defense/march-speed/loot multipliers apply;
  // recruitment is intentionally NOT passed mods — it snapshots its per-unit duration
  // (incl. the recruit-speed fraction) at queue time, so reading mods again mid-flight
  // would double-apply.
  for (const id of state.villageOrder) {
    const v = state.villages[id]
    for (const r of RESOURCE_IDS) {
      const rate = v.production[r]
      // A corrupt non-finite production rate must not poison resources.
      if (!isFiniteDecimal(rate)) continue
      let next = v.resources[r].add(rate.mul(dt))
      if (next.gt(v.storageCap)) next = v.storageCap
      v.resources[r] = next
    }
    // Each is a no-op when its subsystem is idle (empty queue / no marches / village
    // not yet worth raiding), so the steady state stays cheap. The global battle log
    // is passed explicitly so combat from any village appends to the one shared feed;
    // the global world is passed so marches resolve targets and erode loyalty. Marches
    // return any captures earned this step — deferred to after the loop.
    advanceRecruitment(v, dt)
    // `state.stats` is threaded in (M5.4) so the combat advancers bump the lifetime
    // counters on this exact deterministic path — identical online/offline/sim, never
    // from the UI. They mutate it in place (attacks won/lost, loot hauled, camps razed,
    // scouts returned / raids repelled-lost); see advanceMarches / advanceRaids.
    conquests.push(...advanceMarches(v, state.world, state.battleLog, dt, mods, state.stats, rng))
    advanceRaids(v, state.battleLog, dt, mods, state.stats, rng)
  }
  // Apply captures once, in deterministic collection order. applyConquest no-ops on a
  // barbId already removed this sub-step (two armies both flooring the same target), so
  // duplicate events are harmless. A newly minted village is appended to villageOrder
  // here, so it first produces/advances on the NEXT sub-step (it isn't in this loop).
  for (const ev of conquests) applyConquest(state, ev.barbId, ev.attackerVillageId)
  // Loyalty regenerates exactly ONCE per sub-step (not per village), after captures so a
  // just-taken camp (already off world.barbarians) never regenerates.
  advanceWorldLoyalty(state.world, dt)
  // Automation (M5.1) runs LAST, after the world has fully settled this sub-step
  // (captures applied + barbarians removed by applyConquest, loyalty regenerated): so
  // auto-attack never targets a camp that was floored-and-removed this very step, and
  // every action reads a consistent world. It reuses the SAME `mods` aggregated once
  // above — no second effectiveMods read — keeping the step a pure function of state, so
  // online / offline / sim stay byte-identical with automation ON. Each per-village
  // action is gated by mods.automations[kind] (the tech unlock) AND state.automation[kind]
  // (the user toggle), and is self-limiting (resources / pop / a march already in flight),
  // so there is no inner loop here. Auto-attack pushes onto v.marches, which advanceMarches
  // resolves on FUTURE sub-steps — it deliberately does not feed into this step's already
  // collected `conquests`, so it can't collide with the capture phase above.
  runAutomation(state, mods, dt)
  // Achievements (M5.4) are evaluated LAST in the sub-step, after every subsystem has
  // already bumped this step's lifetime counters (state.stats, threaded into the combat
  // advancers above and into applyConquest / foundVillage) AND the world has fully settled
  // (captures applied, loyalty regenerated, automation run). checkAchievements is a pure,
  // deterministic pass over (state, state.stats) that stamps any newly satisfied
  // achievement once and never clears it — so unlocks fire byte-identically online /
  // offline / sim, exactly like the counters they read, and NEVER from the UI. In v1 an
  // achievement is a pure distinction (no gameplay bonus), so this pass can't feed back
  // into the economy and the 17 balance goals stay untouched. The returned list of newly
  // unlocked ids is unused here (the UI reads state.achievements reactively after commit).
  checkAchievements(state)
  // M5.5: persist the advanced luck stream so the next sub-step resumes exactly where this
  // one left off. All draws happened inside the village loop above (one per resolved attack
  // / fired raid); nothing after it draws, so `rng.getState()` captures the whole sub-step's
  // consumption. Stored as a uint32 (getState masks), serialized as part of the save —
  // identical online / offline / sim because the sub-step grid makes the draw sequence
  // invariant to the `dt` split.
  state.rngState = rng.getState()
}

/**
 * Advance the whole simulation by `dtSeconds` of game time, mutating `state`.
 *
 * Pure (no I/O, no DOM, no clock reads, no nondeterministic RNG: combat luck since M5.5
 * draws only from the persisted, seeded `state.rngState` — see {@link subStep} — never
 * from Math.random/the clock) and Node-safe so the same code path runs in the browser
 * loop, offline catch-up and the headless sim harness. The span
 * is decomposed onto the fixed TICK_RATE grid (floor(dt/TICK_RATE) whole sub-steps +
 * one remainder) and {@link subStep} runs production, recruitment, marches and raids
 * together for every village each sub-step. Because applyOffline drives the SAME grid
 * (it calls simulate(TICK_RATE) repeatedly), `simulate(big)` and the chunked offline
 * path resolve to an identical ordered list of sub-steps — the guarantee the offline
 * / combat determinism invariants assert.
 */
export function simulate(state: GameState, dtSeconds: number): void {
  // Reject zero, negative AND NaN (NaN <= 0 is false, and Decimal.add(NaN) === 0,
  // so a NaN dt would silently wipe every resource — see offline boot path).
  if (!(dtSeconds > 0)) return

  // Aggregate the effective tech × prestige modifiers ONCE for the whole span: the ledger
  // they fold is immutable across sub-steps (see subStep), so every sub-step of this call
  // sees the identical bag. This collapses the per-substep effectiveMods scan (all tech +
  // prestige nodes) to one roll-up per simulate() call. The live loop / offline catch-up
  // call simulate(TICK_RATE) (one sub-step) so they are unaffected; only big-`dt` callers
  // (sim harness) shed the redundant scans — and because the value is identical either way,
  // online (one big step) and offline (many TICK_RATE steps) stay byte-identical.
  const mods = effectiveMods(state)
  const fullSteps = Math.floor(dtSeconds / TICK_RATE)
  for (let i = 0; i < fullSteps; i++) subStep(state, TICK_RATE, mods)
  const remainder = dtSeconds - fullSteps * TICK_RATE
  if (remainder > 0) subStep(state, remainder, mods)
}
