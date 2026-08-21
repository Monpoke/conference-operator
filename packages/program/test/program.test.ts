import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import {
  assetUrls,
  currentSession,
  formatSessionRange,
  nextSession,
  normalizeProgram,
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

describe('normalizeProgram — export Cloud Nord 2026 réel', () => {
  const program = normalizeProgram(rawFixture)

  it('expose les tracks amont comme salles', () => {
    expect(program.rooms.map((room) => room.id)).toEqual([TRACK_1, TRACK_2, HANDS_ON])
  })

  it('conserve les 27 sessions et les répartit par salle', () => {
    expect(program.sessions).toHaveLength(27)
    expect(sessionsForRoom(program, TRACK_1)).toHaveLength(15)
    expect(sessionsForRoom(program, TRACK_2)).toHaveLength(9)
    expect(sessionsForRoom(program, HANDS_ON)).toHaveLength(3)
  })

  it("ne relève aucune anomalie bloquante sur l'export de référence", () => {
    const blocking = program.issues.filter((issue) =>
      ['unknown-speaker', 'unknown-track', 'missing-date', 'duplicate-id'].includes(issue.code),
    )
    expect(blocking).toEqual([])
  })

  it('résout les speakers de chaque talk', () => {
    const honeySwamp = program.sessions.find((s) => s.id === 'cmqav0qto03qe01nsitbr18cn')
    expect(honeySwamp?.speakers).toHaveLength(1)
    expect(honeySwamp?.speakers[0]?.name).toBeTruthy()
    expect(honeySwamp?.category?.name).toBeTruthy()
  })

  it('distingue les talks des créneaux sans speaker', () => {
    const breaks = sessionsForRoom(program, TRACK_1).filter((s) => s.kind === 'break')
    expect(breaks.map((s) => s.title)).toContain('Déjeuner')
    expect(breaks.map((s) => s.title)).toContain('Pause croissants')
    const keynote = program.sessions.find((s) => s.id === 'SCGAR8iJEoCyZxxLyfbb')
    // Sans speakerIds en amont, la keynote est un « break » : heuristique assumée.
    expect(keynote?.kind).toBe('break')
  })

  it('trie les tiers de sponsors sur `order` (l\'export ne le fait pas)', () => {
    expect(program.sponsorTiers.map((tier) => tier.order)).toEqual([0, 1, 2, 3])
    expect(program.sponsorTiers[0]?.name).toBe('Gold')
    expect(program.sponsorTiers[0]?.sponsors).toHaveLength(5)
  })

  it('remonte le thème et le fuseau de l\'événement', () => {
    expect(program.timezone).toBe('Europe/Paris')
    expect(program.event.name).toBe('Cloud Nord 2026')
    expect(program.event.theme.color).toBe('#1c71d8')
    expect(program.event.logoUrl).toMatch(/^https:\/\//)
  })

  it('liste les assets distants à précharger, sans doublon', () => {
    const urls = assetUrls(program)
    expect(urls).toHaveLength(34)
    expect(new Set(urls).size).toBe(urls.length)
    expect(urls).toContain(program.event.logoUrl)
  })
})

describe('timeline d\'une salle', () => {
  const program = normalizeProgram(rawFixture)

  it('trouve la session en cours et la suivante', () => {
    const position = roomTimelinePosition(program, TRACK_1, at('2026-10-30T10:20:00Z'))
    expect(position.current?.id).toBe('cmqav0qto03qe01nsitbr18cn')
    expect(position.next?.id).toBe('eryK7jXLxb4r7DsPTmnC')
    expect(position.previous?.id).toBe('d88TFwa7AfvX9eEIgg5J')
  })

  it('ne retourne aucune session en cours dans un inter-créneau', () => {
    // 08:45 → 08:50 : cinq minutes de battement entre keynote et premier talk.
    const position = roomTimelinePosition(program, TRACK_1, at('2026-10-30T08:47:00Z'))
    expect(position.current).toBeNull()
    expect(position.next?.id).toBe('cmotqj1r1008401pxxsm6y2fu')
    expect(position.previous?.id).toBe('SCGAR8iJEoCyZxxLyfbb')
  })

  it('gère avant l\'ouverture et après la clôture', () => {
    const before = roomTimelinePosition(program, TRACK_1, at('2026-10-30T05:00:00Z'))
    expect(before.current).toBeNull()
    expect(before.previous).toBeNull()
    expect(before.next?.title).toBe('Accueil et petit déjeuner')

    const after = roomTimelinePosition(program, TRACK_1, at('2026-10-30T21:00:00Z'))
    expect(after.current).toBeNull()
    expect(after.next).toBeNull()
    expect(after.previous?.title).toBe('Apéro Networking')
  })

  it('isole bien les salles entre elles', () => {
    const nowMs = at('2026-10-30T09:00:00Z')
    expect(currentSession(program, HANDS_ON, nowMs)?.title).toContain('usage responsable')
    expect(currentSession(program, TRACK_1, nowMs)?.title).toBe('IA for OPS on Scaleway')
  })

  it('formate les horaires dans le fuseau de l\'événement, pas celui du PC', () => {
    const session = program.sessions.find((s) => s.id === 'cmqav0qto03qe01nsitbr18cn')!
    // 10:00 UTC → 11:00 à Paris (CET, +01:00 le 30 octobre).
    expect(formatSessionRange(session, program.timezone)).toBe('11:00 – 11:50')
  })

  it('retourne null sur une salle inconnue plutôt que de lever', () => {
    expect(currentSession(program, 'salle-inexistante', at('2026-10-30T10:20:00Z'))).toBeNull()
    expect(nextSession(program, 'salle-inexistante', at('2026-10-30T10:20:00Z'))).toBeNull()
  })
})

describe('programSchema — validation du modèle normalisé', () => {
  const program = normalizeProgram(rawFixture)

  it('valide le programme réel après normalisation', () => {
    expect(() => programSchema.parse(program)).not.toThrow()
  })

  it('survit à un aller-retour JSON (cache SQLite, transport oRPC)', () => {
    const roundTripped = programSchema.parse(JSON.parse(JSON.stringify(program)))
    expect(roundTripped.sessions).toHaveLength(27)
    expect(roundTripped.sponsorTiers[0]?.name).toBe('Gold')
    expect(roundTripped).toEqual(program)
  })

  it('rejette un snapshot corrompu plutôt que de l\'afficher', () => {
    const corrupted = { ...program, sessions: [{ id: 'x' }] }
    expect(() => programSchema.parse(corrupted)).toThrow()
  })
})
