import type { HostLoad } from './hote.js'
import type { VodPolicy } from '@cloudnord/contract'

/**
 * Quand une salle a le droit de téléverser ses rushes.
 *
 * Le rapatriement est un confort d'après-événement ; la captation, elle, ne se
 * refait pas. Tout ce module tient dans cette hiérarchie : au moindre doute, on
 * ne téléverse pas. Un transfert qui lit le disque pendant qu'OBS-B y écrit, ou
 * qui sature l'uplink pendant un direct, serait un remède pire que le mal — et
 * la panne se découvrirait au editing, quand la salle est démontée.
 *
 * Le module est **pur** : il ne lit ni disque, ni horloge, ni réseau. C'est ce
 * qui permet de dérouler la journée entière dans un test, minute par minute,
 * sans monter une salle.
 */
import type { WaitReason, UploadVerdict } from '@cloudnord/contract'

export type { WaitReason, UploadVerdict }

export interface EntreesRegulateur {
  /** Le hub a un stockage prêt. Faux : il n'y a nulle part où envoyer. */
  stockagePret: boolean
  politique: VodPolicy
  /** Un humain a demandé ce téléversement — ici, ou depuis la console. */
  manuel: boolean
  /** OBS-B enregistre en ce moment. */
  enregistre: boolean
  /** Une conférence est pilotée par cette salle (démarrée, pas terminée). */
  conferenceEnCours: boolean
  /**
   * Millisecondes avant le début de la prochaine conférence de cette salle.
   *
   * `null` quand il n'y en a plus — fin de journée, ou salle jamais
   * synchronisée. Calculé par l'appelant sur le programme en cache et l'horloge
   * corrigée du hub, jamais sur celle du poste : en développement, l'écart se
   * compte en semaines.
   */
  msAvantProchaine: number | null
  charge: HostLoad
  /** Débit constaté sur la dernière part. `null` avant la première. */
  debitConstateOctetsS: number | null
}

/**
 * Sous ce débit, le réseau sert visiblement à autre chose.
 *
 * Deux cents kilo-octets par seconde : au-dessous, un rush de trois gigaoctets
 * demanderait plus de quatre heures, et l'on est de toute façon en train de
 * disputer la bande passante à quelque chose. Mieux vaut repasser plus tard.
 */
export const DEBIT_PLANCHER_OCTETS_S = 200 * 1024

/** Au-delà, la machine échange sur le disque — celui qui écrit le rush. */
const MEMOIRE_MAX = 0.9

const attente = (
  reason: WaitReason,
  text: string,
): UploadVerdict => ({ allowed: false, reason, debitMaxOctetsS: null, text })

const minutes = (ms: number): number => Math.max(0, Math.round(ms / 60_000))

/**
 * Le verdict, en six règles ordonnées.
 *
 * L'ordre porte le sens : la première qui refuse donne la reason affichée, et
 * c'est celle qu'on veut lire. Une salle qui enregistre *et* dont le poste est
 * chargé doit dire « enregistrement en cours », parce que c'est ce qui
 * s'expliquerait le moins bien autrement.
 *
 * **Une demande manuelle passe outre les trois dernières** — fenêtre, charge,
 * débit. Elles protègent un automatisme, et celui qui appuie sur le bouton n'en
 * est pas un : il a la salle sous les yeux et sait ce qu'il fait. Elle ne passe
 * jamais outre l'absence de stockage, qui n'est pas un mauvais moment mais une
 * absence de destination.
 *
 * Elle ne passe pas non plus outre l'enregistrement ni la conférence en cours,
 * et c'est délibéré : ce sont les deux seuls cas où continuer coûterait la
 * captation elle-même. La régie prévient avant d'envoyer la demande, pour que
 * le refus ne surprenne personne.
 */
export function verdictTeleversement(e: EntreesRegulateur): UploadVerdict {
  if (!e.stockagePret) {
    return attente('sans-stockage', 'aucun stockage configuré sur le hub')
  }
  if (!e.politique.actif && !e.manuel) {
    return attente('auto-desactive', 'téléversement automatique désactivé')
  }
  if (e.enregistre) {
    return attente('enregistrement', 'enregistrement en cours')
  }
  if (e.conferenceEnCours) {
    return attente('conference', 'conférence en cours')
  }

  const plafond = e.politique.debitMaxOctetsS
  if (e.manuel) {
    return { allowed: true, reason: null, debitMaxOctetsS: plafond, text: 'demandé' }
  }

  const marge = e.politique.margeConferenceMinutes * 60_000
  if (e.msAvantProchaine != null && e.msAvantProchaine <= marge) {
    return attente('fenetre', `conférence dans ${minutes(e.msAvantProchaine)} min`)
  }

  const { cpu, memory } = e.charge
  // `cpu` nul est un aveu, pas un zéro : on ne sait pas lire les compteurs, et
  // s'autoriser à charger la machine sur cette ignorance serait exactement le
  // mauvais pari — c'est l'encodeur qui paierait.
  if (cpu == null || cpu > e.politique.cpuMax) {
    const dit = cpu == null ? 'charge du poste illisible' : `poste à ${Math.round(cpu * 100)} %`
    return attente('charge', dit)
  }
  if (memory != null && memory.usedBytes / memory.totalBytes > MEMOIRE_MAX) {
    return attente('charge', 'mémoire du poste saturée')
  }

  if (e.debitConstateOctetsS != null && e.debitConstateOctetsS < DEBIT_PLANCHER_OCTETS_S) {
    return attente('debit', 'réseau trop lent, nouvelle tentative plus tard')
  }

  return { allowed: true, reason: null, debitMaxOctetsS: plafond, text: 'en cours' }
}

/**
 * Combien attendre avant de réessayer après un refus.
 *
 * Le débit est le seul motif qui **recule en exponentiel** : les autres se
 * lèvent d'eux-mêmes — une conférence finit, un poste se calme —, et repasser
 * dans quinze secondes ne coûte qu'une lecture de compteurs. Un réseau saturé,
 * lui, ne guérit pas parce qu'on redemande, et insister est précisément ce qui
 * le garde saturé.
 */
export function attenteApres(reason: WaitReason, echecs: number): number {
  if (reason !== 'debit') return 15_000
  return Math.min(15 * 60_000, 30_000 * 2 ** Math.min(echecs, 5))
}
