import { describe, expect, it } from 'vitest'
import { composeStatistiques, type StatSources } from '../src/services/statistiques.js'

const BASE: StatSources = {
  sessions: [
    { id: 'a', title: 'A', kind: 'talk', roomId: 'r1', startsAt: '2026-10-30T09:00:00.000Z', endsAt: '2026-10-30T10:00:00.000Z' },
    { id: 'b', title: 'B', kind: 'talk', roomId: 'r2', startsAt: '2026-10-30T09:00:00.000Z', endsAt: '2026-10-30T10:00:00.000Z' },
    { id: 'p', title: 'Pause', kind: 'break', roomId: 'r1', startsAt: '2026-10-30T10:00:00.000Z', endsAt: '2026-10-30T10:10:00.000Z' },
  ],
  roomName: (id) => id.toUpperCase(),
  sallesSansCaptation: [],
  states: [],
  uploads: [],
  jobs: [],
  consents: [],
  alerts: [],
  sponsorTiers: [{ name: 'Gold', sponsors: [{}, {}] }, { name: 'Silver', sponsors: [{}] }],
  audit: { actions: 3, refusees: 1 },
  questions: 0,
  timezone: 'Europe/Paris',
}

describe('the edition in figures', () => {
  it('counts talks, never breaks, and the sponsors by tier', () => {
    const stats = composeStatistiques(BASE)
    expect(stats.talks.map((talk) => talk.sessionId)).toEqual(['a', 'b'])
    expect(stats.sponsors).toEqual({ total: 3, paliers: [{ nom: 'Gold', nombre: 2 }, { nom: 'Silver', nombre: 1 }] })
  })

  it('measures a late start, and says nothing of one left to the time rule', () => {
    const { talks } = composeStatistiques({
      ...BASE,
      states: [
        { sessionId: 'a', startedAt: '2026-10-30T09:04:00.000Z', endedAt: '2026-10-30T09:58:00.000Z', decidedBy: 'regie@x' },
        { sessionId: 'b', startedAt: '2026-10-30T09:14:00.000Z', endedAt: null, decidedBy: 'auto' },
      ],
    })
    expect(talks[0]).toMatchObject({ retardMs: 240_000, depassementMs: -120_000, tenue: true, auto: false })
    expect(talks[1]).toMatchObject({ retardMs: null, tenue: true, auto: true })
  })

  it('tells a missing rush from a room nobody records', () => {
    const { talks } = composeStatistiques({ ...BASE, sallesSansCaptation: ['r2'] })
    expect(talks.map((talk) => talk.rush)).toEqual(['manquant', 'sans-objet'])
  })

  it('counts an alert once, in its own room and during the talk', () => {
    const { talks } = composeStatistiques({
      ...BASE,
      states: [{ sessionId: 'a', startedAt: '2026-10-30T09:00:00.000Z', endedAt: '2026-10-30T10:00:00.000Z', decidedBy: 'x' }],
      alerts: [
        { roomId: 'r1', kind: 'saturation', since: '2026-10-30T09:10:00.000Z' },
        { roomId: 'r1', kind: 'saturation', since: '2026-10-30T09:10:00.000Z' },
        { roomId: 'r2', kind: 'saturation', since: '2026-10-30T09:20:00.000Z' },
        { roomId: 'r1', kind: 'saturation', since: '2026-10-30T11:00:00.000Z' },
        { roomId: 'r1', kind: 'silence', since: '2026-10-30T09:30:00.000Z' },
      ],
    })
    expect(talks[0]).toMatchObject({ alertesSaturation: 1, alertesSilence: 1 })
  })

  it('reads the measures of the latest analysis, and sums the videos of a split talk', () => {
    const job = (state: string, createdAt: string, durationMs: number | null, lufs: number) => ({
      sessionId: 'a', state, createdAt, durationMs, analyseJson: JSON.stringify({ confiance: 'basse', audio: { lufsAvant: lufs, truePeak: -8, lra: 6 } }),
    })
    const { talks } = composeStatistiques({ ...BASE, jobs: [job('termine', '2026-10-30T12:00:00Z', 60_000, -40), job('termine', '2026-10-30T13:00:00Z', 120_000, -30), job('annule', '2026-10-30T14:00:00Z', null, -10)] })
    expect(talks[0]).toMatchObject({ lufs: -30, videoMs: 180_000, montages: ['termine', 'termine'] })
  })
})
