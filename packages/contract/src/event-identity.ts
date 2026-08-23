import { z } from 'zod'

/**
 * Identité de l'événement, telle que l'affichent toutes les surfaces.
 *
 * Une seule source pour le mur public, la console, l'écran de salle, les
 * titres de fenêtre et les notifications poussées. Sans elle, le nom de
 * l'événement était écrit en dur à une douzaine d'endroits : changer d'édition
 * — ou faire tourner le produit sur un autre événement — demandait de relire
 * tout le dépôt et de rejouer une release sur les machines de salle.
 *
 * Elle n'est pas saisie dans un fichier de configuration : le hub la **déduit
 * du programme importé**, qui porte déjà `event.name`. Le réglage n'existe que
 * pour les cas où l'export amont ne dit pas ce qu'on veut lire à l'écran.
 */
export const eventIdentitySchema = z.object({
  /**
   * Nom complet, millésime compris : « Cloud Nord 2026 ».
   *
   * C'est ce qu'on écrit en tête du mur public et de la console — les deux
   * endroits où quelqu'un peut arriver sans savoir où il est tombé.
   */
  name: z.string().min(1).max(80),
  /**
   * Nom court, sans millésime : « Cloud Nord ».
   *
   * Pour les endroits où la place manque et où l'année n'apprend rien : titre
   * de la fenêtre de régie, titre d'une notification poussée sur un téléphone,
   * boucle d'attente projetée (« Suivez … »). Déduit du nom complet à défaut
   * d'être réglé.
   */
  shortName: z.string().min(1).max(40),
})
export type EventIdentity = z.infer<typeof eventIdentitySchema>

/**
 * Ce qu'affichent les surfaces quand rien n'est connu : ni programme importé,
 * ni réglage.
 *
 * Ce cas existe réellement — un hub qui vient d'être installé, avant le premier
 * import — et il vaut mieux un mot neutre qu'un nom d'événement écrit en dur
 * qui serait faux partout ailleurs.
 */
export const IDENTITE_PAR_DEFAUT: EventIdentity = { name: 'Événement', shortName: 'Événement' }

/**
 * Retire d'un nom d'événement ce qui le date.
 *
 * « Cloud Nord 2026 » → « Cloud Nord », « DevFest Lille #12 » → « DevFest
 * Lille ». Heuristique assumée, et volontairement timide : elle ne coupe qu'un
 * suffixe reconnaissable en fin de chaîne, et rend le nom inchangé dès qu'elle
 * n'est sûre de rien. Un nom court faux se lirait sur chaque écran de la
 * journée ; un nom court trop long ne se remarque pas.
 *
 * Le réglage `eventShortName` du hub existe pour les noms qu'elle rate.
 */
export function nomCourtDeduit(nom: string): string {
  const coupe = nom.replace(/[\s]*[—–\-·|,]?[\s]*(?:(?:19|20)\d{2}|#\d+|éd(?:ition)?\.?\s*\d+)\s*$/iu, '').trim()
  // Un nom qui n'est *que* son millésime (« 2026 ») ne se raccourcit pas.
  return coupe === '' ? nom.trim() : coupe
}

/** Ce dont le hub dispose pour trancher, par ordre de priorité décroissante. */
export interface SourcesIdentite {
  /**
   * Réglages du hub. Ce qui est saisi là gagne : c'est le seul endroit où
   * quelqu'un a explicitement dit ce qu'il voulait lire.
   */
  reglage?: { name?: string | null; shortName?: string | null } | null
  /**
   * `program.event.name` du snapshot actif.
   *
   * La source normale, et celle qui rend le produit agnostique sans rien
   * demander : importer le programme d'un autre événement suffit à renommer
   * toutes les surfaces.
   */
  programme?: string | null
}

/**
 * Tranche l'identité affichée.
 *
 * Réglage explicite, sinon programme importé, sinon défaut neutre — et le nom
 * court se déduit du nom retenu, pas d'une autre source : régler le nom complet
 * sans penser au court doit donner un résultat cohérent.
 */
export function resoudreIdentiteEvenement(sources: SourcesIdentite = {}): EventIdentity {
  const propre = (valeur: string | null | undefined): string | null => {
    const texte = valeur?.trim() ?? ''
    return texte === '' ? null : texte
  }

  const name =
    propre(sources.reglage?.name) ?? propre(sources.programme) ?? IDENTITE_PAR_DEFAUT.name
  const shortName = propre(sources.reglage?.shortName) ?? nomCourtDeduit(name)

  // Les bornes du schéma s'appliquent aussi à ce qui vient de l'export amont,
  // qui n'a aucune raison de les respecter : un nom de 300 caractères ferait
  // échouer la validation du `sync` de toutes les salles.
  return eventIdentitySchema.parse({
    name: name.slice(0, 80),
    shortName: shortName.slice(0, 40),
  })
}
