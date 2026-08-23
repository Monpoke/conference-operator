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
import { contract } from '@cloudnord/contract'
import { RoomApp } from '../src/core/room-app.js'
import { createMockObsTransport } from '../src/core/obs-mock.js'
import { runPairing, type PairingTransport } from '../src/core/pairing.js'
import { ToggleProxy } from './helpers/tcp-proxy.js'

const rawProgram = readFileSync(
  fileURLToPath(new URL('../../../packages/program/test/fixtures/cloudnord-2026.json', import.meta.url)),
  'utf8',
)

const OPERATOR = { email: 'regie@cloudnord.fr', name: 'Régie', password: 'motdepasse-regie-2026' }
const CLIENT_ID = '01JB2ZK5T7QW9V0YHRXM3N4P6C'
const TRACK_1 = 'track-1-teilhard-de-chardin'
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

let hub: Hub
let hubPort: number
let proxy: ToggleProxy
let dir: string
let room: RoomApp | null = null

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'cloudnord-supervision-'))
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
  hubPort = typeof address === 'object' && address != null ? address.port : 0

  proxy = new ToggleProxy(hubPort)
  await proxy.listen()

  await provisionOperator(hub.auth, OPERATOR)
  const snapshot = hub.services.programs.importFromText(rawProgram, 'https://exemple/programme.json')
  hub.services.rooms.ensureFromTracks(snapshot.program.rooms)
})

afterEach(async () => {
  await room?.close()
  room = null
  await proxy.close()
  await hub.close().catch(() => {})
  rmSync(dir, { recursive: true, force: true })
})

/** Approuve dès qu'un code apparaît, comme le ferait un opérateur. */
async function approuver(userCode: string): Promise<void> {
  const reponse = await fetch(`http://127.0.0.1:${hubPort}/api/auth/sign-in/email`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: OPERATOR.email, password: OPERATOR.password }),
  })
  const session = (await reponse.json()) as { token: string }
  const admin: ContractRouterClient<typeof contract> = createORPCClient(
    new RPCLink({
      origin: `http://127.0.0.1:${hubPort}`,
      url: '/rpc',
      headers: () => ({ authorization: `Bearer ${session.token}` }),
    }),
  )
  await admin.devices.approve({ userCode, clientId: CLIENT_ID, roomId: TRACK_1 })
}

function creerSalle(): RoomApp {
  let token: string | null = null
  return new RoomApp({
    dataDir: dir,
    hubOrigin: proxy.origin,
    clientId: CLIENT_ID,
    // Salle connue d'avance : ces tests n'ont pas d'écran pour la choisir.
    roomId: TRACK_1,
    displayPort: 0,
    obsTransportFactory: (instance) =>
      createMockObsTransport({ instance, recordingDir: join(dir, 'rec') }),
    readToken: () => token,
    writeToken: (valeur) => {
      token = valeur
    },
    onPairingCode: (code) => {
      void approuver(code.user_code).catch(() => {
        // Le hub est peut-être débranché : l'opérateur réessaiera, la salle aussi.
      })
    },
  })
}

describe('hub absent au démarrage', () => {
  it('la salle ne renonce pas et le rejoint quand il répond', async () => {
    // Ordre de démarrage le plus probable un matin d'événement : les salles
    // s'allument avant que quiconque ait lancé le hub.
    proxy.debrancher()

    room = creerSalle()
    const url = await room.startDisplay()
    room.startSupervision(1_000)

    const jeton = await room.ensurePaired()
    expect(jeton).toBeNull()
    expect(room.pairingState().status).toBe('failed')

    // L'écran fonctionne malgré tout : c'est toute la promesse du cache local.
    expect((await fetch(`${url}/display/projector`)).status).toBe(200)

    proxy.rebrancher()

    /**
     * On attend la synchronisation, pas l'appairage.
     *
     * Le statut passe à « paired » dès que le jeton est obtenu, avant que le
     * `sync` ait écrit la salle : s'arrêter là laisserait passer un rattrapage
     * incomplet — et rendait ce test intermittent.
     */
    for (let i = 0; i < 60 && room.store.settings().roomId == null; i += 1) await sleep(500)

    expect(room.pairingState().status).toBe('paired')
    expect(room.store.settings().roomId).toBe(TRACK_1)
    // Le programme est là : le rattrapage est allé jusqu'au bout.
    expect(room.store.activeProgram()?.program.sessions).toHaveLength(38)
  }, 60_000)

  it('ne relance pas de travail tant que le hub reste absent', async () => {
    proxy.debrancher()
    room = creerSalle()
    await room.startDisplay()
    room.startSupervision(300)

    await sleep(2_000)
    // Sonder n'appaire pas : la salle attend, sans consommer de code.
    expect(room.pairingState().status).not.toBe('paired')
  }, 30_000)
})

describe('coupure pendant l\'appairage', () => {
  it('ne perd pas le code sur une panne réseau passagère', async () => {
    let sondages = 0
    const transport: PairingTransport = {
      requestCode: async () => ({
        device_code: 'dev',
        user_code: 'ABCD-1234',
        interval: 1,
        expires_in: 60,
      }),
      requestToken: async () => {
        sondages += 1
        // Le hub redémarre pendant que l'opérateur se dirige vers la console.
        if (sondages <= 3) return { ok: false, error: 'network' }
        return { ok: true, body: { access_token: 'jeton' } }
      },
    }

    const injoignable = vi.fn()
    let horloge = 0
    const resultat = await runPairing(transport, CLIENT_ID, {
      onUnreachable: injoignable,
      now: () => horloge,
      sleep: async (ms) => {
        horloge += ms
      },
    })

    // Perdre le code obligerait l'opérateur à tout recommencer sans raison.
    expect(resultat.accessToken).toBe('jeton')
    expect(injoignable).toHaveBeenCalledTimes(3)
  })

  it('abandonne quand même si le code expire', async () => {
    const transport: PairingTransport = {
      requestCode: async () => ({
        device_code: 'dev',
        user_code: 'ABCD-1234',
        interval: 5,
        expires_in: 12,
      }),
      requestToken: async () => ({ ok: false, error: 'network' }),
    }

    let horloge = 0
    await expect(
      runPairing(transport, CLIENT_ID, {
        now: () => horloge,
        sleep: async (ms) => {
          horloge += ms
        },
      }),
    ).rejects.toMatchObject({ code: 'expired_token' })
  })
})
