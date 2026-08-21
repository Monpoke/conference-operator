import { describe, expect, it } from 'vitest'
import { simulatedClock, systemClock } from '../src/services/clock.js'

describe('horloge du hub', () => {
  it('suit le temps réel par défaut', () => {
    const horloge = systemClock()
    expect(horloge.simulated).toBe(false)
    expect(Math.abs(horloge.now() - Date.now())).toBeLessThan(50)
  })

  it('se place à l\'instant demandé', () => {
    let base = 1_000
    const horloge = simulatedClock('2026-10-30T10:20:00.000Z', () => base)

    expect(horloge.nowIso()).toBe('2026-10-30T10:20:00.000Z')
    expect(horloge.simulated).toBe(true)
  })

  it('avance au rythme réel, sans se figer', () => {
    let base = 1_000
    const horloge = simulatedClock('2026-10-30T10:20:00.000Z', () => base)

    base += 90_000
    // Figer l'instant ne se distinguerait pas d'un écran planté, et la clôture
    // automatique ne se déclencherait jamais.
    expect(horloge.nowIso()).toBe('2026-10-30T10:21:30.000Z')
  })

  it('refuse une heure illisible plutôt que de démarrer de travers', () => {
    expect(() => simulatedClock('hier soir')).toThrow(/illisible/)
  })
})

import { mutableClock } from '../src/services/clock.js'

describe('horloge réglable', () => {
  it('part à l\'heure réelle et se laisse déplacer', () => {
    const horloge = mutableClock()
    expect(horloge.simulated).toBe(false)

    horloge.setSimulated('2026-10-30T10:20:00.000Z')
    expect(horloge.simulated).toBe(true)
    expect(horloge.nowIso().startsWith('2026-10-30T10:2')).toBe(true)
  })

  it('revient à l\'heure réelle', () => {
    const horloge = mutableClock('2026-10-30T10:20:00.000Z')
    horloge.setSimulated(null)

    expect(horloge.simulated).toBe(false)
    expect(Math.abs(horloge.now() - Date.now())).toBeLessThan(50)
  })

  it('refuse une heure illisible sans se laisser casser', () => {
    const horloge = mutableClock('2026-10-30T10:20:00.000Z')
    expect(() => horloge.setSimulated('hier')).toThrow(/illisible/)

    // L'horloge précédente tient toujours : un hub sans horloge serait pire.
    expect(horloge.nowIso().startsWith('2026-10-30')).toBe(true)
  })
})
