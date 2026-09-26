import type { VodClip, VodHabillage, VodSponsorPage } from '@conference-operator/contract'
import { cree, ecrire, initiales, rond, teinte } from '../browser/dom.js'
import { jouerEffets } from '../browser/effects.js'
import { ajusterRonds } from '../browser/scenes/sponsors.js'
import { INTRO_MS, OUTRO_MS, OUTRO_SORTIE_MS } from './timeline.js'

/**
 * The intro and the outro of a published talk, on the loop's stage.
 *
 * Two uses, one page. In the console, it plays and replays, to be looked at. In
 * the renderer (`window.__VOD_CAPTURE__`), it plays nothing on its own: every
 * animation is paused and the renderer sets the instant of each frame through
 * `__vod.figer(ms)` — what a frame shows then depends on its timestamp only,
 * never on how fast the capture went.
 */

declare global {
  interface Window {
    __VOD_CAPTURE__?: boolean
    __vod?: { clip: VodClip; dureeMs: number; pret: Promise<void>; figer: (ms: number) => void }
  }
}

const donnees = JSON.parse(document.getElementById('vod-donnees')?.textContent ?? '{}') as {
  clip: VodClip
  habillage: VodHabillage
}
const capture = window.__VOD_CAPTURE__ === true
const plateau = document.getElementById('stage')!
const clip = document.getElementById('clip')!
const noir = document.getElementById('noir')!
const stinger = document.getElementById('stinger')!

/* ---------- Scale, as the projector does: the design is a fixed 1920×1080 ---------- */
const echelle = () =>
  plateau.style.setProperty('--scale', String(Math.min(innerWidth / 1920, innerHeight / 1080) || 1))
addEventListener('resize', echelle)
echelle()

/* ---------- Chance, seeded: `eclate` draws at random, a re-render must not ---------- */
function graine(texte: string): () => number {
  let h = [...texte].reduce((a, c) => Math.imul(a ^ c.charCodeAt(0), 2654435761) >>> 0, 1779033703)
  return () => {
    h = (h + 0x6d2b79f5) >>> 0
    let t = h
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/* ---------- Intro ---------- */
function intro(h: VodHabillage): number {
  clip.className = 'vod vod-intro'
  clip.innerHTML = `
    <header class="vod-tete">
      <img class="vod-logo" alt="" data-effet="zoom" data-delai="350" hidden>
      <p class="vod-edition" data-effet="monte" data-delai="650"></p>
    </header>
    <div class="vod-talk">
      <p class="vod-categorie" data-effet="pop" data-delai="950" hidden></p>
      <h1 class="vod-titre f-titre contour" data-effet="mots" data-delai="1100"></h1>
    </div>
    <ul class="vod-orateurs" data-effet-enfants="entre" data-pas="180" data-delai="2000"></ul>`

  const logo = clip.querySelector<HTMLImageElement>('.vod-logo')!
  if (h.event.logoUrl) {
    logo.src = h.event.logoUrl
    logo.hidden = false
  }
  clip.querySelector('.vod-edition')!.textContent = [h.event.name, h.event.date].filter(Boolean).join(' · ')

  const categorie = clip.querySelector<HTMLElement>('.vod-categorie')!
  if (h.talk.category) {
    categorie.textContent = h.talk.category
    categorie.hidden = false
    if (h.talk.color) categorie.style.setProperty('--c', h.talk.color)
  }

  ecrire(clip.querySelector<HTMLElement>('.vod-titre')!, h.talk.title)

  const orateurs = clip.querySelector<HTMLElement>('.vod-orateurs')!
  orateurs.style.setProperty('--n', String(Math.max(1, h.speakers.length)))
  orateurs.replaceChildren(...h.speakers.map((s) => {
    const li = cree('li', 'vod-orateur')
    const photo = cree('div', 'vod-photo')
    if (s.photoUrl) {
      const img = new Image()
      img.src = s.photoUrl
      img.alt = ''
      // A photo that does not load gives its place back to the initials.
      img.addEventListener('error', () => { photo.replaceChildren(initiales(s.name)); photo.style.background = teinte(s.name) }, { once: true })
      photo.append(img)
    } else {
      photo.textContent = initiales(s.name)
      photo.style.background = teinte(s.name)
    }
    li.append(photo, cree('p', 'vod-nom', s.name))
    if (s.company) li.append(cree('p', 'vod-societe', s.company))
    return li
  }))
  return INTRO_MS
}

/** The largest title size that holds in its box: a title may be three words or thirty. */
function ajusterTitre(): void {
  const titre = clip.querySelector<HTMLElement>('.vod-titre')
  if (titre == null) return
  let bas = 56
  let haut = 132
  for (let n = 0; n < 10; n++) {
    const taille = (bas + haut) / 2
    titre.style.fontSize = `${taille}px`
    if (titre.scrollHeight <= 330 && titre.scrollWidth <= titre.clientWidth) bas = taille
    else haut = taille
  }
  titre.style.fontSize = `${Math.floor(bas)}px`
}

/* ---------- Outro ---------- */
/** The first tier — the one that paid the most — is drawn larger than the others. */
const TAILLE_PREMIER = 1.25
const TAILLE_SUIVANTS = 0.8

function outro(h: VodHabillage): number {
  clip.className = 'vod vod-outro'
  clip.innerHTML = `
    <h2 class="vod-merci f-titre contour vague" data-effet="claque" data-delai="300"></h2>
    <div class="sp-zone">
      <div class="sp-rangs" data-effet-enfants="pop" data-cible=".rond, .vod-niveau" data-ordre="position" data-pas="70" data-delai="900"></div>
    </div>`
  ecrire(clip.querySelector<HTMLElement>('.vod-merci')!, h.merci)

  const contenu = clip.querySelector<HTMLElement>('.sp-rangs')!
  let i = 0
  const groupe = (page: VodSponsorPage, facteur: number) => {
    const el = cree('div', 'vod-groupe')
    if (page.titre) el.append(cree('p', 'vod-niveau f-titre', page.titre))
    el.append(...page.rangs.map((row) => {
      const rang = cree('div', 'sp-rang')
      rang.style.setProperty('--t', String((row.taille || 1) * facteur))
      rang.append(...row.logos.map((logo) => rond(logo, i++)))
      return rang
    }))
    return el
  }
  // The first tier alone on top; the others side by side beneath it — stacked,
  // four tiers left the circles tiny in a column with the sides empty.
  const [premier, ...suivants] = h.sponsorPages
  const autres = cree('div', 'vod-autres')
  autres.append(...suivants.map((page) => groupe(page, TAILLE_SUIVANTS)))
  contenu.replaceChildren(...(premier ? [groupe(premier, TAILLE_PREMIER)] : []), ...(suivants.length ? [autres] : []))
  if (h.sponsorPages.length === 0) clip.classList.add('sans-sponsors')
  return OUTRO_MS
}

/* ---------- The frame around: from black, the stinger, to black ---------- */
function habiller(duree: number, kind: VodClip): void {
  noir.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 450, easing: 'ease-out', fill: 'backwards' }).id = 'vod'
  stinger.animate([
    { transform: 'translateX(-2800px) skewX(-14deg)' },
    { transform: 'translateX(2800px) skewX(-14deg)' },
  ], { duration: 1_000, delay: 120, easing: 'cubic-bezier(.55, 0, .45, 1)', fill: 'both' }).id = 'vod'
  if (kind === 'outro') {
    noir.animate([{ opacity: 0 }, { opacity: 1 }], {
      duration: OUTRO_SORTIE_MS - 300,
      delay: duree - OUTRO_SORTIE_MS + 300,
      easing: 'ease-in',
      fill: 'forwards',
    }).id = 'vod-fin'
  }
}

/** Everything the frame depends on is there: typefaces, images, layout. */
async function charge(): Promise<void> {
  await document.fonts.ready
  await Promise.all([...document.images].map((img) => img.decode().catch(() => undefined)))
}

function jouer(duree: number): void {
  for (const a of document.getAnimations()) if (a.id.startsWith('vod')) a.cancel()
  const hasard = Math.random
  Math.random = graine(`${donnees.clip}|${donnees.habillage.talk.title}`)
  try {
    jouerEffets(clip, 0)
  } finally {
    Math.random = hasard
  }
  habiller(duree, donnees.clip)
}

const dureeMs = donnees.clip === 'intro' ? intro(donnees.habillage) : outro(donnees.habillage)

const pret = charge().then(() => {
  ajusterTitre()
  for (const zone of clip.querySelectorAll<HTMLElement>('.sp-zone')) {
    ajusterRonds(zone, zone.querySelector<HTMLElement>('.sp-rangs')!)
  }
  document.body.classList.add('pret')
  jouer(dureeMs)
  if (capture) figer(0)
  // In the console, it plays again after a breath, to be looked at twice.
  else setInterval(() => jouer(dureeMs), dureeMs + 1_500)
})

/** Every animation of the page, paused, at `ms` from the clip's start. */
function figer(ms: number): void {
  for (const a of document.getAnimations()) {
    a.pause()
    a.currentTime = ms
  }
}

window.__vod = { clip: donnees.clip, dureeMs, pret, figer }
