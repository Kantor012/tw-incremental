import { describe, it, expect } from 'vitest'
import { signal, effect, computed, batch } from '../src/engine/store'

describe('reactive store', () => {
  it('re-runs an effect when its signal changes', () => {
    const s = signal(1)
    let observed = 0
    effect(() => {
      observed = s.value
    })
    expect(observed).toBe(1)
    s.value = 2
    expect(observed).toBe(2)
  })

  it('does not re-run an effect when set to an equal value (Object.is)', () => {
    const s = signal(5)
    let runs = 0
    effect(() => {
      void s.value
      runs++
    })
    expect(runs).toBe(1)
    s.value = 5
    expect(runs).toBe(1)
    s.value = 6
    expect(runs).toBe(2)
  })

  it('recomputes a computed after its dependency changes', () => {
    const a = signal(2)
    const doubled = computed(() => a.value * 10)
    expect(doubled.value).toBe(20)
    a.value = 3
    expect(doubled.value).toBe(30)
  })

  it('coalesces notifications inside a batch', () => {
    const s = signal(0)
    let runs = 0
    effect(() => {
      void s.value
      runs++
    })
    expect(runs).toBe(1)

    batch(() => {
      s.value = 1
      s.value = 2
      s.value = 3
    })

    expect(runs).toBe(2)
    expect(s.value).toBe(3)
  })
})
