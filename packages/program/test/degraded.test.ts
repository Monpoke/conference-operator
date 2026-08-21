import { describe, expect, it } from 'vitest'
import { normalizeProgram, roomTimelinePosition, sessionsForRoom, type Program } from '../src/index.js'

/**
 * Exports volontairement abîmés : le normaliseur doit dégrader proprement et
 * signaler, jamais lever. Un import partiel le jour J vaut mieux qu'un écran noir.
 */

const at = (iso: string): number => Date.parse(iso)
const timeline = (program: Program, nowMs: number) =>
  roomTimelinePosition(program, 'salle-a', nowMs)

const baseEvent = {
  id: 'evt',
  name: 'Test',
  tracks: [{ id: 'salle-a', name: 'Salle A' }],
  categories: [],
  formats: [],
}

describe('normalizeProgram — exports dégradés', () => {
  it('écarte un lien social qui n\'est pas une URL et le signale', () => {
    // Cas réel : l'export Cloud Nord contient `link: "LinkedIn"` sur un membre d'équipe.
    const program = normalizeProgram({
      event: baseEvent,
      speakers: [
        {
          id: 'spk-1',
          name: 'Alice',
          socials: [
            { name: 'LinkedIn', icon: 'linkedin', link: 'LinkedIn' },
            { name: 'Bluesky', icon: 'bluesky', link: 'https://bsky.app/profile/alice' },
          ],
        },
      ],
    })

    expect(program.speakers[0]?.socials).toHaveLength(1)
    expect(program.speakers[0]?.socials[0]?.url).toBe('https://bsky.app/profile/alice')
    expect(program.issues).toContainEqual(
      expect.objectContaining({ code: 'invalid-social-url', ref: 'speaker:spk-1' }),
    )
  })

  it('signale un speakerId orphelin sans perdre la session', () => {
    const program = normalizeProgram({
      event: baseEvent,
      speakers: [],
      sessions: [
        {
          id: 'ses-1',
          title: 'Talk fantôme',
          dateStart: '2026-10-30T09:00:00.000+00:00',
          dateEnd: '2026-10-30T09:50:00.000+00:00',
          speakerIds: ['spk-inconnu'],
          trackId: 'salle-a',
        },
      ],
    })

    expect(program.sessions).toHaveLength(1)
    expect(program.sessions[0]?.speakers).toEqual([])
    expect(program.sessions[0]?.kind).toBe('talk')
    expect(program.issues).toContainEqual(
      expect.objectContaining({ code: 'unknown-speaker', ref: 'ses-1' }),
    )
  })

  it('signale une salle inconnue mais garde la session dans le programme', () => {
    const program = normalizeProgram({
      event: baseEvent,
      sessions: [
        {
          id: 'ses-1',
          title: 'Talk égaré',
          dateStart: '2026-10-30T09:00:00.000+00:00',
          trackId: 'salle-supprimee',
        },
      ],
    })

    expect(program.sessions).toHaveLength(1)
    expect(sessionsForRoom(program, 'salle-a')).toEqual([])
    expect(program.issues).toContainEqual(
      expect.objectContaining({ code: 'unknown-track', ref: 'ses-1' }),
    )
  })

  it('exclut une session sans date exploitable et le signale', () => {
    const program = normalizeProgram({
      event: baseEvent,
      sessions: [
        { id: 'ses-ok', title: 'OK', dateStart: '2026-10-30T09:00:00.000+00:00', trackId: 'salle-a' },
        { id: 'ses-nodate', title: 'Sans date', dateStart: null, trackId: 'salle-a' },
        { id: 'ses-baddate', title: 'Date illisible', dateStart: 'pas-une-date', trackId: 'salle-a' },
      ],
    })

    expect(program.sessions.map((s) => s.id)).toEqual(['ses-ok'])
    expect(program.issues.filter((i) => i.code === 'missing-date')).toHaveLength(2)
  })

  it('déduit la fin d\'une session depuis sa durée, puis depuis la suivante', () => {
    const program = normalizeProgram({
      event: baseEvent,
      sessions: [
        {
          id: 'par-duree',
          title: 'Durée connue',
          dateStart: '2026-10-30T09:00:00.000+00:00',
          durationMinutes: 30,
          trackId: 'salle-a',
        },
        {
          id: 'par-suivante',
          title: 'Ni fin ni durée',
          dateStart: '2026-10-30T10:00:00.000+00:00',
          trackId: 'salle-a',
        },
        {
          id: 'derniere',
          title: 'Dernière',
          dateStart: '2026-10-30T11:00:00.000+00:00',
          trackId: 'salle-a',
        },
      ],
    })

    // 09:20 : dans la fenêtre déduite de durationMinutes (09:00 → 09:30).
    expect(sessionsForRoom(program, 'salle-a')[0]?.id).toBe('par-duree')
    expect(timeline(program, at('2026-10-30T09:20:00Z')).current?.id).toBe('par-duree')
    // 09:40 : au-delà de la durée, donc plus rien en cours.
    expect(timeline(program, at('2026-10-30T09:40:00Z')).current).toBeNull()
    // 10:30 : sans fin ni durée, la session court jusqu'au début de la suivante.
    expect(timeline(program, at('2026-10-30T10:30:00Z')).current?.id).toBe('par-suivante')
    // 23:00 : la dernière session n'a aucune borne de fin, elle reste ouverte.
    expect(timeline(program, at('2026-10-30T23:00:00Z')).current?.id).toBe('derniere')
  })

  it('tolère les champs inconnus d\'un export enrichi en amont', () => {
    const program = normalizeProgram({
      event: { ...baseEvent, champInedit: 42 },
      sessions: [
        {
          id: 'ses-1',
          title: 'Talk',
          dateStart: '2026-10-30T09:00:00.000+00:00',
          trackId: 'salle-a',
          nouveauChamp: { imbrique: true },
        },
      ],
      nouvelleSectionRacine: [1, 2, 3],
    })

    expect(program.sessions).toHaveLength(1)
    expect(program.issues).toEqual([])
  })

  it('rejette un JSON structurellement invalide', () => {
    expect(() => normalizeProgram({ pasDEvent: true })).toThrow()
  })
})
