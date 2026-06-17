import './ui/styles/tokens.css'
import './ui/styles/base.css'
import './ui/styles/layout.css'
// Ruch + mikro-interakcje (M11.3): wczytany PO layout.css, by mógł nadpisywać
// pojedyncze reguły (skrócone przejście paska, docisk karty). Czysto prezentacyjny.
import './ui/styles/motion.css'
// Toasty celebracyjne (M11.6): kontener live-region + karta toasta. Wczytane PO
// layout.css (spełnia wymóg „po layout.css"); czysto prezentacyjne, zero logiki gry.
import './ui/styles/toast.css'

import { createInitialState, GameStore, type GameState, type VillageId } from './engine/state'
import { signal } from './engine/store'
import {
  clearLocal,
  exportSave,
  importSave,
  loadFromLocal,
  saveToLocal,
} from './engine/save'
import { applyOffline } from './engine/offline'
import { GameLoop } from './engine/loop'
import { EventBus, type GameEvents } from './engine/eventbus'
import { build } from './systems/buildings'
import { recruit } from './systems/recruitment'
import { sendAttack, sendScout } from './systems/marches'
import { foundVillage } from './systems/villages'
import { sendShipment, canExchange, exchangeResources } from './systems/market'
import { purchaseTech } from './systems/tech'
import { ascend, effectiveMods, purchasePrestige } from './systems/prestige'
import { newEra, purchaseEra } from './systems/era'
import { newDynasty, purchaseDynasty } from './systems/dynasty'
import { abandonChallenge, startChallenge } from './systems/challenges'
import type { UnitId } from './content/units'
import { mountApp } from './ui/app'
import { mountToasts } from './ui/toast'
import type { UiCtx } from './ui/types'

/**
 * Browser entry point. Boots the persisted (or fresh) state, credits offline
 * progress, starts the fixed-timestep loop and mounts the UI. DOM access is
 * allowed here (this file, like loop.ts and ui/*, is browser-only).
 */

const now = Date.now()

// Boot is fully guarded: a corrupt/shape-incomplete save (or a throwing offline
// catch-up) must never brick the page. On any failure we fall back to a fresh
// run rather than crashing into a blank screen (CLAUDE.md "Nigdy nie psuj zapisow").
let state: GameState
let offlineSeconds = 0
try {
  state = loadFromLocal() ?? createInitialState('barbarus-' + now, now)
  offlineSeconds = applyOffline(state, now)
} catch {
  state = createInitialState('barbarus-' + now, now)
  offlineSeconds = 0
}

const store = new GameStore(state)
const bus = new EventBus<GameEvents>()
const loop = new GameLoop(store, bus)

// Currently selected village. The selector (layout.ts) writes it; panels + HUD read
// the active village as `store.state.villages[activeVillageId.value]`. Seeded to the
// first village in the stable order (always non-empty — the capital `v0`).
const activeVillageId = signal<VillageId>(store.state.villageOrder[0])

const root = document.getElementById('app')
if (!root) throw new Error('#app')

// Nazwany ctx (zamiast literału w wywołaniu): ten SAM obiekt trafia do mountApp
// i do mountToasts — bez tego watcher toastów nie miałby dostępu do store. Adnotacja
// UiCtx zachowuje kontekstowe typowanie nieotypowanych callbacków (onBuild/onFound…).
const ctx: UiCtx = {
  store,
  bus,
  activeVillageId,
  onExport: () => exportSave(store.state),
  onImport: (s) => {
    try {
      const ns = importSave(s)
      Object.assign(store.state, ns)
      // The previously-selected village may not exist in the imported run; fall back
      // to that save's first village so the active selection is always valid.
      if (store.state.villages[activeVillageId.value] === undefined) {
        activeVillageId.value = store.state.villageOrder[0]
      }
      store.commit()
      saveToLocal(store.state)
      return true
    } catch {
      return false
    }
  },
  onReset: () => {
    clearLocal()
    location.reload()
  },
  onBuild: (villageId, id) => {
    // Fold the EFFECTIVE multipliers (tech × prestige) into the post-build recompute so a
    // freshly upgraded building immediately reflects the account-wide + permanent bonuses.
    const ok = build(store.state.villages[villageId], id, effectiveMods(store.state))
    if (ok) {
      store.commit()
      saveToLocal(store.state)
    }
    return ok
  },
  onRecruit: (villageId: VillageId, id: UnitId, count: number) => {
    // Recruit time snapshots the per-unit duration at queue time; fold in the
    // EFFECTIVE recruit-speed bonus (tech × prestige) so the queued ETA reflects it.
    const ok = recruit(
      store.state.villages[villageId],
      id,
      count,
      effectiveMods(store.state),
    )
    if (ok) {
      store.commit()
      saveToLocal(store.state)
    }
    return ok
  },
  onAttack: (villageId: VillageId, targetId: string, units: Record<UnitId, number>) => {
    // March time + combat power for the dispatched army fold in the EFFECTIVE
    // modifiers (tech × prestige): march_speed / attack_mult / loot_mult.
    const ok = sendAttack(
      store.state.villages[villageId],
      store.state.world,
      store.state.battleLog,
      targetId,
      units,
      effectiveMods(store.state),
    )
    if (ok) {
      store.commit()
      saveToLocal(store.state)
    }
    return ok
  },
  onAssaultFortress: (villageId: VillageId, fortressId: string, units: Record<UnitId, number>) => {
    // ASSAULT a fortress (M7): the SAME dispatch path as onAttack, with the trailing
    // targetType set to 'fortress' so sendAttack looks the target up in world.fortresses,
    // gates it via canAttackFortress (rejecting a razed/missing fortress) and snapshots the
    // 'fortress' class onto the march. The army folds in the EFFECTIVE modifiers (march_speed
    // / attack_mult / loot_mult) exactly like a camp attack. Commit + persist only on a send.
    const ok = sendAttack(
      store.state.villages[villageId],
      store.state.world,
      store.state.battleLog,
      fortressId,
      units,
      effectiveMods(store.state),
      'fortress',
    )
    if (ok) {
      store.commit()
      saveToLocal(store.state)
    }
    return ok
  },
  onScout: (villageId: VillageId, targetId: string, scoutCount: number) => {
    // Dispatch a SCOUT march (M5.2): the scouts travel to the camp, flip its
    // `scouted` flag on arrival (revealing defence/loot in the UI), and return
    // unharmed — they never fight or loot. Fold in the EFFECTIVE march-speed bonus
    // so the recon ETA matches an attack's. Commit + persist only on a successful send.
    const ok = sendScout(
      store.state.villages[villageId],
      store.state.world,
      store.state.battleLog,
      targetId,
      scoutCount,
      effectiveMods(store.state),
    )
    if (ok) {
      store.commit()
      saveToLocal(store.state)
    }
    return ok
  },
  onFound: (payerVillageId: VillageId, x: number, y: number) => {
    const id = foundVillage(store.state, payerVillageId, x, y)
    if (id !== null) {
      store.commit()
      saveToLocal(store.state)
    }
    return id
  },
  onTransport: (fromVillageId, toVillageId, cargo) => {
    // Dispatch a MERCHANT shipment (M9 rynek): the cargo leaves the source village
    // immediately (debited and held in transit, occupying its merchant capacity) and is
    // delivered to the destination on arrival (clamped to its storage cap, overflow
    // spilled). sendShipment re-validates via canTransport and no-ops (returns false) when
    // the transport is not sendable; we commit + persist only on a successful send.
    const ok = sendShipment(store.state, fromVillageId, toVillageId, cargo)
    if (ok) {
      store.commit()
      saveToLocal(store.state)
    }
    return ok
  },
  onExchange: (villageId, fromRes, toRes, amount) => {
    // Exchange (M9.2 rynek): convert one resource type into another AT THE SAME village,
    // INSTANTLY, at the market. The input is debited and the floored received amount of the
    // other resource credited (clamped to the storage cap, overflow spilled). The rate is
    // ALWAYS < 1, so the exchange pays a spread and can never mint resources — a benign
    // convenience / surplus sink. We re-validate via canExchange (the panel reads it too for
    // the disabled cue), call exchangeResources (which no-ops when not exchangeable), and
    // commit + persist only on a successful conversion. Player-initiated like onTransport.
    if (!canExchange(store.state, villageId, fromRes, toRes, amount).ok) return false
    const ok = exchangeResources(store.state, villageId, fromRes, toRes, amount)
    if (ok) {
      store.commit()
      saveToLocal(store.state)
    }
    return ok
  },
  onPurchaseTech: (nodeId: string) => {
    // purchaseTech spends from the GLOBAL resource pool and recomputes derived
    // multipliers internally; we only persist + commit on success.
    const ok = purchaseTech(store.state, nodeId)
    if (ok) {
      store.commit()
      saveToLocal(store.state)
    }
    return ok
  },
  onAscend: () => {
    // ascend banks the pending PP and resets the run in place (fresh capital, world
    // regenerated from a per-ascension seed, tech/log cleared, start bonuses applied);
    // the prestige account survives. No-op (returns 0) when there is nothing to bank.
    // The active village may be gone after the reset, so resnap to the new run's first
    // village before committing so the selection stays valid.
    const pp = ascend(store.state)
    if (pp > 0) {
      if (store.state.villages[activeVillageId.value] === undefined) {
        activeVillageId.value = store.state.villageOrder[0]
      }
      store.commit()
      saveToLocal(store.state)
    }
    return pp
  },
  onPurchasePrestige: (nodeId: string) => {
    // purchasePrestige spends banked PP and recomputes derived multipliers internally
    // (the new permanent bonus folds into every village); persist + commit on success.
    const ok = purchasePrestige(store.state, nodeId)
    if (ok) {
      store.commit()
      saveToLocal(store.state)
    }
    return ok
  },
  onNewEra: () => {
    // newEra (M6.1) banks the pending EP and performs the GREAT RESET in place: it WIPES
    // the ENTIRE prestige account (PP, prestige nodes, ascensions) and rebuilds the run
    // from a per-era seed (fresh capital, world regenerated, tech/log cleared, era start
    // bonus applied); the era account + lifetime stats/achievements survive. No-op
    // (returns 0) when there is nothing to bank. The active village is gone after the
    // reset, so resnap to the new run's first village before committing so the selection
    // stays valid (mirrors onAscend).
    const ep = newEra(store.state)
    if (ep > 0) {
      if (store.state.villages[activeVillageId.value] === undefined) {
        activeVillageId.value = store.state.villageOrder[0]
      }
      store.commit()
      saveToLocal(store.state)
    }
    return ep
  },
  onPurchaseEra: (nodeId: string) => {
    // purchaseEra spends banked EP and recomputes derived multipliers internally (the new
    // permanent bonus folds into every village); persist + commit on success.
    const ok = purchaseEra(store.state, nodeId)
    if (ok) {
      store.commit()
      saveToLocal(store.state)
    }
    return ok
  },
  onNewDynasty: () => {
    // newDynasty (M6.2) banks the pending DP and performs the GREAT-GREAT RESET in place: it
    // WIPES the ENTIRE era account (EP, era nodes, eras) AND the ENTIRE prestige account (PP,
    // prestige nodes, ascensions) and rebuilds the run from a per-dynasty seed (fresh capital,
    // world regenerated, tech/log cleared, dynasty start bonus applied); the dynasty account +
    // lifetime stats/achievements survive. No-op (returns 0) when there is nothing to bank.
    // The active village is gone after the reset, so resnap to the new run's first village
    // before committing so the selection stays valid (mirrors onNewEra).
    const dp = newDynasty(store.state)
    if (dp > 0) {
      if (store.state.villages[activeVillageId.value] === undefined) {
        activeVillageId.value = store.state.villageOrder[0]
      }
      store.commit()
      saveToLocal(store.state)
    }
    return dp
  },
  onPurchaseDynasty: (nodeId: string) => {
    // purchaseDynasty spends banked DP and recomputes derived multipliers internally (the new
    // permanent bonus folds into every village); persist + commit on success.
    const ok = purchaseDynasty(store.state, nodeId)
    if (ok) {
      store.commit()
      saveToLocal(store.state)
    }
    return ok
  },
  onStartChallenge: (id: string) => {
    // startChallenge RESETS the run (fresh capital, world regenerated from a per-challenge
    // seed, tech/battle log cleared, horde re-armed) and turns the constraint on; the META
    // accounts (prestige/era/dynasty) + lifetime stats/achievements survive. The active
    // village is gone after the reset, so resnap to the new run's first village before
    // committing so the selection stays valid (mirrors onAscend). No-op (returns false) when
    // a challenge is already active or the id is unknown.
    const ok = startChallenge(store.state, id)
    if (ok) {
      if (store.state.villages[activeVillageId.value] === undefined) {
        activeVillageId.value = store.state.villageOrder[0]
      }
      store.commit()
      saveToLocal(store.state)
    }
    return ok
  },
  onAbandonChallenge: () => {
    // End the active challenge with NO reward: clear the constraint and let the run continue
    // unconstrained (no reset). A no-op when no challenge is active. Persist + commit so the
    // dropped constraint is reflected immediately.
    abandonChallenge(store.state)
    store.commit()
    saveToLocal(store.state)
  },
  onSetAutomation: (patch) => {
    // Merge the partial toggle/policy patch into state.automation, then commit +
    // persist. No recompute: the automation settings are read directly each sub-step
    // by runAutomation (systems/automation.ts), not folded into derived stats.
    Object.assign(store.state.automation, patch)
    store.commit()
    saveToLocal(store.state)
  },
  version: '0.33.0',
  offlineSeconds,
}

mountApp(root, ctx)
// M11.6: watcher kamieni milowych + kontener toastów. Raz na sesję; subskrybuje
// store.rev jak puls raportów (M11.3) i odpala gratulacyjny toast TYLKO na realny
// wzrost licznika (read-only ze stanu). Disposer zwracany dla symetrii — sesja go nie woła.
mountToasts(ctx)

loop.start()

// Periodic autosave + heartbeat for any save-driven UI.
setInterval(() => {
  saveToLocal(store.state)
  bus.emit('save', { manual: false })
}, 15000)

// Flush on hide; on re-show, credit the time the tab spent hidden (rAF was
// paused) before the loop resumes, then resync the loop so the next frame does
// not also reprocess that gap.
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    saveToLocal(store.state)
  } else {
    applyOffline(store.state, Date.now())
    loop.resync()
    store.commit()
  }
})
window.addEventListener('beforeunload', () => saveToLocal(store.state))
