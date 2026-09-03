import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHub, type Hub } from '@cloudnord/hub-server/server'
import { provisionOperator } from '@cloudnord/hub-server/operators'
import { createORPCClient } from '@orpc/client'
import { RPCLink } from '@orpc/client/fetch'
import type { ContractRouterClient } from '@orpc/contract'
import { contract, CONTROL_SESSION_HEADER } from '@cloudnord/contract'
import { httpPairingTransport, runPairing } from '../src/core/pairing.js'
import { LocalStore } from '../src/core/store.js'
import { RoomRuntime, type RuntimeEffects } from '../src/core/runtime.js'
import { Outbox } from '../src/core/outbox.js'
import { OutboxPump, buildHeartbeat, heartbeatDedupKey } from '../src/core/outbox-pump.js'
import { HubLink } from '../src/core/hub-link.js'

const rawProgram = readFileSync(
  fileURLToPath(new URL('../../../packages/program/test/fixtures/cloudnord-2026.json', import.meta.url)),
  'utf8',
)

const OPERATOR = { email: 'regie@cloudnord.fr', name: 'Régie', password: 'motdepasse-regie-2026' }
const CLIENT_ID = '01JB2ZK5T7QW9V0YHRXM3N4P6C'
const TRACK_1 = 'track-1-teilhard-de-chardin'
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

let hub: Hub
let origin: string
let tempDir: string
const openLinks: HubLink[] = []
const openStores: LocalStore[] = []

beforeEach(async () => {
  tempDir = mkdtempSync(join(tmpdir(), 'cloudnord-room-'))
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
    name: 'Track #1 - Teilhard de Chardin',
    trackId: TRACK_1,
    obs: {
      A: { url: 'ws://127.0.0.1:4455', password: null },
      B: { url: 'ws://127.0.0.1:4456', password: null },
    },
    sceneRoles: { A: { LIVE: 'Capture HDMI', HOLD: 'Habillage' }, B: { TALK: 'Talk' } },
    displayPort: 7788,
    recordingRoot: null,
  })
})

afterEach(async () => {
  for (const link of openLinks.splice(0)) await link.close()
  for (const store of openStores.splice(0)) store.close()
  await hub.close()
  rmSync(tempDir, { recursive: true, force: true })
})

/** Déroule l'appairage réel, du code au jeton, comme au premier démarrage. */
async function pair(): Promise<string> {
  const transport = httpPairingTransport(origin)
  let approved = false

  const pairing = runPairing(transport, CLIENT_ID, {
    onCode: (code) => {
      // L'opérateur lit le code sur l'écran de régie et l'approuve dans l'admin.
      void (async () => {
        const token = await signInOperator()
        const admin: ContractRouterClient<typeof contract> = createORPCClient(
          new RPCLink({ origin, url: '/rpc', headers: () => ({ authorization: `Bearer ${token}` }) }),
        )
        await admin.devices.approve({
          userCode: code.user_code,
          clientId: CLIENT_ID,
          roomId: TRACK_1,
          label: 'PC régie salle 1',
        })
        approved = true
      })()
    },
  })

  const { accessToken } = await pairing
  expect(approved).toBe(true)

  // Échange contre un jeton de salle : la session d'approbation porte les
  // droits de l'opérateur, une machine de régie n'a pas à les conserver.
  const machine: ContractRouterClient<typeof contract> = createORPCClient(
    new RPCLink({
      origin,
      url: '/rpc',
      headers: () => ({
        authorization: `Bearer ${accessToken}`,
        'x-room-client-id': CLIENT_ID,
      }),
    }),
  )
  const { token } = await machine.devices.claim()
  return token
}

async function signInOperator(): Promise<string> {
  const response = await fetch(`${origin}/api/auth/sign-in/email`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: OPERATOR.email, password: OPERATOR.password }),
  })
  return ((await response.json()) as { token: string }).token
}

function makeClient(token: string, dbPath = ':memory:', effects: RuntimeEffects = {}) {
  const store = new LocalStore(dbPath)
  openStores.push(store)
  const runtime = new RoomRuntime(store, effects)
  const link = new HubLink({ hubOrigin: origin, clientId: CLIENT_ID, token, store, runtime })
  openLinks.push(link)
  return { store, runtime, link }
}

/**
 * Une salle branchée, prête à recevoir. Les effets tiennent lieu d'OBS.
 *
 * Le runtime ne connaît pas OBS — il décide *quoi* faire, la machine sait
 * *comment* —, ce qui permet d'exercer la chaîne entière sans instance.
 */
async function salleBranchee(effects: RuntimeEffects) {
  const token = await pair()
  const { runtime, link, store } = makeClient(token, ':memory:', effects)
  await link.sync()
  const controller = new AbortController()
  void link.consumeCommands(controller.signal)
  await sleep(200)
  return { runtime, controller, token, store }
}

describe('salle et hub, chaîne complète', () => {
  it('s\'appaire puis récupère le programme de sa salle', async () => {
    const token = await pair()
    const { store, runtime, link } = makeClient(token)

    const result = await link.sync()
    expect(result.ok).toBe(true)

    expect(runtime.state().roomId).toBe(TRACK_1)
    // 27 créneaux à l'export, 38 servis par le hub : les pauses communes sont
    // projetées dans les salles libres au même moment.
    expect(store.activeProgram()?.program.sessions).toHaveLength(38)
    expect(store.settings().config?.sceneRoles.A?.LIVE).toBe('Capture HDMI')
  }, 20_000)

  it('reçoit les commandes du hub et les applique', async () => {
    const token = await pair()
    const { runtime, link } = makeClient(token)
    await link.sync()

    const controller = new AbortController()
    void link.consumeCommands(controller.signal)
    await sleep(200)

    hub.services.commands.publish(TRACK_1, { type: 'scene.force', role: 'LIVE' }, null)
    hub.services.commands.publish(
      null,
      { type: 'message.broadcast', text: 'Ouverture des portes', level: 'info' },
      600,
    )
    await sleep(400)

    expect(runtime.state().sceneRole).toBe('LIVE')
    /**
     * Sans destinataire explicite, le message reste au bandeau de régie.
     *
     * C'est le défaut le moins dommageable : un message qui n'atteint que
     * l'opérateur se rattrape, un message projeté devant le public non.
     */
    expect(runtime.state().message).toBeNull()
    expect(runtime.state().notifications.map((n) => n.text).join(' ')).toContain(
      'Ouverture des portes',
    )
    controller.abort()
  }, 20_000)

  it('rattrape les commandes émises pendant une coupure', async () => {
    const token = await pair()
    const { store, runtime, link } = makeClient(token)
    await link.sync()

    const first = new AbortController()
    void link.consumeCommands(first.signal)
    await sleep(200)
    hub.services.commands.publish(TRACK_1, { type: 'scene.force', role: 'HOLD' }, null)
    await sleep(300)
    expect(runtime.state().sceneRole).toBe('HOLD')

    // Coupure : le flux s'arrête, le hub continue d'émettre.
    first.abort()
    await sleep(100)
    hub.services.commands.publish(TRACK_1, { type: 'scene.force', role: 'LIVE' }, null)
    hub.services.commands.publish(TRACK_1, { type: 'display.set', mode: 'programme' }, null)

    // Reconnexion : la reprise part du dernier `seq` appliqué, stocké localement.
    const seqBefore = store.settings().lastCommandSeq
    const second = new AbortController()
    void link.consumeCommands(second.signal)
    await sleep(500)

    expect(runtime.state().sceneRole).toBe('LIVE')
    expect(runtime.state().mode).toBe('programme')
    expect(store.settings().lastCommandSeq).toBeGreaterThan(seqBefore)
    second.abort()
  }, 20_000)

  it('démarre sur son cache quand le hub est injoignable', async () => {
    const token = await pair()
    const dbPath = join(tempDir, 'salle.db')

    // Première journée : la salle synchronise et met en cache.
    const online = makeClient(token, dbPath)
    await online.link.sync()
    expect(online.store.activeProgram()).not.toBeNull()
    await online.link.close()
    online.store.close()
    openStores.pop()

    // Le hub tombe. On ferme seulement l'écoute HTTP : fermer aussi SQLite ici
    // ferait crier Better Auth sur des requêtes encore en vol, ce qui
    // ressemblerait à un échec du test sans en être un.
    await hub.app.close()

    const offline = new LocalStore(dbPath)
    openStores.push(offline)
    const runtime = new RoomRuntime(offline)
    // Le programme et la salle sont là, sans le moindre appel réseau.
    expect(offline.activeProgram()?.program.sessions).toHaveLength(38)
    expect(offline.settings().roomId).toBe(TRACK_1)
    expect(runtime.state().contentHash).toBeTruthy()

    const link = new HubLink({
      hubOrigin: origin,
      clientId: CLIENT_ID,
      token,
      store: offline,
      runtime,
      // Échéance courte : le test vérifie que `sync` rend la main, pas qu'il patiente.
      syncTimeoutMs: 1_500,
    })
    openLinks.push(link)

    // La synchronisation échoue sans lever, et l'écran reste servi.
    const result = await link.sync()
    expect(result.ok).toBe(false)
    expect(runtime.state().connectivity).toBe('OFFLINE')
    expect(runtime.state().roomId).toBe(TRACK_1)


  }, 25_000)
})

/**
 * La régie mobile, de bout en bout.
 *
 * Le maillon qu'aucun test unitaire ne couvre : un opérateur pose un geste en
 * HTTP sur le hub, la commande traverse le WebSocket, et la salle l'applique.
 * Chacun des trois côtés est vérifié ailleurs ; ce qui se casse en silence,
 * c'est la jointure.
 */
describe('régie mobile, du téléphone à la salle', () => {
  /**
   * Ce que fait la page : se connecter, s'annoncer, puis appeler le contrat.
   *
   * L'en-tête de session est ce que le verrou retient — un compte peut avoir
   * deux onglets ouverts, et ils ne doivent pas se croire porteurs tous les
   * deux. `session` permet d'en simuler un second.
   */
  async function commePhone(token: string, session = 'session-telephone') {
    const client: ContractRouterClient<typeof contract> = createORPCClient(
      new RPCLink({
        origin,
        url: '/rpc',
        headers: () => ({
          authorization: `Bearer ${token}`,
          [CONTROL_SESSION_HEADER]: session,
        }),
      }),
    )
    return client
  }

  it('porte scène, captation et verrou jusqu\'à la salle', async () => {
    const scenes: string[] = []
    const captations: boolean[] = []
    const { runtime, controller } = await salleBranchee({
      setSceneRole: async (role) => {
        scenes.push(role)
        runtime.observeSceneRole(role)
      },
      setRecording: (on) => {
        captations.push(on)
        runtime.observeCapture({ recording: on })
      },
    })

    const phone = await commePhone(await signInOperator())
    await phone.regie.hold({ roomId: TRACK_1, force: false })
    await phone.regie.command({ roomId: TRACK_1, action: { type: 'scene.set', role: 'LIVE' } })
    await phone.regie.command({ roomId: TRACK_1, action: { type: 'recording.set', on: true } })
    await sleep(500)

    expect(scenes).toEqual(['LIVE'])
    expect(captations).toEqual([true])
    // Le badge de l'écran de régie : il ne grise rien, il dit qui pilote.
    expect(runtime.state().remoteHolder).toBe(OPERATOR.email)
    // Et le signalement nomme l'auteur, pour qu'on ne cherche pas une panne.
    expect(runtime.state().notifications.map((n) => n.text).join(' ')).toContain(OPERATOR.email)

    controller.abort()
  }, 25_000)

  it('rend au téléphone ce que la salle a remonté', async () => {
    /*
     * L'aller-retour complet, et la propriété dont dépend « Commencer ».
     *
     * La régie mobile ne peint jamais d'avance : elle confirme l'enregistrement
     * par l'**observation**, en sondant jusqu'à voir `recording` passer à vrai.
     * Encore faut-il que ce que la salle constate remonte jusqu'à la vue —
     * sinon la confirmation expire sur une captation qui tourne, et
     * « Commencer » renonce pour rien.
     *
     * La remontée est montée ici comme la monte `RoomApp` : la file locale, la
     * pompe, et `ingest.push` au bout. C'est le chemin réel, sans le serveur
     * d'affichage dont ce test n'a que faire.
     */
    const { runtime, controller, store } = await salleBranchee({
      setRecording: (on) => runtime.observeCapture({ recording: on }),
    })
    const lien = openLinks.at(-1)!
    const outbox = new Outbox(store, TRACK_1)
    const pump = new OutboxPump({
      outbox,
      store,
      push: (batch) => lien.client.ingest.push({ batch }),
    })

    const phone = await commePhone(await signInOperator())
    await phone.regie.hold({ roomId: TRACK_1, force: false })
    expect((await phone.regie.view({ roomId: TRACK_1 })).recording).toBe(false)

    await phone.regie.command({ roomId: TRACK_1, action: { type: 'recording.set', on: true } })
    await sleep(400)
    expect(runtime.state().recording).toBe(true)

    // Le battement porte ce que la salle constate : c'est lui qui peint
    // `room_state`, et c'est `room_state` que relit la vue du téléphone.
    outbox.enqueue(
      buildHeartbeat({
        connectivity: 'ONLINE',
        sceneRole: runtime.state().sceneRole,
        recording: runtime.state().recording,
        streaming: runtime.state().streaming,
        outboxDepth: 0,
        programContentHash: runtime.state().contentHash,
        displayMode: runtime.state().mode,
      }),
      { dedupKey: heartbeatDedupKey(TRACK_1) },
    )
    await pump.drainOnce()

    const vue = await phone.regie.view({ roomId: TRACK_1 })
    expect(vue.recording).toBe(true)
    expect(vue.connectivity).toBe('ONLINE')

    controller.abort()
  }, 30_000)

  it('refuse le geste de qui ne tient pas la salle, sans rien envoyer', async () => {
    const scenes: string[] = []
    const { controller } = await salleBranchee({
      setSceneRole: async (role) => {
        scenes.push(role)
      },
    })

    const phone = await commePhone(await signInOperator())
    // Aucune prise : le hub refuse, et rien ne descend. Sans ce refus, deux
    // téléphones basculeraient la même salle en sens contraire.
    await expect(
      phone.regie.command({ roomId: TRACK_1, action: { type: 'scene.set', role: 'LIVE' } }),
    ).rejects.toThrow()
    await sleep(300)
    expect(scenes).toEqual([])

    controller.abort()
  }, 25_000)
})
