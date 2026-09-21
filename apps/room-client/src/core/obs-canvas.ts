import type { ObsState, SceneRole } from '@conference-operator/contract'
import type {
  AudioSource,
  ObsCapture,
  ObsController,
  ObsControllerEvent,
  ObsTransport,
} from './obs.js'

/**
 * The capture, inside the projection's OBS.
 *
 * A room needed two OBS instances because one process has **one** program: what
 * goes to the projector is what gets recorded, overlay included. The vertical
 * canvas plugin lifts exactly that — a second canvas, with its own scenes, its own
 * recording and its own stream, inside the same OBS. So the machine only carries
 * one instance, and the capture stops depending on a second one being launched,
 * configured and kept alive.
 *
 * This controller is therefore **not** a connection: it rides on the projection's
 * websocket and speaks to the plugin through `CallVendorRequest`. It exposes the
 * same surface as `ObsController` for everything the capture needs, so `RoomApp`
 * drives "OBS-B" without knowing which of the two it got.
 *
 * What it deliberately does not do: switch scenes. The canvas has its own, and the
 * rule has not changed — framing is done by hand in OBS, the application only
 * checks that the configured roles exist.
 */

/** The vendor name the plugin registers with obs-websocket. */
export const CANVAS_VENDOR = 'aitum-vertical-canvas'

export interface CanvasObsOptions {
  /**
   * The projection's transport — the canvas lives in that OBS process.
   *
   * Read at each connection rather than held: reconnecting OBS-A rebuilds its
   * controller and its socket, and a capture pinned to the old one would speak
   * into a closed connection. Taken as a function so that reconnecting the
   * projection costs nothing here — in particular not the recording in progress,
   * which rebuilding the capture would have closed.
   */
  transport: () => ObsTransport | null
  /**
   * The projection's controller, for what belongs to the OBS process and not to
   * the canvas: the VU meter and the audio sources. The microphones are the
   * process's inputs, shared by both canvases — asking the plugin for them would
   * be asking the wrong object.
   */
  host: () => ObsController | null
  /** Role → the real scene name, as configured for this room's capture. */
  sceneRoles: Partial<Record<SceneRole, string>>
  onStateChange?: (state: ObsState) => void
  onEvent?: (event: ObsControllerEvent) => void
  onLog?: (level: 'info' | 'warn' | 'error', message: string, context?: unknown) => void
}

/** What `get_settings` answers, reduced to what we read. */
interface CanvasSettings {
  current_scene?: string
  record?: { path?: string; extension?: string }
  stream?: { outputs?: { name?: string; server?: string; has_key?: boolean; enabled?: boolean }[] }
}

/** One of the plugin's stream outputs, as `stream_status` reports it. */
interface CanvasStreamOutput {
  name?: string
  enabled?: boolean
  active?: boolean
  bytes?: number
  total_frames?: number
  dropped_frames?: number
  congestion?: number
}

export class CanvasObsController implements ObsCapture {
  /**
   * Shares the projection's OBS process.
   *
   * Read where a gesture must not be applied twice — muting a microphone, first of
   * all: with two instances it had to reach both, here both are the same process.
   */
  readonly sharesHost = true

  private state: ObsState
  /** The transport the event handlers are attached to, to attach them only once. */
  private bound: ObsTransport | null = null

  constructor(private readonly options: CanvasObsOptions) {
    this.state = {
      instance: 'B',
      connected: false,
      currentSceneName: null,
      currentRole: null,
      unresolvedRoles: [],
      // Answered at the connection, from the transport that carried it: the
      // projection can be rebuilt between two, simulated or not.
      simulated: false,
      canvas: true,
      scenes: [],
      recording: false,
      streaming: false,
    }
  }

  snapshot(): ObsState {
    return { ...this.state, unresolvedRoles: [...this.state.unresolvedRoles] }
  }

  private patch(patch: Partial<ObsState>): void {
    this.state = { ...this.state, ...patch }
    this.options.onStateChange?.(this.snapshot())
  }

  /**
   * One vendor request, and its refusals made readable.
   *
   * The plugin answers `success: false` with its own message rather than an
   * obs-websocket error: without this, a refused setting came back as a silent
   * success. A vendor that is not registered at all makes the call itself fail —
   * that is the case `connect` turns into "the plugin is not installed".
   */
  private async vendor<T>(requestType: string, requestData: Record<string, unknown> = {}): Promise<T> {
    const transport = this.options.transport()
    if (transport == null) throw new Error("OBS-A n'est pas connecté : la captation vit dans son canvas")
    const response = (await transport.call('CallVendorRequest', {
      vendorName: CANVAS_VENDOR,
      requestType,
      requestData,
    })) as { responseData?: Record<string, unknown> }
    const data = (response?.responseData ?? {}) as Record<string, unknown> & { success?: boolean }
    if (data.success === false) {
      throw new Error(String(data.error ?? `le plugin a refusé « ${requestType} »`))
    }
    return data as T
  }

  private bindEvents(transport: ObsTransport): void {
    if (this.bound === transport) return
    this.bound = transport

    transport.on('VendorEvent', (payload: never) => {
      const event = payload as unknown as {
        vendorName?: string
        eventType?: string
        eventData?: Record<string, unknown>
      }
      if (event.vendorName !== CANVAS_VENDOR) return
      this.observe(event.eventType ?? '', event.eventData ?? {})
    })

    /*
     * The canvas falls with its process.
     *
     * It has no socket of its own to lose: without this, a projection OBS that is
     * closed left a capture reported as connected — and the console would have kept
     * showing a healthy capture on a machine where OBS no longer runs.
     */
    transport.on('ConnectionClosed', () => {
      const wasConnected = this.state.connected
      this.patch({ connected: false, currentSceneName: null, currentRole: null })
      if (wasConnected) this.options.onEvent?.({ type: 'disconnected' })
    })
  }

  private observe(type: string, data: Record<string, unknown>): void {
    const path = typeof data.path === 'string' && data.path !== '' ? data.path : null

    switch (type) {
      case 'recording_started':
        this.patch({ recording: true })
        this.options.onEvent?.({ type: 'recording', active: true, outputPath: path })
        break

      /*
       * The stop carries the path **and** the reason.
       *
       * `code` is OBS's own: anything other than zero is a capture that ended
       * badly — a full disk, an encoder that gave up. It used to be readable only
       * in OBS's log, on the machine; it now travels with the event that closes
       * the take, next to the stopwatch that claimed everything was fine.
       */
      case 'recording_stopped': {
        const code = typeof data.code === 'number' ? data.code : 0
        const lastError = typeof data.last_error === 'string' ? data.last_error : ''
        this.patch({ recording: false })
        this.options.onEvent?.({
          type: 'recording',
          active: false,
          outputPath: path,
          error: code === 0 ? null : lastError !== '' ? lastError : `OBS a arrêté la capture (code ${code})`,
        })
        break
      }

      // Split recording: the take carries on in another container, and that
      // container has to reach the sidecar — it is a piece of the take, not a
      // line in a log.
      case 'recording_file_changed':
        if (path != null) {
          this.options.onLog?.('info', 'la capture continue dans un nouveau fichier', { path })
          this.options.onEvent?.({ type: 'record-file', path })
        }
        break

      case 'streaming_started':
        this.patch({ streaming: true })
        this.options.onEvent?.({ type: 'streaming', active: true })
        break

      case 'streaming_stopped': {
        const code = typeof data.code === 'number' ? data.code : 0
        const lastError = typeof data.last_error === 'string' ? data.last_error : ''
        if (code !== 0) {
          this.options.onLog?.('warn', 'diffusion interrompue par OBS', {
            code,
            message: lastError !== '' ? lastError : null,
          })
        }
        this.patch({ streaming: false })
        this.options.onEvent?.({ type: 'streaming', active: false })
        break
      }

      case 'switch_scene': {
        const sceneName = typeof data.new_scene === 'string' ? data.new_scene : null
        if (sceneName == null) break
        const role = this.roleOf(sceneName)
        this.patch({ currentSceneName: sceneName, currentRole: role })
        this.options.onEvent?.({ type: 'scene', sceneName, role })
        break
      }

      default:
        break
    }
  }

  /**
   * Adopts the canvas's state — it is not a connection that opens.
   *
   * Same contract as `ObsController.connect()` all the same: the caller insists in
   * a loop until it goes through, and here what it is waiting for is the plugin
   * answering, that is, OBS-A being up with the plugin loaded.
   */
  async connect(): Promise<ObsState> {
    const transport = this.options.transport()
    if (transport == null) throw new Error("OBS-A n'est pas connecté : la captation vit dans son canvas")
    this.bindEvents(transport)

    let version: string
    try {
      const answer = await this.vendor<{ version?: string }>('version')
      version = answer.version ?? '?'
    } catch (cause) {
      /*
       * The one configuration that cannot work, said in full.
       *
       * A single OBS without the plugin has no second canvas: nothing records,
       * nothing streams, and the message must say what to do rather than pass on
       * obs-websocket's "unknown vendor".
       */
      throw new Error(
        "Le plugin Canvas vertical n'est pas installé dans OBS : une salle à un seul OBS en a besoin " +
          "pour enregistrer et diffuser. Installer le plugin, ou renseigner l'adresse d'un second OBS. " +
          `(${(cause as Error).message})`,
      )
    }

    const status = await this.vendor<{ recording?: boolean; streaming?: boolean }>('status')
    const settings = await this.vendor<CanvasSettings>('get_settings').catch(() => ({}) as CanvasSettings)
    const inventory = await this.readScenes(settings.current_scene ?? null)

    this.patch({
      connected: true,
      simulated: transport.simulated === true,
      recording: status.recording === true,
      streaming: status.streaming === true,
      ...inventory,
    })
    this.options.onLog?.('info', 'captation dans le canvas vertical d\'OBS-A', { plugin: version })
    this.options.onEvent?.({
      type: 'connected',
      unresolvedRoles: this.state.unresolvedRoles,
      currentRole: this.state.currentRole,
      currentSceneName: this.state.currentSceneName,
      recording: this.state.recording,
      streaming: this.state.streaming,
    })
    return this.snapshot()
  }

  /**
   * Lets go of the canvas without touching the projection.
   *
   * Closing the socket would cut the room's screen to reconnect the capture — the
   * very thing the instance-by-instance reconnection exists to avoid.
   */
  async disconnect(): Promise<void> {
    const wasConnected = this.state.connected
    this.patch({ connected: false, currentSceneName: null, currentRole: null })
    if (wasConnected) this.options.onEvent?.({ type: 'disconnected' })
  }

  async refreshScenes(): Promise<ObsState> {
    const settings = await this.vendor<CanvasSettings>('get_settings').catch(() => ({}) as CanvasSettings)
    this.patch(await this.readScenes(settings.current_scene ?? null))
    return this.snapshot()
  }

  private async readScenes(currentSceneName: string | null): Promise<Partial<ObsState>> {
    const { scenes } = await this.vendor<{ scenes?: { name?: string }[] }>('get_scenes')
    const names = (scenes ?? [])
      .map((scene) => scene.name)
      .filter((name): name is string => name != null && name !== '')
    const present = new Set(names)
    return {
      scenes: names,
      unresolvedRoles: (Object.keys(this.options.sceneRoles) as SceneRole[]).filter((role) => {
        const sceneName = this.options.sceneRoles[role]
        return sceneName == null || !present.has(sceneName)
      }),
      currentSceneName,
      currentRole: currentSceneName == null ? null : this.roleOf(currentSceneName),
    }
  }

  /**
   * The VU meter belongs to the process, not to the canvas.
   *
   * The plugin encodes a second program out of the **same** inputs: the levels
   * travel on the projection's connection, and subscribing here would open no new
   * source of them.
   */
  async setVolumeMeters(active: boolean): Promise<void> {
    await this.options.host()?.setVolumeMeters(active)
  }

  audioInputs(): AudioSource[] {
    return this.options.host()?.audioInputs() ?? []
  }

  hasAudioInput(inputName: string): boolean {
    return this.options.host()?.hasAudioInput(inputName) === true
  }

  async setInputMute(inputName: string, muted: boolean): Promise<void> {
    const host = this.options.host()
    if (host == null) throw new Error("OBS-A n'est pas connecté : la captation vit dans son canvas")
    await host.setInputMute(inputName, muted)
  }

  async startRecording(): Promise<void> {
    await this.vendor('start_recording')
  }

  async stopRecording(): Promise<void> {
    await this.vendor('stop_recording')
  }

  /**
   * The canvas names its own files, and that changes nothing.
   *
   * OBS's `Output/FilenameFormatting` drives the main program; the plugin writes
   * its own name, from its own settings. The take's name does not depend on it
   * anyway: the file is **renamed** at the stop, from the path the plugin
   * announces — which is the source in both setups, precisely because the format
   * may not have taken.
   */
  async setProfileParameter(_category: string, _name: string, _value: string): Promise<void> {
    /* nothing to write: the rename at the stop is what names the master */
  }

  /** Where the canvas writes, as it resolves it — profile settings included. */
  async recordDirectory(): Promise<string | null> {
    const settings = await this.vendor<CanvasSettings>('get_settings')
    const directory = settings.record?.path
    return directory != null && directory.length > 0 ? directory : null
  }

  /**
   * The RTMP address **and** its key, on the canvas's first output.
   *
   * Both in one `set_settings`, which checks everything before writing anything: a
   * value the plugin refuses leaves the stream as it was rather than half applied
   * — a server without its key is a stream that starts and is rejected. The key
   * never comes back out of the plugin afterwards — `get_settings` only says
   * whether one is set — and that is what we want of a secret the hub pushes.
   *
   * **Index 0 by convention**: the hub pushes one destination, so it is the
   * canvas's first output that carries it. A canvas set up for multi-RTMP keeps
   * its others untouched.
   *
   * And a canvas that has **no** output is caught here rather than by the plugin.
   * Its list is empty until somebody declares a destination in it, `set_settings`
   * then refuses an index matching nothing, and that refusal — in English, about
   * an index — would have landed on the operator pressing "Diffuser" in the middle
   * of an event. The room now says what is missing, and where.
   */
  async configureStream(rtmpUrl: string, streamKey: string): Promise<void> {
    const settings = await this.vendor<CanvasSettings>('get_settings')
    if ((settings.stream?.outputs ?? []).length === 0) {
      throw new Error(
        "Le canvas vertical n'a aucune destination de diffusion : en ajouter une dans " +
          "le panneau du plugin, dans OBS. Le hub pousse l'adresse et la clé, mais il " +
          'ne peut pas créer la sortie.',
      )
    }
    await this.vendor('set_settings', {
      stream: { outputs: [{ index: 0, server: rtmpUrl, key: streamKey, enabled: true }] },
    })
  }

  async startStream(): Promise<void> {
    await this.vendor('start_streaming')
  }

  async stopStream(): Promise<void> {
    await this.vendor('stop_streaming')
  }

  /**
   * The canvas's stream counters, cumulative like OBS's own.
   *
   * The first **active** output, because that is the one being watched: the plugin
   * can carry several, disabled ones included, and averaging them would describe a
   * stream nobody is receiving.
   */
  async streamStatus(): Promise<{
    outputBytes: number
    skippedFrames: number
    totalFrames: number
    congestion: number
  }> {
    const { outputs } = await this.vendor<{ outputs?: CanvasStreamOutput[] }>('stream_status')
    const output = (outputs ?? []).find((candidate) => candidate.active === true)
    return {
      outputBytes: output?.bytes ?? 0,
      skippedFrames: output?.dropped_frames ?? 0,
      totalFrames: output?.total_frames ?? 0,
      congestion: Math.min(1, Math.max(0, output?.congestion ?? 0)),
    }
  }

  private roleOf(sceneName: string): SceneRole | null {
    for (const [role, name] of Object.entries(this.options.sceneRoles)) {
      if (name === sceneName) return role as SceneRole
    }
    return null
  }
}
