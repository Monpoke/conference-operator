import { describe, expect, it } from 'vitest'
import { horaireReel } from '../src/stores/planning-grid.js'

describe('what really happened in a slot', () => {
  const hour = (iso: string) => iso.slice(11, 16)
  const slot = { startsAt: '2026-10-30T09:00:00Z' }

  it('says nothing before the start, and leaves the end open while it runs', () => {
    expect(horaireReel(slot, hour)).toBeNull()
    expect(horaireReel({ ...slot, startedAt: '2026-10-30T09:02:00Z' }, hour)).toMatchObject({ heures: '09:02–…', retard: '+2 min', enRetard: false })
  })

  it('tells a late start, an early one and one on time', () => {
    const at = (startedAt: string) => horaireReel({ ...slot, startedAt, endedAt: '2026-10-30T09:50:00Z' }, hour)
    expect(at('2026-10-30T09:06:00Z')).toEqual({ heures: '09:06–09:50', retard: '+6 min', enRetard: true })
    expect(at('2026-10-30T08:58:00Z')?.retard).toBe('−2 min')
    expect(at('2026-10-30T09:00:10Z')?.retard).toBe("à l'heure")
  })

  it('shows no delay for a start left to the time rule', () => {
    expect(horaireReel({ ...slot, startedAt: '2026-10-30T09:14:00Z', decidedBy: 'auto' }, hour)).toMatchObject({ retard: null, enRetard: false })
  })
})
