import { simulate, TICK_RATE } from './tick'
import { applyOffline } from './offline'
import type { GameStore } from './state'
import type { GameBus } from './eventbus'

/**
 * Frame gap (seconds) above which we assume the tab was backgrounded (rAF is
 * paused while hidden) and credit the elapsed wall-clock time through the
 * offline path instead of trying to replay it live. This both bounds the live
 * step loop and stops idle progress being silently discarded on tab return.
 */
const MAX_FRAME_GAP = 1

/** Safety bound on live steps processed in a single frame. */
const MAX_FRAME_STEPS = 2000

/**
 * Browser-only fixed-timestep driver (uses requestAnimationFrame and
 * performance.now). Real time is split into fixed `tickRate` steps so the
 * simulation is frame-rate independent and deterministic; leftover time is
 * carried in an accumulator. A large frame gap is routed to the offline catch-up
 * path so backgrounded time is credited (not lost). Engine/sim code must use
 * `simulate` directly.
 */
export class GameLoop {
  /** Fixed simulation step: 20 ticks per second. */
  readonly tickRate = TICK_RATE

  private store: GameStore
  private bus: GameBus
  private running = false
  private rafId = 0
  private last = 0
  private acc = 0

  constructor(store: GameStore, bus: GameBus) {
    this.store = store
    this.bus = bus
  }

  start(): void {
    if (this.running) return
    this.running = true
    this.last = performance.now()
    this.acc = 0
    this.rafId = requestAnimationFrame(this.frame)
  }

  stop(): void {
    if (!this.running) return
    this.running = false
    cancelAnimationFrame(this.rafId)
  }

  /**
   * Re-anchor the loop's clock after time was credited outside a frame (e.g.
   * offline catch-up run on tab focus), so the resuming frame doesn't reprocess
   * the same gap.
   */
  resync(): void {
    this.last = performance.now()
    this.acc = 0
  }

  private frame = (t: number): void => {
    const dt = (t - this.last) / 1000
    this.last = t

    if (dt > MAX_FRAME_GAP) {
      // Large gap => the tab was backgrounded (rAF paused). Credit the elapsed
      // wall-clock time through the offline path (chunked, identical to live
      // stepping) instead of discarding all but a clamped sliver.
      applyOffline(this.store.state, Date.now())
      this.acc = 0
    } else {
      this.acc += dt
      let steps = 0
      while (this.acc >= this.tickRate && steps < MAX_FRAME_STEPS) {
        simulate(this.store.state, this.tickRate)
        this.acc -= this.tickRate
        steps++
      }
      this.store.state.lastSeen = Date.now()
    }

    this.store.commit()
    this.bus.emit('tick', { dt, now: t })

    if (this.running) this.rafId = requestAnimationFrame(this.frame)
  }
}
