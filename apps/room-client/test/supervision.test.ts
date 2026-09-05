import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHub, type Hub } from '@conference-operator/hub-server/server'
import { provisionOperator } from '@conference-operator/hub-server/operators'
import { createORPCClient } from '@orpc/client'
import { RPCLink } from '@orpc/client/fetch'
import type { ContractRouterClient } from '@orpc/contract'
import { contract } from '@conference-operator/contract'
import { RoomApp } from '../src/core/room-app.js'
import { createMockObsTransport } from '../src/core/obs-mock.js'
import { runPairing, type PairingTransport } from '../src/core/pairing.js'
import { ToggleProxy } from './helpers/tcp-proxy.js'

const rawProgram = readFileSync(
  fileURLToPath(new URL('../../../packages/program/test/fixtures/cloudnord-2026.json', import.meta.url)),
  'utf8',
)

const OPERATOR = { email: 'regie@cloudnord.fr', name: 'Régie', password: 'control-password-2026' }
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

/** Approves as soon as a code appears, as an operator would. */
async function approve(userCode: string): Promise<void> {
  const response = await fetch(`http://127.0.0.1:${hubPort}/api/auth/sign-in/email`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: OPERATOR.email, password: OPERATOR.password }),
  })
  const session = (await response.json()) as { token: string }
  const admin: ContractRouterClient<typeof contract> = createORPCClient(
    new RPCLink({
      origin: `http://127.0.0.1:${hubPort}`,
      url: '/rpc',
      headers: () => ({ authorization: `Bearer ${session.token}` }),
    }),
  )
  await admin.devices.approve({ userCode, clientId: CLIENT_ID, roomId: TRACK_1 })
}

function createRoom(): RoomApp {
  let token: string | null = null
  return new RoomApp({
    dataDir: dir,
    hubOrigin: proxy.origin,
    clientId: CLIENT_ID,
    // Room known up front: these tests have no screen to choose it on.
    roomId: TRACK_1,
    displayPort: 0,
    obsTransportFactory: (instance) =>
      createMockObsTransport({ instance, recordingDir: join(dir, 'rec') }),
    readToken: () => token,
    writeToken: (value) => {
      token = value
    },
    onPairingCode: (code) => {
      void approve(code.user_code).catch(() => {
        // The hub may be unplugged: the operator will try again, and so will the room.
      })
    },
  })
}

describe('hub absent at start-up', () => {
  it('the room does not give up and joins it when it answers', async () => {
    // The most likely start-up order on an event morning: the rooms are powered
    // on before anyone has launched the hub.
    proxy.unplug()

    room = createRoom()
    const url = await room.startDisplay()
    room.startSupervision(1_000)

    const token = await room.ensurePaired()
    expect(token).toBeNull()
    expect(room.pairingState().status).toBe('failed')

    // The screen works all the same: that is the whole promise of the local cache.
    expect((await fetch(`${url}/display/projector`)).status).toBe(200)

    proxy.plug()

    /**
     * We wait for the synchronisation, not for the pairing.
     *
     * The status turns to "paired" as soon as the token is obtained, before the
     * `sync` has written the room: stopping there would let an incomplete
     * catch-up through — and made this test flaky.
     */
    for (let i = 0; i < 60 && room.store.settings().roomId == null; i += 1) await sleep(500)

    expect(room.pairingState().status).toBe('paired')
    expect(room.store.settings().roomId).toBe(TRACK_1)
    // The program is here: the catch-up went all the way.
    expect(room.store.activeProgram()?.program.sessions).toHaveLength(38)
  }, 60_000)

  it('does not restart any work while the hub stays absent', async () => {
    proxy.unplug()
    room = createRoom()
    await room.startDisplay()
    room.startSupervision(300)

    await sleep(2_000)
    // Polling does not pair: the room waits, without burning a code.
    expect(room.pairingState().status).not.toBe('paired')
  }, 30_000)
})

describe('cut during pairing', () => {
  it('does not lose the code on a transient network failure', async () => {
    let polls = 0
    const transport: PairingTransport = {
      requestCode: async () => ({
        device_code: 'dev',
        user_code: 'ABCD-1234',
        interval: 1,
        expires_in: 60,
      }),
      requestToken: async () => {
        polls += 1
        // The hub restarts while the operator walks over to the console.
        if (polls <= 3) return { ok: false, error: 'network' }
        return { ok: true, body: { access_token: 'token' } }
      },
    }

    const unreachable = vi.fn()
    let clock = 0
    const result = await runPairing(transport, CLIENT_ID, {
      onUnreachable: unreachable,
      now: () => clock,
      sleep: async (ms) => {
        clock += ms
      },
    })

    // Losing the code would force the operator to start over for no reason.
    expect(result.accessToken).toBe('token')
    expect(unreachable).toHaveBeenCalledTimes(3)
  })

  it('still gives up if the code expires', async () => {
    const transport: PairingTransport = {
      requestCode: async () => ({
        device_code: 'dev',
        user_code: 'ABCD-1234',
        interval: 5,
        expires_in: 12,
      }),
      requestToken: async () => ({ ok: false, error: 'network' }),
    }

    let clock = 0
    await expect(
      runPairing(transport, CLIENT_ID, {
        now: () => clock,
        sleep: async (ms) => {
          clock += ms
        },
      }),
    ).rejects.toMatchObject({ code: 'expired_token' })
  })
})
