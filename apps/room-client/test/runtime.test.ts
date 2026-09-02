import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { commandSchema, type Command, type CommandPayloadInput } from '@cloudnord/contract'
import { normalizeProgram } from '@cloudnord/program'
import { LocalStore } from '../src/core/store.js'
import { RoomRuntime } from '../src/core/runtime.js'

const program = normalizeProgram(
  JSON.parse(
    readFileSync(
      fileURLToPath(new URL('../../../packages/program/test/fixtures/cloudnord-2026.json', import.meta.url)),
      'utf8',
    ),
  ),
)

const TRACK_1 = 'track-1-teilhard-de-chardin'
const ISSUED_AT = '2026-10-30T10:20:00.000+00:00'

let store: LocalStore
let clockMs: number

beforeEach(() => {
  store = new LocalStore(':memory:')
  clockMs = Date.parse(ISSUED_AT)
})

function makeRuntime(effects = {}) {
  const runtime = new RoomRuntime(store, effects, () => clockMs)
  runtime.setRoomId(TRACK_1)
  runtime.setProgram('hash-1', program)
  return runtime
}

let nextSeq = 0
const command = (payload: CommandPayloadInput, ttlSeconds: number | null = null): Command => {
  nextSeq += 1
  return commandSchema.parse({ seq: nextSeq, issuedAt: ISSUED_AT, ttlSeconds, payload })
}

describe('état de la salle', () => {
  it('positionne la session en cours et la suivante depuis le programme', () => {
    const runtime = makeRuntime()
    const state = runtime.state()
    // 10:20 UTC : « HoneySwamp » court de 10:00 à 10:50.
    expect(state.currentSession?.title).toContain('HoneySwamp')
    expect(state.nextSession?.title).toContain('Coupable')
  })

  it('démarre sur la boucle d\'attente, sans dépendre du réseau', () => {
    // C'est l'écran qu'on veut trouver en salle le matin sans que personne
    // n'ait rien touché. Elle se réduit d'elle-même aux pages qui ont du
    // contenu : sans programme en cache, elle montre les sponsors.
    expect(new RoomRuntime(store, {}, () => clockMs).state()).toMatchObject({
      mode: 'loop',
      connectivity: 'OFFLINE',
    })
  })

  it('corrige l\'horloge avec l\'offset serveur', () => {
    const runtime = makeRuntime()
    // Le PC de régie retarde de 40 minutes : sans correction, l'écran
    // annoncerait encore le talk précédent (10:20 → HoneySwamp au lieu de 11:00).
    expect(runtime.state().currentSession?.title).toContain('HoneySwamp')
    runtime.setClockOffset(40 * 60_000)
    runtime.refreshSessions()
    expect(runtime.state().currentSession?.title).toContain('Coupable')
    // L'offset est persisté : un redémarrage ne le reperd pas.
    expect(store.settings().clockOffsetMs).toBe(2_400_000)
  })
})

describe('application des commandes', () => {
  it('bascule la scène OBS demandée', async () => {
    const setSceneRole = vi.fn(async () => {})
    const runtime = makeRuntime({ setSceneRole })

    const outcome = await runtime.applyCommand(command({ type: 'scene.force', role: 'LIVE' }))
    expect(outcome).toEqual({ applied: true })
    expect(setSceneRole).toHaveBeenCalledWith('LIVE')
    expect(runtime.state().sceneRole).toBe('LIVE')
  })

  /**
   * Ce que fait une salle voisine arrive déjà poussé sur le flux de commandes ;
   * seule la *vue* qui l'affiche était sondée. La régie recevait donc la
   * notification « Track #2 vient de terminer » pendant que la pastille de
   * Track #2 disait encore « en cours ».
   */
  it("redemande la vue des autres salles dès qu'une d'elles décide", async () => {
    const refreshRoomStatuses = vi.fn()
    const runtime = makeRuntime({ refreshRoomStatuses })
    runtime.setRoomId('track-1')

    await runtime.applyCommand(
      command({
        type: 'session.state',
        sessionId: 'ses-voisine',
        roomId: 'track-2',
        sessionTitle: 'Blind ops',
        status: 'ended',
        decidedBy: 'regie@cloudnord.fr',
      }),
    )

    expect(refreshRoomStatuses).toHaveBeenCalledTimes(1)
    // Sans toucher à notre propre cycle de vie : celui d'à côté n'a rien à y faire.
    expect(runtime.state().sessionStates['ses-voisine']).toBeUndefined()
  })

  it("ne redemande rien sur une décision qui la concerne elle-même", async () => {
    // Sa propre salle se met à jour par la commande : il n'y a rien à relire,
    // et une requête par décision locale serait du bruit.
    const refreshRoomStatuses = vi.fn()
    const runtime = makeRuntime({ refreshRoomStatuses })
    runtime.setRoomId('track-1')

    await runtime.applyCommand(
      command({
        type: 'session.state',
        sessionId: 'ses-1',
        roomId: 'track-1',
        sessionTitle: 'HoneySwamp',
        status: 'running',
        decidedBy: 'regie@cloudnord.fr',
      }),
    )

    expect(refreshRoomStatuses).not.toHaveBeenCalled()
    expect(runtime.state().sessionStates['ses-1']).toBe('running')
  })

  it('affiche en salle un message destiné au public', async () => {
    const runtime = makeRuntime()
    await runtime.applyCommand(
      command(
        { type: 'message.broadcast', text: 'Évacuation', level: 'urgent', target: 'audience' },
        600,
      ),
    )
    expect(runtime.state()).toMatchObject({
      mode: 'message',
      message: { text: 'Évacuation', level: 'urgent' },
    })
    // La régie est prévenue de ce qui est projeté chez elle.
    expect(runtime.state().notifications.at(-1)?.text).toContain('Affiché en salle')
  })

  it('garde pour l\'opérateur un message qui lui est adressé', async () => {
    const runtime = makeRuntime()
    await runtime.applyCommand(
      command({
        type: 'message.broadcast',
        text: 'Ton speaker est arrivé',
        level: 'info',
        target: 'operator',
        from: 'organisateur@cloudnord.fr',
      }),
    )

    // Basculer l'écran l'afficherait en grand devant le public.
    expect(runtime.state().mode).toBe('loop')
    expect(runtime.state().message).toBeNull()
    expect(runtime.state().notifications.at(-1)?.text).toContain('Ton speaker est arrivé')
    expect(runtime.state().notifications.at(-1)?.text).toContain('organisateur@cloudnord.fr')
  })

  it('efface un signalement au bout de trente secondes', async () => {
    const runtime = makeRuntime()
    await runtime.applyCommand(
      command({ type: 'message.broadcast', text: 'Ton speaker est arrivé', level: 'info', target: 'operator' }),
    )
    expect(runtime.state().notifications).toHaveLength(1)

    // Vingt-neuf secondes plus tard : encore lisible.
    clockMs += 29_000
    runtime.expireNotifications()
    expect(runtime.state().notifications).toHaveLength(1)

    clockMs += 2_000
    runtime.expireNotifications()
    expect(runtime.state().notifications).toHaveLength(0)
  })

  it('ne fait pas tomber un signalement qui vient d\'arriver', async () => {
    // Le piège du filtre par lot : le plus ancien périme, pas toute la pile.
    const runtime = makeRuntime()
    await runtime.applyCommand(
      command({ type: 'message.broadcast', text: 'Premier', level: 'info', target: 'operator' }),
    )
    clockMs += 31_000
    await runtime.applyCommand(
      command({ type: 'message.broadcast', text: 'Second', level: 'info', target: 'operator' }),
    )

    runtime.expireNotifications()

    const restants = runtime.state().notifications
    expect(restants).toHaveLength(1)
    expect(restants[0]?.text).toContain('Second')
  })

  it('écarte une commande rattrapée après expiration', async () => {
    const runtime = makeRuntime()
    const lunch = command({ type: 'message.broadcast', text: 'Pause déjeuner', level: 'info' }, 600)

    // Reconnexion 40 minutes plus tard : le message n'a plus lieu d'être.
    clockMs += 40 * 60_000
    const outcome = await runtime.applyCommand(lunch)

    expect(outcome).toEqual({ applied: false, reason: 'expired' })
    expect(runtime.state().mode).toBe('loop')
    // Marquée appliquée malgré tout, sinon chaque reconnexion la relivrerait.
    expect(store.hasApplied(lunch.seq)).toBe(true)
  })

  it('ignore un rejeu de commande déjà appliquée', async () => {
    const setSceneRole = vi.fn(async () => {})
    const runtime = makeRuntime({ setSceneRole })
    const forced = command({ type: 'scene.force', role: 'HOLD' })

    await runtime.applyCommand(forced)
    const replay = await runtime.applyCommand(forced)

    expect(replay).toEqual({ applied: false, reason: 'already-applied' })
    expect(setSceneRole).toHaveBeenCalledTimes(1)
  })

  it('déclenche une resynchronisation sur invalidation du programme', async () => {
    const resync = vi.fn()
    const runtime = makeRuntime({ resync })
    await runtime.applyCommand(command({ type: 'program.invalidate', contentHash: 'hash-2' }))
    expect(resync).toHaveBeenCalledWith('hash-2')
  })

  it('ne boucle pas sur une commande pas encore supportée', async () => {
    const runtime = makeRuntime()
    const later = command({ type: 'wall.approved', commentId: 'c-1' })

    expect(await runtime.applyCommand(later)).toEqual({ applied: false, reason: 'unsupported' })
    // Sans marquage, la reconnexion suivante la relivrerait indéfiniment.
    expect(store.hasApplied(later.seq)).toBe(true)
    expect(await runtime.applyCommand(later)).toEqual({ applied: false, reason: 'already-applied' })
  })

  it('retire le message quand son TTL est écoulé', async () => {
    const runtime = makeRuntime()
    await runtime.applyCommand(
      command(
        { type: 'message.broadcast', text: 'Reprise dans 5 min', level: 'info', target: 'audience' },
        300,
      ),
    )
    expect(runtime.state().mode).toBe('message')

    clockMs += 301_000
    runtime.expireMessage()
    // Retour à l'écran d'attente par défaut, pas à une page figée.
    expect(runtime.state()).toMatchObject({ mode: 'loop', message: null })
  })
})

describe('état observé sur OBS', () => {
  it('fait foi sur l\'état local', () => {
    const runtime = makeRuntime()
    const seen: string[] = []
    runtime.on('state', (state) => seen.push(String(state.sceneRole)))

    // L'opérateur a basculé dans OBS directement : la régie doit suivre.
    runtime.observeSceneRole('LIVE')
    expect(runtime.state().sceneRole).toBe('LIVE')
    expect(seen).toContain('LIVE')
  })
})

describe('conférence pilotable', () => {
  /** Décale l'horloge du runtime à un instant donné (UTC). */
  const a = (iso: string) => {
    clockMs = Date.parse(iso)
    return makeRuntime()
  }

  it('vise la conférence en cours quand il y en a une', () => {
    // 10:20 UTC = 11:20 à Paris, en plein « HoneySwamp ».
    const runtime = a('2026-10-30T10:20:00Z')
    expect(runtime.state().targetSession?.title).toContain('HoneySwamp')
    expect(runtime.state().targetIsUpcoming).toBe(false)
  })

  it('vise la suivante dans un inter-créneau', () => {
    /**
     * Le cas signalé : 14:50 à Paris, soit 13:50 UTC. « Platform Engineering »
     * vient de finir, « Blind ops » commence à 14:55. Rien n'est en cours —
     * et c'est justement le moment où l'opérateur veut démarrer.
     */
    const runtime = a('2026-10-30T13:50:00Z')
    expect(runtime.state().currentSession).toBeNull()
    expect(runtime.state().targetSession?.title).toContain('Blind ops')
    expect(runtime.state().targetIsUpcoming).toBe(true)
  })

  it('vise le talk suivant pendant une pause', () => {
    // 14:20 UTC = 15:20 à Paris, en pleine « Pause café ».
    const runtime = a('2026-10-30T14:20:00Z')
    expect(runtime.state().currentSession?.kind).toBe('break')
    // Une pause ne se « démarre » pas : ce qu'on pilote, c'est le talk qui suit.
    expect(runtime.state().targetSession?.kind).toBe('talk')
    expect(runtime.state().targetSession?.title).toContain('DevEx')
  })

  it("n'a plus de cible après le dernier talk", () => {
    const runtime = a('2026-10-31T12:00:00Z')
    expect(runtime.state().targetSession).toBeNull()
  })
})

/**
 * Horloge de la salle.
 *
 * `serverTimeOffsetMs` part dans la charge utile d'affichage : les pages
 * servies l'ajoutent à **leur** `Date.now()` — elles n'ont que l'horloge du
 * navigateur — et la file de remontée date ses événements pareil. L'écart doit
 * donc se compter depuis la même horloge partout, sinon les deux moitiés du
 * client vivent à des dates différentes sans que rien ne le signale.
 */
describe('horloge de la salle', () => {
  /** Sans horloge injectée : comme en salle, où il n'y en a qu'une. */
  const enSalle = () => {
    const runtime = new RoomRuntime(store)
    runtime.setRoomId(TRACK_1)
    runtime.setProgram('hash-1', program)
    return runtime
  }

  it('donne la même heure au cœur applicatif et aux pages', () => {
    const runtime = enSalle()

    runtime.setServerTime('2026-10-30T10:20:00.000Z')

    const vuParUnePage = Date.now() + runtime.state().serverTimeOffsetMs
    expect(Math.abs(vuParUnePage - runtime.correctedNow())).toBeLessThan(50)
    expect(new Date(runtime.correctedNow()).toISOString()).toMatch(/^2026-10-30T10:20/)
  })

  it('laisse l\'heure du hub reprendre la main sur une heure simulée locale', () => {
    /**
     * Le défaut signalé : une salle lancée en heure simulée, puis raccordée à
     * un hub lui aussi simulé, cumulait les deux écarts. La régie cherchait ses
     * conférences des semaines après la fin de l'événement — « aucune
     * conférence à piloter » — pendant que le flux des autres salles, calculé
     * dans la page, tombait juste.
     */
    const runtime = enSalle()
    runtime.setClockOffset(Date.parse('2026-10-30T16:00:00Z') - Date.now(), true)

    runtime.setServerTime('2026-10-30T10:20:00.000Z')

    expect(new Date(runtime.correctedNow()).toISOString()).toMatch(/^2026-10-30T10:20/)
    // Et la conférence en cours suit, sans attendre le tic d'horloge suivant.
    expect(runtime.state().currentSession?.title).toContain('HoneySwamp')
  })

  it('recalcule la timeline dès que l\'heure bouge', () => {
    // Attendre le tic laisserait l'écran désigner le mauvais talk pendant 5 s.
    const runtime = enSalle()

    runtime.setServerTime('2026-10-30T07:00:00.000Z')
    const matin = runtime.state().currentSession?.title

    runtime.setServerTime('2026-10-30T10:20:00.000Z')

    expect(runtime.state().currentSession?.title).toContain('HoneySwamp')
    expect(runtime.state().currentSession?.title).not.toBe(matin)
  })
})

/**
 * Bandeau des scènes live.
 *
 * Il se superpose à la vidéo au lieu de prendre l'écran : c'est toute la
 * différence avec un message diffusé au public, et la raison d'être d'une
 * surface séparée.
 */
describe('bandeau live', () => {
  it('affiche un bandeau sans rien interrompre', async () => {
    const runtime = makeRuntime()
    await runtime.applyCommand(command({ type: 'display.set', mode: 'programme' }))

    await runtime.applyCommand(
      command({ type: 'overlay.set', message: { text: 'Reprise dans 5 min', level: 'info' } }),
    )

    expect(runtime.state().liveMessage).toMatchObject({ text: 'Reprise dans 5 min', level: 'info' })
    // Ni l'écran de salle ni la scène ne bougent : le talk continue dessous.
    expect(runtime.state().mode).toBe('programme')
    expect(runtime.state().message).toBeNull()
  })

  it('se retire sur ordre de la console', async () => {
    const runtime = makeRuntime()
    await runtime.applyCommand(
      command({ type: 'overlay.set', message: { text: 'Micro en panne', level: 'warning' } }),
    )

    await runtime.applyCommand(command({ type: 'overlay.set', message: null }))

    expect(runtime.state().liveMessage).toBeNull()
  })

  it('expire tout seul quand il a une durée', async () => {
    const runtime = makeRuntime()
    await runtime.applyCommand(
      command({ type: 'overlay.set', message: { text: 'Bientôt', level: 'info' } }, 60),
    )
    expect(runtime.state().liveMessage).not.toBeNull()

    clockMs += 61_000
    runtime.expireMessage()

    // Il ne ramène rien en se retirant : il ne s'était substitué à rien.
    expect(runtime.state().liveMessage).toBeNull()
    expect(runtime.state().mode).toBe('loop')
  })
})

/**
 * Question du public, canal distinct du bandeau.
 *
 * Les deux ont longtemps partagé `liveMessage`. Conséquence : un « on reprend
 * dans 5 minutes » envoyé du hub s'affichait à la place de la question, et
 * aucune surface ne pouvait montrer l'un sans risquer l'autre. Or ils ne vont
 * pas au même endroit — la question a sa place dans la VOD, le message
 * d'exploitation non.
 */
describe('question à l\'antenne', () => {
  it('vit à côté du bandeau, sans le toucher', async () => {
    const runtime = makeRuntime()
    runtime.setQuestion('Et les faux positifs ?', 'Camille', runtime.state().targetSession?.id ?? null)

    await runtime.applyCommand(
      command({ type: 'overlay.set', message: { text: 'Reprise dans 5 min', level: 'info' } }),
    )

    // Le bandeau de la console n'écrase pas la question, et réciproquement.
    expect(runtime.state().question).toMatchObject({ text: 'Et les faux positifs ?', author: 'Camille' })
    expect(runtime.state().liveMessage).toMatchObject({ text: 'Reprise dans 5 min' })
  })

  it('n\'est jamais posée par une commande de bandeau', async () => {
    const runtime = makeRuntime()

    await runtime.applyCommand(
      command({ type: 'overlay.set', message: { text: 'Micro en panne', level: 'warning' } }),
    )

    expect(runtime.state().question).toBeNull()
  })

  it('tombe au changement de conférence', () => {
    // Sans ça, elle reste incrustée dans l'habillage de captation pendant que
    // le speaker suivant s'installe — gravée dans sa VOD, adressée à un autre.
    const runtime = makeRuntime()
    const talk = runtime.state().targetSession!
    runtime.setQuestion('Et les faux positifs ?', null, talk.id)

    clockMs = talk.endsAtMs! + 20 * 60_000
    runtime.refreshSessions()

    expect(runtime.state().targetSession?.id).not.toBe(talk.id)
    expect(runtime.state().question).toBeNull()
  })

  it('reste tant que la conférence pilotée ne change pas', () => {
    const runtime = makeRuntime()
    const talk = runtime.state().targetSession!
    runtime.setQuestion('Et les faux positifs ?', null, talk.id)

    clockMs += 60_000
    runtime.refreshSessions()

    expect(runtime.state().question).not.toBeNull()
  })

  it('se retire depuis la régie', () => {
    const runtime = makeRuntime()
    runtime.setQuestion('Et les faux positifs ?', null, null)

    runtime.setQuestion(null, null, null)

    expect(runtime.state().question).toBeNull()
  })
})

/**
 * La conférence pilotée saute ce qui ne se tiendra plus.
 *
 * La régie autorise « Commencer » — puis « Terminer » — sur une conférence
 * dont le créneau n'a pas encore commencé. La cible restait ensuite collée
 * dessus jusqu'à l'heure prévue : une heure pendant laquelle l'opérateur ne
 * pouvait pas piloter la conférence suivante, et pendant laquelle le grand
 * compte à rebours décomptait jusqu'au début d'un talk déjà clos.
 */
describe('cible des commandes et cycle de vie', () => {
  /**
   * 08:10 UTC — 09:10 à Paris : la keynote d'ouverture court, et c'est un
   * créneau sans intervenant, donc une pause. Le talk suivant est à 08:50 UTC.
   */
  const AVANT = Date.parse('2026-10-30T08:10:00.000Z')

  it('vise la prochaine conférence quand rien ne se joue', () => {
    clockMs = AVANT
    const runtime = makeRuntime()

    expect(runtime.state().targetSession?.title).toBe('IA for OPS on Scaleway')
    expect(runtime.state().targetIsUpcoming).toBe(true)
  })

  it('passe à la suivante dès qu’on termine celle qui n’a pas commencé', () => {
    clockMs = AVANT
    const runtime = makeRuntime()
    const terminee = runtime.state().targetSession!

    runtime.setSessionStatus(terminee.id, 'ended')

    // Sans attendre le tic d'horloge : le geste vient d'être posé, et c'est
    // maintenant qu'on veut pouvoir lancer la conférence d'après.
    const cible = runtime.state().targetSession
    expect(cible?.id).not.toBe(terminee.id)
    expect(cible?.kind).toBe('talk')
    expect(cible!.startsAtMs).toBeGreaterThan(terminee.startsAtMs)
  })

  it('reste sur une conférence terminée pendant son propre créneau', () => {
    // Terminer en avance pendant le créneau laisse la conférence pilotée : le
    // geste se répare depuis la carte, « Remettre à venir » à portée.
    clockMs = Date.parse('2026-10-30T10:20:00.000Z')
    const runtime = makeRuntime()
    const courante = runtime.state().targetSession!

    runtime.setSessionStatus(courante.id, 'ended')

    expect(runtime.state().targetSession?.id).toBe(courante.id)
  })

  /**
   * Le cas signalé en régie : conférence lancée à 08:59, horloge avancée à
   * 09:44 puis 09:45. À la seconde où le créneau se fermait, la régie basculait
   * sur le compte à rebours du talk suivant et « Terminer » disparaissait —
   * alors que le speaker parlait encore. Le dépassement est précisément le
   * moment où ce bouton est le seul qui compte.
   */
  it('reste sur la conférence en cours quand son créneau est dépassé', () => {
    clockMs = AVANT
    const runtime = makeRuntime()
    const lancee = runtime.state().targetSession!
    runtime.setSessionStatus(lancee.id, 'running')

    // Une seconde après la fin prévue du créneau : le talk est en dépassement.
    clockMs = lancee.endsAtMs! + 1_000
    runtime.refreshSessions()

    expect(runtime.state().currentSession?.id).not.toBe(lancee.id)
    expect(runtime.state().targetSession?.id).toBe(lancee.id)
    // Ni « à venir » — elle est à l'antenne — ni impilotable.
    expect(runtime.state().targetIsUpcoming).toBe(false)
    expect(runtime.currentSessionStatus()).toBe('running')
  })

  it("rend la main à la suivante une fois le dépassement terminé", () => {
    clockMs = AVANT
    const runtime = makeRuntime()
    const lancee = runtime.state().targetSession!
    runtime.setSessionStatus(lancee.id, 'running')

    clockMs = lancee.endsAtMs! + 1_000
    runtime.refreshSessions()
    runtime.setSessionStatus(lancee.id, 'ended')

    const cible = runtime.state().targetSession
    expect(cible?.id).not.toBe(lancee.id)
    expect(cible?.kind).toBe('talk')
  })

  /**
   * Un talk oublié ouvert le matin ne doit pas capturer la régie de la journée.
   * Le créneau courant prime : c'est ce que la salle est en train de vivre.
   */
  it('préfère le créneau courant à une conférence restée ouverte', () => {
    clockMs = AVANT
    const runtime = makeRuntime()
    const oubliee = runtime.state().targetSession!
    runtime.setSessionStatus(oubliee.id, 'running')

    // 11:20 à Paris : « HoneySwamp » a son propre créneau.
    clockMs = Date.parse('2026-10-30T10:20:00.000Z')
    runtime.refreshSessions()

    expect(runtime.state().targetSession?.title).toContain('HoneySwamp')
    expect(runtime.state().targetIsUpcoming).toBe(false)
  })

  it('reprend la conférence quand la décision est annulée', () => {
    clockMs = AVANT
    const runtime = makeRuntime()
    const terminee = runtime.state().targetSession!

    runtime.setSessionStatus(terminee.id, 'ended')
    runtime.setSessionStatus(terminee.id, 'scheduled')

    expect(runtime.state().targetSession?.id).toBe(terminee.id)
  })
})

/**
 * Les gestes venus d'une régie mobile.
 *
 * Ils empruntent le flux descendant comme le reste, donc les deux filtres qui le
 * gouvernent : l'expiration d'abord, le rejeu ensuite. Ce qui compte ici est
 * qu'ils s'y plient — un « enregistre » rattrapé une demi-heure plus tard, ou
 * appliqué deux fois à la reconnexion, coûterait une prise.
 */
describe('commandes de régie mobile', () => {
  it('lance et arrête la captation, en nommant qui l’a demandé', async () => {
    const captations: boolean[] = []
    const runtime = makeRuntime({ setRecording: (on: boolean) => captations.push(on) })

    await runtime.applyCommand(
      command({ type: 'recording.set', on: true, requestedBy: 'regie@cloudnord.fr' }, 90),
    )
    await runtime.applyCommand(
      command({ type: 'recording.set', on: false, requestedBy: 'regie@cloudnord.fr' }, 90),
    )

    expect(captations).toEqual([true, false])
    /*
     * Signalé en régie, et pas seulement au journal.
     *
     * Un enregistrement qui démarre sans que personne n'ait touché au clavier de
     * la salle se lit comme une panne d'OBS. Nommer qui l'a demandé évite qu'on
     * aille chercher le défaut là où il n'y en a pas.
     */
    const dernier = runtime.state().notifications.at(-1)
    expect(dernier?.text).toContain('regie@cloudnord.fr')
    expect(dernier?.text).toContain('Enregistrement arrêté')
  })

  it('bascule la diffusion de la même façon', async () => {
    const diffusions: boolean[] = []
    const runtime = makeRuntime({ setStreaming: (on: boolean) => diffusions.push(on) })

    await runtime.applyCommand(
      command({ type: 'stream.set', on: true, requestedBy: 'regie@cloudnord.fr' }, 90),
    )
    expect(diffusions).toEqual([true])
  })

  it('écarte une captation rattrapée trop tard, mais la marque quand même', async () => {
    const captations: boolean[] = []
    const runtime = makeRuntime({ setRecording: (on: boolean) => captations.push(on) })

    // Émise il y a plus longtemps que sa durée de validité : une salle coupée
    // dix minutes ne doit pas se mettre à enregistrer toute seule au retour.
    clockMs = Date.parse(ISSUED_AT) + 91_000
    const outcome = await runtime.applyCommand(
      command({ type: 'recording.set', on: true, requestedBy: 'regie@cloudnord.fr' }, 90),
    )

    expect(outcome).toEqual({ applied: false, reason: 'expired' })
    expect(captations).toEqual([])
  })

  it('ne rejoue pas une commande déjà appliquée', async () => {
    const captations: boolean[] = []
    const runtime = makeRuntime({ setRecording: (on: boolean) => captations.push(on) })
    const rejouee = command({ type: 'recording.set', on: true, requestedBy: null }, 90)

    await runtime.applyCommand(rejouee)
    // Le rattrapage d'une reconnexion peut relivrer ce qui est déjà appliqué.
    const seconde = await runtime.applyCommand(rejouee)

    expect(seconde).toEqual({ applied: false, reason: 'already-applied' })
    expect(captations).toEqual([true])
  })

  it('affiche qui pilote la salle à distance, sans rien verrouiller', async () => {
    const runtime = makeRuntime()

    await runtime.applyCommand(command({ type: 'regie.hold', holder: 'regie@cloudnord.fr' }))
    expect(runtime.state().remoteHolder).toBe('regie@cloudnord.fr')

    // Rendu : le badge s'éteint. C'est ce que publie le balayage du hub quand
    // un verrou expire, faute de quoi l'écran garderait un porteur parti.
    await runtime.applyCommand(command({ type: 'regie.hold', holder: null }))
    expect(runtime.state().remoteHolder).toBeNull()
  })
})
