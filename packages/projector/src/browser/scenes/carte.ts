import type { WallCard } from '@conference-operator/contract'
import { cree, initiales, teinte, texteRiche } from '../dom.js'
import { dateLisible } from '../time.js'

/**
 * A post of the social wall, as a card: who, when, what, the photo, where.
 *
 * The images are the room's (`/assets/…`) or absent — then the author's
 * initials on a tint, the card without its photo. A partner's post says so, with
 * its logo: a sponsor's message is not the audience's, and must not pass for it.
 */
export function carte(p: WallCard, now: number): HTMLElement {
  const auteur = p.author || '?'
  const article = cree('article', 'carte')
  if (p.featured) article.classList.add('en-avant')
  if (p.sponsor) article.classList.add('partenaire')

  const tete = cree('header', 'carte-tete')
  const avatar = cree('div', 'avatar')
  if (p.avatarUrl) {
    const img = new Image()
    img.src = p.avatarUrl
    img.alt = ''
    avatar.append(img)
  } else {
    avatar.textContent = initiales(auteur)
    avatar.style.setProperty('--c', teinte(auteur))
  }
  const qui = cree('div')
  qui.append(cree('p', 'carte-nom', auteur))
  if (p.authorSubtitle) qui.append(cree('p', 'carte-titre', p.authorSubtitle))
  tete.append(avatar, qui, cree('p', 'carte-date', dateLisible(p.postedAt, now)))
  article.append(tete)

  if (p.text) {
    const texte = cree('p', 'carte-texte')
    texteRiche(texte, p.text)
    article.append(texte)
  }
  if (p.imageUrl) {
    article.classList.add('avec-image')
    const img = new Image()
    img.src = p.imageUrl
    img.alt = ''
    img.className = 'carte-image'
    article.append(img)
  }

  const pied = cree('footer', 'carte-pied')
  if (p.sponsor) {
    const partenaire = cree('span', 'carte-sponsor')
    partenaire.append(cree('span', 'badge-partenaire', 'Partenaire'))
    if (p.sponsor.logoUrl) {
      const logo = new Image()
      logo.src = p.sponsor.logoUrl
      logo.alt = p.sponsor.name
      partenaire.append(logo)
    } else {
      partenaire.append(cree('span', null, p.sponsor.name))
    }
    pied.append(partenaire)
  } else {
    pied.append(cree('span'))
  }
  pied.append(cree('span', 'carte-reseau', p.network ?? ''))
  article.append(pied)
  return article
}
