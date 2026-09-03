import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import {
  applySharedBreaks,
  currentSession,
  normalizeProgram,
  sessionsForRoom,
  type Program,
  type Session,
} from '../src/index.js'

const fixtureUrl = new URL('./fixtures/cloudnord-2026.json', import.meta.url)
const rawFixture: unknown = JSON.parse(readFileSync(fileURLToPath(fixtureUrl), 'utf8'))

const TRACK_1 = 'track-1-teilhard-de-chardin'
const TRACK_2 = 'track-2-mf-1092'
const HANDS_ON = 'hands-on'
const at = (iso: string): number => Date.parse(iso)

/**
 * One room's breaks hold for the rooms that have nothing scheduled.
 *
 * The upstream export only attaches a slot to one track: lunch, welcome and
 * coffee breaks appear on the main room and nowhere else. The other rooms
 * therefore showed "hors créneau" while the whole event was having lunch.
 */
describe('applySharedBreaks — real Cloud Nord 2026 export', () => {
  const program = normalizeProgram(rawFixture)
  const served = applySharedBreaks(program)

  it('only adds projections, without touching the program slots', () => {
    expect(program.sessions.every((session) => session.sharedFrom == null)).toBe(true)
    const added = served.sessions.filter((session) => session.sharedFrom != null)

    expect(served.sessions).toHaveLength(program.sessions.length + added.length)
    // The originals come back as they were: the rule projects, it does not rewrite.
    for (const original of program.sessions) {
      expect(served.sessions).toContainEqual(original)
    }
    // Every projection descends from another room's break.
    for (const copy of added) {
      const source = program.sessions.find((s) => s.id === copy.sharedFrom)!
      expect(source.kind).toBe('break')
      expect(source.roomId).not.toBe(copy.roomId)
      expect(copy.startsAtMs).toBe(source.startsAtMs)
    }
  })

  it('fills lunch in the two other rooms', () => {
    const noon = at('2026-10-30T11:40:00Z')

    expect(currentSession(program, TRACK_2, noon)).toBeNull()
    expect(currentSession(program, HANDS_ON, noon)).toBeNull()

    for (const room of [TRACK_1, TRACK_2, HANDS_ON]) {
      expect(currentSession(served, room, noon)?.title).toBe('Déjeuner')
    }
  })

  it('leaves a busy room on its own program', () => {
    // 09:50 UTC: Track #1 is on its croissant break (09:40 → 10:00), while Hands
    // on is running a two-hour workshop. Trimming the workshop to slip the break
    // in would manufacture a slot nobody put in the program.
    const breakTime = at('2026-10-30T09:50:00Z')

    expect(currentSession(served, TRACK_1, breakTime)?.title).toBe('Pause croissants')
    expect(currentSession(served, TRACK_2, breakTime)?.title).toBe('Pause croissants')
    expect(currentSession(served, HANDS_ON, breakTime)?.title).toContain('usage responsable')
  })

  it('keeps the list sorted by start time', () => {
    const starts = served.sessions.map((session) => session.startsAtMs)
    expect(starts).toEqual([...starts].sort((a, b) => a - b))
  })

  it('is idempotent: replaying it duplicates nothing', () => {
    // It is recomputed on every read of the served program: replaying it on its
    // own result must not pile the copies up.
    expect(applySharedBreaks(served).sessions).toHaveLength(served.sessions.length)
  })
})

/**
 * Edge cases, on hand-cut programs: the real export runs its slots edge to edge
 * and says nothing about partial overlaps.
 */
describe('applySharedBreaks — edge cases', () => {
  const base = (id: string, roomId: string, start: string, end: string | null, kind: 'talk' | 'break'): Session => ({
    id,
    title: id,
    abstract: null,
    startsAt: start,
    endsAt: end,
    startsAtMs: at(start),
    endsAtMs: end == null ? null : at(end),
    durationMinutes: null,
    roomId,
    kind,
    sharedFrom: null,
    feedbackId: null,
    speakers: [],
    category: null,
    format: null,
    language: null,
    level: null,
    tags: [],
    imageUrl: null,
  })

  const programOf = (sessions: Session[]): Program => ({
    event: {
      id: 'e', name: 'E', startsAt: null, endsAt: null, locationName: null, locationUrl: null,
      language: null, theme: { color: null, colorSecondary: null, colorBackground: null },
      logoUrl: null, logoUrl2: null, backgroundUrl: null, intermissionMediaUrl: null,
    },
    timezone: 'Europe/Paris',
    generatedAt: null,
    rooms: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }],
    sessions: [...sessions].sort((x, y) => x.startsAtMs - y.startsAtMs || x.id.localeCompare(y.id)),
    speakers: [], categories: [], formats: [], sponsorTiers: [], issues: [],
  })

  const shared = (p: Program, roomId: string): Session[] =>
    sessionsForRoom(applySharedBreaks(p), roomId).filter((s) => s.sharedFrom != null)

  it('projects a break into an edge-to-edge room, without calling it busy', () => {
    // The common case: B's talk ends at the hour A's break starts. Treating that
    // contact as an overlap would cancel the rule everywhere.
    const p = programOf([
      base('pause-a', 'a', '2026-10-30T11:00:00Z', '2026-10-30T12:00:00Z', 'break'),
      base('talk-b', 'b', '2026-10-30T10:00:00Z', '2026-10-30T11:00:00Z', 'talk'),
      base('talk-b2', 'b', '2026-10-30T12:00:00Z', '2026-10-30T13:00:00Z', 'talk'),
    ])

    expect(shared(p, 'b').map((s) => s.sharedFrom)).toEqual(['pause-a'])
  })

  it('gives up on an overlap, even a partial one', () => {
    // B has its own program over part of the interval: trimming the break to fit
    // what is left would invent a slot.
    const p = programOf([
      base('pause-a', 'a', '2026-10-30T11:00:00Z', '2026-10-30T12:00:00Z', 'break'),
      base('talk-b', 'b', '2026-10-30T11:30:00Z', '2026-10-30T12:30:00Z', 'talk'),
    ])

    expect(shared(p, 'b')).toEqual([])
  })

  it('gives up on a break we cannot close', () => {
    // With no end, no duration and no next slot, it would run to the end of the
    // day in a room that may well have a talk later.
    const p = programOf([base('pause-a', 'a', '2026-10-30T11:00:00Z', null, 'break')])

    expect(shared(p, 'b')).toEqual([])
  })

  it('projects a break held by two rooms only once', () => {
    // Two tracks each carry their own 15:00 "Pause café": the third room only
    // inherits one. Two identical rows in its timeline would read as two
    // successive slots.
    const p: Program = {
      ...programOf([
        base('pause-a', 'a', '2026-10-30T15:00:00Z', '2026-10-30T15:20:00Z', 'break'),
        base('pause-b', 'b', '2026-10-30T15:00:00Z', '2026-10-30T15:20:00Z', 'break'),
      ]),
      rooms: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }, { id: 'c', name: 'C' }],
    }
    // Identical titles: it is the same moment of the day, held twice.
    p.sessions = p.sessions.map((s) => ({ ...s, title: 'Pause café' }))

    expect(shared(p, 'c')).toHaveLength(1)
  })
})
