/**
 * Minimal fine-grained reactive core (signals/effects). No framework — full
 * control over how the tick and the tree view re-render.
 *
 * - `signal(v)`     holds a value; reading inside an effect tracks a dependency.
 * - `effect(fn)`    runs fn, re-runs when any signal it read changes.
 * - `computed(fn)`  memoized derived signal.
 * - `batch(fn)`     coalesces notifications (the game loop commits once/frame).
 */

interface ReactiveEffect {
  run: () => void
  deps: Set<Set<ReactiveEffect>>
}

let activeEffect: ReactiveEffect | null = null
let batchDepth = 0
const pending = new Set<ReactiveEffect>()

function schedule(effect: ReactiveEffect): void {
  if (batchDepth > 0) pending.add(effect)
  else effect.run()
}

export function batch(fn: () => void): void {
  batchDepth++
  try {
    fn()
  } finally {
    batchDepth--
    if (batchDepth === 0) {
      const list = [...pending]
      pending.clear()
      for (const effect of list) effect.run()
    }
  }
}

export class Signal<T> {
  private subs = new Set<ReactiveEffect>()

  constructor(
    private _value: T,
    private eq: (a: T, b: T) => boolean = Object.is,
  ) {}

  get value(): T {
    if (activeEffect) {
      this.subs.add(activeEffect)
      activeEffect.deps.add(this.subs)
    }
    return this._value
  }

  set value(next: T) {
    if (this.eq(this._value, next)) return
    this._value = next
    for (const effect of [...this.subs]) schedule(effect)
  }

  /** Read without creating a dependency. */
  peek(): T {
    return this._value
  }
}

export function signal<T>(value: T, eq?: (a: T, b: T) => boolean): Signal<T> {
  return new Signal(value, eq)
}

export function effect(fn: () => void): () => void {
  const eff: ReactiveEffect = {
    deps: new Set(),
    run: () => {
      cleanup()
      const prev = activeEffect
      activeEffect = eff
      try {
        fn()
      } finally {
        activeEffect = prev
      }
    },
  }
  function cleanup(): void {
    for (const dep of eff.deps) dep.delete(eff)
    eff.deps.clear()
  }
  eff.run()
  return cleanup
}

export function computed<T>(fn: () => T): { readonly value: T } {
  const s = signal<T>(fn())
  effect(() => {
    s.value = fn()
  })
  return {
    get value() {
      return s.value
    },
  }
}
