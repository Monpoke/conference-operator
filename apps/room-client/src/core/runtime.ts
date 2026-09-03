import { EventEmitter } from 'node:events'
import {
  DUREE_SIGNALEMENT_MS,
  isCommandExpired,
  type AiredQuestion,
  type BroadcastMessage,
  type Comment,
  type Command,
  type Connectivity,
  type DisplayMode,
  type DisplayState,
  type Notification,
  type SceneRole,
  type SessionStatus,
} from '@cloudnord/contract'
import { talkToControl, roomBreak } from '@cloudnord/room-state'
import {
  currentSession,
  nextSession,
  sessionsForRoom,
  type Program,
  type Session,
} from '@cloudnord/program'
import type { LocalStore } from './store.js'

/*
 * Réexportés, et non redéfinis : les définitions sont dans `@cloudnord/contract`
 * depuis que la régie est un paquet à part. Les garder visibles ici évite de
 * toucher aux imports de tout ce qui lit l'état d'une salle.
 */
export { DUREE_SIGNALEMENT_MS }
export type { AiredQuestion, BroadcastMessage, DisplayState, Notification }


export interface RuntimeEffects {
  /** Bascule OBS-A. Séparé du runtime pour rester testable sans OBS. */
  setSceneRole?: (role: SceneRole) => Promise<void>
  /** Redemande un sync au hub après invalidation du programme. */
  resync?: (contentHash: string) => void
  /**
   * Relit le cycle de vie des conférences auprès du hub.
   *
   * Le runtime tient une copie locale, alimentée au fil des commandes : elle ne
   * peut pas se corriger seule quand c'est le *temps* qui change, puisqu'aucune
   * commande n'est émise pour les décisions qui cessent de s'appliquer.
   */
  reloadSessionStates?: () => void
  /** Resynchronisation complète demandée par la console. */
  fullResync?: () => void
  /**
   * Rapatriement des rushes demandé par la console. `file` nul = tout ce qui reste.
   *
   * Le runtime ne téléverse rien lui-même : il n'a ni disque ni réseau. Il
   * transmet, exactement comme pour la resynchronisation.
   */
  uploadVod?: (file: string | null) => void
  /**
   * Efface les rushes de la salle. **Développement seulement.**
   *
   * Le runtime ne supprime rien lui-même : il transmet, comme pour le reste.
   * Le refus de production vit dans `RoomApp`, au plus près du disque.
   */
  razVod?: () => void
  /**
   * Captation d'OBS-B, demandée à distance.
   *
   * Séparé du runtime comme `setSceneRole`, et pour la même raison : ce module
   * décide *quoi* faire, la machine sait *comment*. Demander ce qui tourne déjà
   * doit être un succès silencieux — une commande rejouée à la reconnexion ne
   * doit pas produire un incident dans la pile de la régie.
   */
  setRecording?: (on: boolean) => void
  /** Diffusion d'OBS-B. Même forme et mêmes raisons que `setRecording`. */
  setStreaming?: (on: boolean) => void
  /**
   * Redemande au hub l'état des autres salles, sans attendre le tour de sonde.
   *
   * Ce que fait une salle voisine arrive déjà poussé sur le flux de commandes ;
   * seule la *vue* qui l'affiche était sondée. La régie recevait donc la
   * notification « Track #2 vient de terminer » pendant que la pastille de
   * Track #2 disait encore « en cours ».
   */
  refreshRoomStatuses?: () => void
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
      remoteHolder: null,
      breakBadge: null,
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
    // La cible dépend du cycle de vie : terminer la conférence à venir doit
    // faire passer la régie à la suivante tout de suite, pas au prochain tic.
    this.refreshSessions()
  }

  /**
   * Remplace tout le cycle de vie par ce que dit le hub.
   *
   * Un remplacement, pas une fusion : ce qui a disparu de la liste du hub doit
   * disparaître ici aussi. Une décision annulée — par la console, ou parce
   * qu'on a reculé l'horloge — ne s'efface d'aucune autre façon, et une salle
   * qui garderait « en cours » sur une conférence à venir peindrait sa pastille
   * et son compte à rebours sur un fait qui n'existe plus.
   */
  replaceSessionStates(etats: { sessionId: string; status: SessionStatus }[]): void {
    const suivant: Record<string, SessionStatus> = {}
    // `scheduled` reste l'absence d'état, à l'identique de setSessionStatus.
    for (const etat of etats) {
      if (etat.status !== 'scheduled') suivant[etat.sessionId] = etat.status
    }
    this.patch({ sessionStates: suivant })
    this.refreshSessions()
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
      this.patch({ currentSession: null, nextSession: null, breakBadge: null })
      return
    }
    const at = this.correctedNow()
    const courante = currentSession(this.program, roomId, at)
    const suivante = nextSession(this.program, roomId, at)

    /**
     * Cible des commandes : ce que « Commencer » et « Terminer » atteignent.
     *
     * La règle vit dans `talkToControl`, avec le reste de l'automate : la
     * console du hub et le banc d'essai la déroulent aussi, et trois copies
     * d'une règle d'horaire finissent toujours par diverger.
     */
    const cible = talkToControl(
      sessionsForRoom(this.program, roomId),
      at,
      this.display.sessionStates,
    )

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

    const pause = roomBreak(this.program, roomId, at)

    this.patch({
      currentSession: courante,
      nextSession: suivante,
      targetSession: cible,
      /**
       * « À venir » se lit sur l'horaire, pas sur l'écart à la session courante.
       *
       * Une conférence en dépassement n'est plus le créneau courant — son
       * créneau est clos — sans être pour autant à venir : elle est à
       * l'antenne. Comparer les identifiants l'annonçait « à venir » au moment
       * précis où elle débordait.
       */
      targetIsUpcoming: cible != null && cible.startsAtMs > at,
      breakBadge:
        pause == null
          ? null
          : { state: pause.state, title: pause.session.title, startsAt: pause.session.startsAt },
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
      case 'room.resync':
        /**
         * Signalé en régie, et pas seulement au journal.
         *
         * Une salle qui se remet à télécharger son programme au milieu d'une
         * journée sans que personne ne l'ait demandé sur place se lit comme un
         * incident. Dire d'où vient le geste évite qu'on aille le chercher.
         */
        this.notify({
          level: 'info',
          text:
            payload.requestedBy == null
              ? 'Resynchronisation complète demandée depuis la console'
              : `Resynchronisation complète demandée par ${payload.requestedBy}`,
        })
        this.effects.fullResync?.()
        break
      case 'vod.upload':
        /**
         * Signalé en régie, comme la resynchronisation, et pour la même raison.
         *
         * Une salle qui se met à saturer son uplink au milieu d'une journée
         * sans que personne ne l'ait demandé sur place se lit comme un
         * incident. Dire d'où vient le geste évite qu'on cherche la panne.
         */
        this.notify({
          level: 'info',
          text:
            payload.requestedBy == null
              ? 'Rapatriement des rushes demandé depuis la console'
              : `Rapatriement des rushes demandé par ${payload.requestedBy}`,
        })
        this.effects.uploadVod?.(payload.file)
        break
      case 'vod.reset':
        /**
         * Signalée en régie, et en avertissement.
         *
         * Une salle qui perd ses rushes doit le dire fort et nommer qui l'a
         * demandé : c'est le seul geste du système dont on ne revient pas, et
         * découvrir le dossier vide sans savoir pourquoi est le pire des deux
         * moments.
         */
        this.notify({
          level: 'warning',
          text:
            payload.requestedBy == null
              ? 'Remise à zéro des rushes demandée depuis la console'
              : `Remise à zéro des rushes demandée par ${payload.requestedBy}`,
        })
        this.effects.razVod?.()
        break
      case 'recording.set':
        /**
         * Signalé en régie, comme la resynchronisation et pour la même raison.
         *
         * Un enregistrement qui démarre — ou pire, qui s'arrête — sans que
         * personne n'ait touché au clavier de la salle se lit comme une panne
         * d'OBS. Nommer qui l'a demandé évite qu'on aille chercher un défaut à
         * l'endroit où il n'y en a pas.
         */
        this.notify({
          level: 'info',
          text: `${payload.on ? 'Enregistrement démarré' : 'Enregistrement arrêté'} ${demandePar(payload.requestedBy)}`,
        })
        this.effects.setRecording?.(payload.on)
        break
      case 'stream.set':
        this.notify({
          level: 'info',
          text: `${payload.on ? 'Diffusion démarrée' : 'Diffusion arrêtée'} ${demandePar(payload.requestedBy)}`,
        })
        this.effects.setStreaming?.(payload.on)
        break
      case 'regie.hold':
        /**
         * Qui pilote la salle à distance — un affichage, et rien d'autre.
         *
         * Aucun bouton ne se grise ici : l'opérateur qui est dans la salle ne
         * doit jamais dépendre d'un téléphone parti dans un couloir, ni d'un
         * verrou qu'on a oublié de rendre. Ce que la commande change est ce
         * que l'écran *dit*, faute de quoi une scène qui bascule toute seule
         * s'interprète comme un incident — en plein talk.
         */
        this.patch({ remoteHolder: payload.holder })
        this.notify({
          level: 'info',
          text:
            payload.holder == null
              ? 'La régie mobile a rendu la salle'
              : `Salle pilotée à distance par ${payload.holder}`,
        })
        break
      case 'session.state': {
        const notre = this.display.roomId
        if (payload.roomId == null || payload.roomId === notre) {
          this.setSessionStatus(payload.sessionId, payload.status)
          break
        }
        /**
         * Une autre salle : on ne touche pas à notre état, mais on va relire
         * le sien.
         *
         * Le cycle de vie des autres salles ne nous est pas envoyé — et on n'en
         * veut pas, il n'a rien à faire dans notre état. Ce qui l'affiche est la
         * vue de supervision, sondée : la commande sert donc de déclencheur, et
         * la pastille suit la notification au lieu de la traîner d'un tour.
         */
        this.effects.refreshRoomStatuses?.()
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
        /**
         * Et on relit le cycle de vie dans la foulée.
         *
         * Reculer l'horloge annule des décisions : un talk lancé plus tard dans
         * la journée n'a pas encore commencé au nouvel instant. Le hub le sait
         * — c'est lui qui date les décisions —, la salle non : sans cette
         * relecture, la régie garde « en cours » sur une conférence à venir
         * jusqu'à la prochaine synchronisation.
         */
        this.effects.reloadSessionStates?.()
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

/**
 * D'où vient un geste posé à distance.
 *
 * `null` n'arrive que d'un hub plus ancien que cette commande — le champ a un
 * défaut. On dit alors « depuis le hub » plutôt que d'inventer un nom : le
 * signalement sert à ce que l'opérateur cesse de chercher une panne, et « par
 * personne » relancerait exactement la recherche qu'il doit clore.
 */
function demandePar(requestedBy: string | null): string {
  return requestedBy == null ? 'depuis le hub' : `par ${requestedBy}`
}
