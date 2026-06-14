import './ui/styles/tokens.css'
import './ui/styles/base.css'

import { createInitialState, GameStore, type GameState } from './engine/state'
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
import type { UnitId } from './content/units'
import { mountApp } from './ui/app'

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

const root = document.getElementById('app')
if (!root) throw new Error('#app')

mountApp(root, {
  store,
  bus,
  onExport: () => exportSave(store.state),
  onImport: (s) => {
    try {
      const ns = importSave(s)
      Object.assign(store.state, ns)
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
  onBuild: (id) => {
    const ok = build(store.state, id)
    if (ok) {
      store.commit()
      saveToLocal(store.state)
    }
    return ok
  },
  onRecruit: (id: UnitId, count: number) => {
    const ok = recruit(store.state, id, count)
    if (ok) {
      store.commit()
      saveToLocal(store.state)
    }
    return ok
  },
  version: '0.3.0',
  offlineSeconds,
})

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
