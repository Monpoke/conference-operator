import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { beforeEach, describe, expect, it } from 'vitest'
import { normalizeProgram, sessionsForRoom, type Program } from '@cloudnord/program'
import { POLITIQUE_VOD_PAR_DEFAUT } from '@cloudnord/contract'
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

/**
 * Reculer l'horloge du hub — ce que fait le menu Développement.
 *
 * Le défaut observé : le talk de 09:50 lancé pendant un essai à 11 h restait
 * « en cours » quand on revenait à 08:38, et la régie affichait deux heures de
 * compte à rebours sur une conférence que personne n'avait démarrée.
 */
describe('horloge reculée', () => {
  it('écarte une décision datée d\'après l\'instant courant', () => {
    sessions.start(TALK.id, TRACK_1, 'op')
    expect(sessions.get(TALK.id)?.status).toBe('running')

    horloge -= 2 * 60 * 60_000
    expect(sessions.get(TALK.id)).toBeNull()
    expect(sessions.states(TRACK_1)).toEqual([])
  })

  it('écarte aussi une clôture à venir, sans faire réapparaître le démarrage', () => {
    sessions.start(TALK.id, TRACK_1, 'op')
    horloge += 45 * 60_000
    sessions.end(TALK.id, TRACK_1, 'op')

    // Entre le démarrage et la clôture : la conférence tourne encore.
    horloge -= 20 * 60_000
    expect(sessions.get(TALK.id)).toBeNull()
  })

  it('retrouve la journée là où on l\'avait laissée en ré-avançant', () => {
    const demarre = sessions.start(TALK.id, TRACK_1, 'op')
    const depart = horloge

    horloge -= 2 * 60 * 60_000
    expect(sessions.get(TALK.id)).toBeNull()

    // On filtre à la lecture, on n'efface pas : la ligne est toujours là.
    horloge = depart
    expect(sessions.get(TALK.id)).toEqual(demarre)
  })

  it('ne clôture pas automatiquement ce qui n\'a pas encore commencé', () => {
    sessions.start(TALK.id, TRACK_1, 'op')

    // Une heure *avant* le démarrage enregistré, mais bien après la fin du
    // créneau de la veille : la règle horaire ne doit rien conclure.
    horloge = FIN - 3 * 60 * 60_000
    expect(sessions.sweep(program).ended).toEqual([])
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
      // Aucun stockage, et surtout rien qui parte tout seul : le défaut doit
      // être celui où aucun octet ne quitte une salle sans qu'on l'ait demandé.
      vodBucket: null,
      vodPrefix: null,
      vodPolitique: POLITIQUE_VOD_PAR_DEFAUT,
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
      vodBucket: null,
      vodPrefix: null,
      vodPolitique: POLITIQUE_VOD_PAR_DEFAUT,
    })
    expect(settings.get().autoEndGraceMinutes).toBe(15)
  })

  it('refuse une valeur hors bornes', () => {
    expect(() => settings.update({ autoEndGraceMinutes: -1 })).toThrow()
    expect(() => settings.update({ autoEndGraceMinutes: 999 })).toThrow()
  })

  it('garde le reste de la politique VOD quand on n\'en change qu\'un réglage', () => {
    settings.update({ vodPolitique: { actif: true, debitMaxOctetsS: 2_000_000 } })
    // Le formulaire de la console n'envoie que ce qu'il porte. Sans ce report,
    // corriger le plafond de débit en cours d'événement rendrait au passage la
    // taille de part et le seuil CPU à leurs valeurs d'usine — silencieusement.
    const apres = settings.update({ vodPolitique: { debitMaxOctetsS: 500_000 } })
    expect(apres.vodPolitique.debitMaxOctetsS).toBe(500_000)
    expect(apres.vodPolitique.actif).toBe(true)
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

/**
 * Le hub applique la table du cycle de vie, comme la régie.
 *
 * L'IHM grisait déjà « Terminer » sur une conférence non lancée ; la procédure,
 * elle, l'acceptait. Rien ne cassait — on écrivait simplement `ended` sur un
 * talk qui ne s'était pas tenu. La table vit désormais dans
 * `@cloudnord/room-state`, et les deux côtés la lisent.
 */
describe('gestes refusés par le cycle de vie', () => {
  it('ne termine pas une conférence que personne n\'a lancée', () => {
    expect(() => sessions.end(TALK.id, TRACK_1, 'op')).toThrow(/pas été lancée/)
    // Et rien n'est écrit : le refus ne laisse pas de trace à moitié posée.
    expect(sessions.get(TALK.id)).toBeNull()
  })

  it('ne lance pas deux fois la même conférence', () => {
    const premier = sessions.start(TALK.id, TRACK_1, 'op')
    expect(() => sessions.start(TALK.id, TRACK_1, 'op')).toThrow(/déjà lancée/)
    // L'heure de début réelle reste celle du premier départ.
    expect(sessions.get(TALK.id)?.startedAt).toBe(premier.startedAt)
  })

  it('ne termine pas deux fois', () => {
    sessions.start(TALK.id, TRACK_1, 'op')
    sessions.end(TALK.id, TRACK_1, 'op')
    expect(() => sessions.end(TALK.id, TRACK_1, 'op')).toThrow(/déjà terminée/)
  })

  it('relance une conférence close par erreur, sans détour', () => {
    // La règle horaire clôt un talk qui débordait mais n'était pas fini : le
    // rattraper doit tenir en un geste, pas en un « Remettre à venir » suivi
    // d'un « Commencer ».
    sessions.start(TALK.id, TRACK_1, 'op')
    sessions.end(TALK.id, TRACK_1, 'auto')
    expect(sessions.start(TALK.id, TRACK_1, 'op').status).toBe('running')
  })

  it('laisse « Remettre à venir » ouvert, y compris sur un talk en cours', () => {
    // L'échappatoire ne se conditionne pas : elle sert précisément quand on
    // s'est trompé de conférence.
    sessions.start(TALK.id, TRACK_1, 'op')
    sessions.reset(TALK.id)
    expect(sessions.get(TALK.id)).toBeNull()
  })

  it('laisse la clôture automatique faire son travail', () => {
    // Le balayage ne vise que ce qui est en cours : la table ne lui interdit
    // rien de ce qu'il fait déjà.
    sessions.start(TALK.id, TRACK_1, 'op')
    horloge = FIN + 10 * 60_000
    expect(sessions.sweep(program).ended.map((e) => e.sessionId)).toEqual([TALK.id])
  })
})

/**
 * La règle horaire lit la même fin que le dépassement.
 *
 * Elle exigeait `endsAt` là où l'état de la salle se contente d'une fin
 * déduite : un créneau dont l'export ne donne que l'heure de début passait en
 * dépassement sans que le balayage ne le voie jamais. La salle restait en
 * rouge pour le reste de la journée — le dépassement est évalué en premier et
 * masque tous les créneaux suivants — et rien ne pouvait l'en sortir qu'un
 * opérateur appuyant sur « Terminer ».
 */
describe('clôture automatique sur une fin déduite', () => {
  /** Le programme, mais avec un créneau qui ne porte que son heure de début. */
  function programmeSansFin(): Program {
    return {
      ...program,
      sessions: program.sessions.map((session) =>
        session.id === TALK.id
          ? { ...session, endsAt: null, endsAtMs: null }
          : session,
      ),
    }
  }

  it('ferme un créneau dont seule la durée est connue', () => {
    const servi = programmeSansFin()
    sessions.start(TALK.id, TRACK_1, 'op')

    // La durée vaut fin : 10:00 + 50 min, plus cinq minutes de grâce.
    horloge = FIN + 4 * 60_000
    expect(sessions.sweep(servi).ended).toEqual([])

    horloge = FIN + 6 * 60_000
    expect(sessions.sweep(servi).ended.map((e) => e.sessionId)).toEqual([TALK.id])
  })

  it('ferme un créneau que seul le suivant ferme', () => {
    const servi = programmeSansFin()
    servi.sessions = servi.sessions.map((session) =>
      session.id === TALK.id ? { ...session, durationMinutes: null } : session,
    )
    sessions.start(TALK.id, TRACK_1, 'op')

    // Reste le début du créneau suivant. Il vient après la fin prévue de
    // celui-ci, donc la clôture arrive plus tard — mais elle arrive.
    horloge = FIN + 60 * 60_000
    expect(sessions.sweep(servi).ended.map((e) => e.sessionId)).toEqual([TALK.id])
  })

  it('ne ferme pas ce qu\'aucune des trois règles ne ferme', () => {
    // Un créneau sans heure de fin, sans durée, et sans suivant : personne ne
    // sait quand il finit, et le clore reviendrait à inventer une heure.
    const dernier = sessionsForRoom(program, TRACK_1).at(-1)!
    const servi: Program = {
      ...program,
      sessions: program.sessions
        .filter((session) => session.roomId !== TRACK_1 || session.id === dernier.id)
        .map((session) =>
          session.id === dernier.id
            ? { ...session, endsAt: null, endsAtMs: null, durationMinutes: null }
            : session,
        ),
    }
    sessions.start(dernier.id, TRACK_1, 'op')

    horloge = dernier.startsAtMs + 12 * 60 * 60_000
    expect(sessions.sweep(servi).ended).toEqual([])
  })

  it('ne décide rien sur une conférence absente du programme', () => {
    // Réimport, annulation : sans créneau de référence, on ne touche à rien.
    sessions.start('session-hors-programme', TRACK_1, 'op')
    horloge = FIN + 60 * 60_000

    expect(sessions.sweep(program).ended.map((e) => e.sessionId)).not.toContain(
      'session-hors-programme',
    )
  })
})
