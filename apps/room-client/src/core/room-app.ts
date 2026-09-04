import { join } from 'node:path'
import { AssetCache } from './assets.js'
import { DisplayServer } from './display-server.js'
import { HubLink } from './hub-link.js'
import { ObsController } from './obs.js'
import { httpPairingTransport, runPairing, type DeviceCodeResponse } from './pairing.js'
import { createORPCClient } from '@orpc/client'
import { RPCLink as FetchLink } from '@orpc/client/fetch'
import type { ContractRouterClient } from '@orpc/contract'
import { contract, NO_EDITING_MARKS } from '@cloudnord/contract'
import { DEFAULT_TIMEZONE } from '@cloudnord/program'
import { RoomRuntime } from './runtime.js'
import { LocalStore } from './store.js'
import { createObsTransport, keepObsConnected } from './obs-transport.js'
import type { ObsTransport } from './obs.js'
import type { ObsInstance } from '@cloudnord/contract'
import { ConnectivityTracker, probeConnectivity } from './connectivity.js'
import { RecordingSession, slugify, type MarkerRole, type StopResult } from './recording.js'
import type { ControlDiagnostics, ControlTarget, VisibleObsEndpoint, VodList } from './control-api.js'
import {
  ffprobeProbe,
  inspectRecording,
  listRecordings,
  nodeVodFs,
  toolAvailable,
  openExcerpt,
  openFile,
  setVerdict,
  pathUnder,
  type VodCheck,
  type Excerpt,
  type FileStream,
  type VodVerdict,
  type VodIndexDeps,
} from './vod-index.js'
import { Outbox } from './outbox.js'
import { OutboxPump, buildHeartbeat, heartbeatDedupKey } from './outbox-pump.js'
import { LevelAggregator } from './audio-levels.js'
import { hostMonitor, type HostLoad } from './host.js'
import { Uploads, type VodCandidate, type HubVod, type UploadsView } from './upload.js'
import { nextTalk } from '@cloudnord/room-state'
import { sessionsForRoom } from '@cloudnord/program'
import type { ExecutionMode, RoomConfigPatch, RoomEventPayload } from '@cloudnord/contract'

/** A room's configuration in the local cache, as the hub pushed it. */
type RoomConfigCache = NonNullable<ReturnType<LocalStore['settings']>['config']>

/**
 * What an OBS connection depends on.
 *
 * Used to know whether the current connection was opened with the current
 * settings: the port changes, the mapping changes, and the live connection
 * becomes stale with nothing showing it.
 */
function obsFingerprint(config: RoomConfigCache, instance: ObsInstance): string {
  return JSON.stringify([
    config.obs[instance].url,
    config.obs[instance].password,
    config.sceneRoles[instance],
  ])
}

/** Where this machine's pairing stands. */
export interface PairingState {
  status: 'idle' | 'waiting' | 'paired' | 'failed' | 'expired'
  userCode?: string
  verificationUri?: string
  expiresInSeconds?: number
  message?: string
  /** The rooms offered to choose from, fetched from the hub. Empty if it is unreachable. */
  rooms?: { id: string; name: string }[]
  /** The room this machine asked for, awaiting confirmation. */
  requestedRoomId?: string | null
}

export interface RoomAppOptions {
  /** The local data root (`userData` under Electron). */
  dataDir: string
  hubOrigin: string
  clientId: string
  /** The machine token's vault. */
  readToken: () => string | null
  writeToken: (token: string) => void
  displayPort?: number
  /**
   * Builds an instance's transport.
   *
   * The instance is passed explicitly rather than derived from the call order: an
   * OBS-B wired onto OBS-A's scenes would be a failure hard to see. By default,
   * the real obs-websocket client.
   *
   * `scenes` carries the names the room configured for that instance. The real
   * client ignores them — an OBS has the scenes one created in it, and it is
   * precisely the gap that has to show. The simulator, for its part, uses them to
   * exist with the scenes one expects of it.
   */
  obsTransportFactory?: (instance: ObsInstance, scenes: string[]) => ObsTransport
  onLog?: (level: 'info' | 'warn' | 'error', message: string, context?: unknown) => void
  /** Displays the pairing code on the control screen. */
  onPairingCode?: (code: DeviceCodeResponse) => void
  /**
   * Opens the system's folder picker, for the rushes' path.
   *
   * Supplied by Electron only: `dev:headless` runs under bare Node, where there is
   * no picker to open. Its absence is what `canBrowse` announces to the control
   * app — which then hides the button rather than offering one that would not
   * answer.
   *
   * @param initial The folder already typed, to open where one was looking.
   */
  chooseFolder?: (initial: string | null) => Promise<string | null>
  /**
   * The room served, known in advance.
   *
   * Avoids the choice screen on a machine provisioned upstream — a prepared disk
   * image, a scripted deployment — where nobody will be in front of the screen on
   * the first start. Stays a proposal: the console decides.
   */
  roomId?: string
  /**
   * The room's execution mode.
   *
   * Decided by the entry point, which reads the environment — the application core
   * does not read `process.env`, and that is what makes it testable. See
   * `core/mode`.
   */
  mode?: ExecutionMode
  /**
   * The room's time source.
   *
   * Used in development, to place oneself in the middle of the event. Goes through
   * here and not through the server offset: that one is recomputed on every
   * successful send and would overwrite any value set by hand.
   */
  now?: () => number
  /**
   * The rebuilt control app's Vite server. **Development only.**
   *
   * Decided by the entry point, like the mode: the application core does not read
   * `process.env`. Absent — the case of every installed machine — the machine
   * serves the built bundle, and nothing else is possible.
   */
  regieViteOrigin?: string | null
}

/**
 * The complete assembly of a room machine.
 *
 * With no dependency on Electron: that is what makes it possible to start the
 * whole thing in a test and to check the real chain rather than isolated pieces.
 *
 * The startup order expresses the project's central rule: **we serve the screen
 * first, we talk to the hub afterwards**. A room must project its program even if
 * the hub has never answered.
 */
export class RoomApp implements ControlTarget {
  readonly store: LocalStore
  readonly assets: AssetCache
  readonly runtime: RoomRuntime
  readonly display: DisplayServer
  private link: HubLink | null = null
  private obsA: ObsController | null = null
  private obsB: ObsController | null = null
  private recording: RecordingSession | null = null
  /**
   * The output path's resolver, armed for the length of a recording stop. OBS only
   * announces the file after `StopRecord`, so it has to be waited for.
   */
  private pendingOutputPath: ((path: string | null) => void) | null = null
  /**
   * One capture closing at a time.
   *
   * Two paths lead to the sidecar — the stop asked for in the control app and the
   * stop observed from OBS — and they can cross: a `RecordStateChanged` arriving
   * after the control app's wait timeout would find the take still open and would
   * write a second one.
   */
  private captureClosing = false
  private outbox: Outbox | null = null
  private pump: OutboxPump | null = null
  /**
   * The machine's load reading, **shared** with the display server.
   *
   * The measurement is a difference between two reads of the kernel's counters: it
   * only exists if somebody keeps the previous mark. Two separate monitors — one
   * for the control app, one for the regulator — would each keep their own and
   * return two equally wrong figures, with nothing to say so.
   */
  private readonly hostLoad: () => HostLoad = hostMonitor()
  private readonly uploads: Uploads
  /** The last recording root observed: the uploader resolves its paths against it. */
  private knownRoot: string | null = null
  private readonly abort = new AbortController()
  private tick: NodeJS.Timeout | null = null
  private heartbeat: NodeJS.Timeout | null = null
  private roomsTimer: NodeJS.Timeout | null = null
  /** The mode the hub announced at the last sync. `null` until it has answered. */
  private hubMode: ExecutionMode | null = null
  /** The fingerprint of the settings each instance was wired with. */
  private obsApplied: Record<ObsInstance, string | null> = { A: null, B: null }
  /** A resume loop is already running for this instance. */
  private obsResuming: Record<ObsInstance, boolean> = { A: false, B: false }
  private roomStatuses: ControlDiagnostics['rooms'] = []
  private questions: ControlDiagnostics['questions'] = []
  private questionsAt: string | null = null
  private questionsSession: ControlDiagnostics['questionsSession'] = null
  private roomStatusesAt: string | null = null
  private pairing: PairingState = { status: 'idle' }
  private supervision: NodeJS.Timeout | null = null
  private workInFlight = false
  /**
   * The room asked for from the control screen.
   *
   * It commits to nothing: the console stays free to choose another. But it is the
   * room's operator who knows where they are, not the one in front of the console
   * — the proposal may as well come from them.
   */
  private wantedRoomId: string | null = null
  private knownRooms: { id: string; name: string }[] = []
  /** Pairing in the background, to let settle before closing. */
  private pairingInFlight: Promise<void> | null = null
  private readonly connectivity: ConnectivityTracker

  constructor(private readonly options: RoomAppOptions) {
    this.store = new LocalStore(join(options.dataDir, 'salle.db'))
    this.assets = new AssetCache(this.store, join(options.dataDir, 'assets'))
    this.runtime = new RoomRuntime(
      this.store,
      {
        setSceneRole: async (role) => {
          await this.obsA?.setRole(role)
        },
        resync: () => {
          void this.link?.sync()
        },
        reloadSessionStates: () => {
          void this.loadSessionStates()
        },
        fullResync: () => {
          void this.fullResync()
        },
        uploadVod: (file) => {
          void this.uploads.request(file)
        },
        resetVod: () => {
          void this.resetVod()
        },
        refreshRoomStatuses: () => {
          void this.refreshRoomStatuses()
        },
        /**
         * A capture asked for from a mobile control app.
         *
         * **Asking for what is already running is a silent success.** The command
         * stream is at-least-once: a reconnection can redeliver a "record" while OBS
         * is recording, and throwing here would fill the notice stack with incidents
         * that are not any.
         *
         * A real failure, for its part, goes to the log and not as an exception:
         * this path is a downward command, nobody is waiting for an answer at the
         * end. It is the view that will say the recording did not start — the mobile
         * control app never paints ahead, exactly like the room's.
         */
        setRecording: (on) => {
          if (this.runtime.state().recording === on) return
          const gesture = on ? this.startRecording() : this.stopRecording()
          void gesture.catch((cause: Error) => {
            this.options.onLog?.('warn', "captation : commande distante refusée", {
              on,
              message: cause.message,
            })
          })
        },
        setStreaming: (on) => {
          if (this.runtime.state().streaming === on) return
          const gesture = on ? this.startStreaming() : this.stopStreaming()
          void gesture.catch((cause: Error) => {
            this.options.onLog?.('warn', "diffusion : commande distante refusée", {
              on,
              message: cause.message,
            })
          })
        },
      },
      options.now,
    )
    this.wantedRoomId = options.roomId ?? null
    this.connectivity = new ConnectivityTracker({
      hubOrigin: options.hubOrigin,
      onChange: (value) => this.runtime.setConnectivity(value),
    })
    this.display = new DisplayServer({
      runtime: this.runtime,
      assets: this.assets,
      program: () => this.store.activeProgram(),
      roomName: () => this.store.settings().config?.name ?? null,
      roomConfig: () => this.store.settings().config ?? null,
      hubOrigin: options.hubOrigin,
      control: this,
      pairing: () => this.pairingState(),
      // Read back from the cache on every send: they change at sync time, not on
      // every scene switch, and a room started with the hub unreachable keeps the
      // last known ones rather than an empty page.
      socialLinks: () => this.store.settings().socialLinks,
      event: () => this.store.settings().event,
      onLevelsRequested: (active) => {
        this.levelsRequested = active
        // With no OBS-B connected, we only keep the intent: the subscription will be
        // set at connection time, otherwise opening the control app before OBS would
        // leave the VU meter silent until the page is reloaded.
        void this.obsB?.setVolumeMeters(active).catch(() => {
          this.options.onLog?.('warn', "OBS-B n'a pas accepté l'abonnement au vumètre")
        })
      },
      hostLoad: this.hostLoad,
      port: options.displayPort ?? 7788,
      viteOrigin: options.regieViteOrigin ?? null,
    })

    this.levels = new LevelAggregator((inputs) => this.display.publishLevels(inputs))

    /**
     * Shipping the rushes back.
     *
     * Always mounted, never active while the hub has no storage: it is the hub that
     * decides, and it says so at sync time. A room has nothing to know about S3 —
     * it only knows whether there is, or is not, a destination.
     */
    this.uploads = new Uploads({
      store: this.store,
      candidates: () => this.vodCandidates(),
      hub: () => this.hubVod(),
      policy: () => this.store.settings().vod?.politique ?? null,
      load: this.hostLoad,
      // OBS-B's real state, observed and not assumed: it is the same boolean as the
      // control app's indicator, and it beats what one believes one launched.
      recording: () => this.runtime.state().recording,
      talkRunning: () => this.runtime.currentSessionStatus() === 'running',
      msBeforeNext: () => this.msBeforeNextTalk(),
      pathOf: (file) => this.pathInCaptures(file),
      // Read back from the cache on every send, like the rest: a CA corrected on the
      // hub takes effect at the next sync, without touching the room machine.
      caCert: () => this.store.settings().vod?.caCert ?? null,
      onLog: this.options.onLog,
    })
  }

  /** Is a control app displaying the levels right now? */
  private levelsRequested = false
  private readonly levels: LevelAggregator

  /**
   * Queues an event for sending up.
   *
   * Never makes the caller wait: the queue is local, the sending happens in the
   * background. That is what lets a control action succeed instantly even offline.
   */
  emit(payload: RoomEventPayload, dedupKey?: string): void {
    const outbox = this.ensureOutbox()
    if (outbox == null) {
      // Before the very first pairing, the room is not known yet and the event
      // cannot be stamped. The case is rare and transient, but it must leave a trace
      // rather than disappear in silence.
      this.store.log('warn', 'événement émis avant appairage, non mis en file', {
        type: payload.type,
      })
      return
    }
    outbox.enqueue(payload, dedupKey != null ? { dedupKey } : {})
    // `backlog()` and not `depth()`: the heartbeat we have just enqueued leaves at
    // the next drain, and counting it would make the indicator blink endlessly.
    this.runtime.setOutboxDepth(outbox.backlog())
  }

  /**
   * Creates the queue as soon as the room is known — including from the local
   * cache, so with no network. An offline restart thus captures the startup's
   * events (the OBS connection, incidents) instead of losing them.
   */
  private ensureOutbox(): Outbox | null {
    if (this.outbox != null) return this.outbox
    const roomId = this.store.settings().roomId
    if (roomId == null) return null
    this.outbox = new Outbox(this.store, roomId)
    return this.outbox
  }

  /** Where the pairing stands, for the control screen. */
  pairingState(): PairingState {
    return {
      ...this.pairing,
      rooms: [...this.knownRooms],
      requestedRoomId: this.wantedRoomId,
    }
  }

  /**
   * Records the room chosen on the control screen and restarts the pairing.
   *
   * Restarting is necessary: the choice travels in the code request, so it cannot
   * apply to a code that has already been issued.
   */
  async chooseRoom(roomId: string): Promise<void> {
    if (this.knownRooms.length > 0 && !this.knownRooms.some((s) => s.id === roomId)) {
      throw new Error(`Salle inconnue : ${roomId}`)
    }
    this.wantedRoomId = roomId
    this.setPairing({ ...this.pairing, status: 'idle', userCode: undefined })

    /**
     * The pairing leaves in the background and the call hands back at once.
     *
     * Awaiting it would block the HTTP request until the approval — so potentially
     * half an hour, during which the control app's button would spin and the browser
     * would end up giving up. The screen follows the progress through the state
     * stream.
     */
    this.pairingInFlight = this.startPairing().finally(() => {
      this.pairingInFlight = null
    })
  }

  private async startPairing(): Promise<void> {
    try {
      const token = await this.ensurePaired()
      if (token == null) return
      await this.connectHub(token)
      await this.connectObs()
    } catch (cause) {
      this.options.onLog?.('warn', 'appairage interrompu', { message: (cause as Error).message })
    }
  }

  /**
   * Fetches the list of rooms for the choice screen.
   *
   * Public on the hub side: an unpaired machine has no token to present.
   */
  private async loadRooms(): Promise<void> {
    try {
      const client: ContractRouterClient<typeof contract> = createORPCClient(
        new FetchLink({ origin: this.options.hubOrigin, url: '/rpc' }),
      )
      this.knownRooms = await client.rooms.public()
    } catch {
      // Hub unreachable: the screen will show it, the supervision will retry.
      this.knownRooms = []
    }
  }

  private setPairing(state: PairingState): void {
    this.pairing = state
    // The screen must follow immediately: it is the one that carries the code.
    this.runtime.emit('state', this.runtime.state())
  }

  /**
   * Watches the hub and catches up on what failed.
   *
   * Without this loop, a hub absent at startup condemned the room: it displayed its
   * code, failed once, and never tried again. Yet that is exactly the most likely
   * startup order on an event morning — the rooms come on before anyone has
   * launched the hub.
   */
  startSupervision(intervalMs = 15_000): void {
    if (this.supervision != null) return

    this.supervision = setInterval(() => {
      if (this.workInFlight || this.abort.signal.aborted) return
      this.workInFlight = true
      void this.catchUp().finally(() => {
        this.workInFlight = false
      })
    }, intervalMs)
    this.supervision.unref?.()
  }

  /** One catch-up pass. Never throws: it is a background loop. */
  private async catchUp(): Promise<void> {
    // Nothing to do while the link holds: `consumeCommands` handles its own
    // reconnections, and probing on top would only add noise.
    if (this.link != null) return

    // Waiting for a room choice: we only refresh the list, so that the screen stops
    // being empty as soon as the hub answers.
    if (this.wantedRoomId == null && this.options.readToken()?.trim() == null) {
      await this.loadRooms()
      if (this.knownRooms.length > 0) {
        this.setPairing({ ...this.pairing, status: 'idle' })
        return
      }
    }

    const reachable = await probeConnectivity({ hubOrigin: this.options.hubOrigin })
    if (reachable === 'OFFLINE') {
      // The hub still does not answer. We try nothing and will come back: the room
      // keeps working from its cache in the meantime.
      await this.connectivity.markRealtimeFailure()
      return
    }

    try {
      const token = await this.ensurePaired()
      if (token == null) return
      await this.connectHub(token)
      await this.connectObs()
      this.options.onLog?.('info', 'hub rejoint après indisponibilité')
    } catch (cause) {
      this.options.onLog?.('warn', 'rattrapage du hub sans succès', {
        message: (cause as Error).message,
      })
    }
  }

  /** Serves the screen. The first thing done, before any network attempt. */
  async startDisplay(): Promise<string> {
    const url = await this.display.listen()
    this.options.onLog?.('info', "écran de salle servi", { url: `${url}/display/projector` })

    // The clock tick: advances the timeline, and expires messages and notices, even
    // when nothing arrives from the hub any more.
    this.tick = setInterval(() => {
      this.runtime.refreshSessions()
      this.runtime.expireMessage()
      this.runtime.expireNotifications()
    }, 5_000)

    /**
     * Shipping the rushes back, in the background.
     *
     * Started with the screen and not with the hub: the loop does nothing while no
     * destination is known, and starting it later would mean a room never connected
     * would never catch up on its rushes in the evening, when the hub comes back.
     */
    this.uploads.start()

    return url
  }

  /**
   * Fetches the machine's token, running the pairing if necessary.
   *
   * Returns `null` if the hub is unreachable: it is not an error, the room carries
   * on from its cache.
   */
  async ensurePaired(): Promise<string | null> {
    // The empty string included: it is what `repair()` writes to clear, and letting
    // it through would make the machine look paired with a null token.
    const existing = this.options.readToken()?.trim()
    if (existing != null && existing.length > 0) {
      this.setPairing({ status: 'paired' })
      return existing
    }

    // The choice comes before the code: with no room proposed, the screen asks
    // which one first, rather than displaying a code the console will have to
    // guess.
    await this.loadRooms()
    if (this.wantedRoomId == null && this.knownRooms.length > 0) {
      this.setPairing({ status: 'idle' })
      return null
    }

    try {
      const { accessToken } = await runPairing(
        httpPairingTransport(this.options.hubOrigin),
        this.options.clientId,
        {
          scope: this.wantedRoomId == null ? undefined : `room:${this.wantedRoomId}`,
          // Closing the application must interrupt the wait, not endure it.
          signal: this.abort.signal,
          onUnreachable: () => {
            // The code stays displayed: it is still valid on the hub side.
            this.setPairing({ ...this.pairing, message: 'Hub momentanément injoignable…' })
          },
          onCode: (code) => {
            this.setPairing({
              status: 'waiting',
              userCode: code.user_code,
              verificationUri:
                code.verification_uri_complete ??
                code.verification_uri ??
                `${this.options.hubOrigin.replace(/\/$/, '')}/admin`,
              expiresInSeconds: code.expires_in,
            })
            this.options.onPairingCode?.(code)
          },
        },
      )

      /**
       * The approving session is used here only, to claim the room token. It gives
       * the rights of the operator who approved; a control machine has no reason to
       * keep them.
       */
      const token = await this.claimRoomToken(accessToken)
      this.options.writeToken(token)
      this.setPairing({ status: 'paired' })
      return token
    } catch (cause) {
      const message = (cause as Error).message
      this.setPairing({ status: 'failed', message })
      this.options.onLog?.('warn', 'appairage impossible pour le moment', { message })
      return null
    }
  }

  private async claimRoomToken(sessionToken: string): Promise<string> {
    const client: ContractRouterClient<typeof contract> = createORPCClient(
      new FetchLink({
        origin: this.options.hubOrigin,
        url: '/rpc',
        headers: () => ({
          authorization: `Bearer ${sessionToken}`,
          'x-room-client-id': this.options.clientId,
        }),
      }),
    )
    const { token } = await client.devices.claim()
    return token
  }

  /**
   * Starts again from scratch after a credentials refusal.
   *
   * The stored token is worth nothing any more: keeping it would make the machine
   * loop on a silent failure. We erase it and display the code again.
   */
  async repair(reason: string): Promise<void> {
    this.options.onLog?.('warn', 'réappairage nécessaire', { raison: reason })
    this.options.writeToken('')
    this.setPairing({ status: 'expired', message: reason })

    // Everything that talks to the hub stops: without that, the queue and the
    // heartbeat would keep hitting a closed link and would throw in a loop.
    this.pump?.stop()
    this.pump = null
    if (this.heartbeat != null) clearInterval(this.heartbeat)
    this.heartbeat = null
    if (this.roomsTimer != null) clearInterval(this.roomsTimer)
    this.roomsTimer = null

    await this.link?.close()
    this.link = null

    const token = await this.ensurePaired()
    if (token != null) await this.connectHub(token)
  }

  /** Connects the hub: synchronizes then consumes the commands in the background. */
  async connectHub(token: string): Promise<void> {
    this.link = new HubLink({
      hubOrigin: this.options.hubOrigin,
      clientId: this.options.clientId,
      token,
      store: this.store,
      runtime: this.runtime,
      onLog: this.options.onLog,
      onHubMode: (mode) => {
        if (mode === this.hubMode) return
        this.hubMode = mode
        const ours = this.options.mode ?? 'production'
        if (mode !== ours) {
          this.options.onLog?.('error', 'MODES DIVERGENTS entre la salle et le hub', {
            room: ours,
            hub: mode,
          })
        }
      },
      onAuthRejected: (reason) => {
        // Restarted outside the call stack: we are inside the error handler of the
        // link we are about to close.
        setTimeout(() => void this.repair(reason), 0)
      },
      /*
       * Confirm what we have just applied, right away.
       *
       * The gesture comes from a mobile control app, which never paints ahead: the
       * room screen it asked for stays off on its phone until the room has sent it
       * up. A scene switch announces itself — OBS emits — a screen mode does not: it
       * only travels through the heartbeat.
       */
      onCommandApplied: () => {
        this.beat()
        this.wakeUplink()
      },
    })

    await this.syncEverything()

    void this.link.consumeCommands(this.abort.signal)
    void this.link.consumeWall(this.abort.signal)
    this.startOutbox()
    this.startRoomWatch()

    // The talks' initial state: without it, a restart mid-talk would show
    // "upcoming" on a talk that has already been launched.
    await this.loadSessionStates()
  }

  /**
   * Everything the room reads back from the hub: program, assets, configuration,
   * QR code.
   *
   * Extracted from the connection so it can be replayed during the day. What
   * *opens* something — the command stream, the outbox, the room watch, OBS — is
   * not in it: replaying that would cut what is running.
   *
   * @param full Asks for the whole program again even at an identical fingerprint.
   */
  private async syncEverything(full = false): Promise<boolean> {
    if (this.link == null) return false
    const result = await this.link.sync({ full })
    const roomId = this.store.settings().roomId
    if (roomId != null) {
      await this.display
        .prepareWallQr(roomId, `${this.options.hubOrigin.replace(/\/$/, '')}/mur?salle=${encodeURIComponent(roomId)}`)
        .catch((cause: Error) => this.options.onLog?.('warn', 'QR du mur non généré', { message: cause.message }))
    }
    if (result.ok) {
      const cached = this.store.activeProgram()
      if (cached != null) {
        // After the sync, not before: downloading the assets must never delay the
        // program's display.
        const report = await this.assets.prefetch(cached.program)
        this.options.onLog?.('info', 'assets préchargés', report)
      }
    }
    return result.ok
  }

  /**
   * A full resynchronization, asked for from the console.
   *
   * Everything a startup does, except what would cut something: the program comes
   * down whole — without trusting the cached fingerprint, since it is precisely the
   * cache that is suspected — the missing assets are picked up, the configuration,
   * the social accounts, the event and the clock are read back, and the talks'
   * lifecycle is asked of the hub again.
   *
   * **OBS is not reconnected and the recording is not touched.** A room being put
   * straight during a talk must not lose its capture to it: this gesture exists
   * precisely so one does not have to restart the machine, which does cut
   * everything.
   */
  async fullResync(): Promise<void> {
    if (this.link == null) {
      this.options.onLog?.('warn', 'resynchronisation complète sans hub : rien à relire')
      return
    }
    this.options.onLog?.('info', 'resynchronisation complète demandée')
    const ok = await this.syncEverything(true)
    await this.loadSessionStates()
    if (ok) {
      this.runtime.notify({ level: 'info', text: 'Resynchronisation complète terminée' })
      this.options.onLog?.('info', 'resynchronisation complète terminée')
      return
    }
    // Said plainly: a room that stays on its cache after being asked to read
    // everything back is not put straight, and the console has just announced the
    // opposite.
    this.runtime.notify({
      level: 'warning',
      text: 'Resynchronisation complète : hub injoignable, la salle garde son cache',
    })
    this.options.onLog?.('warn', 'resynchronisation complète incomplète : hub injoignable')
  }

  /**
   * Reads the room's talk lifecycle back from the hub.
   *
   * Called at sync time, and every time the hub's clock moves: the hub discards the
   * decisions dated after the current instant, so the room has to read them back
   * rather than reason on its copy — it does not have the decision dates, and no
   * command announces that a fact has stopped applying.
   *
   * On failure we keep the previous copy: stale beats empty, which would show
   * "upcoming" on a running talk.
   */
  private async loadSessionStates(): Promise<void> {
    if (this.link == null) return
    try {
      const states = await this.link.client.sessions.states({ roomId: this.store.settings().roomId })
      this.runtime.replaceSessionStates(states)
    } catch (cause) {
      this.options.onLog?.('warn', 'états des conférences non récupérés', {
        message: (cause as Error).message,
      })
    }
  }

  /**
   * Starts the sending up.
   *
   * Separate from the synchronization: even if the `sync` failed, the queue must
   * run — it will catch up as soon as the hub answers.
   */
  private startOutbox(): void {
    const roomId = this.store.settings().roomId
    const outbox = this.ensureOutbox()
    if (roomId == null || outbox == null || this.link == null) return
    // A re-pairing restarts `connectHub`: we do not want two pumps.
    this.pump?.stop()
    if (this.heartbeat != null) clearInterval(this.heartbeat)

    this.pump = new OutboxPump({
      outbox,
      store: this.store,
      push: async (batch) => {
        // The link can disappear during a re-pairing: failing cleanly sends the batch
        // back to the queue, where `!` would have thrown an unhandled error.
        const link = this.link
        if (link == null) throw new Error('Hub non connecté')
        return link.client.ingest.push({ batch })
      },
      onConnectivity: (value) => {
        // A send failure does not mean "network cut": we probe the hub over HTTP to
        // tell `DEGRADED` from `OFFLINE`.
        if (value === 'ONLINE') this.connectivity.markOnline()
        else void this.connectivity.markRealtimeFailure()
      },
      onDepth: (depth) => this.runtime.setOutboxDepth(depth),
      onServerTime: (serverTime) =>
        this.runtime.setServerTime(serverTime),
    })
    this.pump.start()

    // A regular heartbeat, collapsed: an hour offline leaves a single occurrence in
    // the queue, not 720.
    this.heartbeat = setInterval(() => this.beat(), 10_000)
    this.heartbeat.unref?.()
  }

  /**
   * Sends up to the hub what only travels through the heartbeat.
   *
   * Called by the tick, and **right away** when one of these facts changes. A
   * mobile control app never paints ahead: until the room has sent up, its button
   * still describes the state from before, and ten seconds of delay are enough to
   * get it pressed a second time.
   *
   * Free to repeat: `heartbeatDedupKey` collapses the queue — it is the same
   * mechanism that avoids 720 heartbeats after an hour offline.
   */
  private beat(): void {
    const roomId = this.store.settings().roomId
    if (roomId == null) return
    const state = this.runtime.state()
    this.emit(
      buildHeartbeat({
        connectivity: state.connectivity,
        sceneRole: state.sceneRole,
        /*
         * The capture's state, read from the runtime.
         *
         * It is **OBS-B** that records and streams; OBS-A only projects. The
         * heartbeat nevertheless asked `obsA`: it therefore sent up `false` every ten
         * seconds, overwriting at the hub the `recording` that `recording.started`
         * had just written there. The mobile control app showed an indicator switched
         * off on a room mid-capture, and the supervision console with it.
         *
         * The runtime rather than `obsB` directly: it is the source the room's
         * control app already reads, and it adopts what OBS was recording before the
         * connection. A single truth, the one that is on screen.
         */
        recording: state.recording,
        streaming: state.streaming,
        outboxDepth: this.outboxDepth(),
        programContentHash: state.contentHash,
        displayMode: state.mode,
      }),
      heartbeatDedupKey(roomId),
    )
  }

  /**
   * Loads a program from a local file.
   *
   * The startup chain's last fallback: the SQLite cache → a file imported by hand
   * (a USB key) → the embedded snapshot. Makes it possible to open a room even if
   * the hub has never been reachable from this machine.
   */
  async importProgramFile(path: string): Promise<{ contentHash: string; sessions: number }> {
    const { readFile } = await import('node:fs/promises')
    const { createHash } = await import('node:crypto')
    const { normalizeProgram } = await import('@cloudnord/program')

    const raw = await readFile(path, 'utf8')
    const program = normalizeProgram(JSON.parse(raw))
    // The same fingerprint as on the hub side: a manual import then a sync do not
    // create two versions of the same program.
    const contentHash = createHash('sha256').update(raw).digest('hex').slice(0, 32)

    this.store.saveProgram(contentHash, program)
    this.runtime.setProgram(contentHash, program)
    this.runtime.refreshSessions()
    this.store.log('info', 'programme importé depuis un fichier local', { path, contentHash })

    return { contentHash, sessions: program.sessions.length }
  }

  /**
   * Beyond this, the control app stops believing the other rooms' view.
   *
   * A mirror of `STALE_VIEW_MS` on the page side: it is the window to hold, and the
   * reminder below takes it well in advance.
   */
  private static readonly STALE_VIEW_MS = 60_000

  /**
   * Beyond this, we republish even with no change, to refresh the timestamp.
   *
   * The control app only trusts the hub's view if it is fresh; the timestamp must
   * therefore reach it regularly, including when nothing moves. A third of the
   * window leaves two chances to hold it before it closes, even if one fails.
   */
  private static readonly VIEW_REMINDER_MS = 20_000

  /** The last published view, serialized, so as to republish only when it makes sense. */
  private publishedRoomStatuses: string | null = null
  private publishedRoomStatusesAt = 0
  /** One call in flight, and at most one pending re-request. */
  private roomWatchRunning = false
  private roomWatchAsked = false

  /**
   * Refreshes the other rooms' state.
   *
   * Three cadences, and that is intended: a short poll for what has no command —
   * recording, scene, connectivity, which come up on the concerned room's heartbeat
   * — an **immediate trigger** on a command for what has one, and a periodic
   * reminder to hold the freshness timestamp.
   *
   * The immediate trigger is what makes the difference in a room: a neighbouring
   * control app's decision already arrives pushed on the command stream, only the
   * *view* was polled. The badge therefore lagged the notification that accompanied
   * it by up to one polling turn.
   */
  private startRoomWatch(): void {
    if (this.roomsTimer != null) clearInterval(this.roomsTimer)
    void this.refreshRoomStatuses()
    this.roomsTimer = setInterval(() => void this.refreshRoomStatuses(), 5_000)
    this.roomsTimer.unref?.()
  }

  /**
   * Asks for the other rooms' view again, and republishes it if it moved.
   *
   * Publishing is not a given: updating the field in memory wakes nobody. The
   * screen only receives on `runtime.emit('state')` — that is what was missing, and
   * the polling ran in the void.
   *
   * Republishing on every turn would be the opposite excess: the whole payload is
   * reserialized on every broadcast, and the stream is supposed to stay silent when
   * nothing changes. Hence the comparison, doubled with a periodic reminder for the
   * timestamp.
   */
  /**
   * Sends up right away what has just changed in OBS.
   *
   * For what is driven from afar. A mobile control app reads the room's state
   * through the hub, which holds it from the heartbeat: with no wake-up, a scene
   * switch takes up to one pump tick plus one polling turn to show on the phone.
   * Yet the control app never paints ahead — it is the stream that repaints the
   * button — so that delay reads as a missed gesture, and one presses a second
   * time.
   *
   * Three transitions only, and OBS emits them only on a real change: it is not a
   * flow, it is one fact per switch.
   */
  private wakeUplink(): void {
    this.pump?.wake()
  }

  private async refreshRoomStatuses(): Promise<void> {
    if (this.link == null) return
    // One call in flight: a burst of decisions must not open ten parallel requests,
    // but the last one must not get lost either — an answer that left *before* the
    // write still describes the past.
    if (this.roomWatchRunning) {
      this.roomWatchAsked = true
      return
    }
    this.roomWatchRunning = true
    try {
      const statuses = await this.link.client.rooms.statuses()
      this.roomStatuses = statuses.map((room) => ({
        roomId: room.roomId,
        name: room.name,
        connectivity: room.connectivity,
        sceneRole: room.sceneRole,
        recording: room.recording,
        outboxDepth: room.outboxDepth,
        lastSeenAt: room.lastSeenAt,
        currentSessionId: room.currentSessionId,
        conference: room.conference,
      }))
      this.roomStatusesAt = new Date().toISOString()

      const view = JSON.stringify(this.roomStatuses)
      const reminderDue = Date.now() - this.publishedRoomStatusesAt >= RoomApp.VIEW_REMINDER_MS
      if (view !== this.publishedRoomStatuses || reminderDue) {
        this.publishedRoomStatuses = view
        this.publishedRoomStatusesAt = Date.now()
        this.runtime.emit('state', this.runtime.state())
      }
    } catch {
      // Hub unreachable: we keep the last known view, dated, rather than emptying
      // the panel — an empty list would read as "no room". The timestamp does not
      // move: past a minute, the control app will fall back by itself onto the
      // program, which stays right offline.
    } finally {
      this.roomWatchRunning = false
      if (this.roomWatchAsked) {
        this.roomWatchAsked = false
        void this.refreshRoomStatuses()
      }
    }
  }

  /** Connects both OBS instances with the room's role mapping. */
  async connectObs(): Promise<void> {
    const config = this.store.settings().config
    if (config == null) {
      this.options.onLog?.('warn', 'configuration de salle absente, OBS non connecté')
      return
    }

    await this.connectProjection(config)
    await this.connectCapture(config)
  }

  /**
   * Opens (or reopens) **one** instance, at the operator's request.
   *
   * Instance by instance: cutting the capture to apply a projection setting would
   * cost a take. It is also why saving a setting reconnects nothing by itself — the
   * moment belongs to the operator, who knows whether a talk is running.
   */
  async connectObsInstance(instance: ObsInstance): Promise<void> {
    const config = this.store.settings().config
    if (config == null) {
      throw new Error("Configuration de salle absente : le hub n'a pas encore répondu")
    }

    // The old connection goes first: the parameters are carried by the controller,
    // which gets rebuilt.
    if (instance === 'A') {
      await this.obsA?.disconnect().catch(() => {})
      this.obsA = null
      await this.connectProjection(config, true)
    } else {
      await this.obsB?.disconnect().catch(() => {})
      this.obsB = null
      await this.connectCapture(config, true)
    }
  }

  /**
   * Opens the connection of an already built instance.
   *
   * Two regimes. At startup, we insist endlessly: OBS is often launched after the
   * control app, and nobody should have to click anything again. On demand, a
   * single attempt — somebody is waiting in front of the screen and the failure
   * must come back to them — but the resume loop starts in the background anyway,
   * so that the instance ends up reattaching by itself.
   */
  private async wire(instance: ObsInstance, manual: boolean): Promise<void> {
    const connect = () => (instance === 'A' ? this.obsA! : this.obsB!).connect()

    if (!manual) {
      this.obsResuming[instance] = true
      try {
        await keepObsConnected({
          connect,
          onLog: this.options.onLog,
          signal: this.abort.signal,
        })
      } finally {
        this.obsResuming[instance] = false
      }
      return
    }

    try {
      await connect()
    } catch (cause) {
      this.restartResume(instance)
      throw new Error('OBS-' + instance + " n'a pas répondu : " + (cause as Error).message)
    }
  }

  /** A background resume loop, one at a time per instance. */
  private restartResume(instance: ObsInstance): void {
    if (this.obsResuming[instance]) return
    this.obsResuming[instance] = true
    void keepObsConnected({
      connect: () => (instance === 'A' ? this.obsA! : this.obsB!).connect(),
      onLog: this.options.onLog,
      signal: this.abort.signal,
    }).finally(() => {
      this.obsResuming[instance] = false
    })
  }

  private async connectProjection(config: RoomConfigCache, manual = false): Promise<void> {
    const transport = (this.options.obsTransportFactory ?? createObsTransport)(
      'A',
      sceneNames(config.sceneRoles.A),
    )
    this.obsA = new ObsController({
      instance: 'A',
      url: config.obs.A.url,
      password: config.obs.A.password,
      sceneRoles: config.sceneRoles.A,
      transport,
      onEvent: (event) => {
        switch (event.type) {
          case 'scene':
            this.runtime.observeSceneRole(event.role)
            this.emit({ type: 'scene.changed', obs: 'A', role: event.role, sceneName: event.sceneName })
            this.wakeUplink()
            break
          case 'connected':
            // Adopt the observed state: without it, the control app and the console
            // show an empty scene until the first switch.
            this.runtime.observeSceneRole(event.currentRole)
            this.emit({
              type: 'obs.connection',
              obs: 'A',
              connected: true,
              unresolvedRoles: event.unresolvedRoles,
            })
            if (event.unresolvedRoles.length > 0) {
              this.options.onLog?.('warn', 'rôles de scène introuvables dans OBS-A', {
                roles: event.unresolvedRoles,
              })
            }
            break
          case 'disconnected':
            this.emit({ type: 'obs.connection', obs: 'A', connected: false, unresolvedRoles: [] })
            break
          default:
            break
        }
      },
    })

    this.obsApplied.A = obsFingerprint(config, 'A')
    await this.wire('A', manual)
  }

  /**
   * OBS-B: the capture. Distinct from the projection because it has neither the
   * same scenes nor the same consequences — a mistake here costs a VOD.
   */
  private async connectCapture(config: RoomConfigCache, manual = false): Promise<void> {
    const transport = (this.options.obsTransportFactory ?? createObsTransport)(
      'B',
      sceneNames(config.sceneRoles.B),
    )
    this.obsB = new ObsController({
      instance: 'B',
      url: config.obs.B.url,
      password: config.obs.B.password,
      sceneRoles: config.sceneRoles.B,
      transport,
      onEvent: (event) => {
        switch (event.type) {
          case 'audio':
            this.levels.push(event.inputs)
            break
          case 'recording':
            this.runtime.observeCapture({ recording: event.active })
            /*
             * The heartbeat, not only the drain.
             *
             * A capture launched from OBS itself emits no `recording.started`: it
             * only comes up through the heartbeat. Without this reminder, the queue we
             * wake here holds nothing to say.
             */
            this.beat()
            this.wakeUplink()
            // The path only arrives at the stop: it unblocks the sidecar's writing.
            if (!event.active) {
              if (this.pendingOutputPath != null) {
                this.pendingOutputPath(event.outputPath)
                this.pendingOutputPath = null
              } else {
                // Nobody is waiting for this path in the control app: the stop comes
                // from OBS.
                void this.closeStopFromObs(event.outputPath)
              }
            }
            break
          case 'streaming':
            this.runtime.observeCapture({ streaming: event.active })
            this.beat()
            this.wakeUplink()
            this.emit(
              event.active
                ? { type: 'stream.started', obs: 'B', sessionId: this.runtime.state().currentSession?.id ?? null }
                : { type: 'stream.stopped', obs: 'B', reason: 'operator' },
            )
            break
          case 'connected':
            /**
             * Adopt the recording and the stream in progress.
             *
             * The case that matters: the application restarts during a talk and OBS
             * is already recording. Starting again from "nothing running" would
             * suggest a lost take.
             */
            this.runtime.observeCapture({
              recording: event.recording,
              streaming: event.streaming,
            })
            // Adopted here, so said here: the console and the mobile control app
            // otherwise started from "nothing running" for ten seconds.
            this.beat()
            this.emit({
              type: 'obs.connection',
              obs: 'B',
              connected: true,
              unresolvedRoles: event.unresolvedRoles,
            })
            // Reapplies the VU meter subscription: a control app opened before OBS,
            // or during a reconnection, must find its levels back by itself.
            if (this.levelsRequested) void this.obsB?.setVolumeMeters(true).catch(() => {})
            break
          case 'disconnected':
            // The VU meter falls back to zero rather than freezing the last
            // measurement: a silent control app must not show a signal.
            this.levels.reset()
            this.display.publishLevels([])
            this.emit({ type: 'obs.connection', obs: 'B', connected: false, unresolvedRoles: [] })
            break
          default:
            break
        }
      },
    })

    this.recording = new RecordingSession({
      setFilenameFormat: async (format) => {
        await this.obsB!.setProfileParameter('Output', 'FilenameFormatting', format)
      },
      startRecord: () => this.obsB!.startRecording(),
      stopRecord: () => this.obsB!.stopRecording(),
      // The fallback: with no path announced by OBS, the master is found by its name
      // in the captures root — the very one the VOD modal reads back.
      recordingRoot: () => this.capturesRoot(),
      fs: nodeRecordingFs(),
      now: () => Date.now(),
      correctedNow: () => this.runtime.correctedNow(),
      // In development only: it is by pushing the clock that one runs through a day
      // there, and a take's duration must follow what the timeline says rather than
      // the time spent in front of the screen. In production, monotonic time stays
      // the only judge — a clock resynchronization mid-talk must not lengthen the
      // talk.
      followsClock: (this.options.mode ?? 'production') === 'dev',
      onLog: this.options.onLog,
    })

    this.obsApplied.B = obsFingerprint(config, 'B')
    await this.wire('B', manual)
  }

  /** Starts recording the running talk. */
  async startRecording(): Promise<void> {
    const config = this.store.settings().config
    if (this.recording == null || config == null) throw new Error('OBS-B non connecté')

    const state = this.runtime.state()
    const cached = this.store.activeProgram()

    await this.recording.start({
      session: state.currentSession,
      roomId: state.roomId,
      roomSlug: config.fileSlug ?? slugify(config.name).slice(0, 16),
      timezone: cached?.program.timezone ?? DEFAULT_TIMEZONE,
    })
    /**
     * The room's log, and not only the machine's console.
     *
     * A capture found running without remembering having launched it is a question
     * one asks in front of the control app, not in front of a terminal: the answer
     * must be next to the stopwatch. The log is picked up in the Diagnostic panel,
     * and it carries the time.
     */
    this.options.onLog?.('info', 'captation démarrée depuis la régie', {
      session: state.currentSession?.title ?? null,
      simulated: this.obsB?.snapshot().simulated === true,
    })
    this.emit({ type: 'recording.started', obs: 'B', sessionId: state.currentSession?.id ?? null })
  }

  /**
   * Waits for OBS to announce the file produced.
   *
   * Bounded: if the event does not come — OBS killed mid-stop, for instance — we
   * write what we know anyway rather than blocking the control app. The sidecar
   * will be missing, and the log will say so.
   */
  private awaitOutputPath(timeoutMs = 5_000): Promise<string | null> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pendingOutputPath = null
        this.options.onLog?.('warn', "OBS n'a pas annoncé le fichier enregistré", { timeoutMs })
        resolve(null)
      }, timeoutMs)

      this.pendingOutputPath = (path) => {
        clearTimeout(timer)
        resolve(path)
      }
    })
  }

  /** Applies the stream configuration then starts the stream. */
  async startStreaming(): Promise<void> {
    const config = this.store.settings().config
    if (this.obsB == null) throw new Error('OBS-B non connecté')
    if (config?.stream == null) {
      throw new Error("Aucune clé de diffusion pour cette salle : le hub ne l'a pas fournie")
    }
    await this.obsB.configureStream(config.stream.rtmpUrl, config.stream.streamKey)
    await this.obsB.startStream()
  }

  async stopStreaming(): Promise<void> {
    if (this.obsB == null) throw new Error('OBS-B non connecté')
    await this.obsB.stopStream()
  }

  /**
   * Reads the stream's health.
   *
   * Sent up as `best-effort`: it is monitoring information, not a fact to keep —
   * losing it during an outage has no consequence.
   */
  async reportStreamHealth(): Promise<void> {
    if (this.obsB == null || !this.runtime.state().streaming) return
    try {
      const status = await this.obsB.streamStatus()
      this.emit({ type: 'stream.telemetry', ...status }, 'stream.telemetry')
    } catch (cause) {
      this.options.onLog?.('warn', 'télémétrie de diffusion indisponible', {
        message: (cause as Error).message,
      })
    }
  }

  /** Places a chapter, or one of the two editing markers. See `RecordingSession.mark`. */
  mark(label: string, role: MarkerRole | null = null): void {
    if (this.recording == null || !this.recording.active) throw new Error('Aucun enregistrement en cours')
    const marker = this.recording.mark(label, role)
    /*
     * The role does not go up to the hub, and does not have to.
     *
     * What the editing reads is the sidecar: written on the room's disk, uploaded
     * with the rush, it carries `role`. The event, for its part, feeds the log
     * somebody reads back — and "Marqueur « Début »" already reads there. A second
     * field for the same thing would make two truths to keep in agreement, one of
     * which nobody reads.
     *
     * A marker placed again therefore emits a second event, without the first
     * disappearing. That is right: the log tells the gestures, and placing the start
     * again *is* a gesture.
     */
    this.emit({
      type: 'talk.marker',
      sessionId: this.runtime.state().currentSession?.id ?? null,
      label,
      offsetMs: marker.offsetMs,
    })
  }

  /**
   * Stops the recording, renames the master and writes the sidecar.
   *
   * Everything is produced locally: the VOD chain works even if the hub has stayed
   * unreachable all day.
   */
  async stopRecording(): Promise<StopResult> {
    if (this.recording == null || !this.recording.active) throw new Error('Aucun enregistrement en cours')

    // Armed **before** `StopRecord`: OBS's event can arrive right on the heels of
    // the request, and a resolver set after it would miss it.
    const outputPath = this.awaitOutputPath()
    this.captureClosing = true
    let result: StopResult
    try {
      result = await this.recording.stop(() => outputPath)
    } finally {
      this.captureClosing = false
    }
    this.options.onLog?.('info', 'captation arrêtée depuis la régie', {
      duree: Math.round(result.sidecar.durationMs / 1000) + ' s',
      fichier: result.sidecar.videoFile,
    })
    this.emit({
      type: 'recording.stopped',
      obs: 'B',
      sessionId: result.sidecar.sessionId,
      outputPath: result.videoPath,
      durationMs: result.sidecar.durationMs,
      sidecarWritten: result.sidecarPath != null,
    })
    return result
  }

  /**
   * Closes a take the operator stopped **from OBS**.
   *
   * The gesture is common and perfectly legitimate: the hand is already in OBS, one
   * presses "Stop recording" there. The control app then asked for nothing, so
   * nobody was waiting for the file's path — and until now everything the take knew
   * about itself went in the bin: the title, the speakers, and above all the
   * markers placed during the talk, which exist nowhere else.
   *
   * What this fallback does **not** do: adopt a capture *launched* from OBS. That
   * one has neither a start, nor a talk, nor markers on our side — there would be
   * nothing to write in the sidecar, and fabricating an empty one would mislead the
   * editing more surely than its absence.
   *
   * `alreadyStopped` is indispensable here: asking `StopRecord` again of an already
   * inactive output is an OBS error, which would carry away the sidecar's writing.
   */
  private async closeStopFromObs(outputPath: string | null): Promise<void> {
    if (this.recording == null || !this.recording.active || this.captureClosing) return
    this.captureClosing = true
    try {
      const result = await this.recording.stop(async () => outputPath, { alreadyStopped: true })
      this.options.onLog?.(
        result.sidecarPath == null ? 'warn' : 'info',
        result.sidecarPath == null
          ? 'captation arrêtée depuis OBS, sidecar non écrit'
          : 'captation arrêtée depuis OBS, sidecar écrit',
        {
          duree: Math.round(result.sidecar.durationMs / 1000) + ' s',
          fichier: result.sidecar.videoFile,
        },
      )
      this.emit({
        type: 'recording.stopped',
        obs: 'B',
        sessionId: result.sidecar.sessionId,
        outputPath: result.videoPath,
        durationMs: result.sidecar.durationMs,
        sidecarWritten: result.sidecarPath != null,
      })
    } catch (cause) {
      this.options.onLog?.('error', "arrêt constaté depuis OBS : sidecar non écrit", {
        message: (cause as Error).message,
      })
    } finally {
      this.captureClosing = false
    }
  }

  /**
   * The captures root.
   *
   * The room's setting is authoritative; failing that we ask OBS-B where it writes.
   * Without this fallback, a room that never filled the field in — the most common
   * case, since nothing else uses it — could check nothing at all, while the folder
   * exists and has been filling up since the morning.
   */
  private async capturesRoot(): Promise<string | null> {
    const configured = this.store.settings().config?.recordingRoot
    if (configured != null && configured.trim().length > 0) return configured
    try {
      return (await this.obsB?.recordDirectory()) ?? null
    } catch {
      return null
    }
  }

  private vodDeps(root: string): VodIndexDeps {
    return {
      root,
      fs: nodeVodFs(),
      // The room's clock dates the verdicts, the machine's judges the `mtime`s:
      // they are two different measurements, and confusing them made a take in
      // progress pass for a finished rush as soon as the hub ran a simulated day.
      now: () => this.runtime.correctedNow(),
      realNow: () => Date.now(),
      probe: ffprobeProbe(),
      onLog: this.options.onLog,
    }
  }

  /**
   * The absolute path of a file under the recordings root.
   *
   * Goes through the same guard as the control app's modal: the root is a folder an
   * operator types into a form served over HTTP, and `../../` is a valid entry
   * there. `null` when the file is not strictly below it — the uploader then
   * refuses, rather than sending a third party a file nobody asked it for.
   */
  private pathInCaptures(file: string): string | null {
    if (this.knownRoot == null) return null
    try {
      return pathUnder(this.knownRoot, file)
    } catch {
      return null
    }
  }

  /**
   * What there is to ship back: the rushes, each with its sidecar.
   *
   * Rebuilt on every pass rather than kept: the folder fills up all day, and a list
   * frozen at startup would see no talk.
   */
  private async vodCandidates(): Promise<VodCandidate[]> {
    const root = await this.capturesRoot()
    this.knownRoot = root
    if (root == null) return []
    const deps = this.vodDeps(root)
    const entries = await listRecordings(deps)

    return await Promise.all(
      entries.map(async (entry) => {
        const name = entry.file.replace(/\.[^./]+$/, '.json')
        /**
         * The sidecar's size is **read from disk**, it is not derived.
         *
         * It was first computed by re-serializing the object read back: the file the
         * room writes is indented, the recomputed string was not, and the sidecar
         * arrived at the storage truncated of its whitespace — so invalid, so
         * unreadable at editing time. A JSON cut in the middle does not show in a
         * list of files; it is discovered by opening it, months later.
         */
        const stat = entry.sidecar == null ? null : await deps.fs.stat(pathUnder(root, name))
        return {
          file: entry.file,
          sizeBytes: entry.sizeBytes,
          beingWritten: entry.beingWritten,
          sessionId: entry.sidecar?.sessionId ?? null,
          // Absent, we only upload the rush: a rush with no sidecar is precisely the
          // one that has to be saved.
          sidecar: stat == null ? null : { file: name, sizeBytes: stat.size },
        }
      }),
    )
  }

  /**
   * The hub, as the uploader uses it. `null`: nothing leaves.
   *
   * Two conditions, and both are needed: an open link, and a hub that announced a
   * destination at the last sync. An offline room does not upload — it is the only
   * thing in the system that cannot be done with no network, and that is in its
   * nature.
   */
  private hubVod(): HubVod | null {
    const link = this.link
    if (link == null || !(this.store.settings().vod?.actif ?? false)) return null
    return {
      begin: (input) => link.client.vod.begin(input),
      parts: (uploadId, numeros) => link.client.vod.parts({ uploadId, numeros }),
      progress: async (input) => {
        await link.client.vod.progress(input)
      },
      complete: async (uploadId) => {
        await link.client.vod.complete({ uploadId })
      },
      abort: async (uploadId, reason) => {
        await link.client.vod.abort({ uploadId, raison: reason })
      },
    }
  }

  /**
   * Milliseconds before this room's next talk.
   *
   * On the cached program and the **hub's corrected clock**, never the machine's:
   * in development, the gap between the two is counted in weeks, and the regulator
   * would allow an upload mid-talk. `null` when there is nothing left in the
   * program — end of day, or a room never synchronized: in both cases, there is
   * nothing to spare.
   */
  private msBeforeNextTalk(): number | null {
    const cached = this.store.activeProgram()
    const roomId = this.store.settings().roomId
    if (cached == null || roomId == null) return null
    const at = this.runtime.correctedNow()
    const next = nextTalk(
      sessionsForRoom(cached.program, roomId),
      at,
      this.runtime.state().sessionStates,
    )
    return next == null ? null : Math.max(0, next.startsAtMs - at)
  }

  /**
   * Erases this room's rushes. **Development only.**
   *
   * A second lock, after the hub's. Two rather than one because the two machines
   * can end up plugged into each other by accident — it is even the disagreement
   * the control app's mode badge exists to make visible. A production room that
   * receives this order refuses it and says so.
   *
   * Only erases what the application knows: the video containers it lists, their
   * sidecars, the verdicts file. The captures root is a folder an operator typed
   * into a form — sometimes a shared disk, sometimes not the one one thinks — and
   * emptying it entirely is not a gesture one recovers from.
   */
  async resetVod(): Promise<number> {
    if (this.options.mode !== 'dev') {
      this.options.onLog?.(
        'error',
        'remise à zéro des rushes refusée : cette salle n\u2019est pas en mode développement',
      )
      return 0
    }

    const root = await this.capturesRoot()
    if (root == null) return 0

    const { unlink } = await import('node:fs/promises')
    const entries = await listRecordings(this.vodDeps(root))
    // The verdicts file lives at the root, next to the rushes, and describes a
    // review that has no object once the rushes are gone.
    const names = entries.flatMap((entry) => [
      entry.file,
      entry.file.replace(/\.[^./]+$/, '.json'),
    ])
    names.push('.controles-vod.json')

    let erased = 0
    for (const name of names) {
      let filePath: string
      try {
        // The same guard as everywhere else: the root comes from a form served over
        // HTTP, and `../../` is a valid entry there.
        filePath = pathUnder(root, name)
      } catch {
        continue
      }
      try {
        await unlink(filePath)
        erased += 1
      } catch {
        // Absent, or already gone: it is not an error. A sidecar never written is
        // even the case one meets most.
      }
    }

    this.uploads.forgetAll()
    this.options.onLog?.('warn', 'rushes effacés (remise à zéro)', { root, files: erased })
    return erased
  }

  /** The uploads in progress and the reason for waiting, for the control app's modal. */
  vodUploads(): UploadsView {
    return this.uploads.view()
  }

  /** Queues a rush. A null `file` = everything that is left. */
  async uploadRecording(file: string | null): Promise<number> {
    return await this.uploads.request(file)
  }

  /** Gives up an upload in progress. */
  async cancelUpload(file: string): Promise<void> {
    await this.uploads.cancel(file)
  }

  /** The rushes produced under the root, from the most recent to the oldest. */
  async listRecordings(): Promise<VodList> {
    const [ffmpeg, ffprobe] = await Promise.all([
      toolAvailable('ffmpeg'),
      toolAvailable('ffprobe'),
    ])
    const tools = { ffmpeg, ffprobe }
    const root = await this.capturesRoot()
    if (root == null) return { root: null, entries: [], tools }
    return { root, entries: await listRecordings(this.vodDeps(root)), tools }
  }

  /** A few seconds' excerpt, produced on the fly for the modal. */
  async readRecordingExtract(file: string, atMs: number, durationMs: number): Promise<Excerpt | null> {
    const root = await this.capturesRoot()
    if (root == null) throw new Error('Aucun dossier d\u2019enregistrement connu')
    return await openExcerpt(this.vodDeps(root), file, { atMs, durationMs })
  }

  /** The rush as it is: to open it in a real player, or to fetch it back. */
  async readRecordingFile(file: string, range: string | null): Promise<FileStream | null> {
    const root = await this.capturesRoot()
    if (root == null) throw new Error('Aucun dossier d\u2019enregistrement connu')
    return await openFile(this.vodDeps(root), file, range)
  }

  /** A rush's technical check: container, tracks, duration, bitrate. */
  async inspectRecording(file: string): Promise<VodCheck> {
    const root = await this.capturesRoot()
    if (root == null) throw new Error('Aucun dossier d\u2019enregistrement connu')
    const check = await inspectRecording(this.vodDeps(root), file)
    // In the room's log, not only on the screen: an unreadable rush observed at
    // 11 am has to be findable in the evening, when one looks for what is missing.
    this.options.onLog?.(
      check.status === 'ok' ? 'info' : check.status === 'suspect' ? 'warn' : 'error',
      `contrôle VOD ${check.status} : ${file}`,
      { raisons: check.reasons },
    )
    return check
  }

  /** A verdict placed by hand, which takes precedence over the probe. */
  async setRecordingVerdict(file: string, status: VodVerdict | null): Promise<VodCheck | null> {
    const root = await this.capturesRoot()
    if (root == null) throw new Error('Aucun dossier d\u2019enregistrement connu')
    return await setVerdict(this.vodDeps(root), file, status)
  }

  /** The send backlog displayed in the control app — heartbeat aside, which renews itself. */
  outboxDepth(): number {
    return this.outbox?.backlog() ?? 0
  }

  /** Switches the room screen. */
  async setDisplayMode(mode: Parameters<RoomRuntime['setDisplayMode']>[0]): Promise<void> {
    await this.runtime.setDisplayMode(mode)
    // The room screen is also driven from afar: what the room shows must be
    // readable on the phone without waiting for the next tick.
    this.beat()
    this.wakeUplink()
  }

  /** Switches the projection scene. */
  async setSceneRole(role: Parameters<RoomRuntime['setSceneRole']>[0]): Promise<void> {
    if (role === 'RELAY' && this.store.settings().config?.relaySourceRoomId == null) {
      // Switching to an unconfigured relay would project an empty scene in front of
      // the room: better to refuse and say so.
      throw new Error("Aucune salle source configurée pour le relais")
    }
    await this.runtime.setSceneRole(role)
  }

  /**
   * Starts the talk currently in the program.
   *
   * The decision goes through the hub and not through the local state: the
   * organizer must see it from the console, and the other rooms from their own
   * view.
   */
  async startSession(): Promise<void> {
    await this.decideSession('start')
  }

  async endSession(): Promise<void> {
    await this.decideSession('end')
  }

  async resetSession(): Promise<void> {
    await this.decideSession('reset')
  }

  private async decideSession(action: 'start' | 'end' | 'reset'): Promise<void> {
    // The target, not the "running" session: between two talks or during a break,
    // it is the talk that is coming that one wants to drive.
    const session = this.runtime.state().targetSession
    if (session == null) throw new Error('Aucune conférence à piloter dans cette salle')
    if (this.link == null) throw new Error('Hub non connecté : la décision ne serait vue nulle part')

    if (action === 'reset') {
      await this.link.client.sessions.reset({ sessionId: session.id })
      this.runtime.setSessionStatus(session.id, 'scheduled')
      return
    }
    const state = await this.link.client.sessions[action]({ sessionId: session.id })
    // Applied locally without waiting for the command to come back: the button must
    // react at once, the command will confirm.
    this.runtime.setSessionStatus(state.sessionId, state.status)
  }

  /**
   * Sends a message to the console.
   *
   * Goes through the outbox: a call for help issued during a network outage will
   * arrive anyway, late — and that is precisely the moment one needs it most.
   */
  sendMessage(text: string, level: 'info' | 'warning' | 'urgent'): void {
    this.emit({ type: 'room.message', text, level })
    this.runtime.notify({ level: 'info', text: `Envoyé à la console : ${text}` })
  }

  /** Sets or removes the live scenes' banner, from the control app. */
  setLiveMessage(text: string | null, level: 'info' | 'warning' | 'urgent'): void {
    this.runtime.setLiveMessage(text, level)
  }

  /**
   * Puts an audience question on air, or takes it off.
   *
   * Attached to the driven talk: that is what makes it drop at the next talk rather
   * than stay burned into the next speaker's VOD.
   */
  setAiredQuestion(text: string | null, author: string | null): void {
    this.runtime.setQuestion(text, author, this.runtime.state().targetSession?.id ?? null)
  }

  /**
   * Reads back the questions asked in this room.
   *
   * On demand: the control app only looks at them at the end of a talk, and
   * circulating them continuously would load the state stream for nothing.
   */
  async refreshQuestions(): Promise<void> {
    if (this.link == null) throw new Error('Hub non connecté : les questions vivent chez lui')
    const { roomId, targetSession } = this.runtime.state()
    if (roomId == null) throw new Error('Salle inconnue')

    /**
     * Bounded to the driven talk.
     *
     * Across all rooms, the list mixed the day's questions: at 4 pm those of the
     * 10 am talk were still at the top of the vote, and the speaker was asked a
     * question that did not concern them. No talk driven: nothing to list — there
     * are no "questions in general" one would want to put on air.
     */
    this.questionsSession =
      targetSession == null ? null : { id: targetSession.id, title: targetSession.title }
    this.questions =
      targetSession == null
        ? []
        : (await this.link.questions(roomId, targetSession.id)).map((question) => ({
            id: question.id,
            text: question.text,
            author: question.author,
            votes: question.votes,
          }))
    this.questionsAt = new Date(this.runtime.correctedNow()).toISOString()
    // The state leaves at once: the control app displays the list without waiting.
    this.runtime.emit('state', this.runtime.state())
  }

  /** Dismisses a notice read in the control app. */
  dismissNotification(id: string): void {
    this.runtime.dismissNotification(id)
  }

  /** A resynchronization asked for from the control app. */
  async resync(): Promise<void> {
    if (this.link == null) throw new Error("Hub non connecté : rien à synchroniser")
    const result = await this.link.sync()
    if (!result.ok) throw new Error('Le hub est injoignable')
  }

  /**
   * Records a room setting, then puts the room back in agreement with it.
   *
   * Three steps, in this order: the hub writes, the room resynchronizes, OBS
   * reopens. Writing locally first would be faster but would lie — the next `sync`
   * pushes the hub's configuration back, and the entry would disappear without a
   * word. Hence the plain failure when the hub is absent: there is no honest half
   * measure here.
   */
  async configureRoom(patch: RoomConfigPatch): Promise<void> {
    if (this.link == null) {
      throw new Error(
        "Hub non connecté : la configuration s'enregistre sur le hub, elle serait perdue au prochain sync",
      )
    }
    await this.link.configure(patch)

    const result = await this.link.sync()
    if (!result.ok) throw new Error('Configuration écrite, mais la salle ne s\'est pas resynchronisée')

    // No automatic reconnection: the controllers carry their parameters at
    // construction time, so applying would mean cutting — including a capture in
    // progress. The control app reports the gap and lets the operator choose their
    // moment, instance by instance.
    this.options.onLog?.('info', 'configuration de salle modifiée depuis la régie')
  }

  /** Reads both instances' scenes back, for the configuration form. */
  async refreshObsScenes(): Promise<void> {
    const read = await Promise.allSettled([this.obsA?.refreshScenes(), this.obsB?.refreshScenes()])
    const failure = read.find((result) => result.status === 'rejected')
    if (failure != null) throw new Error('OBS n\'a pas répondu — instance déconnectée ?')
  }

  /**
   * The internal state exposed to the control app.
   *
   * Deliberately descriptive and not actionable: the page has no access to
   * `RoomApp`, only to what this contract makes visible.
   */
  diagnostics(): ControlDiagnostics {
    return {
      obs: {
        A: this.obsA?.snapshot() ?? null,
        B: this.obsB?.snapshot() ?? null,
      },
      outboxDepth: this.outboxDepth(),
      log: this.store.recentLogs(8).map((entry) => ({
        level: entry.level,
        message: entry.message,
        createdAt: entry.createdAt,
      })),
      relaySourceRoomId: this.store.settings().config?.relaySourceRoomId ?? null,
      config: this.configVisible(),
      questions: this.questions,
      questionsRefreshedAt: this.questionsAt,
      questionsSession: this.questionsSession,
      mode: { room: this.options.mode ?? 'production', hub: this.hubMode },
      rooms: this.roomStatuses,
      roomsRefreshedAt: this.roomStatusesAt,
      recording: {
        active: this.recording?.active ?? false,
        markers: this.recording?.markerCount ?? 0,
        startedAtMs: this.recording?.startedAt ?? null,
        startedAtCorrectedMs: this.recording?.correctedStartedAt ?? null,
        editing: this.recording?.editing ?? NO_EDITING_MARKS,
      },
    }
  }

  /** The room's settings, passwords stripped. See `VisibleConfig`. */
  private configVisible(): ControlDiagnostics['config'] {
    const config = this.store.settings().config
    if (config == null) return null
    return {
      obs: {
        A: this.visibleEndpoint(config, 'A'),
        B: this.visibleEndpoint(config, 'B'),
      },
      sceneRoles: config.sceneRoles,
      displayPort: config.displayPort,
      recordingRoot: config.recordingRoot,
      fileSlug: config.fileSlug,
      relaySourceRoomId: config.relaySourceRoomId,
      openFeedbackProjectId: config.openFeedbackProjectId,
      promptRecordingOnStart: config.promptRecordingOnStart,
      promptRecordingOnStop: config.promptRecordingOnStop,
      sceneOnStart: config.sceneOnStart,
      canBrowse: this.options.chooseFolder != null,
    }
  }

  /**
   * Opens the machine's picker and returns the chosen folder.
   *
   * Touches nothing: the path goes back up to the page, which fills in its field.
   * It will be "Enregistrer" that writes it to the hub, like the rest of the panel
   * — a picker that saved along the way would turn a glance at the file tree into a
   * change to the room.
   */
  async chooseFolder(): Promise<string | null> {
    const open = this.options.chooseFolder
    if (open == null) return null
    return open(this.store.settings().config?.recordingRoot ?? null)
  }

  private visibleEndpoint(config: RoomConfigCache, instance: ObsInstance): VisibleObsEndpoint {
    const applied = this.obsApplied[instance]
    return {
      url: config.obs[instance].url,
      hasPassword: (config.obs[instance].password ?? '') !== '',
      // Never wired: the "Connecter" button already says what to do, no use
      // announcing on top a gap with a connection that does not exist.
      pending: applied != null && applied !== obsFingerprint(config, instance),
    }
  }

  async close(): Promise<void> {
    this.abort.abort()
    // Lets the pairing observe the interruption: without that, its polling loop
    // would survive the close.
    await this.pairingInFlight?.catch(() => {})
    this.pump?.stop()
    this.uploads.stop()
    if (this.supervision != null) clearInterval(this.supervision)
    if (this.roomsTimer != null) clearInterval(this.roomsTimer)
    if (this.heartbeat != null) clearInterval(this.heartbeat)
    if (this.tick != null) clearInterval(this.tick)
    await this.link?.close()
    await this.obsA?.disconnect().catch(() => {})
    await this.obsB?.disconnect().catch(() => {})
    await this.display.close()
    this.store.close()
  }
}


/**
 * The scene names an instance has actually mapped.
 *
 * The roles left empty go out: a partial mapping is the normal case — a room with
 * no relay has no `RELAY` — and making a scene named `undefined` exist in a
 * simulated OBS would be worse than passing nothing.
 */
function sceneNames(roles: Partial<Record<string, string>>): string[] {
  return Object.values(roles).filter((name): name is string => name != null && name !== '')
}

/** Real disk access for the sidecars. Injected, so replaceable in a test. */
function nodeRecordingFs() {
  return {
    async rename(from: string, to: string): Promise<void> {
      const { rename } = await import('node:fs/promises')
      await rename(from, to)
    },
    async writeFile(path: string, contents: string): Promise<void> {
      const { writeFile } = await import('node:fs/promises')
      await writeFile(path, contents, 'utf8')
    },
    async exists(path: string): Promise<boolean> {
      const { access } = await import('node:fs/promises')
      return access(path).then(
        () => true,
        () => false,
      )
    },
  }
}
