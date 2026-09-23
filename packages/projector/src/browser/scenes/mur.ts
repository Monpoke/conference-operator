import type { BoucleView } from '@conference-operator/contract'
import type { Data, Scene } from '../scene.js'
import { cree, ecrire, initiales, pluriel, teinte, texteRiche } from '../dom.js'
import { dateLisible, maintenant } from '../time.js'

type Post = BoucleView['mur']['posts'][number]

/**
 * The hand-fed social wall: posts written in the console, in three columns, a
 * different page on every pass. The offline fallback of walls.io.
 */
export function mur(el: HTMLElement): Scene {
  el.innerHTML = `
    <header class="bande">
      <h2 class="f-titre" data-titre data-effet="mots"></h2>
      <p class="bande-droite" data-hashtag data-effet="glisse" data-delai="350"></p>
    </header>
    <div class="contenu mur" data-effet-enfants="entre" data-cible=".carte" data-ordre="position" data-pas="110" data-delai="250">
      <div class="mur-col"></div>
      <div class="mur-col"></div>
      <div class="mur-col"></div>
    </div>`
  const titre = el.querySelector<HTMLElement>('[data-titre]')!
  const hashtag = el.querySelector<HTMLElement>('[data-hashtag]')!
  const cols = [...el.querySelectorAll<HTMLElement>('.mur-col')]
  let file: number[] | null = null
  let posts: Post[] = []
  let now = 0

  function carte(p: Post): HTMLElement {
    const auteur = p.auteur || ''
    const article = cree('article', 'carte')
    const tete = cree('header', 'carte-tete')
    const avatar = cree('div', 'avatar')
    if (p.photoUrl) {
      const img = new Image()
      img.src = p.photoUrl
      img.alt = ''
      avatar.append(img)
    } else {
      avatar.textContent = initiales(auteur || '?')
      avatar.style.setProperty('--c', teinte(auteur || '?'))
    }
    const qui = cree('div')
    qui.append(cree('p', 'carte-nom', auteur))
    if (p.titre) qui.append(cree('p', 'carte-titre', p.titre))
    tete.append(avatar, qui, cree('p', 'carte-date', dateLisible(p.date, now)))
    const texte = cree('p', 'carte-texte')
    texteRiche(texte, p.texte || '')
    article.append(tete, texte)
    if (p.imageUrl) {
      article.classList.add('avec-image')
      const img = new Image()
      img.src = p.imageUrl
      img.alt = ''
      img.className = 'carte-image'
      article.append(img)
    }
    const stats: string[] = []
    if (p.reactions) stats.push(pluriel(p.reactions, 'réaction'))
    if (p.commentaires) stats.push(pluriel(p.commentaires, 'commentaire'))
    const pied = cree('footer', 'carte-pied')
    pied.append(cree('span', null, stats.join(', ')), cree('span', null, p.reseau || 'LinkedIn'))
    article.append(pied)
    return article
  }

  /**
   * The rotation queue: the posts shown go to the back, those that found no room
   * come first on the next page.
   */
  function page(): void {
    cols.forEach((c) => c.replaceChildren())
    if (!posts.length) return
    if (!file || file.length !== posts.length) file = posts.map((_, i) => i)
    const bas = (c: HTMLElement) => {
      const d = c.lastElementChild as HTMLElement | null
      return d ? d.offsetTop + d.offsetHeight : 0
    }
    const places: number[] = []
    let echecs = 0
    for (const i of file) {
      if (echecs >= 4) break
      const col = cols.reduce((a, c) => (bas(c) < bas(a) ? c : a))
      const c = carte(posts[i]!)
      col.append(c)
      if (places.length && col.clientHeight > 0 && bas(col) > col.clientHeight) { c.remove(); echecs++; continue }
      places.push(i)
    }
    file = file.filter((i) => !places.includes(i)).concat(places)
  }

  return {
    el,
    cle: (data: Data) => data.boucle?.mur ?? null,
    jouable: (data: Data) => (data.boucle?.mur.posts.length ?? 0) > 0,
    rendre(data: Data) {
      ecrire(titre, data.boucle?.mur.titre || 'Ils en parlent')
      ecrire(hashtag, data.boucle?.mur.hashtag ?? '')
      posts = data.boucle?.mur.posts ?? []
      now = maintenant(data)
      file = null // new data: start again from the most recent posts
      page()
    },
    quitte(data: Data) {
      now = maintenant(data)
      page()
    },
  }
}
