import { describe, expect, it } from 'vitest'
import { simulatedClock, systemClock } from '../src/services/clock.js'

describe('hub clock', () => {
  it('follows real time by default', () => {
    const clock = systemClock()
    expect(clock.simulated).toBe(false)
    expect(Math.abs(clock.now() - Date.now())).toBeLessThan(50)
  })

  it('sits at the requested instant', () => {
    let base = 1_000
    const clock = simulatedClock('2026-10-30T10:20:00.000Z', () => base)

    expect(clock.nowIso()).toBe('2026-10-30T10:20:00.000Z')
    expect(clock.simulated).toBe(true)
  })

  it('moves at the real pace, without freezing', () => {
    let base = 1_000
    const clock = simulatedClock('2026-10-30T10:20:00.000Z', () => base)

    base += 90_000
    // Freezing the instant would be indistinguishable from a hung screen, and the
    // automatic closing would never fire.
    expect(clock.nowIso()).toBe('2026-10-30T10:21:30.000Z')
  })

  it('refuses an unreadable time rather than starting up crooked', () => {
    expect(() => simulatedClock('hier soir')).toThrow(/illisible/)
  })
})

import { mutableClock } from '../src/services/clock.js'

describe('adjustable clock', () => {
  it('starts at the real time and lets itself be moved', () => {
    const clock = mutableClock()
    expect(clock.simulated).toBe(false)

    clock.setSimulated('2026-10-30T10:20:00.000Z')
    expect(clock.simulated).toBe(true)
    expect(clock.nowIso().startsWith('2026-10-30T10:2')).toBe(true)
  })

  it('comes back to the real time', () => {
    const clock = mutableClock('2026-10-30T10:20:00.000Z')
    clock.setSimulated(null)

    expect(clock.simulated).toBe(false)
    expect(Math.abs(clock.now() - Date.now())).toBeLessThan(50)
  })

  it('refuses an unreadable time without letting itself be broken', () => {
    const clock = mutableClock('2026-10-30T10:20:00.000Z')
    expect(() => clock.setSimulated('hier')).toThrow(/illisible/)

    // The previous clock still holds: a hub with no clock would be worse.
    expect(clock.nowIso().startsWith('2026-10-30')).toBe(true)
  })
})
