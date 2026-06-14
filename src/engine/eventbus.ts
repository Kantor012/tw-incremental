/**
 * Tiny typed publish/subscribe bus for loose coupling between systems.
 * Systems emit domain events; UI and other systems subscribe without hard refs.
 */
export type Listener<T> = (payload: T) => void

export class EventBus<Events extends Record<string, unknown>> {
  private map = new Map<keyof Events, Set<Listener<unknown>>>()

  on<K extends keyof Events>(event: K, listener: Listener<Events[K]>): () => void {
    let set = this.map.get(event)
    if (!set) {
      set = new Set()
      this.map.set(event, set)
    }
    set.add(listener as Listener<unknown>)
    return () => this.off(event, listener)
  }

  once<K extends keyof Events>(event: K, listener: Listener<Events[K]>): () => void {
    const off = this.on(event, (payload) => {
      off()
      listener(payload)
    })
    return off
  }

  off<K extends keyof Events>(event: K, listener: Listener<Events[K]>): void {
    this.map.get(event)?.delete(listener as Listener<unknown>)
  }

  emit<K extends keyof Events>(event: K, payload: Events[K]): void {
    const set = this.map.get(event)
    if (!set) return
    for (const listener of [...set]) (listener as Listener<Events[K]>)(payload)
  }

  clear(): void {
    this.map.clear()
  }
}

/** Engine-level events. Systems extend their own maps as needed. */
export interface GameEvents extends Record<string, unknown> {
  tick: { dt: number; now: number }
  save: { manual: boolean }
  load: { offlineSeconds: number }
  reset: undefined
  'resource:capped': { id: string }
}

/** Shared bus instance type used across the app. */
export type GameBus = EventBus<GameEvents>
