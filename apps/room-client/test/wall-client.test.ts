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

const fakeObs = (): ObsTransport => ({
  connect: async () => {},
  disconnect: async () => {},
  call: (async (request: string) =>
    request === 'GetSceneList'
      ? { currentProgramSceneName: 'Habillage', scenes: [{ sceneName: 'Habillage' }] }
      : {}) as ObsTransport['call'],
  on: () => {},
})

let hub: Hub
let origin: string
let dir: string
let room: RoomApp
let local: string

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'cloudnord-wall-'))
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
    sceneRoles: { A: { HOLD: 'Habillage' }, B: {} },
  })

  let token: string | null = null
  room = new RoomApp({
    dataDir: dir,
    hubOrigin: origin,
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
        const response = await fetch(`${origin}/api/auth/sign-in/email`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ email: OPERATOR.email, password: OPERATOR.password }),
        })
        const session = (await response.json()) as { token: string }
        const admin: ContractRouterClient<typeof contract> = createORPCClient(
          new RPCLink({ origin, url: '/rpc', headers: () => ({ authorization: `Bearer ${session.token}` }) }),
        )
        await admin.devices.approve({ userCode: code.user_code, clientId: CLIENT_ID, roomId: TRACK_1 })
      })()
    },
  })

  local = await room.startDisplay()
  const jeton = await room.ensurePaired()
  await room.connectHub(jeton!)
})

afterEach(async () => {
  await room.close()
  await hub.close().catch(() => {})
  rmSync(dir, { recursive: true, force: true })
})

const etat = async () => (await (await fetch(`${local}/display/data`)).json()) as DisplayPayload

describe('mur social en salle', () => {
  it('affiche un message dès qu\'il est modéré, et jamais avant', async () => {
    const depose = hub.services.wall.post({ source: 'form', author: 'Alice', text: 'Bravo !' })
    await sleep(300)

    // En attente de relecture : l'écran ne doit rien montrer.
    expect((await etat()).state.comments).toEqual([])

    hub.services.wall.moderate(depose.id, 'approve', OPERATOR.email)
    await sleep(600)

    expect((await etat()).state.comments.map((c) => c.text)).toEqual(['Bravo !'])
  }, 40_000)

  it('ne relivre pas un message déjà affiché', async () => {
    const depose = hub.services.wall.post({ source: 'form', author: 'Alice', text: 'Bravo !' })
    hub.services.wall.moderate(depose.id, 'approve', OPERATOR.email)
    await sleep(600)

    // La reprise du flux après coupure peut relivrer : le mur ne doit pas doubler.
    room.runtime.addComment((await etat()).state.comments[0]!)
    expect((await etat()).state.comments).toHaveLength(1)
  }, 40_000)

  it('prépare le QR du mur de sa salle', async () => {
    const payload = await etat()
    expect(payload.wall?.url).toContain('/mur?salle=')
    expect(payload.wall?.url).toContain(TRACK_1)
    // Le QR est un SVG en ligne : la page n'a rien à télécharger.
    expect(payload.wall?.qrSvg).toContain('<svg')
  }, 40_000)

  it('borne le nombre de messages affichés', async () => {
    for (let i = 0; i < 20; i += 1) {
      const depose = hub.services.wall.post({ source: 'form', author: 'A', text: `message ${i}` })
      hub.services.wall.moderate(depose.id, 'approve', OPERATOR.email)
    }
    await sleep(900)

    // Un mur qui défile sans fin devient illisible à dix mètres.
    const comments = (await etat()).state.comments
    expect(comments.length).toBeLessThanOrEqual(12)
    expect(comments.at(-1)?.text).toBe('message 19')
  }, 40_000)
})
