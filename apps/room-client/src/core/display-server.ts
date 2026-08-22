import Fastify, { type FastifyInstance } from 'fastify'
import {
  openFeedbackUrl,
  sessionsForRoom,
  type Program,
  type Session,
  type SponsorTier,
} from '@cloudnord/program'
import type { AssetCache } from './assets.js'
import type { NiveauEntree } from './obs.js'
import type { DisplayState, RoomRuntime } from './runtime.js'
import { renderProjectorPage } from './display-page.js'
import { renderOverlayPage } from './overlay-page.js'
import { renderOverlayLivePage } from './overlay-live-page.js'
import { renderRegiePage } from './regie-page.js'
import {
  controlActionSchema,
  runControlAction,
  type ControlDiagnostics,
  type ControlTarget,
} from './control-api.js'

export interface DisplayPayload {
  state: DisplayState
  /** Nom lisible de la salle. `state.roomId` est un identifiant technique. */
  roomName: string | null
  event: Program['event'] | null
  timezone: string
  sessions: Session[]
  sponsorTiers: SponsorTier[]
  /** Présent seulement pour la régie ; l'écran projeté n'en a pas besoin. */
  diagnostics: ControlDiagnostics | null
  /** Adresse du mur public et son QR (SVG en ligne), pour l'écran de salle. */
  wall: { url: string; qrSvg: string } | null
  /**
   * Ce qui arrive dans les **autres** salles.
   *
   * Calculé ici, depuis le programme déjà en cache : le hub n'a rien à en dire
   * que la salle ne sache déjà, et la boucle d'attente doit se dérouler entière
   * sans réseau. Sert à la page « pendant ce temps, à côté » — la seule chose
   * qu'un participant en salle ne peut pas deviner.
   */
  otherRooms: {
    roomId: string
    name: string
    /** Prochaine conférence à commencer, ou celle en cours si elle court. */
    session: { id: string; title: string; startsAt: string; speakers: string[] } | null
    /** Vrai si elle a déjà commencé : « en ce moment » plutôt que « à HH:MM ». */
    enCours: boolean
  }[]
  /** Comptes de l'événement, réglés sur le hub. Vide = la boucle saute cette page. */
  socialLinks: { network: string; handle: string; url: string }[]
  /**
   * QR OpenFeedback du talk en cours.
   *
   * Fabriqué hors ligne : OpenFeedback réutilise les identifiants de session de
   * l'export amont, donc l'adresse se déduit du programme déjà en cache. `null`
   * quand aucune conférence ne court, ou sans projet configuré.
   */
  feedback: { url: string; qrSvg: string } | null
  /** Appairage de la machine : la régie s'en sert pour afficher le code. */
  pairing: {
    status: string
    userCode?: string
    verificationUri?: string
    message?: string
    rooms?: { id: string; name: string }[]
    requestedRoomId?: string | null
  } | null
}

/** Les trois pages servies, chacune n'ayant pas les mêmes besoins. */
export type VueAffichage = 'projecteur' | 'overlay' | 'bandeau' | 'regie'

/**
 * Ce que chaque vue reçoit réellement.
 *
 * L'overlay ne lit que deux champs sur neuf : lui pousser le programme complet
 * de la salle, les sponsors et le QR du mur à chaque changement d'état coûte
 * une trentaine de kilo-octets pour rien. Le test `vues-du-flux` vérifie que
 * ces listes couvrent bien ce que chaque page consulte — un champ ajouté à une
 * page sans l'être ici produirait un rendu muet, pas une erreur.
 */
export const CHAMPS_PAR_VUE: Record<VueAffichage, readonly (keyof DisplayPayload)[]> = {
  projecteur: [
    'state', 'roomName', 'event', 'timezone', 'sessions', 'sponsorTiers', 'wall', 'feedback',
    // Deux champs pour la seule boucle d'attente : ils ne bougent qu'au
    // changement de créneau et au sync, donc ils ne coûtent rien au flux.
    'otherRooms', 'socialLinks',
  ],
  overlay: ['state', 'event'],
  // Le bandeau ne lit que `state.liveMessage` : lui pousser le programme et
  // les sponsors coûterait trente kilo-octets par changement d'écran.
  bandeau: ['state'],
  regie: ['state', 'roomName', 'timezone', 'sessions', 'diagnostics', 'pairing'],
}

/** Un abonné au flux : sa vue, et la dernière valeur qu'il a reçue par champ. */
interface AbonneFlux {
  vue: VueAffichage | null
  dernier: Record<string, string>
  ecrire: (evenement: string | null, corps: string) => void
}

export interface DisplayServerOptions {
  runtime: RoomRuntime
  assets: AssetCache
  /** Programme courant, déjà en cache local — relu à chaque requête pour suivre les resyncs. */
  program: () => { contentHash: string; program: Program } | null
  /** Nom d'affichage de la salle, issu de la configuration reçue du hub. */
  roomName?: () => string | null
  /** Configuration de la salle, pour le projet OpenFeedback. Relue à chaque envoi. */
  roomConfig?: () => { openFeedbackProjectId: string | null } | null
  /** Origine publique du hub, pour construire l'URL du mur affichée en QR. */
  hubOrigin?: string
  /** Cible des actions de régie. Absente, l'interface reste en lecture seule. */
  control?: ControlTarget
  /** État d'appairage, relu à chaque envoi. */
  pairing?: () => DisplayPayload['pairing']
  /** Comptes de l'événement, relus du cache local à chaque envoi. */
  socialLinks?: () => DisplayPayload['socialLinks']
  /**
   * Signale qu'une régie regarde (ou non) les niveaux audio.
   *
   * Le vumètre d'OBS émet une cinquantaine de fois par seconde : on ne s'y
   * abonne que tant qu'une page l'affiche, et on s'en détache dès qu'elle se
   * ferme. Une salle dont personne ne regarde les niveaux n'en paie pas le prix.
   */
  onNiveauxDemandes?: (actif: boolean) => void
  host?: string
  port?: number
}

/**
 * Serveur local qui sert l'écran de salle.
 *
 * La même URL alimente la Browser Source d'OBS-A **et** une fenêtre Electron
 * plein écran de secours : si OBS plante, l'opérateur bascule sur la fenêtre
 * native et la projection continue.
 */
export class DisplayServer {
  private readonly app: FastifyInstance
  private readonly clients = new Set<AbonneFlux>()
  private readonly abonnesNiveaux = new Set<(corps: string) => void>()
  /**
   * QR du mur, calculé une seule fois par salle.
   *
   * Le régénérer à chaque envoi d'état coûterait un rendu par seconde pour une
   * image qui ne change jamais.
   */
  private wallCache: { url: string; qrSvg: string } | null = null
  private wallCacheKey: string | null = null
  /** Même raison pour le QR OpenFeedback, qui change à chaque conférence. */
  private feedbackCache: { url: string; qrSvg: string } | null = null
  private feedbackCacheKey: string | null = null
  private readonly surChangement: () => void

  constructor(private readonly options: DisplayServerOptions) {
    this.app = Fastify({ logger: false })
    this.registerRoutes()
    // Rediffuse à chaque changement d'état : l'écran n'interroge jamais.
    this.surChangement = () => this.broadcast()
    options.runtime.on('state', this.surChangement)
  }

  private payload(): DisplayPayload {
    const cached = this.options.program()
    const state = this.options.runtime.state()
    const roomName = this.options.roomName?.() ?? null
    const diagnostics = this.options.control?.diagnostics() ?? null
    const wall = this.wallFor(state.roomId)
    const feedback = this.feedbackPour(state.currentSession?.id ?? null)
    const pairing = this.options.pairing?.() ?? null
    const socialLinks = this.options.socialLinks?.() ?? []
    if (cached == null) {
      return {
        state,
        roomName,
        event: null,
        timezone: 'Europe/Paris',
        sessions: [],
        sponsorTiers: [],
        diagnostics,
        wall,
        feedback,
        pairing,
        otherRooms: [],
        socialLinks,
      }
    }

    // Les URLs sont réécrites vers le cache local : la page ne doit jamais
    // dépendre d'Internet pendant l'événement.
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
      otherRooms: this.autresSalles(program, state.roomId),
      socialLinks,
    }
  }

  /**
   * Ce qui se joue, ou va se jouer, dans les autres salles.
   *
   * Calculé sur le programme en cache et l'horloge corrigée du hub — jamais sur
   * l'heure du poste, qui peut en être à des semaines quand le hub tourne sur
   * une horloge simulée. Les pauses sont écartées : « Déjeuner en Track #2 »
   * n'aide personne à choisir où aller.
   */
  private autresSalles(program: Program, roomId: string | null): DisplayPayload['otherRooms'] {
    const at = this.options.runtime.correctedNow()
    return program.rooms
      .filter((salle) => salle.id !== roomId)
      .map((salle) => {
        const creneaux = sessionsForRoom(program, salle.id).filter((c) => c.kind === 'talk')
        // En cours d'abord, sinon la prochaine à commencer : entre deux talks,
        // c'est l'heure du suivant qu'on vient chercher.
        const courant = creneaux.find(
          (c) => c.startsAtMs <= at && (c.endsAtMs == null || at < c.endsAtMs),
        )
        const session = courant ?? creneaux.find((c) => c.startsAtMs > at) ?? null
        return {
          roomId: salle.id,
          name: salle.name,
          session:
            session == null
              ? null
              : {
                  id: session.id,
                  title: session.title,
                  startsAt: session.startsAt,
                  speakers: session.speakers.map((personne) => personne.name),
                },
          enCours: session != null && session === courant,
        }
      })
  }

  /**
   * QR OpenFeedback de la conférence en cours.
   *
   * Aucune requête : l'adresse se fabrique depuis le programme déjà en cache —
   * voir `openFeedbackUrl`, partagé avec le hub pour que le lien affiché dans
   * la console et le QR projeté ne puissent pas diverger. Le QR se dessine donc
   * même réseau coupé, ce qui est bien le moment où l'on ne veut pas d'une
   * image manquante à l'écran.
   */
  private feedbackPour(sessionId: string | null): { url: string; qrSvg: string } | null {
    const config = this.options.roomConfig?.() ?? null
    const projet = config?.openFeedbackProjectId ?? null
    if (projet == null || sessionId == null) return null
    if (this.feedbackCacheKey === sessionId && this.feedbackCache != null) return this.feedbackCache

    const cached = this.options.program()
    const session = cached?.program.sessions.find((creneau) => creneau.id === sessionId) ?? null
    if (session == null) return null
    const url = openFeedbackUrl(session, projet, cached?.program.timezone ?? 'Europe/Paris')
    if (url == null) return null

    this.feedbackCacheKey = sessionId
    this.feedbackCache = { url, qrSvg: this.qrFeedback.get(sessionId) ?? '' }
    void this.preparerQrFeedback(sessionId, url)
    return this.feedbackCache
  }

  /** QR dessiné en tâche de fond : le prochain envoi d'état le portera. */
  private async preparerQrFeedback(sessionId: string, url: string): Promise<void> {
    if (this.qrFeedback.has(sessionId)) return
    this.qrFeedback.set(sessionId, '')
    const { toString } = await import('qrcode')
    const svg = await toString(url, {
      type: 'svg',
      margin: 1,
      errorCorrectionLevel: 'H',
      color: { dark: '#0d0f16', light: '#ffffff' },
    })
    this.qrFeedback.set(sessionId, svg)
    this.feedbackCacheKey = null
    this.broadcast()
  }

  /** Prépare (une fois) l'URL du mur et son QR pour la salle courante. */
  private wallFor(roomId: string | null): { url: string; qrSvg: string } | null {
    const origin = this.options.hubOrigin
    if (origin == null || roomId == null) return null
    if (this.wallCacheKey === roomId && this.wallCache != null) return this.wallCache

    const url = `${origin.replace(/\/$/, '')}/mur?salle=${encodeURIComponent(roomId)}`
    this.wallCacheKey = roomId
    this.wallCache = { url, qrSvg: this.pendingQr.get(roomId) ?? '' }
    return this.wallCache
  }

  /** QR rendus en amont : la génération est synchrone mais pas gratuite. */
  private readonly pendingQr = new Map<string, string>()
  /** QR OpenFeedback déjà dessinés, par conférence. */
  private readonly qrFeedback = new Map<string, string>()

  /**
   * Prégénère le QR d'une salle.
   *
   * Appelé au sync : à ce moment on connaît la salle, et l'écran peut ensuite
   * afficher le mur sans latence.
   */
  async prepareWallQr(roomId: string, url: string): Promise<void> {
    const { toString } = await import('qrcode')
    const svg = await toString(url, {
      type: 'svg',
      margin: 1,
      // Correction élevée : le QR est photographié de loin, parfois de biais,
      // souvent sur un vidéoprojecteur peu contrasté.
      errorCorrectionLevel: 'H',
      color: { dark: '#0d0f16', light: '#ffffff' },
    })
    this.pendingQr.set(roomId, svg)
    this.wallCacheKey = null
    this.broadcast()
  }

  /**
   * Sérialise l'état une fois, champ par champ.
   *
   * Découper à ce niveau permet de comparer et de n'envoyer que ce qui bouge,
   * sans sérialiser deux fois : les chaînes produites ici sont celles qui
   * partent sur le fil.
   */
  private champsSerialises(): Record<string, string> {
    const payload = this.payload() as unknown as Record<string, unknown>
    const sortie: Record<string, string> = {}
    for (const [cle, valeur] of Object.entries(payload)) sortie[cle] = JSON.stringify(valeur ?? null)
    return sortie
  }

  /** Assemble un objet JSON à partir de champs déjà sérialisés. */
  private static assembler(champs: Record<string, string>, cles: readonly string[]): string {
    return `{${cles.map((cle) => `${JSON.stringify(cle)}:${champs[cle] ?? 'null'}`).join(',')}}`
  }

  /** Champs visibles par une vue, dans l'ordre de la charge utile. */
  private static clesDeVue(champs: Record<string, string>, vue: VueAffichage | null): string[] {
    const cles = Object.keys(champs)
    if (vue == null) return cles
    const autorises = new Set<string>(CHAMPS_PAR_VUE[vue] as readonly string[])
    return cles.filter((cle) => autorises.has(cle))
  }

  /**
   * Rediffuse ce qui a changé, à ceux que ça concerne.
   *
   * Deux propriétés voulues : un abonné dont rien n'a bougé ne reçoit **rien**
   * (le tic d'horloge de la salle ne doit pas générer de trafic), et un abonné
   * ne reçoit jamais un champ qu'il ne lit pas.
   */
  /**
   * Diffuse les niveaux audio.
   *
   * Volontairement hors du flux d'état : à 10 envois par seconde, les faire
   * passer par la charge utile complète republierait tout l'état — programme
   * compris — cent fois plus souvent que nécessaire.
   */
  publierNiveaux(inputs: NiveauEntree[]): void {
    if (this.abonnesNiveaux.size === 0) return
    const corps = JSON.stringify({ inputs })
    for (const ecrire of this.abonnesNiveaux) ecrire(corps)
  }

  private broadcast(): void {
    const champs = this.champsSerialises()
    for (const abonne of this.clients) {
      const cles = DisplayServer.clesDeVue(champs, abonne.vue)
      const modifies = cles.filter((cle) => abonne.dernier[cle] !== champs[cle])
      if (modifies.length === 0) continue
      for (const cle of modifies) abonne.dernier[cle] = champs[cle] ?? 'null'
      abonne.ecrire('delta', DisplayServer.assembler(champs, modifies))
    }
  }

  private registerRoutes(): void {
    this.app.get('/health', async () => ({ ok: true }))

    this.app.get('/display/projector', async (_request, reply) => {
      reply.header('content-type', 'text/html; charset=utf-8')
      // L'état est embarqué : pas d'écran vide au rechargement de la Browser Source.
      return reply.send(renderProjectorPage({ initialPayload: this.payload() }))
    })

    /**
     * Bandeau live : une source de plus, posée où l'on veut qu'un message
     * apparaisse — y compris dans la scène LIVE d'OBS-A, par-dessus les slides.
     */
    this.app.get('/display/overlay-live', async (_request, reply) => {
      reply.header('content-type', 'text/html; charset=utf-8')
      return reply.send(renderOverlayLivePage({ initialPayload: this.payload() }))
    })

    this.app.get('/display/overlay', async (_request, reply) => {
      reply.header('content-type', 'text/html; charset=utf-8')
      return reply.send(renderOverlayPage({ initialPayload: this.payload() }))
    })

    this.app.get('/regie', async (_request, reply) => {
      reply.header('content-type', 'text/html; charset=utf-8')
      return reply.send(renderRegiePage({ initialPayload: this.payload() }))
    })

    /**
     * Actions de régie.
     *
     * Validées avant d'atteindre OBS, et jamais propagées en exception : un
     * échec revient à l'opérateur sous forme de message, pas d'une page cassée
     * au milieu d'une intervention.
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
      // L'état a pu changer : on repousse immédiatement plutôt que d'attendre un tic.
      this.broadcast()
      return reply.status(outcome.ok ? 200 : 409).send(outcome)
    })

    /**
     * Programme d'une autre salle, à la demande.
     *
     * Volontairement hors du flux d'état : embarquer les 27 sessions de
     * l'événement dans chaque envoi SSE coûterait à chaque changement d'écran,
     * pour une donnée que la régie ne consulte qu'à l'ouverture d'un onglet.
     */
    this.app.get<{ Querystring: { salle?: string } }>('/display/sessions', async (request, reply) => {
      const cached = this.options.program()
      if (cached == null) return { rooms: [], sessions: [], roomId: null }

      const program = this.options.assets.localize(cached.program)
      const roomId = request.query.salle ?? null
      if (roomId != null && !program.rooms.some((salle) => salle.id === roomId)) {
        return reply.status(404).send({ error: 'salle inconnue au programme' })
      }
      return {
        roomId,
        rooms: program.rooms.map((salle) => ({ id: salle.id, name: salle.name })),
        sessions: roomId == null ? [] : sessionsForRoom(program, roomId),
      }
    })

    this.app.get('/display/data', async () => this.payload())

    /**
     * Flux d'état en SSE, et non en WebSocket.
     *
     * Le navigateur reconnecte un `EventSource` tout seul, sans une ligne de
     * code côté page. Pour l'écran du vidéoprojecteur — celui qui ne doit
     * jamais rester figé et qui n'a aucune étape de build — c'est exactement la
     * propriété qu'on veut. Le flux est unidirectionnel de toute façon.
     */
    this.app.get<{ Querystring: { vue?: string } }>('/display/state', (request, reply) => {
      reply.raw.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
      })

      const demandee = (request.query as { vue?: string } | undefined)?.vue
      const vue: VueAffichage | null =
        demandee === 'projecteur' || demandee === 'overlay' || demandee === 'bandeau' || demandee === 'regie'
          ? demandee
          : null

      const ecrire = (evenement: string | null, corps: string): void => {
        reply.raw.write(`${evenement == null ? '' : `event: ${evenement}\n`}data: ${corps}\n\n`)
      }

      // Instantané complet à l'ouverture : c'est aussi ce qui répare la page
      // après une reconnexion d'`EventSource`, sans logique de reprise à écrire.
      const champs = this.champsSerialises()
      const cles = DisplayServer.clesDeVue(champs, vue)
      const abonne: AbonneFlux = { vue, dernier: {}, ecrire }
      for (const cle of cles) abonne.dernier[cle] = champs[cle] ?? 'null'
      ecrire(null, DisplayServer.assembler(champs, cles))
      this.clients.add(abonne)

      // Battement régulier : garde la connexion ouverte à travers les proxys et
      // révèle une page morte plutôt que de la laisser figée en silence. C'est
      // désormais le seul trafic d'une salle au repos.
      const heartbeat = setInterval(() => reply.raw.write(': ping\n\n'), 10_000)

      request.raw.on('close', () => {
        clearInterval(heartbeat)
        this.clients.delete(abonne)
      })
    })

    /**
     * Niveaux audio, en flux séparé.
     *
     * Séparé pour deux raisons : la cadence (10 Hz contre quelques messages par
     * heure pour l'état), et le fait que seule la régie s'en sert. Fermer la
     * page suffit à couper l'abonnement chez OBS.
     */
    this.app.get('/display/audio', (request, reply) => {
      reply.raw.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
      })

      const ecrire = (corps: string): void => {
        reply.raw.write(`data: ${corps}\n\n`)
      }

      // Premier octet immédiat : sans lui, les en-têtes ne partent pas et le
      // flux ne s'ouvre côté page qu'à la première mesure — donc jamais si la
      // salle est silencieuse ou si OBS n'est pas encore là.
      reply.raw.write(': flux ouvert\n\n')

      const premier = this.abonnesNiveaux.size === 0
      this.abonnesNiveaux.add(ecrire)
      if (premier) this.options.onNiveauxDemandes?.(true)

      const heartbeat = setInterval(() => reply.raw.write(': ping\n\n'), 10_000)

      request.raw.on('close', () => {
        clearInterval(heartbeat)
        this.abonnesNiveaux.delete(ecrire)
        if (this.abonnesNiveaux.size === 0) this.options.onNiveauxDemandes?.(false)
      })
    })

    this.app.get<{ Params: { sha256: string } }>('/assets/:sha256', async (request, reply) => {
      const asset = await this.options.assets.read(request.params.sha256)
      if (asset == null) return reply.status(404).send({ error: 'asset absent du cache' })
      reply.header('content-type', asset.contentType ?? 'application/octet-stream')
      // Adressé par contenu : jamais réécrit, donc cacheable indéfiniment.
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
    // Se désabonner d'abord : sans ça, un dernier changement d'état déclenche
    // une lecture du programme sur une base déjà fermée.
    this.options.runtime.off('state', this.surChangement)
    this.clients.clear()
    await this.app.close()
  }
}
