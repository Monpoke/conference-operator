import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHub, type Hub } from '@cloudnord/hub-server/server'
import { provisionOperator } from '@cloudnord/hub-server/operators'
import { createORPCClient } from '@orpc/client'
import { RPCLink } from '@orpc/client/fetch'
import type { ContractRouterClient } from '@orpc/contract'
import { contract } from '@cloudnord/contract'
import { RoomApp } from '../src/core/room-app.js'
import type { ObsTransport } from '../src/core/obs.js'
import type { DisplayPayload } from '../src/core/display-server.js'

const rawProgram = readFileSync(
  fileURLToPath(new URL('../../../packages/program/test/fixtures/cloudnord-2026.json', import.meta.url)),
  'utf8',
)

const OPERATOR = { email: 'regie@cloudnord.fr', name: 'Régie', password: 'motdepasse-regie-2026' }
const CLIENT_ID = '01JB2ZK5T7QW9V0YHRXM3N4P6C'
const TRACK_1 = 'track-1-teilhard-de-chardin'
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** OBS factice : les scènes de la salle, sans instance réelle. */
function fakeObs(scenes = ['Capture HDMI', 'Habillage']) {
  const handlers = new Map<string, ((payload: unknown) => void)[]>()
  let current = scenes[1] ?? scenes[0]!
  const transport: ObsTransport = {
    connect: vi.fn(async () => {}),
    disconnect: vi.fn(async () => {}),
    call: (async (request: string, args?: Record<string, unknown>) => {
      if (request === 'GetSceneList') {
        return { currentProgramSceneName: current, scenes: scenes.map((sceneName) => ({ sceneName })) }
      }
      if (request === 'SetCurrentProgramScene') {
        current = args!.sceneName as string
        for (const h of handlers.get('CurrentProgramSceneChanged') ?? []) h({ sceneName: current })
      }
      return {}
    }) as ObsTransport['call'],
    on: (event, handler) => {
      const list = handlers.get(event) ?? []
      list.push(handler as (payload: unknown) => void)
      handlers.set(event, list)
    },
  }
  return {
    transport,
    get currentScene() { return current },
    /** Ce qu'OBS pousse de lui-même : un enregistrement lancé sur la machine. */
    emettre(event: string, payload: unknown) {
      for (const h of handlers.get(event) ?? []) h(payload)
    },
  }
}

let hub: Hub
let origin: string
let dir: string
let room: RoomApp
let obs: ReturnType<typeof fakeObs>

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'cloudnord-app-'))
  hub = await createHub({
    port: 0,
    host: '127.0.0.1',
    databasePath: ':memory:',
    publicUrl: 'http://127.0.0.1',
    authSecret: 'test-secret-'.padEnd(48, 'x'),
    logLevel: 'fatal',
    devicePollInterval: '1s',
  })
  await hub.app.listen({ port: 0, host: '127.0.0.1' })
  const address = hub.app.server.address()
  origin = `http://127.0.0.1:${typeof address === 'object' && address != null ? address.port : 0}`

  await provisionOperator(hub.auth, OPERATOR)
  hub.services.programs.importFromText(rawProgram, 'https://exemple/programme.json')
  hub.services.rooms.upsert({
    id: TRACK_1,
    name: 'Track #1',
    trackId: TRACK_1,
    obs: {
      A: { url: 'ws://127.0.0.1:4455', password: null },
      B: { url: 'ws://127.0.0.1:4456', password: null },
    },
    sceneRoles: { A: { LIVE: 'Capture HDMI', HOLD: 'Habillage' }, B: { TALK: 'Talk' } },
    displayPort: 7788,
    recordingRoot: null,
  })

  obs = fakeObs()
})

afterEach(async () => {
  await room?.close()
  await hub.close().catch(() => {})
  rmSync(dir, { recursive: true, force: true })
})

function makeApp(hubOrigin = origin) {
  let token: string | null = null
  const app = new RoomApp({
    dataDir: dir,
    hubOrigin,
    clientId: CLIENT_ID,
    // Salle connue d'avance : ces tests n'ont pas d'écran pour la choisir.
    roomId: TRACK_1,
    readToken: () => token,
    writeToken: (value) => {
      token = value
    },
    displayPort: 0,
    obsTransportFactory: () => obs.transport,
    onPairingCode: (code) => {
      // L'opérateur approuve depuis l'admin pendant que la machine sonde.
      void (async () => {
        const response = await fetch(`${origin}/api/auth/sign-in/email`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ email: OPERATOR.email, password: OPERATOR.password }),
        })
        const session = (await response.json()) as { token: string }
        const admin: ContractRouterClient<typeof contract> = createORPCClient(
          new RPCLink({
            origin,
            url: '/rpc',
            headers: () => ({ authorization: `Bearer ${session.token}` }),
          }),
        )
        await admin.devices.approve({
          userCode: code.user_code,
          clientId: CLIENT_ID,
          roomId: TRACK_1,
          label: 'PC régie salle 1',
        })
      })()
    },
  })
  return app
}

describe('machine de salle, démarrage complet', () => {
  it('sert l\'écran avant même de parler au hub', async () => {
    room = makeApp('http://127.0.0.1:1') // hub volontairement injoignable
    const url = await room.startDisplay()

    // La règle centrale du projet : la salle projette, quoi qu'il arrive.
    const page = await fetch(`${url}/display/projector`)
    expect(page.status).toBe(200)

    const token = await room.ensurePaired()
    expect(token).toBeNull()
  }, 20_000)

  it('annonce au transport les scènes que la salle attend', async () => {
    /*
     * Le vrai client les ignore — un OBS a les scènes qu'on y a créées, et
     * c'est justement l'écart qui doit se voir en rouge. Le simulateur, lui,
     * s'en sert pour exister avec les scènes qu'on attend de lui : sans ça,
     * tout nom un peu personnel ressortait « rôle introuvable » sur une
     * instance qui n'existe pas.
     */
    const recus: [string, string[]][] = []
    room = makeApp()
    ;(room as unknown as { options: { obsTransportFactory: unknown } }).options.obsTransportFactory =
      (instance: string, scenes: string[]) => {
        recus.push([instance, scenes])
        return obs.transport
      }

    await room.startDisplay()
    const token = await room.ensurePaired()
    await room.connectHub(token!)
    await room.connectObs()

    // Les noms de la configuration de la salle, pas ceux d'une constante.
    expect(recus).toEqual([
      ['A', ['Capture HDMI', 'Habillage']],
      ['B', ['Talk']],
    ])
  }, 20_000)

  it('s\'appaire, synchronise, pilote OBS et reçoit les commandes', async () => {
    room = makeApp()
    const url = await room.startDisplay()

    const token = await room.ensurePaired()
    expect(token).toBeTruthy()

    await room.connectHub(token!)
    await room.connectObs()

    // Le programme de la salle est servi à l'écran.
    const payload = (await (await fetch(`${url}/display/data`)).json()) as DisplayPayload
    expect(payload.sessions).toHaveLength(15)
    expect(payload.event?.name).toBe('Cloud Nord 2026')

    // Une commande du hub bascule réellement la scène OBS.
    hub.services.commands.publish(TRACK_1, { type: 'scene.force', role: 'LIVE' }, null)
    await sleep(500)
    expect(obs.currentScene).toBe('Capture HDMI')
    expect(room.runtime.state().sceneRole).toBe('LIVE')

    // Et l'écran suit le mode demandé.
    hub.services.commands.publish(TRACK_1, { type: 'display.set', mode: 'programme' }, null)
    await sleep(400)
    const apres = (await (await fetch(`${url}/display/data`)).json()) as DisplayPayload
    expect(apres.state.mode).toBe('programme')
  }, 30_000)

  it('met les assets en cache pour que l\'écran ne dépende plus du réseau', async () => {
    room = makeApp()
    await room.startDisplay()
    const token = await room.ensurePaired()
    await room.connectHub(token!)

    // Les assets réels sont distants ; en test le préchargement échoue et c'est
    // sans conséquence : l'écran garde les URLs d'origine et reste servable.
    const cached = room.store.activeProgram()
    expect(cached).not.toBeNull()
    expect(room.assets.localize(cached!.program).sponsorTiers[0]?.name).toBe('Gold')
  }, 30_000)
})

/**
 * Ce que la salle remonte au hub, et pourquoi ça compte maintenant.
 *
 * `room_state` n'était lu que par la console de supervision, qui regarde. La
 * régie mobile s'en sert pour **peindre des boutons** : ce qui y arrive faux
 * n'est plus une ligne de tableau discutable, c'est un témoin éteint sur une
 * salle qui enregistre.
 */
describe('le battement', () => {
  /** Deux instances, deux transports : c'est tout l'objet de ces tests. */
  async function salleAvecDeuxObs() {
    const a = fakeObs()
    const b = fakeObs(['Talk'])
    room = makeApp()
    ;(room as unknown as { options: { obsTransportFactory: unknown } }).options.obsTransportFactory =
      (instance: string) => (instance === 'A' ? a.transport : b.transport)

    await room.startDisplay()
    const token = await room.ensurePaired()
    await room.connectHub(token!)
    await room.connectObs()
    return { a, b }
  }

  const statut = () => hub.services.rooms.statuses().find((s) => s.roomId === TRACK_1)

  it("porte la captation d'OBS-B, pas celle d'OBS-A", async () => {
    /*
     * Le défaut qu'on fige ici : le battement interrogeait `obsA`.
     *
     * OBS-A projette, OBS-B enregistre. Le battement remontait donc `false`
     * toutes les dix secondes, écrasant chez le hub le `recording` que
     * `recording.started` venait d'y écrire — la régie mobile montrait un
     * témoin éteint sur une salle en pleine captation, et la console avec elle.
     */
    const { b } = await salleAvecDeuxObs()

    // Lancé depuis OBS lui-même : aucun `recording.started` n'est émis, ce fait
    // ne voyage que par le battement. C'est le pire cas, donc le bon test.
    b.emettre('RecordStateChanged', { outputActive: true })
    await sleep(800)

    expect(room.runtime.state().recording).toBe(true)
    expect(statut()?.recording).toBe(true)
  }, 30_000)

  it('écrit le sidecar quand la captation est arrêtée depuis OBS', async () => {
    /*
     * Le geste est courant et légitime : la main est déjà dans OBS, on y appuie
     * sur « Arrêter l'enregistrement ». La régie n'a alors rien demandé et
     * n'attend aucun chemin — et tout ce que la prise savait d'elle-même
     * partait à la poubelle, marqueurs compris, qui n'existent nulle part
     * ailleurs.
     */
    const { b } = await salleAvecDeuxObs()
    await room.startRecording()
    room.mark('démo')

    const master = join(dir, 'depuis-obs.mkv')
    writeFileSync(master, 'FAUX')
    b.emettre('RecordStateChanged', {
      outputActive: false,
      outputState: 'OBS_WEBSOCKET_OUTPUT_STOPPED',
      outputPath: master,
    })
    await sleep(300)

    const sidecars = readdirSync(dir).filter((nom) => nom.endsWith('.json'))
    expect(sidecars).toHaveLength(1)
    const sidecar = JSON.parse(readFileSync(join(dir, sidecars[0]!), 'utf8')) as {
      markers: { label: string }[]
    }
    expect(sidecar.markers.map((marqueur) => marqueur.label)).toEqual(['démo'])
    // La prise est close : la régie ne croit pas qu'un enregistrement court encore.
    expect(room.runtime.state().recording).toBe(false)
  }, 30_000)

  it('n’écrit pas de second sidecar quand l’arrêt vient de la régie', async () => {
    // Les deux chemins mènent au sidecar et peuvent se croiser : l'événement
    // d'OBS arrive dans la foulée de `StopRecord`, la prise étant encore ouverte.
    const { b } = await salleAvecDeuxObs()
    await room.startRecording()

    const master = join(dir, 'depuis-regie.mkv')
    writeFileSync(master, 'FAUX')
    const arret = room.stopRecording()
    b.emettre('RecordStateChanged', {
      outputActive: false,
      outputState: 'OBS_WEBSOCKET_OUTPUT_STOPPED',
      outputPath: master,
    })
    await arret
    await sleep(300)

    expect(readdirSync(dir).filter((nom) => nom.endsWith('.json'))).toHaveLength(1)
  }, 30_000)

  it("remonte l'écran de salle, pour que le téléphone sache quel bouton allumer", async () => {
    await salleAvecDeuxObs()

    // Le geste d'une régie mobile : le hub publie, la salle applique, et la
    // salle le dit — sans attendre le tic suivant, sinon le bouton reste mort
    // dix secondes et on appuie une seconde fois.
    hub.services.commands.publish(TRACK_1, { type: 'display.set', mode: 'programme' }, null)
    await sleep(800)

    expect(room.runtime.state().mode).toBe('programme')
    expect(statut()?.displayMode).toBe('programme')
  }, 30_000)
})

/**
 * Questions du public, bornées à la conférence pilotée.
 *
 * Toutes salles confondues, la liste mélangeait la journée entière : à 16 h,
 * les questions du talk de 10 h étaient encore en tête au vote, et le speaker
 * se voyait poser une question qui ne le concernait pas.
 */
describe('questions du public', () => {
  it('ne remonte que celles du talk piloté', async () => {
    room = makeApp()
    await room.startDisplay()
    const token = await room.ensurePaired()
    await room.connectHub(token!)

    const cible = room.runtime.state().targetSession
    expect(cible).not.toBeNull()

    hub.services.questions.post({
      roomId: TRACK_1, sessionId: cible!.id, author: 'Camille',
      text: 'Comment gérez-vous les faux positifs ?',
    })
    hub.services.questions.post({
      roomId: TRACK_1, sessionId: 'un-autre-talk', author: null,
      text: 'Question du talk de ce matin',
    })

    await room.refreshQuestions()

    const { questions, questionsSession } = room.diagnostics()
    expect(questions.map((q) => q.text)).toEqual(['Comment gérez-vous les faux positifs ?'])
    // Le talk est nommé : une liste vide ne dit pas la même chose selon qu'on
    // pilote un talk sans question, ou qu'on n'en pilote aucun.
    expect(questionsSession).toEqual({ id: cible!.id, title: cible!.title })
  }, 30_000)

  it('rattache la question mise à l\'antenne à ce talk', async () => {
    // C'est ce qui la fait tomber au suivant, plutôt que de rester incrustée
    // dans la VOD du speaker d'après.
    room = makeApp()
    await room.startDisplay()
    const token = await room.ensurePaired()
    await room.connectHub(token!)

    room.setAiredQuestion('Et les faux positifs ?', 'Camille')

    expect(room.runtime.state().question).toEqual({
      text: 'Et les faux positifs ?',
      author: 'Camille',
      sessionId: room.runtime.state().targetSession?.id,
    })
    // Et surtout pas sur le canal du bandeau de la console.
    expect(room.runtime.state().liveMessage).toBeNull()
  }, 30_000)
})

/**
 * Boucle d'attente : ce qu'elle a besoin de savoir.
 *
 * Deux champs que la salle calcule seule, depuis le programme déjà en cache —
 * la boucle doit se dérouler entière pendant une pause, c'est-à-dire quand le
 * réseau de l'événement est le plus chargé.
 */
describe('boucle d\'attente', () => {
  it('sait ce qui se joue dans les autres salles, sans rien demander au hub', async () => {
    room = makeApp()
    const url = await room.startDisplay()
    const token = await room.ensurePaired()
    await room.connectHub(token!)

    const payload = (await (await fetch(`${url}/display/data`)).json()) as DisplayPayload

    // Les deux autres tracks, jamais la sienne.
    expect(payload.otherRooms.map((salle) => salle.roomId)).toEqual([
      'track-2-mf-1092',
      'hands-on',
    ])
    // Des talks, pas des pauses : « Déjeuner en Track #2 » n'aide personne à
    // choisir où aller.
    for (const salle of payload.otherRooms) {
      expect(salle.session?.title).not.toContain('Déjeuner')
    }
  }, 30_000)

  it('reçoit les comptes de l\'événement du hub, et les garde', async () => {
    hub.services.settings.update({
      socialLinks: [
        { network: 'Bluesky', handle: '@cloudnord.fr', url: 'https://bsky.app/profile/cloudnord.fr' },
      ],
    })

    room = makeApp()
    const url = await room.startDisplay()
    const token = await room.ensurePaired()
    await room.connectHub(token!)

    const payload = (await (await fetch(`${url}/display/data`)).json()) as DisplayPayload
    expect(payload.socialLinks).toEqual([
      { network: 'Bluesky', handle: '@cloudnord.fr', url: 'https://bsky.app/profile/cloudnord.fr' },
    ])
    // En cache local : une salle qui redémarre hub injoignable déroule la même
    // boucle qu'une autre.
    expect(room.store.settings().socialLinks).toHaveLength(1)
  }, 30_000)

  it('apprend du hub le nom de l\'événement, et le garde', async () => {
    // Rien n'est compilé dans le binaire : la machine de salle reçoit le nom au
    // sync, et c'est ce qui lui permet de servir l'édition suivante sans être
    // réinstallée. Le hub le déduit ici du programme importé.
    room = makeApp()
    const url = await room.startDisplay()
    const token = await room.ensurePaired()
    await room.connectHub(token!)

    const payload = (await (await fetch(`${url}/display/data`)).json()) as DisplayPayload
    expect(payload.eventIdentity).toEqual({ name: 'Cloud Nord 2026', shortName: 'Cloud Nord' })
    // En cache, comme le programme : une salle qui démarre hub injoignable
    // titre quand même ses fenêtres correctement.
    expect(room.store.settings().event.name).toBe('Cloud Nord 2026')
  }, 30_000)
})
