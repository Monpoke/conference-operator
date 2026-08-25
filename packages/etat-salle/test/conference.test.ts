import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { applySharedBreaks, currentSession, normalizeProgram, sessionsForRoom } from '@cloudnord/program'

import {
  conferenceAPiloter,
  etatDesCreneaux,
  roomBreak,
  roomConferenceState,
} from '../src/index.js'

const rawFixture: unknown = JSON.parse(
  readFileSync(
    fileURLToPath(new URL('../../program/test/fixtures/cloudnord-2026.json', import.meta.url)),
    'utf8',
  ),
)

const TRACK_1 = 'track-1-teilhard-de-chardin'
const TRACK_2 = 'track-2-mf-1092'
const HANDS_ON = 'hands-on'

const at = (iso: string): number => Date.parse(iso)


/**
 * Ce que peint la pastille des consoles.
 *
 * Une couleur juste vaut mieux qu'une couleur rassurante : c'est sur elle qu'on
 * décide de laisser filer cinq minutes ou de lancer le talk suivant.
 */
describe("état d'une salle", () => {
  const program = normalizeProgram(rawFixture)
  const sessionsT1 = sessionsForRoom(program, TRACK_1)
  const honeySwamp = sessionsT1.find((s) => s.title.startsWith('HoneySwamp'))!

  it('distingue la pause du hors-créneau', () => {
    // Déjeuner : la salle est occupée, mais rien ne s'y joue.
    expect(roomConferenceState(program, TRACK_1, at('2026-10-30T11:30:00Z'))).toBe('pause')
    // Battement de cinq minutes entre deux créneaux.
    expect(roomConferenceState(program, TRACK_1, at('2026-10-30T08:47:00Z'))).toBe('aucune')
    expect(roomConferenceState(program, TRACK_1, at('2026-10-30T21:00:00Z'))).toBe('aucune')
  })

  it("ne dit pas « en cours » d'un talk que personne n'a lancé", () => {
    /**
     * Le créneau a commencé, la régie n'a pas appuyé sur Commencer. Le lire
     * comme un talk en cours était le point aveugle : la pastille passait au
     * vert sur une salle où il ne se passait rien.
     */
    const debut = at('2026-10-30T10:02:00Z')
    expect(roomConferenceState(program, TRACK_1, debut)).toBe('pas-commencee')

    // Les premières minutes ne disent rien ; après, c'est une question.
    expect(roomConferenceState(program, TRACK_1, at('2026-10-30T10:07:00Z'))).toBe('retard')

    // Marqué commencé : le créneau se lit enfin comme un talk.
    const lance = { [honeySwamp.id]: 'running' as const }
    expect(roomConferenceState(program, TRACK_1, debut, lance)).toBe('en-cours')
  })

  it('annonce une fin proche cinq minutes avant, sur un talk lancé', () => {
    // HoneySwamp finit à 10:50 : c'est le moment où l'on ne lance pas un talk
    // dans la salle d'à côté, sous peine de croiser tout son public.
    const lance = { [honeySwamp.id]: 'running' as const }
    expect(roomConferenceState(program, TRACK_1, at('2026-10-30T10:44:00Z'), lance)).toBe('en-cours')
    expect(roomConferenceState(program, TRACK_1, at('2026-10-30T10:46:00Z'), lance)).toBe('fin-proche')
  })

  it('signale une salle libérée avant l\'heure', () => {
    // Terminée dans son créneau : la salle est disponible, et la voisine peut
    // en tenir compte. Ce n'est pas un créneau vide.
    const terminee = { [honeySwamp.id]: 'ended' as const }
    expect(roomConferenceState(program, TRACK_1, at('2026-10-30T10:30:00Z'), terminee)).toBe('terminee')
  })

  it('ne voit un dépassement que dans le cycle de vie', () => {
    const apresLaFin = at('2026-10-30T11:00:00Z')

    // Le programme seul est passé au créneau suivant : il ne dira jamais qu'une
    // salle déborde. Seule une conférence encore marquée « en cours » le dit.
    expect(roomConferenceState(program, TRACK_1, apresLaFin)).toBe('pas-commencee')
    expect(roomConferenceState(program, TRACK_1, apresLaFin, { [honeySwamp.id]: 'running' })).toBe('depassement')
    expect(roomConferenceState(program, TRACK_1, apresLaFin, { [honeySwamp.id]: 'ended' })).toBe('pas-commencee')
  })

  it('ignore un état portant sur une conférence absente du programme', () => {
    // Import remplacé en cours de journée : sans créneau, il n'y a rien à
    // dépasser, et on retombe sur ce que dit le programme.
    expect(roomConferenceState(program, TRACK_1, at('2026-10-30T11:30:00Z'), { 'ses-fantome': 'running' })).toBe('pause')
  })
})

/**
 * Le noyau tourne sur une liste de créneaux, pas sur un `Program`.
 *
 * C'est ce qui permet à la régie de l'appeler : elle n'a en cache que les
 * créneaux de sa salle, jamais le programme entier. Les deux entrées doivent
 * donc répondre exactement la même chose — sinon on aurait deux automates de
 * plus, au lieu des deux qu'on vient de réunir.
 */
describe('noyau sur liste de créneaux', () => {
  const program = normalizeProgram(rawFixture)
  const creneaux = sessionsForRoom(program, TRACK_1)
  const honeySwamp = creneaux.find((s) => s.title.startsWith('HoneySwamp'))!

  it('répond comme l’enveloppe qui part du programme', () => {
    const instants = [
      '2026-10-30T08:47:00Z',
      '2026-10-30T10:02:00Z',
      '2026-10-30T10:07:00Z',
      '2026-10-30T10:46:00Z',
      '2026-10-30T11:00:00Z',
      '2026-10-30T11:30:00Z',
      '2026-10-30T21:00:00Z',
    ]
    for (const statuts of [{}, { [honeySwamp.id]: 'running' as const }, { [honeySwamp.id]: 'ended' as const }]) {
      for (const iso of instants) {
        expect(etatDesCreneaux(creneaux, at(iso), statuts), `${iso} / ${JSON.stringify(statuts)}`).toBe(
          roomConferenceState(program, TRACK_1, at(iso), statuts),
        )
      }
    }
  })

  it('tient sur des créneaux réduits à leurs horaires', () => {
    // La régie désérialise son cache : elle passe des objets qui n'ont ni
    // intervenants ni catégorie. Exiger une `Session` entière l'obligerait à en
    // fabriquer une pour poser une question d'horaire.
    const nus = creneaux.map((s) => ({
      id: s.id,
      kind: s.kind,
      startsAtMs: s.startsAtMs,
      endsAtMs: s.endsAtMs,
      durationMinutes: s.durationMinutes,
    }))
    expect(etatDesCreneaux(nus, at('2026-10-30T10:07:00Z'))).toBe('retard')
  })
})

/**
 * L'étiquette BREAK, telle que les trois surfaces la lisent.
 *
 * Une donnée à part de `roomConferenceState` : les deux cohabitent, et c'est
 * voulu — une conférence peut courir pendant que le déjeuner approche.
 */
describe('roomBreak', () => {
  const program = applySharedBreaks(normalizeProgram(rawFixture))

  it('annonce le break en cours, avec sa reprise', () => {
    const midi = at('2026-10-30T11:40:00Z')
    const pause = roomBreak(program, TRACK_2, midi)!

    expect(pause.state).toBe('en-cours')
    expect(pause.session.title).toBe('Déjeuner')
    // La reprise : c'est ce qu'on vient chercher pendant une pause.
    expect(pause.endsAtMs).toBe(at('2026-10-30T12:05:00Z'))
  })

  it("l'annonce un quart d'heure avant, pendant que la conférence court encore", () => {
    // 11:05 UTC : Track #2 tient un talk jusqu'à 11:15, le déjeuner suit.
    // C'est le cas qui compte — celui où l'on décide de ne pas enchaîner.
    const avant = at('2026-10-30T11:05:00Z')

    expect(currentSession(program, TRACK_2, avant)?.kind).toBe('talk')
    expect(roomBreak(program, TRACK_2, avant)).toMatchObject({
      state: 'a-venir',
      session: { title: 'Déjeuner' },
    })
  })

  it('se tait au-delà du quart d\'heure', () => {
    // 11:00 UTC : le déjeuner est à quinze minutes et une seconde près — trop
    // tôt pour que l'information serve, et elle encombrerait toute la journée.
    expect(roomBreak(program, TRACK_2, at('2026-10-30T10:59:00Z'))).toBeNull()
    expect(roomBreak(program, TRACK_2, at('2026-10-30T11:00:00Z'))).toMatchObject({
      state: 'a-venir',
    })
  })

  it('se tait quand une conférence suit une conférence', () => {
    // 10:30 UTC sur Hands on : un atelier court, un autre suit. Rien à annoncer.
    expect(roomBreak(program, HANDS_ON, at('2026-10-30T10:30:00Z'))).toBeNull()
  })
})

/**
 * Une pause héritée d'une autre salle se lit comme une pause.
 *
 * L'assertion vivait dans le test des pauses partagées, côté `program` ; elle
 * y appelait l'automate, que ce paquet a repris. Elle compte : un déjeuner que
 * l'export ne rattache qu'à Track #1 concerne pourtant tout le monde, et les
 * trois salles doivent le dire pareil.
 */
describe('pauses héritées', () => {
  const servi = applySharedBreaks(normalizeProgram(rawFixture))

  it('vaut « pause » dans les trois salles', () => {
    const midi = at('2026-10-30T11:40:00Z')
    for (const salle of [TRACK_1, TRACK_2, HANDS_ON]) {
      expect(roomConferenceState(servi, salle, midi)).toBe('pause')
    }
  })
})


/**
 * Ce que « Commencer » et « Terminer » atteignent.
 *
 * La cible se décide sur deux sources qui peuvent se contredire : le programme
 * dit quel créneau est ouvert, le cycle de vie dit ce qui est à l'antenne. Le
 * second l'emporte au-delà du créneau — c'est le dépassement, et c'est là que
 * « Terminer » est le seul geste utile.
 */
describe('conférence à piloter', () => {
  const program = normalizeProgram(rawFixture)
  const creneaux = sessionsForRoom(program, TRACK_1)
  /** Sans intervenant, donc une pause au programme — et pourtant on la lance. */
  const keynote = creneaux.find((s) => s.title.startsWith('Keynote'))!
  const iaForOps = creneaux.find((s) => s.title.startsWith('IA for OPS'))!
  const honeySwamp = creneaux.find((s) => s.title.startsWith('HoneySwamp'))!

  it("vise le créneau courant quand c'est une conférence", () => {
    expect(conferenceAPiloter(creneaux, at('2026-10-30T10:20:00Z'))?.id).toBe(honeySwamp.id)
  })

  it('vise la prochaine dans un battement', () => {
    // 08:47 : le créneau de 08:00 est clos, « IA for OPS » commence à 08:50.
    expect(conferenceAPiloter(creneaux, at('2026-10-30T08:47:00Z'))?.id).toBe(iaForOps.id)
  })

  it('reste sur la conférence en cours pendant son dépassement', () => {
    const statuts = { [iaForOps.id]: 'running' as const }
    // « IA for OPS » finit à 09:40 et la pause croissants s'ouvre : le speaker
    // parle encore, et « Terminer » doit rester à portée.
    expect(conferenceAPiloter(creneaux, at('2026-10-30T09:42:00Z'), statuts)?.id).toBe(iaForOps.id)
  })

  it('la garde même quand le dépassement empiète sur le déjeuner', () => {
    const statuts = { [honeySwamp.id]: 'running' as const }
    expect(conferenceAPiloter(creneaux, at('2026-10-30T11:30:00Z'), statuts)?.id).toBe(
      honeySwamp.id,
    )
  })

  /**
   * Une pause ne se pilote pas, même lancée.
   *
   * La keynote d'ouverture n'a pas d'intervenant : l'export en fait une pause,
   * et il n'y a rien à commencer ni à terminer dans un créneau creux. Ce qui la
   * rend pilotable est la décision « considérer comme conférence » prise depuis
   * la console — elle arrive alors ici avec `kind` à `talk`, et la règle du
   * dépassement s'y applique comme sur n'importe quelle autre.
   */
  it('ne reprend pas une pause, même portée à « en cours »', () => {
    const statuts = { [keynote.id]: 'running' as const }
    expect(conferenceAPiloter(creneaux, at('2026-10-30T08:47:00Z'), statuts)?.id).toBe(iaForOps.id)
  })

  it("la rend dès qu'elle est close", () => {
    const statuts = { [iaForOps.id]: 'ended' as const }
    expect(conferenceAPiloter(creneaux, at('2026-10-30T09:42:00Z'), statuts)?.id).toBe(
      honeySwamp.id,
    )
  })

  it('préfère le créneau courant à une conférence restée ouverte', () => {
    const statuts = { [iaForOps.id]: 'running' as const }
    expect(conferenceAPiloter(creneaux, at('2026-10-30T10:20:00Z'), statuts)?.id).toBe(
      honeySwamp.id,
    )
  })
})
