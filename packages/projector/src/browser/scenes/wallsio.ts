import type { Data, Scene } from '../scene.js'
import { ecrire } from '../dom.js'

/**
 * The walls.io wall.
 *
 * Loaded once, then left running: the iframe is never inside markup that gets
 * rewritten, so a state arriving every second does not reload it. It is only
 * replaced when its address changes, and reloaded every `rechargeMinutes` —
 * always off screen — to keep the memory stable over a day. Skipped while the
 * room's server says walls.io does not answer.
 */
export function wallsio(el: HTMLElement): Scene {
  el.innerHTML = `
    <header class="bande">
      <h2 class="f-titre" data-titre data-effet="mots"></h2>
      <p class="bande-droite" data-hashtag data-effet="glisse" data-delai="350"></p>
    </header>
    <div class="contenu wallsio" data-effet="entre" data-delai="200"></div>
    <p class="vide" hidden>Aucun mur configuré sur le hub.</p>`
  const titre = el.querySelector<HTMLElement>('[data-titre]')!
  const hashtag = el.querySelector<HTMLElement>('[data-hashtag]')!
  const zone = el.querySelector<HTMLElement>('.wallsio')!
  const vide = el.querySelector<HTMLElement>('.vide')!
  let chargeA = 0
  let pret = false

  function charger(src: string): void {
    pret = false
    chargeA = Date.now()
    zone.dataset.url = src
    const cadre = document.createElement('iframe')
    cadre.title = 'Mur social'
    cadre.loading = 'eager'
    cadre.addEventListener('load', () => { pret = true }, { once: true })
    // A frame that never says "load" must not keep the scene away for the day.
    setTimeout(() => { pret = true }, 15_000)
    cadre.src = src
    zone.replaceChildren(cadre)
  }

  const scene: Scene = {
    el,
    cle: (data: Data) => [data.boucle?.wallsio, data.wallsIoReachable],
    // The iframe exists as soon as there is an address: the page loads it off
    // screen and plays the scene once walls.io answers.
    jouable: (data: Data) => Boolean(data.boucle?.wallsio.src) && data.wallsIoReachable && pret,
    rendre(data: Data) {
      const c = data.boucle?.wallsio
      ecrire(titre, c?.titre ?? '')
      ecrire(hashtag, c?.hashtag ?? '')
      zone.style.setProperty('--zoom-wallsio', String(Math.max(0.5, c?.zoom ?? 1)))
      const src = c?.src ?? null
      vide.hidden = src != null
      if (src == null) {
        zone.replaceChildren()
        delete zone.dataset.url
        return
      }
      const minutes = c?.rechargeMinutes ?? 0
      const expire = minutes > 0 && chargeA > 0 && Date.now() - chargeA > minutes * 60_000
      if (data.wallsIoReachable && (zone.dataset.url !== src || expire)) charger(src)
    },
    tick(data: Data) {
      const minutes = data.boucle?.wallsio.rechargeMinutes ?? 0
      if (minutes > 0 && chargeA > 0 && Date.now() - chargeA > minutes * 60_000) scene.sale = true
    },
  }
  return scene
}
