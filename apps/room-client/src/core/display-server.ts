import Fastify, { type FastifyInstance } from 'fastify'
import fastifyProxy from '@fastify/http-proxy'
import fastifyStatic from '@fastify/static'
import { join } from 'node:path'
import {
  FIELDS_BY_VIEW,
  MERGED_FIELDS,
  DEFAULT_EVENT_IDENTITY,
  type Boucle,
  type BoucleView,
  type DisplayPayload,
  type DisplayView,
} from '@conference-operator/contract'
import {
  agendaForRoom,
  DEFAULT_TIMEZONE,
  openFeedbackUrl,
  sessionsForRoom,
  type Program,
  type Session,
  type SponsorTier,
} from '@conference-operator/program'
import type { AssetCache } from './assets.js'
import type { InputLevel } from './obs.js'
import type { DisplayState, RoomRuntime } from './runtime.js'
import { renderProjectorPage } from './display-page.js'
import { boucleQrUrls, buildBoucleView } from './boucle-view.js'
import { otherRoomsFor } from '@conference-operator/projector/server'
import { availableFonts, readFont, resolveFontsFolder } from './fonts.js'
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
  /**
   * Asked with `partiel=1`: receives `patch` messages, where `state` and
   * `diagnostics` travel sub-field by sub-field. Without it, the historical
   * `delta` — a page opened before an update keeps its own JavaScript, and must
   * keep understanding the stream after the reconnection.
   */
  partial: boolean
  last: Record<string, string>
  /** The last sub-fields sent, per merged field. */
  lastParts: Record<string, Record<string, string>>
  write: (event: string | null, body: string) => void
}

/** The state serialized once: whole fields, and the merged fields' sub-fields. */
interface SerializedState {
  fields: Record<string, string>
  parts: Record<string, Record<string, string>>
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
  /**
   * What the hub leaves available, read back from the cache on every send.
   *
   * Absent — a test, a preview — every screen is offered and there is no social
   * wall: the permissive fallback is the one that does not silently remove a
   * button from an operator's console.
   */
  screens?: () => { wallsIoUrl: string | null; disabled: DisplayPayload['screensDisabled'] }
  /** The event's identity, read back from the local cache on every send. */
  event?: () => DisplayPayload['eventIdentity']
  /**
   * The welcome loop's settings, read back from the local cache.
   *
   * Absent — a test, a preview — no loop content is built and the page plays the
   * scenes the program alone can fill.
   */
  boucle?: () => Boucle
  /** Does walls.io answer right now? Absent = assumed reachable. */
  wallsIoReachable?: () => boolean
  /** Where the loop's typefaces are. Absent = searched from this file. */
  fontsFolder?: string | null
  /** The machine's version, handed to the control app. */
  version?: string | null
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
   * How to hang up on each open stream, one entry per connected page.
   *
   * Without it, `close()` never returned. The two SSE routes write on `reply.raw`
   * and **never end the response** — that is what a stream is — so `app.close()`
   * waited on sockets nobody was ever going to close: the projection, the control
   * app and the two overlays, that is to say every page of a working room. The
   * room then stayed in the background, holding its port, and the next launch
   * found it taken.
   *
   * The ping timers are in here too, and they are the other half of the leak: a
   * `setInterval` per page, cleared only when the page disconnects. Kept alive,
   * they hold the Node event loop open on their own — a process that will not
   * quit even once the sockets are gone.
   */
  private readonly openStreams = new Set<() => void>()
  /**
   * Set when the wanted port was taken and the next free one was used.
   *
   * Kept on the server because it is the only thing that knows: the port is
   * settled at `listen()`, long after the state and its runtime were built.
   */
  private portFallbackState: { wanted: number; actual: number } | null = null
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

  private readonly fontsFolder: string | null

  constructor(private readonly options: DisplayServerOptions) {
    this.hostLoad = options.hostLoad ?? hostMonitor()
    this.fontsFolder = options.fontsFolder !== undefined ? options.fontsFolder : resolveFontsFolder()
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
    const screens = this.options.screens?.() ?? { wallsIoUrl: null, disabled: [] }
    const eventIdentity = this.options.event?.() ?? DEFAULT_EVENT_IDENTITY
    const boucle = this.boucleFor(cached, screens.wallsIoUrl, eventIdentity.shortName)
    const wallsIoReachable = this.options.wallsIoReachable?.() ?? true
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
        wallsIoUrl: screens.wallsIoUrl,
        screensDisabled: screens.disabled,
        boucle,
        agenda: [],
        wallsIoReachable,
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
      wallsIoUrl: screens.wallsIoUrl,
      screensDisabled: screens.disabled,
      boucle,
      agenda: state.roomId == null
        ? []
        : agendaForRoom(program, state.roomId, {
            plenaries: boucle?.agenda.plenieres ?? true,
            nowMs: this.options.runtime.correctedNow(),
          }),
      wallsIoReachable,
      eventIdentity,
    }
  }

  /**
   * The loop's content, rebuilt only when what it is made of changed.
   *
   * `payload()` runs on every state change — every second while a talk runs — and
   * resolving the loop reads the image cache once per logo. The key is what the
   * view is made of; `refreshBoucle()` drops it when the cache itself moved.
   */
  private boucleFor(
    cached: { contentHash: string; program: Program } | null,
    wallsIoUrl: string | null,
    shortName: string,
  ): BoucleView | null {
    const settings = this.options.boucle?.()
    if (settings == null) return null
    const project = this.options.roomConfig?.()?.openFeedbackProjectId ?? null
    const key = JSON.stringify([settings, cached?.contentHash ?? null, project, wallsIoUrl, shortName, this.qrGeneration])
    if (key === this.boucleKey && this.boucleCache != null) return this.boucleCache
    this.boucleKey = key
    this.boucleCache = buildBoucleView({
      boucle: settings,
      program: cached?.program ?? null,
      openFeedbackProjectId: project,
      wallsIoUrl,
      eventShortName: shortName,
      localize: (ref) => this.options.assets.localizeRef(ref),
      qr: (url) => this.qrFor(url),
    })
    return this.boucleCache
  }

  private boucleCache: BoucleView | null = null
  private boucleKey: string | null = null
  /** QR codes drawn for the loop, by address; `''` while being drawn. */
  private readonly loopQr = new Map<string, string>()
  private qrGeneration = 0

  /** A loop QR code, drawn in the background the first time it is asked for. */
  private qrFor(url: string): string | null {
    const svg = this.loopQr.get(url)
    if (svg != null) return svg === '' ? null : svg
    this.loopQr.set(url, '')
    void import('qrcode')
      .then(({ toString }) =>
        toString(url, { type: 'svg', margin: 1, errorCorrectionLevel: 'H', color: { dark: '#0d0f16', light: '#ffffff' } }),
      )
      .then((drawn) => {
        this.loopQr.set(url, drawn)
        this.qrGeneration += 1
        this.broadcast()
      })
      .catch(() => this.loopQr.delete(url))
    return null
  }

  /**
   * The loop's images or settings moved outside a state change — a prefetch that
   * just finished: rebuild its content and send it.
   */
  refreshBoucle(): void {
    this.boucleKey = null
    const settings = this.options.boucle?.()
    if (settings != null) {
      for (const url of boucleQrUrls(settings, this.options.roomConfig?.()?.openFeedbackProjectId ?? null)) this.qrFor(url)
    }
    this.broadcast()
  }

  /** What is going on, or about to go on, in the other rooms — see `otherRoomsFor`. */
  private otherRooms(program: Program, roomId: string | null): DisplayPayload['otherRooms'] {
    return otherRoomsFor(program, roomId, this.options.runtime.correctedNow())
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
  private serializedFields(): SerializedState {
    const payload = this.payload() as unknown as Record<string, unknown>
    const fields: Record<string, string> = {}
    const parts: Record<string, Record<string, string>> = {}
    for (const [key, value] of Object.entries(payload)) {
      if ((MERGED_FIELDS as readonly string[]).includes(key) && value != null && typeof value === 'object') {
        // Cut one level lower, and the whole field rebuilt from its pieces: still
        // a single serialization, and the same string as `JSON.stringify`.
        const part: Record<string, string> = {}
        for (const [sub, subValue] of Object.entries(value)) {
          if (subValue !== undefined) part[sub] = JSON.stringify(subValue)
        }
        parts[key] = part
        fields[key] = DisplayServer.assemble(part, Object.keys(part))
      } else {
        fields[key] = JSON.stringify(value ?? null)
      }
    }
    return { fields, parts }
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

  broadcast(): void {
    const { fields, parts } = this.serializedFields()
    for (const subscriber of this.clients) {
      const keys = DisplayServer.viewKeys(fields, subscriber.view)
      const changed = keys.filter((key) => subscriber.last[key] !== fields[key])
      if (changed.length === 0) continue
      for (const key of changed) subscriber.last[key] = fields[key] ?? 'null'

      if (!subscriber.partial) {
        subscriber.write('delta', DisplayServer.assemble(fields, changed))
        continue
      }

      const set: string[] = []
      const merge: string[] = []
      for (const key of changed) {
        const now = parts[key]
        const before = subscriber.lastParts[key]
        if (now != null && before != null) {
          // A sub-field that disappeared goes out as `null`: the merge cannot delete.
          const moved = [...new Set([...Object.keys(before), ...Object.keys(now)])].filter(
            (sub) => before[sub] !== now[sub],
          )
          merge.push(`${JSON.stringify(key)}:${DisplayServer.assemble(now, moved)}`)
        } else {
          // From or to `null`: nothing to merge over, the field goes out whole.
          set.push(key)
        }
        if (now != null) subscriber.lastParts[key] = now
        else delete subscriber.lastParts[key]
      }
      subscriber.write('patch', `{"set":${DisplayServer.assemble(fields, set)},"merge":{${merge.join(',')}}}`)
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
            'pnpm --filter @conference-operator/control-web build',
        )
      }

      return reply.send(
        renderControlShell({
          initialPayload: this.payload(),
          eventName: this.options.event?.().name ?? null,
          version: this.options.version ?? null,
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
      return reply.send(
        renderProjectorPage({
          initialPayload: this.payload(),
          // Read at every load: a typeface dropped in the folder shows at the
          // next reload of the Browser Source, without restarting the room.
          fonts: { base: '/fonts', files: availableFonts(this.fontsFolder) },
        }),
      )
    })

    /** The loop's typefaces — the allow-list is in `readFont`. */
    this.app.get<{ Params: { file: string } }>('/fonts/:file', async (request, reply) => {
      const font = await readFont(this.fontsFolder, request.params.file)
      if (font == null) return reply.status(404).send({ error: 'police absente' })
      reply.header('content-type', font.type)
      reply.header('cache-control', 'public, max-age=86400')
      return reply.send(font.bytes)
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
    this.app.get<{ Querystring: { vue?: string; partiel?: string } }>('/display/state', (request, reply) => {
      reply.raw.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
      })

      const query = request.query as { vue?: string; partiel?: string } | undefined
      const requested = query?.vue
      const view: DisplayView | null =
        requested === 'projecteur' || requested === 'overlay' || requested === 'bandeau' || requested === 'regie'
          ? requested
          : null

      const write = (event: string | null, body: string): void => {
        reply.raw.write(`${event == null ? '' : `event: ${event}\n`}data: ${body}\n\n`)
      }

      // A complete snapshot on opening: it is also what repairs the page after an
      // `EventSource` reconnection, with no resume logic to write.
      const { fields, parts } = this.serializedFields()
      const keys = DisplayServer.viewKeys(fields, view)
      const subscriber: StreamSubscriber = { view, partial: query?.partiel === '1', last: {}, lastParts: {}, write }
      for (const key of keys) {
        subscriber.last[key] = fields[key] ?? 'null'
        if (parts[key] != null) subscriber.lastParts[key] = parts[key]
      }
      write(null, DisplayServer.assemble(fields, keys))
      this.clients.add(subscriber)

      // A regular heartbeat: keeps the connection open through the proxies and
      // reveals a dead page rather than leaving it frozen in silence. It is now an
      // idle room's only traffic.
      const heartbeat = setInterval(() => reply.raw.write(': ping\n\n'), 10_000)

      const hangUp = (): void => {
        clearInterval(heartbeat)
        this.clients.delete(subscriber)
        this.openStreams.delete(hangUp)
        // Ends the response, which is what `app.close()` is waiting for. Harmless
        // when the page hung up first: the stream is already finished.
        reply.raw.end()
      }
      this.openStreams.add(hangUp)

      request.raw.on('close', hangUp)
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

      /*
       * Called twice, and it has to survive that.
       *
       * `close()` hangs up on the stream, and ending the response makes the socket
       * fire its own `close` — which calls this again. The second pass must be
       * silent: on its own, `size === 0` was true both times, and OBS-B was
       * unsubscribed twice for one page. The removal is therefore what decides —
       * only the pass that really took a subscriber out speaks.
       */
      const hangUp = (): void => {
        clearInterval(heartbeat)
        const removed = this.levelSubscribers.delete(write)
        this.openStreams.delete(hangUp)
        // With no subscriber left, OBS-B must stop sending its VU meter fifty
        // times a second.
        if (removed && this.levelSubscribers.size === 0) this.options.onLevelsRequested?.(false)
        reply.raw.end()
      }
      this.openStreams.add(hangUp)

      request.raw.on('close', hangUp)
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

  /**
   * How far we go looking for a free port. Ten is already a lot.
   *
   * Past that, it is not "a port taken" any more but a machine with something
   * systematically in the way, and walking up to 7888 would only make the room
   * harder to find. The startup then fails as it used to, naming the ports tried.
   */
  private static readonly PORT_ATTEMPTS = 10

  /**
   * Opens the local server, **falling back rather than giving up**.
   *
   * The wanted port can be taken by something that is none of our business — a
   * dev server left over from the day before, another application, a room process
   * that has not finished dying. The room used to stop dead there, on a modal
   * dialog, at the moment of the day when one has the least patience for it.
   *
   * It now takes the next free port and says so. The trade is not free and it is
   * the reason `portFallback` exists: OBS's Browser Sources carry the old port in
   * hard, so a room that has moved serves a projection **nobody is watching** —
   * and that reads exactly like a room that works. The fact is therefore not
   * merely logged, it is carried in the state up to a badge the control app
   * cannot show without saying what to do about it.
   *
   * Only "address taken" is caught. A refused binding — a host that is not ours,
   * a port under 1024 without the rights — is a settings mistake, and retrying it
   * on the next port would turn a clear failure into ten obscure ones.
   */
  async listen(): Promise<string> {
    const host = this.options.host ?? '127.0.0.1'
    const wanted = this.options.port ?? 7788
    const tried: number[] = []

    // Port 0 has nowhere to walk to: the system hands out a free one or there is
    // none, and `0 + 1` would aim at a privileged port for no reason.
    const attempts = wanted === 0 ? 1 : DisplayServer.PORT_ATTEMPTS

    for (let step = 0; step < attempts; step += 1) {
      const port = wanted + step
      tried.push(port)
      try {
        await this.app.listen({ host, port })
      } catch (cause) {
        if ((cause as { code?: string }).code !== 'EADDRINUSE') throw cause
        continue
      }
      const address = this.app.server.address()
      const bound = typeof address === 'object' && address != null ? address.port : port
      /*
       * Recorded only when it really moved: a room on its usual port must carry
       * nothing at all, or the badge would be permanent furniture.
       *
       * Port 0 is excluded, and it is not a detail — it means "any free port", so
       * the port it lands on is the port it asked for. Tests and headless rooms
       * run on it, and counting it as a fallback would have every one of them
       * raise an alarm about a port nobody wanted.
       */
      if (wanted !== 0 && bound !== wanted) this.portFallbackState = { wanted, actual: bound }
      return `http://${host}:${bound}`
    }

    throw new Error(
      `Le serveur local n'a trouvé aucun port libre : ${tried.join(', ')} sont tous occupés.`,
    )
  }

  /** The port the room wanted and the one it got, or `null` if it got its own. */
  portFallback(): { wanted: number; actual: number } | null {
    return this.portFallbackState
  }

  /**
   * Closes the server, **hanging up on the open streams first**.
   *
   * The order is the whole of it. `app.close()` waits for the requests in flight
   * to finish, and an SSE stream never finishes: leaving them open made the close
   * wait forever, on every page of a room that was working. The room survived its
   * own quit, holding its port — and the next launch found it taken.
   *
   * Hanging up is done through the routes' own cleanup, not by destroying sockets
   * from here: it is what clears the ping timers and unsubscribes OBS-B's VU
   * meter. Destroying the socket would have left both behind.
   *
   * `end()` and not `destroy()`: a page that is still there gets a closed stream
   * rather than a severed connection, and `EventSource` reconnects on its own —
   * which is what one wants of a projection when the room is restarted.
   */
  async close(): Promise<void> {
    // Unsubscribe first: without that, one last state change triggers a read of the
    // program on an already closed database.
    this.options.runtime.off('state', this.onStateChange)
    for (const hangUp of [...this.openStreams]) hangUp()
    this.clients.clear()
    this.levelSubscribers.clear()
    await this.app.close()
  }
}
