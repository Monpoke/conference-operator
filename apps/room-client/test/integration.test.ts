import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createHub, type Hub } from '@cloudnord/hub-server/server'
import { provisionOperator } from '@cloudnord/hub-server/operators'
import { createORPCClient } from '@orpc/client'
import { RPCLink } from '@orpc/client/fetch'
import type { ContractRouterClient } from '@orpc/contract'
import { contract } from '@cloudnord/contract'
import { httpPairingTransport, runPairing } from '../src/core/pairing.js'
import { LocalStore } from '../src/core/store.js'
import { RoomRuntime } from '../src/core/runtime.js'
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

function makeClient(token: string, dbPath = ':memory:') {
  const store = new LocalStore(dbPath)
  openStores.push(store)
  const runtime = new RoomRuntime(store)
  const link = new HubLink({ hubOrigin: origin, clientId: CLIENT_ID, token, store, runtime })
  openLinks.push(link)
  return { store, runtime, link }
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
