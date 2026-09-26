import type { Data, Scene } from '../scene.js'
import { cree, ecrire, rond } from '../dom.js'

const ZOOM_SPONSORS_MAX = 1.1 // largest enlargement of the sponsor circles

/** "Petit déjeuner — offert par" and its logos. One scene per announcement. */
export function annonce(el: HTMLElement, index: number): Scene {
  el.innerHTML = `
    <div class="annonce">
      <p class="annonce-titre f-titre contour vague" data-titre data-effet="mots"></p>
      <p class="annonce-sous f-titre contour" data-sous-titre data-effet="claque" data-delai="500"></p>
      <div class="annonce-logos" data-logos data-effet-enfants="pop" data-delai="750"></div>
    </div>`
  const titre = el.querySelector<HTMLElement>('[data-titre]')!
  const sous = el.querySelector<HTMLElement>('[data-sous-titre]')!
  const logos = el.querySelector<HTMLElement>('[data-logos]')!
  const donnees = (data: Data) => data.boucle?.annonces[index] ?? null
  return {
    el,
    cle: donnees,
    jouable: (data: Data) => (donnees(data)?.logos.length ?? 0) > 0,
    rendre(data: Data) {
      const a = donnees(data)
      ecrire(titre, a?.titre ?? '')
      ecrire(sous, a?.sousTitre ?? '')
      logos.replaceChildren(...(a?.logos ?? []).map((logo, i) => rond(logo, i)))
    },
  }
}

/** "Merci à nos Sponsors", large, before the sponsor pages. */
export function merci(el: HTMLElement): Scene {
  el.innerHTML = `
    <div class="titre-plein">
      <h2 class="f-titre contour vague" data-effet="claque"></h2>
    </div>`
  const titre = el.querySelector<HTMLElement>('h2')!
  return {
    el,
    cle: (data: Data) => data.boucle?.merciSponsors ?? null,
    // Thanking sponsors nobody then shows would read as a mistake.
    jouable: (data: Data) =>
      Boolean(data.boucle?.merciSponsors) &&
      (data.boucle?.sponsorPages ?? []).some((page) => page.rangs.some((row) => row.logos.length > 0)),
    rendre(data: Data) {
      ecrire(titre, data.boucle?.merciSponsors ?? '')
    },
  }
}

/**
 * One page of sponsors: an optional title, then rows of white circles, each
 * row with its own circle size. The circles take the largest size that fits.
 */
export function sponsors(el: HTMLElement, index: number): Scene {
  el.innerHTML = `
    <div class="sp">
      <h2 class="sp-titre f-titre vague" data-titre data-effet="mots"></h2>
      <div class="sp-zone"><div class="sp-rangs" data-effet-enfants="pop" data-cible=".rond" data-pas="90" data-delai="300"></div></div>
    </div>
    <p class="vide" hidden>Nos partenaires</p>`
  const titre = el.querySelector<HTMLElement>('[data-titre]')!
  const zone = el.querySelector<HTMLElement>('.sp-zone')!
  const contenu = el.querySelector<HTMLElement>('.sp-rangs')!
  const vide = el.querySelector<HTMLElement>('.vide')!
  const donnees = (data: Data) => data.boucle?.sponsorPages[index] ?? null
  return {
    el,
    cle: donnees,
    jouable: (data: Data) => (donnees(data)?.rangs ?? []).some((row) => row.logos.length > 0),
    rendre(data: Data) {
      const page = donnees(data) ?? { titre: '', rangs: [] }
      ecrire(titre, page.titre)
      const rangs = page.rangs.filter((row) => row.logos.length > 0)
      vide.hidden = rangs.length > 0
      let i = 0
      contenu.replaceChildren(...rangs.map((row) => {
        const rang = cree('div', 'sp-rang')
        rang.style.setProperty('--t', String(row.taille || 1))
        rang.append(...row.logos.map((logo) => rond(logo, i++)))
        return rang
      }))
      ajusterRonds(zone, contenu)
    },
  }
}

/**
 * Gives the circles of `contenu` the largest size (`--k` on `zone`) that fits.
 *
 * A margin is kept: otherwise the top and bottom circles, which float, would be
 * clipped by the edge of the zone. Shared with the VOD outro, laid out the same.
 */
export function ajusterRonds(zone: HTMLElement, contenu: HTMLElement): void {
  const marge = 30
  let bas = 0.2
  let haut = ZOOM_SPONSORS_MAX
  let ok = zone.clientHeight > 0 ? bas : 1
  if (zone.clientHeight > 0) {
    for (let n = 0; n < 12; n++) {
      const k = (bas + haut) / 2
      zone.style.setProperty('--k', k.toFixed(3))
      if (contenu.offsetHeight <= zone.clientHeight - marge) { ok = k; bas = k } else haut = k
    }
  }
  zone.style.setProperty('--k', ok.toFixed(3))
}
