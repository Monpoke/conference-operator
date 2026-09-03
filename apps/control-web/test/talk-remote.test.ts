import type { ControlCommand, ControlView } from '@cloudnord/contract'
import { useToast } from '@cloudnord/components'
import { flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { payloadDepuisVue } from '../src/lib/gateway.js'
import { useTalkStore } from '../src/stores/conference.js'
import { useGatewayStore } from '../src/stores/gateway.js'
import { useRoomStore } from '../src/stores/room.js'
import { useSessionStore } from '../src/stores/session.js'
import { talk } from './fixtures.js'

/**
 * Les garde-fous de « Commencer » ne dépendent pas du transport.
 *
 * `conference.ts` est un seul chemin, en salle comme sur un téléphone : c'est
 * tout l'intérêt de la porte. Ce fichier vérifie qu'il le reste — et surtout que
 * la règle qui coûte une VOD quand elle tombe tient encore de l'autre côté :
 * **si l'enregistrement ne part pas, la conférence ne commence pas.**
 *
 * Cette règle est la plus fragile des deux côtés, et pour une raison qui ne se
 * devine pas : en salle, `recording.start` répond quand OBS a répondu ; à
 * distance, le hub répond quand il a mis la commande en file. Prise telle
 * quelle, la garantie disparaissait sans que rien ne le dise.
 */

const AT = Date.parse('2026-10-30T08:59:00.000Z')

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
    conference: 'pas-commencee',
    targetSession: talk(),
    targetIsUpcoming: true,
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

let commandes: ControlCommand[]

/**
 * Monte la régie en portée distante, sur une salle donnée.
 *
 * `vues` est la file que le sondage consomme : c'est ainsi qu'on décrit « la
 * salle finit par confirmer » et « la salle ne confirme jamais ».
 */
function distante(vues: ControlView[]): void {
  commandes = []
  let restantes = [...vues]

  const porte = useGatewayStore()
  porte.start({ portee: 'distante', roomId: 'track-1', salles: [], google: null })

  const session = useSessionStore()
  session.client = {
    rpc: {
      regie: {
        view: async () => (restantes.length > 1 ? restantes.shift()! : restantes[0]!),
        command: async ({ action }: { action: ControlCommand }) => {
          commandes.push(action)
          return { ok: true, applied: 'queued' as const }
        },
      },
    },
  } as never

  // L'état que le premier sondage aurait posé : les garde-fous le lisent, et
  // c'est exactement la charge utile que la porte synthétise en vrai.
  useRoomStore().seed(payloadDepuisVue(vues[0]!, Date.now()))

  /*
   * L'horloge est substituée, et le sondage n'est pas lancé.
   *
   * La confirmation par observation est bornée par un délai de garde : l'exercer
   * en temps réel ferait dormir la suite cinq secondes pour une règle qui tient
   * en trois lignes. La porte se fabrique au premier geste — exactement ce qui
   * arrive en vrai quand un bouton est pressé avant que le flux ne soit branché.
   */
  let horloge = Date.now()
  porte.configurer({
    maintenant: () => horloge,
    attendre: async (ms) => {
      horloge += ms
    },
  })
}

beforeEach(() => {
  setActivePinia(createPinia())
  useToast().clear()
  /*
   * Faute de jeton, le store demande au hub s'il reste une session par cookie —
   * un vrai appel, et le seul de ces écrans qui ne passe pas par le client
   * oRPC. Y répondre « personne » vaut mieux que le laisser pendre : happy-dom
   * l'interrompt au démontage, et la trace ressemble à une panne.
   */
  vi.stubGlobal('fetch', async () => new Response('{}', { status: 401 }))
})

const types = (): string[] => commandes.map((commande) => commande.type)

describe('commencer, depuis un téléphone', () => {
  it('pose la même question sur l’enregistrement qu’en salle', async () => {
    distante([vue({ recording: false, promptRecordingOnStart: true })])
    const conference = useTalkStore()

    conference.askStart()
    await flushPromises()

    /*
     * Le réglage voyage dans la vue. Sans lui, la page retomberait sur son
     * défaut et la question posée sur un téléphone ne serait pas celle posée
     * en salle — deux opérateurs, deux avertissements différents.
     */
    expect(conference.recordingOpen).toBe(true)
    expect(types()).toEqual([])
  })

  it('se tait quand la salle a décoché l’avertissement', async () => {
    distante([vue({ recording: false, promptRecordingOnStart: false })])
    const conference = useTalkStore()

    conference.askStart()
    await flushPromises()

    expect(conference.recordingOpen).toBe(false)
    // Le cycle de vie, puis la scène : la bascule suit le démarrage, jamais
    // l'inverse — une scène prise sans conférence lancée mettrait la salle à
    // l'antenne sur rien.
    expect(types()).toEqual(['session.start', 'scene.set'])
  })

  it('enchaîne captation, conférence, puis scène quand la salle confirme', async () => {
    distante([vue({ recording: false }), vue({ recording: true })])
    const conference = useTalkStore()

    await conference.launch(true)

    expect(types()).toEqual(['recording.set', 'session.start', 'scene.set'])
  })

  it('ne commence pas quand l’enregistrement ne part pas', async () => {
    /*
     * La règle qui coûte une VOD quand elle tombe.
     *
     * La salle ne confirme jamais : le hub a bien mis la commande en file — il
     * a répondu 200 —, mais rien n'a démarré. Commencer quand même rendrait
     * l'avertissement mensonger la fois suivante, et une VOD absente ne se
     * rattrape pas le soir.
     */
    distante([vue({ recording: false })])
    const conference = useTalkStore()

    await conference.launch(true)

    expect(types()).toEqual(['recording.set'])
    expect(useToast().notices.value.at(-1)?.text).toContain("n'a pas démarré")
  })

  it('ne bascule aucune scène quand la salle a choisi de ne pas basculer', async () => {
    distante([vue({ recording: true, sceneOnStart: null })])
    const conference = useTalkStore()

    await conference.launch(false)

    expect(types()).toEqual(['session.start'])
  })
})

describe('terminer, depuis un téléphone', () => {
  it('confirme en avance, et dit ce qu’il reste au créneau', async () => {
    distante([vue({ conference: 'en-cours', sessionStates: { 'talk-1': 'running' } })])
    const conference = useTalkStore()

    conference.askEnd()
    await flushPromises()

    // « Terminer » est à côté de « Commencer », et le voisinage se paie une
    // fois par événement : en avance, il se confirme.
    expect(conference.endEarlyOpen).toBe(true)
    expect(types()).toEqual([])
    expect(conference.endEarlyDetail).toContain('rien dans la salle')
  })

  it('termine sans rien demander une fois l’heure passée', async () => {
    const apres = Date.parse('2026-10-30T09:50:00.000Z')
    distante([
      vue({
        serverTime: new Date(apres).toISOString(),
        conference: 'depassement',
        sessionStates: { 'talk-1': 'running' },
      }),
    ])
    const conference = useTalkStore()

    conference.askEnd()
    await flushPromises()

    // Le geste normal de la journée : le confirmer à chaque fois en ferait un
    // réflexe, ce qui revient à ne plus le lire.
    expect(conference.endEarlyOpen).toBe(false)
    expect(types()).toEqual(['session.end'])
  })
})
