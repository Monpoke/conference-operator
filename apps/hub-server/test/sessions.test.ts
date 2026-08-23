import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { beforeEach, describe, expect, it } from 'vitest'
import { normalizeProgram, sessionsForRoom, type Program } from '@cloudnord/program'
import { openHubDatabase, type HubDatabase } from '../src/db.js'
import { SessionStateService, SettingsService } from '../src/services/sessions.js'
import { RoomService } from '../src/services/rooms.js'

const program: Program = normalizeProgram(
  JSON.parse(
    readFileSync(
      fileURLToPath(new URL('../../../packages/program/test/fixtures/cloudnord-2026.json', import.meta.url)),
      'utf8',
    ),
  ),
)

const TRACK_1 = 'track-1-teilhard-de-chardin'
/** « HoneySwamp » : 10:00 → 10:50 UTC. */
const TALK = sessionsForRoom(program, TRACK_1).find((s) => s.id === 'cmqav0qto03qe01nsitbr18cn')!
const FIN = TALK.endsAtMs!

let db: HubDatabase
let settings: SettingsService
let sessions: SessionStateService
let horloge: number

beforeEach(() => {
  db = openHubDatabase(':memory:').orm
  const rooms = new RoomService(db)
  // Les deux salles existent : l'état d'une session référence sa salle, et une
  // clé étrangère interdit d'écrire un état orphelin.
  for (const id of [TRACK_1, 'track-2-mf-1092']) {
    rooms.upsert({
      id,
      name: id,
      trackId: id,
      obs: {
        A: { url: 'ws://127.0.0.1:4455', password: null },
        B: { url: 'ws://127.0.0.1:4456', password: null },
      },
      sceneRoles: { A: {}, B: {} },
    })
  }
  settings = new SettingsService(db)
  horloge = FIN - 30 * 60_000
  sessions = new SessionStateService(db, settings, () => horloge)
})

describe('cycle de vie d\'une conférence', () => {
  it('part de « à venir » sans rien stocker', () => {
    // On n'enregistre que ce qui s'est produit.
    expect(sessions.get(TALK.id)).toBeNull()
    expect(sessions.states(TRACK_1)).toEqual([])
  })

  it('démarre puis termine', () => {
    const demarre = sessions.start(TALK.id, TRACK_1, 'regie@cloudnord.fr')
    expect(demarre.status).toBe('running')
    expect(demarre.startedAt).toBeTruthy()

    horloge += 45 * 60_000
    const termine = sessions.end(TALK.id, TRACK_1, 'regie@cloudnord.fr')
    expect(termine.status).toBe('ended')
    // L'heure de début réelle est conservée : la réécrire ferait perdre la
    // durée effective du talk.
    expect(termine.startedAt).toBe(demarre.startedAt)
    expect(termine.endedAt).toBeTruthy()
  })

  it('revient à « à venir » après une fausse manœuvre', () => {
    sessions.start(TALK.id, TRACK_1, 'regie@cloudnord.fr')
    sessions.reset(TALK.id)
    expect(sessions.get(TALK.id)).toBeNull()
  })

  it('filtre les états par salle', () => {
    sessions.start(TALK.id, TRACK_1, 'op')
    sessions.start('autre-session', 'track-2-mf-1092', 'op')

    expect(sessions.states(TRACK_1).map((e) => e.sessionId)).toEqual([TALK.id])
    expect(sessions.states(null)).toHaveLength(2)
  })
})

describe('clôture automatique', () => {
  it('ne clôture rien avant le délai de grâce', () => {
    sessions.start(TALK.id, TRACK_1, 'op')

    horloge = FIN + 4 * 60_000
    expect(sessions.sweep(program).ended).toEqual([])
    expect(sessions.get(TALK.id)?.status).toBe('running')
  })

  it('clôture une fois le délai dépassé', () => {
    sessions.start(TALK.id, TRACK_1, 'op')

    horloge = FIN + 6 * 60_000
    const { ended } = sessions.sweep(program)

    expect(ended.map((e) => e.sessionId)).toEqual([TALK.id])
    // `auto` plutôt que l'opérateur : en régie, savoir qui a clôturé change la
    // lecture qu'on fait de l'historique.
    expect(sessions.get(TALK.id)).toMatchObject({ status: 'ended', decidedBy: 'auto' })
  })

  it('respecte le délai configuré', () => {
    settings.update({ autoEndGraceMinutes: 20 })
    sessions.start(TALK.id, TRACK_1, 'op')

    horloge = FIN + 10 * 60_000
    expect(sessions.sweep(program).ended).toEqual([])

    horloge = FIN + 21 * 60_000
    expect(sessions.sweep(program).ended).toHaveLength(1)
  })

  it('ne fait rien si la règle est désactivée', () => {
    settings.update({ autoEndEnabled: false })
    sessions.start(TALK.id, TRACK_1, 'op')

    horloge = FIN + 60 * 60_000
    expect(sessions.sweep(program).ended).toEqual([])
    expect(sessions.get(TALK.id)?.status).toBe('running')
  })

  it('ne déclare jamais terminée une conférence jamais démarrée', () => {
    horloge = FIN + 60 * 60_000
    expect(sessions.sweep(program).ended).toEqual([])

    // Affirmer qu'un talk s'est tenu alors que personne ne l'a lancé serait un
    // mensonge dans l'historique, et fausserait la VOD.
    expect(sessions.get(TALK.id)).toBeNull()
  })

  it('ignore une session absente du programme courant', () => {
    sessions.start('session-supprimee-au-reimport', TRACK_1, 'op')

    horloge = FIN + 60 * 60_000
    expect(sessions.sweep(program).ended).toEqual([])
    expect(sessions.get('session-supprimee-au-reimport')?.status).toBe('running')
  })

  it('ne reclôture pas ce qui l\'est déjà', () => {
    sessions.start(TALK.id, TRACK_1, 'op')
    horloge = FIN + 6 * 60_000
    sessions.sweep(program)

    expect(sessions.sweep(program).ended).toEqual([])
  })
})

describe('réglages du hub', () => {
  it('fournit des valeurs par défaut utilisables', () => {
    expect(settings.get()).toEqual({
      autoEndEnabled: true,
      autoEndGraceMinutes: 5,
      // Sans source de programme tant que personne n'en a renseigné une : le
      // hub n'importe alors rien tout seul, et c'est un état légitime.
      programSourceUrl: null,
      // Aucun compte déclaré : la boucle d'attente des salles saute sa page
      // réseaux plutôt que d'afficher un cadre vide.
      socialLinks: [],
      // Rien de l'événement n'est réglé au départ : le hub déduit son nom du
      // programme importé, et c'est ce qui rend le produit agnostique. Ces
      // champs ne servent qu'à contredire l'export amont.
      eventName: null,
      eventShortName: null,
      openFeedbackProjectId: null,
    })
  })

  it('applique une modification partielle', () => {
    expect(settings.update({ autoEndGraceMinutes: 15 })).toEqual({
      autoEndEnabled: true,
      autoEndGraceMinutes: 15,
      programSourceUrl: null,
      socialLinks: [],
      eventName: null,
      eventShortName: null,
      openFeedbackProjectId: null,
    })
    expect(settings.get().autoEndGraceMinutes).toBe(15)
  })

  it('refuse une valeur hors bornes', () => {
    expect(() => settings.update({ autoEndGraceMinutes: -1 })).toThrow()
    expect(() => settings.update({ autoEndGraceMinutes: 999 })).toThrow()
  })
})

/**
 * Vues enrichies : ce que la console reçoit.
 *
 * Le temps restant s'y trouve parce qu'il ne peut pas se calculer ailleurs :
 * l'heure qui fait foi est celle du hub, et elle peut être simulée. Fait dans
 * le navigateur, le calcul affichait « +6010 min » sur un talk à l'heure dès
 * qu'on déplaçait l'horloge depuis le menu Développement.
 */
describe('vues enrichies du programme', () => {
  it('compte le restant sur l\'horloge du hub', () => {
    sessions.start(TALK.id, TRACK_1, 'op')

    const vue = sessions.views(TRACK_1, program).find((e) => e.sessionId === TALK.id)!
    expect(vue.title).toBe(TALK.title)
    // L'horloge de test est à 30 minutes de la fin du créneau — et à des mois
    // de l'heure réelle de la machine qui exécute ce test.
    expect(vue.remainingMs).toBe(30 * 60_000)
  })

  it('passe en négatif sur un dépassement', () => {
    // C'est l'information qui déclenche une décision : elle doit exister avant
    // que la clôture automatique ne s'en mêle.
    sessions.start(TALK.id, TRACK_1, 'op')
    horloge = FIN + 7 * 60_000

    expect(sessions.views(TRACK_1, program)[0]?.remainingMs).toBe(-7 * 60_000)
  })

  it('ne l\'invente pas sans créneau de référence', () => {
    // Session absente du programme courant : sans fin connue, « 0 min » serait
    // un mensonge.
    sessions.start('session-hors-programme', TRACK_1, 'op')

    const vue = sessions.views(TRACK_1, program).find((e) => e.sessionId === 'session-hors-programme')!
    expect(vue.scheduledEndsAt).toBeNull()
    expect(vue.remainingMs).toBeNull()
  })
})
