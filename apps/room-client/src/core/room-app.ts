import { join } from 'node:path'
import { AssetCache } from './assets.js'
import { DisplayServer } from './display-server.js'
import { HubLink } from './hub-link.js'
import { ObsController } from './obs.js'
import { httpPairingTransport, runPairing, type DeviceCodeResponse } from './pairing.js'
import { createORPCClient } from '@orpc/client'
import { RPCLink as FetchLink } from '@orpc/client/fetch'
import type { ContractRouterClient } from '@orpc/contract'
import { contract } from '@cloudnord/contract'
import { FUSEAU_PAR_DEFAUT } from '@cloudnord/program'
import { RoomRuntime } from './runtime.js'
import { LocalStore } from './store.js'
import { createObsTransport, keepObsConnected } from './obs-transport.js'
import type { ObsTransport } from './obs.js'
import type { ObsInstance } from '@cloudnord/contract'
import { ConnectivityTracker, probeConnectivity } from './connectivity.js'
import { RecordingSession, slugify, type StopResult } from './recording.js'
import type { ControlDiagnostics, ControlTarget, PointObsVisible, VodListe } from './control-api.js'
import {
  ffprobeSonde,
  inspecterEnregistrement,
  listerEnregistrements,
  nodeVodFs,
  outilDisponible,
  ouvrirExtrait,
  ouvrirFichier,
  poserVerdict,
  cheminSur,
  type ControleVod,
  type Extrait,
  type FluxFichier,
  type VerdictVod,
  type VodIndexDeps,
} from './vod-index.js'
import { Outbox } from './outbox.js'
import { OutboxPump, buildHeartbeat, heartbeatDedupKey } from './outbox-pump.js'
import { AgregateurNiveaux } from './niveaux-audio.js'
import { moniteurHote, type ChargeHote } from './hote.js'
import { Televersements, type CandidatVod, type HubVod, type VueTeleversements } from './televersement.js'
import { prochaineConference } from '@cloudnord/etat-salle'
import { sessionsForRoom } from '@cloudnord/program'
import type { ModeExecution, RoomConfigPatch, RoomEventPayload } from '@cloudnord/contract'

/** Configuration de salle en cache local, telle que le hub l'a poussée. */
type ConfigSalle = NonNullable<ReturnType<LocalStore['settings']>['config']>

/**
 * Ce dont dépend une connexion OBS.
 *
 * Sert à savoir si la connexion en cours a été ouverte avec les réglages
 * actuels : le port change, le mapping change, et la connexion vivante devient
 * périmée sans que rien ne le montre.
 */
function empreinteObs(config: ConfigSalle, instance: ObsInstance): string {
  return JSON.stringify([
    config.obs[instance].url,
    config.obs[instance].password,
    config.sceneRoles[instance],
  ])
}

/** Où en est l'appairage de cette machine. */
export interface PairingState {
  status: 'idle' | 'waiting' | 'paired' | 'failed' | 'expired'
  userCode?: string
  verificationUri?: string
  expiresInSeconds?: number
  message?: string
  /** Salles proposées au choix, récupérées du hub. Vide s'il est injoignable. */
  rooms?: { id: string; name: string }[]
  /** Salle demandée par cette machine, en attente de confirmation. */
  requestedRoomId?: string | null
}

export interface RoomAppOptions {
  /** Racine des données locales (`userData` sous Electron). */
  dataDir: string
  hubOrigin: string
  clientId: string
  /** Coffre du jeton de machine. */
  readToken: () => string | null
  writeToken: (token: string) => void
  displayPort?: number
  /**
   * Fabrique de transport OBS, par instance.
   *
   * L'instance est passée explicitement plutôt que déduite de l'ordre d'appel :
   * un OBS-B branché sur les scènes d'OBS-A serait une panne difficile à voir.
   * Par défaut, le vrai client obs-websocket.
   */
  obsTransportFactory?: (instance: ObsInstance) => ObsTransport
  onLog?: (level: 'info' | 'warn' | 'error', message: string, context?: unknown) => void
  /** Affiche le code d'appairage sur l'écran de régie. */
  onPairingCode?: (code: DeviceCodeResponse) => void
  /**
   * Salle desservie, connue d'avance.
   *
   * Évite l'écran de choix sur une machine provisionnée en amont — image
   * disque préparée, déploiement scripté — où personne ne sera devant l'écran
   * au premier démarrage. Reste une proposition : la console tranche.
   */
  roomId?: string
  /**
   * Mode d'exécution de la salle.
   *
   * Décidé par le point d'entrée, qui lit l'environnement — le cœur applicatif
   * ne lit pas `process.env`, c'est ce qui le rend testable. Voir `core/mode`.
   */
  mode?: ModeExecution
  /**
   * Source de temps de la salle.
   *
   * Sert au développement, pour se placer au milieu de l'événement. Passe par
   * ici et non par l'offset serveur : celui-ci est recalculé à chaque remontée
   * réussie et écraserait toute valeur posée à la main.
   */
  now?: () => number
}

/**
 * Assemblage complet d'une machine de salle.
 *
 * Sans dépendance à Electron : c'est ce qui permet de démarrer l'ensemble dans
 * un test et de vérifier la chaîne réelle plutôt que des morceaux isolés.
 *
 * L'ordre de démarrage traduit la règle centrale du projet : **on sert l'écran
 * d'abord, on parle au hub ensuite**. Une salle doit projeter son programme
 * même si le hub n'a jamais répondu.
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
   * Résolveur du chemin de sortie, armé le temps d'un arrêt d'enregistrement.
   * OBS n'annonce le fichier qu'après `StopRecord`, il faut donc l'attendre.
   */
  private pendingOutputPath: ((path: string | null) => void) | null = null
  private outbox: Outbox | null = null
  private pump: OutboxPump | null = null
  /**
   * Relevé de charge du poste, **partagé** avec le serveur d'affichage.
   *
   * La mesure est une différence entre deux lectures des compteurs du noyau :
   * elle n'existe que si quelqu'un garde le repère précédent. Deux moniteurs
   * distincts — un pour la régie, un pour le régulateur — garderaient chacun le
   * leur et rendraient deux chiffres également faux, sans que rien ne le dise.
   */
  private readonly hote: () => ChargeHote = moniteurHote()
  private readonly televersements: Televersements
  /** Dernière racine d'enregistrement constatée : le téléverseur y résout ses chemins. */
  private racineConnue: string | null = null
  private readonly abort = new AbortController()
  private tick: NodeJS.Timeout | null = null
  private heartbeat: NodeJS.Timeout | null = null
  private roomsTimer: NodeJS.Timeout | null = null
  /** Mode annoncé par le hub au dernier sync. `null` tant qu'il n'a pas répondu. */
  private hubMode: ModeExecution | null = null
  /** Empreinte des réglages avec lesquels chaque instance a été branchée. */
  private obsApplique: Record<ObsInstance, string | null> = { A: null, B: null }
  /** Une boucle de reprise tourne déjà pour cette instance. */
  private repriseObs: Record<ObsInstance, boolean> = { A: false, B: false }
  private roomStatuses: ControlDiagnostics['rooms'] = []
  private questions: ControlDiagnostics['questions'] = []
  private questionsAt: string | null = null
  private questionsSession: ControlDiagnostics['questionsSession'] = null
  private roomStatusesAt: string | null = null
  private pairing: PairingState = { status: 'idle' }
  private supervision: NodeJS.Timeout | null = null
  private travailEnCours = false
  /**
   * Salle demandée depuis l'écran de régie.
   *
   * Elle n'engage rien : la console reste libre d'en choisir une autre. Mais
   * c'est l'opérateur de la salle qui sait où il se trouve, pas celui devant
   * la console — autant que la proposition vienne de lui.
   */
  private roomIdSouhaite: string | null = null
  private sallesConnues: { id: string; name: string }[] = []
  /** Appairage en tâche de fond, à laisser retomber avant de fermer. */
  private appairageEnCours: Promise<void> | null = null
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
          void this.chargerEtatsDesConferences()
        },
        fullResync: () => {
          void this.fullResync()
        },
        uploadVod: (file) => {
          void this.televersements.demander(file)
        },
        razVod: () => {
          void this.razVod()
        },
        refreshRoomStatuses: () => {
          void this.refreshRoomStatuses()
        },
      },
      options.now,
    )
    this.roomIdSouhaite = options.roomId ?? null
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
      // Relus du cache à chaque envoi : ils changent au sync, pas à chaque
      // bascule de scène, et une salle démarrée hub injoignable garde les
      // derniers connus plutôt qu'une page vide.
      socialLinks: () => this.store.settings().socialLinks,
      event: () => this.store.settings().event,
      onNiveauxDemandes: (actif) => {
        this.niveauxDemandes = actif
        // Sans OBS-B connecté, on retient seulement l'intention : l'abonnement
        // sera posé à la connexion, sinon ouvrir la régie avant OBS laisserait
        // le vumètre muet jusqu'à un rechargement de la page.
        void this.obsB?.setVolumeMeters(actif).catch(() => {
          this.options.onLog?.('warn', "OBS-B n'a pas accepté l'abonnement au vumètre")
        })
      },
      hote: this.hote,
      port: options.displayPort ?? 7788,
    })

    this.niveaux = new AgregateurNiveaux((inputs) => this.display.publierNiveaux(inputs))

    /**
     * Rapatriement des rushes.
     *
     * Monté toujours, actif jamais tant que le hub n'a pas de stockage : c'est
     * le hub qui décide, et il le dit au sync. Une salle n'a rien à savoir de
     * S3 — elle sait seulement qu'il y a, ou non, une destination.
     */
    this.televersements = new Televersements({
      store: this.store,
      candidats: () => this.candidatsVod(),
      hub: () => this.hubVod(),
      politique: () => this.store.settings().vod?.politique ?? null,
      charge: this.hote,
      // L'état réel d'OBS-B, observé et non supposé : c'est le même booléen que
      // le témoin de la régie, et il vaut mieux que ce qu'on croit avoir lancé.
      enregistre: () => this.runtime.state().recording,
      conferenceEnCours: () => this.runtime.currentSessionStatus() === 'running',
      msAvantProchaine: () => this.msAvantProchaineConference(),
      cheminDe: (file) => this.cheminDansCaptations(file),
      // Relue du cache à chaque envoi, comme le reste : une CA corrigée sur le
      // hub prend effet au sync suivant, sans toucher à la machine de salle.
      caCert: () => this.store.settings().vod?.caCert ?? null,
      onLog: this.options.onLog,
    })
  }

  /** Une régie affiche-t-elle les niveaux en ce moment ? */
  private niveauxDemandes = false
  private readonly niveaux: AgregateurNiveaux

  /**
   * Met un événement en file de remontée.
   *
   * Ne fait jamais attendre l'appelant : la file est locale, la remontée se
   * fait en tâche de fond. C'est ce qui permet à une action de régie d'aboutir
   * instantanément même hors ligne.
   */
  emit(payload: RoomEventPayload, dedupKey?: string): void {
    const outbox = this.ensureOutbox()
    if (outbox == null) {
      // Avant le tout premier appairage, on ne connaît pas encore la salle et
      // l'événement n'est pas estampillable. Le cas est rare et transitoire,
      // mais il doit laisser une trace plutôt que disparaître en silence.
      this.store.log('warn', 'événement émis avant appairage, non mis en file', {
        type: payload.type,
      })
      return
    }
    outbox.enqueue(payload, dedupKey != null ? { dedupKey } : {})
    // `backlog()` et non `depth()` : le battement qu'on vient d'inscrire repart
    // au drain suivant, et le compter ferait clignoter l'indicateur sans fin.
    this.runtime.setOutboxDepth(outbox.backlog())
  }

  /**
   * Crée la file dès que la salle est connue — y compris depuis le cache local,
   * donc sans réseau. Un redémarrage hors ligne capture ainsi les événements du
   * démarrage (connexion OBS, incidents) au lieu de les perdre.
   */
  private ensureOutbox(): Outbox | null {
    if (this.outbox != null) return this.outbox
    const roomId = this.store.settings().roomId
    if (roomId == null) return null
    this.outbox = new Outbox(this.store, roomId)
    return this.outbox
  }

  /** Où en est l'appairage, pour l'écran de régie. */
  pairingState(): PairingState {
    return {
      ...this.pairing,
      rooms: [...this.sallesConnues],
      requestedRoomId: this.roomIdSouhaite,
    }
  }

  /**
   * Enregistre la salle choisie sur l'écran de régie et relance l'appairage.
   *
   * Relancer est nécessaire : le choix voyage dans la demande de code, il ne
   * peut donc pas s'appliquer à un code déjà émis.
   */
  async chooseRoom(roomId: string): Promise<void> {
    if (this.sallesConnues.length > 0 && !this.sallesConnues.some((s) => s.id === roomId)) {
      throw new Error(`Salle inconnue : ${roomId}`)
    }
    this.roomIdSouhaite = roomId
    this.setPairing({ ...this.pairing, status: 'idle', userCode: undefined })

    /**
     * L'appairage part en tâche de fond et l'appel rend la main aussitôt.
     *
     * L'attendre bloquerait la requête HTTP jusqu'à l'approbation — donc
     * potentiellement une demi-heure, pendant laquelle le bouton de la régie
     * tournerait et le navigateur finirait par abandonner. L'écran suit
     * l'avancement par le flux d'état.
     */
    this.appairageEnCours = this.lancerAppairage().finally(() => {
      this.appairageEnCours = null
    })
  }

  private async lancerAppairage(): Promise<void> {
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
   * Récupère la liste des salles pour l'écran de choix.
   *
   * Publique côté hub : une machine non appairée n'a aucun jeton à présenter.
   */
  private async chargerSalles(): Promise<void> {
    try {
      const client: ContractRouterClient<typeof contract> = createORPCClient(
        new FetchLink({ origin: this.options.hubOrigin, url: '/rpc' }),
      )
      this.sallesConnues = await client.rooms.public()
    } catch {
      // Hub injoignable : l'écran l'affichera, la supervision réessaiera.
      this.sallesConnues = []
    }
  }

  private setPairing(etat: PairingState): void {
    this.pairing = etat
    // L'écran doit suivre immédiatement : c'est lui qui porte le code.
    this.runtime.emit('state', this.runtime.state())
  }

  /**
   * Surveille le hub et rattrape ce qui a échoué.
   *
   * Sans cette boucle, un hub absent au démarrage condamnait la salle : elle
   * affichait son code, échouait une fois, et n'essayait plus jamais. Or c'est
   * exactement l'ordre de démarrage le plus probable un matin d'événement —
   * les salles s'allument avant que quiconque ait lancé le hub.
   */
  startSupervision(intervalMs = 15_000): void {
    if (this.supervision != null) return

    this.supervision = setInterval(() => {
      if (this.travailEnCours || this.abort.signal.aborted) return
      this.travailEnCours = true
      void this.rattraper().finally(() => {
        this.travailEnCours = false
      })
    }, intervalMs)
    this.supervision.unref?.()
  }

  /** Une passe de rattrapage. Ne lève jamais : c'est une boucle de fond. */
  private async rattraper(): Promise<void> {
    // Rien à faire tant que le lien tient : `consumeCommands` gère ses propres
    // reconnexions, et sonder par-dessus ne ferait qu'ajouter du bruit.
    if (this.link != null) return

    // En attente d'un choix de salle : on rafraîchit seulement la liste, pour
    // que l'écran cesse d'être vide dès que le hub répond.
    if (this.roomIdSouhaite == null && this.options.readToken()?.trim() == null) {
      await this.chargerSalles()
      if (this.sallesConnues.length > 0) {
        this.setPairing({ ...this.pairing, status: 'idle' })
        return
      }
    }

    const joignable = await probeConnectivity({ hubOrigin: this.options.hubOrigin })
    if (joignable === 'OFFLINE') {
      // Le hub ne répond toujours pas. On ne tente rien et on repassera : la
      // salle continue de fonctionner sur son cache pendant ce temps.
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

  /** Sert l'écran. Première chose faite, avant toute tentative réseau. */
  async startDisplay(): Promise<string> {
    const url = await this.display.listen()
    this.options.onLog?.('info', "écran de salle servi", { url: `${url}/display/projector` })

    // Tic d'horloge : fait avancer la timeline, et expirer messages et
    // signalements, même quand plus rien n'arrive du hub.
    this.tick = setInterval(() => {
      this.runtime.refreshSessions()
      this.runtime.expireMessage()
      this.runtime.expireNotifications()
    }, 5_000)

    /**
     * Rapatriement des rushes, en fond.
     *
     * Démarré avec l'écran et non avec le hub : la boucle ne fait rien tant
     * qu'aucune destination n'est connue, et la démarrer plus tard voudrait dire
     * qu'une salle jamais raccordée ne rattraperait jamais ses rushes le soir,
     * quand le hub revient.
     */
    this.televersements.demarrer()

    return url
  }

  /**
   * Récupère le jeton de la machine, en déroulant l'appairage si nécessaire.
   *
   * Renvoie `null` si le hub est injoignable : ce n'est pas une erreur, la
   * salle continue sur son cache.
   */
  async ensurePaired(): Promise<string | null> {
    // Chaîne vide comprise : c'est ce qu'écrit `repair()` pour effacer, et la
    // laisser passer ferait croire la machine appairée avec un jeton nul.
    const existing = this.options.readToken()?.trim()
    if (existing != null && existing.length > 0) {
      this.setPairing({ status: 'paired' })
      return existing
    }

    // Le choix précède le code : sans salle proposée, l'écran demande d'abord
    // laquelle, plutôt que d'afficher un code que la console devra deviner.
    await this.chargerSalles()
    if (this.roomIdSouhaite == null && this.sallesConnues.length > 0) {
      this.setPairing({ status: 'idle' })
      return null
    }

    try {
      const { accessToken } = await runPairing(
        httpPairingTransport(this.options.hubOrigin),
        this.options.clientId,
        {
          scope: this.roomIdSouhaite == null ? undefined : `room:${this.roomIdSouhaite}`,
          // Fermer l'application doit interrompre l'attente, pas la subir.
          signal: this.abort.signal,
          onUnreachable: () => {
            // Le code reste affiché : il est toujours valide côté hub.
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
       * La session d'approbation n'est utilisée qu'ici, pour réclamer le jeton
       * de salle. Elle donne les droits de l'opérateur qui a approuvé ; une
       * machine de régie n'a aucune raison de les conserver.
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
   * Repart de zéro après un refus d'identifiants.
   *
   * Le jeton stocké ne vaut plus rien : le conserver ferait boucler la machine
   * sur un échec silencieux. On l'efface et on réaffiche le code.
   */
  async repair(raison: string): Promise<void> {
    this.options.onLog?.('warn', 'réappairage nécessaire', { raison })
    this.options.writeToken('')
    this.setPairing({ status: 'expired', message: raison })

    // Tout ce qui parle au hub s'arrête : sans ça, la file et le battement
    // continueraient de frapper un lien fermé et lèveraient en boucle.
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

  /** Connecte le hub : synchronise puis consomme les commandes en tâche de fond. */
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
        const nous = this.options.mode ?? 'production'
        if (mode !== nous) {
          this.options.onLog?.('error', 'MODES DIVERGENTS entre la salle et le hub', {
            salle: nous,
            hub: mode,
          })
        }
      },
      onAuthRejected: (raison) => {
        // Relancé hors de la pile d'appel : on est dans le gestionnaire
        // d'erreur du lien qu'on s'apprête à fermer.
        setTimeout(() => void this.repair(raison), 0)
      },
    })

    await this.synchroniserTout()

    void this.link.consumeCommands(this.abort.signal)
    void this.link.consumeWall(this.abort.signal)
    this.startOutbox()
    this.startRoomWatch()

    // État initial des conférences : sans ça, un redémarrage en plein talk
    // afficherait « à venir » sur une conférence déjà lancée.
    await this.chargerEtatsDesConferences()
  }

  /**
   * Tout ce que la salle relit du hub : programme, assets, configuration, QR.
   *
   * Extrait du raccordement pour être rejouable en cours de journée. Ce qui
   * *ouvre* quelque chose — flux de commandes, file de remontée, veille des
   * salles, OBS — n'y est pas : le rejouer couperait ce qui tourne.
   *
   * @param complet Redemande le programme entier même à empreinte identique.
   */
  private async synchroniserTout(complet = false): Promise<boolean> {
    if (this.link == null) return false
    const result = await this.link.sync({ complet })
    const roomId = this.store.settings().roomId
    if (roomId != null) {
      await this.display
        .prepareWallQr(roomId, `${this.options.hubOrigin.replace(/\/$/, '')}/mur?salle=${encodeURIComponent(roomId)}`)
        .catch((cause: Error) => this.options.onLog?.('warn', 'QR du mur non généré', { message: cause.message }))
    }
    if (result.ok) {
      const cached = this.store.activeProgram()
      if (cached != null) {
        // Après le sync, pas avant : télécharger les assets ne doit jamais
        // retarder l'affichage du programme.
        const report = await this.assets.prefetch(cached.program)
        this.options.onLog?.('info', 'assets préchargés', report)
      }
    }
    return result.ok
  }

  /**
   * Resynchronisation complète, demandée depuis la console.
   *
   * Tout ce que fait un démarrage, sauf ce qui couperait quelque chose : le
   * programme redescend entier — sans se fier à l'empreinte en cache, puisque
   * c'est justement le cache qu'on soupçonne —, les assets manquants sont
   * repris, la configuration, les réseaux, l'événement et l'horloge relus, et
   * le cycle de vie des conférences redemandé au hub.
   *
   * **OBS n'est pas reconnecté et l'enregistrement n'est pas touché.** Une
   * salle qu'on remet d'aplomb pendant un talk ne doit pas y perdre sa
   * captation : ce geste existe précisément pour ne pas avoir à redémarrer la
   * machine, ce qui, lui, coupe tout.
   */
  async fullResync(): Promise<void> {
    if (this.link == null) {
      this.options.onLog?.('warn', 'resynchronisation complète sans hub : rien à relire')
      return
    }
    this.options.onLog?.('info', 'resynchronisation complète demandée')
    const ok = await this.synchroniserTout(true)
    await this.chargerEtatsDesConferences()
    if (ok) {
      this.runtime.notify({ level: 'info', text: 'Resynchronisation complète terminée' })
      this.options.onLog?.('info', 'resynchronisation complète terminée')
      return
    }
    // Dit franchement : une salle qui reste sur son cache après qu'on lui a
    // demandé de tout relire n'est pas remise d'aplomb, et la console vient
    // d'annoncer le contraire.
    this.runtime.notify({
      level: 'warning',
      text: 'Resynchronisation complète : hub injoignable, la salle garde son cache',
    })
    this.options.onLog?.('warn', 'resynchronisation complète incomplète : hub injoignable')
  }

  /**
   * Relit le cycle de vie des conférences de la salle auprès du hub.
   *
   * Appelée au sync, et à chaque fois que l'heure du hub bouge : le hub écarte
   * les décisions datées d'après l'instant courant, la salle doit donc les
   * relire plutôt que de raisonner sur sa copie — elle n'a pas les dates de
   * décision, et aucune commande n'annonce qu'un fait a cessé de s'appliquer.
   *
   * En cas d'échec on garde la copie précédente : périmée vaut mieux que vide,
   * qui afficherait « à venir » sur un talk en cours.
   */
  private async chargerEtatsDesConferences(): Promise<void> {
    if (this.link == null) return
    try {
      const etats = await this.link.client.sessions.states({ roomId: this.store.settings().roomId })
      this.runtime.replaceSessionStates(etats)
    } catch (cause) {
      this.options.onLog?.('warn', 'états des conférences non récupérés', {
        message: (cause as Error).message,
      })
    }
  }

  /**
   * Démarre la remontée.
   *
   * Séparée de la synchronisation : même si le `sync` a échoué, la file doit
   * tourner — elle rattrapera dès que le hub répondra.
   */
  private startOutbox(): void {
    const roomId = this.store.settings().roomId
    const outbox = this.ensureOutbox()
    if (roomId == null || outbox == null || this.link == null) return
    // Un réappairage relance `connectHub` : on ne veut pas deux aspirateurs.
    this.pump?.stop()
    if (this.heartbeat != null) clearInterval(this.heartbeat)

    this.pump = new OutboxPump({
      outbox,
      store: this.store,
      push: async (batch) => {
        // Le lien peut disparaître pendant un réappairage : échouer proprement
        // renvoie le lot en file, là où `!` aurait levé une erreur non gérée.
        const lien = this.link
        if (lien == null) throw new Error('Hub non connecté')
        return lien.client.ingest.push({ batch })
      },
      onConnectivity: (value) => {
        // Un échec de remontée ne veut pas dire « réseau coupé » : on sonde le
        // hub en HTTP pour distinguer `DEGRADED` d'`OFFLINE`.
        if (value === 'ONLINE') this.connectivity.markOnline()
        else void this.connectivity.markRealtimeFailure()
      },
      onDepth: (depth) => this.runtime.setOutboxDepth(depth),
      onServerTime: (serverTime) =>
        this.runtime.setServerTime(serverTime),
    })
    this.pump.start()

    // Battement régulier, collapsé : une heure hors ligne laisse une seule
    // occurrence en file, pas 720.
    this.heartbeat = setInterval(() => {
      const state = this.runtime.state()
      this.emit(
        buildHeartbeat({
          connectivity: state.connectivity,
          sceneRole: state.sceneRole,
          recording: this.obsA?.snapshot().recording ?? false,
          streaming: this.obsA?.snapshot().streaming ?? false,
          outboxDepth: outbox.backlog(),
          programContentHash: state.contentHash,
        }),
        heartbeatDedupKey(roomId),
      )
    }, 10_000)
    this.heartbeat.unref?.()
  }

  /**
   * Charge un programme depuis un fichier local.
   *
   * Dernier repli de la chaîne de démarrage : cache SQLite → fichier importé à
   * la main (clé USB) → snapshot embarqué. Permet d'ouvrir une salle même si le
   * hub n'a jamais été joignable depuis cette machine.
   */
  async importProgramFile(path: string): Promise<{ contentHash: string; sessions: number }> {
    const { readFile } = await import('node:fs/promises')
    const { createHash } = await import('node:crypto')
    const { normalizeProgram } = await import('@cloudnord/program')

    const raw = await readFile(path, 'utf8')
    const program = normalizeProgram(JSON.parse(raw))
    // Même empreinte que côté hub : un import manuel puis un sync ne créent pas
    // deux versions du même programme.
    const contentHash = createHash('sha256').update(raw).digest('hex').slice(0, 32)

    this.store.saveProgram(contentHash, program)
    this.runtime.setProgram(contentHash, program)
    this.runtime.refreshSessions()
    this.store.log('info', 'programme importé depuis un fichier local', { path, contentHash })

    return { contentHash, sessions: program.sessions.length }
  }

  /**
   * Au-delà, la régie cesse de croire la vue des autres salles.
   *
   * Miroir de `VUE_PERIMEE_MS` côté page : c'est la fenêtre qu'il faut tenir,
   * et le rappel ci-dessous s'y prend largement à l'avance.
   */
  private static readonly VUE_PERIMEE_MS = 60_000

  /**
   * Au-delà, on republie même sans changement, pour rafraîchir l'horodatage.
   *
   * La régie ne se fie à la vue du hub que si elle est fraîche ; l'horodatage
   * doit donc lui parvenir régulièrement, y compris quand rien ne bouge. Un
   * tiers de la fenêtre laisse deux occasions de la tenir avant qu'elle ne se
   * ferme, même si l'une échoue.
   */
  private static readonly RAPPEL_VUE_MS = 20_000

  /** Sérialisation de la dernière vue publiée, pour ne republier qu'à bon escient. */
  private roomStatusesPubliees: string | null = null
  private roomStatusesPublieesA = 0
  /** Un seul appel en vol, et au plus une redemande en attente. */
  private roomWatchEnCours = false
  private roomWatchRedemande = false

  /**
   * Rafraîchit l'état des autres salles.
   *
   * Trois cadences, et c'est voulu : un sondage court pour ce qui n'a pas de
   * commande — enregistrement, scène, connectivité, qui remontent au battement
   * de la salle concernée —, un **déclenchement immédiat** sur commande pour ce
   * qui en a une, et un rappel périodique pour tenir l'horodatage de fraîcheur.
   *
   * Le déclenchement immédiat est ce qui fait la différence en salle : la
   * décision d'une régie voisine arrive déjà poussée sur le flux de commandes,
   * seule la *vue* était sondée. La pastille accusait donc jusqu'à un tour de
   * sonde de retard sur la notification qui l'accompagnait.
   */
  private startRoomWatch(): void {
    if (this.roomsTimer != null) clearInterval(this.roomsTimer)
    void this.refreshRoomStatuses()
    this.roomsTimer = setInterval(() => void this.refreshRoomStatuses(), 5_000)
    this.roomsTimer.unref?.()
  }

  /**
   * Redemande la vue des autres salles, et la republie si elle a bougé.
   *
   * La publication ne va pas de soi : mettre à jour le champ en mémoire ne
   * réveille personne. L'écran ne reçoit que sur `runtime.emit('state')` —
   * c'est ce qui manquait, et le sondage tournait dans le vide.
   *
   * Republier à chaque tour serait l'excès inverse : la charge utile entière
   * est resérialisée à chaque diffusion, et le flux est censé rester muet quand
   * rien ne change. D'où la comparaison, doublée d'un rappel périodique pour
   * l'horodatage.
   */
  private async refreshRoomStatuses(): Promise<void> {
    if (this.link == null) return
    // Un seul appel en vol : une rafale de décisions ne doit pas ouvrir dix
    // requêtes parallèles, mais la dernière ne doit pas non plus se perdre —
    // une réponse partie *avant* l'écriture décrit encore le passé.
    if (this.roomWatchEnCours) {
      this.roomWatchRedemande = true
      return
    }
    this.roomWatchEnCours = true
    try {
      const statuses = await this.link.client.rooms.statuses()
      this.roomStatuses = statuses.map((salle) => ({
        roomId: salle.roomId,
        name: salle.name,
        connectivity: salle.connectivity,
        sceneRole: salle.sceneRole,
        recording: salle.recording,
        outboxDepth: salle.outboxDepth,
        lastSeenAt: salle.lastSeenAt,
        currentSessionId: salle.currentSessionId,
        conference: salle.conference,
      }))
      this.roomStatusesAt = new Date().toISOString()

      const vue = JSON.stringify(this.roomStatuses)
      const rappelDu = Date.now() - this.roomStatusesPublieesA >= RoomApp.RAPPEL_VUE_MS
      if (vue !== this.roomStatusesPubliees || rappelDu) {
        this.roomStatusesPubliees = vue
        this.roomStatusesPublieesA = Date.now()
        this.runtime.emit('state', this.runtime.state())
      }
    } catch {
      // Hub injoignable : on garde la dernière vue connue, datée, plutôt que
      // de vider le panneau — une liste vide se lirait comme « aucune salle ».
      // L'horodatage ne bouge pas : passé une minute, la régie retombera d'elle
      // même sur le programme, qui reste juste hors ligne.
    } finally {
      this.roomWatchEnCours = false
      if (this.roomWatchRedemande) {
        this.roomWatchRedemande = false
        void this.refreshRoomStatuses()
      }
    }
  }

  /** Connecte les deux instances OBS avec le mapping de rôles de la salle. */
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
   * Ouvre (ou rouvre) **une** instance, à la demande de l'opérateur.
   *
   * Instance par instance : couper la captation pour appliquer un réglage de
   * projection coûterait une prise. C'est aussi pourquoi enregistrer un réglage
   * ne reconnecte rien tout seul — le moment appartient à l'opérateur, qui sait
   * si un talk est en cours.
   */
  async connectObsInstance(instance: ObsInstance): Promise<void> {
    const config = this.store.settings().config
    if (config == null) {
      throw new Error("Configuration de salle absente : le hub n'a pas encore répondu")
    }

    // L'ancienne connexion part d'abord : les paramètres sont portés par le
    // contrôleur, qui est reconstruit.
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
   * Ouvre la connexion d'une instance déjà construite.
   *
   * Deux régimes. Au démarrage, on insiste sans fin : OBS est souvent lancé
   * après la régie, et personne ne devrait avoir à rien recliquer. À la
   * demande, une seule tentative — quelqu'un attend devant l'écran et l'échec
   * doit lui revenir — mais la boucle de reprise repart quand même en fond,
   * pour que l'instance finisse par se rattacher toute seule.
   */
  private async brancher(instance: ObsInstance, manuel: boolean): Promise<void> {
    const connecter = () => (instance === 'A' ? this.obsA! : this.obsB!).connect()

    if (!manuel) {
      this.repriseObs[instance] = true
      try {
        await keepObsConnected({
          connect: connecter,
          onLog: this.options.onLog,
          signal: this.abort.signal,
        })
      } finally {
        this.repriseObs[instance] = false
      }
      return
    }

    try {
      await connecter()
    } catch (cause) {
      this.relancerReprise(instance)
      throw new Error('OBS-' + instance + " n'a pas répondu : " + (cause as Error).message)
    }
  }

  /** Boucle de reprise en fond, une seule à la fois par instance. */
  private relancerReprise(instance: ObsInstance): void {
    if (this.repriseObs[instance]) return
    this.repriseObs[instance] = true
    void keepObsConnected({
      connect: () => (instance === 'A' ? this.obsA! : this.obsB!).connect(),
      onLog: this.options.onLog,
      signal: this.abort.signal,
    }).finally(() => {
      this.repriseObs[instance] = false
    })
  }

  private async connectProjection(config: ConfigSalle, manuel = false): Promise<void> {
    const transport = (this.options.obsTransportFactory ?? createObsTransport)('A')
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
            break
          case 'connected':
            // Adopter l'état constaté : sans ça, la régie et la console
            // affichent une scène vide jusqu'à la première bascule.
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

    this.obsApplique.A = empreinteObs(config, 'A')
    await this.brancher('A', manuel)
  }

  /**
   * OBS-B : la captation. Distincte de la projection parce qu'elle n'a ni les
   * mêmes scènes, ni les mêmes conséquences — une erreur ici coûte une VOD.
   */
  private async connectCapture(config: ConfigSalle, manuel = false): Promise<void> {
    const transport = (this.options.obsTransportFactory ?? createObsTransport)('B')
    this.obsB = new ObsController({
      instance: 'B',
      url: config.obs.B.url,
      password: config.obs.B.password,
      sceneRoles: config.sceneRoles.B,
      transport,
      onEvent: (event) => {
        switch (event.type) {
          case 'audio':
            this.niveaux.pousser(event.inputs)
            break
          case 'recording':
            this.runtime.observeCapture({ recording: event.active })
            // Le chemin n'arrive qu'à l'arrêt : il débloque l'écriture du sidecar.
            if (!event.active && this.pendingOutputPath != null) {
              this.pendingOutputPath(event.outputPath)
              this.pendingOutputPath = null
            }
            break
          case 'streaming':
            this.runtime.observeCapture({ streaming: event.active })
            this.emit(
              event.active
                ? { type: 'stream.started', obs: 'B', sessionId: this.runtime.state().currentSession?.id ?? null }
                : { type: 'stream.stopped', obs: 'B', reason: 'operator' },
            )
            break
          case 'connected':
            /**
             * Adopter l'enregistrement et la diffusion en cours.
             *
             * Le cas qui compte : l'application redémarre pendant un talk et
             * OBS enregistre déjà. Repartir de « rien en cours » ferait croire
             * à une prise perdue.
             */
            this.runtime.observeCapture({
              recording: event.recording,
              streaming: event.streaming,
            })
            this.emit({
              type: 'obs.connection',
              obs: 'B',
              connected: true,
              unresolvedRoles: event.unresolvedRoles,
            })
            // Réapplique l'abonnement au vumètre : une régie ouverte avant OBS,
            // ou pendant une reconnexion, doit retrouver ses niveaux seule.
            if (this.niveauxDemandes) void this.obsB?.setVolumeMeters(true).catch(() => {})
            break
          case 'disconnected':
            // Le vumètre retombe à zéro plutôt que de figer la dernière mesure :
            // une régie muette ne doit pas montrer du signal.
            this.niveaux.reinitialiser()
            this.display.publierNiveaux([])
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
      fs: nodeRecordingFs(),
      now: () => Date.now(),
      correctedNow: () => this.runtime.correctedNow(),
      onLog: this.options.onLog,
    })

    this.obsApplique.B = empreinteObs(config, 'B')
    await this.brancher('B', manuel)
  }

  /** Démarre l'enregistrement du talk en cours. */
  async startRecording(): Promise<void> {
    const config = this.store.settings().config
    if (this.recording == null || config == null) throw new Error('OBS-B non connecté')

    const state = this.runtime.state()
    const cached = this.store.activeProgram()

    await this.recording.start({
      session: state.currentSession,
      roomId: state.roomId,
      roomSlug: config.fileSlug ?? slugify(config.name).slice(0, 16),
      timezone: cached?.program.timezone ?? FUSEAU_PAR_DEFAUT,
    })
    /**
     * Le journal de la salle, et pas seulement la console du poste.
     *
     * Une captation qu'on retrouve en cours sans se souvenir de l'avoir lancée
     * est une question qu'on se pose devant la régie, pas devant un terminal :
     * la réponse doit être à côté du chronomètre. Le journal est repris dans le
     * panneau Diagnostic, et il porte l'heure.
     */
    this.options.onLog?.('info', 'captation démarrée depuis la régie', {
      session: state.currentSession?.title ?? null,
      simule: this.obsB?.snapshot().simulated === true,
    })
    this.emit({ type: 'recording.started', obs: 'B', sessionId: state.currentSession?.id ?? null })
  }

  /**
   * Attend que OBS annonce le fichier produit.
   *
   * Borné : si l'événement ne vient pas — OBS tué en plein arrêt, par exemple —
   * on écrit quand même ce qu'on sait plutôt que de bloquer la régie. Le sidecar
   * manquera, et le journal le dira.
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

  /** Applique la configuration de diffusion puis démarre le stream. */
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
   * Relève la santé de la diffusion.
   *
   * Remontée en `best-effort` : c'est une information de surveillance, pas un
   * fait à conserver — la perdre pendant une coupure n'a aucune conséquence.
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

  /** Pose un marqueur de chapitre. */
  mark(label: string): void {
    if (this.recording == null || !this.recording.active) throw new Error('Aucun enregistrement en cours')
    const marker = this.recording.mark(label)
    this.emit({
      type: 'talk.marker',
      sessionId: this.runtime.state().currentSession?.id ?? null,
      label,
      offsetMs: marker.offsetMs,
    })
  }

  /**
   * Arrête l'enregistrement, renomme le master et écrit le sidecar.
   *
   * Tout est produit localement : la chaîne VOD fonctionne même si le hub est
   * resté injoignable toute la journée.
   */
  async stopRecording(): Promise<StopResult> {
    if (this.recording == null || !this.recording.active) throw new Error('Aucun enregistrement en cours')

    // Armé **avant** `StopRecord` : l'événement d'OBS peut arriver dans la
    // foulée de la requête, et un résolveur posé après le manquerait.
    const outputPath = this.awaitOutputPath()
    const result = await this.recording.stop(() => outputPath)
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
   * Racine des captations.
   *
   * Le réglage de la salle fait foi ; à défaut on demande à OBS-B où il écrit.
   * Sans ce repli, une salle qui n'a jamais rempli le champ — le cas le plus
   * courant, puisque rien d'autre ne s'en sert — ne pourrait rien vérifier du
   * tout, alors que le dossier existe et se remplit depuis le matin.
   */
  private async racineCaptations(): Promise<string | null> {
    const configuree = this.store.settings().config?.recordingRoot
    if (configuree != null && configuree.trim().length > 0) return configuree
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
      now: () => this.runtime.correctedNow(),
      probe: ffprobeSonde(),
      onLog: this.options.onLog,
    }
  }

  /**
   * Chemin absolu d'un fichier de la racine des enregistrements.
   *
   * Passe par le même garde-fou que la modale de la régie : la racine est un
   * dossier qu'un opérateur saisit dans un formulaire servi en HTTP, et
   * `../../` y est une entrée valide. `null` quand le fichier n'est pas
   * strictement dessous — le téléverseur refuse alors, plutôt que d'envoyer
   * chez un tiers un fichier qu'on ne lui a pas demandé.
   */
  private cheminDansCaptations(file: string): string | null {
    if (this.racineConnue == null) return null
    try {
      return cheminSur(this.racineConnue, file)
    } catch {
      return null
    }
  }

  /**
   * Ce qu'il y a à rapatrier : les rushes, chacun avec son sidecar.
   *
   * Reconstruit à chaque passe plutôt que gardé : le dossier se remplit toute
   * la journée, et une liste figée au démarrage ne verrait aucun talk.
   */
  private async candidatsVod(): Promise<CandidatVod[]> {
    const root = await this.racineCaptations()
    this.racineConnue = root
    if (root == null) return []
    const deps = this.vodDeps(root)
    const entrees = await listerEnregistrements(deps)

    return await Promise.all(
      entrees.map(async (entree) => {
        const nom = entree.file.replace(/\.[^./]+$/, '.json')
        /**
         * La taille du sidecar se **lit sur le disque**, elle ne se déduit pas.
         *
         * Elle a d'abord été calculée en re-sérialisant l'objet relu : le
         * fichier écrit par la salle est indenté, la chaîne recalculée ne
         * l'était pas, et le sidecar arrivait chez le stockage tronqué de ses
         * espaces — donc invalide, donc illisible au montage. Un JSON coupé au
         * milieu ne se voit pas dans une liste de fichiers ; il se découvre en
         * l'ouvrant, des mois plus tard.
         */
        const stat = entree.sidecar == null ? null : await deps.fs.stat(cheminSur(root, nom))
        return {
          file: entree.file,
          sizeBytes: entree.sizeBytes,
          enEcriture: entree.enEcriture,
          sessionId: entree.sidecar?.sessionId ?? null,
          // Absent, on ne monte que le rush : un rush sans sidecar est
          // justement celui qu'il faut sauver.
          sidecar: stat == null ? null : { file: nom, sizeBytes: stat.size },
        }
      }),
    )
  }

  /**
   * Le hub, tel que le téléverseur s'en sert. `null` : rien ne part.
   *
   * Deux conditions, et il faut les deux : un lien ouvert, et un hub qui a
   * annoncé une destination au dernier sync. Une salle hors ligne ne téléverse
   * pas — c'est la seule chose du système qui ne peut pas se faire sans réseau,
   * et c'est dans sa nature.
   */
  private hubVod(): HubVod | null {
    const lien = this.link
    if (lien == null || !(this.store.settings().vod?.actif ?? false)) return null
    return {
      begin: (entree) => lien.client.vod.begin(entree),
      parts: (uploadId, numeros) => lien.client.vod.parts({ uploadId, numeros }),
      progress: async (entree) => {
        await lien.client.vod.progress(entree)
      },
      complete: async (uploadId) => {
        await lien.client.vod.complete({ uploadId })
      },
      abort: async (uploadId, raison) => {
        await lien.client.vod.abort({ uploadId, raison })
      },
    }
  }

  /**
   * Millisecondes avant la prochaine conférence de cette salle.
   *
   * Sur le programme en cache et l'**horloge corrigée du hub**, jamais celle du
   * poste : en développement, l'écart entre les deux se compte en semaines, et
   * le régulateur autoriserait un téléversement en plein talk. `null` quand il
   * n'y a plus rien au programme — fin de journée, ou salle jamais
   * synchronisée : dans les deux cas, il n'y a rien à ménager.
   */
  private msAvantProchaineConference(): number | null {
    const cache = this.store.activeProgram()
    const roomId = this.store.settings().roomId
    if (cache == null || roomId == null) return null
    const at = this.runtime.correctedNow()
    const suivante = prochaineConference(
      sessionsForRoom(cache.program, roomId),
      at,
      this.runtime.state().sessionStates,
    )
    return suivante == null ? null : Math.max(0, suivante.startsAtMs - at)
  }

  /**
   * Efface les rushes de cette salle. **Développement seulement.**
   *
   * Second verrou, après celui du hub. Deux plutôt qu'un parce que les deux
   * postes peuvent se retrouver branchés l'un à l'autre par accident — c'est
   * même le désaccord que le badge de mode de la régie existe pour rendre
   * visible. Une salle de production qui reçoit cet ordre le refuse et le dit.
   *
   * N'efface que ce que l'application connaît : les conteneurs vidéo qu'elle
   * liste, leurs sidecars, le fichier de verdicts. La racine des captations est
   * un dossier qu'un opérateur a saisi dans un formulaire — parfois un disque
   * partagé, parfois pas celui qu'on croit — et la vider entièrement n'est pas
   * un geste qu'on rattrape.
   */
  async razVod(): Promise<number> {
    if (this.options.mode !== 'dev') {
      this.options.onLog?.(
        'error',
        'remise à zéro des rushes refusée : cette salle n\u2019est pas en mode développement',
      )
      return 0
    }

    const root = await this.racineCaptations()
    if (root == null) return 0

    const { unlink } = await import('node:fs/promises')
    const entrees = await listerEnregistrements(this.vodDeps(root))
    // Le fichier de verdicts vit à la racine, à côté des rushes, et décrit une
    // relecture qui n'a plus d'objet une fois les rushes partis.
    const noms = entrees.flatMap((entree) => [
      entree.file,
      entree.file.replace(/\.[^./]+$/, '.json'),
    ])
    noms.push('.controles-vod.json')

    let effaces = 0
    for (const nom of noms) {
      let chemin: string
      try {
        // Le même garde-fou que partout ailleurs : la racine vient d'un
        // formulaire servi en HTTP, et `../../` y est une saisie valide.
        chemin = cheminSur(root, nom)
      } catch {
        continue
      }
      try {
        await unlink(chemin)
        effaces += 1
      } catch {
        // Absent, ou déjà parti : ce n'est pas une erreur. Un sidecar jamais
        // écrit est même le cas qu'on rencontre le plus.
      }
    }

    this.televersements.oublierTout()
    this.options.onLog?.('warn', 'rushes effacés (remise à zéro)', { root, fichiers: effaces })
    return effaces
  }

  /** Téléversements en cours et raison d'attente, pour la modale de la régie. */
  vodUploads(): VueTeleversements {
    return this.televersements.vue()
  }

  /** Met un rush en file. `file` nul = tout ce qui reste. */
  async uploadRecording(file: string | null): Promise<number> {
    return await this.televersements.demander(file)
  }

  /** Renonce à un téléversement en cours. */
  async cancelUpload(file: string): Promise<void> {
    await this.televersements.annuler(file)
  }

  /** Rushes produits sous la racine, du plus récent au plus ancien. */
  async listRecordings(): Promise<VodListe> {
    const [ffmpeg, ffprobe] = await Promise.all([
      outilDisponible('ffmpeg'),
      outilDisponible('ffprobe'),
    ])
    const outils = { ffmpeg, ffprobe }
    const root = await this.racineCaptations()
    if (root == null) return { root: null, entries: [], outils }
    return { root, entries: await listerEnregistrements(this.vodDeps(root)), outils }
  }

  /** Extrait de quelques secondes, produit à la volée pour la modale. */
  async readRecordingExtract(file: string, atMs: number, dureeMs: number): Promise<Extrait | null> {
    const root = await this.racineCaptations()
    if (root == null) throw new Error('Aucun dossier d\u2019enregistrement connu')
    return await ouvrirExtrait(this.vodDeps(root), file, { atMs, dureeMs })
  }

  /** Le rush tel quel : pour l'ouvrir dans un vrai lecteur, ou le rapatrier. */
  async readRecordingFile(file: string, plage: string | null): Promise<FluxFichier | null> {
    const root = await this.racineCaptations()
    if (root == null) throw new Error('Aucun dossier d\u2019enregistrement connu')
    return await ouvrirFichier(this.vodDeps(root), file, plage)
  }

  /** Contrôle technique d'un rush : conteneur, pistes, durée, débit. */
  async inspectRecording(file: string): Promise<ControleVod> {
    const root = await this.racineCaptations()
    if (root == null) throw new Error('Aucun dossier d\u2019enregistrement connu')
    const controle = await inspecterEnregistrement(this.vodDeps(root), file)
    // Au journal de la salle, pas seulement à l'écran : un rush illisible
    // constaté à 11 h doit se retrouver le soir, quand on cherche ce qui manque.
    this.options.onLog?.(
      controle.status === 'ok' ? 'info' : controle.status === 'suspect' ? 'warn' : 'error',
      `contrôle VOD ${controle.status} : ${file}`,
      { raisons: controle.reasons },
    )
    return controle
  }

  /** Verdict posé à la main, qui prime sur la sonde. */
  async setRecordingVerdict(file: string, status: VerdictVod | null): Promise<ControleVod | null> {
    const root = await this.racineCaptations()
    if (root == null) throw new Error('Aucun dossier d\u2019enregistrement connu')
    return await poserVerdict(this.vodDeps(root), file, status)
  }

  /** Profondeur de la file, affichée en régie. */
  /** Retard de remontée affiché en régie — hors battement, qui se renouvelle seul. */
  outboxDepth(): number {
    return this.outbox?.backlog() ?? 0
  }

  /** Bascule l'écran de salle. */
  async setDisplayMode(mode: Parameters<RoomRuntime['setDisplayMode']>[0]): Promise<void> {
    await this.runtime.setDisplayMode(mode)
  }

  /** Bascule la scène de projection. */
  async setSceneRole(role: Parameters<RoomRuntime['setSceneRole']>[0]): Promise<void> {
    if (role === 'RELAY' && this.store.settings().config?.relaySourceRoomId == null) {
      // Basculer sur un relais non configuré projetterait une scène vide devant
      // la salle : mieux vaut refuser et le dire.
      throw new Error("Aucune salle source configurée pour le relais")
    }
    await this.runtime.setSceneRole(role)
  }

  /**
   * Démarre la conférence en cours au programme.
   *
   * La décision passe par le hub et non par l'état local : l'organisateur doit
   * la voir depuis la console, et les autres salles depuis leur propre vue.
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
    // La cible, pas la session « en cours » : entre deux talks ou pendant une
    // pause, c'est la conférence qui arrive qu'on veut piloter.
    const session = this.runtime.state().targetSession
    if (session == null) throw new Error('Aucune conférence à piloter dans cette salle')
    if (this.link == null) throw new Error('Hub non connecté : la décision ne serait vue nulle part')

    if (action === 'reset') {
      await this.link.client.sessions.reset({ sessionId: session.id })
      this.runtime.setSessionStatus(session.id, 'scheduled')
      return
    }
    const etat = await this.link.client.sessions[action]({ sessionId: session.id })
    // Applique localement sans attendre la commande retour : le bouton doit
    // réagir tout de suite, la commande confirmera.
    this.runtime.setSessionStatus(etat.sessionId, etat.status)
  }

  /**
   * Envoie un message à la console.
   *
   * Passe par l'outbox : un appel à l'aide émis pendant une coupure réseau
   * arrivera quand même, en retard — et c'est précisément le moment où on en a
   * le plus besoin.
   */
  sendMessage(text: string, level: 'info' | 'warning' | 'urgent'): void {
    this.emit({ type: 'room.message', text, level })
    this.runtime.notify({ level: 'info', text: `Envoyé à la console : ${text}` })
  }

  /** Pose ou retire le bandeau des scènes live, depuis la régie. */
  setLiveMessage(text: string | null, level: 'info' | 'warning' | 'urgent'): void {
    this.runtime.setLiveMessage(text, level)
  }

  /**
   * Met une question du public à l'antenne, ou l'en retire.
   *
   * Rattachée à la conférence pilotée : c'est ce qui la fait tomber au talk
   * suivant plutôt que de rester incrustée dans la VOD du speaker d'après.
   */
  setAiredQuestion(text: string | null, author: string | null): void {
    this.runtime.setQuestion(text, author, this.runtime.state().targetSession?.id ?? null)
  }

  /**
   * Relit les questions posées dans cette salle.
   *
   * À la demande : la régie ne les regarde qu'en fin de talk, et les faire
   * circuler en continu chargerait le flux d'état pour rien.
   */
  async refreshQuestions(): Promise<void> {
    if (this.link == null) throw new Error('Hub non connecté : les questions vivent chez lui')
    const { roomId, targetSession } = this.runtime.state()
    if (roomId == null) throw new Error('Salle inconnue')

    /**
     * Bornées à la conférence pilotée.
     *
     * Toutes salles confondues, la liste mélangeait les questions de la
     * journée : à 16 h, celles du talk de 10 h étaient encore en tête au vote,
     * et le speaker se voyait poser une question qui ne le concernait pas.
     * Aucun talk piloté : rien à lister — il n'y a pas de « questions en
     * général » qu'on voudrait mettre à l'antenne.
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
    // L'état repart tout de suite : la régie affiche la liste sans attendre.
    this.runtime.emit('state', this.runtime.state())
  }

  /** Écarte un signalement lu en régie. */
  dismissNotification(id: string): void {
    this.runtime.dismissNotification(id)
  }

  /** Resynchronisation demandée depuis la régie. */
  async resync(): Promise<void> {
    if (this.link == null) throw new Error("Hub non connecté : rien à synchroniser")
    const result = await this.link.sync()
    if (!result.ok) throw new Error('Le hub est injoignable')
  }

  /**
   * Enregistre un réglage de salle, puis remet la salle en accord avec lui.
   *
   * Trois temps, dans cet ordre : le hub écrit, la salle resynchronise, OBS se
   * rouvre. Écrire d'abord en local irait plus vite mais mentirait — le
   * prochain `sync` repousse la configuration du hub, et la saisie
   * disparaîtrait sans un mot. D'où l'échec franc quand le hub est absent : il
   * n'y a pas de demi-mesure honnête ici.
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

    // Pas de reconnexion d'office : les contrôleurs portent leurs paramètres à
    // la construction, donc appliquer voudrait dire couper — y compris une
    // captation en cours. La régie signale l'écart et laisse l'opérateur
    // choisir son moment, instance par instance.
    this.options.onLog?.('info', 'configuration de salle modifiée depuis la régie')
  }

  /** Relit les scènes des deux instances, pour le formulaire de configuration. */
  async refreshObsScenes(): Promise<void> {
    const lues = await Promise.allSettled([this.obsA?.refreshScenes(), this.obsB?.refreshScenes()])
    const echec = lues.find((resultat) => resultat.status === 'rejected')
    if (echec != null) throw new Error('OBS n\'a pas répondu — instance déconnectée ?')
  }

  /**
   * État interne exposé à la régie.
   *
   * Volontairement descriptif et non actionnable : la page n'a pas accès à
   * `RoomApp`, seulement à ce que ce contrat rend visible.
   */
  diagnostics(): ControlDiagnostics {
    return {
      obs: {
        A: this.obsA?.snapshot() ?? null,
        B: this.obsB?.snapshot() ?? null,
      },
      outboxDepth: this.outboxDepth(),
      journal: this.store.recentLogs(8).map((entry) => ({
        level: entry.level,
        message: entry.message,
        createdAt: entry.createdAt,
      })),
      relaySourceRoomId: this.store.settings().config?.relaySourceRoomId ?? null,
      config: this.configVisible(),
      questions: this.questions,
      questionsRefreshedAt: this.questionsAt,
      questionsSession: this.questionsSession,
      mode: { salle: this.options.mode ?? 'production', hub: this.hubMode },
      rooms: this.roomStatuses,
      roomsRefreshedAt: this.roomStatusesAt,
      recording: {
        active: this.recording?.active ?? false,
        markers: this.recording?.markerCount ?? 0,
        startedAtMs: this.recording?.startedAt ?? null,
      },
    }
  }

  /** Réglages de la salle, mots de passe retirés. Voir `ConfigVisible`. */
  private configVisible(): ControlDiagnostics['config'] {
    const config = this.store.settings().config
    if (config == null) return null
    return {
      obs: {
        A: this.pointVisible(config, 'A'),
        B: this.pointVisible(config, 'B'),
      },
      sceneRoles: config.sceneRoles,
      displayPort: config.displayPort,
      recordingRoot: config.recordingRoot,
      fileSlug: config.fileSlug,
      relaySourceRoomId: config.relaySourceRoomId,
      openFeedbackProjectId: config.openFeedbackProjectId,
      promptRecordingOnStart: config.promptRecordingOnStart,
      sceneOnStart: config.sceneOnStart,
    }
  }

  private pointVisible(config: ConfigSalle, instance: ObsInstance): PointObsVisible {
    const applique = this.obsApplique[instance]
    return {
      url: config.obs[instance].url,
      hasPassword: (config.obs[instance].password ?? '') !== '',
      // Jamais branchée : le bouton « Connecter » dit déjà quoi faire, inutile
      // d'annoncer en plus un écart avec une connexion qui n'existe pas.
      pending: applique != null && applique !== empreinteObs(config, instance),
    }
  }

  async close(): Promise<void> {
    this.abort.abort()
    // Laisse l'appairage constater l'interruption : sans ça, sa boucle de
    // sondage survivrait à la fermeture.
    await this.appairageEnCours?.catch(() => {})
    this.pump?.stop()
    this.televersements.arreter()
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


/** Accès disque réel pour les sidecars. Injecté, donc remplaçable en test. */
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
