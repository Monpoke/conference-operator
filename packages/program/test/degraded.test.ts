import { describe, expect, it } from 'vitest'
import { normalizeProgram, roomTimelinePosition, sessionsForRoom, type Program } from '../src/index.js'

/**
 * Deliberately damaged exports: the normalizer must degrade cleanly and report,
 * never throw. A partial import on the day beats a black screen.
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

describe('normalizeProgram — degraded exports', () => {
  it('discards a social link that is not a URL and reports it', () => {
    // Real case: the Cloud Nord export has `link: "LinkedIn"` on a team member.
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

  it('reports an orphan speakerId without losing the session', () => {
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

  it('reports an unknown room but keeps the session in the program', () => {
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

  it('excludes a session with no usable date and reports it', () => {
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

  it('derives a session end from its duration, then from the next one', () => {
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

    // 09:20: inside the window derived from durationMinutes (09:00 → 09:30).
    expect(sessionsForRoom(program, 'salle-a')[0]?.id).toBe('par-duree')
    expect(timeline(program, at('2026-10-30T09:20:00Z')).current?.id).toBe('par-duree')
    // 09:40: past the duration, so nothing is running.
    expect(timeline(program, at('2026-10-30T09:40:00Z')).current).toBeNull()
    // 10:30: with no end and no duration, the session runs until the next starts.
    expect(timeline(program, at('2026-10-30T10:30:00Z')).current?.id).toBe('par-suivante')
    // 23:00: the last session has no end bound at all, it stays open.
    expect(timeline(program, at('2026-10-30T23:00:00Z')).current?.id).toBe('derniere')
  })

  it('tolerates unknown fields from an export enriched upstream', () => {
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

  it('rejects structurally invalid JSON', () => {
    expect(() => normalizeProgram({ pasDEvent: true })).toThrow()
  })
})
