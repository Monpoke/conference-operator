import { describe, expect, it, vi } from 'vitest'
import { ObsController, type ObsTransport } from '../src/core/obs.js'

/** A fake OBS: implements the subset in use, with no real instance. */
function fakeObs(scenes: string[], current = scenes[0] ?? 'Scene') {
  const handlers = new Map<string, ((payload: unknown) => void)[]>()
  const calls: { request: string; args?: Record<string, unknown> }[] = []
  let currentScene = current

  const transport: ObsTransport = {
    connect: vi.fn(async () => {}),
    disconnect: vi.fn(async () => {}),
    call: (async (request: string, args?: Record<string, unknown>) => {
      calls.push({ request, args })
      if (request === 'GetSceneList') {
        return {
          currentProgramSceneName: currentScene,
          scenes: scenes.map((sceneName) => ({ sceneName })),
        }
      }
      if (request === 'SetCurrentProgramScene') {
        currentScene = args!.sceneName as string
        // OBS always confirms with an event: that is what is authoritative.
        emit('CurrentProgramSceneChanged', { sceneName: currentScene })
      }
      return {}
    }) as ObsTransport['call'],
    on: (event, handler) => {
      const list = handlers.get(event) ?? []
      list.push(handler as (payload: unknown) => void)
      handlers.set(event, list)
    },
  }

  function emit(event: string, payload: unknown): void {
    for (const handler of handlers.get(event) ?? []) handler(payload)
  }

  return { transport, calls, emit, get currentScene() { return currentScene } }
}

const ROLES = { LIVE: 'Capture HDMI', HOLD: 'Habillage web' }

describe('driving OBS by roles', () => {
  it('resolves the roles on connection', async () => {
    const obs = fakeObs(['Capture HDMI', 'Habillage web'], 'Habillage web')
    const controller = new ObsController({
      instance: 'A',
      url: 'ws://127.0.0.1:4455',
      sceneRoles: ROLES,
      transport: obs.transport,
    })

    const state = await controller.connect()
    expect(state.connected).toBe(true)
    expect(state.unresolvedRoles).toEqual([])
    // The state comes from OBS, not from a guess.
    expect(state.currentSceneName).toBe('Habillage web')
    expect(state.currentRole).toBe('HOLD')
  })

  it('reports the roles whose scene does not exist in OBS', async () => {
    const obs = fakeObs(['Capture HDMI'])
    const events: unknown[] = []
    const controller = new ObsController({
      instance: 'A',
      url: 'ws://127.0.0.1:4455',
      sceneRoles: ROLES,
      transport: obs.transport,
      onEvent: (event) => events.push(event),
    })

    const state = await controller.connect()
    // The room renamed "Habillage web": the problem must show up at the
    // rehearsal, not when switching in the middle of a talk.
    expect(state.unresolvedRoles).toEqual(['HOLD'])
    expect(events[0]).toMatchObject({ type: 'connected', unresolvedRoles: ['HOLD'] })
  })

  it('switches scene by role', async () => {
    const obs = fakeObs(['Capture HDMI', 'Habillage web'], 'Habillage web')
    const controller = new ObsController({
      instance: 'A',
      url: 'ws://127.0.0.1:4455',
      sceneRoles: ROLES,
      transport: obs.transport,
    })
    await controller.connect()
    await controller.setRole('LIVE')

    expect(obs.currentScene).toBe('Capture HDMI')
    expect(controller.snapshot().currentRole).toBe('LIVE')
  })

  it('refuses an unmapped role with an actionable message', async () => {
    const obs = fakeObs(['Capture HDMI'])
    const controller = new ObsController({
      instance: 'A',
      url: 'ws://127.0.0.1:4455',
      sceneRoles: { LIVE: 'Capture HDMI' },
      transport: obs.transport,
    })
    await controller.connect()
    await expect(controller.setRole('RELAY')).rejects.toThrow(/non configuré/)
  })

  it('refuses a role whose scene has disappeared from OBS', async () => {
    const obs = fakeObs(['Capture HDMI'])
    const controller = new ObsController({
      instance: 'A',
      url: 'ws://127.0.0.1:4455',
      sceneRoles: ROLES,
      transport: obs.transport,
    })
    await controller.connect()
    await expect(controller.setRole('HOLD')).rejects.toThrow(/n'existe pas/)
  })

  it('follows a switch made directly in OBS', async () => {
    const obs = fakeObs(['Capture HDMI', 'Habillage web'], 'Habillage web')
    const controller = new ObsController({
      instance: 'A',
      url: 'ws://127.0.0.1:4455',
      sceneRoles: ROLES,
      transport: obs.transport,
    })
    await controller.connect()

    // The operator clicks in OBS, not in our control app: the display must follow.
    obs.emit('CurrentProgramSceneChanged', { sceneName: 'Capture HDMI' })
    expect(controller.snapshot().currentRole).toBe('LIVE')
  })

  it('follows the recording state and picks up the output path', async () => {
    const obs = fakeObs(['Talk'])
    const events: unknown[] = []
    const controller = new ObsController({
      instance: 'B',
      url: 'ws://127.0.0.1:4456',
      sceneRoles: { TALK: 'Talk' },
      transport: obs.transport,
      onEvent: (event) => events.push(event),
    })
    await controller.connect()

    obs.emit('RecordStateChanged', { outputActive: true })
    expect(controller.snapshot().recording).toBe(true)

    obs.emit('RecordStateChanged', { outputActive: false, outputPath: '/rec/talk.mkv' })
    expect(controller.snapshot().recording).toBe(false)
    // The path is what lets us rename the master and write the sidecar.
    expect(events.at(-1)).toEqual({
      type: 'recording',
      active: false,
      outputPath: '/rec/talk.mkv',
    })
  })

  it('waits for `STOPPED` to deliver the path, and ignores `STOPPING`', async () => {
    const obs = fakeObs(['Talk'])
    const events: unknown[] = []
    const controller = new ObsController({
      instance: 'B',
      url: 'ws://127.0.0.1:4456',
      sceneRoles: { TALK: 'Talk' },
      transport: obs.transport,
      onEvent: (event) => events.push(event),
    })
    await controller.connect()

    // A real OBS's sequence, which the simulators do not reproduce.
    obs.emit('RecordStateChanged', {
      outputActive: false,
      outputState: 'OBS_WEBSOCKET_OUTPUT_STARTING',
    })
    obs.emit('RecordStateChanged', {
      outputActive: true,
      outputState: 'OBS_WEBSOCKET_OUTPUT_STARTED',
    })
    expect(controller.snapshot().recording).toBe(true)
    expect(events.filter((event) => (event as { type: string }).type === 'recording')).toHaveLength(1)

    // `STOPPING` already says "inactive" but carries no path: letting it
    // through resolved the wait with `null`, and the sidecar was not written.
    obs.emit('RecordStateChanged', {
      outputActive: false,
      outputState: 'OBS_WEBSOCKET_OUTPUT_STOPPING',
    })
    expect(controller.snapshot().recording).toBe(true)

    obs.emit('RecordStateChanged', {
      outputActive: false,
      outputState: 'OBS_WEBSOCKET_OUTPUT_STOPPED',
      outputPath: '/rec/talk.mkv',
    })
    expect(controller.snapshot().recording).toBe(false)
    expect(events.at(-1)).toEqual({
      type: 'recording',
      active: false,
      outputPath: '/rec/talk.mkv',
    })
  })

  it('does not report a stream stop during a reconnection', async () => {
    const obs = fakeObs(['Talk'])
    const events: unknown[] = []
    const controller = new ObsController({
      instance: 'B',
      url: 'ws://127.0.0.1:4456',
      sceneRoles: { TALK: 'Talk' },
      transport: obs.transport,
      onEvent: (event) => events.push(event),
    })
    await controller.connect()

    obs.emit('StreamStateChanged', {
      outputActive: true,
      outputState: 'OBS_WEBSOCKET_OUTPUT_STARTED',
    })
    // The stream drops and OBS recovers on its own: announcing an "operator"
    // stop to the hub on every network hiccup would be a lie.
    obs.emit('StreamStateChanged', {
      outputActive: false,
      outputState: 'OBS_WEBSOCKET_OUTPUT_RECONNECTING',
    })
    expect(controller.snapshot().streaming).toBe(true)
    expect(events.filter((event) => (event as { type: string }).type === 'streaming')).toHaveLength(1)
  })

  it('goes back to disconnected when OBS closes the connection', async () => {
    const obs = fakeObs(['Capture HDMI', 'Habillage web'])
    const controller = new ObsController({
      instance: 'A',
      url: 'ws://127.0.0.1:4455',
      sceneRoles: ROLES,
      transport: obs.transport,
    })
    await controller.connect()

    obs.emit('ConnectionClosed', {})
    const state = controller.snapshot()
    expect(state.connected).toBe(false)
    // We forget the scene: showing the last known one would suggest the
    // projection is still being driven.
    expect(state.currentSceneName).toBeNull()
  })

  it('announces no disconnection for a failed connection attempt', () => {
    const obs = fakeObs(['Capture HDMI', 'Habillage web'])
    const events: unknown[] = []
    new ObsController({
      instance: 'A',
      url: 'ws://127.0.0.1:4455',
      sceneRoles: ROLES,
      transport: obs.transport,
      onEvent: (event) => events.push(event),
    })

    // OBS off: the resume loop fails every three seconds, and the library closes
    // each time. A required event per attempt would flood the queue.
    obs.emit('ConnectionClosed', {})
    obs.emit('ConnectionClosed', {})
    expect(events.filter((event) => (event as { type: string }).type === 'disconnected')).toHaveLength(0)
  })
})

describe('state observed on connection', () => {
  it('adopts the scene OBS is already showing', async () => {
    const obs = fakeObs(['Capture HDMI', 'Habillage web'], 'Habillage web')
    const events: unknown[] = []
    const controller = new ObsController({
      instance: 'A',
      url: 'ws://127.0.0.1:4455',
      sceneRoles: ROLES,
      transport: obs.transport,
      onEvent: (event) => events.push(event),
    })
    await controller.connect()

    // Without this, the control app and the console show an empty scene until
    // the first switch — that is, potentially a whole talk.
    expect(events[0]).toMatchObject({ currentRole: 'HOLD', currentSceneName: 'Habillage web' })
  })

  it('finds a recording already under way', async () => {
    const obs = fakeObs(['Talk'])
    // OBS was already recording when the application restarted.
    const transport = {
      ...obs.transport,
      call: (async (request: string, args?: Record<string, unknown>) => {
        if (request === 'GetRecordStatus') return { outputActive: true }
        return (obs.transport.call as (r: string, a?: Record<string, unknown>) => Promise<unknown>)(
          request,
          args,
        )
      }) as typeof obs.transport.call,
    }

    const events: unknown[] = []
    const controller = new ObsController({
      instance: 'B',
      url: 'ws://127.0.0.1:4456',
      sceneRoles: { TALK: 'Talk' },
      transport,
      onEvent: (event) => events.push(event),
    })
    const state = await controller.connect()

    // Starting from "nothing running" would suggest a lost take.
    expect(state.recording).toBe(true)
    expect(events[0]).toMatchObject({ recording: true })
  })

  it('connects even if OBS ignores those requests', async () => {
    const obs = fakeObs(['Capture HDMI', 'Habillage web'])
    const transport = {
      ...obs.transport,
      call: (async (request: string, args?: Record<string, unknown>) => {
        if (request === 'GetRecordStatus' || request === 'GetStreamStatus') {
          throw new Error('requête inconnue')
        }
        return (obs.transport.call as (r: string, a?: Record<string, unknown>) => Promise<unknown>)(
          request,
          args,
        )
      }) as typeof obs.transport.call,
    }

    const controller = new ObsController({
      instance: 'A',
      url: 'ws://127.0.0.1:4455',
      sceneRoles: ROLES,
      transport,
    })
    // An instance that does not answer those requests must not block the room.
    await expect(controller.connect()).resolves.toMatchObject({ connected: true })
  })
})

describe('audio sources', () => {
  /** How OBS routes a source, beyond the mute state the panel shows. */
  interface Routing {
    /** The sources in the scene. Defaults to every source declared. */
    inScene?: string[]
    /** The global devices, as `GetSpecialInputs` names them. */
    specials?: string[]
    /** Per source, its audio tracks; absent means the six of a normal source. */
    tracks?: Record<string, Record<string, boolean>>
    /** Per source, its settings — `device_id: 'disabled'` is the one that counts. */
    settings?: Record<string, Record<string, unknown>>
    /** Requests this OBS refuses, as an obs-websocket too old would. */
    refuses?: string[]
  }

  /** An OBS with inputs: `null` = a source with no audio, which OBS refuses to answer about. */
  function audioObs(sources: Record<string, boolean | null>, routing: Routing = {}) {
    const handlers = new Map<string, ((payload: unknown) => void)[]>()
    const calls: { request: string; args?: Record<string, unknown> }[] = []
    const inScene = routing.inScene ?? Object.keys(sources)
    const transport: ObsTransport = {
      connect: vi.fn(async () => {}),
      disconnect: vi.fn(async () => {}),
      call: (async (request: string, args?: Record<string, unknown>) => {
        calls.push({ request, args })
        if (routing.refuses?.includes(request) === true) throw new Error('NotSupported')
        if (request === 'GetSceneList') {
          return { currentProgramSceneName: 'Scene', scenes: [{ sceneName: 'Scene' }] }
        }
        if (request === 'GetSceneItemList') {
          return { sceneItems: inScene.map((sourceName) => ({ sourceName, isGroup: false })) }
        }
        if (request === 'GetSpecialInputs') {
          // OBS always answers the six slots, `null` for those left on "Disabled".
          const [desktop1, mic1] = routing.specials ?? []
          return { desktop1: desktop1 ?? null, desktop2: null, mic1: mic1 ?? null }
        }
        if (request === 'GetInputAudioTracks') {
          const tracks = routing.tracks?.[args!.inputName as string]
          return { inputAudioTracks: tracks ?? { '1': true, '2': false } }
        }
        if (request === 'GetInputSettings') {
          return { inputSettings: routing.settings?.[args!.inputName as string] ?? {} }
        }
        if (request === 'GetInputList') {
          return { inputs: Object.keys(sources).map((inputName) => ({ inputName })) }
        }
        if (request === 'GetInputMute') {
          const muted = sources[args!.inputName as string]
          if (muted == null) throw new Error('InvalidResourceState')
          return { inputMuted: muted }
        }
        return {}
      }) as ObsTransport['call'],
      on: (event, handler) => {
        const list = handlers.get(event) ?? []
        list.push(handler as (payload: unknown) => void)
        handlers.set(event, list)
      },
    }
    const emit = (event: string, payload: unknown): void => {
      for (const handler of handlers.get(event) ?? []) handler(payload)
    }
    const events: { type: string }[] = []
    const controller = new ObsController({
      instance: 'B',
      url: 'ws://127.0.0.1:4456',
      sceneRoles: {},
      transport,
      onEvent: (event) => events.push(event),
    })
    return { controller, calls, emit, events }
  }

  const SOURCES = { 'Micro cravate': false, 'Micro main': true, 'Navigateur habillage': null }

  it('lists only the sources that carry audio, with their mute state', async () => {
    const obs = audioObs(SOURCES)
    await obs.controller.connect()

    // The browser source has no audio: offering to mute it would be a button that
    // fails.
    expect(obs.controller.audioInputs()).toEqual([
      { name: 'Micro cravate', muted: false },
      { name: 'Micro main', muted: true },
    ])
    expect(obs.events.filter((event) => event.type === 'audio-inputs')).toHaveLength(1)
  })

  it('follows a mute made in OBS itself', async () => {
    const obs = audioObs(SOURCES)
    await obs.controller.connect()

    obs.emit('InputMuteStateChanged', { inputName: 'Micro cravate', inputMuted: true })

    expect(obs.controller.audioInputs()[0]).toEqual({ name: 'Micro cravate', muted: true })
  })

  it('asks OBS, and does not anticipate its answer', async () => {
    const obs = audioObs(SOURCES)
    await obs.controller.connect()

    await obs.controller.setInputMute('Micro cravate', true)

    expect(obs.calls.at(-1)).toEqual({
      request: 'SetInputMute',
      args: { inputName: 'Micro cravate', inputMuted: true },
    })
    // `InputMuteStateChanged` is authoritative, as for the scenes.
    expect(obs.controller.audioInputs()[0]?.muted).toBe(false)
  })

  it('refuses a source OBS does not have, naming it', async () => {
    const obs = audioObs(SOURCES)
    await obs.controller.connect()

    await expect(obs.controller.setInputMute('Navigateur habillage', true)).rejects.toThrow(
      'Navigateur habillage',
    )
  })

  it('forgets the sources when the connection closes', async () => {
    const obs = audioObs(SOURCES)
    await obs.controller.connect()

    obs.emit('ConnectionClosed', {})

    expect(obs.controller.audioInputs()).toEqual([])
    expect(obs.controller.hasAudioInput('Micro cravate')).toBe(false)
  })

  it('leaves out a source that is in no scene', async () => {
    // A source taken out of every scene is heard nowhere: a mute button for it
    // promises something it cannot do, and it hides the microphones in the list.
    const obs = audioObs(SOURCES, { inScene: ['Micro cravate'] })
    await obs.controller.connect()

    expect(obs.controller.audioInputs()).toEqual([{ name: 'Micro cravate', muted: false }])
    expect(obs.controller.hasAudioInput('Micro main')).toBe(false)
  })

  it('keeps the global devices, which belong to no scene', async () => {
    const obs = audioObs(SOURCES, { inScene: [], specials: ['Micro main'] })
    await obs.controller.connect()

    expect(obs.controller.audioInputs()).toEqual([{ name: 'Micro main', muted: true }])
  })

  it('leaves out a source whose every audio track is unticked', async () => {
    const obs = audioObs(SOURCES, {
      tracks: { 'Micro main': { '1': false, '2': false } },
    })
    await obs.controller.connect()

    expect(obs.controller.audioInputs()).toEqual([{ name: 'Micro cravate', muted: false }])
  })

  it('leaves out a capture device left on "Disabled"', async () => {
    const obs = audioObs(SOURCES, {
      settings: { 'Micro main': { device_id: 'disabled' } },
    })
    await obs.controller.connect()

    expect(obs.controller.audioInputs()).toEqual([{ name: 'Micro cravate', muted: false }])
  })

  it('hides nothing when OBS refuses the routing questions', async () => {
    // An obs-websocket too old to know these requests must not empty the panel:
    // an unanswered question is not a reason to take a microphone away.
    const obs = audioObs(SOURCES, { refuses: ['GetSpecialInputs', 'GetInputAudioTracks'] })
    await obs.controller.connect()

    expect(obs.controller.audioInputs()).toEqual([
      { name: 'Micro cravate', muted: false },
      { name: 'Micro main', muted: true },
    ])
  })

  it('re-reads the sources when a scene gains or loses an item', async () => {
    const obs = audioObs(SOURCES)
    await obs.controller.connect()
    const before = obs.calls.filter((call) => call.request === 'GetInputList').length

    obs.emit('SceneItemRemoved', { sceneName: 'Scene', sourceName: 'Micro main' })
    await vi.waitFor(() =>
      expect(obs.calls.filter((call) => call.request === 'GetInputList').length).toBeGreaterThan(
        before,
      ),
    )
  })

  it('only meters the sources it kept', async () => {
    // The VU meters sit right next to the panel: OBS meters every source that
    // carries audio, and the ones just filtered out came back through that door.
    const obs = audioObs(SOURCES, { inScene: ['Micro cravate'] })
    await obs.controller.connect()

    obs.emit('InputVolumeMeters', {
      inputs: [
        { inputName: 'Micro cravate', inputLevelsMul: [[0.5, 0.6]] },
        { inputName: 'Micro main', inputLevelsMul: [[0.5, 0.6]] },
      ],
    })

    const levels = obs.events.filter(
      (event): event is { type: 'audio'; inputs: { name: string }[] } => event.type === 'audio',
    )
    expect(levels).toHaveLength(1)
    expect(levels[0]!.inputs.map((input) => input.name)).toEqual(['Micro cravate'])
  })
})
