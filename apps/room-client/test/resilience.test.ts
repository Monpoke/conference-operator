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
import { contract, type RoomEventPayload } from '@cloudnord/contract'
import { RoomApp } from '../src/core/room-app.js'
import { LocalStore } from '../src/core/store.js'
import { Outbox } from '../src/core/outbox.js'
import type { ObsTransport } from '../src/core/obs.js'
import { ToggleProxy } from './helpers/tcp-proxy.js'

const rawProgram = readFileSync(
  fileURLToPath(new URL('../../../packages/program/test/fixtures/cloudnord-2026.json', import.meta.url)),
  'utf8',
)

const OPERATOR = { email: 'regie@cloudnord.fr', name: 'Régie', password: 'motdepasse-regie-2026' }
const CLIENT_ID = '01JB2ZK5T7QW9V0YHRXM3N4P6C'
const TRACK_1 = 'track-1-teilhard-de-chardin'
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

function fakeObs() {
  const transport: ObsTransport = {
    connect: async () => {},
    disconnect: async () => {},
    call: (async (request: string) =>
      request === 'GetSceneList'
        ? { currentProgramSceneName: 'Habillage', scenes: [{ sceneName: 'Capture HDMI' }, { sceneName: 'Habillage' }] }
        : {}) as ObsTransport['call'],
    on: () => {},
  }
  return transport
}

let hub: Hub
let hubOrigin: string
let proxy: ToggleProxy
let dir: string
let room: RoomApp | null = null

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'cloudnord-resilience-'))
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
  const port = typeof address === 'object' && address != null ? address.port : 0
  hubOrigin = `http://127.0.0.1:${port}`

  // Toute la salle passe par le proxy : on peut débrancher le câble pour de vrai.
  proxy = new ToggleProxy(port)
  await proxy.listen()

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
})

afterEach(async () => {
  await room?.close()
  room = null
  await proxy.close()
  await hub.close().catch(() => {})
  rmSync(dir, { recursive: true, force: true })
})

/** Appairage réel via le proxy, approbation depuis l'admin. */
async function bootRoom(dataDir = dir): Promise<RoomApp> {
  let token: string | null = null
  const app = new RoomApp({
    dataDir,
    hubOrigin: proxy.origin,
    clientId: CLIENT_ID,
    // Salle connue d'avance : ces tests n'ont pas d'écran pour la choisir.
    roomId: TRACK_1,
    displayPort: 0,
    obsTransportFactory: fakeObs,
    readToken: () => token,
    writeToken: (value) => {
      token = value
    },
    onPairingCode: (code) => {
      void (async () => {
        const response = await fetch(`${hubOrigin}/api/auth/sign-in/email`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ email: OPERATOR.email, password: OPERATOR.password }),
        })
        const session = (await response.json()) as { token: string }
        const admin: ContractRouterClient<typeof contract> = createORPCClient(
          new RPCLink({
            origin: hubOrigin,
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

  await app.startDisplay()
  const jeton = await app.ensurePaired()
  expect(jeton).toBeTruthy()
  await app.connectHub(jeton!)
  return app
}

const marker = (label: string): RoomEventPayload => ({
  type: 'talk.marker',
  sessionId: 'ses-1',
  label,
  offsetMs: 1_000,
})

describe('coupure réseau en plein enregistrement', () => {
  it('ne perd rien et remonte tout dans l\'ordre à la reprise', async () => {
    room = await bootRoom()

    room.emit({ type: 'recording.started', obs: 'B', sessionId: 'ses-1' })
    room.emit(marker('intro'))
    await sleep(2_500)

    // Le premier lot est passé.
    expect(room.outboxDepth()).toBe(0)

    // On débranche le câble en plein enregistrement.
    proxy.unplug()

    room.emit(marker('démo-1'))
    room.emit(marker('démo-2'))
    room.emit({
      type: 'recording.stopped',
      obs: 'B',
      sessionId: 'ses-1',
      outputPath: '/rec/talk.mkv',
      durationMs: 3_000_000,
      sidecarWritten: true,
    })

    // La régie continue de fonctionner : les événements s'empilent localement.
    expect(room.outboxDepth()).toBe(3)
    await sleep(2_500)
    expect(room.outboxDepth()).toBe(3)
    expect(room.runtime.state().connectivity).toBe('OFFLINE')

    // On rebranche.
    proxy.plug()
    await sleep(6_000)

    expect(room.outboxDepth()).toBe(0)
    expect(room.runtime.state().connectivity).toBe('ONLINE')

    // Côté hub : tout est là, une seule fois, dans l'ordre d'émission.
    const recus = hub.services.ingest.eventsFor(TRACK_1)
    const types = recus.map((e) => e.type)

    expect(types).toContain('recording.started')
    expect(types).toContain('recording.stopped')
    expect(types.filter((t) => t === 'talk.marker')).toHaveLength(3)

    // Aucun doublon malgré les rejeux de la reconnexion.
    expect(new Set(recus.map((e) => e.id)).size).toBe(recus.length)

    // Les `seq` sont strictement croissants : l'ordre d'émission est préservé,
    // condition pour que les timecodes du talk restent exploitables au editing.
    const seqs = recus.map((e) => e.seq)
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b))

    // Le `recording.stopped` arrive bien après son `recording.started`.
    expect(types.indexOf('recording.stopped')).toBeGreaterThan(types.indexOf('recording.started'))
  }, 60_000)
})

describe('événements émis hors connexion', () => {
  it('met en file dès que la salle est connue, sans réseau', async () => {
    const dbPath = join(dir, 'salle.db')
    // Première mise en service : la salle est déjà connue du cache local.
    const amorce = new LocalStore(dbPath)
    amorce.saveSettings({ roomId: TRACK_1 })
    amorce.close()

    proxy.unplug()
    room = new RoomApp({
      dataDir: dir,
      hubOrigin: proxy.origin,
      clientId: CLIENT_ID,
      // Salle connue d'avance : ces tests n'ont pas d'écran pour la choisir.
      roomId: TRACK_1,
      displayPort: 0,
      obsTransportFactory: fakeObs,
      readToken: () => 'jeton-en-cache',
      writeToken: () => {},
    })
    await room.startDisplay()

    // Aucun hub joignable, aucun lien ouvert : l'événement doit tout de même
    // être capturé, sinon un redémarrage hors ligne perdrait le démarrage OBS.
    room.emit({ type: 'obs.connection', obs: 'A', connected: true, unresolvedRoles: [] })
    expect(room.outboxDepth()).toBe(1)
  }, 30_000)
})

describe('repli par fichier local', () => {
  it('ouvre une salle sans que le hub ait jamais répondu', async () => {
    const chemin = join(dir, 'programme.json')
    const { writeFileSync } = await import('node:fs')
    writeFileSync(chemin, rawProgram)

    proxy.unplug()
    room = new RoomApp({
      dataDir: dir,
      hubOrigin: proxy.origin,
      clientId: CLIENT_ID,
      // Salle connue d'avance : ces tests n'ont pas d'écran pour la choisir.
      roomId: TRACK_1,
      displayPort: 0,
      obsTransportFactory: fakeObs,
      readToken: () => null,
      writeToken: () => {},
    })
    const url = await room.startDisplay()

    // Dernier repli de la chaîne de démarrage : la clé USB.
    const resultat = await room.importProgramFile(chemin)
    expect(resultat.sessions).toBe(27)

    room.runtime.setRoomId(TRACK_1)
    const payload = (await (await fetch(`${url}/display/data`)).json()) as { sessions: unknown[] }
    expect(payload.sessions).toHaveLength(15)
  }, 30_000)

  it('produit la même empreinte que le hub, pour ne pas dupliquer la version', async () => {
    const chemin = join(dir, 'programme.json')
    const { writeFileSync } = await import('node:fs')
    writeFileSync(chemin, rawProgram)

    room = new RoomApp({
      dataDir: dir,
      hubOrigin: proxy.origin,
      clientId: CLIENT_ID,
      // Salle connue d'avance : ces tests n'ont pas d'écran pour la choisir.
      roomId: TRACK_1,
      displayPort: 0,
      obsTransportFactory: fakeObs,
      readToken: () => null,
      writeToken: () => {},
    })
    await room.startDisplay()
    const local = await room.importProgramFile(chemin)

    const cote = hub.services.programs.active()
    expect(local.contentHash).toBe(cote?.contentHash)
  }, 30_000)
})

describe('redémarrage brutal hors ligne', () => {
  it('retrouve programme et file intacts', async () => {
    const dbPath = join(dir, 'salle.db')
    const store = new LocalStore(dbPath)
    store.saveSettings({ roomId: TRACK_1 })

    const outbox = new Outbox(store, TRACK_1)
    outbox.enqueue({ type: 'recording.started', obs: 'B', sessionId: 'ses-1' })
    outbox.enqueue(marker('avant-coupure'))
    const seqAvant = outbox.claimBatch().map((e) => e.seq)
    store.close()

    // Coupure de courant : l'application n'a rien pu vider.
    const rouvert = new LocalStore(dbPath)
    const reprise = new Outbox(rouvert, TRACK_1)

    expect(reprise.depth()).toBe(2)
    expect(reprise.claimBatch().map((e) => e.seq)).toEqual(seqAvant)
    // Le compteur ne repart pas de zéro : le hub verrait sinon des `seq` en doublon.
    expect(rouvert.settings().nextSeq).toBeGreaterThan(seqAvant.at(-1)!)
    rouvert.close()
  })
})
