import Fastify, { type FastifyInstance, type FastifyReply } from 'fastify'
import fastifyProxy from '@fastify/http-proxy'
import fastifyStatic from '@fastify/static'
import { join } from 'node:path'
import { consolePaths, CONTROL_PATH, controlRoomIdFromPath } from '@cloudnord/contract'
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
import { RegieService } from './services/regie.js'
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
import {
  assetsDeDeveloppement,
  assetsDeProduction,
  renderConsoleShell,
  resoudreConsole,
} from './pages/console-shell.js'
import {
  assetsDeDeveloppementRegie,
  assetsDeProductionRegie,
  renderRegieMobileShell,
  resoudreRegie,
} from './pages/regie-shell.js'
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
    regie: new RegieService(orm, () => clock.now()),
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

  /*
   * Reprise du projet OpenFeedback saisi jadis sur une régie.
   *
   * Au démarrage plutôt qu'en migration SQL : la valeur vit dans le
   * `config_json` d'une salle, et la déterrer en SQL demanderait de raisonner
   * en JSON dans une migration, là où le service sait déjà lire et réécrire une
   * configuration. Idempotent — au démarrage suivant il n'y a plus rien à
   * reprendre, et rien n'est réécrit.
   */
  const repriseOpenFeedback = services.rooms.reprendreProjetOpenFeedback(settings)
  if (repriseOpenFeedback.sallesNettoyees.length > 0) {
    app.log.info(
      { adopte: repriseOpenFeedback.adopte, salles: repriseOpenFeedback.sallesNettoyees },
      repriseOpenFeedback.adopte == null
        ? 'projet OpenFeedback : surcharges de salle effacées, le réglage du hub fait foi'
        : 'projet OpenFeedback repris depuis une salle vers les réglages du hub',
    )
  }

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
  const dev = config.mode === 'dev'
  /*
   * Les adresses de la console, toutes servies par le bundle.
   *
   * La liste vient du contrat : le hub l'énumère pour enregistrer ses routes et
   * le routeur de la console la déclare pour naviguer. Aucun des deux ne peut
   * la posséder sans forcer l'autre à en dépendre — faire dépendre le hub de la
   * console ferait entrer Vue dans l'image.
   *
   * Énumérées et non prises au joker : `/admin/moderationn` doit répondre 404,
   * pas ouvrir une console muette. Et `developpement` n'est servie qu'en mode
   * dev, comme son module n'est chargé qu'à la demande.
   */
  /**
   * Service worker des notifications, servi à la racine.
   *
   * La portée d'un service worker est celle de son chemin : servi sous
   * `/admin/`, il ne couvrirait pas le reste du hub. C'est aussi la raison pour
   * laquelle le serveur de Vite est proxifié **derrière** celui-ci en
   * développement, et jamais l'inverse. Sans cache, il ne sert qu'à recevoir
   * les avis poussés quand la console est fermée.
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

  const bundle = resoudreConsole()
  const cheminsConsole = consolePaths(dev)

  /*
   * La régie mobile : le même bundle que sert une machine de salle.
   *
   * Deux adresses seulement — `/regie` choisit une salle, `/regie/<id>` la
   * pilote. Énumérées comme celles de la console plutôt que prises au joker :
   * `/regie/assets/...` doit atteindre les fichiers, pas rendre la coquille à
   * leur place, et une salle inconnue doit le dire.
   */
  const bundleRegie = resoudreRegie()

  /*
   * Assets de la console, servis par le hub lui-même.
   *
   * C'est ce qui remplace l'invariant « aucune dépendance externe » sans le
   * trahir : rien n'est demandé à une autre origine que celle qui a servi la
   * page, et une coupure du réseau de l'événement ne peut donc pas les faire
   * disparaître. Les noms portent une empreinte, d'où `immutable` — c'est ce
   * qui supprime les 45 Ko de CSS retéléchargés à chaque navigation.
   */
  if (!dev && bundle != null) {
    await app.register(fastifyStatic, {
      root: join(bundle.dossier, 'assets'),
      prefix: '/admin/assets/',
      wildcard: false,
      immutable: true,
      maxAge: '1y',
      decorateReply: false,
    })
  }

  if (!dev && bundleRegie != null) {
    await app.register(fastifyStatic, {
      root: join(bundleRegie.dossier, 'assets'),
      prefix: '/regie/assets/',
      wildcard: false,
      immutable: true,
      maxAge: '1y',
      decorateReply: false,
    })
  }

  /*
   * En développement, le hub proxifie Vite — jamais l'inverse.
   *
   * Le sens est imposé, et pas par commodité. Le hub porte les cookies de
   * Better Auth, `/rpc`, le WebSocket des salles, et surtout `/sw.js`, dont la
   * **portée dépend du chemin depuis lequel il est servi**. Mettre Vite devant
   * casserait la portée du service worker et l'origine des cookies, et les deux
   * pannes se diagnostiquent mal.
   *
   * `websocket` pour le rechargement à chaud : sans lui la console se recharge
   * à la main, ce qui est précisément ce qu'on vient chercher.
   *
   * En mode dev, Vite passe **devant** le bundle. L'ordre contraire rendait le
   * développement impossible dès qu'un `dist/` traînait : `pnpm test` en
   * construit un, et une console compilée de la veille prenait le pas sur le
   * serveur qui tourne — sans rechargement à chaud, et avec une extension Vue
   * qui refuse d'inspecter une page qu'elle voit en mode production. Un `dist/`
   * est un artefact ; `MODE=dev` est une intention.
   */
  if (dev) {
    const avant = app.server.listenerCount('upgrade')
    await app.register(fastifyProxy, {
      upstream: config.viteOrigin,
      prefix: '/admin/',
      rewritePrefix: '/admin/',
      websocket: true,
      // Les adresses de vues sont servies par la coquille juste en dessous : le
      // proxy ne prend que ce que Vite sait rendre.
      httpMethods: ['GET'],
      preHandler: (request, reply, done) => {
        if (cheminsConsole.includes(request.url.split('?')[0] ?? '')) {
          return reply.callNotFound()
        }
        done()
      },
    })

    /*
     * Le proxy ne doit voir que ce qui le regarde.
     *
     * `@fastify/http-proxy` pose son propre écouteur `upgrade` et route **tout**
     * ce qui arrive par le routeur Fastify — y compris `/ws`, le transport des
     * salles, qui n'y a pas de route. Il part donc en 404, et le proxy détruit
     * son socket à la fin de la réponse. Résultat : aucune salle ne peut se
     * connecter dès que le proxy est monté, ce qui en développement était le
     * cas exact où personne ne regardait — il ne se montait que faute de bundle
     * construit, donc surtout sur un dépôt fraîchement cloné.
     *
     * On lui retire donc les adresses qui ne sont pas les siennes. Aucun symbole
     * privé : l'écouteur qu'il vient d'ajouter est le seul de plus, et on le
     * remplace par une version filtrée.
     */
    /*
     * La régie a son propre Vite, sur son propre port.
     *
     * Le même serveur sert la régie au poste de salle et au hub, et les deux la
     * servent sous `/regie/` : la `base` du bundle convient donc telle quelle.
     * `preHandler` exclut les deux adresses de coquille, que le hub rend
     * lui-même — c'est là que vit l'amorce de portée, et Vite n'en sait rien.
     */
    await app.register(fastifyProxy, {
      upstream: config.regieViteOrigin,
      prefix: `${CONTROL_PATH}/`,
      rewritePrefix: `${CONTROL_PATH}/`,
      websocket: true,
      httpMethods: ['GET'],
      preHandler: (request, reply, done) => {
        const chemin = request.url.split('?')[0] ?? ''
        if (chemin === CONTROL_PATH || controlRoomIdFromPath(chemin) != null) {
          return reply.callNotFound()
        }
        done()
      },
    })

    /*
     * Le proxy ne doit voir que ce qui le regarde.
     *
     * `@fastify/http-proxy` pose son propre écouteur `upgrade` et route **tout**
     * ce qui arrive par le routeur Fastify — y compris `/ws`, le transport des
     * salles, qui n'y a pas de route. Il part donc en 404, et le proxy détruit
     * son socket à la fin de la réponse. Résultat : aucune salle ne peut se
     * connecter dès que le proxy est monté, ce qui en développement était le
     * cas exact où personne ne regardait — il ne se montait que faute de bundle
     * construit, donc surtout sur un dépôt fraîchement cloné.
     *
     * **Un seul écouteur pour les deux proxys**, et c'est le plugin qui en
     * décide : il le pose une fois par serveur (`kWsUpgradeListener`) puis
     * dispatche par le routeur, si bien que la console et la régie le
     * partagent. Compter ici reste le garde-fou — le jour où le plugin en pose
     * un par instance, le filtre ne couvrirait plus que le premier, et les
     * salles retomberaient dans la panne muette qu'il existe pour éviter.
     */
    const ajoutes = app.server.listeners('upgrade').slice(avant)
    if (ajoutes.length !== 1) {
      throw new Error(
        `Les proxys Vite ont posé ${ajoutes.length} écouteurs « upgrade » au lieu d'un : ` +
          'le filtre qui protège le transport des salles ne sait plus lequel envelopper.',
      )
    }
    const dispatch = ajoutes[0] as (...args: unknown[]) => void
    app.server.removeListener('upgrade', dispatch)
    app.server.on('upgrade', (request, socket, head) => {
      if (request.url?.startsWith('/ws') === true) return
      dispatch(request, socket, head)
    })
  }

  for (const chemin of cheminsConsole) {
    app.get(chemin, async (_request, reply) => {
      reply.header('content-type', 'text/html; charset=utf-8')
      // Jamais `immutable` sur la coquille : une console mise à jour qui ne
      // l'est jamais sur le poste d'un opérateur est pire que la retélécharger.
      reply.header('cache-control', 'no-store')
      if (bundle == null && !dev) {
        /*
         * Le bundle manque, et il n'y a plus de gabarit derrière.
         *
         * Ce n'est pas un état d'exploitation : l'image du hub construit la
         * console à l'étape « Console » du Dockerfile, donc l'absence signale
         * un déploiement incomplet. Le dire en toutes lettres vaut mieux qu'un
         * 404, qui enverrait chercher du côté de l'adresse.
         */
        reply.status(503)
        return reply.send(
          'Console non construite. Depuis les sources : ' +
            'pnpm --filter @cloudnord/hub-admin build',
        )
      }
      return reply.send(
        renderConsoleShell({
          mode: config.mode,
          event: services.identity.get(),
          google: config.googleClientId == null ? null : { domaine: config.googleHostedDomain! },
          assets: dev ? assetsDeDeveloppement() : assetsDeProduction(bundle!.manifeste),
        }),
      )
    })
  }

  /**
   * La régie mobile : l'écran de choix, puis une salle.
   *
   * Deux adresses parce que **chaque écran est une adresse**, comme les onglets
   * de la console : la page rafraîchie rouvre la salle qu'on pilotait, le lien
   * se met en favori et s'envoie à un collègue, et le bouton Retour ramène au
   * choix plutôt que de quitter.
   *
   * Rien n'est vérifié ici sur la salle ni sur l'opérateur : la coquille est
   * publique, comme celle de la console, et c'est le premier appel oRPC qui
   * demande une session. Résoudre une salle avant de rendre la page rendrait un
   * 404 à qui n'est pas connecté, ce qui se lit comme une adresse morte.
   */
  const rendreRegie = async (roomId: string | null, reply: FastifyReply): Promise<unknown> => {
    reply.header('content-type', 'text/html; charset=utf-8')
    // Jamais `immutable` : la coquille porte l'amorce de portée, et la salle
    // qu'elle nomme change d'une adresse à l'autre.
    reply.header('cache-control', 'no-store')

    if (bundleRegie == null && !dev) {
      /*
       * Le bundle manque, et il n'y a pas de gabarit derrière.
       *
       * Le dire en toutes lettres vaut mieux qu'un 404, qui enverrait chercher
       * du côté de l'adresse — c'est la même réponse que sert un poste de salle
       * dans le même cas.
       */
      reply.status(503)
      return reply.send(
        'Régie non construite. Depuis les sources : ' +
          'pnpm --filter @cloudnord/regie-web build',
      )
    }

    return reply.send(
      renderRegieMobileShell({
        event: services.identity.get(),
        roomId,
        salles: services.rooms.list().map((salle) => ({ id: salle.id, name: salle.name })),
        google: config.googleClientId == null ? null : { domaine: config.googleHostedDomain! },
        assets: dev
          ? assetsDeDeveloppementRegie()
          : assetsDeProductionRegie(bundleRegie!.manifeste),
      }),
    )
  }

  app.get(CONTROL_PATH, async (_request, reply) => rendreRegie(null, reply))
  app.get<{ Params: { roomId: string } }>('/regie/:roomId', async (request, reply) =>
    rendreRegie(request.params.roomId, reply),
  )

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
      /*
       * En développement, `/admin/` appartient au proxy Vite : le rechargement
       * à chaud passe par un WebSocket, et le détruire ici couperait exactement
       * ce qu'on vient chercher. Ailleurs, rien d'autre n'écoute — un socket
       * laissé ouvert fuirait.
       */
      if (!dev) socket.destroy()
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
    /*
     * Les verrous de régie mobile périmés, **avant** le retour anticipé.
     *
     * Ce balayage n'a rien à voir avec le push, et il doit tourner même quand
     * personne n'est abonné — c'est le cas normal d'un hub de développement.
     * Il ne décide de rien : `regie.lock()` écarte déjà un verrou périmé à la
     * lecture. Il éteint le badge « pilotée à distance » resté allumé en salle,
     * ce que seule une commande peut faire.
     */
    for (const roomId of services.regie.sweep()) {
      services.commands.publish(roomId, { type: 'regie.hold', holder: null }, null)
      app.log.info({ roomId }, 'verrou de régie mobile expiré')
    }

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
