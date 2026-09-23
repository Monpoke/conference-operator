import type { Data, Scene } from '../scene.js'
import { ecrire } from '../dom.js'
import { DECOUPES } from '../effects.js'

type Cle = 'bienvenue' | 'partage' | 'silence'

/**
 * A short sentence in animated type. Word effects carry the violet outline,
 * letter effects come in white, run through by a wave of colours.
 */
export function message(el: HTMLElement, cle: Cle): Scene {
  el.innerHTML = `
    <div class="message">
      <p class="message-texte f-titre vague" data-texte-message></p>
      <p class="message-sous" data-sous data-effet="machine" data-delai="900"></p>
    </div>`
  const texte = el.querySelector<HTMLElement>('[data-texte-message]')!
  const sous = el.querySelector<HTMLElement>('[data-sous]')!
  const donnees = (data: Data) => data.boucle?.messages[cle] ?? null
  return {
    el,
    cle: donnees,
    jouable: (data: Data) => Boolean(donnees(data)?.texte),
    rendre(data: Data) {
      const m = donnees(data)
      const effet = m?.effet ?? 'claque'
      // The violet outline only goes with the word effects.
      const parLettres = DECOUPES[effet]?.mode === 'lettres'
      texte.classList.toggle('contour', !parLettres)
      texte.classList.toggle('arcenciel', parLettres)
      texte.dataset.effet = effet
      ecrire(texte, m?.texte ?? '')
      ecrire(sous, m?.sousTitre ?? '')
    },
  }
}
