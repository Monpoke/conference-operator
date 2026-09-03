import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ObsInstance } from '@cloudnord/contract'
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

  let currentScene = scenes[1] ?? scenes[0]!
  let recording = false
  let streaming = false
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

        case 'GetRecordDirectory':
          // The control app uses it to list the rushes when the room has not filled
          // in its root: the simulated machine must answer like the real one.
          return { recordDirectory: options.recordingDir }

        case 'GetRecordStatus':
          // Asked at connection time: a relaunched control app must find the state.
          return { outputActive: recording }

        case 'GetStreamStatus':
          return {
            outputActive: streaming,
            outputBytes: streaming ? 750_000 : 0,
            outputSkippedFrames: 0,
            outputCongestion: 0,
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
