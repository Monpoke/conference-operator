import { describe, expect, it } from 'vitest'
import type { StatistiqueTalk } from '@conference-operator/contract'
import { synthese, talksCsv } from '../src/stores/statistiques.js'

const TALK: StatistiqueTalk = {
  sessionId: 'a', title: 'A', roomId: 'r', roomName: 'R', startsAt: '2026-10-30T09:00:00Z', endsAt: null, retardMs: 600_000, depassementMs: null,
  auto: false, tenue: true, sansCaptation: false, rush: 'rentre', rushOctets: 10, lufs: -40, truePeak: -8, lra: 6, confiance: 'basse',
  alertesSaturation: 2, alertesSilence: 0, montages: ['termine'], videoMs: 60_000, consentement: 'accorde',
}

describe('the figures of the talks in view', () => {
  it('averages only what was measured, and says on how many', () => {
    const s = synthese([TALK, { ...TALK, sessionId: 'b', retardMs: null, lufs: null, auto: true, rush: 'manquant', rushOctets: 0, montages: [], videoMs: 0 }])
    expect(s.retard).toEqual({ valeur: 600_000, sur: 1 })
    expect(s.lufs).toEqual({ valeur: -40, sur: 1 })
    expect(s).toMatchObject({ prevus: 2, enRetard: 1, autos: 1, rushManquants: 1, rushRentres: 1, videos: 1 })
  })

  it('does not expect a rush from a room nobody records', () => {
    expect(synthese([{ ...TALK, sansCaptation: true, rush: 'sans-objet' }]).rushManquants).toBe(0)
  })

  it('exports one line per talk, a title never running as a formula', () => {
    const csv = talksCsv([{ ...TALK, title: '=HYPERLINK("x");y' }])
    const [, row] = csv.split('\n')
    expect(row).toContain(`"'=HYPERLINK(""x"");y"`)
    expect(row).toContain(';10;')
  })
})
