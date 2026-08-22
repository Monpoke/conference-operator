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
