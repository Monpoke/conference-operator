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

const OPERATOR = { email: 'regie@cloudnord.fr', name: 'Régie', password: 'control-password-2026' }
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

  // The whole room goes through the proxy: we can really unplug the cable.
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

/** Real pairing through the proxy, approved from the admin console. */
async function bootRoom(dataDir = dir): Promise<RoomApp> {
  let token: string | null = null
  const app = new RoomApp({
    dataDir,
    hubOrigin: proxy.origin,
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
  const paired = await app.ensurePaired()
  expect(paired).toBeTruthy()
  await app.connectHub(paired!)
  return app
}

const marker = (label: string): RoomEventPayload => ({
  type: 'talk.marker',
  sessionId: 'ses-1',
  label,
  offsetMs: 1_000,
})

describe('network cut in the middle of a recording', () => {
  it('loses nothing and reports everything in order once back', async () => {
    room = await bootRoom()

    room.emit({ type: 'recording.started', obs: 'B', sessionId: 'ses-1' })
    room.emit(marker('intro'))
    await sleep(2_500)

    // The first batch has gone through.
    expect(room.outboxDepth()).toBe(0)

    // We unplug the cable in the middle of the recording.
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

    // The control app keeps working: the events pile up locally.
    expect(room.outboxDepth()).toBe(3)
    await sleep(2_500)
    expect(room.outboxDepth()).toBe(3)
    expect(room.runtime.state().connectivity).toBe('OFFLINE')

    // We plug it back in.
    proxy.plug()
    await sleep(6_000)

    expect(room.outboxDepth()).toBe(0)
    expect(room.runtime.state().connectivity).toBe('ONLINE')

    // Hub side: everything is there, once each, in emission order.
    const received = hub.services.ingest.eventsFor(TRACK_1)
    const types = received.map((e) => e.type)

    expect(types).toContain('recording.started')
    expect(types).toContain('recording.stopped')
    expect(types.filter((t) => t === 'talk.marker')).toHaveLength(3)

    // No duplicate despite the reconnection's replays.
    expect(new Set(received.map((e) => e.id)).size).toBe(received.length)

    // The `seq` are strictly increasing: emission order is preserved, which is
    // what keeps the talk's timecodes usable at editing time.
    const seqs = received.map((e) => e.seq)
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b))

    // The `recording.stopped` does arrive after its `recording.started`.
    expect(types.indexOf('recording.stopped')).toBeGreaterThan(types.indexOf('recording.started'))
  }, 60_000)
})

describe('events emitted while offline', () => {
  it('queues as soon as the room is known, with no network', async () => {
    const dbPath = join(dir, 'salle.db')
    // First commissioning: the room is already known to the local cache.
    const seeded = new LocalStore(dbPath)
    seeded.saveSettings({ roomId: TRACK_1 })
    seeded.close()

    proxy.unplug()
    room = new RoomApp({
      dataDir: dir,
      hubOrigin: proxy.origin,
      clientId: CLIENT_ID,
      // Room known up front: these tests have no screen to choose it on.
      roomId: TRACK_1,
      displayPort: 0,
      obsTransportFactory: fakeObs,
      readToken: () => 'cached-token',
      writeToken: () => {},
    })
    await room.startDisplay()

    // No hub reachable, no link open: the event must still be captured,
    // otherwise an offline restart would lose the OBS start-up.
    room.emit({ type: 'obs.connection', obs: 'A', connected: true, unresolvedRoles: [] })
    expect(room.outboxDepth()).toBe(1)
  }, 30_000)
})

describe('falling back to a local file', () => {
  it('opens a room without the hub ever having answered', async () => {
    const path = join(dir, 'programme.json')
    const { writeFileSync } = await import('node:fs')
    writeFileSync(path, rawProgram)

    proxy.unplug()
    room = new RoomApp({
      dataDir: dir,
      hubOrigin: proxy.origin,
      clientId: CLIENT_ID,
      // Room known up front: these tests have no screen to choose it on.
      roomId: TRACK_1,
      displayPort: 0,
      obsTransportFactory: fakeObs,
      readToken: () => null,
      writeToken: () => {},
    })
    const url = await room.startDisplay()

    // The start-up chain's last resort: the USB stick.
    const result = await room.importProgramFile(path)
    expect(result.sessions).toBe(27)

    room.runtime.setRoomId(TRACK_1)
    const payload = (await (await fetch(`${url}/display/data`)).json()) as { sessions: unknown[] }
    expect(payload.sessions).toHaveLength(15)
  }, 30_000)

  it('produces the same fingerprint as the hub, so as not to duplicate the version', async () => {
    const path = join(dir, 'programme.json')
    const { writeFileSync } = await import('node:fs')
    writeFileSync(path, rawProgram)

    room = new RoomApp({
      dataDir: dir,
      hubOrigin: proxy.origin,
      clientId: CLIENT_ID,
      // Room known up front: these tests have no screen to choose it on.
      roomId: TRACK_1,
      displayPort: 0,
      obsTransportFactory: fakeObs,
      readToken: () => null,
      writeToken: () => {},
    })
    await room.startDisplay()
    const local = await room.importProgramFile(path)

    const sideProgram = hub.services.programs.active()
    expect(local.contentHash).toBe(sideProgram?.contentHash)
  }, 30_000)
})

describe('hard restart while offline', () => {
  it('finds program and queue intact', async () => {
    const dbPath = join(dir, 'salle.db')
    const store = new LocalStore(dbPath)
    store.saveSettings({ roomId: TRACK_1 })

    const outbox = new Outbox(store, TRACK_1)
    outbox.enqueue({ type: 'recording.started', obs: 'B', sessionId: 'ses-1' })
    outbox.enqueue(marker('before-cut'))
    const seqBefore = outbox.claimBatch().map((e) => e.seq)
    store.close()

    // Power cut: the application could flush nothing.
    const reopenedStore = new LocalStore(dbPath)
    const reopened = new Outbox(reopenedStore, TRACK_1)

    expect(reopened.depth()).toBe(2)
    expect(reopened.claimBatch().map((e) => e.seq)).toEqual(seqBefore)
    // The counter does not restart from zero: the hub would otherwise see duplicate `seq`.
    expect(reopenedStore.settings().nextSeq).toBeGreaterThan(seqBefore.at(-1)!)
    reopenedStore.close()
  })
})
