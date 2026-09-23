/** Small DOM helpers, as in the reference loop. */

export const cree = <K extends keyof HTMLElementTagNameMap>(
  balise: K,
  classe?: string | null,
  texte?: string | null,
): HTMLElementTagNameMap[K] => {
  const e = document.createElement(balise)
  if (classe) e.className = classe
  if (texte != null) e.textContent = texte
  return e
}

/** Copies the text of the `.contour` elements for their outline. */
export const contours = (racine: ParentNode): void => {
  racine.querySelectorAll<HTMLElement>('.contour').forEach((e) => {
    e.dataset.texte = e.textContent ?? ''
  })
}

/** Writes a text, preparing the element for the effects and the outline. */
export const ecrire = (el: HTMLElement, texte: string): void => {
  el.textContent = texte
  el.classList.remove('decoupe')
  delete el.dataset.decoupe
  if (el.classList.contains('contour')) el.dataset.texte = texte
}

/** A text with its #hashtags and @mentions set off, as on LinkedIn. */
export function texteRiche(p: HTMLElement, texte: string): void {
  let dernier = 0
  for (const m of texte.matchAll(/[#@][\p{L}\p{N}_]+/gu)) {
    if (m.index > dernier) p.append(texte.slice(dernier, m.index))
    p.append(cree('span', 'tag', m[0]))
    dernier = m.index + m[0].length
  }
  if (dernier < texte.length) p.append(texte.slice(dernier))
}

export const initiales = (nom: string): string =>
  nom.split(/[\s-]+/).filter(Boolean).slice(0, 2).map((m) => m[0]!.toUpperCase()).join('')

const TEINTES = ['#5e17eb', '#b01fd6', '#1f8fb0', '#2c2ca4', '#b44c70', '#c77414']
export const teinte = (nom: string): string =>
  TEINTES[[...nom].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7) % TEINTES.length]!

export const pluriel = (n: number, mot: string): string =>
  `${n.toLocaleString('fr-FR')} ${mot}${n > 1 ? 's' : ''}`

/** A white circle holding a logo, or the name when there is no image. */
export function rond(s: { nom: string; logoUrl: string | null; echelle: number }, i = 0): HTMLElement {
  const r = cree('div', 'rond flotte')
  r.style.setProperty('--i', String(i))
  if (s.echelle) r.style.setProperty('--e', String(s.echelle))
  if (s.logoUrl) {
    const img = new Image()
    img.src = s.logoUrl
    img.alt = s.nom || ''
    // A logo that fails to load gives its place back to the name.
    img.addEventListener('error', () => {
      r.classList.add('sans-logo')
      r.replaceChildren(s.nom || '')
    }, { once: true })
    r.append(img)
  } else {
    r.classList.add('sans-logo')
    r.textContent = s.nom || ''
  }
  return r
}

/**
 * An SVG drawn by the room (a QR code), parsed rather than set as HTML.
 *
 * It comes from the room's own server, but the page takes nothing as markup
 * that it can build as nodes.
 */
export function svg(markup: string): Node | null {
  if (!markup) return null
  const doc = new DOMParser().parseFromString(markup, 'image/svg+xml')
  const root = doc.documentElement
  if (root == null || root.nodeName.toLowerCase() !== 'svg') return null
  return document.importNode(root, true)
}

/** The LinkedIn mark of the reference's signature, drawn instead of shipped. */
export function linkedin(): SVGSVGElement {
  const ns = 'http://www.w3.org/2000/svg'
  const icone = document.createElementNS(ns, 'svg')
  icone.setAttribute('viewBox', '0 0 64 64')
  icone.setAttribute('aria-hidden', 'true')
  const fond = document.createElementNS(ns, 'rect')
  fond.setAttribute('width', '64')
  fond.setAttribute('height', '64')
  fond.setAttribute('rx', '12')
  fond.setAttribute('fill', '#fff')
  const lettres = document.createElementNS(ns, 'path')
  lettres.setAttribute('fill', '#0a66c2')
  lettres.setAttribute(
    'd',
    'M14 24h8v26h-8zM18 11a4.6 4.6 0 1 1 0 9.2A4.6 4.6 0 0 1 18 11zM27 24h7.7v3.6h.1c1.1-2 3.7-4.2 7.6-4.2 8.1 0 9.6 5.3 9.6 12.3V50h-8V37.4c0-3 0-6.9-4.2-6.9s-4.8 3.3-4.8 6.7V50h-8z',
  )
  icone.append(fond, lettres)
  return icone
}
