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
 * Les pauses d'une salle valent pour celles qui n'ont rien de prévu.
 *
 * L'export amont ne rattache un créneau qu'à un track : déjeuner, accueil et
 * pauses café figurent sur la salle principale et nulle part ailleurs. Les
 * autres salles affichaient donc « hors créneau » pendant que l'événement
 * entier déjeunait.
 */
describe('applySharedBreaks — export Cloud Nord 2026 réel', () => {
  const program = normalizeProgram(rawFixture)
  const servi = applySharedBreaks(program)

  it("n'ajoute que des projections, sans toucher aux créneaux du programme", () => {
    expect(program.sessions.every((session) => session.sharedFrom == null)).toBe(true)
    const ajoutees = servi.sessions.filter((session) => session.sharedFrom != null)

    expect(servi.sessions).toHaveLength(program.sessions.length + ajoutees.length)
    // Les originaux repartent tels quels : la règle projette, elle ne réécrit pas.
    for (const originale of program.sessions) {
      expect(servi.sessions).toContainEqual(originale)
    }
    // Toute projection descend d'une pause d'une autre salle.
    for (const copie of ajoutees) {
      const source = program.sessions.find((s) => s.id === copie.sharedFrom)!
      expect(source.kind).toBe('break')
      expect(source.roomId).not.toBe(copie.roomId)
      expect(copie.startsAtMs).toBe(source.startsAtMs)
    }
  })

  it('comble le déjeuner dans les deux autres salles', () => {
    const midi = at('2026-10-30T11:40:00Z')

    expect(currentSession(program, TRACK_2, midi)).toBeNull()
    expect(currentSession(program, HANDS_ON, midi)).toBeNull()

    for (const salle of [TRACK_1, TRACK_2, HANDS_ON]) {
      expect(currentSession(servi, salle, midi)?.title).toBe('Déjeuner')
    }
  })

  it("laisse une salle occupée sur son propre programme", () => {
    // 09:50 UTC : Track #1 est en pause croissants (09:40 → 10:00), pendant que
    // Hands on tient un atelier de deux heures. Rogner l'atelier pour y glisser
    // la pause fabriquerait un créneau que personne n'a mis au programme.
    const pause = at('2026-10-30T09:50:00Z')

    expect(currentSession(servi, TRACK_1, pause)?.title).toBe('Pause croissants')
    expect(currentSession(servi, TRACK_2, pause)?.title).toBe('Pause croissants')
    expect(currentSession(servi, HANDS_ON, pause)?.title).toContain('usage responsable')
  })

  it('garde la liste triée par heure de début', () => {
    const debuts = servi.sessions.map((session) => session.startsAtMs)
    expect(debuts).toEqual([...debuts].sort((a, b) => a - b))
  })

  it('est idempotente : la rejouer ne duplique rien', () => {
    // Elle se recalcule à chaque lecture du programme servi : la rejouer sur son
    // propre résultat ne doit pas empiler les copies.
    expect(applySharedBreaks(servi).sessions).toHaveLength(servi.sessions.length)
  })
})

/**
 * Cas limites, sur des programmes taillés à la main : l'export réel enchaîne ses
 * créneaux bord à bord et ne dit rien des recouvrements partiels.
 */
describe('applySharedBreaks — cas limites', () => {
  const base = (id: string, roomId: string, debut: string, fin: string | null, kind: 'talk' | 'break'): Session => ({
    id,
    title: id,
    abstract: null,
    startsAt: debut,
    endsAt: fin,
    startsAtMs: at(debut),
    endsAtMs: fin == null ? null : at(fin),
    durationMinutes: null,
    roomId,
    kind,
    sharedFrom: null,
    speakers: [],
    category: null,
    format: null,
    language: null,
    level: null,
    tags: [],
    imageUrl: null,
  })

  const programme = (sessions: Session[]): Program => ({
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

  const partagees = (p: Program, roomId: string): Session[] =>
    sessionsForRoom(applySharedBreaks(p), roomId).filter((s) => s.sharedFrom != null)

  it('projette une pause dans une salle bord à bord, sans la croire occupée', () => {
    // Le cas courant : le talk de B finit à l'heure où la pause de A commence.
    // Traiter ce contact comme un chevauchement annulerait la règle partout.
    const p = programme([
      base('pause-a', 'a', '2026-10-30T11:00:00Z', '2026-10-30T12:00:00Z', 'break'),
      base('talk-b', 'b', '2026-10-30T10:00:00Z', '2026-10-30T11:00:00Z', 'talk'),
      base('talk-b2', 'b', '2026-10-30T12:00:00Z', '2026-10-30T13:00:00Z', 'talk'),
    ])

    expect(partagees(p, 'b').map((s) => s.sharedFrom)).toEqual(['pause-a'])
  })

  it('renonce sur un recouvrement, même partiel', () => {
    // B a son propre programme sur une partie de l'intervalle : rogner la pause
    // pour la faire entrer dans ce qui reste inventerait un créneau.
    const p = programme([
      base('pause-a', 'a', '2026-10-30T11:00:00Z', '2026-10-30T12:00:00Z', 'break'),
      base('talk-b', 'b', '2026-10-30T11:30:00Z', '2026-10-30T12:30:00Z', 'talk'),
    ])

    expect(partagees(p, 'b')).toEqual([])
  })

  it('renonce sur une pause qu\'on ne sait pas fermer', () => {
    // Sans fin ni durée ni créneau suivant, elle courrait jusqu'au bout de la
    // journée dans une salle qui a peut-être un talk plus tard.
    const p = programme([base('pause-a', 'a', '2026-10-30T11:00:00Z', null, 'break')])

    expect(partagees(p, 'b')).toEqual([])
  })

  it('ne projette qu\'une fois une pause que deux salles tiennent', () => {
    // Deux tracks portent chacun leur « Pause café » de 15:00 : la troisième
    // salle n'en hérite qu'une. Deux lignes identiques dans sa timeline se
    // liraient comme deux créneaux successifs.
    const p: Program = {
      ...programme([
        base('pause-a', 'a', '2026-10-30T15:00:00Z', '2026-10-30T15:20:00Z', 'break'),
        base('pause-b', 'b', '2026-10-30T15:00:00Z', '2026-10-30T15:20:00Z', 'break'),
      ]),
      rooms: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }, { id: 'c', name: 'C' }],
    }
    // Titres identiques : c'est le même moment de la journée, tenu deux fois.
    p.sessions = p.sessions.map((s) => ({ ...s, title: 'Pause café' }))

    expect(partagees(p, 'c')).toHaveLength(1)
  })
})
