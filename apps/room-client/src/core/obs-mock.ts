import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ObsInstance } from '@conference-operator/contract'
import type { ObsTransport } from './obs.js'

/**
 * A simulated OBS, to develop without installing OBS.
 *
 * Lives in `core/` and not in the tests because it serves daily development: it
 * makes it possible to run a whole talk — scene switch, recording, markers,
 * sidecar — on a bare machine.
 *
 * It **writes a real file** when the recording stops: without that, the VOD chain
 * would stop at the renaming and one would never see the sidecar, that is,
 * precisely the part one wants to be able to observe.
 */
export interface MockObsOptions {
  instance: ObsInstance
  /**
   * The scenes this room expects, in addition to the plausible ones.
   *
   * They **add to them**, they do not replace them: a simulated OBS must carry
   * what the room configured — otherwise every slightly personal scene name comes
   * out as "role not found", red in the control app, on an instance that does not
   * exist. One does not debug the typo of an OBS one does not have.
   *
   * The plausible ones stay, so that the ⚙'s picker always has a list to choose
   * from, including on a room no configuration has touched yet.
   */
  scenes?: string[]
  /**
   * The room runs on a single OBS: this instance also simulates the plugin's
   * vertical canvas, with these scenes.
   *
   * Absent — the two-instance setup — and the instance answers no vendor request,
   * exactly like an OBS without the plugin. Which is what makes the "single OBS
   * without the plugin" case observable in development, where it is a message to
   * read rather than a capture that silently records nothing.
   */
  canvasScenes?: string[]
  /** The folder to drop the fake recordings into. */
  recordingDir: string
  onLog?: (message: string) => void
}

/** The default scenes, aligned on the mapping set when a room is created. */
export const DEFAULT_SCENES: Record<ObsInstance, string[]> = {
  A: ['Direct — capture HDMI', 'Habillage — écran de salle'],
  B: ['Talk — caméra + slides', 'Caméra seule', 'Slides seules'],
}

export function createMockObsTransport(options: MockObsOptions): ObsTransport {
  /*
   * The plausible ones first: that is what keeps `scenes[1]` on the styling, and
   * therefore a room that lights up on its screen rather than on air.
   */
  const scenes = [
    ...new Set([...DEFAULT_SCENES[options.instance], ...(options.scenes ?? [])]),
  ]
  const handlers = new Map<string, ((payload: unknown) => void)[]>()

  /**
   * The simulated canvas: the capture's scenes, its recording and its stream.
   *
   * Separate counters from the main program's on purpose — that separation **is**
   * the plugin, and sharing them here would hide in development the very mistake
   * one would pay for in a room: a capture that follows the projection.
   */
  const canvasScenes =
    options.canvasScenes == null
      ? null
      : [...new Set([...DEFAULT_SCENES.B, ...options.canvasScenes])]
  let canvasScene = canvasScenes?.[0] ?? null
  let canvasRecording = false
  let canvasStreaming = false
  let canvasBytes = 0
  let canvasFrames = 0

  let currentScene = scenes[1] ?? scenes[0]!
  let recording = false
  let streaming = false
  /**
   * The stream's counters, cumulative since it started — as the real OBS reports
   * them. Each reading advances them by a plausible ten seconds of 4.5 Mb/s at
   * 30 fps, so that two samples give a rate.
   */
  let streamBytes = 0
  let streamFrames = 0
  let format = 'enregistrement'
  /** The VU meter's emission, active only while we are subscribed to it. */
  let meter: ReturnType<typeof setInterval> | null = null

  const emit = (event: string, payload: unknown): void => {
    // Asynchronous, like the real OBS: the event follows the request's answer, it
    // is not returned with it.
    setTimeout(() => {
      for (const handler of handlers.get(event) ?? []) handler(payload)
    }, 5)
  }

  const log = (message: string): void =>
    options.onLog?.(`[OBS-${options.instance} simulé] ${message}`)

  mkdirSync(options.recordingDir, { recursive: true })

  /**
   * Simulated audio inputs, with a plausible signal.
   *
   * With no levels, the control app's VU meter would be neither demonstrable nor
   * observable outside a real room — so never looked at before the day itself. The
   * microphone breathes, the ambience stays low, and the foldback is silent: three
   * cases one wants to tell apart at a glance on the screen.
   */
  const AUDIO_INPUTS: { name: string; base: number; amplitude: number; channels: number }[] = [
    { name: 'Micro cravate', base: -18, amplitude: 10, channels: 1 },
    { name: 'Ambiance salle', base: -38, amplitude: 6, channels: 2 },
    { name: 'Retour régie', base: -60, amplitude: 0, channels: 2 },
  ]
  /** The same sources on A and B, as in the rooms: the microphones feed both. */
  const muted = new Map(AUDIO_INPUTS.map((input) => [input.name, false]))

  let phase = 0
  const measure = (): { inputs: { inputName: string; inputLevelsMul: number[][] }[] } => {
    phase += 1
    return {
      inputs: AUDIO_INPUTS.map((input, index) => {
        // A slow oscillation, offset per input: two identical bars would give the
        // impression of a frozen display.
        const wave = Math.sin((phase + index * 7) / 6)
        const db = input.base + input.amplitude * wave
        const mul = db <= -60 ? 0 : 10 ** (db / 20)
        return {
          inputName: input.name,
          inputLevelsMul: Array.from({ length: input.channels }, () => [mul, mul * 1.1, mul * 1.1]),
        }
      }),
    }
  }

  const toggleMeter = (active: boolean): void => {
    if (active && meter == null) {
      log('vumètre activé')
      meter = setInterval(() => emit('InputVolumeMeters', measure()), 50)
      meter.unref?.()
    } else if (!active && meter != null) {
      log('vumètre coupé')
      clearInterval(meter)
      meter = null
    }
  }

  /** Is the VU meter asked for by this subscription mask? */
  const wantsLevels = (subscriptions?: number): boolean =>
    subscriptions != null && (subscriptions & (1 << 16)) !== 0

  /** The plugin's vendor events, shaped like obs-websocket's. */
  const canvasEvent = (eventType: string, eventData: Record<string, unknown> = {}): void =>
    emit('VendorEvent', { vendorName: 'aitum-vertical-canvas', eventType, eventData })

  /** One vendor request, answered like the plugin does — `success` included. */
  const canvas = (requestType: string, data: Record<string, unknown>): Record<string, unknown> => {
    switch (requestType) {
      case 'version':
        return { success: true, version: '0.0.0-simulé' }

      case 'status':
        return {
          success: true,
          recording: canvasRecording,
          streaming: canvasStreaming,
          backtrack: false,
          virtual_camera: false,
        }

      case 'get_scenes':
        return { success: true, scenes: (canvasScenes ?? []).map((name) => ({ name })) }

      case 'current_scene':
        return { success: true, scene: canvasScene ?? '' }

      case 'switch_scene': {
        const target = String(data.scene)
        if (!(canvasScenes ?? []).includes(target)) return { success: false, error: `Scène inconnue : ${target}` }
        const old = canvasScene
        canvasScene = target
        canvasEvent('switch_scene', { old_scene: old ?? '', new_scene: target })
        return { success: true }
      }

      case 'get_settings':
        return {
          success: true,
          current_scene: canvasScene ?? '',
          record: { path: options.recordingDir, extension: 'mkv', filename_formatting: format },
          stream: { outputs: [{ name: 'Direct', server: '', has_key: false, enabled: true }] },
        }

      case 'set_settings':
        log('paramètres du canvas appliqués')
        return { success: true }

      case 'start_recording': {
        if (canvasRecording) return { success: false, error: 'Enregistrement déjà en cours' }
        canvasRecording = true
        log('canvas : enregistrement démarré')
        canvasEvent('recording_starting')
        canvasEvent('recording_started', { path: '' })
        return { success: true }
      }

      case 'stop_recording': {
        if (!canvasRecording) return { success: false, error: 'Aucun enregistrement en cours' }
        canvasRecording = false
        const path = freePath(options.recordingDir, format)
        // A real file, like the main program's: the renaming and the sidecar
        // follow, and that is precisely the chain one wants to see run.
        writeFileSync(path, `enregistrement simulé (canvas) — ${new Date().toISOString()}\n`)
        log(`canvas : enregistrement arrêté → ${path}`)
        canvasEvent('recording_stopping')
        canvasEvent('recording_stopped', { path, code: 0, last_error: '' })
        return { success: true }
      }

      case 'start_streaming':
        canvasStreaming = true
        canvasBytes = 0
        canvasFrames = 0
        log('canvas : diffusion démarrée')
        canvasEvent('streaming_started', { name: 'Direct' })
        return { success: true }

      case 'stop_streaming':
        canvasStreaming = false
        log('canvas : diffusion arrêtée')
        canvasEvent('streaming_stopped', { name: 'Direct', code: 0, last_error: '' })
        return { success: true }

      case 'record_status':
        return { success: true, active: canvasRecording, paused: false, path: '', duration_ms: 0, bytes: 0 }

      case 'stream_status':
        if (canvasStreaming) {
          canvasBytes += 5_625_000
          canvasFrames += 300
        }
        return {
          success: true,
          outputs: [
            {
              name: 'Direct',
              enabled: true,
              active: canvasStreaming,
              bytes: canvasBytes,
              total_frames: canvasFrames,
              dropped_frames: 0,
              congestion: 0,
            },
          ],
        }

      default:
        return { success: false, error: `Requête inconnue : ${requestType}` }
    }
  }

  return {
    /**
     * Declares itself simulated.
     *
     * The control app displays it: nothing on screen tells a simulated recording
     * from a real one, and that is exactly the kind of mistake that is paid for in
     * a missing VOD. Carried by the transport rather than derived from an
     * environment variable read elsewhere — what is fake says so itself, and cannot
     * disagree with reality.
     */
    simulated: true,
    async connect(_url, _password, subscriptions) {
      log(`connecté — scènes : ${scenes.join(', ')}`)
      toggleMeter(wantsLevels(subscriptions))
    },
    async reidentify(subscriptions) {
      toggleMeter(wantsLevels(subscriptions))
    },
    async disconnect() {
      toggleMeter(false)
      log('déconnecté')
    },
    call: (async (request: string, args?: Record<string, unknown>) => {
      switch (request) {
        case 'GetSceneList':
          return {
            currentProgramSceneName: currentScene,
            scenes: scenes.map((sceneName) => ({ sceneName })),
          }

        case 'SetCurrentProgramScene': {
          const target = String(args?.sceneName)
          if (!scenes.includes(target)) throw new Error(`Scène inconnue : ${target}`)
          currentScene = target
          log(`scène → ${target}`)
          emit('CurrentProgramSceneChanged', { sceneName: target })
          return {}
        }

        case 'SetProfileParameter':
          if (args?.parameterName === 'FilenameFormatting') {
            format = String(args.parameterValue)
          }
          return {}

        case 'StartRecord':
          if (recording) throw new Error('Enregistrement déjà en cours')
          recording = true
          log('enregistrement démarré')
          emit('RecordStateChanged', {
            outputActive: false,
            outputState: 'OBS_WEBSOCKET_OUTPUT_STARTING',
          })
          emit('RecordStateChanged', {
            outputActive: true,
            outputState: 'OBS_WEBSOCKET_OUTPUT_STARTED',
          })
          return {}

        case 'StopRecord': {
          if (!recording) throw new Error('Aucun enregistrement en cours')
          recording = false
          const path = freePath(options.recordingDir, format)
          // A real file: the VOD chain is going to rename it and write its sidecar.
          writeFileSync(path, `enregistrement simulé — ${new Date().toISOString()}\n`)
          log(`enregistrement arrêté → ${path}`)
          // The two steps of a real OBS, the path on the second only. The simulator
          // emitted only one, and that is exactly what let through a defect that
          // only shows on a real instance.
          emit('RecordStateChanged', {
            outputActive: false,
            outputState: 'OBS_WEBSOCKET_OUTPUT_STOPPING',
          })
          emit('RecordStateChanged', {
            outputActive: false,
            outputState: 'OBS_WEBSOCKET_OUTPUT_STOPPED',
            outputPath: path,
          })
          return {}
        }

        case 'SetStreamServiceSettings':
          log('paramètres de diffusion appliqués')
          return {}

        case 'StartStream':
          streaming = true
          streamBytes = 0
          streamFrames = 0
          log('diffusion démarrée')
          emit('StreamStateChanged', {
            outputActive: true,
            outputState: 'OBS_WEBSOCKET_OUTPUT_STARTED',
          })
          return {}

        case 'StopStream':
          streaming = false
          log('diffusion arrêtée')
          emit('StreamStateChanged', {
            outputActive: false,
            outputState: 'OBS_WEBSOCKET_OUTPUT_STOPPED',
          })
          return {}

        case 'GetInputList':
          // A video source too: OBS lists everything, and only the audio ones
          // answer about their mute.
          return {
            inputs: [
              ...AUDIO_INPUTS.map((input) => ({ inputName: input.name })),
              { inputName: 'Navigateur habillage' },
            ],
          }

        case 'GetInputMute': {
          const name = String(args?.inputName)
          const state = muted.get(name)
          if (state == null) throw new Error(`La source « ${name} » n'a pas de piste audio`)
          return { inputMuted: state }
        }

        case 'SetInputMute': {
          const name = String(args?.inputName)
          if (!muted.has(name)) throw new Error(`Source audio inconnue : ${name}`)
          const next = args?.inputMuted === true
          muted.set(name, next)
          log(`${name} → ${next ? 'coupé' : 'rétabli'}`)
          emit('InputMuteStateChanged', { inputName: name, inputMuted: next })
          return {}
        }

        case 'GetRecordDirectory':
          // The control app uses it to list the rushes when the room has not filled
          // in its root: the simulated machine must answer like the real one.
          return { recordDirectory: options.recordingDir }

        case 'GetRecordStatus':
          // Asked at connection time: a relaunched control app must find the state.
          return { outputActive: recording }

        case 'GetStreamStatus':
          if (streaming) {
            streamBytes += 5_625_000
            streamFrames += 300
          }
          return {
            outputActive: streaming,
            outputBytes: streamBytes,
            outputSkippedFrames: 0,
            outputTotalFrames: streamFrames,
            outputCongestion: 0,
          }

        case 'CallVendorRequest': {
          if (canvasScenes == null || args?.vendorName !== 'aitum-vertical-canvas') {
            // What a real obs-websocket answers for a vendor nobody registered.
            throw new Error(`Vendor inconnu : ${String(args?.vendorName)}`)
          }
          return {
            vendorName: args.vendorName,
            requestType: args.requestType,
            responseData: canvas(String(args.requestType), (args.requestData ?? {}) as Record<string, unknown>),
          }
        }

        default:
          return {}
      }
    }) as ObsTransport['call'],

    on(event, handler) {
      const list = handlers.get(event) ?? []
      list.push(handler as (payload: unknown) => void)
      handlers.set(event, list)
    },
  }
}

/**
 * A path that overwrites nothing.
 *
 * The simulated machine writes into the same folder as the real capture, and two
 * stops on the same talk give the same file name. Overwriting was anecdotal for
 * as long as that folder only held fifty-byte files; since the control app can
 * read them back, real videos get dropped there — and one "Stop" too many erased
 * them without a word.
 */
function freePath(directory: string, format: string): string {
  const candidate = join(directory, `${format}.mkv`)
  if (!existsSync(candidate)) return candidate
  for (let next = 2; next < 1000; next += 1) {
    const following = join(directory, `${format}-${next}.mkv`)
    if (!existsSync(following)) return following
  }
  return candidate
}
