import { EventEmitter } from 'node:events'
import {
  isCommandExpired,
  type Comment,
  type Command,
  type Connectivity,
  type DisplayMode,
  type SceneRole,
  type SessionStatus,
} from '@cloudnord/contract'
import {
  currentSession,
  nextSession,
  sessionsForRoom,
  type Program,
  type Session,
} from '@cloudnord/program'
import type { LocalStore } from './store.js'

export interface BroadcastMessage {
  text: string
  level: 'info' | 'warning' | 'urgent'
  /** Expiration absolue : une commande rattrapée en retard ne réapparaît pas. */
  expiresAtMs: number | null
}

/**
 * Question du public mise à l'antenne depuis la régie.
 *
 * **Canal distinct de `liveMessage`, et c'est tout l'objet du type.** Les deux
 * ont longtemps partagé un seul champ : un « on reprend dans 5 minutes » envoyé
 * du hub s'affichait alors à la place de la question sur l'écran de salle, et
 * surtout, aucune surface ne pouvait montrer l'un sans risquer l'autre. Or ils
 * ne vont pas au même endroit — la question a sa place dans la VOD, le message
 * d'exploitation non.
 */
export interface AiredQuestion {
  text: string
  author: string | null
  /**
   * Conférence à laquelle elle se rattache.
   *
   * Sert à la faire tomber d'elle-même au talk suivant : une question restée à
   * l'antenne au changement de conférence serait incrustée dans la VOD du
   * mauvais speaker.
   */
  sessionId: string | null
}

/** Ce que la page d'affichage doit rendre à un instant donné. */
export interface DisplayState {
  mode: DisplayMode
  message: BroadcastMessage | null
  /**
   * Bandeau superposé aux scènes live.
   *
   * Distinct de `message` : celui-ci **remplace** l'écran de salle, le bandeau
   * se pose par-dessus la vidéo sans rien interrompre. Les deux coexistent
   * donc, et c'est voulu.
   *
   * Distinct de `question` aussi : ce bandeau-ci vient de la console et ne doit
   * jamais atteindre l'habillage de captation — il ne parle pas au public de la
   * VOD, il parle à la salle de maintenant.
   */
  liveMessage: BroadcastMessage | null
  /** Question du public à l'antenne. Va dans la VOD, contrairement au bandeau. */
  question: AiredQuestion | null
  sceneRole: SceneRole | null
  connectivity: Connectivity
  roomId: string | null
  contentHash: string | null
  currentSession: Session | null
  nextSession: Session | null
  outboxDepth: number
  serverTimeOffsetMs: number
  /**
   * État réel d'OBS-B, observé et non supposé.
   *
   * Sert au témoin de la régie, jamais à l'habillage : ce qui est dans
   * l'habillage part dans le master, et un point rouge gravé dans la VOD n'a
   * rien à y faire.
   */
  recording: boolean
  streaming: boolean
  /**
   * Derniers messages approuvés. Bornés : un mur qui défile sans fin devient
   * illisible à dix mètres, et la mémoire du client n'a pas à tout garder.
   */
  comments: Comment[]
  /**
   * État des conférences, par identifiant. Absent = « à venir ».
   * Seul ce qui s'est produit est stocké, ici comme sur le hub.
   */
  sessionStates: Record<string, SessionStatus>
  /** Faits récents dignes d'être signalés en régie. Bornés et périssables. */
  notifications: Notification[]
  /**
   * L'heure vient d'un hub à horloge simulée.
   *
   * Affiché en régie : voir 11:00 un matin d'août sans explication ferait
   * douter de tout le reste de l'écran.
   */
  /**
   * Conférence sur laquelle portent les commandes de régie.
   *
   * Rarement la même que `currentSession` : entre deux talks, pendant une
   * pause, ou quelques minutes avant le début, `currentSession` est vide ou
   * désigne un créneau sans speaker. Or c'est exactement à ces moments-là que
   * l'opérateur veut appuyer sur « Commencer » — le speaker s'installe.
   */
  targetSession: Session | null
  /** La cible n'a pas encore commencé au programme : l'écran doit le dire. */
  targetIsUpcoming: boolean
  simulatedClock: boolean
}

/**
 * Signalement affiché en haut de la régie.
 *
 * Sert surtout aux autres salles : savoir qu'un talk vient de se terminer à
 * côté permet d'anticiper un enchaînement ou une bascule, sans avoir à
 * surveiller le panneau des salles en permanence.
 */
export interface Notification {
  id: string
  level: 'info' | 'warning'
  text: string
  at: string
}

/**
 * Durée de vie d'un signalement.
 *
 * Un bandeau qui ne part pas cesse d'être lu : la régie finissait la journée
 * avec cinq signalements empilés au-dessus des commandes, tous périmés depuis
 * longtemps. Trente secondes suffisent à voir passer un fait ponctuel — et ce
 * qui doit rester consultable, l'état des autres salles, est de toute façon
 * dans le flux d'en-tête, qui lui ne périme pas.
 */
export const DUREE_SIGNALEMENT_MS = 30_000

export interface RuntimeEffects {
  /** Bascule OBS-A. Séparé du runtime pour rester testable sans OBS. */
  setSceneRole?: (role: SceneRole) => Promise<void>
  /** Redemande un sync au hub après invalidation du programme. */
  resync?: (contentHash: string) => void
}

export type CommandOutcome =
  | { applied: true }
  | { applied: false; reason: 'expired' | 'already-applied' | 'unsupported' }

/**
 * État courant de la salle et application des commandes descendantes.
 *
 * Volontairement sans réseau ni Electron : le runtime décide *quoi* afficher et
 * *quelle* scène demander, les effets réels sont injectés.
 */
export class RoomRuntime extends EventEmitter {
  private display: DisplayState
  private program: Program | null

  constructor(
    private readonly store: LocalStore,
    private readonly effects: RuntimeEffects = {},
    private readonly now: () => number = Date.now,
  ) {
    super()
    const settings = store.settings()
    const cached = store.activeProgram()
    this.program = cached?.program ?? null
    this.display = {
      /**
       * Au démarrage, la boucle d'attente.
       *
       * C'est l'état neutre d'une salle avant intervention, et celui qu'on veut
       * y trouver le matin sans que personne n'ait rien touché. Elle se réduit
       * d'elle-même aux pages qui ont du contenu : une salle jamais
       * synchronisée y montre les sponsors, comme avant.
       */
      mode: 'loop',
      message: null,
      liveMessage: null,
      question: null,
      sceneRole: null,
      connectivity: 'OFFLINE',
      roomId: settings.roomId,
      contentHash: cached?.contentHash ?? null,
      currentSession: null,
      nextSession: null,
      outboxDepth: 0,
      serverTimeOffsetMs: settings.clockOffsetMs,
      recording: false,
      streaming: false,
      comments: [],
      sessionStates: {},
      notifications: [],
      simulatedClock: false,
      targetSession: null,
      targetIsUpcoming: false,
    }
    this.refreshSessions()
  }

  state(): DisplayState {
    return { ...this.display }
  }

  /**
   * Applique un changement d'état, et ne prévient que s'il y en a un.
   *
   * Le tic d'horloge recalcule la timeline toutes les 5 s : sans cette
   * comparaison, il republiait un état identique, et chaque page abonnée
   * recevait la charge utile complète pour rien.
   */
  private patch(patch: Partial<DisplayState>): void {
    const courant = this.display as unknown as Record<string, unknown>
    const modifie = Object.entries(patch).some(
      ([cle, valeur]) => JSON.stringify(courant[cle] ?? null) !== JSON.stringify(valeur ?? null),
    )
    if (!modifie) return
    this.display = { ...this.display, ...patch }
    this.emit('state', this.state())
  }

  /**
   * Heure corrigée de l'offset serveur — jamais `Date.now()` brut pour l'affichage.
   *
   * **`serverTimeOffsetMs` se compte à partir de l'horloge de la machine.** Les
   * pages servies le rajoutent à leur propre `Date.now()`, la file de remontée
   * date ses événements de la même façon, et une horloge injectée ici les
   * ferait diverger sans un mot : c'est pourquoi l'heure simulée d'une salle
   * est **un décalage** et non une horloge de remplacement.
   */
  correctedNow(): number {
    return this.now() + this.display.serverTimeOffsetMs
  }

  setConnectivity(connectivity: Connectivity): void {
    if (connectivity !== this.display.connectivity) this.patch({ connectivity })
  }

  setOutboxDepth(outboxDepth: number): void {
    if (outboxDepth !== this.display.outboxDepth) this.patch({ outboxDepth })
  }

  /**
   * Ajoute un message approuvé au mur.
   *
   * Déduplique : la reprise du flux après coupure peut relivrer ce qui est
   * déjà affiché.
   */
  addComment(comment: Comment, limit = 12): void {
    if (this.display.comments.some((existing) => existing.id === comment.id)) return
    this.patch({ comments: [...this.display.comments, comment].slice(-limit) })
  }

  /**
   * Signale un fait en régie. Les plus anciens tombent : une pile qui grandit
   * sans fin cesse d'être lue.
   */
  notify(notification: Omit<Notification, 'id' | 'at'>, limit = 5): void {
    const entree: Notification = {
      ...notification,
      id: `${this.now()}-${Math.random().toString(36).slice(2, 8)}`,
      at: new Date(this.correctedNow()).toISOString(),
    }
    this.patch({ notifications: [...this.display.notifications, entree].slice(-limit) })
  }

  dismissNotification(id: string): void {
    this.patch({ notifications: this.display.notifications.filter((n) => n.id !== id) })
  }

  /** Applique un changement d'état décidé sur le hub ou par la règle horaire. */
  setSessionStatus(sessionId: string, status: SessionStatus): void {
    const suivant = { ...this.display.sessionStates }
    // `scheduled` est l'absence d'état : on retire plutôt que de stocker un
    // marqueur qui voudrait dire « rien ne s'est produit ».
    if (status === 'scheduled') delete suivant[sessionId]
    else suivant[sessionId] = status
    this.patch({ sessionStates: suivant })
  }

  /** État de la conférence pilotable. */
  currentSessionStatus(): SessionStatus {
    const id = this.display.targetSession?.id
    return id == null ? 'scheduled' : (this.display.sessionStates[id] ?? 'scheduled')
  }

  /** Reflète l'état d'OBS-B. Toujours issu d'un événement OBS, jamais supposé. */
  observeCapture(patch: { recording?: boolean; streaming?: boolean }): void {
    const next = { ...this.display, ...patch }
    if (next.recording !== this.display.recording || next.streaming !== this.display.streaming) {
      this.patch({ recording: next.recording, streaming: next.streaming })
    }
  }

  /**
   * Cale l'horloge sur celle du hub.
   *
   * L'écart se mesure contre **notre** horloge, pas contre un `Date.now()`
   * relu par l'appelant. La nuance a coûté cher : mesuré de travers, l'écart
   * s'ajoutait à une salle déjà décalée, et la régie cherchait ses conférences
   * plusieurs semaines après la fin de l'événement — « aucune conférence à
   * piloter », pendant que le flux des autres salles, lui, tombait juste.
   */
  setServerTime(serverTime: string, simulated = this.display.simulatedClock): void {
    this.setClockOffset(Date.parse(serverTime) - this.now(), simulated)
  }

  setClockOffset(offsetMs: number, simulated = this.display.simulatedClock): void {
    if (offsetMs === this.display.serverTimeOffsetMs && simulated === this.display.simulatedClock) {
      return
    }
    this.store.saveSettings({ clockOffsetMs: offsetMs })
    this.patch({ serverTimeOffsetMs: offsetMs, simulatedClock: simulated })
    // L'heure a bougé : la conférence en cours aussi, peut-être. Attendre le
    // tic suivant laisserait l'écran désigner le mauvais talk pendant 5 s.
    this.refreshSessions()
  }

  /**
   * Bandeau posé depuis la régie.
   *
   * Sans durée : la régie a un bouton pour le retirer, et un bandeau qui
   * disparaît seul pendant qu'on regarde ailleurs se remet sans qu'on sache
   * pourquoi il était parti.
   */
  setLiveMessage(text: string | null, level: 'info' | 'warning' | 'urgent' = 'info'): void {
    this.patch({ liveMessage: text == null ? null : { text, level, expiresAtMs: null } })
  }

  /**
   * Question mise à l'antenne depuis la régie.
   *
   * Sans durée, comme le bandeau : la régie a un bouton pour la retirer. Elle
   * porte en revanche la conférence à laquelle elle se rattache — voir
   * `refreshSessions`, qui la fait tomber au talk suivant.
   */
  setQuestion(text: string | null, author: string | null, sessionId: string | null): void {
    this.patch({ question: text == null ? null : { text, author, sessionId } })
  }

  setProgram(contentHash: string, program: Program): void {
    this.program = program
    this.patch({ contentHash })
    this.refreshSessions()
  }

  setRoomId(roomId: string): void {
    this.patch({ roomId })
    this.refreshSessions()
  }

  /** Recalcule session en cours / suivante. À rappeler sur tic d'horloge. */
  refreshSessions(): void {
    const { roomId } = this.display
    if (this.program == null || roomId == null) {
      this.patch({ currentSession: null, nextSession: null })
      return
    }
    const at = this.correctedNow()
    const courante = currentSession(this.program, roomId, at)
    const suivante = nextSession(this.program, roomId, at)

    /**
     * Cible des commandes : la conférence en cours si c'en est une, sinon la
     * prochaine. Un créneau sans speaker (pause, déjeuner) ne se « démarre »
     * pas — ce que l'opérateur veut piloter à ce moment-là, c'est le talk qui
     * arrive.
     */
    const prochainTalk =
      sessionsForRoom(this.program, roomId).find(
        (session) => session.kind === 'talk' && session.startsAtMs > at,
      ) ?? null
    const cible = courante?.kind === 'talk' ? courante : prochainTalk

    /**
     * La question à l'antenne tombe avec le talk auquel elle appartient.
     *
     * Sans ça, elle reste incrustée dans l'habillage de captation pendant que
     * le speaker suivant s'installe — gravée dans sa VOD, adressée à quelqu'un
     * d'autre. Une question sans conférence rattachée (posée hors talk) n'est
     * pas concernée : rien ne dit quand elle devrait tomber.
     */
    const question = this.display.question
    const questionPerimee =
      question != null && question.sessionId != null && question.sessionId !== cible?.id

    this.patch({
      currentSession: courante,
      nextSession: suivante,
      targetSession: cible,
      targetIsUpcoming: cible != null && cible.id !== courante?.id,
      ...(questionPerimee ? { question: null } : {}),
    })
  }

  /** Bascule d'affichage demandée localement par l'opérateur. */
  async setDisplayMode(mode: DisplayMode): Promise<void> {
    this.patch({ mode })
  }

  async setSceneRole(role: SceneRole): Promise<void> {
    await this.effects.setSceneRole?.(role)
    this.patch({ sceneRole: role })
  }

  /** L'état de scène observé sur OBS fait foi et écrase le nôtre. */
  observeSceneRole(role: SceneRole | null): void {
    if (role !== this.display.sceneRole) this.patch({ sceneRole: role })
  }

  /**
   * Applique une commande du hub.
   *
   * Deux filtres avant toute action, dans cet ordre : l'expiration (un « pause
   * déjeuner » rattrapé 40 min plus tard ne doit pas s'afficher) puis le rejeu
   * (une reconnexion peut relivrer ce qui est déjà appliqué).
   */
  async applyCommand(command: Command): Promise<CommandOutcome> {
    if (isCommandExpired(command, this.correctedNow())) {
      // Marquée quand même : sinon chaque reconnexion la re-livrerait.
      this.store.markApplied(command.seq, command.payload.type)
      return { applied: false, reason: 'expired' }
    }
    if (this.store.hasApplied(command.seq)) {
      return { applied: false, reason: 'already-applied' }
    }

    const payload = command.payload
    switch (payload.type) {
      case 'scene.force':
        await this.setSceneRole(payload.role)
        break
      case 'display.set':
        this.patch({ mode: payload.mode })
        break
      case 'message.broadcast': {
        const auteur = payload.from == null ? '' : `${payload.from} : `
        if (payload.target === 'operator') {
          /**
           * Bandeau de régie uniquement.
           *
           * Basculer l'écran de salle pour une note à l'opérateur l'afficherait
           * en grand devant le public — « ton speaker est arrivé » n'a rien à
           * y faire.
           */
          this.notify({
            level: payload.level === 'info' ? 'info' : 'warning',
            text: `${auteur}${payload.text}`,
          })
          break
        }

        /**
         * Destiné au public : l'écran de salle prend le message.
         *
         * La durée d'affichage court depuis **maintenant**, pas depuis
         * l'émission par le hub. Un message affiché doit rester lisible le
         * temps annoncé, même s'il a mis quelques secondes à arriver — ou si
         * l'horloge de la salle diverge de celle du hub. L'obsolescence, elle,
         * est un tout autre filtre : elle se juge sur `issuedAt`, avant
         * d'arriver ici.
         */
        this.patch({
          mode: 'message',
          message: {
            text: payload.text,
            level: payload.level,
            expiresAtMs:
              command.ttlSeconds == null ? null : this.correctedNow() + command.ttlSeconds * 1000,
          },
        })
        // La régie doit aussi savoir ce qui est projeté chez elle.
        this.notify({
          level: payload.level === 'urgent' ? 'warning' : 'info',
          text: `Affiché en salle — ${auteur}${payload.text}`,
        })
        break
      }
      case 'overlay.set':
        // Le bandeau ne touche ni au mode d'écran ni à la scène : il se
        // superpose, et la salle continue exactement ce qu'elle faisait.
        this.patch({
          liveMessage:
            payload.message == null
              ? null
              : {
                  ...payload.message,
                  expiresAtMs:
                    command.ttlSeconds == null
                      ? null
                      : this.correctedNow() + command.ttlSeconds * 1000,
                },
        })
        break
      case 'program.invalidate':
        this.effects.resync?.(payload.contentHash)
        break
      case 'session.state': {
        const notre = this.display.roomId
        if (payload.roomId == null || payload.roomId === notre) {
          this.setSessionStatus(payload.sessionId, payload.status)
          break
        }
        // Une autre salle : on ne touche pas à notre état, on signale.
        if (payload.status === 'ended') {
          this.notify({
            level: 'info',
            text: `${payload.sessionTitle ?? 'Une conférence'} vient de se terminer dans une autre salle`,
          })
        }
        break
      }
      case 'clock.changed': {
        /**
         * L'heure du hub a bougé : on recale immédiatement.
         *
         * Sans ça, l'écran continuerait d'afficher l'ancien moment jusqu'à la
         * prochaine synchronisation — et la timeline désignerait le mauvais talk.
         */
        this.setServerTime(payload.serverTime, payload.simulated)
        this.notify({
          level: 'info',
          text: payload.simulated
            ? "Heure du hub modifiée (horloge simulée)"
            : "Heure du hub revenue à l'heure réelle",
        })
        break
      }
      case 'session.override':
      case 'wall.approved':
      case 'stream.configure':
        // Câblés aux lots suivants ; on trace l'application pour ne pas les
        // recevoir en boucle à chaque reconnexion.
        this.store.markApplied(command.seq, payload.type)
        return { applied: false, reason: 'unsupported' }
    }

    this.store.markApplied(command.seq, payload.type)
    return { applied: true }
  }

  /** Retire un message dont le TTL est écoulé. À appeler sur tic d'horloge. */
  expireMessage(): void {
    const { message, liveMessage } = this.display
    const maintenant = this.correctedNow()

    if (message?.expiresAtMs != null && maintenant > message.expiresAtMs) {
      // Retour à la boucle d'attente : c'est l'écran par défaut de la salle, et
      // celui sur lequel on veut retomber quand un message s'efface tout seul.
      this.patch({ message: null, mode: 'loop' })
    }
    // Le bandeau expire seul, mais ne ramène rien : il ne s'était substitué à
    // rien, il se retire simplement de l'image.
    if (liveMessage?.expiresAtMs != null && maintenant > liveMessage.expiresAtMs) {
      this.patch({ liveMessage: null })
    }
  }

  /**
   * Retire les signalements passés de date. À appeler sur tic d'horloge.
   *
   * Écarter à la main reste possible et immédiat ; ceci ne concerne que ceux
   * que personne n'a écartés, c'est-à-dire la plupart : en régie, on lit le
   * bandeau, on ne le range pas.
   */
  expireNotifications(): void {
    const { notifications } = this.display
    if (notifications.length === 0) return
    const limite = this.correctedNow() - DUREE_SIGNALEMENT_MS
    const restants = notifications.filter((signalement) => Date.parse(signalement.at) > limite)
    if (restants.length !== notifications.length) this.patch({ notifications: restants })
  }
}
