import type { RoomConferenceState } from './conference.js'

/**
 * Ce que peint chaque état, et le mot qui l'accompagne.
 *
 * Le mot n'est pas décoratif : la pastille se regarde de loin, et tout le monde
 * ne distingue pas les teintes.
 *
 * Cette table existait deux fois — une dans la régie, une dans la console du
 * hub — et les deux copies avaient déjà divergé : le même état `aucune` se
 * lisait « hors créneau » d'un côté et « rien au programme » de l'autre, pour
 * une salle qui était dans le même état. Deux personnes qui regardent deux
 * écrans doivent pouvoir se dire la même chose au téléphone.
 */
export interface Apparence {
  /** Suffixe de classe de la pastille. Vide pour l'état nominal, qui est le vert. */
  teinte: string
  /** Le mot affiché à côté. */
  mot: string
  /** Classe de couleur du texte qui accompagne la pastille. */
  texte: string
}

export const APPARENCE: Record<RoomConferenceState, Apparence> = {
  aucune: { teinte: 'hors', mot: 'hors créneau', texte: 'text-attenue' },
  // Un créneau commun n'est pas un état de la salle : il n'y a personne.
  // « pause » laissait croire à une conférence en suspens.
  pause: { teinte: 'hors', mot: 'rien dans la salle', texte: 'text-attenue' },
  'pas-commencee': { teinte: 'pas-commencee', mot: 'pas commencée', texte: 'text-attenue' },
  retard: { teinte: 'retard', mot: 'retard au démarrage', texte: 'text-attention' },
  'en-cours': { teinte: '', mot: 'en cours', texte: 'text-attenue' },
  'fin-proche': { teinte: 'fin-proche', mot: 'vers la fin', texte: 'text-attention' },
  terminee: { teinte: 'terminee', mot: 'terminée en avance', texte: 'text-attenue' },
  depassement: { teinte: 'depassement', mot: 'dépassement', texte: 'text-alerte' },
}

/**
 * Apparence d'un état, y compris d'un état qu'on ne connaît pas.
 *
 * Un hub d'une version plus récente peut nommer un état que cette page ignore.
 * Retomber sur `aucune` affiche une pastille neutre plutôt que de casser le
 * rendu de toute la liste des salles.
 */
export function apparenceDe(etat: string | null | undefined): Apparence {
  return APPARENCE[etat as RoomConferenceState] ?? APPARENCE.aucune
}

/**
 * États que seul le hub peut constater : ils tiennent au cycle de vie des
 * conférences, que la régie ne reçoit pas pour les autres salles.
 */
export const ETATS_DU_HUB: readonly RoomConferenceState[] = [
  'pas-commencee',
  'retard',
  'terminee',
  'depassement',
]

/** Fraîcheur au-delà de laquelle la vue du hub cesse de faire autorité. */
export const VUE_PERIMEE_MS = 60_000

/**
 * Qui a raison sur l'état d'une autre salle, du programme local ou du hub.
 *
 * Le partage n'est pas arbitraire. Le programme mis en cache est recalculé
 * chaque seconde, sur l'heure du hub : il est le plus juste pour tout ce qui se
 * déduit d'un horaire — en cours, vers la fin, pause. Reprendre là-dessus une
 * vue rafraîchie toutes les quelques secondes ferait manquer le passage à
 * « vers la fin », qui est précisément ce qu'on surveille.
 *
 * Le hub, lui, est seul à savoir qu'un créneau a commencé sans que personne ne
 * l'ait lancé, ou qu'une salle déborde. Sur ces états-là, il fait foi — tant
 * que sa vue est fraîche. Passé une minute, elle décrit un passé, et le
 * programme redevient la meilleure réponse : pendant une coupure, la salle
 * d'à côté finit quand même à l'heure prévue.
 */
export function etatFaisantFoi(
  local: RoomConferenceState,
  vueDuHub: string | null | undefined,
  vueFraiche: boolean,
): RoomConferenceState {
  if (!vueFraiche || vueDuHub == null) return local
  return ETATS_DU_HUB.includes(vueDuHub as RoomConferenceState)
    ? (vueDuHub as RoomConferenceState)
    : local
}
