import { DB_FLOOR, type InputLevel, type ObsInstance, type ObsState, type SceneRole } from '@conference-operator/contract'

/**
 * The surface of OBS we actually need.
 *
 * The abstraction exists for a precise reason: `obs-websocket-js` demands a
 * running OBS instance, so without it the role-resolution and reconnection logic
 * would only be testable on a control machine.
 */
/**
 * obs-websocket v5 event subscriptions (a bit mask).
 *
 * `InputVolumeMeters` is deliberately **outside** the default set on the OBS
 * side: it emits some fifty times a second. We therefore only subscribe to it
 * while a control app is watching the levels, and unsubscribe afterwards.
 */
export const OBS_SUBSCRIPTIONS = {
  /** Everything OBS sends by default: scenes, outputs, inputs… */
  standard: 0x7ff,
  /** The VU meter, at its acknowledged cost. */
  levels: 1 << 16,
} as const

export interface ObsTransport {
  /** A simulated transport, not a real OBS instance. See `obs-mock`. */
  readonly simulated?: boolean
  connect(url: string, password?: string, subscriptions?: number): Promise<void>
  /** Renegotiates the subscriptions without reopening the connection. */
  reidentify?(subscriptions: number): Promise<void>
  disconnect(): Promise<void>
  call(request: 'GetSceneList'): Promise<{ currentProgramSceneName: string; scenes: { sceneName: string }[] }>
  call(request: 'SetCurrentProgramScene', args: { sceneName: string }): Promise<unknown>
  call(request: string, args?: Record<string, unknown>): Promise<unknown>
  on(event: string, handler: (payload: never) => void): void
  off?(event: string, handler: (payload: never) => void): void
}

export interface ObsControllerOptions {
  instance: ObsInstance
  url: string
  password?: string | null
  /** Role → the real OBS scene name, as configured for this room. */
  sceneRoles: Partial<Record<SceneRole, string>>
  transport: ObsTransport
  onStateChange?: (state: ObsState) => void
  onEvent?: (event: ObsControllerEvent) => void
}

export type { ObsState }

export type ObsControllerEvent =
  | {
      type: 'connected'
      unresolvedRoles: SceneRole[]
      /**
       * The state observed at connection time.
       *
       * Without it, the application does not know what OBS is already doing until
       * the first change: a control app relaunched mid-talk would show "not
       * recording" while OBS is running, and the console would see an empty scene.
       */
      currentRole: SceneRole | null
      currentSceneName: string | null
      recording: boolean
      streaming: boolean
    }
  | { type: 'disconnected' }
  | { type: 'scene'; sceneName: string; role: SceneRole | null }
  | { type: 'recording'; active: boolean; outputPath: string | null }
  | { type: 'streaming'; active: boolean }
  | { type: 'audio'; inputs: InputLevel[] }

export { DB_FLOOR, type InputLevel }

/** OBS's linear multiplier towards bounded dBFS. */
export function multiplierToDb(mul: number): number {
  if (!Number.isFinite(mul) || mul <= 0) return DB_FLOOR
  return Math.max(DB_FLOOR, 20 * Math.log10(mul))
}

interface OutputState {
  outputActive: boolean
  /** Absent from the simulators, always present on a real OBS. */
  outputState?: string
}

/** The only two states that conclude an output transition. */
const SETTLED_STATES = new Set(['OBS_WEBSOCKET_OUTPUT_STARTED', 'OBS_WEBSOCKET_OUTPUT_STOPPED'])

/**
 * True when the event concludes the transition, and not when it announces it.
 *
 * A real OBS emits `RecordStateChanged` **twice** per transition: `STOPPING` then
 * `STOPPED`, `STARTING` then `STARTED`. Only the second carries the result — the
 * file's path is only filled in on `STOPPED`. The first already announces
 * `outputActive: false` though, and taking it at its word made the wait for the
 * path resolve with `null`: the master was written all right, its sidecar never,
 * and the VOD modal said "sidecar missing" on perfectly healthy captures.
 *
 * The defect could not show in development: the simulators emit only one event,
 * the one that carries the path, and do not fill in `outputState` at all — hence
 * the fallback to "settled" when the field is missing.
 *
 * `PAUSED` / `RESUMED` and the stream's `RECONNECTING` / `RECONNECTED` fall in the
 * same place, and that is intended: the output has not changed state, passing it
 * on would make the control app blink and, for the stream, would announce an
 * "operator" stop to the hub on every reconnection of the stream.
 */
function isSettledTransition(outputState: string | undefined): boolean {
  return outputState == null || SETTLED_STATES.has(outputState)
}

/**
 * Drives an OBS instance reasoning in **roles**, never in scene names.
 *
 * Each room names its scenes as it likes; the code knows nothing of them. The
 * roles that cannot be found are reported from the connection on, so that the
 * problem shows at the rehearsal and not in the middle of a talk.
 */
export class ObsController {
  private state: ObsState
  /** The VU meter survives a reconnection: the subscription is reapplied. */
  private levelsActive = false

  constructor(private readonly options: ObsControllerOptions) {
    this.state = {
      instance: options.instance,
      connected: false,
      currentSceneName: null,
      currentRole: null,
      unresolvedRoles: [],
      scenes: [],
      simulated: options.transport.simulated === true,
      recording: false,
      streaming: false,
    }
    this.bindEvents()
  }

  snapshot(): ObsState {
    return { ...this.state, unresolvedRoles: [...this.state.unresolvedRoles] }
  }

  private patch(patch: Partial<ObsState>): void {
    this.state = { ...this.state, ...patch }
    this.options.onStateChange?.(this.snapshot())
  }

  private bindEvents(): void {
    const { transport } = this.options

    transport.on('CurrentProgramSceneChanged', (payload: never) => {
      const { sceneName } = payload as unknown as { sceneName: string }
      const role = this.roleOf(sceneName)
      this.patch({ currentSceneName: sceneName, currentRole: role })
      this.options.onEvent?.({ type: 'scene', sceneName, role })
    })

    transport.on('InputVolumeMeters', (payload: never) => {
      const { inputs } = payload as unknown as {
        inputs: { inputName: string; inputLevelsMul: number[][] }[]
      }
      this.options.onEvent?.({
        type: 'audio',
        inputs: inputs.map((input) => ({
          name: input.inputName,
          // OBS gives [magnitude, peak, input peak] per channel; the first two are
          // enough to draw a bar and its peak.
          channels: (input.inputLevelsMul ?? []).map((channel) => ({
            magnitude: multiplierToDb(channel[0] ?? 0),
            peak: multiplierToDb(channel[1] ?? channel[0] ?? 0),
          })),
        })),
      })
    })

    transport.on('RecordStateChanged', (payload: never) => {
      const event = payload as unknown as OutputState & { outputPath?: string }
      if (!isSettledTransition(event.outputState)) return
      this.patch({ recording: event.outputActive })
      this.options.onEvent?.({
        type: 'recording',
        active: event.outputActive,
        outputPath: event.outputPath ?? null,
      })
    })

    transport.on('StreamStateChanged', (payload: never) => {
      const event = payload as unknown as OutputState
      if (!isSettledTransition(event.outputState)) return
      this.patch({ streaming: event.outputActive })
      this.options.onEvent?.({ type: 'streaming', active: event.outputActive })
    })

    transport.on('ConnectionClosed', () => {
      this.patch({ connected: false, currentSceneName: null, currentRole: null })
      this.options.onEvent?.({ type: 'disconnected' })
    })
  }

  /**
   * Connects and resynchronizes the state from OBS.
   *
   * The state displayed in the control app always comes from OBS: if the operator
   * switches a scene directly in OBS, the control app must stay right.
   */
  /**
   * Switches the VU meter on or off.
   *
   * Renegotiating the subscriptions rather than filtering on receipt: without it,
   * OBS would send 50 messages a second permanently, including when nobody is
   * watching — for nothing, and on the machine that encodes.
   */
  async setVolumeMeters(active: boolean): Promise<void> {
    if (active === this.levelsActive) return
    const { transport } = this.options
    if (transport.reidentify == null) return
    this.levelsActive = active
    await transport.reidentify(
      active ? OBS_SUBSCRIPTIONS.standard | OBS_SUBSCRIPTIONS.levels : OBS_SUBSCRIPTIONS.standard,
    )
  }

  async connect(): Promise<ObsState> {
    await this.options.transport.connect(
      this.options.url,
      this.options.password ?? undefined,
      this.levelsActive
        ? OBS_SUBSCRIPTIONS.standard | OBS_SUBSCRIPTIONS.levels
        : OBS_SUBSCRIPTIONS.standard,
    )
    const inventory = await this.readScenes()

    /**
     * We also ask about the recording and the stream.
     *
     * OBS may very well already be recording: it is even the case that matters,
     * the one where the application restarted in the middle of a talk. Tolerant to
     * failure — an instance that does not answer these requests must not prevent
     * the connection.
     */
    let recording = false
    let streaming = false
    try {
      const status = (await this.options.transport.call('GetRecordStatus')) as { outputActive?: boolean }
      recording = status.outputActive === true
    } catch {
      /* an instance that does not handle the request */
    }

    /**
     * A simulated instance reports no take in progress: we stop it.
     *
     * Adopting OBS's recording exists for one reason only — the app restarted in
     * the middle of a talk and the take is still running. Nothing of the sort with
     * a simulated instance: it is born with the application, captures nothing, and
     * what it "records" from one connection to the next is the memory of no video.
     * The control app therefore sometimes lit up on a capture in progress that
     * nobody had started, and that had to be stopped before one could start one.
     *
     * We stop rather than ignore: reporting "nothing is capturing" while leaving
     * the instance believing the opposite would make the next "Enregistrer" fail
     * on an "already running" that the screen contradicts.
     */
    if (this.state.simulated && recording) {
      // The simulated instance keeps its own log: the stop can be read in it, and a
      // failure must not prevent the connection — we start again from "nothing is
      // capturing" in both cases, since that is the truth of what is captured.
      await this.options.transport.call('StopRecord').catch(() => {})
      recording = false
    }
    try {
      const status = (await this.options.transport.call('GetStreamStatus')) as { outputActive?: boolean }
      streaming = status.outputActive === true
    } catch {
      /* the same */
    }

    const { names, unresolvedRoles, currentSceneName, currentRole } = inventory
    this.patch({
      connected: true,
      currentSceneName,
      currentRole,
      unresolvedRoles,
      scenes: names,
      recording,
      streaming,
    })
    this.options.onEvent?.({
      type: 'connected',
      unresolvedRoles,
      currentRole,
      currentSceneName,
      recording,
      streaming,
    })
    return this.snapshot()
  }

  /**
   * Reads OBS's scenes back and replays the role resolution.
   *
   * Renaming or adding a scene in OBS emits no event we are subscribed to:
   * without an explicit re-read, the configuration form would offer the list as it
   * was at connection time, and a role repaired in OBS would stay red in the
   * control app until the next restart.
   */
  async refreshScenes(): Promise<ObsState> {
    const { names, unresolvedRoles, currentSceneName, currentRole } = await this.readScenes()
    this.patch({ scenes: names, unresolvedRoles, currentSceneName, currentRole })
    return this.snapshot()
  }

  /** An inventory of the scenes and the roles they resolve, at a given instant. */
  private async readScenes(): Promise<{
    names: string[]
    unresolvedRoles: SceneRole[]
    currentSceneName: string
    currentRole: SceneRole | null
  }> {
    const { scenes, currentProgramSceneName } = await this.options.transport.call('GetSceneList')
    const names = scenes.map((scene) => scene.sceneName)
    const present = new Set(names)
    return {
      names,
      unresolvedRoles: (Object.keys(this.options.sceneRoles) as SceneRole[]).filter((role) => {
        const sceneName = this.options.sceneRoles[role]
        return sceneName == null || !present.has(sceneName)
      }),
      currentSceneName: currentProgramSceneName,
      currentRole: this.roleOf(currentProgramSceneName),
    }
  }

  async disconnect(): Promise<void> {
    await this.options.transport.disconnect()
    this.patch({ connected: false })
  }

  /** Switches to the requested role. Fails explicitly if the role is not mapped. */
  async setRole(role: SceneRole): Promise<void> {
    const sceneName = this.options.sceneRoles[role]
    if (sceneName == null) {
      throw new Error(
        `Rôle « ${role} » non configuré pour OBS-${this.options.instance} : compléter le mapping de la salle`,
      )
    }
    if (this.state.unresolvedRoles.includes(role)) {
      throw new Error(
        `La scène « ${sceneName} » (rôle ${role}) n'existe pas dans OBS-${this.options.instance}`,
      )
    }
    await this.options.transport.call('SetCurrentProgramScene', { sceneName })
    // We do not anticipate the state: `CurrentProgramSceneChanged` is authoritative.
  }

  async startRecording(): Promise<void> {
    await this.options.transport.call('StartRecord')
  }

  async stopRecording(): Promise<void> {
    await this.options.transport.call('StopRecord')
  }

  /**
   * The folder where OBS writes its recordings.
   *
   * Serves as a fallback when the room has not filled in its capture root: it is
   * OBS that decides in the last resort, and it alone knows for certain.
   */
  async recordDirectory(): Promise<string | null> {
    const response = (await this.options.transport.call('GetRecordDirectory')) as {
      recordDirectory?: string
    }
    const directory = response?.recordDirectory
    return directory != null && directory.length > 0 ? directory : null
  }

  /**
   * Writes an OBS profile parameter — notably `Output/FilenameFormatting`, read by
   * OBS at `StartRecord` time.
   */
  async setProfileParameter(category: string, name: string, value: string): Promise<void> {
    await this.options.transport.call('SetProfileParameter', {
      parameterCategory: category,
      parameterName: name,
      parameterValue: value,
    })
  }

  /** Applies the RTMP key before `StartStream`. */
  async configureStream(rtmpUrl: string, streamKey: string): Promise<void> {
    await this.options.transport.call('SetStreamServiceSettings', {
      streamServiceType: 'rtmp_custom',
      streamServiceSettings: { server: rtmpUrl, key: streamKey },
    })
  }

  async startStream(): Promise<void> {
    await this.options.transport.call('StartStream')
  }

  async stopStream(): Promise<void> {
    await this.options.transport.call('StopStream')
  }

  /** The stream's health: bitrate and dropped frames, for the telemetry. */
  async streamStatus(): Promise<{ bitrateKbps: number; skippedFrames: number; congestion: number }> {
    const status = (await this.options.transport.call('GetStreamStatus')) as {
      outputBytes?: number
      outputSkippedFrames?: number
      outputCongestion?: number
    }
    return {
      bitrateKbps: Math.round(((status.outputBytes ?? 0) * 8) / 1000),
      skippedFrames: status.outputSkippedFrames ?? 0,
      congestion: Math.min(1, Math.max(0, status.outputCongestion ?? 0)),
    }
  }

  private roleOf(sceneName: string): SceneRole | null {
    for (const [role, name] of Object.entries(this.options.sceneRoles)) {
      if (name === sceneName) return role as SceneRole
    }
    return null
  }
}
