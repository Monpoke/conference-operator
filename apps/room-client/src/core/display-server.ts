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

/** Un abonné au flux : sa vue, et la dernière valeur qu'il a reçue par champ. */
interface AbonneFlux {
  vue: DisplayView | null
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
  /**
   * Serveur Vite de la régie, en développement seulement.
   *
   * Renseigné, le poste proxifie Vite sous `/regie/` et la coquille pointe
   * sur lui : le rechargement à chaud fonctionne sans que la page ait à sortir
   * de son origine. Absent — le cas de tout poste installé — c'est le bundle
   * construit qui est servi, et rien d'autre n'est possible.
   */
  viteOrigin?: string | null
  /**
   * Où trouver le bundle de la régie refaite.
   *
   * Injectable, et pas par goût de l'injection : `resolveControlBundle()` remonte les
   * dossiers jusqu'à tomber sur un `dist/`, si bien qu'un test passait ou non
   * selon qu'un build traînait sur la machine. Le hub s'est fait prendre au
   * même piège avec la console, et le défaut ne se voit qu'en CI, une fois.
   */
  bundleRegie?: () => { directory: string; manifest: string } | null
  /** Cible des actions de régie. Absente, l'interface reste en lecture seule. */
  control?: ControlTarget
  /** État d'appairage, relu à chaque envoi. */
  pairing?: () => DisplayPayload['pairing']
  /** Comptes de l'événement, relus du cache local à chaque envoi. */
  socialLinks?: () => DisplayPayload['socialLinks']
  /** Identité de l'événement, relue du cache local à chaque envoi. */
  event?: () => DisplayPayload['eventIdentity']
  /**
   * Signale qu'une régie regarde (ou non) les niveaux audio.
   *
   * Le vumètre d'OBS émet une cinquantaine de fois par seconde : on ne s'y
   * abonne que tant qu'une page l'affiche, et on s'en détache dès qu'elle se
   * ferme. Une salle dont personne ne regarde les niveaux n'en paie pas le prix.
   */
  onNiveauxDemandes?: (actif: boolean) => void
  /** Charge du poste, relevée à la demande. Par défaut, celle de cette machine. */
  hote?: () => HostLoad
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
  /**
   * Relevé de charge du poste.
   *
   * Créé ici, et non à chaque requête : la mesure est une **différence** entre
   * deux lectures des compteurs du noyau, donc elle n'existe que si quelqu'un
   * garde le repère précédent.
   */
  private readonly hote: () => HostLoad

  constructor(private readonly options: DisplayServerOptions) {
    this.hote = options.hote ?? hostMonitor()
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
      eventIdentity,
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
        /**
         * La position se calcule sur **tous** les créneaux, les pauses
         * comprises, et on ne retient que les conférences ensuite.
         *
         * L'ordre compte : la fin d'un créneau se déduit du début du suivant
         * quand l'export ne la donne pas, et chercher directement dans une
         * liste filtrée faisait sauter la pause qui le ferme. Un talk sans
         * heure de fin restait alors « en cours » sur l'écran d'à côté jusqu'à
         * la fin de la journée.
         */
        const creneaux = sessionsForRoom(program, salle.id)
        const { current } = timelinePosition(creneaux, at)
        // Les pauses sont écartées ici : « Déjeuner en Track #2 » n'aide
        // personne à choisir où aller.
        const courant = current?.kind === 'talk' ? current : null
        const session =
          courant ?? creneaux.find((c) => c.kind === 'talk' && c.startsAtMs > at) ?? null
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
          running: session != null && session === courant,
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
    const url = openFeedbackUrl(session, projet, cached?.program.timezone ?? DEFAULT_TIMEZONE)
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
  private static clesDeVue(champs: Record<string, string>, vue: DisplayView | null): string[] {
    const cles = Object.keys(champs)
    if (vue == null) return cles
    const autorises = new Set<string>(FIELDS_BY_VIEW[vue] as readonly string[])
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
  publierNiveaux(inputs: InputLevel[]): void {
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

  /**
   * La fenêtre de l'opérateur.
   *
   * Un bundle, et non plus un gabarit d'une seule pièce : la page pilote OBS
   * pendant qu'une salle est pleine, et trois mille lignes de chaînes de
   * caractères ne se relisaient plus. Le poste rend toujours la coquille
   * lui-même, avec l'état complet dedans — voir `regie-shell.ts`.
   */
  private registerRegie(): void {
    const bundle = (this.options.bundleRegie ?? resolveControlBundle)()
    const vite = this.options.viteOrigin ?? null

    /*
     * Vite passe devant le bundle, et non l'inverse.
     *
     * L'ordre contraire semblait plus prudent — un poste installé n'a pas de
     * Vite, une variable qui traîne ne doit pas le détourner. Il rendait en
     * fait le développement impossible : `pnpm test` construit le bundle, et un
     * `dist/` vieux de trois jours prenait alors le pas sur le serveur qui
     * tourne. On développait sur une régie compilée, sans rechargement à chaud,
     * et l'extension Vue refusait d'inspecter une page qu'elle voyait en mode
     * production.
     *
     * Un `dist/` est un artefact ; une origine Vite est une intention. C'est
     * l'intention qui gagne.
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

    // Développement : Vite derrière le poste, jamais devant. Le poste porte le
    // flux d'état, les actions et le vumètre ; les faire transiter par Vite
    // pour le seul confort du rechargement à chaud serait payer cher.
    if (vite != null) {
      void this.app.register(fastifyProxy, {
        upstream: vite,
        prefix: '/regie/',
        rewritePrefix: '/regie/',
        websocket: true,
        httpMethods: ['GET'],
        preHandler: (request, reply, done) => {
          // La coquille est rendue ici : le proxy ne prend que ce que Vite sait
          // rendre, et surtout pas l'adresse qui porte l'état embarqué.
          if ((request.url.split('?')[0] ?? '') === '/regie') return reply.callNotFound()
          done()
        },
      })
    }

    this.app.get('/regie', async (_request, reply) => {
      reply.header('content-type', 'text/html; charset=utf-8')
      // Jamais `immutable` sur la coquille : elle porte l'état de la salle, qui
      // change à chaque seconde de la journée.
      reply.header('cache-control', 'no-store')

      if (vite == null && bundle == null) {
        /*
         * Le bundle manque, et aucun Vite n'est annoncé.
         *
         * Ce n'est pas un état d'exploitation : l'empaquetage embarque le
         * bundle. Le dire en toutes lettres vaut mieux qu'un 404, qui enverrait
         * chercher du côté de l'adresse.
         */
        reply.status(503)
        return reply.send(
          'Régie non construite. Depuis les sources : ' +
            'pnpm --filter @cloudnord/regie-web build',
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

    this.registerRegie()

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
     * Rushes produits, à la demande.
     *
     * Hors du flux d'état, et pour la même raison que le programme des autres
     * salles : lire le dossier des captations à chaque tic coûterait un accès
     * disque par seconde pour une liste qu'on ouvre trois fois dans la journée.
     * Rien n'est sondé ici — ouvrir la modale ne doit pas lancer une série de
     * ffprobe pendant qu'une conférence tourne.
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
     * Aperçu d'un rush, produit à la volée.
     *
     * Vingt secondes remballées en MP4 fragmenté, et jamais le fichier entier :
     * les rushes d'OBS sont des Matroska, qu'aucun navigateur ne sait ouvrir, et
     * ils pèsent plusieurs gigaoctets. L'extrait répond à la seule question
     * qu'on se pose devant la liste — « est-ce qu'il y a une image et du son ? »
     * — sans rien écrire sur le disque ni attendre un téléchargement.
     */
    this.app.get<{ Querystring: { file?: string; at?: string; duree?: string } }>(
      '/control/recordings/extrait',
      async (request, reply) => {
        if (this.options.control == null) {
          return reply.status(503).send({ ok: false, message: 'Régie indisponible' })
        }
        const fichier = request.query.file
        if (fichier == null || fichier.length === 0) {
          return reply.status(400).send({ ok: false, message: 'Fichier non précisé' })
        }

        let extrait: Awaited<ReturnType<ControlTarget['readRecordingExtract']>>
        try {
          extrait = await this.options.control.readRecordingExtract(
            fichier,
            Number(request.query.at ?? 0) || 0,
            Number(request.query.duree ?? 20_000) || 20_000,
          )
        } catch (cause) {
          return reply.status(409).send({ ok: false, message: (cause as Error).message })
        }
        if (extrait == null) {
          return reply.status(503).send({ ok: false, message: 'ffmpeg introuvable sur cette machine' })
        }

        // Le flux s'écrit au fil de l'encodage : ni longueur connue, ni tranche
        // possible. Le lecteur le prend comme un direct, ce qu'il est.
        reply.header('content-type', 'video/mp4')
        reply.header('accept-ranges', 'none')
        reply.header('cache-control', 'no-store')
        // Refermer la modale ne doit pas laisser un ffmpeg tourner sur la
        // machine qui enregistre la conférence suivante.
        request.raw.on('close', () => extrait.arreter())
        return reply.send(extrait.flux)
      },
    )

    /**
     * Le rush tel quel, par tranche.
     *
     * Pour l'ouvrir dans un lecteur qui sait lire du Matroska, ou le rapatrier
     * sur une autre machine — ce qu'un aperçu de vingt secondes ne remplacera
     * jamais.
     */
    this.app.get<{ Querystring: { file?: string } }>(
      '/control/recordings/fichier',
      async (request, reply) => {
        if (this.options.control == null) {
          return reply.status(503).send({ ok: false, message: 'Régie indisponible' })
        }
        const fichier = request.query.file
        if (fichier == null || fichier.length === 0) {
          return reply.status(400).send({ ok: false, message: 'Fichier non précisé' })
        }

        let flux: Awaited<ReturnType<ControlTarget['readRecordingFile']>>
        try {
          flux = await this.options.control.readRecordingFile(fichier, request.headers.range ?? null)
        } catch (cause) {
          return reply.status(409).send({ ok: false, message: (cause as Error).message })
        }
        if (flux == null) return reply.status(404).send({ ok: false, message: 'Fichier absent du disque' })

        const partiel = flux.debut > 0 || flux.fin < flux.taille - 1
        reply.header('content-type', flux.type)
        reply.header('accept-ranges', 'bytes')
        reply.header('content-length', String(flux.fin - flux.debut + 1))
        if (partiel) {
          reply.header('content-range', `bytes ${flux.debut}-${flux.fin}/${flux.taille}`)
          reply.status(206)
        }
        request.raw.on('close', () => flux.flux.destroy())
        return reply.send(flux.flux)
      },
    )

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

    /**
     * Charge du poste, à la demande.
     *
     * Hors du flux d'état, et c'est le point : un chiffre qui bouge chaque
     * seconde placé dans la charge utile republierait tout le diagnostic —
     * salles, journal, configuration — à chaque tic, alors qu'une salle au
     * repos ne doit générer aucun trafic. Ici, seule la régie ouverte
     * interroge, et elle interroge une réponse de trois champs.
     */
    this.app.get('/control/host', async () => this.hote())

    /**
     * Téléversements en cours, et pourquoi rien ne part.
     *
     * Hors du flux d'état pour la même raison que la charge du poste : un
     * pourcentage qui avance republierait tout le diagnostic à chaque part.
     * La modale des enregistrements l'interroge tant qu'elle est ouverte, et
     * personne ne paie rien quand elle est fermée.
     */
    this.app.get('/control/uploads', async (_request, reply) => {
      if (this.options.control?.vodUploads == null) {
        return reply.status(503).send({ ok: false, message: 'Régie indisponible' })
      }
      return { ok: true, ...this.options.control.vodUploads() }
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
      const vue: DisplayView | null =
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
