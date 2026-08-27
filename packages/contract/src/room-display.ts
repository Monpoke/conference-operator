import type { Program, Session, SponsorTier } from '@cloudnord/program'
import type { EventIdentity } from './event-identity.js'
import type {
  Connectivity,
  DisplayMode,
  ModeExecution,
  ObsInstance,
  SceneRole,
} from './primitives.js'
import type { SceneRoleMap, SessionStatus } from './room-state.js'
import type { Comment } from './wall.js'

/**
 * Ce qu'une salle dit d'elle-même, et ce que ses pages en lisent.
 *
 * Ces types vivaient dans le client de salle, chez le processus qui les
 * produit. Ils en sortent parce qu'ils ont maintenant **deux** lecteurs : le
 * processus lui-même, et la régie, devenue un paquet à part avec sa propre
 * compilation. Un type recopié entre les deux dériverait — c'est déjà arrivé
 * une fois, entre la régie et la console, sur les seuils d'un même état.
 *
 * Rien n'est ajouté ni renommé au passage : les définitions sont celles de
 * `runtime.ts`, `obs.ts`, `control-api.ts` et `display-server.ts`, déplacées
 * telles quelles. Ces quatre fichiers les réexportent, pour qu'aucun appelant
 * n'ait à changer d'import.
 *
 * Ce sont des interfaces et non des schémas Zod, délibérément : rien ne les
 * valide au passage. Elles décrivent un flux **local** — le processus de la
 * salle vers les pages qu'il sert lui-même sur sa boucle locale — pas une
 * frontière réseau franchie par autrui.
 */

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
  /**
   * Break de la salle, en cours ou imminent — ou `null`.
   *
   * À part de la session en cours : les deux cohabitent, et « BREAK à venir »
   * s'affiche pendant qu'une conférence court encore.
   */
  breakBadge: { state: 'en-cours' | 'a-venir'; title: string; startsAt: string } | null
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

export interface ObsState {
  instance: ObsInstance
  connected: boolean
  /** Scène courante telle qu'annoncée par OBS, jamais supposée par nous. */
  currentSceneName: string | null
  currentRole: SceneRole | null
  /** Rôles configurés mais absents d'OBS : à afficher en rouge dans la régie. */
  unresolvedRoles: SceneRole[]
  /**
   * L'instance est simulée.
   *
   * À signaler partout où l'on croit piloter OBS : un enregistrement simulé
   * ressemble en tout point à un vrai, sauf qu'il ne capte rien.
   */
  simulated: boolean
  /**
   * Scènes réellement déclarées dans cette instance.
   *
   * Sert au formulaire de configuration de la régie : choisir un nom de scène
   * dans une liste lue sur OBS vaut mieux que le retaper, puisque c'est
   * justement la faute de frappe qui produit un rôle introuvable.
   */
  scenes: string[]
  recording: boolean
  streaming: boolean
}

/**
 * Configuration de la salle telle que la régie la voit.
 *
 * Les mots de passe OBS n'en font pas partie : seulement le fait qu'il y en a
 * un. Le formulaire n'a pas besoin de les relire pour les garder — un champ
 * laissé vide vaut « inchangé » — et une page servie en HTTP n'est pas
 * l'endroit où faire réapparaître un secret déjà enregistré.
 */
export interface ConfigVisible {
  obs: { A: PointObsVisible; B: PointObsVisible }
  sceneRoles: SceneRoleMap
  displayPort: number
  recordingRoot: string | null
  fileSlug: string | null
  relaySourceRoomId: string | null
  /** Projet OpenFeedback, pour le QR « Notez le talk ». */
  openFeedbackProjectId: string | null
  /** Avertir au « Commencer » si rien n'enregistre. */
  promptRecordingOnStart: boolean
  /** Scène prise automatiquement au « Commencer ». `null` = aucune bascule. */
  sceneOnStart: string | null
}

export interface PointObsVisible {
  url: string
  hasPassword: boolean
  /**
   * La connexion en cours n'a pas été ouverte avec ces réglages-là.
   *
   * Enregistrer ne reconnecte pas : c'est à l'opérateur de choisir quand
   * couper une instance. Encore faut-il qu'il voie qu'il reste à le faire.
   */
  pending: boolean
}

export interface ControlDiagnostics {
  obs: { A: ObsState | null; B: ObsState | null }
  /**
   * Questions posées dans cette salle, les plus votées d'abord.
   *
   * Relues à la demande plutôt que poussées : la régie ne les regarde qu'en
   * fin de talk, et les faire circuler en continu chargerait le flux d'état
   * pour rien.
   */
  questions: { id: string; text: string; author: string | null; votes: number }[]
  /** Instant de la dernière relecture, pour dire une liste datée. */
  questionsRefreshedAt: string | null
  /**
   * Conférence à laquelle se rapportent les questions listées.
   *
   * Affiché en régie : une liste vide ne dit pas la même chose selon qu'aucune
   * question n'a été posée sur ce talk, ou qu'aucun talk n'est piloté. `null`
   * dans le second cas.
   */
  questionsSession: { id: string; title: string } | null
  /** Réglages de la salle, pour le panneau de configuration. `null` avant le premier sync. */
  config: ConfigVisible | null
  /**
   * Modes d'exécution, celui de la salle et celui du hub.
   *
   * `hub` reste `null` tant qu'aucune synchronisation n'a abouti. Les deux sont
   * affichés ensemble parce que c'est leur **désaccord** qui compte : une salle
   * de développement branchée sur le hub de l'événement enverrait de vraies
   * commandes depuis un poste qui simule tout.
   */
  mode: { salle: ModeExecution; hub: ModeExecution | null }
  /** Salle relayée, `null` si le relais n'est pas configuré pour cette salle. */
  relaySourceRoomId: string | null
  /**
   * État des autres salles, tel que le hub le connaît.
   *
   * Rafraîchi périodiquement et **mis en cache** : l'opérateur doit pouvoir
   * jeter un œil aux autres salles sans que chaque rendu d'écran déclenche un
   * appel réseau.
   */
  rooms: {
    roomId: string
    name: string
    connectivity: string
    sceneRole: string | null
    recording: boolean
    outboxDepth: number
    lastSeenAt: string | null
    /**
     * Conférence que la salle pilote réellement, `null` si elle n'en pilote
     * aucune.
     *
     * Distinct de ce que dit le programme : c'est la seule façon de savoir
     * qu'une salle **déborde** — son créneau est fini, elle tourne encore. Le
     * programme seul ne le dira jamais, il passe simplement au suivant.
     */
    currentSessionId: string | null
    /**
     * Où en est la salle, calculé par le hub.
     *
     * Lui seul croise le programme, son horloge — qui peut être simulée — et le
     * cycle de vie des conférences des autres salles. La régie s'en sert tant
     * que cette vue est fraîche, et retombe sur son propre cache dès qu'elle
     * date : pendant une coupure, la salle d'à côté finit quand même à l'heure
     * prévue.
     */
    conference: string
  }[]
  /** Instant du dernier rafraîchissement des salles, pour signaler une vue périmée. */
  roomsRefreshedAt: string | null
  outboxDepth: number
  journal: { level: string; message: string; createdAt: string }[]
  /** Enregistrement en cours côté client, et nombre de marqueurs posés. */
  recording: {
    active: boolean
    markers: number
    startedAtMs: number | null
    /**
     * Départ sur l'horloge corrigée, ou `null` si le temps réel fait foi.
     *
     * Porte la valeur **et** la règle : la régie compte sur l'horloge du hub
     * quand ce champ est renseigné — le cas du développement, où l'on déroule
     * une journée en poussant l'horloge — et en temps réel sinon.
     */
    startedAtCorrigeMs: number | null
  }
}

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
   * Nom de l'événement, tranché par le hub et relu du cache local.
   *
   * Distinct de `event.name` du programme : le hub peut le contredire par
   * réglage, et surtout il est connu **sans** programme — une machine tout
   * juste appairée doit déjà titrer ses fenêtres correctement.
   */
  eventIdentity: { name: string; shortName: string }
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

/**
 * Niveau d'une entrée audio, en dBFS.
 *
 * OBS envoie des multiplicateurs linéaires ; on convertit ici parce que c'est
 * l'échelle sur laquelle un ingénieur du son raisonne, et celle qu'affiche OBS
 * lui-même. `-60` sert de plancher : en dessous, c'est du silence, et un
 * `-Infinity` casserait tout calcul de largeur de barre côté page.
 */
export interface NiveauEntree {
  nom: string
  /** Un élément par canal : mono en a un, stéréo deux. */
  canaux: { magnitude: number; crete: number }[]
}

/** Plancher d'affichage, en dBFS. */
export const PLANCHER_DB = -60

/**
 * Charge du poste de régie, relevée hors du flux d'état.
 *
 * Servie à part sur `/control/host` : la mesure est une moyenne sur sa propre
 * fenêtre, et une salle dont la régie est fermée ne doit émettre aucun trafic.
 */
export interface ChargeHote {
  /**
   * Part occupée du processeur sur la fenêtre observée, entre 0 et 1.
   *
   * `null` tant qu'aucune fenêtre n'a pu être mesurée — au démarrage, ou sur
   * une machine dont Node ne sait pas lire les compteurs. C'est un aveu, pas un
   * zéro : afficher « 0 % » d'un processeur qu'on n'a pas su lire ferait
   * exactement le contraire de ce qu'on cherche.
   */
  cpu: number | null
  coeurs: number
  /** Durée réellement couverte par la mesure, en ms — l'info-bulle la cite. */
  fenetreMs: number
  /**
   * Mémoire vive occupée et totale, en octets. `null` si illisible.
   *
   * L'autre façon dont un poste lâche, et la plus sournoise : la machine ne
   * ralentit pas franchement, elle commence à échanger sur le disque — celui-là
   * même qui écrit le rush.
   */
  memoire: { occupeeOctets: number; totalOctets: number } | null
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
    // Le nom de l'événement : deux mots qui ne bougent qu'au sync, et sans
    // lesquels chaque page se retitrerait avec une constante compilée.
    'eventIdentity',
  ],
  overlay: ['state', 'event', 'eventIdentity'],
  // Le bandeau ne lit que `state.liveMessage` : lui pousser le programme et
  // les sponsors coûterait trente kilo-octets par changement d'écran.
  bandeau: ['state', 'eventIdentity'],
  regie: [
    'state', 'roomName', 'timezone', 'sessions', 'diagnostics', 'pairing', 'eventIdentity',
    // L'adresse du mur, pour le menu des écrans. Le QR voyage avec, ce qui est
    // du gaspillage — mais il ne change qu'au sync, et scinder le champ en deux
    // coûterait plus cher à lire qu'il ne fait économiser.
    'wall',
  ],
}

/*
 * Les rushes tels que la régie les voit.
 *
 * Même raison que le reste de ce fichier : ces types décrivent ce que le poste
 * répond sur `/control/recordings` et `/control/uploads`, et ils ont désormais
 * deux lecteurs — le poste qui les produit, et le bundle de la régie qui les
 * lit. Déplacés tels quels ; les fichiers d'origine les réexportent.
 */

export interface Marker {
  label: string
  /** Décalage depuis le début de l'enregistrement — ce qui sert au montage. */
  offsetMs: number
  at: string
}

/** Métadonnées écrites à côté du master, pour le montage et l'upload. */
export interface Sidecar {
  sessionId: string | null
  title: string
  speakers: { name: string; company: string | null }[]
  roomId: string | null
  trackTitle: string | null
  category: string | null
  startedAt: string
  endedAt: string
  durationMs: number
  markers: Marker[]
  /** Nom final du fichier vidéo, une fois renommé. */
  videoFile: string | null
}


/**
 * Ce que la régie sait dire d'un fichier produit dans la journée.
 *
 * `illisible` est un constat technique — le conteneur ne s'ouvre pas, la piste
 * vidéo manque, le fichier est vide ; `suspect` veut dire « regardez-le
 * vous-même » : il s'ouvre, mais quelque chose ne colle pas avec ce que la
 * régie croyait enregistrer. Les deux méritent d'être vus avant de démonter
 * la salle, pas la veille du montage.
 */
export type VerdictVod = 'ok' | 'suspect' | 'illisible'

/** Ce que ffprobe a lu du fichier. Absent quand l'outil n'est pas installé. */
export interface SondageVod {
  /**
   * ffprobe a reconnu le conteneur.
   *
   * Faux, tout le reste est nul — et il faut le dire ainsi : « aucune piste
   * vidéo » laisse croire à un fichier valide amputé de son image, alors que
   * c'est le conteneur entier qui ne s'ouvre pas. Les deux ne se réparent pas
   * de la même façon.
   */
  ouvert: boolean
  durationMs: number | null
  video: { codec: string; width: number; height: number; fps: number | null } | null
  audio: { codec: string; channels: number } | null
  bitrateKbps: number | null
}

export interface ControleVod {
  status: VerdictVod
  /** Instant du contrôle : un verdict d'il y a trois heures ne vaut plus rien. */
  at: string
  /** `auto` = la vérification technique ; `operateur` = quelqu'un a ouvert le fichier. */
  by: 'auto' | 'operateur'
  /** Ce qui a motivé le verdict, en clair : un badge rouge sans raison ne sert personne. */
  reasons: string[]
  probe: SondageVod | null
}

export interface EntreeVod {
  /** Chemin relatif à la racine, séparateurs normalisés — c'est aussi la clé. */
  file: string
  sizeBytes: number
  modifiedAtMs: number
  /**
   * Le fichier a bougé il y a quelques secondes : la prise est probablement
   * encore en cours. Le contrôler maintenant dirait « tronqué » d'un
   * enregistrement qui se porte très bien.
   */
  enEcriture: boolean
  sidecar: Sidecar | null
  check: ControleVod | null
}


/**
 * Pourquoi rien ne part.
 *
 * Rendu jusqu'à l'écran de régie, et c'est sa raison d'être : une attente sans
 * motif se lit comme une panne, et le bouton qu'on vient de presser passe pour
 * mort. « en attente — conférence dans 6 min » ne demande aucune explication.
 */
export type RaisonAttente =
  | 'desactive'
  | 'enregistrement'
  | 'conference'
  | 'fenetre'
  | 'charge'
  | 'debit'

export interface VerdictTeleversement {
  autorise: boolean
  /** `null` quand c'est autorisé : il n'y a alors rien à expliquer. */
  raison: RaisonAttente | null
  /** Plafond à appliquer, en octets par seconde. `null` = pas de plafond. */
  debitMaxOctetsS: number | null
  /** Ce que la régie affiche, en clair. */
  texte: string
}


/** Ce que la régie affiche pour un fichier. */
export interface EtatTeleversementVu {
  file: string
  state: string
  pourcent: number
  debitOctetsS: number | null
  erreur: string | null
  manuel: boolean
}

export interface VueTeleversements {
  entrees: EtatTeleversementVu[]
  verdict: VerdictTeleversement
}

/**
 * Ce que la modale des enregistrements reçoit.
 *
 * `root` est repris tel quel — nul, la liste est vide et la page doit dire
 * pourquoi plutôt que d'afficher « aucun enregistrement », qui se lirait comme
 * une journée perdue.
 */
export interface VodListe {
  root: string | null
  entries: EntreeVod[]
  /**
   * Outils externes réellement présents sur la machine.
   *
   * La page s'en sert pour ne pas proposer un lecteur qui ne démarrera jamais :
   * ni ffmpeg ni ffprobe ne sont des dépendances du poste.
   */
  outils: { ffmpeg: boolean; ffprobe: boolean }
}
