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

const OPERATOR = { email: 'regie@cloudnord.fr', name: 'Régie', password: 'control-password-2026' }
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

/** Runs the real pairing, from code to token, as on the first start-up. */
async function pair(): Promise<string> {
  const transport = httpPairingTransport(origin)
  let approved = false

  const pairing = runPairing(transport, CLIENT_ID, {
    onCode: (code) => {
      // The operator reads the code on the control screen and approves it in the admin.
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

  // Exchanged for a room token: the approving session carries the operator's
  // rights, and a control machine has no business keeping them.
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
 * A room plugged in, ready to receive. The effects stand in for OBS.
 *
 * The runtime does not know OBS — it decides *what* to do, the machine knows
 * *how* — which lets the whole chain be exercised with no instance.
 */
async function pluggedRoom(effects: RuntimeEffects) {
  const token = await pair()
  const { runtime, link, store } = makeClient(token, ':memory:', effects)
  await link.sync()
  const controller = new AbortController()
  void link.consumeCommands(controller.signal)
  await sleep(200)
  return { runtime, controller, token, store }
}

describe('room and hub, full chain', () => {
  it('pairs, then fetches its own room\'s program', async () => {
    const token = await pair()
    const { store, runtime, link } = makeClient(token)

    const result = await link.sync()
    expect(result.ok).toBe(true)

    expect(runtime.state().roomId).toBe(TRACK_1)
    // 27 slots in the export, 38 served by the hub: the shared breaks are
    // projected into the free rooms at the same time.
    expect(store.activeProgram()?.program.sessions).toHaveLength(38)
    expect(store.settings().config?.sceneRoles.A?.LIVE).toBe('Capture HDMI')
  }, 20_000)

  it('receives the hub\'s commands and applies them', async () => {
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
     * With no explicit recipient, the message stays on the control banner.
     *
     * That is the least damaging default: a message that only reaches the
     * operator can be made good, one projected in front of the audience cannot.
     */
    expect(runtime.state().message).toBeNull()
    expect(runtime.state().notifications.map((n) => n.text).join(' ')).toContain(
      'Ouverture des portes',
    )
    controller.abort()
  }, 20_000)

  it('catches up on the commands issued during a cut', async () => {
    const token = await pair()
    const { store, runtime, link } = makeClient(token)
    await link.sync()

    const first = new AbortController()
    void link.consumeCommands(first.signal)
    await sleep(200)
    hub.services.commands.publish(TRACK_1, { type: 'scene.force', role: 'HOLD' }, null)
    await sleep(300)
    expect(runtime.state().sceneRole).toBe('HOLD')

    // Cut: the stream stops, the hub keeps emitting.
    first.abort()
    await sleep(100)
    hub.services.commands.publish(TRACK_1, { type: 'scene.force', role: 'LIVE' }, null)
    hub.services.commands.publish(TRACK_1, { type: 'display.set', mode: 'programme' }, null)

    // Reconnection: the resume starts from the last applied `seq`, stored locally.
    const seqBefore = store.settings().lastCommandSeq
    const second = new AbortController()
    void link.consumeCommands(second.signal)
    await sleep(500)

    expect(runtime.state().sceneRole).toBe('LIVE')
    expect(runtime.state().mode).toBe('programme')
    expect(store.settings().lastCommandSeq).toBeGreaterThan(seqBefore)
    second.abort()
  }, 20_000)

  it('starts on its cache when the hub is unreachable', async () => {
    const token = await pair()
    const dbPath = join(tempDir, 'salle.db')

    // First day: the room synchronises and caches.
    const online = makeClient(token, dbPath)
    await online.link.sync()
    expect(online.store.activeProgram()).not.toBeNull()
    await online.link.close()
    online.store.close()
    openStores.pop()

    // The hub goes down. We only close the HTTP listener: closing SQLite here as
    // well would make Better Auth shout about requests still in flight, which
    // would look like a test failure without being one.
    await hub.app.close()

    const offline = new LocalStore(dbPath)
    openStores.push(offline)
    const runtime = new RoomRuntime(offline)
    // The program and the room are there, with not a single network call.
    expect(offline.activeProgram()?.program.sessions).toHaveLength(38)
    expect(offline.settings().roomId).toBe(TRACK_1)
    expect(runtime.state().contentHash).toBeTruthy()

    const link = new HubLink({
      hubOrigin: origin,
      clientId: CLIENT_ID,
      token,
      store: offline,
      runtime,
      // Short deadline: the test checks that `sync` returns, not that it waits.
      syncTimeoutMs: 1_500,
    })
    openLinks.push(link)

    // The synchronisation fails without throwing, and the screen stays served.
    const result = await link.sync()
    expect(result.ok).toBe(false)
    expect(runtime.state().connectivity).toBe('OFFLINE')
    expect(runtime.state().roomId).toBe(TRACK_1)


  }, 25_000)
})

/**
 * The mobile control app, end to end.
 *
 * The link no unit test covers: an operator makes a gesture over HTTP on the
 * hub, the command crosses the WebSocket, and the room applies it. Each of the
 * three sides is checked elsewhere; what breaks in silence is the joint.
 */
describe('mobile control app, from the phone to the room', () => {
  /**
   * What the page does: connect, announce itself, then call the contract.
   *
   * The session header is what the lock keys on — an account can have two tabs
   * open, and they must not both believe they hold it. `session` lets a second
   * one be simulated.
   */
  async function asPhone(token: string, session = 'session-phone') {
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

  it('carries scene, take and lock all the way to the room', async () => {
    const scenes: string[] = []
    const captations: boolean[] = []
    const { runtime, controller } = await pluggedRoom({
      setSceneRole: async (role) => {
        scenes.push(role)
        runtime.observeSceneRole(role)
      },
      setRecording: (on) => {
        captations.push(on)
        runtime.observeCapture({ recording: on })
      },
    })

    const phone = await asPhone(await signInOperator())
    await phone.regie.hold({ roomId: TRACK_1, force: false })
    await phone.regie.command({ roomId: TRACK_1, action: { type: 'scene.set', role: 'LIVE' } })
    await phone.regie.command({ roomId: TRACK_1, action: { type: 'recording.set', on: true } })
    await sleep(500)

    expect(scenes).toEqual(['LIVE'])
    expect(captations).toEqual([true])
    // The control screen's badge: it greys nothing out, it says who is driving.
    expect(runtime.state().remoteHolder).toBe(OPERATOR.email)
    // And the notice names the author, so nobody goes looking for a failure.
    expect(runtime.state().notifications.map((n) => n.text).join(' ')).toContain(OPERATOR.email)

    controller.abort()
  }, 25_000)

  it('returns to the phone what the room reported', async () => {
    /*
     * The full round trip, and the property "Commencer" depends on.
     *
     * The mobile control app never paints ahead: it confirms the recording by
     * **observation**, polling until it sees `recording` turn true. But what the
     * room observes still has to reach the view — otherwise the confirmation
     * times out on a take that is running, and "Commencer" gives up for nothing.
     *
     * The uplink is assembled here the way `RoomApp` assembles it: the local
     * queue, the pump, and `ingest.push` at the end. That is the real path,
     * without the display server this test has no use for.
     */
    const { runtime, controller, store } = await pluggedRoom({
      setRecording: (on) => runtime.observeCapture({ recording: on }),
    })
    const link = openLinks.at(-1)!
    const outbox = new Outbox(store, TRACK_1)
    const pump = new OutboxPump({
      outbox,
      store,
      push: (batch) => link.client.ingest.push({ batch }),
    })

    const phone = await asPhone(await signInOperator())
    await phone.regie.hold({ roomId: TRACK_1, force: false })
    expect((await phone.regie.view({ roomId: TRACK_1 })).recording).toBe(false)

    await phone.regie.command({ roomId: TRACK_1, action: { type: 'recording.set', on: true } })
    await sleep(400)
    expect(runtime.state().recording).toBe(true)

    // The heartbeat carries what the room observes: it is what paints
    // `room_state`, and `room_state` is what the phone's view reads back.
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

  it('refuses the gesture of whoever does not hold the room, sending nothing', async () => {
    const scenes: string[] = []
    const { controller } = await pluggedRoom({
      setSceneRole: async (role) => {
        scenes.push(role)
      },
    })

    const phone = await asPhone(await signInOperator())
    // No hold: the hub refuses, and nothing goes down. Without that refusal, two
    // phones would switch the same room in opposite directions.
    await expect(
      phone.regie.command({ roomId: TRACK_1, action: { type: 'scene.set', role: 'LIVE' } }),
    ).rejects.toThrow()
    await sleep(300)
    expect(scenes).toEqual([])

    controller.abort()
  }, 25_000)
})
