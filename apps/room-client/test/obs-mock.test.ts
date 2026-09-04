import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { normalizeProgram } from '@cloudnord/program'
import { createMockObsTransport, DEFAULT_SCENES } from '../src/core/obs-mock.js'
import { ObsController } from '../src/core/obs.js'
import { LocalStore } from '../src/core/store.js'
import { RoomRuntime } from '../src/core/runtime.js'
import { RecordingSession } from '../src/core/recording.js'

const program = normalizeProgram(
  JSON.parse(
    readFileSync(
      fileURLToPath(new URL('../../../packages/program/test/fixtures/cloudnord-2026.json', import.meta.url)),
      'utf8',
    ),
  ),
)
const TRACK_1 = 'track-1-teilhard-de-chardin'
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cloudnord-mock-'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('simulated OBS', () => {
  /**
   * The case reported from the control room: the take was already "running" at
   * power-on, without anyone having started it, and it had to be stopped before
   * one could be started.
   *
   * Adopting OBS's take on connection exists for the app restarted in the middle
   * of a talk. A simulated instance has no talk behind it: what it keeps from one
   * connection to the next is the memory of no video at all.
   */
  it('cuts a running take instead of adopting it', async () => {
    const transport = createMockObsTransport({ instance: 'B', recordingDir: join(dir, 'rec') })
    await transport.call('StartRecord')

    const obs = new ObsController({
      instance: 'B',
      url: 'mock',
      sceneRoles: {},
      transport,
    })
    const state = await obs.connect()

    expect(state.recording).toBe(false)
    // Cut for good, and not merely hidden: without this, the next "Enregistrer"
    // would fail on an "already running" that the screen contradicts.
    expect(await transport.call('GetRecordStatus')).toMatchObject({ outputActive: false })
  })

  it("adopts a real instance's take", async () => {
    /**
     * A guard for the guard: the rule only holds for the simulated one. A real
     * take found running again at restart must stay adopted, otherwise the
     * control app would announce a lost VOD that is in fact recording.
     */
    const transport = createMockObsTransport({ instance: 'B', recordingDir: join(dir, 'rec') })
    await transport.call('StartRecord')
    const asReal = { ...transport, simulated: false }

    const obs = new ObsController({
      instance: 'B',
      url: 'ws://127.0.0.1:4456',
      sceneRoles: {},
      transport: asReal,
    })

    expect((await obs.connect()).recording).toBe(true)
  })

  it('declares itself simulated, so the control app can say so', async () => {
    // Nothing on screen tells a simulated recording from a real one: the
    // transport carries the information itself, rather than an environment
    // variable read back elsewhere, which could contradict it.
    const simulated = new ObsController({
      instance: 'A',
      url: 'mock',
      sceneRoles: {},
      transport: createMockObsTransport({ instance: 'A', recordingDir: join(dir, 'rec') }),
    })
    expect(simulated.snapshot().simulated).toBe(true)

    const real = new ObsController({
      instance: 'A',
      url: 'ws://127.0.0.1:4455',
      sceneRoles: {},
      transport: {
        connect: async () => {},
        disconnect: async () => {},
        call: (async () => ({})) as never,
        on: () => {},
      },
    })
    expect(real.snapshot().simulated).toBe(false)
  })

  it('carries the scenes the room configured, however personal they are', async () => {
    /*
     * A simulated OBS has no scenes of its own: it has the ones expected of it.
     *
     * Without this, any slightly personal name — "Direct 4K", a studio's name, an
     * event convention — came back as "role not found", red in the control app,
     * on an instance that does not exist. One does not debug the typo of an OBS
     * one has not installed.
     */
    const CUSTOM = { LIVE: 'Direct 4K — régie mobile', HOLD: 'Mon habillage à moi' }
    const controller = new ObsController({
      instance: 'A',
      url: 'mock',
      sceneRoles: CUSTOM,
      transport: createMockObsTransport({
        instance: 'A',
        scenes: Object.values(CUSTOM),
        recordingDir: join(dir, 'rec'),
      }),
    })

    const state = await controller.connect()
    expect(state.unresolvedRoles).toEqual([])

    // And the switch goes through: it is the gesture the red announced as bound
    // to fail. The state follows OBS's event, never the call — the control app
    // does not paint ahead.
    await controller.setRole('LIVE')
    await sleep(30)
    expect(controller.snapshot().currentSceneName).toBe(CUSTOM.LIVE)
    expect(controller.snapshot().currentRole).toBe('LIVE')
  })

  it("keeps the plausible scenes alongside the room's own", async () => {
    /*
     * They add up, they do not replace: the ⚙ selector must keep a list to
     * choose from, including on a room whose configuration covers a single
     * role.
     */
    const transport = createMockObsTransport({
      instance: 'A',
      scenes: ['Direct 4K — régie mobile'],
      recordingDir: join(dir, 'rec'),
    })
    await transport.connect('mock')
    const { scenes } = (await transport.call('GetSceneList')) as {
      scenes: { sceneName: string }[]
    }
    const names = scenes.map((scene) => scene.sceneName)

    expect(names).toContain('Direct 4K — régie mobile')
    for (const plausible of DEFAULT_SCENES.A) expect(names).toContain(plausible)
    // Deduplicated: a room configured on the default names must not see them
    // twice in the selector.
    expect(new Set(names).size).toBe(names.length)
  })

  it('exposes the same scenes as the mapping laid down when a room is created', async () => {
    const controller = new ObsController({
      instance: 'A',
      url: 'mock',
      sceneRoles: {
        LIVE: DEFAULT_SCENES.A[0]!,
        HOLD: DEFAULT_SCENES.A[1]!,
      },
      transport: createMockObsTransport({ instance: 'A', recordingDir: join(dir, 'rec') }),
    })

    const state = await controller.connect()
    // Without that agreement, the control app would show roles in red as soon as
    // simulated mode starts — and one would think it a bug.
    expect(state.unresolvedRoles).toEqual([])
    expect(state.currentRole).toBe('HOLD')
  })

  it('confirms the switch by event, like the real OBS', async () => {
    const controller = new ObsController({
      instance: 'A',
      url: 'mock',
      sceneRoles: { LIVE: DEFAULT_SCENES.A[0]!, HOLD: DEFAULT_SCENES.A[1]! },
      transport: createMockObsTransport({ instance: 'A', recordingDir: join(dir, 'rec') }),
    })
    await controller.connect()
    await controller.setRole('LIVE')

    // The event is asynchronous: the state cannot be right immediately, exactly
    // as with OBS.
    await sleep(30)
    expect(controller.snapshot().currentRole).toBe('LIVE')
  })

  it('refuses an unknown scene', async () => {
    const transport = createMockObsTransport({ instance: 'A', recordingDir: join(dir, 'rec') })
    await expect(transport.call('SetCurrentProgramScene', { sceneName: 'Inventée' })).rejects.toThrow(
      /Scène inconnue/,
    )
  })

  it('produces a real file and allows a sidecar to be obtained', async () => {
    const recDir = join(dir, 'rec')
    const store = new LocalStore(':memory:')
    const runtime = new RoomRuntime(store)
    const transport = createMockObsTransport({ instance: 'B', recordingDir: recDir })
    const obs = new ObsController({
      instance: 'B',
      url: 'mock',
      sceneRoles: { TALK: DEFAULT_SCENES.B[0]! },
      transport,
    })
    await obs.connect()

    let path: string | null = null
    transport.on('RecordStateChanged', ((payload: { outputActive: boolean; outputPath?: string }) => {
      if (!payload.outputActive && payload.outputPath != null) path = payload.outputPath
    }) as never)

    const { readFile, rename, writeFile } = await import('node:fs/promises')
    const session = new RecordingSession({
      setFilenameFormat: (format) => obs.setProfileParameter('Output', 'FilenameFormatting', format),
      startRecord: () => obs.startRecording(),
      stopRecord: () => obs.stopRecording(),
      fs: {
        rename: (from, to) => rename(from, to),
        writeFile: (path, contents) => writeFile(path, contents, 'utf8'),
        exists: async (path) => readFile(path).then(() => true, () => false),
      },
      now: () => Date.now(),
      correctedNow: () => runtime.correctedNow(),
    })

    const talk = program.sessions.find((s) => s.id === 'cmqav0qto03qe01nsitbr18cn')!
    await session.start({ session: talk, roomId: TRACK_1, roomSlug: 'track1', timezone: 'Europe/Paris' })
    session.mark('démo')
    const pending = new Promise<string | null>((resolve) => setTimeout(() => resolve(path), 60))
    const result = await session.stop(() => pending)

    // The file really exists: without it, the chain would stop at the rename and
    // we would never see the sidecar — the part we want to observe.
    expect(result.videoPath).toContain('2026-10-30_track1_1100_honeyswamp')
    const files = readdirSync(recDir)
    expect(files.filter((f) => f.endsWith('.mkv'))).toHaveLength(1)
    expect(files.filter((f) => f.endsWith('.json'))).toHaveLength(1)

    const sidecar = JSON.parse(readFileSync(result.sidecarPath!, 'utf8')) as { markers: unknown[] }
    expect(sidecar.markers).toHaveLength(1)
    store.close()
  })

  it('never overwrites a file that is already there', async () => {
    /**
     * The simulated machine writes into the recordings folder, and two stops on
     * the same talk give the same file name. Anecdotal while that folder held
     * only fifty-byte files; now that the control app can read them back, real
     * videos are dropped there — and one "Arrêter" too many erased them without
     * a word.
     */
    const rec = join(dir, 'rec')
    mkdirSync(rec, { recursive: true })
    const transport = createMockObsTransport({ instance: 'B', recordingDir: rec })
    await transport.call('SetProfileParameter', {
      parameterCategory: 'Output',
      parameterName: 'FilenameFormatting',
      parameterValue: 'keynote',
    })
    writeFileSync(join(rec, 'keynote.mkv'), 'une vraie vidéo, posée à la main')

    await transport.call('StartRecord')
    await transport.call('StopRecord')

    expect(readFileSync(join(rec, 'keynote.mkv'), 'utf8')).toBe('une vraie vidéo, posée à la main')
    expect(readdirSync(rec).sort()).toEqual(['keynote-2.mkv', 'keynote.mkv'])
  })

  it('simulates the stream and its telemetry', async () => {
    const transport = createMockObsTransport({ instance: 'B', recordingDir: join(dir, 'rec') })
    const obs = new ObsController({ instance: 'B', url: 'mock', sceneRoles: {}, transport })
    await obs.connect()

    expect((await obs.streamStatus()).bitrateKbps).toBe(0)
    await obs.startStream()
    expect((await obs.streamStatus()).bitrateKbps).toBeGreaterThan(0)
  })

  it('refuses two simultaneous recordings', async () => {
    const transport = createMockObsTransport({ instance: 'B', recordingDir: join(dir, 'rec') })
    await transport.call('StartRecord')
    await expect(transport.call('StartRecord')).rejects.toThrow(/déjà en cours/)
  })
})
