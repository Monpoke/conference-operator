import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import {
  assetUrls,
  currentSession,
  formatSessionRange,
  nextSession,
  normalizeProgram,
  openFeedbackUrl,
  programSchema,
  roomTimelinePosition,
  sessionsForRoom,
} from '../src/index.js'

const fixtureUrl = new URL('./fixtures/cloudnord-2026.json', import.meta.url)
const rawFixture: unknown = JSON.parse(readFileSync(fileURLToPath(fixtureUrl), 'utf8'))

const TRACK_1 = 'track-1-teilhard-de-chardin'
const TRACK_2 = 'track-2-mf-1092'
const HANDS_ON = 'hands-on'

const at = (iso: string): number => Date.parse(iso)

describe('normalizeProgram — real Cloud Nord 2026 export', () => {
  const program = normalizeProgram(rawFixture)

  it('exposes the upstream tracks as rooms', () => {
    expect(program.rooms.map((room) => room.id)).toEqual([TRACK_1, TRACK_2, HANDS_ON])
  })

  it('keeps the 27 sessions and spreads them across rooms', () => {
    expect(program.sessions).toHaveLength(27)
    expect(sessionsForRoom(program, TRACK_1)).toHaveLength(15)
    expect(sessionsForRoom(program, TRACK_2)).toHaveLength(9)
    expect(sessionsForRoom(program, HANDS_ON)).toHaveLength(3)
  })

  it('reports no blocking anomaly on the reference export', () => {
    const blocking = program.issues.filter((issue) =>
      ['unknown-speaker', 'unknown-track', 'missing-date', 'duplicate-id'].includes(issue.code),
    )
    expect(blocking).toEqual([])
  })

  it('resolves the speakers of every talk', () => {
    const honeySwamp = program.sessions.find((s) => s.id === 'cmqav0qto03qe01nsitbr18cn')
    expect(honeySwamp?.speakers).toHaveLength(1)
    expect(honeySwamp?.speakers[0]?.name).toBeTruthy()
    expect(honeySwamp?.category?.name).toBeTruthy()
  })

  it('tells talks from slots with no speaker', () => {
    const breaks = sessionsForRoom(program, TRACK_1).filter((s) => s.kind === 'break')
    expect(breaks.map((s) => s.title)).toContain('Déjeuner')
    expect(breaks.map((s) => s.title)).toContain('Pause croissants')
    const keynote = program.sessions.find((s) => s.id === 'SCGAR8iJEoCyZxxLyfbb')
    // With no upstream speakerIds, the keynote is a "break": an assumed heuristic.
    expect(keynote?.kind).toBe('break')
  })

  it("sorts the sponsor tiers on `order` (the export does not)", () => {
    expect(program.sponsorTiers.map((tier) => tier.order)).toEqual([0, 1, 2, 3])
    expect(program.sponsorTiers[0]?.name).toBe('Gold')
    expect(program.sponsorTiers[0]?.sponsors).toHaveLength(5)
  })

  it("carries the event's theme and timezone through", () => {
    expect(program.timezone).toBe('Europe/Paris')
    expect(program.event.name).toBe('Cloud Nord 2026')
    expect(program.event.theme.color).toBe('#1c71d8')
    expect(program.event.logoUrl).toMatch(/^https:\/\//)
  })

  it('lists the remote assets to preload, with no duplicates', () => {
    const urls = assetUrls(program)
    expect(urls).toHaveLength(34)
    expect(new Set(urls).size).toBe(urls.length)
    expect(urls).toContain(program.event.logoUrl)
  })
})

describe("a room's timeline", () => {
  const program = normalizeProgram(rawFixture)

  it('finds the running session and the next one', () => {
    const position = roomTimelinePosition(program, TRACK_1, at('2026-10-30T10:20:00Z'))
    expect(position.current?.id).toBe('cmqav0qto03qe01nsitbr18cn')
    expect(position.next?.id).toBe('eryK7jXLxb4r7DsPTmnC')
    expect(position.previous?.id).toBe('d88TFwa7AfvX9eEIgg5J')
  })

  it('returns no running session in a gap between slots', () => {
    // 08:45 → 08:50: five minutes between the keynote and the first talk.
    const position = roomTimelinePosition(program, TRACK_1, at('2026-10-30T08:47:00Z'))
    expect(position.current).toBeNull()
    expect(position.next?.id).toBe('cmotqj1r1008401pxxsm6y2fu')
    expect(position.previous?.id).toBe('SCGAR8iJEoCyZxxLyfbb')
  })

  it('handles before the doors open and after the close', () => {
    const before = roomTimelinePosition(program, TRACK_1, at('2026-10-30T05:00:00Z'))
    expect(before.current).toBeNull()
    expect(before.previous).toBeNull()
    expect(before.next?.title).toBe('Accueil et petit déjeuner')

    const after = roomTimelinePosition(program, TRACK_1, at('2026-10-30T21:00:00Z'))
    expect(after.current).toBeNull()
    expect(after.next).toBeNull()
    expect(after.previous?.title).toBe('Apéro Networking')
  })

  it('keeps the rooms properly isolated from each other', () => {
    const nowMs = at('2026-10-30T09:00:00Z')
    expect(currentSession(program, HANDS_ON, nowMs)?.title).toContain('usage responsable')
    expect(currentSession(program, TRACK_1, nowMs)?.title).toBe('IA for OPS on Scaleway')
  })

  it("formats times in the event's timezone, not the machine's", () => {
    const session = program.sessions.find((s) => s.id === 'cmqav0qto03qe01nsitbr18cn')!
    // 10:00 UTC → 11:00 in Paris (CET, +01:00 on 30 October).
    expect(formatSessionRange(session, program.timezone)).toBe('11:00 – 11:50')
  })

  it('returns null on an unknown room rather than throwing', () => {
    expect(currentSession(program, 'missing-room', at('2026-10-30T10:20:00Z'))).toBeNull()
    expect(nextSession(program, 'missing-room', at('2026-10-30T10:20:00Z'))).toBeNull()
  })
})

describe('programSchema — validating the normalized model', () => {
  const program = normalizeProgram(rawFixture)

  it('validates the real program after normalization', () => {
    expect(() => programSchema.parse(program)).not.toThrow()
  })

  it('survives a JSON round trip (SQLite cache, oRPC transport)', () => {
    const roundTripped = programSchema.parse(JSON.parse(JSON.stringify(program)))
    expect(roundTripped.sessions).toHaveLength(27)
    expect(roundTripped.sponsorTiers[0]?.name).toBe('Gold')
    expect(roundTripped).toEqual(program)
  })

  it('rejects a corrupted snapshot rather than showing it', () => {
    const corrupted = { ...program, sessions: [{ id: 'x' }] }
    expect(() => programSchema.parse(corrupted)).toThrow()
  })
})

/**
 * The OpenFeedback address, built with no network.
 *
 * The QR code projected in the room and the link shown in the console both come
 * from here: if they diverged, the audience would rate one talk and the speaker
 * would read another.
 */
describe('OpenFeedback link', () => {
  const program = normalizeProgram(rawFixture)
  const session = program.sessions.find((s) => s.id === 'cmqav0qto03qe01nsitbr18cn')!

  it('follows the public /{project}/{day}/{session} route', () => {
    expect(openFeedbackUrl(session, 'cloud-nord-2026', program.timezone)).toBe(
      `https://openfeedback.io/cloud-nord-2026/2026-10-30/${session.id}`,
    )
  })

  it("dates the slot in the event's timezone, not in UTC", () => {
    // 23:30 in Paris on 30 October is the 30th — but 22:30 UTC. Reading the day
    // in UTC would drop the link on a non-existent page every other evening.
    const late = { id: 'tardif', startsAt: '2026-10-30T23:30:00+01:00' }
    expect(openFeedbackUrl(late, 'cloud-nord-2026', 'Europe/Paris')).toContain('/2026-10-30/')
  })

  it('builds nothing with no project configured', () => {
    // No link beats a dead link: it would end up as a QR code in front of two
    // hundred people.
    expect(openFeedbackUrl(session, null, program.timezone)).toBeNull()
    expect(openFeedbackUrl(session, '   ', program.timezone)).toBeNull()
  })
})
