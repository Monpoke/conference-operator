import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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

/** A fake OBS: the room's scenes, with no real instance. */
function fakeObs(scenes = ['Capture HDMI', 'Habillage']) {
  const handlers = new Map<string, ((payload: unknown) => void)[]>()
  let current = scenes[1] ?? scenes[0]!
  const transport: ObsTransport = {
    connect: vi.fn(async () => {}),
    disconnect: vi.fn(async () => {}),
    call: (async (request: string, args?: Record<string, unknown>) => {
      if (request === 'GetSceneList') {
        return { currentProgramSceneName: current, scenes: scenes.map((sceneName) => ({ sceneName })) }
      }
      if (request === 'SetCurrentProgramScene') {
        current = args!.sceneName as string
        for (const h of handlers.get('CurrentProgramSceneChanged') ?? []) h({ sceneName: current })
      }
      return {}
    }) as ObsTransport['call'],
    on: (event, handler) => {
      const list = handlers.get(event) ?? []
      list.push(handler as (payload: unknown) => void)
      handlers.set(event, list)
    },
  }
  return {
    transport,
    get currentScene() { return current },
    /** What OBS pushes on its own: a recording started on the machine. */
    emettre(event: string, payload: unknown) {
      for (const h of handlers.get(event) ?? []) h(payload)
    },
  }
}

let hub: Hub
let origin: string
let dir: string
let room: RoomApp
let obs: ReturnType<typeof fakeObs>

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'cloudnord-app-'))
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
    sceneRoles: { A: { LIVE: 'Capture HDMI', HOLD: 'Habillage' }, B: { TALK: 'Talk' } },
    displayPort: 7788,
    recordingRoot: null,
  })

  obs = fakeObs()
})

afterEach(async () => {
  await room?.close()
  await hub.close().catch(() => {})
  rmSync(dir, { recursive: true, force: true })
})

function makeApp(hubOrigin = origin) {
  let token: string | null = null
  const app = new RoomApp({
    dataDir: dir,
    hubOrigin,
    clientId: CLIENT_ID,
    // Room known up front: these tests have no screen to choose it on.
    roomId: TRACK_1,
    readToken: () => token,
    writeToken: (value) => {
      token = value
    },
    displayPort: 0,
    obsTransportFactory: () => obs.transport,
    onPairingCode: (code) => {
      // The operator approves from the admin console while the machine polls.
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
        await admin.devices.approve({
          userCode: code.user_code,
          clientId: CLIENT_ID,
          roomId: TRACK_1,
          label: 'PC régie salle 1',
        })
      })()
    },
  })
  return app
}

describe('room machine, full start-up', () => {
  it('serves the screen before even talking to the hub', async () => {
    room = makeApp('http://127.0.0.1:1') // hub volontairement injoignable
    const url = await room.startDisplay()

    // The project's central rule: the room projects, come what may.
    const page = await fetch(`${url}/display/projector`)
    expect(page.status).toBe(200)

    const token = await room.ensurePaired()
    expect(token).toBeNull()
  }, 20_000)

  it('announces to the transport the scenes the room expects', async () => {
    /*
     * The real client ignores them — an OBS has the scenes that were created in
     * it, and that gap is precisely what must show up in red. The simulator, on
     * the other hand, uses them to exist with the scenes expected of it: without
     * this, any slightly personal name came back as "role not found" on an
     * instance that does not exist.
     */
    const recus: [string, string[]][] = []
    room = makeApp()
    ;(room as unknown as { options: { obsTransportFactory: unknown } }).options.obsTransportFactory =
      (instance: string, scenes: string[]) => {
        recus.push([instance, scenes])
        return obs.transport
      }

    await room.startDisplay()
    const token = await room.ensurePaired()
    await room.connectHub(token!)
    await room.connectObs()

    // The names from the room's configuration, not those of a constant.
    expect(recus).toEqual([
      ['A', ['Capture HDMI', 'Habillage']],
      ['B', ['Talk']],
    ])
  }, 20_000)

  it('pairs, synchronises, drives OBS and receives the commands', async () => {
    room = makeApp()
    const url = await room.startDisplay()

    const token = await room.ensurePaired()
    expect(token).toBeTruthy()

    await room.connectHub(token!)
    await room.connectObs()

    // The room's program is served to the screen.
    const payload = (await (await fetch(`${url}/display/data`)).json()) as DisplayPayload
    expect(payload.sessions).toHaveLength(15)
    expect(payload.event?.name).toBe('Cloud Nord 2026')

    // A command from the hub really switches the OBS scene.
    hub.services.commands.publish(TRACK_1, { type: 'scene.force', role: 'LIVE' }, null)
    await sleep(500)
    expect(obs.currentScene).toBe('Capture HDMI')
    expect(room.runtime.state().sceneRole).toBe('LIVE')

    // And the screen follows the requested mode.
    hub.services.commands.publish(TRACK_1, { type: 'display.set', mode: 'programme' }, null)
    await sleep(400)
    const after = (await (await fetch(`${url}/display/data`)).json()) as DisplayPayload
    expect(after.state.mode).toBe('programme')
  }, 30_000)

  it('caches the assets so the screen no longer depends on the network', async () => {
    room = makeApp()
    await room.startDisplay()
    const token = await room.ensurePaired()
    await room.connectHub(token!)

    // The real assets are remote; in tests the prefetch fails and that has no
    // consequence: the screen keeps the original URLs and stays serveable.
    const cached = room.store.activeProgram()
    expect(cached).not.toBeNull()
    expect(room.assets.localize(cached!.program).sponsorTiers[0]?.name).toBe('Gold')
  }, 30_000)
})

/**
 * What the room reports to the hub, and why it matters now.
 *
 * `room_state` used to be read only by the supervision console, which watches.
 * The mobile control app uses it to **paint buttons**: what arrives there wrong
 * is no longer a debatable table row, it is a dark indicator on a room that is
 * recording.
 */
describe('the heartbeat', () => {
  /** Two instances, two transports: that is the whole point of these tests. */
  async function roomWithTwoObs() {
    const a = fakeObs()
    const b = fakeObs(['Talk'])
    room = makeApp()
    ;(room as unknown as { options: { obsTransportFactory: unknown } }).options.obsTransportFactory =
      (instance: string) => (instance === 'A' ? a.transport : b.transport)

    await room.startDisplay()
    const token = await room.ensurePaired()
    await room.connectHub(token!)
    await room.connectObs()
    return { a, b }
  }

  const statut = () => hub.services.rooms.statuses().find((s) => s.roomId === TRACK_1)

  it("carries OBS-B's take, not OBS-A's", async () => {
    /*
     * The defect frozen here: the heartbeat queried `obsA`.
     *
     * OBS-A projects, OBS-B records. The heartbeat therefore reported `false`
     * every ten seconds, overwriting on the hub the `recording` that
     * `recording.started` had just written there — the mobile control app showed a
     * dark indicator on a room in mid-take, and the console with it.
     */
    const { b } = await roomWithTwoObs()

    // Started from OBS itself: no `recording.started` is emitted, so this fact
    // only travels through the heartbeat. That is the worst case, so the right test.
    b.emettre('RecordStateChanged', { outputActive: true })
    await sleep(800)

    expect(room.runtime.state().recording).toBe(true)
    expect(statut()?.recording).toBe(true)
  }, 30_000)

  it('writes the sidecar when the take is stopped from OBS', async () => {
    /*
     * The gesture is common and legitimate: the hand is already in OBS, and one
     * presses "Arrêter l'enregistrement" there. The control app has then asked for
     * nothing and awaits no path — and everything the take knew about itself went
     * in the bin, markers included, which exist nowhere else.
     */
    const { b } = await roomWithTwoObs()
    await room.startRecording()
    room.mark('demo')

    const master = join(dir, 'depuis-obs.mkv')
    writeFileSync(master, 'FAUX')
    b.emettre('RecordStateChanged', {
      outputActive: false,
      outputState: 'OBS_WEBSOCKET_OUTPUT_STOPPED',
      outputPath: master,
    })
    await sleep(300)

    const sidecars = readdirSync(dir).filter((nom) => nom.endsWith('.json'))
    expect(sidecars).toHaveLength(1)
    const sidecar = JSON.parse(readFileSync(join(dir, sidecars[0]!), 'utf8')) as {
      markers: { label: string }[]
    }
    expect(sidecar.markers.map((marker) => marker.label)).toEqual(['demo'])
    // The take is closed: the control app does not believe a recording is still running.
    expect(room.runtime.state().recording).toBe(false)
  }, 30_000)

  it('does not write a second sidecar when the stop comes from the control app', async () => {
    // Both paths lead to the sidecar and can cross: OBS's event arrives right
    // after `StopRecord`, while the take is still open.
    const { b } = await roomWithTwoObs()
    await room.startRecording()

    const master = join(dir, 'depuis-regie.mkv')
    writeFileSync(master, 'FAUX')
    const arret = room.stopRecording()
    b.emettre('RecordStateChanged', {
      outputActive: false,
      outputState: 'OBS_WEBSOCKET_OUTPUT_STOPPED',
      outputPath: master,
    })
    await arret
    await sleep(300)

    expect(readdirSync(dir).filter((nom) => nom.endsWith('.json'))).toHaveLength(1)
  }, 30_000)

  it('reports the room screen, so the phone knows which button to light', async () => {
    await roomWithTwoObs()

    // A mobile control app's gesture: the hub publishes, the room applies, and
    // the room says so — without waiting for the next tick, otherwise the button
    // stays dead for ten seconds and one presses a second time.
    hub.services.commands.publish(TRACK_1, { type: 'display.set', mode: 'programme' }, null)
    await sleep(800)

    expect(room.runtime.state().mode).toBe('programme')
    expect(statut()?.displayMode).toBe('programme')
  }, 30_000)
})

/**
 * Audience questions, bounded to the talk being driven.
 *
 * Across all rooms, the list mixed the whole day together: at 4 pm, the questions
 * from the 10 am talk were still at the top of the vote, and the speaker found
 * themselves asked a question that had nothing to do with them.
 */
describe('audience questions', () => {
  it('reports only those of the driven talk', async () => {
    room = makeApp()
    await room.startDisplay()
    const token = await room.ensurePaired()
    await room.connectHub(token!)

    const target = room.runtime.state().targetSession
    expect(target).not.toBeNull()

    hub.services.questions.post({
      roomId: TRACK_1, sessionId: target!.id, author: 'Camille',
      text: 'Comment gérez-vous les faux positifs ?',
    })
    hub.services.questions.post({
      roomId: TRACK_1, sessionId: 'un-autre-talk', author: null,
      text: 'Question du talk de ce matin',
    })

    await room.refreshQuestions()

    const { questions, questionsSession } = room.diagnostics()
    expect(questions.map((q) => q.text)).toEqual(['Comment gérez-vous les faux positifs ?'])
    // The talk is named: an empty list does not mean the same thing when one is
    // driving a talk with no question and when one is driving none at all.
    expect(questionsSession).toEqual({ id: target!.id, title: target!.title })
  }, 30_000)

  it('attaches the question put on air to that talk', async () => {
    // That is what makes it drop at the next one, rather than stay burned into
    // the next speaker's VOD.
    room = makeApp()
    await room.startDisplay()
    const token = await room.ensurePaired()
    await room.connectHub(token!)

    room.setAiredQuestion('Et les faux positifs ?', 'Camille')

    expect(room.runtime.state().question).toEqual({
      text: 'Et les faux positifs ?',
      author: 'Camille',
      sessionId: room.runtime.state().targetSession?.id,
    })
    // And above all not on the console banner's channel.
    expect(room.runtime.state().liveMessage).toBeNull()
  }, 30_000)
})

/**
 * The waiting loop: what it needs to know.
 *
 * Two fields the room computes on its own, from the already cached program — the
 * loop has to run all the way through during a break, that is, when the event's
 * network is at its busiest.
 */
describe('waiting loop', () => {
  it('knows what is playing in the other rooms, asking the hub for nothing', async () => {
    room = makeApp()
    const url = await room.startDisplay()
    const token = await room.ensurePaired()
    await room.connectHub(token!)

    const payload = (await (await fetch(`${url}/display/data`)).json()) as DisplayPayload

    // The two other tracks, never its own.
    expect(payload.otherRooms.map((other) => other.roomId)).toEqual([
      'track-2-mf-1092',
      'hands-on',
    ])
    // Talks, not breaks: "Déjeuner en Track #2" helps nobody choose where to go.
    for (const other of payload.otherRooms) {
      expect(other.session?.title).not.toContain('Déjeuner')
    }
  }, 30_000)

  it('receives the event\'s accounts from the hub, and keeps them', async () => {
    hub.services.settings.update({
      socialLinks: [
        { network: 'Bluesky', handle: '@cloudnord.fr', url: 'https://bsky.app/profile/cloudnord.fr' },
      ],
    })

    room = makeApp()
    const url = await room.startDisplay()
    const token = await room.ensurePaired()
    await room.connectHub(token!)

    const payload = (await (await fetch(`${url}/display/data`)).json()) as DisplayPayload
    expect(payload.socialLinks).toEqual([
      { network: 'Bluesky', handle: '@cloudnord.fr', url: 'https://bsky.app/profile/cloudnord.fr' },
    ])
    // Cached locally: a room restarting with the hub unreachable runs the same
    // loop as any other.
    expect(room.store.settings().socialLinks).toHaveLength(1)
  }, 30_000)

  it('learns the event\'s name from the hub, and keeps it', async () => {
    // Nothing is compiled into the binary: the room machine receives the name at
    // sync time, and that is what lets it serve next year's edition without being
    // reinstalled. The hub derives it here from the imported program.
    room = makeApp()
    const url = await room.startDisplay()
    const token = await room.ensurePaired()
    await room.connectHub(token!)

    const payload = (await (await fetch(`${url}/display/data`)).json()) as DisplayPayload
    expect(payload.eventIdentity).toEqual({ name: 'Cloud Nord 2026', shortName: 'Cloud Nord' })
    // Cached, like the program: a room starting with the hub unreachable still
    // titles its windows correctly.
    expect(room.store.settings().event.name).toBe('Cloud Nord 2026')
  }, 30_000)
})
