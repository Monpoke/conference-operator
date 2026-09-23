import type { Data, Scene } from '../scene.js'
import { cree, ecrire } from '../dom.js'
import { heureDans } from '../time.js'

/**
 * What is going on next door — the one thing an attendee in this room cannot
 * guess. The talk running in each other room, or the next one, on white cards.
 */
export function salles(el: HTMLElement): Scene {
  el.innerHTML = `
    <header class="bande">
      <h2 class="f-titre" data-effet="mots">Pendant ce temps, à côté</h2>
    </header>
    <div class="contenu salles" data-effet-enfants="entre" data-cible=".carte" data-pas="140" data-delai="250"></div>`
  const zone = el.querySelector<HTMLElement>('.salles')!
  const occupees = (data: Data) => data.otherRooms.filter((room) => room.session != null)
  return {
    el,
    cle: (data: Data) => [data.otherRooms, data.timezone],
    jouable: (data: Data) => occupees(data).length > 0,
    rendre(data: Data) {
      const rooms = occupees(data)
      zone.style.setProperty('--n', String(rooms.length > 2 ? 2 : Math.max(1, rooms.length)))
      zone.replaceChildren(...rooms.map((room) => {
        const session = room.session!
        const carte = cree('article', 'carte salle')
        const tete = cree('header', 'carte-tete')
        tete.append(
          cree('p', 'salle-nom', room.name),
          cree('p', room.running ? 'salle-heure maintenant' : 'salle-heure',
            room.running ? 'En ce moment' : heureDans(Date.parse(session.startsAt), data.timezone)),
        )
        carte.append(tete, cree('p', 'salle-titre', session.title))
        if (session.speakers.length) carte.append(cree('p', 'salle-qui', session.speakers.join(', ')))
        return carte
      }))
    },
  }
}

/**
 * The organiser's accounts, handle large — it is what one retypes on a phone
 * from the back of the room — and the hashtag in the band's orange.
 */
export function reseaux(el: HTMLElement): Scene {
  el.innerHTML = `
    <header class="bande">
      <h2 class="f-titre" data-titre data-effet="mots"></h2>
      <p class="bande-droite" data-hashtag data-effet="glisse" data-delai="350"></p>
    </header>
    <div class="contenu reseaux" data-effet-enfants="pop" data-cible=".carte" data-pas="120" data-delai="300"></div>`
  const titre = el.querySelector<HTMLElement>('[data-titre]')!
  const hashtag = el.querySelector<HTMLElement>('[data-hashtag]')!
  const zone = el.querySelector<HTMLElement>('.reseaux')!
  return {
    el,
    cle: (data: Data) => [data.socialLinks, data.eventIdentity.shortName, data.boucle?.barreBas.hashtag],
    jouable: (data: Data) => data.socialLinks.length > 0,
    rendre(data: Data) {
      ecrire(titre, `Suivez ${data.eventIdentity.shortName}`.trim())
      ecrire(hashtag, data.boucle?.barreBas.hashtag ?? '')
      zone.replaceChildren(...data.socialLinks.map((link) => {
        const carte = cree('article', 'carte reseau')
        carte.append(cree('p', 'reseau-nom', link.network), cree('p', 'reseau-compte', link.handle))
        return carte
      }))
    },
  }
}
