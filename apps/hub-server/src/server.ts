import Fastify, { type FastifyInstance } from 'fastify'
import { WebSocketServer, type WebSocket as NodeWebSocket } from 'ws'
import { RPCHandler as FastifyRPCHandler } from '@orpc/server/fastify'
import { RPCHandler as WebSocketRPCHandler } from '@orpc/server/websocket'
import { createAuth, createAuthOptions, migrateAuth, type Auth } from './auth.js'
import { configSchema, dureeEnMs, type ConfigInput } from './config.js'
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
import { readFileSync } from 'node:fs'
import { clesS3, VodService } from './services/vod.js'
import { EventIdentityService } from './services/event-identity.js'
import { mutableClock } from './services/clock.js'
import {
  SocialIngestor,
  blueskySource,
  mastodonSource,
  xSource,
  type SocialSource,
} from './services/social.js'
import { renderWallPage } from './pages/wall-page.js'
import { ALIAS_APPAIRAGE, cheminDeVue, renderAdminPage, vuesConsole } from './pages/admin-page.js'
import { renderServiceWorker } from './pages/service-worker.js'
import { PushService } from './services/push.js'
import { statutsDesSalles, VeilleSupervision } from './supervision.js'

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

  const devices = new DeviceService(orm, dureeEnMs(config.deviceCodeTtl))
  const push = new PushService(orm, {
    publicKey: config.vapidPublicKey,
    privateKey: config.vapidPrivateKey,
    subject: config.vapidSubject,
  })
  const settings = new SettingsService(orm)
  const programs = new ProgramService(orm)
  const clock = mutableClock(config.simulatedTime ?? null)

  const services: Services = {
    programs,
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
    identity: new EventIdentityService(settings, programs),
    sessions: new SessionStateService(orm, settings, () => clock.now()),
    push,
    // Renseigné juste après la création du serveur : le service journalise,
    // et son journal est celui de Fastify.
    vod: null,
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
            // Garanti présent par le `refine` de la config : Google sans
            // domaine ne démarre pas, parce que le domaine *est* la liste des
            // opérateurs.
            hostedDomain: config.googleHostedDomain!,
          }
        : undefined,
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

  /**
   * Rapatriement des rushes : monté seulement si le stockage est configuré.
   *
   * `null` est le cas normal — c'est une fonctionnalité d'après-événement, et
   * un hub qui n'en a pas besoin ne doit pas porter la moitié de ses rouages :
   * ni boucle de ménage, ni panneau dans la console, ni procédures qui
   * échouent.
   */
  /**
   * Bucket : l'environnement amorce, la console décide.
   *
   * `S3_BUCKET` ne sert qu'au tout premier démarrage — même règle que
   * `PROGRAM_SOURCE_URL`, et pour la même raison : un bucket corrigé en cours
   * d'événement doit survivre au redémarrage qui suit.
   *
   * Amorcé **ici** et non dans `main.ts`, à la différence du programme : c'est
   * juste en dessous que le hub annonce l'état du stockage, et le faire plus
   * tard lui ferait dire « aucun bucket réglé » à chaque premier démarrage
   * d'une installation pourtant complète. Un journal qui se contredit trois
   * lignes plus loin ne se lit plus.
   *
   * Corollaire à connaître : vider le champ dans la console n'éteint pas la
   * fonctionnalité de façon durable, puisque le prochain démarrage le
   * réamorcerait. Pour l'éteindre, c'est « Téléverser automatiquement » qu'on
   * décoche — ce réglage-là, rien ne le réécrit.
   */
  if (config.s3Bucket != null && settings.get().vodBucket == null) {
    settings.update({ vodBucket: config.s3Bucket })
  }

  /**
   * Autorité de certification du stockage, lue une fois au démarrage.
   *
   * Illisible, on le dit **en erreur** et on continue sans : le rapatriement
   * échouera alors sur un refus TLS, mais le hub démarre. C'est la même règle
   * que pour les clés VAPID, et pour la même raison — le téléversement est un
   * confort d'après-événement, et un hub qui refuse de repartir en cours de
   * journée coûterait bien plus cher que des rushes rapatriés le lendemain.
   */
  let caCert: string | null = null
  if (config.s3CaCert != null) {
    try {
      caCert = readFileSync(config.s3CaCert, 'utf8')
    } catch (cause) {
      app.log.error(
        { chemin: config.s3CaCert, message: (cause as Error).message },
        "S3_CA_CERT illisible : le stockage sera refusé si son certificat n'est pas signé par une CA publique",
      )
    }
  }

  const cles = clesS3(config, caCert)
  if (cles != null) {
    services.vod = new VodService(
      orm,
      settings,
      cles,
      config.vodAbandonMinutes,
      () => clock.nowIso(),
      (niveau, message, contexte) => app.log[niveau](contexte ?? {}, message),
    )
  }

  if (config.mode === 'dev') {
    app.log.warn('MODE DÉVELOPPEMENT — heure et horloge réglables, à ne pas laisser le jour J')
  }

  if (clock.simulated) {
    // Bruyant à dessein : une heure simulée oubliée en production fausserait
    // les timecodes VOD et la clôture automatique.
    app.log.warn({ heure: clock.nowIso() }, 'HORLOGE SIMULÉE — développement uniquement')
  }

  /**
   * Ce que le stockage est, ou n'est pas.
   *
   * Dit au démarrage plutôt que découvert au premier clic : « configuré mais
   * sans bucket » est l'état le plus déroutant des trois — les clés sont là,
   * la console montre le panneau, et rien ne part. Le journal le nomme.
   */
  if (services.vod == null) {
    app.log.info('rapatriement des rushes : inactif (aucun stockage S3 configuré)')
  } else if (!services.vod.pret()) {
    app.log.warn('rapatriement des rushes : clés S3 présentes, mais aucun bucket réglé (console → VOD)')
  } else {
    app.log.info({ endpoint: config.s3Endpoint }, 'rapatriement des rushes : actif')
  }

  const panneDuPush = push.unavailableReason()
  // Bruyant à dessein : quelqu'un a renseigné des clés qui ne servent à rien,
  // et le silence ferait chercher la panne du côté des navigateurs.
  if (panneDuPush != null) app.log.error(panneDuPush)

  for (const { variable, raison } of config.ignores) {
    // En erreur, pas en avertissement : quelqu'un croit avoir réglé quelque
    // chose, et ce quelque chose ne s'applique pas. Le taire ferait chercher
    // ailleurs pendant des heures.
    app.log.error({ variable }, `${variable} ignoré : ${raison}`)
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
        // Injecté au rendu plutôt que demandé par la page : c'est le premier
        // mot que lit un participant qui vient de scanner un QR, et l'attendre
        // d'un appel réseau de plus le ferait apparaître après coup.
        event: services.identity.get(),
      }),
    )
  })

  /**
   * Console d'exploitation : modération, appairage, programme, supervision.
   *
   * Une adresse par onglet, toutes servies par la même page : la console
   * choisit sa vue au chargement, et le rafraîchissement, le favori et le
   * bouton Retour retombent sur leurs pieds. Le serveur doit les connaître,
   * sinon `/admin/moderation` rechargée répondrait 404.
   *
   * Les vues sont énumérées, pas prises au joker : `/admin/*` servirait la
   * console sur n'importe quelle faute de frappe, qui s'ouvrirait alors sur
   * l'exploitation sans dire que l'adresse n'existe pas. Et `developpement`
   * n'est servie qu'en mode dev, comme elle n'est rendue qu'en mode dev.
   *
   * `/admin/devices` s'ajoute : c'est l'adresse que Better Auth donne à la
   * machine pendant l'appairage, avec le code en paramètre. La console le
   * pré-remplit, ce qui évite de le recopier à la main depuis un écran de régie
   * à l'autre bout de la salle.
   */
  const cheminsConsole = [
    ...vuesConsole(config.mode === 'dev').map(cheminDeVue),
    ALIAS_APPAIRAGE,
  ]
  /**
   * Service worker des notifications, servi à la racine.
   *
   * La portée d'un service worker est celle de son chemin : servi sous
   * `/admin/`, il ne couvrirait pas le reste du hub. Sans cache, il ne sert
   * qu'à recevoir les avis poussés quand la console est fermée.
   */
  app.get('/sw.js', async (_request, reply) => {
    reply.header('content-type', 'text/javascript; charset=utf-8')
    // Le navigateur revérifie le worker à chaque chargement de page ; le
    // laisser en cache retarderait toute correction d'un jour d'événement.
    reply.header('cache-control', 'no-cache')
    // Le nom de l'événement est figé dans le worker au moment où il est servi :
    // un avis poussé console fermée n'a pas d'autre source pour se titrer, et
    // le navigateur revérifie le worker à chaque chargement de page — un
    // renommage suit donc au premier passage de l'opérateur.
    return reply.send(renderServiceWorker({ event: services.identity.get() }))
  })

  for (const chemin of cheminsConsole) {
    app.get(chemin, async (_request, reply) => {
      reply.header('content-type', 'text/html; charset=utf-8')
      return reply.send(
        renderAdminPage({
          mode: config.mode,
          event: { resolved: services.identity.get(), derived: services.identity.derived() },
          ignores: config.ignores,
          // Le bouton n'est rendu que si le hub sait s'en servir : proposer une
          // connexion qui échoue au clic vaut moins que ne rien proposer.
          google: config.googleClientId == null ? null : { domaine: config.googleHostedDomain! },
        }),
      )
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

  /**
   * Veille de supervision : ce que le hub remarque pour les consoles fermées.
   *
   * Toutes les 15 s, soit un peu moins que le silence au-delà duquel une salle
   * est déclarée muette : de quoi voir la coupure au tour suivant, sans sonder
   * pour rien. Elle ne fait rien quand personne n'est abonné — le cas normal
   * d'un hub de développement.
   */
  const veille = new VeilleSupervision()
  const surveillance = setInterval(() => {
    if (services.push.publicKey() == null || services.push.count() === 0) return
    const snapshot = services.programs.active()
    const statuts = statutsDesSalles(services, clock.now())
    const avis = veille.passe(
      statuts,
      services.devices.pending(),
      Object.fromEntries(
        statuts.map((salle) => [
          salle.roomId,
          Object.fromEntries(
            services.sessions.states(salle.roomId).map((etat) => [etat.sessionId, etat.status]),
          ),
        ]),
      ),
      // Un identifiant opaque ne se lit pas sur un écran de verrouillage.
      (sessionId) =>
        snapshot?.program.sessions.find((session) => session.id === sessionId)?.title ?? null,
    )
    for (const notification of avis) {
      void services.push
        .send(notification)
        .then((atteints) => {
          if (atteints > 0) app.log.info({ avis: notification.title, atteints }, 'avis poussé')
        })
        .catch((cause) => app.log.warn({ cause }, "avis non poussé"))
    }
  }, 15_000)
  surveillance.unref?.()

  if (social != null) social.start()

  /**
   * Ménage des téléversements en plan.
   *
   * Dix minutes, et non quinze secondes comme la supervision : rien ici ne se
   * regarde en direct, et interroger le stockage en boucle coûterait des
   * requêtes facturées pour un problème qui se mesure en heures. L'inventaire
   * des orphelins, lui, ne se fait **qu'au démarrage** — c'est le seul moment
   * où le registre peut ignorer ce que le stockage détient, parce que la base
   * vient d'être recréée.
   */
  if (services.vod != null) {
    services.vod.demarrerMenage()
    void services.vod.menageDesOrphelins().catch(() => {})
  }

  let ferme = false
  /** Idempotent : l'arrêt gracieux et le filet de sécurité peuvent se croiser. */
  const fermerRessources = (): void => {
    if (ferme) return
    ferme = true
    clearInterval(balayage)
    clearInterval(surveillance)
    services.vod?.arreterMenage()
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
