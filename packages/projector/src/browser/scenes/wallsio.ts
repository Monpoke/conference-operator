import type { WallCard } from '@conference-operator/contract'
import type { Data, Scene } from '../scene.js'
import { ecrire } from '../dom.js'
import { maintenant } from '../time.js'
import { compterAffichages } from '../affichages.js'
import { peutAnimer } from '../effects.js'
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
 * With `remplir` set, the page is filled rather than capped: posts keep coming,
 * in every column — under the featured one too — until none fits any more, so
 * short posts leave no hole. At most `MAX_REMPLIES` cards all the same.
 *
 * With `sponsoriseTous` set, the partners' posts leave the head of the page: one
 * of them is slotted in the line every that many posts, at the size of any
 * card, taking turns — the count runs on from one page to the next.
 *
 * Each page counts as a display of its posts when it goes live (`entre`), or
 * when it is redrawn in place on screen — never when it is laid out off screen.
 *
 * Drawn off screen only, like every loop scene: a post arriving while the wall
 * is up waits for the next pass rather than moving a card in front of the room.
 * Its own pages turn in place, faded out then in: every `dureePage` seconds in
 * the loop — a new page only if it still has its whole time before the wall
 * leaves — and, held by the operator, every `dureePage` or the wall's duration.
 */
/** Cards on a filled page at most: every one laid is measured. */
const MAX_REMPLIES = 12
/** The fade of a page turning in place, each way, in ms. */
const FONDU = 600

export function wallsio(el: HTMLElement): Scene {
  el.innerHTML = `
    <header class="bande">
      <h2 class="f-titre" data-titre data-effet="mots"></h2>
      <p class="bande-droite" data-hashtag data-effet="glisse" data-delai="350"></p>
    </header>
    <div class="contenu mur" data-effet-enfants="fondu" data-cible=".carte" data-ordre="position" data-pas="110" data-delai="250">
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
  /** One sponsored post every this many posts; 0 = partners lead the page, like any featured post. */
  let sponsoriseTous = 0
  let remplir = true
  let now = 0
  /** The regular posts' line, by id: shown ones go to the back. */
  let file: string[] = []
  /** Which featured post leads the next page. */
  let tour = 0
  /** Which sponsored post is slotted in next, and the posts shown since the last one — across pages. */
  let tourSponsorise = 0
  let depuisSponsorise = 0
  /** When the page on screen was laid out: held by the operator, it turns on its own. */
  let poseA = 0
  /** When the wall last went live: in the loop, its pass is counted from there. */
  let entreA = 0
  /** The posts on the page laid out, counted when it goes live. */
  let affiches: string[] = []
  /** The page fading out before it turns in place, and since when. */
  let fondu: { anim: Animation; depuis: number } | null = null

  function page(): void {
    poseA = now
    cols.forEach((c) => c.replaceChildren())
    // Slotted in among the posts, the partners leave the head of the page — unless
    // there is nothing to slot them among: they would never be shown.
    const fil = posts.some((p) => p.sponsor == null && !p.featured)
    const sponsorises = sponsoriseTous > 0 && fil ? posts.filter((p) => p.sponsor != null) : []
    const enAvant = posts.filter((p) => p.featured && !sponsorises.includes(p))
    const autres = posts.filter((p) => !p.featured && !sponsorises.includes(p))
    const tete = enAvant.length ? enAvant[tour % enAvant.length]! : null
    tour += 1
    mur.classList.toggle('sans-avant', tete == null)
    if (tete) avant.append(carte(tete, now))
    // Filling, the featured post's column takes posts under it too — last: an
    // ordinary column as short wins over it.
    const colonnes = !tete ? cols : remplir ? [...cols.slice(1), cols[0]!] : cols.slice(1)

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
    const poses: string[] = tete ? [tete.id] : []
    const max = remplir ? MAX_REMPLIES - (tete ? 1 : 0) : Math.max(0, parPage - (tete ? 1 : 0))
    /** Posts that fitted nowhere: past this many, the page is full. */
    const essais = remplir ? 8 : 4
    let cartes = 0
    let echecs = 0
    /** Puts a card in the shortest column; `false` when it overflows the page. */
    const poser = (post: WallCard): boolean => {
      const col = colonnes.reduce((a, c) => (bas(c) < bas(a) ? c : a))
      const c = carte(post, now)
      col.append(c)
      if ((cartes || col.childElementCount > 1) && col.clientHeight > 0 && bas(col) > col.clientHeight) { c.remove(); echecs++; return false }
      cartes += 1
      poses.push(post.id)
      return true
    }
    for (const id of file) {
      if (cartes >= max || echecs >= essais) break
      if (sponsorises.length > 0 && depuisSponsorise >= sponsoriseTous) {
        // In line, at the size of any post: it is its turn, not its page.
        const sponsorise = sponsorises[tourSponsorise % sponsorises.length]!
        if (poser({ ...sponsorise, featured: false })) { tourSponsorise += 1; depuisSponsorise = 0 }
        if (cartes >= max || echecs >= essais) break
      }
      if (!poser(parId.get(id)!)) continue
      places.push(id)
      depuisSponsorise += 1
    }
    file = file.filter((id) => !places.includes(id)).concat(places)
    affiches = poses
    // Redrawn in place — held on screen by the operator: this page is seen now.
    if (el.classList.contains('is-live')) compterAffichages(affiches)
  }

  /**
   * The next page, on screen: the current one fades out, the new one is laid
   * while nothing shows, then fades in. Off screen, or where nothing animates,
   * it is simply laid.
   */
  function tourner(data: Data): void {
    if (fondu != null) {
      // An OBS source off air may never finish an animation: the clock ends it.
      if (Date.now() - fondu.depuis >= FONDU) finirFondu(data)
      return
    }
    if (!el.classList.contains('is-live') || !peutAnimer()) {
      now = maintenant(data)
      page()
      return
    }
    const anim = mur.animate([{ opacity: 1 }, { opacity: 0 }], { duration: FONDU, easing: 'ease-in', fill: 'forwards' })
    fondu = { anim, depuis: Date.now() }
    anim.onfinish = () => finirFondu(data)
  }

  /** Faded out: the next page is laid, then fades in. Once only. */
  function finirFondu(data: Data): void {
    if (fondu == null) return
    const { anim } = fondu
    fondu = null
    // Taken off screen meanwhile: `quitte` lays the next page.
    if (el.classList.contains('is-live')) {
      now = maintenant(data)
      page()
    }
    anim.cancel()
    apparaitre()
  }

  /** The page on screen fades in. */
  function apparaitre(): void {
    if (!peutAnimer() || !el.classList.contains('is-live')) return
    mur.animate([{ opacity: 0 }, { opacity: 1 }], { duration: FONDU, easing: 'ease-out' })
  }

  function arreterFondu(): void {
    fondu?.anim.cancel()
    fondu = null
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
      sponsoriseTous = c?.sponsoriseTous ?? 0
      remplir = c?.remplir ?? true
      el.classList.toggle('sans-bande', c?.bandeau === false)
      posts = data.socialWall ?? []
      vide.hidden = posts.length > 0
      now = maintenant(data)
      arreterFondu()
      page()
      // Redrawn in place, the new page does not pop in front of the room.
      apparaitre()
    },
    entre(data: Data) {
      compterAffichages(affiches)
      entreA = maintenant(data)
      // Laid off screen a whole loop ago: its time starts now.
      poseA = entreA
    },
    quitte(data: Data) {
      arreterFondu()
      now = maintenant(data)
      page()
    },
    /**
     * The page turns in place once it has had its time, with a fade. Put up on
     * its own by the operator, the wall never leaves the screen and turns for
     * as long as it is held; in the loop, only with a page duration, and never
     * a page cut short by the wall leaving — the next one is laid as it leaves
     * (`quitte`).
     */
    tick(data: Data) {
      // A fade under way ends, wherever the wall is: `tourner` lays nothing off screen.
      if (fondu != null) { tourner(data); return }
      const t = maintenant(data)
      const passage = (data.boucle?.durees.wallsio ?? 25) * 1000
      const parPage = (data.boucle?.wallsio?.dureePage ?? 0) * 1000
      if (data.state.mode === 'wallsio') {
        if (poseA > 0 && t - poseA >= (parPage || passage)) tourner(data)
        return
      }
      if (parPage <= 0 || entreA === 0 || !el.classList.contains('is-live')) return
      // The engine counts the pass on its own one-second clock: a second of slack.
      if (t - poseA >= parPage && t - entreA + parPage <= passage + 1000) tourner(data)
    },
  }
  return scene
}
