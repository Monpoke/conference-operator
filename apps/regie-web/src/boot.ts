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
