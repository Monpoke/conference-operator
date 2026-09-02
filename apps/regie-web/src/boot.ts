import type { DisplayPayload } from '@cloudnord/contract'

/**
 * L'état de la salle, embarqué dans la coquille.
 *
 * Le poste de salle rend la page avec son état complet dedans, et c'est la
 * seule raison d'être de ce module. Un rechargement de la régie arrive presque
 * toujours au pire moment — la fenêtre a gelé, l'opérateur fait F5 pendant le
 * talk. Attendre le premier message du flux pour peindre quoi que ce soit
 * donnerait une demi-seconde d'écran vide à cet instant-là.
 *
 * Absent en développement, où `vite dev` sert `index.html` tel quel : la page
 * se remplit alors à l'ouverture du flux, ce qui est le comportement dégradé
 * qu'on accepte hors salle.
 */
export const BOOT_ELEMENT_ID = 'etat-initial'

export function readInitialPayload(document: Document): DisplayPayload | null {
  const element = document.getElementById(BOOT_ELEMENT_ID)
  const contenu = element?.textContent
  if (contenu == null || contenu.trim() === '') return null
  return JSON.parse(contenu) as DisplayPayload
}

/**
 * D'où la régie est servie, et pour quelle salle.
 *
 * Deux hôtes servent le même bundle : la machine de salle, qui n'a qu'une
 * salle et la connaît, et le hub, qui les a toutes et attend qu'on en choisisse
 * une. C'est la seule chose que l'application a besoin de savoir avant de se
 * monter — le reste suit du transport qu'elle choisit.
 *
 * **L'absence vaut « locale ».** C'est ce que sert un poste de salle, et aussi
 * ce que sert `vite dev` avec son `index.html` nu : le défaut est le cas où
 * personne n'a rien à dire.
 */
export const PORTEE_ELEMENT_ID = 'regie-portee'

export interface AmorcePortee {
  portee: 'locale' | 'distante'
  /** La salle pilotée, ou `null` pour l'écran de choix. */
  roomId: string | null
  /** Les salles connues, posées avant tout appel réseau. */
  salles: { id: string; name: string }[]
  /** Domaine Google, ou `null` : le bouton n'apparaît que si le hub le sert. */
  google: { domain: string } | null
}

const LOCALE: AmorcePortee = { portee: 'locale', roomId: null, salles: [], google: null }

export function readPortee(document: Document): AmorcePortee {
  const contenu = document.getElementById(PORTEE_ELEMENT_ID)?.textContent
  if (contenu == null || contenu.trim() === '') return LOCALE
  try {
    return { ...LOCALE, ...(JSON.parse(contenu) as Partial<AmorcePortee>) }
  } catch {
    /*
     * Une amorce illisible retombe en local, et ne casse rien.
     *
     * C'est le seul choix sûr : une page qui refuse de se monter parce qu'un
     * JSON est tronqué laisse un écran noir là où l'on attendait une régie.
     */
    return LOCALE
  }
}
