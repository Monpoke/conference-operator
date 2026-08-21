import Fastify, { type FastifyInstance } from 'fastify'
import { WebSocketServer, type WebSocket as NodeWebSocket } from 'ws'
import { RPCHandler as FastifyRPCHandler } from '@orpc/server/fastify'
import { RPCHandler as WebSocketRPCHandler } from '@orpc/server/websocket'
import { createAuth, createAuthOptions, migrateAuth, type Auth } from './auth.js'
import { configSchema, type ConfigInput } from './config.js'
import { openHubDatabase } from './db.js'
import { router } from './router.js'
import type { HubContext, Services } from './context.js'
import { ProgramService } from './services/program.js'
import { CommandService } from './services/commands.js'
import { IngestService } from './services/ingest.js'
import { DeviceService, RoomService } from './services/rooms.js'
import { QuestionService, WallService } from './services/wall.js'
import { RateLimiter } from './services/rate-limit.js'
import { SessionStateService, SettingsService } from './services/sessions.js'
import { mutableClock } from './services/clock.js'
import {
  SocialIngestor,
  blueskySource,
  mastodonSource,
  xSource,
  type SocialSource,
} from './services/social.js'
import { renderWallPage } from './pages/wall-page.js'
import { renderAdminPage } from './pages/admin-page.js'

export interface Hub {
  app: FastifyInstance
  auth: Auth
  services: Services
  social: SocialIngestor | null
  close: () => Promise<void>
  /**
   * Fermeture de dernier recours, **synchrone**.
   *
   * Les gestionnaires `exit` de Node n'attendent aucune promesse : la version
   * asynchrone ne s'exécuterait pas. Nécessaire parce que `tsx watch` — donc
   * `pnpm dev` — coupe le processus sans laisser l'arrêt gracieux se terminer,
   * à chaque Ctrl-C **et à chaque sauvegarde de fichier**. Sans ce filet, la
   * base n'est jamais refermée proprement.
   */
  closeSync: () => void
}

export async function createHub(input: ConfigInput): Promise<Hub> {
  // Normalisée à l'entrée : le reste du hub travaille sur une config complète.
  const config = configSchema.parse(input)
  const { sqlite, orm } = openHubDatabase(config.databasePath)

  const devices = new DeviceService(orm)
  const settings = new SettingsService(orm)
  const clock = mutableClock(config.simulatedTime ?? null)
  const services: Services = {
    programs: new ProgramService(orm),
    rooms: new RoomService(orm),
    devices,
    commands: new CommandService(orm, () => clock.now()),
    ingest: new IngestService(orm),
    wall: new WallService(orm),
    questions: new QuestionService(orm),
    // Cinq dépôts d'affilée puis un toutes les dix secondes : de quoi poster
    // normalement, pas de quoi noyer la file de modération.
    limiter: new RateLimiter({ capacity: 5, refillPerSecond: 0.1 }),
    settings,
    sessions: new SessionStateService(orm, settings, () => clock.now()),
    clock,
    clockControl: config.clockControl,
  }

  const authOptions = createAuthOptions({
    sqlite,
    secret: config.authSecret,
    publicUrl: config.publicUrl,
    onDeviceRequest: (clientId, scope) => devices.recordRequest(clientId, scope),
    isKnownClient: (clientId) => devices.isKnownClient(clientId),
    deviceInterval: config.devicePollInterval,
  })
  await migrateAuth(authOptions)
  const auth = createAuth(authOptions)

  // Ingestion sociale : montée seulement si un hashtag est configuré. Sans
  // hashtag, le mur fonctionne quand même — par formulaire et QR code.
  const sources: SocialSource[] = []
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

  if (clock.simulated) {
    // Bruyant à dessein : une heure simulée oubliée en production fausserait
    // les timecodes VOD et la clôture automatique.
    app.log.warn({ heure: clock.nowIso() }, 'HORLOGE SIMULÉE — développement uniquement')
  }

  const social =
    sources.length === 0
      ? null
      : new SocialIngestor(sources, services.wall, {
          intervalMs: config.socialPollIntervalMs,
          onLog: (level, message, context) => app.log[level]({ context }, message),
        })

  // Ni Better Auth ni oRPC ne veulent un corps déjà consommé par Fastify.
  app.removeAllContentTypeParsers()
  app.addContentTypeParser('*', (_request, _payload, done) => done(null))

  app.all('/api/auth/*', async (request, reply) => {
    const response = await auth.handler(toWebRequest(request, config.publicUrl))
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
   * Mur public : la page que scannent les participants.
   *
   * Servie par le hub et non par une application séparée — elle doit être
   * joignable depuis la 4G des mobiles, exactement là où le hub est déjà exposé.
   */
  app.get<{ Querystring: { salle?: string } }>('/mur', async (request, reply) => {
    reply.header('content-type', 'text/html; charset=utf-8')
    return reply.send(
      renderWallPage({
        roomId: request.query.salle ?? null,
        rooms: services.rooms.list().map((room) => ({ id: room.id, name: room.name })),
      }),
    )
  })

  /**
   * Console d'exploitation : modération, appairage, programme, supervision.
   *
   * `/admin/devices` sert la même page : c'est l'adresse que Better Auth donne
   * à la machine pendant l'appairage, avec le code en paramètre. La console le
   * pré-remplit, ce qui évite de le recopier à la main depuis un écran de régie
   * à l'autre bout de la salle.
   */
  for (const chemin of ['/admin', '/admin/devices']) {
    app.get(chemin, async (_request, reply) => {
      reply.header('content-type', 'text/html; charset=utf-8')
      return reply.send(renderAdminPage())
    })
  }

  // WebSocket : le transport des salles. Les en-têtes ne sont disponibles qu'à
  // l'upgrade, donc le contexte (session, appareil) est figé pour toute la
  // durée de la connexion — ce qui est le comportement voulu : une machine
  // révoquée en cours de journée est coupée à sa prochaine reconnexion.
  const wsHandler = new WebSocketRPCHandler(router)
  const wss = new WebSocketServer({ noServer: true })
  const liveSockets = new Set<NodeWebSocket>()
  wss.on('connection', (socket: NodeWebSocket, headers: Headers) => {
    liveSockets.add(socket)
    socket.on('close', () => liveSockets.delete(socket))
    wsHandler.upgrade(socket as unknown as Parameters<typeof wsHandler.upgrade>[0], {
      context: contextFrom(auth, services, headers),
    })
  })

  app.server.on('upgrade', (request, socket, head) => {
    if (!request.url?.startsWith('/ws')) {
      socket.destroy()
      return
    }
    const headers = headersOf(request.headers)
    wss.handleUpgrade(request, socket, head, (client) => wss.emit('connection', client, headers))
  })

  /**
   * Clôture automatique des créneaux dépassés.
   *
   * Toutes les 30 s : assez fréquent pour que l'écran suive de près, assez
   * rare pour ne rien coûter. La règle elle-même est réglable dans la console.
   */
  const balayage = setInterval(() => {
    const snapshot = services.programs.active()
    for (const etat of services.sessions.sweep(snapshot?.program ?? null).ended) {
      const session = snapshot?.program.sessions.find((s) => s.id === etat.sessionId)
      // Diffusion générale : les autres salles s'en servent pour notifier.
      services.commands.publish(
        null,
        {
          type: 'session.state',
          sessionId: etat.sessionId,
          roomId: etat.roomId,
          sessionTitle: session?.title ?? null,
          status: 'ended',
          decidedBy: 'auto',
        },
        null,
      )
      app.log.info({ sessionId: etat.sessionId }, 'conférence clôturée automatiquement')
    }
  }, 30_000)
  balayage.unref?.()

  if (social != null) social.start()

  let ferme = false
  /** Idempotent : l'arrêt gracieux et le filet de sécurité peuvent se croiser. */
  const fermerRessources = (): void => {
    if (ferme) return
    ferme = true
    clearInterval(balayage)
    social?.stop()
    /**
     * Ordre imposé. `wss.close()` cesse d'accepter de nouvelles connexions
     * mais **laisse vivre les existantes** : sans les couper explicitement,
     * un appel RPC déjà en vol atteint une base fermée et Better Auth remonte
     * une erreur interne au lieu d'un arrêt propre.
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
      fermerRessources()
      // `better-sqlite3` ferme de façon synchrone : c'est ce qui rend ce filet
      // possible, et ce qui garantit un WAL propre au prochain démarrage.
      if (sqlite.open) sqlite.close()
    },
    close: async () => {
      fermerRessources()
      await app.close()
      if (sqlite.open) sqlite.close()
    },
  }
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

/** Fastify → `Request` standard, seul format que comprend le handler Better Auth. */
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
    // Requis par undici dès qu'un corps en flux est fourni.
    ...(hasBody ? { duplex: 'half' } : {}),
  } as RequestInit)
}
