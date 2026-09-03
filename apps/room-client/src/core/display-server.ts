import Fastify, { type FastifyInstance } from 'fastify'
import fastifyProxy from '@fastify/http-proxy'
import fastifyStatic from '@fastify/static'
import { join } from 'node:path'
import {
  FIELDS_BY_VIEW,
  DEFAULT_EVENT_IDENTITY,
  type DisplayPayload,
  type DisplayView,
} from '@cloudnord/contract'
import { timelinePosition } from '@cloudnord/program/selectors'
import {
  DEFAULT_TIMEZONE,
  openFeedbackUrl,
  sessionsForRoom,
  type Program,
  type Session,
  type SponsorTier,
} from '@cloudnord/program'
import type { AssetCache } from './assets.js'
import type { InputLevel } from './obs.js'
import type { DisplayState, RoomRuntime } from './runtime.js'
import { renderProjectorPage } from './display-page.js'
import { renderOverlayPage } from './overlay-page.js'
import { renderOverlayLivePage } from './overlay-live-page.js'
import {
  developmentAssets,
  productionAssets,
  renderControlShell,
  resolveControlBundle,
} from './control-shell.js'
import {
  controlActionSchema,
  runControlAction,
  type ControlDiagnostics,
  type ControlTarget,
} from './control-api.js'
import { hostMonitor, type HostLoad } from './host.js'

export { FIELDS_BY_VIEW, type DisplayPayload, type DisplayView }

/**
 * A subscriber to the stream: its view, and the last value it received per field.
 *
 * The HTTP routes below and their query parameters (`vue`, `salle`, `duree`,
 * `file`) are a contract with the control app: they do not get renamed.
 */
interface StreamSubscriber {
  view: DisplayView | null
  last: Record<string, string>
  write: (event: string | null, body: string) => void
}

export interface DisplayServerOptions {
  runtime: RoomRuntime
  assets: AssetCache
  /** The current program, already cached locally — read back on every request to follow the resyncs. */
  program: () => { contentHash: string; program: Program } | null
  /** The room's display name, from the configuration received from the hub. */
  roomName?: () => string | null
  /** The room's configuration, for the OpenFeedback project. Read back on every send. */
  roomConfig?: () => { openFeedbackProjectId: string | null } | null
  /** The hub's public origin, to build the wall URL shown as a QR code. */
  hubOrigin?: string
  /**
   * The control app's Vite server, in development only.
   *
   * When filled in, the machine proxies Vite under `/regie/` and the shell points
   * at it: hot reloading works without the page having to leave its origin.
   * Absent — the case of every installed machine — it is the built bundle that is
   * served, and nothing else is possible.
   */
  viteOrigin?: string | null
  /**
   * Where to find the rebuilt control app's bundle.
   *
   * Injectable, and not out of a taste for injection: `resolveControlBundle()`
   * walks up the folders until it hits a `dist/`, so a test passed or not
   * depending on whether a build was lying around on the machine. The hub fell
   * into the same trap with the console, and the defect only shows in CI, once.
   */
  controlBundle?: () => { directory: string; manifest: string } | null
  /** The target of the control actions. Absent, the interface stays read-only. */
  control?: ControlTarget
  /** The pairing state, read back on every send. */
  pairing?: () => DisplayPayload['pairing']
  /** The event's accounts, read back from the local cache on every send. */
  socialLinks?: () => DisplayPayload['socialLinks']
  /** The event's identity, read back from the local cache on every send. */
  event?: () => DisplayPayload['eventIdentity']
  /**
   * Reports that a control app is (or is not) watching the audio levels.
   *
   * OBS's VU meter emits some fifty times a second: we only subscribe to it while
   * a page displays it, and detach as soon as it closes. A room nobody is watching
   * the levels of does not pay their price.
   */
  onLevelsRequested?: (active: boolean) => void
  /** The machine's load, read on demand. By default, this machine's. */
  hostLoad?: () => HostLoad
  host?: string
  port?: number
}

/**
 * The local server that serves the room screen.
 *
 * The same URL feeds OBS-A's Browser Source **and** a full-screen Electron
 * fallback window: if OBS crashes, the operator switches to the native window and
 * the projection carries on.
 */
export class DisplayServer {
  private readonly app: FastifyInstance
  private readonly clients = new Set<StreamSubscriber>()
  private readonly levelSubscribers = new Set<(body: string) => void>()
  /**
   * The wall's QR code, computed once per room.
   *
   * Regenerating it on every state send would cost one render per second for an
   * image that never changes.
   */
  private wallCache: { url: string; qrSvg: string } | null = null
  private wallCacheKey: string | null = null
  /** The same reason for the OpenFeedback QR code, which changes with every talk. */
  private feedbackCache: { url: string; qrSvg: string } | null = null
  private feedbackCacheKey: string | null = null
  private readonly onStateChange: () => void
  /**
   * The machine's load reading.
   *
   * Created here, and not on every request: the measurement is a **difference**
   * between two reads of the kernel's counters, so it only exists if somebody
   * keeps the previous mark.
   */
  private readonly hostLoad: () => HostLoad

  constructor(private readonly options: DisplayServerOptions) {
    this.hostLoad = options.hostLoad ?? hostMonitor()
    this.app = Fastify({ logger: false })
    this.registerRoutes()
    // Rebroadcasts on every state change: the screen never polls.
    this.onStateChange = () => this.broadcast()
    options.runtime.on('state', this.onStateChange)
  }

  private payload(): DisplayPayload {
    const cached = this.options.program()
    const state = this.options.runtime.state()
    const roomName = this.options.roomName?.() ?? null
    const diagnostics = this.options.control?.diagnostics() ?? null
    const wall = this.wallFor(state.roomId)
    const feedback = this.feedbackFor(state.currentSession?.id ?? null)
    const pairing = this.options.pairing?.() ?? null
    const socialLinks = this.options.socialLinks?.() ?? []
    const eventIdentity = this.options.event?.() ?? DEFAULT_EVENT_IDENTITY
    if (cached == null) {
      return {
        state,
        roomName,
        event: null,
        timezone: DEFAULT_TIMEZONE,
        sessions: [],
        sponsorTiers: [],
        diagnostics,
        wall,
        feedback,
        pairing,
        otherRooms: [],
        socialLinks,
        eventIdentity,
      }
    }

    // The URLs are rewritten towards the local cache: the page must never depend
    // on the Internet during the event.
    const program = this.options.assets.localize(cached.program)
    return {
      state,
      roomName,
      event: program.event,
      timezone: program.timezone,
      sessions: state.roomId == null ? [] : sessionsForRoom(program, state.roomId),
      sponsorTiers: program.sponsorTiers,
      diagnostics,
      wall,
      feedback,
      pairing,
      otherRooms: this.otherRooms(program, state.roomId),
      socialLinks,
      eventIdentity,
    }
  }

  /**
   * What is going on, or about to go on, in the other rooms.
   *
   * Computed on the cached program and the hub's corrected clock — never on the
   * machine's time, which can be weeks away when the hub runs on a simulated
   * clock. The breaks are discarded: "Lunch in Track #2" helps nobody choose where
   * to go.
   */
  private otherRooms(program: Program, roomId: string | null): DisplayPayload['otherRooms'] {
    const at = this.options.runtime.correctedNow()
    return program.rooms
      .filter((room) => room.id !== roomId)
      .map((room) => {
        /**
         * The position is computed on **all** the slots, breaks included, and we
         * keep only the talks afterwards.
         *
         * The order matters: a slot's end is derived from the next one's start when
         * the export does not give it, and searching directly in a filtered list
         * skipped the break that closes it. A talk with no end time then stayed
         * "running" on the neighbouring screen until the end of the day.
         */
        const slots = sessionsForRoom(program, room.id)
        const { current } = timelinePosition(slots, at)
        // The breaks are discarded here: "Lunch in Track #2" helps nobody choose
        // where to go.
        const runningTalk = current?.kind === 'talk' ? current : null
        const session =
          runningTalk ?? slots.find((c) => c.kind === 'talk' && c.startsAtMs > at) ?? null
        return {
          roomId: room.id,
          name: room.name,
          session:
            session == null
              ? null
              : {
                  id: session.id,
                  title: session.title,
                  startsAt: session.startsAt,
                  speakers: session.speakers.map((person) => person.name),
                },
          running: session != null && session === runningTalk,
        }
      })
  }

  /**
   * The running talk's OpenFeedback QR code.
   *
   * No request: the address is built from the already cached program — see
   * `openFeedbackUrl`, shared with the hub so that the link displayed in the
   * console and the QR code projected cannot diverge. The QR code is therefore
   * drawn even with the network cut, which is exactly the moment one does not want
   * a missing image on the screen.
   */
  private feedbackFor(sessionId: string | null): { url: string; qrSvg: string } | null {
    const config = this.options.roomConfig?.() ?? null
    const project = config?.openFeedbackProjectId ?? null
    if (project == null || sessionId == null) return null
    if (this.feedbackCacheKey === sessionId && this.feedbackCache != null) return this.feedbackCache

    const cached = this.options.program()
    const session = cached?.program.sessions.find((slot) => slot.id === sessionId) ?? null
    if (session == null) return null
    const url = openFeedbackUrl(session, project, cached?.program.timezone ?? DEFAULT_TIMEZONE)
    if (url == null) return null

    this.feedbackCacheKey = sessionId
    this.feedbackCache = { url, qrSvg: this.feedbackQr.get(sessionId) ?? '' }
    void this.prepareFeedbackQr(sessionId, url)
    return this.feedbackCache
  }

  /** A QR code drawn in the background: the next state send will carry it. */
  private async prepareFeedbackQr(sessionId: string, url: string): Promise<void> {
    if (this.feedbackQr.has(sessionId)) return
    this.feedbackQr.set(sessionId, '')
    const { toString } = await import('qrcode')
    const svg = await toString(url, {
      type: 'svg',
      margin: 1,
      errorCorrectionLevel: 'H',
      color: { dark: '#0d0f16', light: '#ffffff' },
    })
    this.feedbackQr.set(sessionId, svg)
    this.feedbackCacheKey = null
    this.broadcast()
  }

  /** Prepares (once) the wall's URL and its QR code for the current room. */
  private wallFor(roomId: string | null): { url: string; qrSvg: string } | null {
    const origin = this.options.hubOrigin
    if (origin == null || roomId == null) return null
    if (this.wallCacheKey === roomId && this.wallCache != null) return this.wallCache

    const url = `${origin.replace(/\/$/, '')}/mur?salle=${encodeURIComponent(roomId)}`
    this.wallCacheKey = roomId
    this.wallCache = { url, qrSvg: this.pendingQr.get(roomId) ?? '' }
    return this.wallCache
  }

  /** QR codes rendered ahead of time: the generation is synchronous but not free. */
  private readonly pendingQr = new Map<string, string>()
  /** The OpenFeedback QR codes already drawn, per talk. */
  private readonly feedbackQr = new Map<string, string>()

  /**
   * Pre-generates a room's QR code.
   *
   * Called at sync time: at that moment the room is known, and the screen can then
   * display the wall with no latency.
   */
  async prepareWallQr(roomId: string, url: string): Promise<void> {
    const { toString } = await import('qrcode')
    const svg = await toString(url, {
      type: 'svg',
      margin: 1,
      // A high correction level: the QR code is photographed from afar, sometimes
      // at an angle, often on a low-contrast video projector.
      errorCorrectionLevel: 'H',
      color: { dark: '#0d0f16', light: '#ffffff' },
    })
    this.pendingQr.set(roomId, svg)
    this.wallCacheKey = null
    this.broadcast()
  }

  /**
   * Serializes the state once, field by field.
   *
   * Cutting it at this level makes it possible to compare and to send only what
   * moves, without serializing twice: the strings produced here are the ones that
   * go out on the wire.
   */
  private serializedFields(): Record<string, string> {
    const payload = this.payload() as unknown as Record<string, unknown>
    const output: Record<string, string> = {}
    for (const [key, value] of Object.entries(payload)) output[key] = JSON.stringify(value ?? null)
    return output
  }

  /** Assembles a JSON object from already serialized fields. */
  private static assemble(fields: Record<string, string>, keys: readonly string[]): string {
    return `{${keys.map((key) => `${JSON.stringify(key)}:${fields[key] ?? 'null'}`).join(',')}}`
  }

  /** The fields visible to a view, in the payload's order. */
  private static viewKeys(fields: Record<string, string>, view: DisplayView | null): string[] {
    const keys = Object.keys(fields)
    if (view == null) return keys
    const allowed = new Set<string>(FIELDS_BY_VIEW[view] as readonly string[])
    return keys.filter((key) => allowed.has(key))
  }

  /**
   * Rebroadcasts what changed, to those it concerns.
   *
   * Two intended properties: a subscriber nothing has moved for receives
   * **nothing** (the room's clock tick must generate no traffic), and a subscriber
   * never receives a field it does not read.
   */
  /**
   * Broadcasts the audio levels.
   *
   * Deliberately outside the state stream: at 10 sends a second, passing them
   * through the complete payload would republish the whole state — the program
   * included — a hundred times more often than necessary.
   */
  publishLevels(inputs: InputLevel[]): void {
    if (this.levelSubscribers.size === 0) return
    const body = JSON.stringify({ inputs })
    for (const write of this.levelSubscribers) write(body)
  }

  private broadcast(): void {
    const fields = this.serializedFields()
    for (const subscriber of this.clients) {
      const keys = DisplayServer.viewKeys(fields, subscriber.view)
      const changed = keys.filter((key) => subscriber.last[key] !== fields[key])
      if (changed.length === 0) continue
      for (const key of changed) subscriber.last[key] = fields[key] ?? 'null'
      subscriber.write('delta', DisplayServer.assemble(fields, changed))
    }
  }

  /**
   * The operator's window.
   *
   * A bundle, and no longer a single-piece template: the page drives OBS while a
   * room is full, and three thousand lines of strings were no longer readable. The
   * machine always renders the shell itself, with the complete state inside — see
   * `control-shell.ts`.
   */
  private registerControl(): void {
    const bundle = (this.options.controlBundle ?? resolveControlBundle)()
    const vite = this.options.viteOrigin ?? null

    /*
     * Vite comes before the bundle, and not the other way round.
     *
     * The opposite order seemed more cautious — an installed machine has no Vite,
     * a stray variable must not divert it. It in fact made development impossible:
     * `pnpm test` builds the bundle, and a three-day-old `dist/` then took
     * precedence over the running server. One developed on a compiled control app,
     * with no hot reloading, and the Vue extension refused to inspect a page it saw
     * in production mode.
     *
     * A `dist/` is an artifact; a Vite origin is an intent. It is the intent that
     * wins.
     */
    if (vite == null && bundle != null) {
      void this.app.register(fastifyStatic, {
        root: join(bundle.directory, 'assets'),
        prefix: '/regie/assets/',
        wildcard: false,
        immutable: true,
        maxAge: '1y',
        decorateReply: false,
      })
    }

    // Development: Vite behind the machine, never in front. The machine carries the
    // state stream, the actions and the VU meter; routing them through Vite for the
    // sole comfort of hot reloading would be paying dearly.
    if (vite != null) {
      void this.app.register(fastifyProxy, {
        upstream: vite,
        prefix: '/regie/',
        rewritePrefix: '/regie/',
        websocket: true,
        httpMethods: ['GET'],
        preHandler: (request, reply, done) => {
          // The shell is rendered here: the proxy only takes what Vite knows how to
          // render, and above all not the address that carries the embedded state.
          if ((request.url.split('?')[0] ?? '') === '/regie') return reply.callNotFound()
          done()
        },
      })
    }

    this.app.get('/regie', async (_request, reply) => {
      reply.header('content-type', 'text/html; charset=utf-8')
      // Never `immutable` on the shell: it carries the room's state, which changes
      // every second of the day.
      reply.header('cache-control', 'no-store')

      if (vite == null && bundle == null) {
        /*
         * The bundle is missing, and no Vite is announced.
         *
         * It is not an operational state: the packaging embeds the bundle. Saying so
         * in full beats a 404, which would send one looking at the address.
         */
        reply.status(503)
        return reply.send(
          'Régie non construite. Depuis les sources : ' +
            'pnpm --filter @cloudnord/control-web build',
        )
      }

      return reply.send(
        renderControlShell({
          initialPayload: this.payload(),
          eventName: this.options.event?.().name ?? null,
          assets: vite != null ? developmentAssets() : productionAssets(bundle!.manifest),
        }),
      )
    })
  }

  private registerRoutes(): void {
    this.app.get('/health', async () => ({ ok: true }))

    this.app.get('/display/projector', async (_request, reply) => {
      reply.header('content-type', 'text/html; charset=utf-8')
      // The state is embedded: no blank screen when the Browser Source reloads.
      return reply.send(renderProjectorPage({ initialPayload: this.payload() }))
    })

    /**
     * The live banner: one more source, placed wherever a message should appear —
     * including in OBS-A's LIVE scene, over the slides.
     */
    this.app.get('/display/overlay-live', async (_request, reply) => {
      reply.header('content-type', 'text/html; charset=utf-8')
      return reply.send(renderOverlayLivePage({ initialPayload: this.payload() }))
    })

    this.app.get('/display/overlay', async (_request, reply) => {
      reply.header('content-type', 'text/html; charset=utf-8')
      return reply.send(renderOverlayPage({ initialPayload: this.payload() }))
    })

    this.registerControl()

    /**
     * Control actions.
     *
     * Validated before reaching OBS, and never propagated as an exception: a
     * failure comes back to the operator as a message, not as a broken page in the
     * middle of an intervention.
     */
    this.app.post('/control/action', async (request, reply) => {
      if (this.options.control == null) {
        return reply.status(503).send({ ok: false, message: 'Régie indisponible' })
      }
      const parsed = controlActionSchema.safeParse(request.body)
      if (!parsed.success) {
        return reply.status(400).send({ ok: false, message: 'Action inconnue ou mal formée' })
      }
      const outcome = await runControlAction(this.options.control, parsed.data)
      // The state may have changed: we push again immediately rather than waiting a
      // tick.
      this.broadcast()
      return reply.status(outcome.ok ? 200 : 409).send(outcome)
    })

    /**
     * The rushes produced, on demand.
     *
     * Outside the state stream, and for the same reason as the other rooms'
     * program: reading the captures folder on every tick would cost one disk access
     * a second for a list one opens three times a day. Nothing is probed here —
     * opening the modal must not launch a series of ffprobes while a talk is
     * running.
     */
    this.app.get('/control/recordings', async (_request, reply) => {
      if (this.options.control == null) {
        return reply.status(503).send({ ok: false, message: 'Régie indisponible' })
      }
      try {
        return { ok: true, ...(await this.options.control.listRecordings()) }
      } catch (cause) {
        return reply
          .status(200)
          .send({ ok: false, root: null, entries: [], message: (cause as Error).message })
      }
    })

    /**
     * A rush's preview, produced on the fly.
     *
     * Twenty seconds repackaged into fragmented MP4, and never the whole file:
     * OBS's rushes are Matroska, which no browser knows how to open, and they weigh
     * several gigabytes. The excerpt answers the only question one asks in front of
     * the list — "is there a picture and some sound?" — without writing anything to
     * disk or waiting for a download.
     */
    this.app.get<{ Querystring: { file?: string; at?: string; duration?: string } }>(
      '/control/recordings/excerpt',
      async (request, reply) => {
        if (this.options.control == null) {
          return reply.status(503).send({ ok: false, message: 'Régie indisponible' })
        }
        const file = request.query.file
        if (file == null || file.length === 0) {
          return reply.status(400).send({ ok: false, message: 'Fichier non précisé' })
        }

        let excerpt: Awaited<ReturnType<ControlTarget['readRecordingExtract']>>
        try {
          excerpt = await this.options.control.readRecordingExtract(
            file,
            Number(request.query.at ?? 0) || 0,
            Number(request.query.duration ?? 20_000) || 20_000,
          )
        } catch (cause) {
          return reply.status(409).send({ ok: false, message: (cause as Error).message })
        }
        if (excerpt == null) {
          return reply.status(503).send({ ok: false, message: 'ffmpeg introuvable sur cette machine' })
        }

        // The stream is written as the encoding goes: neither a known length nor a
        // possible range. The player takes it as a live stream, which it is.
        reply.header('content-type', 'video/mp4')
        reply.header('accept-ranges', 'none')
        reply.header('cache-control', 'no-store')
        // Closing the modal must not leave an ffmpeg running on the machine that is
        // recording the next talk.
        request.raw.on('close', () => excerpt.stop())
        return reply.send(excerpt.stream)
      },
    )

    /**
     * The rush as it is, by range.
     *
     * To open it in a player that knows how to read Matroska, or to fetch it onto
     * another machine — which a twenty-second preview will never replace.
     */
    this.app.get<{ Querystring: { file?: string } }>(
      '/control/recordings/file',
      async (request, reply) => {
        if (this.options.control == null) {
          return reply.status(503).send({ ok: false, message: 'Régie indisponible' })
        }
        const file = request.query.file
        if (file == null || file.length === 0) {
          return reply.status(400).send({ ok: false, message: 'Fichier non précisé' })
        }

        let stream: Awaited<ReturnType<ControlTarget['readRecordingFile']>>
        try {
          stream = await this.options.control.readRecordingFile(file, request.headers.range ?? null)
        } catch (cause) {
          return reply.status(409).send({ ok: false, message: (cause as Error).message })
        }
        if (stream == null) return reply.status(404).send({ ok: false, message: 'Fichier absent du disque' })

        const partial = stream.start > 0 || stream.end < stream.size - 1
        reply.header('content-type', stream.type)
        reply.header('accept-ranges', 'bytes')
        reply.header('content-length', String(stream.end - stream.start + 1))
        if (partial) {
          reply.header('content-range', `bytes ${stream.start}-${stream.end}/${stream.size}`)
          reply.status(206)
        }
        request.raw.on('close', () => stream.stream.destroy())
        return reply.send(stream.stream)
      },
    )

    /**
     * Another room's program, on demand.
     *
     * Deliberately outside the state stream: embedding the event's 27 sessions in
     * every SSE send would cost on every screen change, for data the control app
     * only consults when a tab is opened.
     */
    this.app.get<{ Querystring: { salle?: string } }>('/display/sessions', async (request, reply) => {
      const cached = this.options.program()
      if (cached == null) return { rooms: [], sessions: [], roomId: null }

      const program = this.options.assets.localize(cached.program)
      const roomId = request.query.salle ?? null
      if (roomId != null && !program.rooms.some((room) => room.id === roomId)) {
        return reply.status(404).send({ error: 'salle inconnue au programme' })
      }
      return {
        roomId,
        rooms: program.rooms.map((room) => ({ id: room.id, name: room.name })),
        sessions: roomId == null ? [] : sessionsForRoom(program, roomId),
      }
    })

    /**
     * The machine's load, on demand.
     *
     * Outside the state stream, and that is the point: a figure that moves every
     * second placed in the payload would republish the whole diagnostic — rooms,
     * log, configuration — on every tick, whereas an idle room must generate no
     * traffic. Here, only an open control app asks, and it asks for a three-field
     * answer.
     */
    this.app.get('/control/host', async () => this.hostLoad())

    /**
     * The uploads in progress, and why nothing is leaving.
     *
     * Outside the state stream for the same reason as the machine's load: a
     * percentage that advances would republish the whole diagnostic on every part.
     * The recordings modal polls it while it is open, and nobody pays anything when
     * it is closed.
     */
    this.app.get('/control/uploads', async (_request, reply) => {
      if (this.options.control?.vodUploads == null) {
        return reply.status(503).send({ ok: false, message: 'Régie indisponible' })
      }
      return { ok: true, ...this.options.control.vodUploads() }
    })

    this.app.get('/display/data', async () => this.payload())

    /**
     * The state stream in SSE, and not in WebSocket.
     *
     * The browser reconnects an `EventSource` by itself, with no line of code on
     * the page side. For the video projector's screen — the one that must never
     * stay frozen and that has no build step — that is exactly the property we
     * want. The stream is one-way anyway.
     */
    this.app.get<{ Querystring: { vue?: string } }>('/display/state', (request, reply) => {
      reply.raw.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
      })

      const requested = (request.query as { vue?: string } | undefined)?.vue
      const view: DisplayView | null =
        requested === 'projecteur' || requested === 'overlay' || requested === 'bandeau' || requested === 'regie'
          ? requested
          : null

      const write = (event: string | null, body: string): void => {
        reply.raw.write(`${event == null ? '' : `event: ${event}\n`}data: ${body}\n\n`)
      }

      // A complete snapshot on opening: it is also what repairs the page after an
      // `EventSource` reconnection, with no resume logic to write.
      const fields = this.serializedFields()
      const keys = DisplayServer.viewKeys(fields, view)
      const subscriber: StreamSubscriber = { view, last: {}, write }
      for (const key of keys) subscriber.last[key] = fields[key] ?? 'null'
      write(null, DisplayServer.assemble(fields, keys))
      this.clients.add(subscriber)

      // A regular heartbeat: keeps the connection open through the proxies and
      // reveals a dead page rather than leaving it frozen in silence. It is now an
      // idle room's only traffic.
      const heartbeat = setInterval(() => reply.raw.write(': ping\n\n'), 10_000)

      request.raw.on('close', () => {
        clearInterval(heartbeat)
        this.clients.delete(subscriber)
      })
    })

    /**
     * The audio levels, in a separate stream.
     *
     * Separate for two reasons: the cadence (10 Hz against a few messages an hour
     * for the state), and the fact that only the control app uses them. Closing the
     * page is enough to cut the subscription at OBS.
     */
    this.app.get('/display/audio', (request, reply) => {
      reply.raw.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
      })

      const write = (body: string): void => {
        reply.raw.write(`data: ${body}\n\n`)
      }

      // An immediate first byte: without it, the headers do not leave and the
      // stream only opens on the page side at the first measurement — so never if
      // the room is silent or if OBS is not there yet.
      reply.raw.write(': flux ouvert\n\n')

      const first = this.levelSubscribers.size === 0
      this.levelSubscribers.add(write)
      if (first) this.options.onLevelsRequested?.(true)

      const heartbeat = setInterval(() => reply.raw.write(': ping\n\n'), 10_000)

      request.raw.on('close', () => {
        clearInterval(heartbeat)
        this.levelSubscribers.delete(write)
        if (this.levelSubscribers.size === 0) this.options.onLevelsRequested?.(false)
      })
    })

    this.app.get<{ Params: { sha256: string } }>('/assets/:sha256', async (request, reply) => {
      const asset = await this.options.assets.read(request.params.sha256)
      if (asset == null) return reply.status(404).send({ error: 'asset absent du cache' })
      reply.header('content-type', asset.contentType ?? 'application/octet-stream')
      // Content-addressed: never rewritten, so cacheable indefinitely.
      reply.header('cache-control', 'public, max-age=31536000, immutable')
      return reply.send(asset.bytes)
    })
  }

  async listen(): Promise<string> {
    const host = this.options.host ?? '127.0.0.1'
    await this.app.listen({ host, port: this.options.port ?? 7788 })
    const address = this.app.server.address()
    const port = typeof address === 'object' && address != null ? address.port : 0
    return `http://${host}:${port}`
  }

  async close(): Promise<void> {
    // Unsubscribe first: without that, one last state change triggers a read of the
    // program on an already closed database.
    this.options.runtime.off('state', this.onStateChange)
    this.clients.clear()
    await this.app.close()
  }
}
