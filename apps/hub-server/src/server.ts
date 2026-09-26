import Fastify, { type FastifyInstance, type FastifyReply } from 'fastify'
import fastifyProxy from '@fastify/http-proxy'
import fastifyStatic from '@fastify/static'
import { dirname, join } from 'node:path'
import { consolePaths, CONTROL_PATH, controlRoomIdFromPath, type VodHabillage } from '@conference-operator/contract'
import { WebSocketServer, type WebSocket as NodeWebSocket } from 'ws'
import { RPCHandler as FastifyRPCHandler } from '@orpc/server/fastify'
import { RPCHandler as WebSocketRPCHandler } from '@orpc/server/websocket'
import { createAuth, createAuthOptions, migrateAuth, type Auth } from './auth.js'
import { configSchema, durationMs, type ConfigInput } from './config.js'
import { openHubDatabase } from './db.js'
import { createSecretBox } from './secrets.js'
import { router } from './router.js'
import type { HubContext, Services } from './context.js'
import { AssetStore } from './services/assets.js'
import { ProgramService } from './services/program.js'
import { AuditService } from './services/audit.js'
import { CommandService } from './services/commands.js'
import { IngestService } from './services/ingest.js'
import { DeviceService, RoomService } from './services/rooms.js'
import { QuestionService, WallService } from './services/wall.js'
import { RateLimiter } from './services/rate-limit.js'
import { ControlService } from './services/control.js'
import { PinService } from './services/pins.js'
import { RoomChanges } from './services/changes.js'
import { SocketTickets } from './services/socket-tickets.js'
import { CONTROL_SESSION_HEADER } from '@conference-operator/contract'
import { SessionStateService, SettingsService } from './services/sessions.js'
import { readFileSync } from 'node:fs'
import { timingSafeEqual } from 'node:crypto'
import { s3Keys, VodService } from './services/vod.js'
import { EventIdentityService } from './services/event-identity.js'
import { mutableClock } from './services/clock.js'
import {
  SocialIngestor,
  blueskySource,
  mastodonSource,
  xSource,
  type SocialSource,
} from './services/social.js'
import { WallsIoConfig, wallsioSource } from './services/wallsio.js'
import { migrateLegacyMur } from './services/legacy-mur.js'
import { renderWallPage } from './pages/wall-page.js'
import { previewPayload, renderBouclePreview } from './pages/boucle-preview.js'
import { buildVodHabillage, readFont, resolveFontsFolder } from '@conference-operator/projector/server'
import { requirePermission, resolveOperator } from './context.js'
import {
  developmentAssets,
  productionAssets,
  renderConsoleShell,
  resolveConsoleBundle,
} from './pages/console-shell.js'
import {
  developmentControlAssets,
  productionControlAssets,
  renderMobileControlShell,
  resolveControlBundle,
} from './pages/control-shell.js'
import { renderServiceWorker } from './pages/service-worker.js'
import { PushService } from './services/push.js'
import { IntegrationService } from './services/integrations.js'
import { MontageService } from './services/montage.js'
import { roomStatuses, SupervisionWatch } from './supervision.js'

export interface Hub {
  app: FastifyInstance
  auth: Auth
  services: Services
  social: SocialIngestor
  close: () => Promise<void>
  /**
   * Last-resort shutdown, **synchronous**.
   *
   * Node's `exit` handlers await no promise: the asynchronous version would not
   * run. Needed because `tsx watch` — so `pnpm dev` — kills the process without
   * letting the graceful shutdown finish, on every Ctrl-C **and on every file
   * save**. Without this safety net, the database is never closed properly.
   */
  closeSync: () => void
}

export async function createHub(input: ConfigInput): Promise<Hub> {
  // Normalized at the entry point: the rest of the hub works on a complete config.
  const config = configSchema.parse(input)
  const { sqlite, orm } = openHubDatabase(config.databasePath)

  const devices = new DeviceService(orm, durationMs(config.deviceCodeTtl))
  const push = new PushService(orm, {
    publicKey: config.vapidPublicKey,
    privateKey: config.vapidPrivateKey,
    subject: config.vapidSubject,
  })
  const settings = new SettingsService(orm)
  const programs = new ProgramService(orm)
  /*
   * The images live beside the database, in the same directory — so on the same
   * volume, wherever the hub is deployed. Until now the image wrote its database
   * and nothing else; this is the one addition, and it is what spares the rooms
   * an outing to the internet.
   */
  const assets = new AssetStore(orm, join(dirname(config.databasePath), 'assets'))
  const clock = mutableClock(config.simulatedTime ?? null)
  const changes = new RoomChanges()
  const touch = (roomId: string | null) => changes.touch(roomId)

  const secretBox = createSecretBox(config.authSecret)
  const audit = new AuditService(orm, () => clock.now())
  const services: Services = {
    audit,
    programs,
    assets,
    // Keyed off the hub's own secret: the stream keys are encrypted at rest
    // with material the deployment already has to hold and already has to
    // keep — one more secret to provision would be one more to lose.
    rooms: new RoomService(orm, secretBox),
    devices,
    commands: new CommandService(orm, () => clock.now()),
    ingest: new IngestService(
      orm,
      touch,
      () => changes.messageArrived(),
      (roomId, outcome) => audit.outcome(roomId, outcome.seq, outcome.ok, outcome.message),
    ),
    wall: new WallService(orm),
    // The token is sealed with the same box as the stream keys. `kick` is bound
    // once the ingestor exists, below.
    wallsIo: { config: new WallsIoConfig(orm, secretBox), kick: async () => undefined },
    // Bound to Fastify's log once the server exists, below.
    log: () => undefined,
    questions: new QuestionService(orm),
    // Five posts in a row then one every ten seconds: enough to post normally,
    // not enough to drown the moderation queue.
    limiter: new RateLimiter({ capacity: 5, refillPerSecond: 0.1 }),
    settings,
    identity: new EventIdentityService(settings, programs),
    sessions: new SessionStateService(orm, settings, () => clock.now(), touch),
    regie: new ControlService(orm, () => clock.now(), touch),
    pins: new PinService(orm, touch),
    changes,
    tickets: new SocketTickets(),
    push,
    integrations: new IntegrationService(orm, {
      publicUrl: config.publicUrl,
      // Read at send time, not frozen here: the name gets corrected during the day.
      eventName: () => services.identity.get().name,
    }),
    // Filled in right after the server is created: the service logs, and its log
    // is Fastify's.
    vod: null,
    // Reads `services.vod` when called: the storage is set up further down.
    montage: new MontageService(
      orm,
      () => services.vod,
      (sessionId) => vodHabillageFor(services, config.publicUrl, sessionId),
      () => new Date(clock.now()),
      (level, message, context) => services.log(level, message, context),
    ),
    clock,
    mode: config.mode,
  }

  const authOptions = createAuthOptions({
    sqlite,
    secret: config.authSecret,
    publicUrl: config.publicUrl,
    onDeviceRequest: (clientId, scope) => devices.recordRequest(clientId, scope),
    isKnownClient: (clientId) => devices.isKnownClient(clientId),
    deviceInterval: config.devicePollInterval,
    deviceCodeExpiresIn: config.deviceCodeTtl,
    google:
      config.googleClientId != null && config.googleClientSecret != null
        ? {
            clientId: config.googleClientId,
            clientSecret: config.googleClientSecret,
            // Guaranteed present by the config's `refine`: Google with no domain
            // does not start, because the domain *is* the list of operators.
            hostedDomain: config.googleHostedDomain!,
          }
        : undefined,
  })
  await migrateAuth(authOptions)
  const auth = createAuth(authOptions)

  // Social ingestion. walls.io is always there and polls only once a token is
  // set in the console; the networks followed by hashtag, only if one is
  // configured. With neither, the wall still works — through the form and the
  // QR code.
  const sources: SocialSource[] = [
    wallsioSource({ config: services.wallsIo.config, onLog: (level, message, context) => services.log(level, message, context) }),
  ]
  if (config.socialHashtag != null) {
    sources.push(blueskySource({ hashtag: config.socialHashtag }))
    if (config.mastodonInstance != null) {
      sources.push(mastodonSource({ instance: config.mastodonInstance, hashtag: config.socialHashtag }))
    }
    if (config.xBearerToken != null) {
      sources.push(xSource({ hashtag: config.socialHashtag, bearerToken: config.xBearerToken }))
    }
  }

  const app = Fastify({ logger: { level: config.logLevel } })

  /*
   * Taking over the OpenFeedback project once entered on a control app.
   *
   * At startup rather than in a SQL migration: the value lives in a room's
   * `config_json`, and digging it out in SQL would mean reasoning in JSON inside
   * a migration, where the service already knows how to read and rewrite a
   * configuration. Idempotent — at the next startup there is nothing left to take
   * over, and nothing is rewritten.
   */
  const openFeedbackTakeover = services.rooms.takeOverOpenFeedbackProject(settings)
  if (openFeedbackTakeover.cleanedRooms.length > 0) {
    app.log.info(
      { adopted: openFeedbackTakeover.adopted, rooms: openFeedbackTakeover.cleanedRooms },
      openFeedbackTakeover.adopted == null
        ? 'projet OpenFeedback : surcharges de salle effacées, le réglage du hub fait foi'
        : 'projet OpenFeedback repris depuis une salle vers les réglages du hub',
    )
  }

  const legacyMur = migrateLegacyMur(orm, settings, services.wall)
  if (legacyMur != null) {
    app.log.info(legacyMur, 'posts de la boucle repris sur le mur social')
  }

  /**
   * Bucket: the environment seeds, the console decides.
   *
   * `S3_BUCKET` only serves the very first startup — the same rule as
   * `PROGRAM_SOURCE_URL`, and for the same reason: a bucket corrected during the
   * event must survive the restart that follows.
   *
   * Seeded **here** and not in `main.ts`, unlike the program: it is just below
   * that the hub announces the storage state, and doing it later would make it
   * say "no bucket configured" at every first startup of an otherwise complete
   * installation. A log that contradicts itself three lines further down stops
   * being read.
   *
   * A corollary worth knowing: clearing the field in the console does not turn
   * the feature off durably, since the next startup would seed it again. To turn
   * it off, it is "Téléverser automatiquement" you uncheck — nothing rewrites
   * that setting.
   */
  if (config.s3Bucket != null && settings.get().vodBucket == null) {
    settings.update({ vodBucket: config.s3Bucket })
  }

  /**
   * `S3_PREFIX`, under the same rule and separately.
   *
   * Separately because the two settings are independent: a bucket already
   * corrected in the console must not keep a prefix from being seeded, and the
   * reverse holds too. Sharing one condition would have tied them together for
   * no reason other than being written on the same line.
   */
  if (config.s3Prefix != null && settings.get().vodPrefix == null) {
    settings.update({ vodPrefix: config.s3Prefix.replace(/^\/+|\/+$/g, '') })
  }

  /**
   * The storage's certificate authority, read once at startup.
   *
   * If unreadable, we say so **as an error** and carry on without it: shipping
   * the rushes back will then fail on a TLS refusal, but the hub starts. It is
   * the same rule as for the VAPID keys, and for the same reason — uploading is
   * an after-event convenience, and a hub that refuses to restart mid-day would
   * cost far more than rushes shipped the next day.
   */
  let caCert: string | null = null
  if (config.s3CaCert != null) {
    try {
      caCert = readFileSync(config.s3CaCert, 'utf8')
    } catch (cause) {
      app.log.error(
        { path: config.s3CaCert, message: (cause as Error).message },
        "S3_CA_CERT illisible : le stockage sera refusé si son certificat n'est pas signé par une CA publique",
      )
    }
  }

  const keys = s3Keys(config, caCert)
  if (keys != null) {
    services.vod = new VodService(
      orm,
      settings,
      keys,
      config.vodAbandonMinutes,
      () => clock.nowIso(),
      (level, message, context) => app.log[level](context ?? {}, message),
    )
  }

  if (config.mode === 'dev') {
    app.log.warn('MODE DÉVELOPPEMENT — heure et horloge réglables, à ne pas laisser le jour J')
  }

  if (clock.simulated) {
    // Deliberately noisy: a simulated clock left on in production would skew the
    // VOD timecodes and the automatic closing.
    app.log.warn({ time: clock.nowIso() }, 'HORLOGE SIMULÉE — développement uniquement')
  }

  /**
   * What the storage is, or is not.
   *
   * Said at startup rather than discovered on the first click: "configured but
   * with no bucket" is the most confusing of the three states — the keys are
   * there, the console shows the panel, and nothing leaves. The log names it.
   */
  if (services.vod == null) {
    app.log.info('rapatriement des rushes : inactif (aucun stockage S3 configuré)')
  } else if (!services.vod.ready()) {
    app.log.warn('rapatriement des rushes : clés S3 présentes, mais aucun bucket réglé (console → VOD)')
  } else {
    app.log.info({ endpoint: config.s3Endpoint }, 'rapatriement des rushes : actif')
  }

  const pushFailure = push.unavailableReason()
  // Deliberately noisy: somebody entered keys that serve no purpose, and silence
  // would send them looking for the fault on the browser side.
  if (pushFailure != null) app.log.error(pushFailure)

  for (const { variable, reason } of config.ignores) {
    // As an error, not a warning: somebody believes they have configured
    // something, and that something does not apply. Staying silent would send
    // them looking elsewhere for hours.
    app.log.error({ variable }, `${variable} ignoré : ${reason}`)
  }

  services.log = (level, message, context) => app.log[level](context ?? {}, message)

  const social = new SocialIngestor(sources, services.wall, {
    intervalMs: config.socialPollIntervalMs,
    onLog: services.log,
    prefetch: (refs) => services.assets.prefetchUrls(refs),
  })
  services.wallsIo.kick = () => social.kick()

  // What the social wall will do, said once at startup: a hub that stays silent
  // about walls.io leaves one wondering whether it reads it at all.
  {
    const followed = sources.map((source) => source.id).filter((id) => id !== 'wallsio')
    const wallsIo = services.wallsIo.config.status(services.wall.countOnScreen('wallsio'))
    app.log.info(
      {
        intervalleS: Math.round(config.socialPollIntervalMs / 1000),
        wallsio: wallsIo.hasToken ? `jeton …${wallsIo.tokenHint}` : 'aucun jeton',
        reseaux: followed,
        postsALecran: services.wall.screen().posts.length,
      },
      wallsIo.hasToken
        ? 'mur social : lecture de walls.io active'
        : 'mur social : walls.io inactif (aucun jeton, console → Réglages)',
    )
  }

  /*
   * The social wall moved: the rooms are told, and fetch it themselves.
   *
   * Grouped over two seconds — a poll that brings ten posts, a moderator hiding
   * three in a row — so that one burst is one notice. The revision alone travels:
   * a notice lost during an outage costs nothing, the room asks again on
   * reconnection. An hour of life, like the other notices a room catching up
   * would otherwise replay by the dozen.
   */
  let wallNotice: NodeJS.Timeout | null = null
  const stopWallNotices = services.wall.onScreenChanged((snapshot) => {
    app.log.info(
      {
        revision: snapshot.revision,
        posts: snapshot.posts.length,
        enAvant: snapshot.posts.filter((post) => post.featured).length,
        walls_io: snapshot.posts.filter((post) => post.source === 'wallsio').length,
      },
      'mur social : nouvelle version',
    )
    if (wallNotice != null) return
    wallNotice = setTimeout(() => {
      wallNotice = null
      const { revision } = services.wall.screen()
      const notice = services.commands.publish(null, { type: 'wall.changed', revision }, 3600)
      app.log.info({ revision, seq: notice.seq }, 'mur social : salles prévenues')
    }, 2_000)
    wallNotice.unref?.()
  })

  // Neither Better Auth nor oRPC wants a body already consumed by Fastify.
  app.removeAllContentTypeParsers()
  app.addContentTypeParser('*', (_request, _payload, done) => done(null))

  /*
   * Accounts and roles, in the audit log.
   *
   * They go through Better Auth's own endpoints, not the router: its guard never
   * sees them. The body is read first — Better Auth would consume the stream — and
   * only for these writes, which are rare and small.
   */
  const auditAuth = async (
    url: URL,
    body: string,
    status: number,
    headers: Record<string, string | string[] | undefined>,
  ) => {
    try {
      const session = await auth.api.getSession({ headers: headersOf(headers) }).catch(() => null)
      let input: unknown = null
      try { input = JSON.parse(body) } catch { /* not JSON: nothing to show */ }
      services.audit.record({
        actor: session?.user.email ?? 'inconnu',
        action: `auth.${url.pathname.replace(/^\/api\/auth\//, '').replaceAll('/', '.')}`,
        roomId: null,
        input,
        ok: status < 400,
        error: status < 400 ? null : `refusé par l'authentification (HTTP ${status})`,
      })
    } catch (cause) {
      app.log.warn({ message: (cause as Error).message }, "journal d'audit : entrée non écrite")
    }
  }

  app.all('/api/auth/*', async (request, reply) => {
    const url = new URL(request.url, config.publicUrl)
    const adminWrite = request.method === 'POST' && url.pathname.startsWith('/api/auth/admin/')
    const body = adminWrite ? await readBody(request.raw) : null
    const response = await auth.handler(
      body == null
        ? toWebRequest(request, config.publicUrl)
        : new Request(url, { method: request.method, headers: headersOf(request.headers), body }),
    )
    if (body != null) await auditAuth(url, body, response.status, request.headers)
    reply.status(response.status)
    response.headers.forEach((value, key) => reply.header(key, value))
    return reply.send(response.body == null ? null : await response.text())
  })

  const rpcHandler = new FastifyRPCHandler(router)
  app.all('/rpc/*', async (request, reply) => {
    const { matched } = await rpcHandler.handle(request, reply, {
      prefix: '/rpc',
      context: contextFrom(auth, services, headersOf(request.headers)),
    })
    if (!matched) await reply.status(404).send({ error: 'procédure inconnue' })
  })

  app.get('/health', async () => ({ ok: true, serverTime: new Date().toISOString() }))

  /**
   * The programme's images, for the rooms.
   *
   * A room computes the hash itself — SHA-256 of the source URL, the key it
   * already uses for its own cache — so nothing has to travel to tell it what to
   * ask for.
   *
   * Public, like `/mur`: these bytes are already public at the source, and the
   * hash is derived from a public URL. Putting the machine token in front would
   * mean carrying that authentication outside oRPC to protect nothing more.
   *
   * `immutable`, because the key is the URL and an upstream export names its
   * images by UUID: this hash will never stand for other bytes. The loop's
   * uploaded images are served here too, keyed by their `hub-image:` reference —
   * which names their content, so the same holds.
   */
  app.get<{ Params: { sha256: string } }>('/assets/:sha256', async (request, reply) => {
    const file = await services.assets.read(request.params.sha256)
    if (file == null) return reply.status(404).send({ error: 'image absente du hub' })

    reply.header('content-type', file.contentType ?? 'application/octet-stream')
    reply.header('cache-control', 'public, max-age=31536000, immutable')
    // An SVG uploaded from the console is served from the console's own origin:
    // opened directly, a script in it would run there. As an `<img>` nothing of
    // this applies, so the screens lose nothing.
    reply.header('content-security-policy', "default-src 'none'; img-src data:; style-src 'unsafe-inline'; sandbox")
    reply.header('x-content-type-options', 'nosniff')
    return reply.send(file.bytes)
  })

  /**
   * Public wall: the page attendees scan.
   *
   * Served by the hub and not by a separate application — it has to be reachable
   * from phones on 4G, exactly where the hub is already exposed.
   */
  app.get<{ Querystring: { salle?: string } }>('/mur', async (request, reply) => {
    reply.header('content-type', 'text/html; charset=utf-8')
    return reply.send(
      renderWallPage({
        roomId: request.query.salle ?? null,
        rooms: services.rooms.list().map((room) => ({ id: room.id, name: room.name })),
        // Injected at render time rather than requested by the page: it is the
        // first word an attendee who has just scanned a QR code reads, and
        // waiting for one more network call would make it appear afterwards.
        event: services.identity.get(),
      }),
    )
  })

  /**
   * The room screen, previewed from the console.
   *
   * The same document a room projects, fed by the hub with what a room would
   * receive at sync (see `renderBouclePreview`): the console's « Boucle » view
   * frames it and reloads it after a save. Behind the operator's session, like
   * the settings it shows — `?salle=` picks the room, `?scene=` holds one scene,
   * `?heure=` (and `?jour=`) draws it at another time than the hub's, and
   * `?salle=global` is the hall's screen: the whole program, no room of its own. With
   * `?cle=` and the key of the public link set in the console, no session is
   * asked: that address is the one shared with the public.
   */
  const fontsFolder = resolveFontsFolder()
  type ApercuQuery = { salle?: string; scene?: string; heure?: string; jour?: string; cle?: string }

  /**
   * May this request see the preview? An operator allowed to read the settings,
   * or anyone with the public link's key — the loop is what the rooms project in
   * front of everyone anyway.
   */
  async function apercuAutorise(request: { query: ApercuQuery; headers: Record<string, string | string[] | undefined> }): Promise<'public' | 'operateur' | null> {
    const publicKey = services.settings.get().boucle.lienPublic
    if (publicKey != null && request.query.cle != null && sameKey(request.query.cle, publicKey)) return 'public'
    try {
      const { operator } = await resolveOperator(contextFrom(auth, services, headersOf(request.headers)))
      requirePermission(operator, 'settings:read')
      return 'operateur'
    } catch {
      return null
    }
  }

  const apercuOptions = (query: ApercuQuery) => {
    const scene = Number.parseInt(query.scene ?? '', 10)
    return {
      roomId: query.salle ?? null,
      scene: Number.isFinite(scene) ? scene : null,
      heure: query.heure ?? null,
      jour: query.jour ?? null,
      fonts: { folder: fontsFolder, base: '/boucle/polices' },
    }
  }

  app.get<{ Querystring: ApercuQuery }>('/boucle/apercu', async (request, reply) => {
    reply.header('content-type', 'text/html; charset=utf-8')
    reply.header('cache-control', 'no-store')
    const acces = await apercuAutorise(request)
    if (acces == null) {
      reply.status(401)
      return reply.send(
        '<!doctype html><html lang="fr"><meta charset="utf-8"><title>Aperçu de la boucle</title>' +
          '<body style="font:18px system-ui;padding:40px">Connectez-vous à la ' +
          '<a href="/admin/boucle">console</a> pour voir l\'aperçu de la boucle.</body></html>',
      )
    }
    if (acces === 'public') reply.header('x-robots-tag', 'noindex')
    /*
     * The page asks for its state again while it stays open — a hall screen, a
     * public link left on a TV. Not at a set time: the clock would jump back to
     * it on every refresh.
     */
    const flux = request.query.heure
      ? null
      : `/boucle/apercu/etat?${new URLSearchParams(
          Object.entries({ salle: request.query.salle, cle: request.query.cle }).filter((entry): entry is [string, string] => entry[1] != null),
        ).toString()}`
    return reply.send(await renderBouclePreview(services, { ...apercuOptions(request.query), flux }))
  })

  /** The preview's state, fetched again by the page every twenty seconds. */
  app.get<{ Querystring: ApercuQuery }>('/boucle/apercu/etat', async (request, reply) => {
    reply.header('cache-control', 'no-store')
    if ((await apercuAutorise(request)) == null) return reply.status(401).send({ error: 'accès refusé' })
    return reply.send(await previewPayload(services, apercuOptions(request.query)))
  })

  /** The loop's typefaces, for the preview — the allow-list is in `readFont`. */
  app.get<{ Params: { file: string } }>('/boucle/polices/:file', async (request, reply) => {
    const font = await readFont(fontsFolder, request.params.file)
    if (font == null) return reply.status(404).send({ error: 'police absente' })
    reply.header('content-type', font.type)
    reply.header('cache-control', 'public, max-age=86400')
    return reply.send(font.bytes)
  })

  /**
   * Operations console: moderation, pairing, program, supervision.
   *
   * One address per tab, all served by the same page: the console picks its view
   * at load time, and refreshing, bookmarking and the Back button all land on
   * their feet. The server has to know them, otherwise a reloaded
   * `/admin/moderation` would answer 404.
   *
   * The views are enumerated, not taken by wildcard: `/admin/*` would serve the
   * console on any typo, which would then open on operations without saying the
   * address does not exist. And `developpement` is only served in dev mode, as it
   * is only rendered in dev mode.
   *
   * `/admin/devices` is added: it is the address Better Auth gives the machine
   * during pairing, with the code as a parameter. The console prefills it, which
   * saves copying it by hand from a control screen at the other end of the room.
   */
  const dev = config.mode === 'dev'
  /**
   * Notifications service worker, served at the root.
   *
   * A service worker's scope is that of its path: served under `/admin/`, it
   * would not cover the rest of the hub. That is also why Vite's server is
   * proxied **behind** this one in development, and never the other way round.
   * With no cache, it only serves to receive the pushed notices when the console
   * is closed.
   */
  app.get('/sw.js', async (_request, reply) => {
    reply.header('content-type', 'text/javascript; charset=utf-8')
    // The browser rechecks the worker on every page load; leaving it in cache
    // would delay any fix by a day of the event.
    reply.header('cache-control', 'no-cache')
    // The event's name is frozen into the worker at the moment it is served: a
    // notice pushed with the console closed has no other source to title itself
    // with, and the browser rechecks the worker on every page load — so a rename
    // follows on the operator's first visit.
    return reply.send(renderServiceWorker({ event: services.identity.get() }))
  })

  const bundle = resolveConsoleBundle()
  /*
   * The console's addresses, all served by the bundle.
   *
   * The list comes from the contract: the hub enumerates it to register its
   * routes and the console's router declares it to navigate. Neither can own it
   * without forcing the other to depend on it — making the hub depend on the
   * console would drag Vue into the image.
   *
   * Enumerated and not taken by wildcard: `/admin/moderationn` must answer 404,
   * not open a silent console. And `developpement` is only served in dev mode, as
   * its module is only loaded on demand.
   */
  const consoleRoutes = consolePaths(dev)

  /*
   * The mobile control app: the same bundle a room machine serves.
   *
   * Two addresses only — `/regie` picks a room, `/regie/<id>` drives it.
   * Enumerated like the console's rather than taken by wildcard:
   * `/regie/assets/...` must reach the files, not render the shell in their
   * place, and an unknown room must say so.
   */
  const controlBundle = resolveControlBundle()

  /*
   * The console's assets, served by the hub itself.
   *
   * That is what replaces the "no external dependency" invariant without
   * betraying it: nothing is asked of an origin other than the one that served
   * the page, and an outage on the event network therefore cannot make them
   * disappear. The names carry a fingerprint, hence `immutable` — which is what
   * removes the 45 kB of CSS re-downloaded on every navigation.
   */
  if (!dev && bundle != null) {
    await app.register(fastifyStatic, {
      root: join(bundle.folder, 'assets'),
      prefix: '/admin/assets/',
      wildcard: false,
      immutable: true,
      maxAge: '1y',
      decorateReply: false,
    })
  }

  if (!dev && controlBundle != null) {
    await app.register(fastifyStatic, {
      root: join(controlBundle.folder, 'assets'),
      prefix: '/regie/assets/',
      wildcard: false,
      immutable: true,
      maxAge: '1y',
      decorateReply: false,
    })
  }

  /*
   * In development, the hub proxies Vite — never the other way round.
   *
   * The direction is imposed, and not by convenience. The hub carries Better
   * Auth's cookies, `/rpc`, the rooms' WebSocket, and above all `/sw.js`, whose
   * **scope depends on the path it is served from**. Putting Vite in front would
   * break the service worker's scope and the cookies' origin, and both failures
   * are hard to diagnose.
   *
   * `websocket` for hot reloading: without it the console reloads by hand, which
   * is precisely what we came for.
   *
   * In dev mode, Vite goes **in front of** the bundle. The opposite order made
   * development impossible as soon as a `dist/` was lying around: `pnpm test`
   * builds one, and a console compiled the day before took precedence over the
   * running server — with no hot reload, and with a Vue extension that refuses to
   * inspect a page it sees as production. A `dist/` is an artefact; `MODE=dev` is
   * an intent.
   */
  if (dev) {
    const before = app.server.listenerCount('upgrade')
    await app.register(fastifyProxy, {
      upstream: config.viteOrigin,
      prefix: '/admin/',
      rewritePrefix: '/admin/',
      websocket: true,
      // The view addresses are served by the shell just below: the proxy only
      // takes what Vite knows how to render.
      httpMethods: ['GET'],
      preHandler: (request, reply, done) => {
        if (consoleRoutes.includes(request.url.split('?')[0] ?? '')) {
          return reply.callNotFound()
        }
        done()
      },
    })

    /*
     * The control app has its own Vite, on its own port.
     *
     * The same server serves the control app to the room machine and to the hub,
     * and both serve it under `/regie/`: the bundle's `base` therefore fits as
     * is. `preHandler` excludes the two shell addresses, which the hub renders
     * itself — that is where the scope boot payload lives, and Vite knows nothing
     * about it.
     */
    await app.register(fastifyProxy, {
      upstream: config.regieViteOrigin,
      prefix: `${CONTROL_PATH}/`,
      rewritePrefix: `${CONTROL_PATH}/`,
      websocket: true,
      httpMethods: ['GET'],
      preHandler: (request, reply, done) => {
        const path = request.url.split('?')[0] ?? ''
        if (path === CONTROL_PATH || controlRoomIdFromPath(path) != null) {
          return reply.callNotFound()
        }
        done()
      },
    })

    /*
     * The proxy must only see what concerns it.
     *
     * `@fastify/http-proxy` sets its own `upgrade` listener and routes
     * **everything** that arrives through the Fastify router — including `/ws`,
     * the rooms' transport, which has no route there. So it goes out as a 404,
     * and the proxy destroys its socket at the end of the response. Result: no
     * room can connect as soon as the proxy is mounted, which in development was
     * the exact case nobody was watching — it only mounted for want of a built
     * bundle, so mostly on a freshly cloned repository.
     *
     * **One listener for both proxies**, and it is the plugin that decides: it
     * sets one per server (`kWsUpgradeListener`) then dispatches through the
     * router, so the console and the control app share it. Counting here stays
     * the guard rail — the day the plugin sets one per instance, the filter would
     * only cover the first, and the rooms would fall back into the silent failure
     * it exists to prevent.
     */
    const added = app.server.listeners('upgrade').slice(before)
    if (added.length !== 1) {
      throw new Error(
        `Les proxys Vite ont posé ${added.length} écouteurs « upgrade » au lieu d'un : ` +
          'le filtre qui protège le transport des salles ne sait plus lequel envelopper.',
      )
    }
    const dispatch = added[0] as (...args: unknown[]) => void
    app.server.removeListener('upgrade', dispatch)
    app.server.on('upgrade', (request, socket, head) => {
      if (request.url?.startsWith('/ws') === true) return
      dispatch(request, socket, head)
    })
  }

  for (const path of consoleRoutes) {
    app.get(path, async (_request, reply) => {
      reply.header('content-type', 'text/html; charset=utf-8')
      // Never `immutable` on the shell: an updated console that never reaches an
      // operator's machine is worse than re-downloading it.
      reply.header('cache-control', 'no-store')
      if (bundle == null && !dev) {
        /*
         * The bundle is missing, and there is no template behind it any more.
         *
         * This is not an operational state: the hub's image builds the console at
         * the Dockerfile's "Console" stage, so its absence signals an incomplete
         * deployment. Saying so in plain words beats a 404, which would send
         * people looking at the address.
         */
        reply.status(503)
        return reply.send(
          'Console non construite. Depuis les sources : ' +
            'pnpm --filter @conference-operator/hub-admin build',
        )
      }
      return reply.send(
        renderConsoleShell({
          mode: config.mode,
          event: services.identity.get(),
          google: config.googleClientId == null ? null : { domain: config.googleHostedDomain! },
          version: config.version,
          assets: dev ? developmentAssets() : productionAssets(bundle!.manifest),
        }),
      )
    })
  }

  /**
   * The mobile control app: the picker screen, then a room.
   *
   * Two addresses because **each screen is an address**, like the console's tabs:
   * the refreshed page reopens the room being driven, the link gets bookmarked
   * and sent to a colleague, and the Back button returns to the picker rather
   * than leaving.
   *
   * Nothing is checked here about the room or the operator: the shell is public,
   * like the console's, and it is the first oRPC call that asks for a session.
   * Resolving a room before rendering the page would return a 404 to anyone not
   * signed in, which reads as a dead address.
   */
  const renderControl = async (roomId: string | null, reply: FastifyReply): Promise<unknown> => {
    reply.header('content-type', 'text/html; charset=utf-8')
    // Never `immutable`: the shell carries the scope boot payload, and the room
    // it names changes from one address to the next.
    reply.header('cache-control', 'no-store')

    if (controlBundle == null && !dev) {
      /*
       * The bundle is missing, and there is no template behind it.
       *
       * Saying so in plain words beats a 404, which would send people looking at
       * the address — it is the same answer a room machine serves in the same
       * case.
       */
      reply.status(503)
      return reply.send(
        'Régie non construite. Depuis les sources : ' +
          'pnpm --filter @conference-operator/control-web build',
      )
    }

    return reply.send(
      renderMobileControlShell({
        event: services.identity.get(),
        roomId,
        rooms: services.rooms.list().map((room) => ({ id: room.id, name: room.name })),
        google: config.googleClientId == null ? null : { domain: config.googleHostedDomain! },
        version: config.version,
        assets: dev
          ? developmentControlAssets()
          : productionControlAssets(controlBundle!.manifest),
      }),
    )
  }

  app.get(CONTROL_PATH, async (_request, reply) => renderControl(null, reply))
  app.get<{ Params: { roomId: string } }>('/regie/:roomId', async (request, reply) =>
    renderControl(request.params.roomId, reply),
  )

  // WebSocket: the rooms' transport. The headers are only available at the
  // upgrade, so the context (session, device) is frozen for the whole lifetime of
  // the connection — which is the intended behaviour: a machine revoked during
  // the day is cut off at its next reconnection.
  const wsHandler = new WebSocketRPCHandler(router)
  const wss = new WebSocketServer({ noServer: true })
  const liveSockets = new Set<NodeWebSocket>()
  wss.on(
    'connection',
    (socket: NodeWebSocket, headers: Headers, ticketOperator?: HubContext['ticketOperator']) => {
      liveSockets.add(socket)
      socket.on('close', () => liveSockets.delete(socket))
      wsHandler.upgrade(socket as unknown as Parameters<typeof wsHandler.upgrade>[0], {
        context: {
          ...contextFrom(auth, services, headers),
          ...(ticketOperator != null ? { ticketOperator } : {}),
        },
      })
    },
  )

  app.server.on('upgrade', (request, socket, head) => {
    if (!request.url?.startsWith('/ws')) {
      /*
       * In development, `/admin/` belongs to the Vite proxy: hot reloading goes
       * through a WebSocket, and destroying it here would cut exactly what we
       * came for. Elsewhere, nothing else is listening — a socket left open would
       * leak.
       */
      if (!dev) socket.destroy()
      return
    }
    const headers = headersOf(request.headers)

    /*
     * A mobile control app: `/ws?ticket=…`.
     *
     * Redeemed **before** the handshake, and refused as a plain 401: a socket
     * accepted on a dead ticket would only fail at its first call, where the page
     * can no longer tell a refusal from a network hiccup. Without a ticket nothing
     * changes — that is the rooms' path, authenticated by their own headers.
     */
    const ticket = new URL(request.url, 'http://hub').searchParams.get('ticket')
    let ticketOperator: HubContext['ticketOperator']
    if (ticket != null) {
      const grant = services.tickets.redeem(ticket)
      if (grant == null) {
        socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n')
        socket.destroy()
        return
      }
      // The socket speaks as the ticket's operator and tab, and as nothing else.
      headers.delete('authorization')
      headers.set(CONTROL_SESSION_HEADER, grant.regieSession)
      ticketOperator = grant.operator
    }

    wss.handleUpgrade(request, socket, head, (client) =>
      wss.emit('connection', client, headers, ticketOperator),
    )
  })

  /**
   * Automatic closing of overrunning slots.
   *
   * Every 30 s: often enough for the screen to keep up, rare enough to cost
   * nothing. The rule itself is configurable in the console.
   */
  const autoEndSweep = setInterval(() => {
    const snapshot = services.programs.active()
    // A forced talk runs outside its slot by decision: the clock does not close it.
    const pinned = new Set(Object.values(services.pins.all()))
    for (const state of services.sessions.sweep(snapshot?.program ?? null, pinned).ended) {
      const session = snapshot?.program.sessions.find((s) => s.id === state.sessionId)
      // Broadcast to everyone: the other rooms use it to notify.
      services.commands.publish(
        null,
        {
          type: 'session.state',
          sessionId: state.sessionId,
          roomId: state.roomId,
          sessionTitle: session?.title ?? null,
          status: 'ended',
          decidedBy: 'auto',
        },
        null,
      )
      app.log.info({ sessionId: state.sessionId }, 'conférence clôturée automatiquement')
    }
  }, 30_000)
  autoEndSweep.unref?.()

  /**
   * Supervision watch: what the hub notices for the closed consoles.
   *
   * Every 15 s, a little less than the silence beyond which a room is declared
   * silent: enough to see the outage on the next pass, without polling for
   * nothing. It does nothing when nobody is subscribed — the normal case of a
   * development hub.
   */
  const watch = new SupervisionWatch()
  /*
   * The audit log's retention, on the hub's clock: once at start, then hourly.
   * A purge that fails costs a few old lines kept, never the hub.
   */
  const purgeAudit = () => {
    try {
      const purged = services.audit.purge()
      if (purged > 0) app.log.info({ purged }, "journal d'audit : entrées anciennes purgées")
    } catch (cause) {
      app.log.warn({ message: (cause as Error).message }, "journal d'audit : purge impossible")
    }
  }
  purgeAudit()
  const auditPurge = setInterval(purgeAudit, 3_600_000)
  auditPurge.unref?.()

  const supervisionTimer = setInterval(() => {
    /*
     * Expired mobile control locks, **before** the early return.
     *
     * This sweep has nothing to do with push, and it must run even when nobody is
     * subscribed — the normal case of a development hub. It decides nothing:
     * `regie.lock()` already discards an expired lock on read. It switches off the
     * "driven remotely" badge left on in the room, which only a command can do.
     */
    for (const roomId of services.regie.sweep()) {
      services.commands.publish(roomId, { type: 'regie.hold', holder: null }, null)
      app.log.info({ roomId }, 'verrou de régie mobile expiré')
    }

    // Either recipient is enough to watch: a hub with nobody subscribed but a
    // Slack channel plugged in still has someone to tell.
    const pushing = services.push.publicKey() != null && services.push.count() > 0
    const integrating = services.integrations.activeCount() > 0
    if (!pushing && !integrating) return
    const snapshot = services.programs.active()
    const statuses = roomStatuses(services, clock.now())
    const notices = watch.pass(
      statuses,
      services.devices.pending(),
      Object.fromEntries(
        statuses.map((room) => [
          room.roomId,
          Object.fromEntries(
            services.sessions.states(room.roomId).map((state) => [state.sessionId, state.status]),
          ),
        ]),
      ),
      // An opaque identifier cannot be read on a lock screen.
      (sessionId) =>
        snapshot?.program.sessions.find((session) => session.id === sessionId)?.title ?? null,
    )
    for (const notification of notices) {
      if (pushing) {
        void services.push
          .send(notification)
          .then((reached) => {
            if (reached > 0) app.log.info({ notice: notification.title, reached }, 'avis poussé')
          })
          .catch((cause) => app.log.warn({ cause }, "avis non poussé"))
      }
      if (integrating) {
        void services.integrations
          .send(notification)
          .then((reached) => {
            if (reached > 0) {
              app.log.info({ notice: notification.title, reached }, 'avis relayé aux intégrations')
            }
          })
          .catch((cause) => app.log.warn({ cause }, 'avis non relayé aux intégrations'))
      }
    }
  }, 15_000)
  supervisionTimer.unref?.()

  social.start()

  /**
   * Housekeeping of stalled uploads.
   *
   * Ten minutes, and not fifteen seconds like supervision: nothing here is
   * watched live, and querying the storage in a loop would cost billed requests
   * for a problem measured in hours. The inventory of orphans, on the other hand,
   * happens **only at startup** — that is the only moment the register can be
   * unaware of what the storage holds, because the database has just been
   * recreated.
   */
  if (services.vod != null) {
    services.vod.startHousekeeping()
    void services.vod.sweepOrphans().catch(() => {})
  }

  let closed = false
  /** Idempotent: the graceful shutdown and the safety net can cross. */
  const closeResources = (): void => {
    if (closed) return
    closed = true
    clearInterval(autoEndSweep)
    clearInterval(supervisionTimer)
    clearInterval(auditPurge)
    services.vod?.stopHousekeeping()
    social.stop()
    stopWallNotices()
    if (wallNotice != null) clearTimeout(wallNotice)
    /**
     * The order is imposed. `wss.close()` stops accepting new connections but
     * **leaves the existing ones alive**: without cutting them explicitly, an RPC
     * call already in flight reaches a closed database and Better Auth reports an
     * internal error instead of a clean shutdown.
     */
    for (const socket of liveSockets) socket.terminate()
    liveSockets.clear()
    wss.close()
  }

  return {
    app,
    auth,
    services,
    social,
    closeSync: () => {
      closeResources()
      // `better-sqlite3` closes synchronously: that is what makes this safety net
      // possible, and what guarantees a clean WAL at the next startup.
      if (sqlite.open) sqlite.close()
    },
    close: async () => {
      closeResources()
      await app.close()
      if (sqlite.open) sqlite.close()
    },
  }
}

/** Compares a key without telling, by its timing, how much of it was right. */
function sameKey(given: string, expected: string): boolean {
  const a = Buffer.from(given)
  const b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b)
}

function contextFrom(auth: Auth, services: Services, headers: Headers): HubContext {
  return { auth, services, headers }
}

function headersOf(raw: Record<string, string | string[] | undefined>): Headers {
  const headers = new Headers()
  for (const [key, value] of Object.entries(raw)) {
    if (value == null) continue
    for (const item of Array.isArray(value) ? value : [value]) headers.append(key, item)
  }
  return headers
}

/** Fastify → standard `Request`, the only format Better Auth's handler understands. */
/** A request's body, whole: for the few the hub has to read before handing on. */
async function readBody(stream: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of stream) chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk)
  return Buffer.concat(chunks).toString('utf8')
}

function toWebRequest(
  request: {
    method: string
    url: string
    headers: Record<string, string | string[] | undefined>
    raw: NodeJS.ReadableStream
  },
  publicUrl: string,
): Request {
  const url = new URL(request.url, publicUrl)
  const hasBody = request.method !== 'GET' && request.method !== 'HEAD'
  return new Request(url, {
    method: request.method,
    headers: headersOf(request.headers),
    body: hasBody ? (request.raw as unknown as ReadableStream) : undefined,
    // Required by undici as soon as a streamed body is provided.
    ...(hasBody ? { duplex: 'half' } : {}),
  } as RequestInit)
}

/**
 * What a talk's intro and outro show, resolved on the hub.
 *
 * The images go as the hub's own `/assets/…` addresses when it holds them —
 * the worker then needs nothing but the hub — and as the export's otherwise.
 * A talk the program does not know gets an empty title: the worker completes
 * it from the take's sidecar, which it reads anyway.
 */
function vodHabillageFor(services: Services, publicUrl: string, sessionId: string): VodHabillage {
  const base = publicUrl.replace(/\/+$/, '')
  return buildVodHabillage({
    program: services.programs.active()?.program ?? null,
    boucle: services.settings.get().boucle,
    sidecar: { sessionId, title: '', speakers: [], category: null },
    eventName: services.identity.get().name,
    localize: (ref) => {
      if (ref == null) return null
      const local = services.assets.previewUrl(ref)
      return local == null ? (/^https?:\/\//.test(ref) ? ref : null) : base + local
    },
  })
}
