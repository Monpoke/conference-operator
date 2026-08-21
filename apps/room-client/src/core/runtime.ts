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

/** Ce que la page d'affichage doit rendre à un instant donné. */
export interface DisplayState {
  mode: DisplayMode
  message: BroadcastMessage | null
  sceneRole: SceneRole | null
  connectivity: Connectivity
  roomId: string | null
  contentHash: string | null
  currentSession: Session | null
  nextSession: Session | null
  outboxDepth: number
  serverTimeOffsetMs: number
  /** État réel d'OBS-B, observé et non supposé. Sert au témoin de l'overlay. */
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
      // Au démarrage on montre les sponsors : c'est l'état neutre d'une salle
      // avant intervention, et il ne dépend d'aucune donnée temps réel.
      mode: 'sponsors',
      message: null,
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

  /** Heure corrigée de l'offset serveur — jamais `Date.now()` brut pour l'affichage. */
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

  setClockOffset(offsetMs: number, simulated = this.display.simulatedClock): void {
    this.store.saveSettings({ clockOffsetMs: offsetMs })
    this.patch({ serverTimeOffsetMs: offsetMs, simulatedClock: simulated })
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

    this.patch({
      currentSession: courante,
      nextSession: suivante,
      targetSession: cible,
      targetIsUpcoming: cible != null && cible.id !== courante?.id,
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
        this.setClockOffset(Date.parse(payload.serverTime) - this.now(), payload.simulated)
        this.refreshSessions()
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
    const { message } = this.display
    if (message?.expiresAtMs == null) return
    if (this.correctedNow() > message.expiresAtMs) {
      this.patch({ message: null, mode: 'sponsors' })
    }
  }
}
