import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createHub, type Hub } from '@conference-operator/hub-server/server'
import { provisionOperator } from '@conference-operator/hub-server/operators'
import { createORPCClient } from '@orpc/client'
import { RPCLink } from '@orpc/client/fetch'
import type { ContractRouterClient } from '@orpc/contract'
import { contract } from '@conference-operator/contract'
import { RoomApp } from '../src/core/room-app.js'
import type { ObsTransport } from '../src/core/obs.js'
import type { DisplayPayload } from '../src/core/display-server.js'

const rawProgram = readFileSync(
  fileURLToPath(new URL('../../../packages/program/test/fixtures/cloudnord-2026.json', import.meta.url)),
  'utf8',
)

const OPERATOR = { email: 'regie@cloudnord.fr', name: 'Régie', password: 'control-password-2026' }
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
    // Room known up front: these tests have no screen to choose it on.
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
  const pairedToken = await room.ensurePaired()
  await room.connectHub(pairedToken!)
})

afterEach(async () => {
  await room.close()
  await hub.close().catch(() => {})
  rmSync(dir, { recursive: true, force: true })
})

const readState = async () => (await (await fetch(`${local}/display/data`)).json()) as DisplayPayload

describe('social wall in the room', () => {
  it('displays a message as soon as it is moderated, and never before', async () => {
    const posted = hub.services.wall.post({ source: 'form', author: 'Alice', text: 'Bravo !' })
    await sleep(300)

    // Awaiting review: the screen must show nothing.
    expect((await readState()).state.comments).toEqual([])

    hub.services.wall.moderate(posted.id, 'approve', OPERATOR.email)
    await sleep(600)

    expect((await readState()).state.comments.map((c) => c.text)).toEqual(['Bravo !'])
  }, 40_000)

  it('does not deliver an already displayed message twice', async () => {
    const posted = hub.services.wall.post({ source: 'form', author: 'Alice', text: 'Bravo !' })
    hub.services.wall.moderate(posted.id, 'approve', OPERATOR.email)
    await sleep(600)

    // Resuming the stream after a cut can deliver again: the wall must not double up.
    room.runtime.addComment((await readState()).state.comments[0]!)
    expect((await readState()).state.comments).toHaveLength(1)
  }, 40_000)

  it('prepares the QR code for its own room wall', async () => {
    const payload = await readState()
    expect(payload.wall?.url).toContain('/mur?salle=')
    expect(payload.wall?.url).toContain(TRACK_1)
    // The QR code is an inline SVG: the page has nothing to download.
    expect(payload.wall?.qrSvg).toContain('<svg')
  }, 40_000)

  it('bounds the number of displayed messages', async () => {
    for (let i = 0; i < 20; i += 1) {
      const posted = hub.services.wall.post({ source: 'form', author: 'A', text: `message ${i}` })
      hub.services.wall.moderate(posted.id, 'approve', OPERATOR.email)
    }
    await sleep(900)

    // A wall that scrolls endlessly becomes unreadable from ten metres away.
    const comments = (await readState()).state.comments
    expect(comments.length).toBeLessThanOrEqual(12)
    expect(comments.at(-1)?.text).toBe('message 19')
  }, 40_000)
})
