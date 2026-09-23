import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import {
  agendaForRoom,
  applySharedBreaks,
  defaultSponsorPages,
  normalizeProgram,
  programSponsors,
  resolveSponsorRef,
} from '../src/index.js'

const fixtureUrl = new URL('./fixtures/cloudnord-2026.json', import.meta.url)
const program = normalizeProgram(JSON.parse(readFileSync(fileURLToPath(fixtureUrl), 'utf8')))

const TRACK_1 = 'track-1-teilhard-de-chardin'
const TRACK_2 = 'track-2-mf-1092'
const HANDS_ON = 'hands-on'
const DAY = Date.parse('2026-10-30T08:00:00Z')

const titles = (roomId: string) => agendaForRoom(program, roomId, { nowMs: DAY }).map((e) => e.title)

describe('normalizeProgram — roomSpan', () => {
  it('reads the grid width of shared slots', () => {
    const breakfast = program.sessions.find((s) => s.title === 'Accueil et petit déjeuner')!
    expect(breakfast.roomSpan).toBe(3)
    expect(program.sessions.find((s) => s.title === 'Pause croissants')!.roomSpan).toBe(2)
    expect(program.sessions.find((s) => s.speakers.length > 0)!.roomSpan).toBe(1)
  })
})

describe('agendaForRoom', () => {
  it('shows a slot in every room it covers, and only there', () => {
    expect(titles(TRACK_2)).toContain('Pause croissants')
    expect(titles(HANDS_ON)).not.toContain('Pause croissants')
    for (const room of [TRACK_1, TRACK_2, HANDS_ON]) expect(titles(room)).toContain('Déjeuner')
  })

  it('keeps the opening keynote in the room that hosts it', () => {
    const keynote = agendaForRoom(program, TRACK_1, { nowMs: DAY }).find((e) => e.title === "Keynote d'ouverture")!
    expect(keynote).toMatchObject({ pause: false, elsewhere: null })
    expect(titles(TRACK_2)).not.toContain("Keynote d'ouverture")
    expect(titles(HANDS_ON)).not.toContain("Keynote d'ouverture")
  })

  it('marks shared slots as breaks, without a room pill where they belong', () => {
    const lunch = agendaForRoom(program, HANDS_ON, { nowMs: DAY }).find((e) => e.title === 'Déjeuner')!
    expect(lunch).toMatchObject({ pause: true, elsewhere: null })
  })

  it('ignores the copies projected into free rooms', () => {
    const served = applySharedBreaks(program)
    const count = agendaForRoom(served, HANDS_ON, { nowMs: DAY }).length
    expect(count).toBe(agendaForRoom(program, HANDS_ON, { nowMs: DAY }).length)
  })

  it('is sorted and resolves speakers and formats', () => {
    const entries = agendaForRoom(program, TRACK_1, { nowMs: DAY })
    expect(entries.map((e) => e.startsAtMs)).toEqual([...entries.map((e) => e.startsAtMs)].sort((a, b) => a - b))
    const talk = entries.find((e) => e.speakers.length > 0)!
    expect(talk.format).not.toMatch(/\(/)
  })

  it('says which room each slot is attached to', () => {
    const lunch = agendaForRoom(program, TRACK_2, { nowMs: DAY }).find((e) => e.title === 'Déjeuner')!
    expect(lunch.roomId).toBe(TRACK_1)
  })

  it('knows nothing of an unknown room', () => {
    expect(agendaForRoom(program, 'nope', { nowMs: DAY })).toEqual([])
  })
})

describe('sponsors', () => {
  it('deduplicates partners across tiers', () => {
    const sponsors = programSponsors(program)
    const ape = sponsors.filter((s) => s.name.toLowerCase() === 'ape factory')
    expect(ape).toHaveLength(1)
    expect(ape[0]!.tiers.length).toBeGreaterThan(1)
  })

  it('lays one page per tier, the first without a title, rows of four at most', () => {
    const pages = defaultSponsorPages(program)
    expect(pages[0]!.titre).toBe('')
    expect(pages.slice(1).every((p) => p.titre !== '')).toBe(true)
    for (const page of pages) for (const row of page.rangs) expect(row.logos.length).toBeLessThanOrEqual(4)
  })

  it('resolves a placement by key or by name, and flags an unknown sponsor', () => {
    const catalogue = programSponsors(program)
    const byName = resolveSponsorRef({ sponsor: 'APE Factory', nom: null, logo: null, echelle: 0.7 }, catalogue)
    expect(byName.missing).toBe(false)
    const unknown = resolveSponsorRef({ sponsor: 'MTG', nom: null, logo: 'https://x/mtg.png', echelle: 0.6 }, catalogue)
    expect(unknown).toEqual({ nom: 'MTG', logoUrl: 'https://x/mtg.png', echelle: 0.6, missing: true })
  })
})
