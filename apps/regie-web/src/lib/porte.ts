import type {
  VisibleConfig,
  DisplayMode,
  DisplayPayload,
  ControlCommand,
  ControlView,
  SceneRole,
} from '@cloudnord/contract'
import { NO_EDITING_MARKS } from '@cloudnord/contract'
import type { HubClient } from '@cloudnord/hub-client'

/**
 * La régie, et les deux façons de l'atteindre.
 *
 * L'écran de régie parle à sa propre machine : SSE pour l'état, un POST pour
 * les gestes, le tout sur `127.0.0.1`. La régie **mobile** est la même
 * application, servie par le hub, qui pilote une salle à distance. Ce qui
 * change entre les deux tient entièrement ici — les panneaux ne savent pas d'où
 * vient leur état ni où part leur geste.
 *
 * Trois propriétés rendent cette réutilisation possible, et il faut les tenir :
 *
 * 1. les panneaux prennent des `props`, pas le store ;
 * 2. le store `room` ne contient qu'un `DisplayPayload` — la porte distante en
 *    **synthétise** un depuis la vue du hub ;
 * 3. tout geste passe par `actions.act()`, y compris ceux de `conference.ts`.
 *
 * La règle qui gouverne les deux portes est la même, et c'est la plus
 * importante : **aucune action n'écrit dans l'état**. Un bouton actif décrit
 * OBS, jamais ce qu'on a demandé à OBS.
 */

/** Ce que le poste répond à une action. Le message est écrit pour l'opérateur. */
export interface ActionResult {
  ok: boolean
  message?: string
  /**
   * Ce que le geste rapporte, quand il rapporte quelque chose.
   *
   * Rare, et volontairement non typé : la quasi-totalité des actions n'ont
   * d'autre effet que sur l'état, qui revient par le flux. Seuls les gestes qui
   * **posent une question au poste** ont une réponse — le sélecteur de dossier
   * rend le chemin choisi, et la page remplit son champ avec.
   */
  detail?: unknown
}

/** Ce que la porte pousse vers le store d'état. */
export interface FluxEtat {
  /** Instantané complet, ou fusion partielle par-dessus le précédent. */
  onPayload: (payload: DisplayPayload | Partial<DisplayPayload>, complet: boolean) => void
  /** Le flux est coupé, ou de nouveau vivant. */
  onCoupure: (coupe: boolean) => void
}

export interface PorteRegie {
  demarrer(flux: FluxEtat): void
  arreter(): void
  act(geste: Record<string, unknown>): Promise<ActionResult>
}

/** De quoi s'abonner et se fermer — juste assez pour tester sans `EventSource`. */
export interface StateStream {
  addEventListener(type: string, listener: (event: MessageEvent) => void): void
  onopen: ((event: Event) => void) | null
  onerror: ((event: Event) => void) | null
  onmessage: ((event: MessageEvent) => void) | null
  close(): void
}

/* ------------------------------------------------------------------ locale */

/**
 * La porte du poste de salle : SSE descendant, POST montant.
 *
 * Reprise telle quelle de ce que faisaient `stores/room.ts` et
 * `stores/actions.ts` : le déplacement ne change aucun comportement, il donne
 * seulement un second point de branchement.
 */
export function porteLocale(
  ouvrir: (url: string) => StateStream = (url) => new EventSource(url),
): PorteRegie {
  let stream: StateStream | null = null

  return {
    demarrer(flux) {
      if (stream != null) return
      stream = ouvrir('/display/state?vue=regie')

      stream.onopen = () => flux.onCoupure(false)
      stream.onerror = () => flux.onCoupure(true)

      // Message sans nom : l'instantané complet. Il part à l'ouverture et après
      // chaque reconnexion, ce qui répare la page sans logique de reprise.
      stream.onmessage = (event) => {
        flux.onCoupure(false)
        flux.onPayload(JSON.parse(event.data) as DisplayPayload, true)
      }

      // Delta : seulement les champs qui ont changé.
      stream.addEventListener('delta', (event) => {
        flux.onCoupure(false)
        flux.onPayload(JSON.parse(event.data) as Partial<DisplayPayload>, false)
      })
    },

    arreter() {
      stream?.close()
      stream = null
    },

    async act(geste) {
      try {
        const response = await fetch('/control/action', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(geste),
        })
        return (await response.json()) as ActionResult
      } catch {
        /*
         * La régie tourne en local : un échec ici ne veut pas dire « le hub est
         * loin », il veut dire que le cœur applicatif de la salle ne répond
         * plus. C'est la panne qui arrête tout, et elle doit se lire
         * immédiatement.
         */
        return { ok: false, message: 'Le service local ne répond pas' }
      }
    },
  }
}

/* ----------------------------------------------------------------- distante */

/** Cadence du sondage. C'est aussi le battement du verrou : un seul aller-retour. */
export const SONDAGE_MS = 1_000

/**
 * Au-delà, un geste dont dépend une étape suivante est déclaré manqué.
 *
 * Cinq secondes : le temps qu'une commande descende, qu'OBS obéisse et que la
 * salle le remonte, avec de la marge pour un réseau d'événement. Au-delà, dire
 * « fait » serait un mensonge, et c'est précisément le mensonge qui vide de sens
 * l'avertissement d'enregistrement de « Commencer ».
 */
export const OBSERVATION_MS = 5_000

export interface PorteDistanteOptions {
  client: HubClient
  /** La salle pilotée. */
  roomId: string
  /**
   * La vue entière, à chaque sondage.
   *
   * Le `DisplayPayload` synthétisé ne porte pas tout : le **verrou** n'a pas sa
   * place dans l'état d'une salle — `remoteHolder` dit à une salle qu'on la
   * pilote de loin, pas au téléphone qui la pilote. Or c'est justement le
   * champ qui doit réagir vite : quand un autre onglet reprend la salle, celui
   * qui la perd doit le voir à la seconde, pas au tour de liste suivant.
   */
  onVue?: (vue: ControlView) => void
  /** Injectables pour tester sans horloge ni minuteur réels. */
  maintenant?: () => number
  attendre?: (ms: number) => Promise<void>
}

/**
 * La porte du hub : sondage descendant, `regie.command` montant.
 *
 * Le sondage porte **aussi le battement du verrou** — `regie.view` renouvelle
 * la prise de son porteur. Un seul aller-retour par seconde dit à la fois « je
 * tiens toujours la salle » et « où en est-elle », et il n'y a pas de battement
 * séparé qu'on puisse oublier d'arrêter.
 */
export function porteDistante(options: PorteDistanteOptions): PorteRegie {
  const maintenant = options.maintenant ?? (() => Date.now())
  const attendre =
    options.attendre ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))

  let timer: ReturnType<typeof setInterval> | null = null
  let derniere: ControlView | null = null
  let enVol = false

  async function lire(flux: FluxEtat | null): Promise<ControlView | null> {
    /*
     * Un seul sondage en vol.
     *
     * Sur un réseau de téléphone, une réponse peut mettre plus d'une seconde :
     * sans ce garde, les appels s'empilent et les réponses arrivent dans le
     * désordre — un état d'il y a trois secondes viendrait alors écraser un
     * état frais.
     */
    if (enVol) return derniere
    enVol = true
    try {
      const vue = await options.client.rpc.regie.view({ roomId: options.roomId })
      derniere = vue
      options.onVue?.(vue)
      flux?.onCoupure(false)
      flux?.onPayload(payloadDepuisVue(vue, maintenant()), true)
      return vue
    } catch {
      /*
       * Une coupure, pas une erreur.
       *
       * Le téléphone perd le réseau en traversant un bâtiment ; le dire en
       * rouge à chaque hoquet rendrait l'avertissement illisible. C'est le
       * délai de grâce du store qui décide quand l'écran est « figé ».
       */
      flux?.onCoupure(true)
      return null
    } finally {
      enVol = false
    }
  }

  /**
   * Attend que la salle **ait fait** ce qu'on lui a demandé.
   *
   * `regie.command` répond quand le hub a mis la commande en file, et c'est
   * tout ce qu'il peut promettre : la salle est peut-être coupée, OBS peut
   * refuser. Les gestes dont dépend une étape suivante — l'enregistrement avant
   * « Commencer » — doivent donc se confirmer par l'**observation**, sinon la
   * règle « si l'enregistrement ne part pas, ne commence pas » disparaît sans
   * que rien ne le dise.
   */
  async function observer(
    predicat: (vue: ControlView) => boolean,
    echec: string,
  ): Promise<ActionResult> {
    const limite = maintenant() + OBSERVATION_MS
    for (;;) {
      await attendre(SONDAGE_MS)
      const vue = await lire(null)
      if (vue != null && predicat(vue)) return { ok: true }
      if (maintenant() >= limite) return { ok: false, message: echec }
    }
  }

  return {
    demarrer(flux) {
      if (timer != null) return
      void lire(flux)
      timer = setInterval(() => void lire(flux), SONDAGE_MS)
    },

    arreter() {
      if (timer != null) clearInterval(timer)
      timer = null
    },

    async act(geste) {
      /*
       * Un geste posé avant la première réponse doit connaître sa cible.
       *
       * Le cycle de vie voyage avec l'identifiant du créneau visé, que seule la
       * vue donne. Un bouton pressé dans la seconde qui suit l'ouverture — un
       * rechargement en plein talk, exactement le moment où l'on recharge —
       * partait sinon sans cible, et se faisait refuser comme un geste hors
       * périmètre. Un aller-retour de plus, et seulement là.
       */
      if (derniere == null) await lire(null)

      const traduite = traduire(geste, derniere)
      if (traduite == null) {
        /*
         * Hors périmètre, et dit en toutes lettres.
         *
         * Les marqueurs, la VOD et le ⚙ demandent la machine de la salle, que
         * le hub n'atteint pas. Laisser l'appel échouer sur un `BAD_REQUEST`
         * donnerait un rouge sans explication, là où la raison tient en une
         * phrase.
         */
        return { ok: false, message: "Ce geste demande la régie de la salle" }
      }

      try {
        await options.client.rpc.regie.command({ roomId: options.roomId, action: traduite })
      } catch (cause) {
        return { ok: false, message: (cause as Error).message || 'Geste refusé' }
      }

      if (traduite.type === 'recording.set') {
        const attendu = traduite.on
        return observer(
          (vue) => vue.recording === attendu,
          attendu
            ? "L'enregistrement n'a pas démarré : la salle n'a pas confirmé"
            : "L'enregistrement ne s'est pas arrêté : la salle n'a pas confirmé",
        )
      }

      /*
       * Les autres gestes ne bloquent rien derrière eux.
       *
       * Le cycle de vie s'écrit chez le hub : c'est acquis au retour. Une
       * bascule de scène se lit sur le bouton au sondage suivant, comme en
       * régie de salle — et personne n'enchaîne dessus.
       */
      return { ok: true }
    },
  }
}

/**
 * Le vocabulaire de la régie, traduit vers celui du hub.
 *
 * `null` pour tout ce qui n'a pas de sens à distance. La table est courte
 * exprès : elle est la définition du périmètre, et une entrée ajoutée ici sans
 * commande descendante en face serait un bouton qui échoue en salle.
 */
export function traduire(
  geste: Record<string, unknown>,
  vue: ControlView | null,
): ControlCommand | null {
  const action = geste.action
  switch (action) {
    case 'session.start':
    case 'session.end':
    case 'session.reset': {
      /*
       * La cible vient de la vue, et elle voyage explicitement.
       *
       * En salle, le poste résout lui-même la conférence à piloter. Ici c'est
       * le hub qui la calcule — même règle, `talkToControl` — mais elle
       * peut tourner entre le rendu et le clic. Renvoyer l'identifiant qu'on
       * avait sous les yeux est ce qui empêche de lancer le talk suivant.
       */
      const sessionId = vue?.targetSession?.id
      return sessionId == null ? null : { type: action, sessionId }
    }
    case 'scene.set':
      return { type: 'scene.set', role: geste.role as SceneRole }
    case 'display.set':
      return { type: 'display.set', mode: geste.mode as DisplayMode }
    case 'recording.start':
      return { type: 'recording.set', on: true }
    case 'recording.stop':
      return { type: 'recording.set', on: false }
    case 'stream.start':
      return { type: 'stream.set', on: true }
    case 'stream.stop':
      return { type: 'stream.set', on: false }
    default:
      return null
  }
}

/**
 * La vue du hub, rendue sous la forme que lisent les panneaux.
 *
 * C'est le cœur de la réutilisation : les composants reçoivent un
 * `DisplayPayload` et ne savent rien d'autre. Les champs qu'aucune source du
 * hub ne peut remplir sont **vides et non inventés** — la disposition mobile ne
 * monte pas les panneaux qui les liraient, et un `0` plausible à la place d'une
 * absence est exactement ce qui fait croire à une salle silencieuse.
 */
export function payloadDepuisVue(vue: ControlView, maintenantMs: number): DisplayPayload {
  /*
   * Une configuration réduite à ce dont dépendent les garde-fous.
   *
   * `conference.ts` lit `promptRecordingOnStart`, `promptRecordingOnStop` et
   * `sceneOnStart` pour décider s'il faut avertir avant « Commencer », proposer
   * d'arrêter la captation au « Terminer », et quelle scène prendre après. Les
   * remplir depuis la vue est ce qui fait que la question posée sur un
   * téléphone est exactement celle posée en salle.
   */
  const config: VisibleConfig = {
    obs: {
      A: { url: '', hasPassword: false, pending: false },
      B: { url: '', hasPassword: false, pending: false },
    },
    /*
     * Les rôles mappés, avec leur propre nom pour valeur.
     *
     * Le nom de scène OBS n'a rien à faire ici — personne ne le lit à distance,
     * et le hub ne le sert pas. Ce que le panneau de projection a besoin de
     * savoir est **quels rôles existent** : proposer « Relais » à une salle qui
     * n'en a pas donnerait un bouton dont personne ne sait ce qu'il montre, et
     * qui échouerait à la bascule.
     */
    sceneRoles: { A: Object.fromEntries(vue.sceneRoles.map((role) => [role, role])), B: {} },
    displayPort: 0,
    recordingRoot: null,
    fileSlug: null,
    relaySourceRoomId: vue.relaySourceRoomId,
    openFeedbackProjectId: null,
    promptRecordingOnStart: vue.promptRecordingOnStart,
    promptRecordingOnStop: vue.promptRecordingOnStop,
    sceneOnStart: vue.sceneOnStart,
    /*
     * Un téléphone n'ouvre pas le sélecteur de dossier d'une machine qu'il ne
     * voit pas — et le ⚙ n'est de toute façon pas monté à distance.
     */
    canBrowse: false,
  }

  return {
    state: {
      /*
       * L'écran que la salle a remonté, ou la boucle si elle ne l'a jamais dit.
       *
       * Ce repli n'invente rien : `loop` est l'état dans lequel une salle
       * démarre, celui qu'on trouve le matin sans que personne n'ait touché à
       * rien. Une salle qui n'a pas encore battu montre donc bien la boucle —
       * et si elle est coupée, la connectivité le dit déjà à côté.
       *
       * Il remonte avec jusqu'à dix secondes de retard sur une bascule décidée
       * en salle, et tout de suite sur une bascule demandée d'ici : la salle
       * bat dès qu'elle a appliqué la commande.
       */
      mode: vue.displayMode ?? 'loop',
      message: null,
      liveMessage: null,
      question: null,
      sceneRole: vue.sceneRole,
      connectivity: vue.connectivity,
      roomId: vue.roomId,
      contentHash: null,
      /*
       * `currentSession` reste nulle, et `targetSession` porte tout.
       *
       * Les panneaux montés à distance ne lisent que la cible ; remplir la
       * session courante demanderait au hub un second calcul dont personne ici
       * n'a l'usage.
       */
      currentSession: null,
      nextSession: null,
      outboxDepth: 0,
      /*
       * L'horloge du hub fait foi, et c'est elle qu'on installe.
       *
       * Le store ajoute cet écart à l'heure du navigateur pour tout ce qui
       * compte le temps. Sans lui, un téléphone mal réglé — ou un hub à horloge
       * simulée, où l'écart se compte en semaines — afficherait un compte à
       * rebours qui n'est celui de personne.
       */
      serverTimeOffsetMs: Date.parse(vue.serverTime) - maintenantMs,
      recording: vue.recording,
      streaming: vue.streaming,
      comments: [],
      sessionStates: vue.sessionStates,
      notifications: [],
      targetSession: vue.targetSession,
      breakBadge: null,
      targetIsUpcoming: vue.targetIsUpcoming,
      simulatedClock: vue.simulatedClock,
      /*
       * Nul, et c'est exact : ce champ dit à la **salle** qu'on la pilote de
       * loin. Sur le téléphone qui la pilote, il n'a personne à prévenir — le
       * bandeau de verrou dit déjà qui tient la salle.
       */
      remoteHolder: null,
    },
    roomName: vue.roomName,
    event: null,
    timezone: vue.timezone,
    sessions: vue.sessions,
    sponsorTiers: [],
    diagnostics: {
      obs: { A: null, B: null },
      questions: [],
      questionsRefreshedAt: null,
      questionsSession: null,
      config,
      mode: { room: 'production', hub: null },
      relaySourceRoomId: vue.relaySourceRoomId,
      rooms: [],
      roomsRefreshedAt: null,
      outboxDepth: 0,
      log: [],
      /*
       * Le hub ne stocke qu'un booléen : `startedAtMs` est donc nul, et le
       * chronomètre d'enregistrement n'est pas monté à distance. Lui donner une
       * heure de départ plausible ferait afficher une durée fausse à côté d'un
       * point rouge juste.
       *
       * Les repères de editing tombent avec, et pour la même raison : ils
       * vivent dans la prise, sur la machine de salle. Les boutons ne sont pas
       * montés à distance — `recording.mark` y est de toute façon refusé.
       */
      recording: {
        active: vue.recording,
        markers: 0,
        startedAtMs: null,
        startedAtCorrectedMs: null,
        editing: NO_EDITING_MARKS,
      },
    },
    wall: null,
    otherRooms: [],
    socialLinks: [],
    eventIdentity: vue.event,
    feedback: null,
    /*
     * Aucun appairage : c'est une affaire de machine de salle. Le voile ne se
     * lève que sur `null` ou `paired`, et `null` est la vérité ici.
     */
    pairing: null,
  }
}
