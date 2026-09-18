import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { CanvasObsController } from '../src/core/obs-canvas.js'
import { createMockObsTransport } from '../src/core/obs-mock.js'
import { ObsController, type ObsControllerEvent, type ObsTransport } from '../src/core/obs.js'

const CANVAS_ROLES = { TALK: 'Talk — caméra + slides', CAM_ONLY: 'Caméra seule' }

/** A single OBS, simulated, plugin included: the room with one instance. */
function singleObs(canvasScenes: string[] = Object.values(CANVAS_ROLES)) {
  const transport = createMockObsTransport({
    instance: 'A',
    scenes: ['Direct — capture HDMI', 'Habillage — écran de salle'],
    canvasScenes,
    recordingDir: mkdtempSync(join(tmpdir(), 'canvas-')),
  })
  const host = new ObsController({
    instance: 'A',
    url: 'ws://127.0.0.1:4455',
    sceneRoles: { LIVE: 'Direct — capture HDMI', HOLD: 'Habillage — écran de salle' },
    transport,
  })
  const events: ObsControllerEvent[] = []
  const capture = new CanvasObsController({
    transport: () => transport,
    host: () => host,
    sceneRoles: CANVAS_ROLES,
    onEvent: (event) => events.push(event),
  })
  return { transport, host, capture, events }
}

/** Waits for the simulator's events, which follow the answer as OBS's do. */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 30))

describe('the capture in the projection s vertical canvas', () => {
  it('connects on the projection s socket and resolves its roles there', async () => {
    const room = singleObs()
    await room.host.connect()

    const state = await room.capture.connect()
    expect(state.connected).toBe(true)
    // Said, and not deduced from an empty address: the control app shows it.
    expect(state.canvas).toBe(true)
    expect(state.unresolvedRoles).toEqual([])
    expect(state.scenes).toContain('Talk — caméra + slides')
  })

  it('reports a role the canvas does not carry', async () => {
    const transport = createMockObsTransport({
      instance: 'A',
      canvasScenes: [],
      recordingDir: mkdtempSync(join(tmpdir(), 'canvas-')),
    })
    const capture = new CanvasObsController({
      transport: () => transport,
      host: () => null,
      // A scene nobody created: the typo one wants reported at the rehearsal
      // rather than in the middle of a talk.
      sceneRoles: { ...CANVAS_ROLES, SLIDES_ONLY: 'Slides plein cadre' },
    })

    const state = await capture.connect()
    expect(state.unresolvedRoles).toEqual(['SLIDES_ONLY'])
  })

  /*
   * The setup that cannot work, and the only one to say so.
   *
   * A single OBS without the plugin has no second canvas: nothing records and
   * nothing streams. Passing on obs-websocket's "unknown vendor" would send the
   * room looking at its network.
   */
  it('says what to do when the plugin is missing', async () => {
    const room = singleObs()
    const plain = createMockObsTransport({
      instance: 'A',
      recordingDir: mkdtempSync(join(tmpdir(), 'canvas-')),
    })
    const capture = new CanvasObsController({
      transport: () => plain,
      host: () => room.host,
      sceneRoles: CANVAS_ROLES,
    })

    await expect(capture.connect()).rejects.toThrow(/plugin Canvas vertical/i)
    expect(capture.snapshot().connected).toBe(false)
  })

  it('records, and hands back the file the plugin wrote', async () => {
    const room = singleObs()
    await room.host.connect()
    await room.capture.connect()

    await room.capture.startRecording()
    await settle()
    expect(room.capture.snapshot().recording).toBe(true)

    await room.capture.stopRecording()
    await settle()
    expect(room.capture.snapshot().recording).toBe(false)

    const stops = room.events.filter((event) => event.type === 'recording' && !event.active)
    expect(stops).toHaveLength(1)
    // The path is the source for the renaming and the sidecar: without it the VOD
    // chain stops, silently.
    expect(stops[0]).toMatchObject({ outputPath: expect.stringContaining('.mkv'), error: null })
  })

  /*
   * The projection keeps recording while the capture runs: that separation is the
   * whole point of the plugin, and it is what a single OBS used to make impossible.
   */
  it('does not touch the projection s own recording', async () => {
    const room = singleObs()
    await room.host.connect()
    await room.capture.connect()

    await room.capture.startRecording()
    await settle()
    expect(room.capture.snapshot().recording).toBe(true)
    expect(room.host.snapshot().recording).toBe(false)
  })

  it('refuses to stream on a canvas that has no destination', async () => {
    const transport: ObsTransport = {
      connect: vi.fn(async () => {}),
      disconnect: vi.fn(async () => {}),
      // A canvas nobody has given a destination to: the plugin's list is empty.
      call: (async () => ({ responseData: { success: true, stream: { outputs: [] } } })) as unknown as
        ObsTransport['call'],
      on: () => {},
    }
    const capture = new CanvasObsController({
      transport: () => transport,
      host: () => null,
      sceneRoles: CANVAS_ROLES,
    })

    // Said in French and about what is missing, rather than the plugin's English
    // refusal about an index — which would land on "Diffuser", during the event.
    await expect(capture.configureStream('rtmp://exemple/live', 'clé')).rejects.toThrow(
      /aucune destination de diffusion/i,
    )
  })

  it('carries the stream key to the canvas and reads its counters back', async () => {
    const calls: { request: string; args?: Record<string, unknown> }[] = []
    const transport: ObsTransport = {
      connect: vi.fn(async () => {}),
      disconnect: vi.fn(async () => {}),
      call: (async (request: string, args?: Record<string, unknown>) => {
        calls.push({ request, args })
        const type = args?.requestType
        if (type === 'get_settings') {
          return { responseData: { success: true, stream: { outputs: [{ name: 'Direct', enabled: true }] } } }
        }
        if (type === 'stream_status') {
          return {
            responseData: {
              success: true,
              outputs: [
                { name: 'éteint', enabled: false, active: false },
                {
                  name: 'Direct',
                  active: true,
                  bytes: 5_625_000,
                  total_frames: 300,
                  dropped_frames: 4,
                  congestion: 2,
                },
              ],
            },
          }
        }
        return { responseData: { success: true } }
      }) as ObsTransport['call'],
      on: () => {},
    }
    const capture = new CanvasObsController({
      transport: () => transport,
      host: () => null,
      sceneRoles: CANVAS_ROLES,
    })

    await capture.configureStream('rtmp://exemple/live', 'clé-secrète')
    const applied = calls.find((call) => call.args?.requestType === 'set_settings')
    expect(applied?.args?.requestData).toEqual({
      stream: { outputs: [{ index: 0, server: 'rtmp://exemple/live', key: 'clé-secrète', enabled: true }] },
    })

    // The first **active** output: an idle one would describe a stream nobody
    // receives. Congestion stays within bounds, whatever the plugin reports.
    expect(await capture.streamStatus()).toEqual({
      outputBytes: 5_625_000,
      totalFrames: 300,
      skippedFrames: 4,
      congestion: 1,
    })
  })

  it('passes the plugin s refusal on rather than a silent success', async () => {
    const transport: ObsTransport = {
      connect: vi.fn(async () => {}),
      disconnect: vi.fn(async () => {}),
      call: (async () => ({
        responseData: { success: false, error: "'stream.video_bitrate' cannot change while streaming" },
      })) as unknown as ObsTransport['call'],
      on: () => {},
    }
    const capture = new CanvasObsController({
      transport: () => transport,
      host: () => null,
      sceneRoles: CANVAS_ROLES,
    })

    await expect(capture.startRecording()).rejects.toThrow(/cannot change while streaming/)
  })

  /*
   * The canvas has no socket of its own: it falls with the OBS that carries it,
   * and stays reconnectable on the socket that comes back.
   */
  it('falls with the projection, and comes back on the new connection', async () => {
    const handlers = new Map<string, ((payload: unknown) => void)[]>()
    const transport: ObsTransport = {
      connect: vi.fn(async () => {}),
      disconnect: vi.fn(async () => {}),
      call: (async (_request: string, args?: Record<string, unknown>) => ({
        responseData:
          args?.requestType === 'get_scenes'
            ? { success: true, scenes: [{ name: 'Talk — caméra + slides' }, { name: 'Caméra seule' }] }
            : { success: true, version: 'test' },
      })) as ObsTransport['call'],
      on: (event, handler) => {
        const list = handlers.get(event) ?? []
        list.push(handler as (payload: unknown) => void)
        handlers.set(event, list)
      },
    }
    const events: ObsControllerEvent[] = []
    const capture = new CanvasObsController({
      transport: () => transport,
      host: () => null,
      sceneRoles: CANVAS_ROLES,
      onEvent: (event) => events.push(event),
    })

    await capture.connect()
    expect(capture.snapshot().connected).toBe(true)

    // OBS-A goes away: the canvas has no socket of its own to lose, and must not
    // stay reported as a healthy capture.
    for (const handler of handlers.get('ConnectionClosed') ?? []) handler(undefined)
    expect(capture.snapshot().connected).toBe(false)
    expect(events.filter((event) => event.type === 'disconnected')).toHaveLength(1)

    await capture.connect()
    expect(capture.snapshot().connected).toBe(true)
  })

  it('lets go of the canvas without closing the room s screen', async () => {
    const room = singleObs()
    await room.host.connect()
    await room.capture.connect()

    await room.capture.disconnect()
    expect(room.capture.snapshot().connected).toBe(false)
    expect(room.host.snapshot().connected).toBe(true)
  })

  it('asks the projection for the VU meter, which belongs to the process', async () => {
    const room = singleObs()
    const meters = vi.spyOn(room.host, 'setVolumeMeters')
    await room.host.connect()
    await room.capture.connect()

    await room.capture.setVolumeMeters(true)
    expect(meters).toHaveBeenCalledWith(true)
  })
})
