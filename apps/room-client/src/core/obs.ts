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

/**
 * What the capture needs of an OBS, whatever is behind it.
 *
 * Two implementations: `ObsController`, a second OBS instance of its own, and
 * `CanvasObsController`, the vertical canvas inside the projection's OBS. `RoomApp`
 * drives the capture through this interface alone, so that a room with one OBS and
 * a room with two follow the same path — the recording, the sidecars and the stream
 * are the part where a divergence costs a VOD.
 */
export interface ObsCapture {
  /** The capture shares the projection's OBS process: a gesture applies once, not twice. */
  readonly sharesHost?: boolean
  snapshot(): ObsState
  connect(): Promise<ObsState>
  disconnect(): Promise<void>
  refreshScenes(): Promise<ObsState>
  setVolumeMeters(active: boolean): Promise<void>
  audioInputs(): AudioSource[]
  hasAudioInput(inputName: string): boolean
  setInputMute(inputName: string, muted: boolean): Promise<void>
  startRecording(): Promise<void>
  stopRecording(): Promise<void>
  setProfileParameter(category: string, name: string, value: string): Promise<void>
  recordDirectory(): Promise<string | null>
  configureStream(rtmpUrl: string, streamKey: string): Promise<void>
  startStream(): Promise<void>
  stopStream(): Promise<void>
  streamStatus(): Promise<{
    outputBytes: number
    skippedFrames: number
    totalFrames: number
    congestion: number
  }>
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
  | {
      type: 'recording'
      active: boolean
      outputPath: string | null
      /**
       * What OBS says about a take that ended badly — `null` when all went well.
       *
       * Only the canvas fills it in, because only the plugin reports it: a full
       * disk or an encoder that gave up otherwise stayed in OBS's own log, on the
       * machine, while the control app closed the take without a word.
       */
      error?: string | null
    }
  /**
   * The take carries on in another file: OBS has just split the recording.
   *
   * Distinct from `recording`, because nothing has changed state — the capture is
   * running, and only the container it lands in moved. It is the only moment the
   * segment that was just closed can be learned: the stop announces the last file
   * and nothing else.
   */
  | { type: 'record-file'; path: string }
  | { type: 'streaming'; active: boolean }
  | { type: 'audio'; inputs: InputLevel[] }
  /** The audio sources and their mute state, whenever either changes. */
  | { type: 'audio-inputs'; inputs: AudioSource[] }

/** An OBS source that carries audio, and whether it is muted. */
export interface AudioSource {
  name: string
  muted: boolean
}

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
export class ObsController implements ObsCapture {
  private state: ObsState
  /** The VU meter survives a reconnection: the subscription is reapplied. */
  private levelsActive = false
  /** The audio sources, as last read from OBS. Empty while disconnected. */
  private audioSources: AudioSource[] = []

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
        // The same filter as the source list: OBS meters everything that carries
        // audio, routed or not. Without this, the sources hidden from the mixer
        // panel came back as VU meters right next to it.
        inputs: inputs
          .filter((input) => this.hasAudioInput(input.inputName))
          .map((input) => ({
            name: input.inputName,
            // OBS gives [magnitude, peak, input peak] per channel; the first two
            // are enough to draw a bar and its peak.
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

    /**
     * Automatic file splitting, set up in OBS's output settings.
     *
     * OBS announces the file it **continues into**, not the one it has just
     * closed — so the first segment is never the subject of this event. It is the
     * one `RecordStateChanged` gives at the start, and that is why the start's
     * path is kept too.
     */
    transport.on('RecordFileChanged', (payload: never) => {
      const { newOutputPath } = payload as unknown as { newOutputPath?: string }
      if (typeof newOutputPath !== 'string' || newOutputPath === '') return
      this.options.onEvent?.({ type: 'record-file', path: newOutputPath })
    })

    transport.on('StreamStateChanged', (payload: never) => {
      const event = payload as unknown as OutputState
      if (!isSettledTransition(event.outputState)) return
      this.patch({ streaming: event.outputActive })
      this.options.onEvent?.({ type: 'streaming', active: event.outputActive })
    })

    transport.on('InputMuteStateChanged', (payload: never) => {
      const { inputName, inputMuted } = payload as unknown as { inputName: string; inputMuted: boolean }
      if (!this.hasAudioInput(inputName)) return
      // Authoritative, like the scene: a mute made in OBS itself shows too.
      this.publishAudioSources(
        this.audioSources.map((source) =>
          source.name === inputName ? { name: inputName, muted: inputMuted } : source,
        ),
      )
    })

    // A source added, removed or renamed in OBS: read the list again rather than
    // guess whether the new one carries audio. The scene events matter as much
    // since the list only keeps what is routed: a microphone dropped into a scene
    // must appear in the control app, and one taken out of the last scene must
    // leave it.
    for (const event of [
      'InputCreated',
      'InputRemoved',
      'InputNameChanged',
      'InputAudioTracksChanged',
      'SceneItemCreated',
      'SceneItemRemoved',
      'SceneCreated',
      'SceneRemoved',
    ]) {
      transport.on(event, () => {
        this.scheduleAudioRefresh()
      })
    }

    transport.on('ConnectionClosed', () => {
      this.audioSources = []
      // The library also fires it on every failed connection attempt: with OBS off,
      // the resume loop would announce a "disconnection" every three seconds — a
      // required event, queued, sent up and republished to the control app each time.
      // Only a connection that was actually up can be lost.
      const wasConnected = this.state.connected
      this.patch({ connected: false, currentSceneName: null, currentRole: null })
      if (wasConnected) this.options.onEvent?.({ type: 'disconnected' })
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
    // Tolerant, like the output status: a source list OBS refuses to give must not
    // prevent driving the scenes.
    await this.refreshAudioInputs().catch(() => {})
    return this.snapshot()
  }

  /**
   * Reads back the sources that carry audio, and their mute state.
   *
   * OBS lists every input, video ones included, and has no flag for "carries
   * audio": asking each for its mute state is what tells them apart — OBS refuses
   * the question for a source with no audio.
   *
   * Carrying audio is not enough to be worth a button: the control app was
   * offering sources that go nowhere — an input left in no scene, a global device
   * set to "Disabled", a source whose every audio track is unticked. Cutting them
   * changes nothing that is heard, and they drown the two microphones that do
   * matter. Only what is routed is kept, see {@link routedInputs} and
   * {@link carriesSound}.
   */
  async refreshAudioInputs(): Promise<void> {
    const { inputs } = (await this.options.transport.call('GetInputList')) as {
      inputs?: { inputName: string }[]
    }
    const routed = await this.routedInputs()
    const found: AudioSource[] = []
    for (const { inputName } of inputs ?? []) {
      try {
        const { inputMuted } = (await this.options.transport.call('GetInputMute', { inputName })) as {
          inputMuted?: boolean
        }
        if (typeof inputMuted !== 'boolean') continue
        if (routed != null && !routed.has(inputName)) continue
        if (!(await this.carriesSound(inputName))) continue
        found.push({ name: inputName, muted: inputMuted })
      } catch {
        /* no audio on this source: nothing to mute */
      }
    }
    this.publishAudioSources(found)
  }

  /**
   * The sources OBS actually plays: those in a scene, plus the global devices.
   *
   * The global devices (Desktop Audio, Mic/Aux) belong to no scene and are heard
   * all the same — `GetSpecialInputs` is what names them, and it answers `null`
   * for a slot left on "Disabled", which is exactly the filter asked for.
   *
   * Returns `null` when OBS refuses one of the questions: an unanswered question
   * must never hide a microphone. Unknown means shown.
   */
  private async routedInputs(): Promise<Set<string> | null> {
    const { transport } = this.options
    try {
      const routed = new Set<string>()
      const specials = (await transport.call('GetSpecialInputs')) as Record<string, string | null>
      for (const name of Object.values(specials ?? {})) {
        if (typeof name === 'string' && name !== '') routed.add(name)
      }
      const { scenes } = await transport.call('GetSceneList')
      for (const { sceneName } of scenes) {
        for (const item of await this.sceneItems('GetSceneItemList', sceneName)) {
          routed.add(item.sourceName)
          // A source inside a group is in the scene like any other; the group's own
          // item only names the group.
          if (item.isGroup !== true) continue
          for (const child of await this.sceneItems('GetGroupSceneItemList', item.sourceName)) {
            routed.add(child.sourceName)
          }
        }
      }
      return routed
    } catch {
      return null
    }
  }

  private async sceneItems(
    request: 'GetSceneItemList' | 'GetGroupSceneItemList',
    sceneName: string,
  ): Promise<{ sourceName: string; isGroup?: boolean | null }[]> {
    const { sceneItems } = (await this.options.transport.call(request, { sceneName })) as {
      sceneItems?: { sourceName: string; isGroup?: boolean | null }[]
    }
    return sceneItems ?? []
  }

  /**
   * Does this source send its sound anywhere?
   *
   * Two ways of being silent that no mute state shows: every audio track unticked
   * — the source sits in the mixer but is routed to no output — and a capture
   * device left on "Disabled". Here too, a question OBS refuses leaves the source
   * in place: an old obs-websocket that knows neither request must not empty the
   * panel.
   */
  private async carriesSound(inputName: string): Promise<boolean> {
    const { transport } = this.options
    try {
      const { inputAudioTracks } = (await transport.call('GetInputAudioTracks', { inputName })) as {
        inputAudioTracks?: Record<string, boolean>
      }
      const tracks = Object.values(inputAudioTracks ?? {})
      if (tracks.length > 0 && !tracks.some(Boolean)) return false
    } catch {
      /* obs-websocket too old, or a source with no track: keep it */
    }
    try {
      const { inputSettings } = (await transport.call('GetInputSettings', { inputName })) as {
        inputSettings?: Record<string, unknown>
      }
      if (inputSettings?.device_id === 'disabled') return false
    } catch {
      /* same: an unanswered question hides nothing */
    }
    return true
  }

  /** A re-read under way, and whether a further one is already owed. */
  private audioRefresh: Promise<void> | null = null
  private audioRefreshQueued = false

  /**
   * Re-reads the sources, coalescing the bursts.
   *
   * Loading a scene collection emits one event per item: reading every scene back
   * for each of them would send OBS hundreds of questions for a single answer. A
   * re-read already under way is left to finish, and at most one more is queued
   * behind it — the last one is the one that tells the truth.
   */
  private scheduleAudioRefresh(): void {
    if (this.audioRefresh != null) {
      this.audioRefreshQueued = true
      return
    }
    this.audioRefresh = this.refreshAudioInputs()
      .catch(() => {})
      .finally(() => {
        this.audioRefresh = null
        if (!this.audioRefreshQueued) return
        this.audioRefreshQueued = false
        this.scheduleAudioRefresh()
      })
  }

  /** The audio sources, as last read from OBS. */
  audioInputs(): AudioSource[] {
    return this.audioSources.map((source) => ({ ...source }))
  }

  hasAudioInput(inputName: string): boolean {
    return this.audioSources.some((source) => source.name === inputName)
  }

  /** Mutes or restores a source. The state follows OBS's event, never the request. */
  async setInputMute(inputName: string, muted: boolean): Promise<void> {
    if (!this.hasAudioInput(inputName)) {
      throw new Error(`La source audio « ${inputName} » n'existe pas dans OBS-${this.options.instance}`)
    }
    await this.options.transport.call('SetInputMute', { inputName, inputMuted: muted })
  }

  private publishAudioSources(sources: AudioSource[]): void {
    if (JSON.stringify(sources) === JSON.stringify(this.audioSources)) return
    this.audioSources = sources
    this.options.onEvent?.({ type: 'audio-inputs', inputs: this.audioInputs() })
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

  /**
   * OBS's stream counters, as it reports them: **cumulative** since the stream
   * started.
   *
   * A rate only comes from two samples — see `streamHealthBetween`. Turning
   * `outputBytes` into a "bitrate" here gave the total sent so far.
   */
  async streamStatus(): Promise<{
    outputBytes: number
    skippedFrames: number
    totalFrames: number
    congestion: number
  }> {
    const status = (await this.options.transport.call('GetStreamStatus')) as {
      outputBytes?: number
      outputSkippedFrames?: number
      outputTotalFrames?: number
      outputCongestion?: number
    }
    return {
      outputBytes: status.outputBytes ?? 0,
      skippedFrames: status.outputSkippedFrames ?? 0,
      totalFrames: status.outputTotalFrames ?? 0,
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
