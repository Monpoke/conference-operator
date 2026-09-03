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
