/**
 * Les valeurs viennent du sous-chemin `selectors`, pas de la racine du paquet.
 *
 * La racine réexporte les schémas zod du programme : le bundle navigateur les
 * embarquait alors *entiers*, six cents kilo-octets inlinés dans chaque page
 * pour trois fonctions d'horaire. Le sous-chemin n'expose que du calcul pur.
 */
import {
  effectiveEndMs,
  sessionsForRoom,
  timelinePosition,
  type SessionHoraire,
} from '@cloudnord/program/selectors'
import type { Program, Session } from '@cloudnord/program'
import type { StatutConference } from './cycle-de-vie.js'

/**
 * Ce qu'il faut d'un créneau pour dire où en est la salle.
 *
 * Plus étroit que `Session`, et c'est ce qui permet à l'automate de tourner des
 * deux côtés : le hub le nourrit de sessions entières, la régie de créneaux
 * relus de son cache, et personne n'a besoin de fabriquer un titre ni une liste
 * d'intervenants pour poser une question d'horaire.
 */
export type Creneau = SessionHoraire & Pick<Session, 'id' | 'kind'>

/**
 * Où en est une salle, en un mot. Voir `etatDesCreneaux`.
 *
 * La liste est une constante et pas seulement un type : le contrat oRPC en
 * dérive son `z.enum`, si bien qu'un état ajouté ici traverse le fil sans qu'on
 * ait à le réécrire ailleurs. Les deux listes existaient séparément, et rien
 * n'aurait signalé qu'elles ne disaient plus la même chose.
 */
export const ETATS_SALLE = [
  'aucune',
  'pause',
  'pas-commencee',
  'retard',
  'en-cours',
  'fin-proche',
  'terminee',
  'depassement',
] as const

export type RoomConferenceState = (typeof ETATS_SALLE)[number]

/** En deçà, une conférence est « vers la fin » : le moment où une décision se prend. */
export const FIN_PROCHE_MS = 5 * 60_000

/**
 * Au-delà, un créneau commencé que personne n'a lancé devient un retard.
 *
 * Les premières minutes ne disent rien : le public s'installe, l'intervenant
 * branche son PC. C'est après que l'absence de démarrage devient une question.
 */
export const RETARD_MS = 5 * 60_000

/**
 * En deçà, un break qui approche s'annonce.
 *
 * Un quart d'heure : c'est le moment où l'on cesse de lancer quoi que ce soit
 * et où l'on commence à préparer la reprise. Plus tôt, l'information ne sert
 * pas ; plus tard, elle arrive après la décision qu'elle devait éclairer.
 */
export const BREAK_PROCHE_MS = 15 * 60_000

/** Cycle de vie des conférences d'une salle, par identifiant. */
export type SessionStatuses = Record<string, StatutConference>

/** Fin effective du créneau d'indice `index` dans une suite déjà triée. */
export function finEffectiveA(creneaux: readonly SessionHoraire[], index: number): number | null {
  const creneau = creneaux[index]
  return creneau == null ? null : effectiveEndMs(creneau, creneaux[index + 1])
}

/**
 * État de la salle tel que les consoles le peignent.
 *
 * Croise deux sources qui disent des choses différentes :
 *
 * - **le programme** donne le créneau : ce qui *devrait* se jouer, à `nowMs` ;
 * - **le cycle de vie** (`Commencer` / `Terminer` en régie) donne ce qui se
 *   joue vraiment. Lui seul révèle un **dépassement** — le programme, passé
 *   l'heure de fin, passe simplement au créneau suivant — et lui seul distingue
 *   un talk en cours d'un créneau que personne n'a lancé.
 *
 * À défaut de cycle de vie, une salle apparaît « pas commencée » puis « en
 * retard » tout du long. C'est assumé : la console ne peut pas deviner qu'un
 * talk tourne si personne ne le dit, et le mot affiché à côté de la pastille
 * évite de lire cette absence comme une panne.
 */
export function etatDesCreneaux(
  creneaux: readonly Creneau[],
  nowMs: number,
  statuts: SessionStatuses = {},
): RoomConferenceState {
  /**
   * Le dépassement d'abord : c'est le seul état qui parle d'un créneau *passé*,
   * et le seul qui décale la suite de la journée.
   */
  const deborde = creneaux.some((creneau, index) => {
    if (statuts[creneau.id] !== 'running') return false
    /**
     * Un créneau qui n'est pas une conférence ne déborde pas.
     *
     * Il n'y a rien à y terminer — personne ne clôture un déjeuner —, et un
     * état « en cours » peut lui rester d'avant : le hub sert le programme
     * décisions comprises, et une conférence déjà lancée peut être déclarée
     * break en cours de journée. La signaler en dépassement ferait clignoter la
     * console sur un fait qu'on vient soi-même de corriger.
     */
    if (creneau.kind === 'break') return false
    const fin = finEffectiveA(creneaux, index)
    return fin != null && fin <= nowMs
  })
  if (deborde) return 'depassement'

  const { current } = timelinePosition(creneaux as Creneau[], nowMs)
  if (current == null) return 'aucune'
  if (current.kind === 'break') return 'pause'

  const statut = statuts[current.id] ?? 'scheduled'
  // Terminée avant l'heure : la salle est libre, et c'est une information pour
  // celle d'à côté — pas un créneau vide.
  if (statut === 'ended') return 'terminee'

  if (statut === 'running') {
    const fin = finEffectiveA(creneaux, creneaux.indexOf(current))
    return fin != null && fin - nowMs <= FIN_PROCHE_MS ? 'fin-proche' : 'en-cours'
  }
  return nowMs - current.startsAtMs > RETARD_MS ? 'retard' : 'pas-commencee'
}

/**
 * Ce que dit le programme seul, sans le cycle de vie.
 *
 * Quatre états sur huit. Les quatre autres — pas commencée, retard, terminée,
 * dépassement — tiennent à des décisions d'opérateur, et un client qui ne les
 * reçoit pas ne doit surtout pas les deviner : la régie ne reçoit le cycle de
 * vie que de sa propre salle. Pendant une coupure, annoncer la salle d'à côté
 * « en retard » parce qu'on n'a pas eu la nouvelle serait une fausse alerte, au
 * moment précis où plus personne ne peut la vérifier.
 *
 * On décrit donc le créneau, pas la salle — et le mot affiché à côté de la
 * pastille dit lequel des deux on regarde.
 */
export function etatDuProgramme(
  creneaux: readonly Creneau[],
  nowMs: number,
): RoomConferenceState {
  const { current } = timelinePosition(creneaux as Creneau[], nowMs)
  if (current == null) return 'aucune'
  if (current.kind === 'break') return 'pause'
  const fin = finEffectiveA(creneaux, creneaux.indexOf(current))
  return fin != null && fin - nowMs <= FIN_PROCHE_MS ? 'fin-proche' : 'en-cours'
}

export interface Pause<T> {
  /** `en-cours` : le break court. `a-venir` : il commence dans moins d'un quart d'heure. */
  state: 'en-cours' | 'a-venir'
  session: T
  /** Reprise : fin effective du break, ou `null` si rien ne le ferme. */
  endsAtMs: number | null
}

export type RoomBreak = Pause<Session>

/**
 * Le break d'une salle, en cours ou imminent.
 *
 * Une donnée à part de l'état de la salle, et non un état de plus : elle
 * cohabite avec ce que fait la salle. Une conférence peut courir pendant que le
 * déjeuner approche — c'est même le cas qui compte, celui où l'on décide de ne
 * pas laisser filer.
 *
 * `null` le reste du temps : l'étiquette n'apparaît que quand elle a quelque
 * chose à dire.
 */
export function pauseDesCreneaux<T extends Creneau>(
  creneaux: readonly T[],
  nowMs: number,
): Pause<T> | null {
  const reprise = (creneau: T): number | null => finEffectiveA(creneaux, creneaux.indexOf(creneau))

  const { current, next } = timelinePosition(creneaux as T[], nowMs)
  if (current?.kind === 'break') {
    return { state: 'en-cours', session: current, endsAtMs: reprise(current) }
  }
  /**
   * Le créneau suivant, qu'une conférence coure ou non.
   *
   * C'est là qu'est l'intérêt : savoir que le déjeuner tombe dans douze minutes
   * pendant qu'un talk se termine est ce qui fait décider de ne pas enchaîner.
   * Ne regarder que les salles déjà vides aurait donné l'information à ceux qui
   * n'en avaient plus besoin.
   */
  if (next?.kind === 'break' && next.startsAtMs - nowMs <= BREAK_PROCHE_MS) {
    return { state: 'a-venir', session: next, endsAtMs: reprise(next) }
  }
  return null
}

/**
 * La prochaine conférence de la salle : celle qui va encore se tenir.
 *
 * Deux filtres, et le second est celui qui manquait.
 *
 * Les **pauses** d'abord : un déjeuner n'est pas ce qu'on attend, et compter
 * jusqu'à lui donnerait un chiffre juste et sans usage quand ce qui se prépare
 * est le talk d'après.
 *
 * Les conférences **déjà terminées** ensuite. La régie autorise « Commencer »
 * — puis « Terminer » — sur une conférence dont le créneau n'a pas encore
 * commencé ; celle-ci restait alors « après maintenant », et la salle se
 * désignait elle-même comme sa propre suivante : le grand compte à rebours
 * décomptait jusqu'au début d'un talk qui venait d'être clos, et la ligne de
 * détail annonçait « prochaine conférence à 09:50 » sur la conférence de 09:50
 * qu'on venait de terminer. Une conférence terminée ne va plus se tenir.
 */
export function prochaineConference<T extends Creneau>(
  creneaux: readonly T[],
  nowMs: number,
  statuts: SessionStatuses = {},
): T | null {
  return (
    creneaux.find(
      (creneau) =>
        creneau.kind === 'talk' &&
        creneau.startsAtMs > nowMs &&
        statuts[creneau.id] !== 'ended',
    ) ?? null
  )
}

/**
 * La conférence que la régie pilote : celle sur laquelle « Commencer » et
 * « Terminer » agissent.
 *
 * Trois règles, dans cet ordre, et c'est l'ordre qui porte le sens.
 *
 * Le créneau **en cours**, quand c'en est une, d'abord : c'est ce que la salle
 * est en train de vivre, et il prime même si un talk plus ancien est resté
 * ouvert faute d'un « Terminer ». Sans cette priorité, oublier de clore le talk
 * de 09:00 rendrait tous les suivants impilotables.
 *
 * Une conférence **encore en cours** ensuite, même si son créneau est passé.
 * C'est le dépassement, et c'est précisément le moment où « Terminer » est le
 * bouton qu'on cherche : un talk lancé à 09:00 pour 09:45 qui parle encore à
 * 09:46 sortait de la cible à la seconde où son créneau se fermait — la régie
 * basculait sur le compte à rebours du talk de 09:50 et le seul geste capable
 * d'arrêter celui qui était à l'antenne disparaissait de l'écran. Elle vaut
 * aussi pendant une pause : un talk qui déborde sur le déjeuner reste à
 * l'antenne, donc reste pilotable.
 *
 * La **prochaine à se tenir** enfin, pour le cas ordinaire : entre deux talks,
 * pendant une pause, avant l'ouverture, ce qu'on prépare est celui qui arrive.
 *
 * @param statuts Cycle de vie tel qu'il s'applique à `nowMs` — c'est lui qui
 * distingue un talk à l'antenne d'un créneau que personne n'a lancé.
 */
export function conferenceAPiloter<T extends Creneau>(
  creneaux: readonly T[],
  nowMs: number,
  statuts: SessionStatuses = {},
): T | null {
  const { current } = timelinePosition(creneaux as T[], nowMs)
  if (current?.kind === 'talk') return current

  /**
   * Une **conférence**, comme partout ailleurs ici.
   *
   * Une pause et un créneau creux ne se pilotent pas : il n'y a rien à
   * commencer ni à terminer dans une salle qui déjeune. Un créneau que l'export
   * donne pour une pause et qui doit se piloter — une keynote sans intervenant,
   * par exemple — se déclare conférence depuis la console, et c'est cette
   * décision-là qui le rend pilotable, pas le fait de l'avoir lancé.
   *
   * Le **dernier** lancé, et pas le premier trouvé : deux conférences peuvent
   * porter `running` en même temps — l'une oubliée ouverte le matin, l'autre
   * lancée depuis. Celle qui est à l'antenne est la plus tardive au programme.
   */
  for (let index = creneaux.length - 1; index >= 0; index -= 1) {
    const creneau = creneaux[index]!
    if (creneau.kind === 'talk' && statuts[creneau.id] === 'running') return creneau
  }

  return prochaineConference(creneaux, nowMs, statuts)
}

/**
 * La règle horaire : quand un créneau dépassé se ferme tout seul.
 *
 * Elle existe parce que personne ne pense à appuyer sur « Terminer » quand un
 * talk déborde et que la salle applaudit. Le délai de grâce est réglable : cinq
 * minutes conviennent à un format de 50 minutes, beaucoup moins à un quickie
 * de 20.
 */
export interface ReglageCloture {
  actif: boolean
  graceMinutes: number
}

export const CLOTURE_PAR_DEFAUT: ReglageCloture = { actif: true, graceMinutes: 5 }

/**
 * Cette conférence doit-elle être close par la règle horaire ?
 *
 * `fin` est la **fin effective** du créneau — heure explicite, sinon durée,
 * sinon début du créneau suivant. C'est exactement la fin sur laquelle repose
 * le dépassement, et c'est le point : les deux règles parlaient d'horaires
 * différents, si bien qu'un créneau dont l'export ne donne que l'heure de début
 * passait en dépassement sans que le balayage ne le voie jamais. La salle
 * restait en rouge pour le reste de la journée, et rien ne pouvait l'en sortir
 * qu'un opérateur.
 *
 * Deux refus subsistent, chacun pour sa raison.
 *
 * - **Pas en cours** : une conférence jamais démarrée reste « à venir ».
 *   Affirmer qu'un talk s'est tenu alors que personne ne l'a lancé serait un
 *   mensonge dans l'historique, et fausserait la VOD.
 * - **Fin inconnue** (`null`) : créneau absent du programme après un réimport,
 *   ou dernier créneau d'une journée qu'aucune des trois règles ne ferme. Sans
 *   heure de référence, on ne décide rien — et une salle qui reste en
 *   dépassement là-dessus le dit à raison : personne ne sait quand ça finit.
 */
export function doitEtreClose(
  fin: number | null,
  statut: StatutConference,
  nowMs: number,
  reglage: ReglageCloture = CLOTURE_PAR_DEFAUT,
): boolean {
  if (!reglage.actif) return false
  if (statut !== 'running') return false
  if (fin == null) return false
  return fin <= nowMs - reglage.graceMinutes * 60_000
}

/**
 * Les créneaux d'une salle que la règle horaire doit clore à cet instant.
 *
 * L'entrée par liste, comme le reste : la fin effective d'un créneau dépend de
 * celui qui le suit, et c'est précisément ce que la version par créneau isolé
 * ne pouvait pas voir.
 */
export function aClore<T extends Creneau>(
  creneaux: readonly T[],
  nowMs: number,
  statuts: SessionStatuses = {},
  reglage: ReglageCloture = CLOTURE_PAR_DEFAUT,
): T[] {
  return creneaux.filter((creneau, index) =>
    doitEtreClose(finEffectiveA(creneaux, index), statuts[creneau.id] ?? 'scheduled', nowMs, reglage),
  )
}

/**
 * Fin effective d'un créneau, resitué dans le programme de sa salle.
 *
 * Ce que le hub a besoin de savoir pour appliquer la règle horaire : il part
 * d'une décision stockée, pas d'une liste de créneaux, et doit retrouver le
 * voisin qui ferme celui-ci. Rend `null` pour un créneau que le programme
 * courant ne contient plus.
 */
export function finEffectiveDansProgramme(program: Program, sessionId: string): number | null {
  const session = program.sessions.find((creneau) => creneau.id === sessionId)
  if (session?.roomId == null) return null
  const creneaux = sessionsForRoom(program, session.roomId)
  return finEffectiveA(creneaux, creneaux.indexOf(session))
}

/** Où en est une salle du programme. Enveloppe de `etatDesCreneaux`. */
export function roomConferenceState(
  program: Program,
  roomId: string,
  nowMs: number,
  statuses: SessionStatuses = {},
): RoomConferenceState {
  return etatDesCreneaux(sessionsForRoom(program, roomId), nowMs, statuses)
}

/** Le break d'une salle du programme. Enveloppe de `pauseDesCreneaux`. */
export function roomBreak(program: Program, roomId: string, nowMs: number): RoomBreak | null {
  return pauseDesCreneaux(sessionsForRoom(program, roomId), nowMs)
}
