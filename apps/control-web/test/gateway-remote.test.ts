import type { ControlCommand, ControlView } from '@cloudnord/contract'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  OBSERVATION_MS,
  payloadFromView,
  remoteGateway,
  translate,
  type ActionResult,
  type StateSink,
} from '../src/lib/gateway.js'
import { talk } from './fixtures.js'

/**
 * La porte du hub, et la seule chose qu'elle promet.
 *
 * `regie.command` répond quand le hub a **mis la commande en file**. Que la
 * salle ait obéi ne s'observe que sur la vue suivante. Toute la valeur de ce
 * fichier tient dans cette distinction : c'est elle qui décide si
 * l'avertissement de « Commencer » reste honnête, ou s'il devient un mensonge
 * qu'on découvre en relisant la VOD.
 */

const AT = Date.parse('2026-10-30T09:10:00.000Z')

function vue(overrides: Partial<ControlView> = {}): ControlView {
  return {
    roomId: 'track-1',
    roomName: 'Track #1',
    event: { name: 'Cloud Nord 2026', shortName: 'Cloud Nord' },
    timezone: 'Europe/Paris',
    serverTime: new Date(AT).toISOString(),
    simulatedClock: false,
    connectivity: 'ONLINE',
    lastSeenAt: new Date(AT).toISOString(),
    conference: 'en-cours',
    targetSession: talk(),
    targetIsUpcoming: false,
    sessionStates: {},
    sessions: [talk()],
    sceneRole: 'HOLD',
    recording: false,
    streaming: false,
    displayMode: 'loop',
    sceneRoles: ['LIVE', 'HOLD'],
    relaySourceRoomId: null,
    promptRecordingOnStart: true,
    promptRecordingOnStop: true,
    sceneOnStart: 'LIVE',
    lock: null,
    ...overrides,
  }
}

/**
 * Un client oRPC réduit à ce que la porte appelle.
 *
 * `vues` est une file : chaque sondage en consomme une, et la dernière tient
 * ensuite. C'est ce qui permet de décrire « la salle finit par confirmer » et
 * « la salle ne confirme jamais » avec le même outil.
 */
function clientFactice(vues: ControlView[]) {
  const commandes: ControlCommand[] = []
  let restantes = [...vues]
  return {
    commandes,
    client: {
      rpc: {
        regie: {
          view: async () => {
            const suivante = restantes.length > 1 ? restantes.shift()! : restantes[0]!
            return suivante
          },
          command: async ({ action }: { action: ControlCommand }) => {
            commandes.push(action)
            return { ok: true, applied: 'queued' as const }
          },
        },
      },
    } as never,
  }
}

const silentStream: StateSink = { onPayload: () => {}, onOutage: () => {} }

describe('translate un geste de régie', () => {
  it('porte la cible du cycle de vie, prise sur la vue', () => {
    // La cible voyage explicitement : le créneau visé peut tourner entre le
    // rendu et le clic, et c'est là qu'une cible implicite lance le mauvais talk.
    expect(translate({ action: 'session.start' }, vue())).toEqual({
      type: 'session.start',
      sessionId: 'talk-1',
    })
  })

  it('refuse le cycle de vie quand la salle ne pilote aucune conférence', () => {
    expect(translate({ action: 'session.end' }, vue({ targetSession: null }))).toBeNull()
  })

  it('rend un état plutôt qu’un verbe pour la captation et la diffusion', () => {
    /*
     * `on: boolean` et non `start`/`stop` : une commande rattrapée décrit alors
     * une intention encore lisible, et l'appliquer deux fois ne coûte rien — ce
     * qui compte sur un flux au-moins-une-fois.
     */
    expect(translate({ action: 'recording.start' }, vue())).toEqual({
      type: 'recording.set',
      on: true,
    })
    expect(translate({ action: 'stream.stop' }, vue())).toEqual({ type: 'stream.set', on: false })
  })

  it('emporte l’écran de salle, qui passe par le flux descendant', () => {
    /*
     * Le mode d'écran ne demande rien de plus qu'une bascule de scène : la
     * commande existe déjà côté salle, et le hub sait la publier. C'est ce qui
     * permet de le piloter d'un téléphone sans rien ajouter entre lui et la
     * machine de salle.
     */
    expect(translate({ action: 'display.set', mode: 'sponsors' }, vue())).toEqual({
      type: 'display.set',
      mode: 'sponsors',
    })
  })

  it('écarte tout ce qui demande la machine de salle', () => {
    // Les marqueurs, la VOD, le ⚙ : le hub n'a ni le disque ni les instances
    // OBS. La table courte *est* la définition du périmètre.
    for (const action of [
      'recording.mark',
      'vod.upload',
      'room.configure',
      'obs.connect',
      'message.send',
    ]) {
      expect(translate({ action }, vue())).toBeNull()
    }
  })
})

describe('poster un geste', () => {
  let gateway: ReturnType<typeof remoteGateway>
  let horloge: number

  function ouvrir(vues: ControlView[]) {
    horloge = AT
    const { client, commandes } = clientFactice(vues)
    gateway = remoteGateway({
      client,
      roomId: 'track-1',
      now: () => horloge,
      // L'attente avance l'horloge de test plutôt que de dormir : le délai de
      // garde se vérifie en millisecondes simulées.
      wait: async (ms) => {
        horloge += ms
      },
    })
    return commandes
  }

  beforeEach(() => {
    horloge = AT
  })

  it('refuse en toutes lettres ce qui demande la régie de la salle', async () => {
    ouvrir([vue()])
    const resultat: ActionResult = await gateway.act({ action: 'recording.mark', label: 'x' })
    // Laisser l'appel échouer sur un refus du hub donnerait un rouge sans
    // explication, là où la raison tient en une phrase.
    expect(resultat).toEqual({ ok: false, message: 'Ce geste demande la régie de la salle' })
  })

  it('n’attend rien derrière une bascule de scène', async () => {
    const commandes = ouvrir([vue()])
    gateway.start(silentStream)
    const resultat = await gateway.act({ action: 'scene.set', role: 'LIVE' })
    gateway.stop()

    expect(commandes).toEqual([{ type: 'scene.set', role: 'LIVE' }])
    // La bascule se lit sur le bouton au sondage suivant, comme en régie de
    // salle : personne n'enchaîne dessus.
    expect(resultat.ok).toBe(true)
  })

  it('confirme la captation par l’observation, pas par la réponse', async () => {
    /*
     * Le hub répond « en file » ; la salle est peut-être coupée, OBS peut
     * refuser. Sans cette attente, `launch()` enchaînerait sur `session.start`
     * en croyant enregistrer — et l'avertissement de « Commencer » deviendrait
     * un mensonge qu'on découvre le soir, devant une VOD absente.
     */
    ouvrir([vue({ recording: false }), vue({ recording: true })])
    const resultat = await gateway.act({ action: 'recording.start' })
    expect(resultat.ok).toBe(true)
  })

  it('déclare la captation manquée quand la salle ne confirme jamais', async () => {
    ouvrir([vue({ recording: false })])
    const debut = horloge
    const resultat = await gateway.act({ action: 'recording.start' })

    expect(resultat.ok).toBe(false)
    expect(resultat.message).toContain("n'a pas démarré")
    // Borné : une salle coupée ne doit pas laisser la page attendre sans fin.
    expect(horloge - debut).toBeGreaterThanOrEqual(OBSERVATION_MS)
  })
})

describe('la vue rendue sous la forme que lisent les panneaux', () => {
  it('installe l’écart à l’horloge du hub, pas celle du téléphone', () => {
    // L'horloge du hub fait foi et peut être simulée : en développement l'écart
    // se compte en semaines, et le navigateur n'a que la sienne.
    const rendue = payloadFromView(vue(), AT - 60_000)
    expect(rendue.state.serverTimeOffsetMs).toBe(60_000)
  })

  it('porte les garde-fous du démarrage, pour que la question soit la même qu’en salle', () => {
    const rendue = payloadFromView(vue({ promptRecordingOnStart: false, sceneOnStart: null }), AT)
    expect(rendue.diagnostics?.config?.promptRecordingOnStart).toBe(false)
    expect(rendue.diagnostics?.config?.sceneOnStart).toBeNull()
  })

  it('n’offre que les rôles de scène que la salle a mappés', () => {
    const rendue = payloadFromView(vue({ sceneRoles: ['LIVE', 'HOLD'] }), AT)
    expect(Object.keys(rendue.diagnostics!.config!.sceneRoles.A)).toEqual(['LIVE', 'HOLD'])
  })

  it('installe l’écran que la salle a remonté, pas celui qu’on a demandé', () => {
    // Le panneau lit `state.mode` : c'est lui qui décide quel bouton s'allume,
    // et il doit décrire la salle, jamais l'intention.
    expect(payloadFromView(vue({ displayMode: 'feedback' }), AT).state.mode).toBe('feedback')
  })

  it('retombe sur la boucle quand la salle n’a pas encore battu', () => {
    /*
     * `loop` n'est pas un remplissage : c'est l'état dans lequel une salle
     * démarre. Une salle qui n'a rien remonté montre donc bien la boucle — et
     * si elle est coupée, la connectivité le dit déjà à côté.
     */
    expect(payloadFromView(vue({ displayMode: null }), AT).state.mode).toBe('loop')
  })

  it('laisse vide ce que le hub ne sait pas, plutôt que de l’inventer', () => {
    const rendue = payloadFromView(vue({ recording: true }), AT)
    /*
     * Le hub ne stocke qu'un booléen. Une heure de départ plausible à côté d'un
     * point rouge juste ferait afficher une durée fausse — et douter des deux.
     * Les repères de editing tombent avec : ils vivent dans la prise, sur la
     * machine de salle, et le hub n'en sait rien.
     */
    expect(rendue.diagnostics?.recording).toEqual({
      active: true,
      markers: 0,
      startedAtMs: null,
      startedAtCorrectedMs: null,
      editing: { startMs: null, endMs: null },
    })
    // `remoteHolder` dit à une *salle* qu'on la pilote de loin ; sur le
    // téléphone qui la pilote, il n'a personne à prévenir.
    expect(rendue.state.remoteHolder).toBeNull()
    // Aucun appairage : c'est une affaire de machine de salle, et un voile
    // d'appairage sur un téléphone n'aurait aucun code à afficher.
    expect(rendue.pairing).toBeNull()
  })
})
