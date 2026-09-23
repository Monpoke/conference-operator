import type { Data, Scene } from '../scene.js'
import { ecrire } from '../dom.js'

/** "Bienvenue à" and the event's logo, large. Comes in behind the stinger. */
export function accueil(el: HTMLElement): Scene {
  el.innerHTML = `
    <div class="accueil">
      <p class="accueil-bienvenue vague" data-effet="eclate"></p>
      <img class="accueil-logo flotte" alt="" data-effet="zoom" data-delai="550">
    </div>`
  const texte = el.querySelector<HTMLElement>('.accueil-bienvenue')!
  const logo = el.querySelector<HTMLImageElement>('.accueil-logo')!
  return {
    el,
    cle: (data: Data) => [data.boucle?.accueil.texte, data.boucle?.logoUrl ?? data.event?.logoUrl ?? null],
    jouable: () => true,
    rendre(data: Data) {
      ecrire(texte, data.boucle?.accueil.texte ?? 'Bienvenue à')
      const url = data.boucle?.logoUrl ?? data.event?.logoUrl ?? null
      if (url) {
        if (logo.getAttribute('src') !== url) logo.src = url
        logo.alt = data.eventIdentity.name
        logo.style.visibility = 'visible'
      } else {
        logo.style.visibility = 'hidden'
      }
    },
  }
}
