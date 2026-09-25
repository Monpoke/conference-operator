import type { WallCard } from '@conference-operator/contract'
import type { Data, Scene } from '../scene.js'
import { ecrire } from '../dom.js'
import { maintenant } from '../time.js'
import { carte } from './carte.js'

/**
 * The social wall: what is said about the event — walls.io, the audience's
 * messages, the partners' posts — as a mosaic of cards.
 *
 * One featured post on each page, large, in the first column: put forward in the
 * console, pinned on walls.io, or a partner's; they take turns from one pass to
 * the next. The others fill two columns (three when nothing is featured), as
 * many as the page holds and at most `parPage` cards in all — the posts shown go
 * to the back of the line, those that found no room come first on the next page.
 *
 * Drawn off screen only, like every loop scene: a post arriving while the wall
 * is up waits for the next pass rather than moving a card in front of the room.
 */
export function wallsio(el: HTMLElement): Scene {
  el.innerHTML = `
    <header class="bande">
      <h2 class="f-titre" data-titre data-effet="mots"></h2>
      <p class="bande-droite" data-hashtag data-effet="glisse" data-delai="350"></p>
    </header>
    <div class="contenu mur" data-effet-enfants="entre" data-cible=".carte" data-ordre="position" data-pas="110" data-delai="250">
      <div class="mur-col mur-avant"></div>
      <div class="mur-col"></div>
      <div class="mur-col"></div>
    </div>
    <p class="vide" hidden>Aucun post sur le mur pour le moment.</p>`
  const titre = el.querySelector<HTMLElement>('[data-titre]')!
  const hashtag = el.querySelector<HTMLElement>('[data-hashtag]')!
  const mur = el.querySelector<HTMLElement>('.mur')!
  const avant = el.querySelector<HTMLElement>('.mur-avant')!
  const vide = el.querySelector<HTMLElement>('.vide')!
  const cols = [...el.querySelectorAll<HTMLElement>('.mur-col')]
  let posts: WallCard[] = []
  let parPage = 5
  let now = 0
  /** The regular posts' line, by id: shown ones go to the back. */
  let file: string[] = []
  /** Which featured post leads the next page. */
  let tour = 0
  /** When the page on screen was laid out: held by the operator, it turns on its own. */
  let poseA = 0

  function page(): void {
    poseA = now
    cols.forEach((c) => c.replaceChildren())
    const enAvant = posts.filter((p) => p.featured)
    const autres = posts.filter((p) => !p.featured)
    const tete = enAvant.length ? enAvant[tour % enAvant.length]! : null
    tour += 1
    mur.classList.toggle('sans-avant', tete == null)
    if (tete) avant.append(carte(tete, now))
    const colonnes = tete ? cols.slice(1) : cols

    // The line keeps its order across passes; new posts join at the front.
    const ids = new Set(autres.map((p) => p.id))
    const connus = new Set(file)
    file = [...autres.filter((p) => !connus.has(p.id)).map((p) => p.id), ...file.filter((id) => ids.has(id))]
    const parId = new Map(autres.map((p) => [p.id, p]))

    const bas = (c: HTMLElement) => {
      const d = c.lastElementChild as HTMLElement | null
      return d ? d.offsetTop + d.offsetHeight : 0
    }
    const places: string[] = []
    const max = Math.max(0, parPage - (tete ? 1 : 0))
    let echecs = 0
    for (const id of file) {
      if (places.length >= max || echecs >= 4) break
      const col = colonnes.reduce((a, c) => (bas(c) < bas(a) ? c : a))
      const c = carte(parId.get(id)!, now)
      col.append(c)
      if (places.length && col.clientHeight > 0 && bas(col) > col.clientHeight) { c.remove(); echecs++; continue }
      places.push(id)
    }
    file = file.filter((id) => !places.includes(id)).concat(places)
  }

  const scene: Scene = {
    el,
    cle: (data: Data) => [data.socialWall, data.boucle?.wallsio],
    jouable: (data: Data) => (data.socialWall?.length ?? 0) > 0,
    rendre(data: Data) {
      const c = data.boucle?.wallsio
      ecrire(titre, c?.titre ?? '')
      ecrire(hashtag, c?.hashtag ?? '')
      parPage = c?.parPage ?? 5
      posts = data.socialWall ?? []
      vide.hidden = posts.length > 0
      now = maintenant(data)
      page()
    },
    quitte(data: Data) {
      now = maintenant(data)
      page()
    },
    /**
     * Put up on its own by the operator, the wall never leaves the screen: it
     * asks to be redrawn once its page has had its time — the engine redraws a
     * held screen in place, a loop scene only once it is off screen.
     */
    tick(data: Data) {
      // In the loop, the next page is laid out as it leaves (`quitte`): turning
      // here too would use up posts nobody saw.
      if (data.state.mode !== 'wallsio') return
      const duree = (data.boucle?.durees.wallsio ?? 25) * 1000
      if (poseA > 0 && maintenant(data) - poseA >= duree) scene.sale = true
    },
  }
  return scene
}
