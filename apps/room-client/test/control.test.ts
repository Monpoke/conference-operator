import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
import type { ObsInstance } from '@cloudnord/contract'
import type { DisplayPayload } from '../src/core/display-server.js'

const rawProgram = readFileSync(
  fileURLToPath(new URL('../../../packages/program/test/fixtures/cloudnord-2026.json', import.meta.url)),
  'utf8',
)

const OPERATOR = { email: 'regie@cloudnord.fr', name: 'Régie', password: 'motdepasse-regie-2026' }
const CLIENT_ID = '01JB2ZK5T7QW9V0YHRXM3N4P6C'
const TRACK_1 = 'track-1-teilhard-de-chardin'

function fakeObsPair(recDir: string) {
  // The fake OBS only listens at its own address: a wrong address must fail the
  // way the real one would, otherwise nothing checks what the operator sees when
  // they get the port wrong.
  const make = (scenes: string[], fileUrl: string): ObsTransport => {
    const handlers = new Map<string, ((p: unknown) => void)[]>()
    let current = scenes[1] ?? scenes[0]!
    const emit = (event: string, payload: unknown) => {
      for (const h of handlers.get(event) ?? []) h(payload)
    }
    return {
      connect: async (url: string) => {
        if (url !== fileUrl) throw new Error('connect ECONNREFUSED ' + url)
      },
      disconnect: async () => {},
      call: (async (request: string, args?: Record<string, unknown>) => {
        if (request === 'GetSceneList') {
          return { currentProgramSceneName: current, scenes: scenes.map((sceneName) => ({ sceneName })) }
        }
        if (request === 'SetCurrentProgramScene') {
          current = args!.sceneName as string
          emit('CurrentProgramSceneChanged', { sceneName: current })
        }
        if (request === 'StartRecord') emit('RecordStateChanged', { outputActive: true })
        if (request === 'StopRecord') {
          const path = join(recDir, 'sortie.mkv')
          writeFileSync(path, 'FAUX')
          emit('RecordStateChanged', { outputActive: false, outputPath: path })
        }
        return {}
      }) as ObsTransport['call'],
      on: (event, handler) => {
        const list = handlers.get(event) ?? []
        list.push(handler as (p: unknown) => void)
        handlers.set(event, list)
      },
    }
  }
  /**
   * By instance, never by call order: a reconnection — the one a configuration
   * change causes — recreates both controllers, and a counter would have given
   * OBS-A the scenes of OBS-B.
   */
  return (instance: ObsInstance) =>
    instance === 'A'
      ? make(['Capture HDMI', 'Habillage'], 'ws://127.0.0.1:4455')
      : make(['Talk'], 'ws://127.0.0.1:4456')
}

let hub: Hub
let origin: string
let dir: string
let room: RoomApp
let control: string
/** What the fake folder picker returns, and the starting point it received. */
let chosenFolder: string | null
let folderRequestedWith: string | null | undefined
/** Le dossier que la salle a en configuration, pour comparer. */
let recordingRootConfigure: string

beforeEach(async () => {
  chosenFolder = null
  folderRequestedWith = undefined
  dir = mkdtempSync(join(tmpdir(), 'cloudnord-regie-'))
  const recDir = join(dir, 'rec')
  recordingRootConfigure = recDir
  mkdirSync(recDir, { recursive: true })

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
    fileSlug: 'track1',
    recordingRoot: recDir,
  })

  let token: string | null = null
  room = new RoomApp({
    dataDir: dir,
    hubOrigin: origin,
    clientId: CLIENT_ID,
    // Room known up front: these tests have no screen to choose it on.
    roomId: TRACK_1,
    displayPort: 0,
    obsTransportFactory: fakeObsPair(recDir),
    // The machine's folder picker. Supplied by Electron for real; here by the
    // test, which decides what the operator picks — or whether they give up.
    chooseFolder: async (initial) => {
      folderRequestedWith = initial
      return chosenFolder
    },
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

  control = await room.startDisplay()
  const paired = await room.ensurePaired()
  await room.connectHub(paired!)
  await room.connectObs()
  room.runtime.setClockOffset(Date.parse('2026-10-30T10:20:00.000Z') - Date.now())
  room.runtime.refreshSessions()
})

afterEach(async () => {
  await room.close()
  await hub.close().catch(() => {})
  rmSync(dir, { recursive: true, force: true })
})

const act = async (payload: unknown) => {
  const response = await fetch(`${control}/control/action`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  })
  return { status: response.status, body: (await response.json()) as { ok: boolean; message?: string } }
}

const state = async () => (await (await fetch(`${control}/display/data`)).json()) as DisplayPayload

describe('control window', () => {
  it('serves a page that does not leave its own origin', async () => {
    const html = await (await fetch(`${control}/regie`)).text()

    /*
     * The self-sufficiency invariant, in the shape it took with the bundle: **no
     * resource outside the served origin**. The previous wording — everything
     * inlined, no `src` or `href` tag — aimed at the same thing, but what it
     * protected was the network, not the tag: a file served by the very process
     * already serving the page cannot disappear at a network cut. Here it is not a
     * test of form but of last resort — the room machine sometimes runs with no
     * network at all.
     */
    const resources = [...html.matchAll(/(?:src|href)="([^"]+)"/g)].map((trouve) => trouve[1]!)
    expect(resources.length).toBeGreaterThan(0)
    for (const url of resources) expect(url.startsWith('/')).toBe(true)

    // The event's name is read back from the cache on every request, never frozen
    // into the binary installed on the room machine.
    expect(html).toMatch(/<title>Régie — .+<\/title>/)
  }, 40_000)

  it('switches the room screen', async () => {
    const result = await act({ action: 'display.set', mode: 'programme' })
    expect(result.body.ok).toBe(true)
    expect((await state()).state.mode).toBe('programme')
  }, 40_000)

  it('switches the projection scene on OBS', async () => {
    await act({ action: 'scene.set', role: 'LIVE' })
    expect((await state()).state.sceneRole).toBe('LIVE')
  }, 40_000)

  it('runs through a complete recording', async () => {
    expect((await state()).diagnostics?.recording.active).toBe(false)

    expect((await act({ action: 'recording.start' })).body.ok).toBe(true)
    const enCours = await state()
    expect(enCours.diagnostics?.recording.active).toBe(true)
    expect(enCours.diagnostics?.recording.startedAtMs).toBeGreaterThan(0)

    await act({ action: 'recording.mark', label: 'demo' })
    expect((await state()).diagnostics?.recording.markers).toBe(1)

    const stop = await act({ action: 'recording.stop' })
    expect(stop.body.message).toContain('.mkv')
    expect((await state()).diagnostics?.recording.active).toBe(false)
  }, 40_000)

  it('lays down the editing anchors, and keeps them apart from the chapters', async () => {
    await act({ action: 'recording.start' })

    await act({ action: 'recording.mark', label: 'Début', role: 'debut' })
    // Laid down again at once: that is the false-start gesture, and it must pile
    // nothing up. What the control app reads is one anchor, not two.
    await act({ action: 'recording.mark', label: 'Début', role: 'debut' })
    await act({ action: 'recording.mark', label: 'Questions' })

    const view = await state()
    expect(view.diagnostics?.recording.editing.startMs).not.toBeNull()
    expect(view.diagnostics?.recording.editing.endMs).toBeNull()
    // The two anchors do not count among the chapters: only "Questions" is one.
    expect(view.diagnostics?.recording.markers).toBe(1)

    await act({ action: 'recording.stop' })
  }, 40_000)

  it('returns a readable message rather than a broken page', async () => {
    // Marker outside a recording: an expected error, worded for the operator.
    const result = await act({ action: 'recording.mark', label: 'perdu' })
    expect(result.status).toBe(409)
    expect(result.body.ok).toBe(false)
    expect(result.body.message).toContain('Aucun enregistrement')
  }, 40_000)

  it('refuses an unknown action', async () => {
    expect((await act({ action: 'formatage.disque' })).status).toBe(400)
    // A non-existent scene role is rejected before reaching OBS.
    expect((await act({ action: 'scene.set', role: 'INVENTEE' })).status).toBe(400)
  }, 40_000)

  it('exposes the state of both OBS instances', async () => {
    const diagnostics = (await state()).diagnostics
    expect(diagnostics?.obs.A?.connected).toBe(true)
    expect(diagnostics?.obs.B?.connected).toBe(true)
    // This room's role mapping is complete on both sides.
    expect(diagnostics?.obs.A?.unresolvedRoles).toEqual([])
  }, 40_000)

  it('reports the queue depth and the log', async () => {
    const diagnostics = (await state()).diagnostics
    expect(diagnostics?.outboxDepth).toBeGreaterThanOrEqual(0)
    expect(Array.isArray(diagnostics?.log)).toBe(true)
  }, 40_000)
})

describe('configuring the room from the control app', () => {
  it('offers the scenes actually declared in each instance', async () => {
    // Picking a scene name from a list read off OBS rather than retyping it: the
    // typo is what produces a role that cannot be found.
    const diagnostics = (await state()).diagnostics
    expect(diagnostics?.obs.A?.scenes).toEqual(['Capture HDMI', 'Habillage'])
    expect(diagnostics?.obs.B?.scenes).toEqual(['Talk'])

    expect((await act({ action: 'obs.refreshScenes' })).body.ok).toBe(true)
  }, 40_000)

  /** Roles swapped: the switch must follow the configuration, not the reverse. */
  const SWAP_ROLES = {
    action: 'room.configure',
    patch: {
      obs: { A: { url: 'ws://127.0.0.1:4455' }, B: { url: 'ws://127.0.0.1:4456' } },
      sceneRoles: { A: { LIVE: 'Habillage', HOLD: 'Capture HDMI' }, B: { TALK: 'Talk' } },
      fileSlug: 'salle1',
    },
  }

  it('saves to the hub without cutting anything', async () => {
    // Applying would mean reconnecting, so cutting — including a running take.
    // The moment belongs to the operator.
    expect((await act(SWAP_ROLES)).body.ok).toBe(true)

    expect(hub.services.rooms.get(TRACK_1)!.fileSlug).toBe('salle1')
    const diagnostics = (await state()).diagnostics
    expect(diagnostics?.config?.fileSlug).toBe('salle1')
    // The connection holds, on the previous settings — and the control app says so.
    expect(diagnostics?.obs.A?.connected).toBe(true)
    expect(diagnostics?.config?.obs.A.pending).toBe(true)

    await act({ action: 'scene.set', role: 'HOLD' })
    expect((await state()).diagnostics?.obs.A?.currentSceneName).toBe('Habillage')
  }, 40_000)

  it('applies the settings to the instance being connected', async () => {
    await act(SWAP_ROLES)

    expect((await act({ action: 'obs.connect', instance: 'A' })).body.ok).toBe(true)

    const diagnostics = (await state()).diagnostics
    expect(diagnostics?.obs.A?.connected).toBe(true)
    expect(diagnostics?.config?.obs.A.pending).toBe(false)

    // "HOLD" now names the other scene: it really is the new configuration that
    // is driving.
    await act({ action: 'scene.set', role: 'HOLD' })
    expect((await state()).diagnostics?.obs.A?.currentSceneName).toBe('Capture HDMI')
  }, 40_000)

  it('does not touch the take when the projection is reconnected', async () => {
    // The defect avoided: reconnecting both instances in one go to apply a
    // projection setting, and losing the running take.
    await act({ action: 'recording.start' })
    expect((await state()).diagnostics?.obs.B?.recording).toBe(true)

    await act(SWAP_ROLES)
    await act({ action: 'obs.connect', instance: 'A' })

    const diagnostics = (await state()).diagnostics
    // OBS-B was not reopened: its recording is still there.
    expect(diagnostics?.obs.B?.recording).toBe(true)
    expect(diagnostics?.recording.active).toBe(true)
    // And its settings, for their part, stay pending a reconnection.
    expect(diagnostics?.config?.obs.B.pending).toBe(false)
  }, 40_000)

  it('returns the connection failure to the operator, without a wait', async () => {
    // A single attempt when asked for by hand: the retry loop starts again in the
    // background, but the answer is immediate and readable.
    await act({
      action: 'room.configure',
      patch: { obs: { A: { url: 'ws://127.0.0.1:1' }, B: { url: 'ws://127.0.0.1:4456' } } },
    })

    const result = await act({ action: 'obs.connect', instance: 'A' })
    expect(result.status).toBe(409)
    expect(result.body.message).toContain('OBS-A')
  }, 40_000)

  it('never sends the OBS passwords down to the page', async () => {
    await act({
      action: 'room.configure',
      patch: {
        obs: {
          A: { url: 'ws://127.0.0.1:4455', password: 'mot-de-passe-tres-secret' },
          B: { url: 'ws://127.0.0.1:4456' },
        },
      },
    })

    const diagnostics = (await state()).diagnostics
    expect(diagnostics?.config?.obs.A).toEqual({
      url: 'ws://127.0.0.1:4455',
      hasPassword: true,
      pending: true,
    })
    // The whole payload: the secret must appear nowhere.
    expect(JSON.stringify(diagnostics)).not.toContain('mot-de-passe-tres-secret')
  }, 40_000)

  it('refuses a malformed patch before it reaches the hub', async () => {
    expect((await act({ action: 'room.configure', patch: { displayPort: -1 } })).status).toBe(400)
    expect(hub.services.rooms.get(TRACK_1)!.displayPort).toBe(7788)
  }, 40_000)
})

/**
 * Checking the footage from the control app.
 *
 * End to end: what the take writes to disk must be found again in the list, and
 * the verdict laid down must survive the modal being closed. This is the only
 * moment when a take can still be redone — in the evening, the room is
 * dismantled.
 */
/**
 * The VOD folder, chosen on the machine.
 *
 * A disk path can only be typed by hand without error when one has it in front of
 * them — and it is **the room machine**'s disk it names, wherever the page is
 * being read.
 */
describe('folder picker', () => {
  it('returns the chosen path, and starts from the folder already typed', async () => {
    chosenFolder = '/media/rushes/2026'
    const result = await act({ action: 'config.chooseFolder' })

    expect(result.body.ok).toBe(true)
    expect((result.body as { detail?: unknown }).detail).toBe('/media/rushes/2026')
    // Fixing a path almost always means changing one branch of it: the picker
    // opens where one was looking, not at the root.
    expect(folderRequestedWith).toBe(recordingRootConfigure)
  })

  it('does not treat giving up as a failure', async () => {
    chosenFolder = null
    const result = await act({ action: 'config.chooseFolder' })

    // Closing a picker is a gesture, not a failure: a red at that moment would
    // read as a refusal from the machine.
    expect(result.body.ok).toBe(true)
    expect((result.body as { detail?: unknown }).detail).toBeNull()
  })

  it('writes nothing into the room\'s configuration', async () => {
    chosenFolder = '/media/rushes/2026'
    await act({ action: 'config.chooseFolder' })

    // "Enregistrer" is what decides, as for the rest of the panel.
    expect(room.diagnostics().config?.recordingRoot).toBe(recordingRootConfigure)
  })

  it('tells the control app that this machine can open it', () => {
    // The page cannot guess it: it runs just as well in the machine's Electron
    // window as in a browser opened beside it.
    expect(room.diagnostics().config?.canBrowse).toBe(true)
  })
})

describe('checking the recordings', () => {
  const listRecordings = async () =>
    (await (await fetch(`${control}/control/recordings`)).json()) as {
      ok: boolean
      root: string | null
      entries: {
        file: string
        sizeBytes: number
        sidecar: { title: string } | null
        check: { status: string; by: string; reasons: string[] } | null
      }[]
    }

  it('lists the footage produced, with the talk\'s title', async () => {
    expect((await listRecordings()).entries).toEqual([])

    await act({ action: 'recording.start' })
    await act({ action: 'recording.stop' })

    const listing = await listRecordings()
    expect(listing.root).toMatch(/rec$/)
    expect(listing.entries).toHaveLength(1)
    expect(listing.entries[0]!.file).toMatch(/\.mkv$/)
    // The sidecar is paired with the file: it is what carries the title.
    expect(listing.entries[0]!.sidecar?.title).toBeTruthy()
    expect(listing.entries[0]!.check).toBeNull()
  }, 40_000)

  it('refuses to declare a four-byte file usable', async () => {
    await act({ action: 'recording.start' })
    await act({ action: 'recording.stop' })
    const rush = (await listRecordings()).entries[0]!

    const inspected = await act({ action: 'vod.inspect', file: rush.file })
    expect(inspected.body.ok).toBe(true)

    const after = (await listRecordings()).entries[0]!
    // The fake OBS writes four bytes: whether or not ffprobe is installed on the
    // test machine, nothing in there can pass for a talk.
    expect(after.check?.status).not.toBe('ok')
    expect(after.check?.reasons.length).toBeGreaterThan(0)
  }, 40_000)

  it('keeps the operator\'s verdict, and lets it be taken back', async () => {
    await act({ action: 'recording.start' })
    await act({ action: 'recording.stop' })
    const rush = (await listRecordings()).entries[0]!

    await act({ action: 'vod.verdict', file: rush.file, status: 'illisible' })
    expect((await listRecordings()).entries[0]!.check).toMatchObject({ status: 'illisible', by: 'operateur' })

    await act({ action: 'vod.verdict', file: rush.file, status: null })
    expect((await listRecordings()).entries[0]!.check).toBeNull()
  }, 40_000)

  it('serves the footage as is, and by range', async () => {
    await act({ action: 'recording.start' })
    await act({ action: 'recording.stop' })
    const rush = (await listRecordings()).entries[0]!
    const fileUrl = `${control}/control/recordings/file?file=` + encodeURIComponent(rush.file)

    const whole = await fetch(fileUrl)
    expect(whole.status).toBe(200)
    expect(whole.headers.get('content-type')).toBe('video/x-matroska')
    expect(whole.headers.get('accept-ranges')).toBe('bytes')
    expect((await whole.text()).length).toBe(rush.sizeBytes)

    // Ranges are what make a three-gigabyte file seekable: without them, a player
    // downloads everything before the first frame.
    const slice = await fetch(fileUrl, { headers: { range: 'bytes=1-2' } })
    expect(slice.status).toBe(206)
    expect(slice.headers.get('content-range')).toBe(`bytes 1-2/${rush.sizeBytes}`)
    expect((await slice.text()).length).toBe(2)
  }, 40_000)

  it('does not let just anything on the disk be read', async () => {
    // The control app is served over HTTP on the machine: these two routes return
    // bytes, and they are exactly where a `..` would cost dearly.
    const read = await fetch(`${control}/control/recordings/file?file=../../etc/passwd`)
    expect(read.status).toBe(409)

    const excerpt = await fetch(`${control}/control/recordings/excerpt?file=../../etc/passwd`)
    expect(excerpt.status).toBe(409)
  }, 40_000)

  it('returns 404 on footage that no longer exists', async () => {
    const response = await fetch(`${control}/control/recordings/file?file=jamais.mkv`)
    expect(response.status).toBe(404)
  }, 40_000)

  it('does not leave the recordings folder', async () => {
    // The page is served over HTTP on the machine: a `..` in the file name would
    // read, and mark, just anything on the disk.
    const result = await act({ action: 'vod.inspect', file: '../../etc/passwd' })
    expect(result.status).toBe(409)
    expect(result.body.message).toContain('hors du dossier')
  }, 40_000)
})
