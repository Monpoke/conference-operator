import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
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
import { createMockObsTransport } from '../src/core/obs-mock.js'

/**
 * A room with a **single** OBS.
 *
 * The capture then lives in the vertical canvas of the OBS that projects, and
 * everything downstream must be the same as with two instances: the same
 * recording session, the same sidecar, the same state sent up. That is what these
 * tests hold — a setup with one OBS must not be a second, less travelled path.
 */

const rawProgram = readFileSync(
  fileURLToPath(new URL('../../../packages/program/test/fixtures/cloudnord-2026.json', import.meta.url)),
  'utf8',
)

const OPERATOR = { email: 'regie@cloudnord.fr', name: 'Régie', password: 'control-password-2026' }
const CLIENT_ID = '01JB2ZK5T7QW9V0YHRXM3N4P6D'
const TRACK_1 = 'track-1-teilhard-de-chardin'

/** The simulator's events follow the answer, as a real OBS's do. */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 40))

let hub: Hub
let origin: string
let dir: string
let room: RoomApp

/** The instances the machine actually opened a transport for. */
let opened: string[]

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'cloudnord-solo-'))
  opened = []
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
    // The whole configuration of a single-OBS room: no address for the capture.
    obs: {
      A: { url: 'ws://127.0.0.1:4455', password: null },
      B: { url: '', password: null },
    },
    sceneRoles: {
      A: { LIVE: 'Direct — capture HDMI', HOLD: 'Habillage — écran de salle' },
      B: { TALK: 'Talk — caméra + slides' },
    },
    displayPort: 7788,
    recordingRoot: join(dir, 'rec'),
  })
})

afterEach(async () => {
  await room?.close()
  await hub.close().catch(() => {})
  rmSync(dir, { recursive: true, force: true })
})

async function start(): Promise<void> {
  let token: string | null = null
  room = new RoomApp({
    dataDir: dir,
    hubOrigin: origin,
    clientId: CLIENT_ID,
    roomId: TRACK_1,
    displayPort: 0,
    readToken: () => token,
    writeToken: (value) => {
      token = value
    },
    obsTransportFactory: (instance, scenes, canvasScenes) => {
      opened.push(instance)
      return createMockObsTransport({ instance, scenes, canvasScenes, recordingDir: join(dir, 'rec') })
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
          new RPCLink({
            origin,
            url: '/rpc',
            headers: () => ({ authorization: `Bearer ${session.token}` }),
          }),
        )
        await admin.devices.approve({ userCode: code.user_code, clientId: CLIENT_ID, roomId: TRACK_1 })
      })()
    },
  })

  await room.startDisplay()
  const paired = await room.ensurePaired()
  await room.connectHub(paired!)
  await room.connectObs()
}

describe('a room with a single OBS', () => {
  it('opens one connection, and the capture says where it lives', async () => {
    await start()

    // One transport, and only one: there is no second OBS to reach.
    expect(opened).toEqual(['A'])

    const diagnostics = room.diagnostics()
    expect(diagnostics.obs.A?.connected).toBe(true)
    expect(diagnostics.obs.B?.connected).toBe(true)
    // Said by the machine, so the control app shows a capture rather than a
    // second instance to go and restart.
    expect(diagnostics.obs.B?.canvas).toBe(true)
    expect(diagnostics.obs.B?.scenes).toContain('Talk — caméra + slides')
    expect(diagnostics.obs.B?.unresolvedRoles).toEqual([])
  }, 20_000)

  it('records the talk, renames the master and writes its sidecar', async () => {
    await start()

    await room.startRecording()
    await settle()
    expect(room.runtime.state().recording).toBe(true)

    const result = await room.stopRecording()
    expect(room.runtime.state().recording).toBe(false)

    // The chain that a capture in a canvas must not shorten: a real file, renamed
    // from the path the plugin announced, and its sidecar next to it.
    expect(result.videoPath).not.toBeNull()
    expect(existsSync(result.videoPath!)).toBe(true)
    expect(result.sidecarPath).not.toBeNull()
    expect(existsSync(result.sidecarPath!)).toBe(true)
  }, 20_000)

  it('projects without the capture following the projection', async () => {
    await start()

    await room.startRecording()
    await settle()
    // The projection switches scene under a running take: with a single canvas
    // that switch **was** the capture, which is the setup the plugin lifts.
    await room.setSceneRole('LIVE')
    await settle()

    expect(room.diagnostics().obs.A?.currentRole).toBe('LIVE')
    expect(room.diagnostics().obs.B?.recording).toBe(true)
    expect(room.diagnostics().obs.A?.recording).toBe(false)

    await room.stopRecording()
  }, 20_000)
})
