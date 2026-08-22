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
  roomConferenceState,
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

/**
 * Ce que peint la pastille des consoles.
 *
 * Une couleur juste vaut mieux qu'une couleur rassurante : c'est sur elle qu'on
 * décide de laisser filer cinq minutes ou de lancer le talk suivant.
 */
describe("état d'une salle", () => {
  const program = normalizeProgram(rawFixture)

  it('distingue le talk, la pause et le hors-créneau', () => {
    expect(roomConferenceState(program, TRACK_1, at('2026-10-30T10:20:00Z'))).toBe('en-cours')
    // Déjeuner : la salle est occupée, mais rien ne s'y joue.
    expect(roomConferenceState(program, TRACK_1, at('2026-10-30T11:30:00Z'))).toBe('pause')
    // Battement de cinq minutes entre deux créneaux.
    expect(roomConferenceState(program, TRACK_1, at('2026-10-30T08:47:00Z'))).toBe('aucune')
    expect(roomConferenceState(program, TRACK_1, at('2026-10-30T21:00:00Z'))).toBe('aucune')
  })

  it('annonce une fin proche cinq minutes avant', () => {
    // HoneySwamp finit à 10:50 : c'est le moment où l'on ne lance pas un talk
    // dans la salle d'à côté, sous peine de croiser tout son public.
    expect(roomConferenceState(program, TRACK_1, at('2026-10-30T10:44:00Z'))).toBe('en-cours')
    expect(roomConferenceState(program, TRACK_1, at('2026-10-30T10:46:00Z'))).toBe('fin-proche')
  })

  it('ne voit un dépassement que dans ce que la salle pilote', () => {
    const apresLaFin = at('2026-10-30T11:00:00Z')
    const honeySwamp = sessionsForRoom(program, TRACK_1).find((s) => s.title.startsWith('HoneySwamp'))!

    // Le programme seul est passé au créneau suivant : il ne dira jamais qu'une
    // salle déborde, c'est l'état remonté qui le révèle.
    expect(roomConferenceState(program, TRACK_1, apresLaFin)).toBe('en-cours')
    expect(roomConferenceState(program, TRACK_1, apresLaFin, honeySwamp.id)).toBe('depassement')
  })

  it('ignore une conférence pilotée absente du programme', () => {
    // Import remplacé en cours de journée : sans créneau, il n'y a rien à
    // dépasser, et on retombe sur ce que dit le programme.
    expect(roomConferenceState(program, TRACK_1, at('2026-10-30T10:20:00Z'), 'ses-fantome')).toBe('en-cours')
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

/**
 * Adresse OpenFeedback, fabriquée sans réseau.
 *
 * Le QR projeté en salle et le lien affiché dans la console sortent d'ici tous
 * les deux : s'ils divergeaient, le public noterait un talk et le speaker en
 * lirait un autre.
 */
describe('lien OpenFeedback', () => {
  const program = normalizeProgram(rawFixture)
  const session = program.sessions.find((s) => s.id === 'cmqav0qto03qe01nsitbr18cn')!

  it('suit la route publique /{projet}/{jour}/{session}', () => {
    expect(openFeedbackUrl(session, 'cloud-nord-2026', program.timezone)).toBe(
      `https://openfeedback.io/cloud-nord-2026/2026-10-30/${session.id}`,
    )
  })

  it('date le créneau dans le fuseau de l\'événement, pas en UTC', () => {
    // 23:30 à Paris le 30 octobre, c'est le 30 — mais 22:30 UTC. Lire le jour
    // en UTC ferait tomber le lien sur une page inexistante une fois sur deux
    // en soirée.
    const tardif = { id: 'tardif', startsAt: '2026-10-30T23:30:00+01:00' }
    expect(openFeedbackUrl(tardif, 'cloud-nord-2026', 'Europe/Paris')).toContain('/2026-10-30/')
  })

  it('ne fabrique rien sans projet configuré', () => {
    // Pas de lien vaut mieux qu'un lien mort : il finirait en QR devant deux
    // cents personnes.
    expect(openFeedbackUrl(session, null, program.timezone)).toBeNull()
    expect(openFeedbackUrl(session, '   ', program.timezone)).toBeNull()
  })
})
