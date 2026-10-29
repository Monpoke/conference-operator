import { createHash } from 'node:crypto'
import { escapeHtml } from '@conference-operator/format'
import type { MurPublic } from '@conference-operator/contract'
import type { Reseau } from './config.js'
import type { Image } from './hub.js'

/** What the page shows before the hub has ever answered: an empty wall, the default look. */
export const MUR_VIDE: MurPublic = {
  revision: '',
  event: { name: 'Le mur social' },
  logo: null,
  hashtag: null,
  accroche: '',
  menu: [],
  reseaux: ['bluesky', 'mastodon', 'x', 'linkedin'],
  theme: { couleurs: {}, fond: null, polices: {} },
  posts: [],
}

/**
 * The page's script. A constant — nothing is interpolated into it — so that its
 * hash, in the `Content-Security-Policy`, is the only script the page may run.
 * The data comes in a `<script type="application/json">`, which never runs.
 */
const SCRIPT = `(() => {
  'use strict'
  const $ = (id) => document.getElementById(id)
  let state = JSON.parse($('donnees').textContent)
  const mur = $('mur')
  const etat = $('etat')
  const vus = new Set()
  const dates = new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Paris' })
  // Beyond this, a post is folded to a few lines: one long post no longer
  // stretches its column a screen down.
  const LONG = 360
  const LARGEUR_MIN = 300
  const ECART = 16

  // Views: a card counts once per page load, when half of it — or half the
  // screen, for a card taller than that — stays in view for a second. What was
  // seen leaves every 10 s, and when the page is put away.
  const VUE_MS = 1000
  const comptes = new Set()
  const aEnvoyer = new Set()
  const enCours = new Map()
  function oublier(id) {
    clearTimeout(enCours.get(id))
    enCours.delete(id)
  }
  const observateur = 'IntersectionObserver' in window ? new IntersectionObserver((entrees) => {
    for (const e of entrees) {
      const id = e.target.dataset.id
      if (!id || comptes.has(id)) continue
      const visible = e.isIntersecting && (e.intersectionRatio >= 0.5 ||
        (e.rootBounds != null && e.intersectionRect.height >= e.rootBounds.height / 2))
      if (visible && !enCours.has(id)) {
        enCours.set(id, setTimeout(() => {
          enCours.delete(id)
          if (document.hidden || comptes.has(id)) return
          comptes.add(id)
          aEnvoyer.add(id)
        }, VUE_MS))
      } else if (!visible && enCours.has(id)) oublier(id)
    }
  }, { threshold: [0, 0.25, 0.5, 0.75, 1] }) : null
  function envoyer(fin) {
    if (aEnvoyer.size === 0) return
    const corps = JSON.stringify({ ids: [...aEnvoyer] })
    aEnvoyer.clear()
    if (fin && navigator.sendBeacon) {
      navigator.sendBeacon('/vues', new Blob([corps], { type: 'application/json' }))
      return
    }
    fetch('/vues', { method: 'POST', headers: { 'content-type': 'application/json' }, body: corps, keepalive: true }).catch(() => {})
  }
  setInterval(() => envoyer(false), 10000)
  addEventListener('pagehide', () => envoyer(true))
  document.addEventListener('visibilitychange', () => { if (document.hidden) envoyer(true) })

  function depuis(iso) {
    const t = Date.parse(iso)
    if (!Number.isFinite(t)) return ''
    const s = Math.max(0, (Date.now() - t) / 1000)
    if (s < 60) return "à l'instant"
    if (s < 3600) return 'il y a ' + Math.floor(s / 60) + ' min'
    if (s < 86400) return 'il y a ' + Math.floor(s / 3600) + ' h'
    return dates.format(t)
  }
  function el(tag, classe, texte) {
    const e = document.createElement(tag)
    if (classe) e.className = classe
    if (texte != null) e.textContent = texte
    return e
  }
  function initiales(nom) {
    return nom.split(/\\s+/).filter(Boolean).slice(0, 2).map((m) => m[0].toUpperCase()).join('') || '?'
  }
  function teinte(nom) {
    let h = 7
    for (const c of nom) h = (h * 31 + c.charCodeAt(0)) >>> 0
    return 'var(--c-avatar-' + (h % 6) + ')'
  }
  function image(cle, classe, alt) {
    const img = new Image()
    img.src = '/images/' + cle
    img.alt = alt
    img.decoding = 'async'
    img.loading = 'lazy'
    if (classe) img.className = classe
    // A photo that arrives changes its card's height: the columns are laid again.
    img.addEventListener('load', planifier)
    return img
  }
  function carte(p) {
    const a = el('article', 'carte')
    a.dataset.id = p.id
    if (p.featured) a.classList.add('en-avant')
    if (p.sponsor) a.classList.add('partenaire')
    const auteur = p.author || '?'

    const tete = el('header', 'tete')
    const avatar = el('div', 'avatar')
    if (p.avatar) avatar.append(image(p.avatar, null, ''))
    else {
      avatar.textContent = initiales(auteur)
      avatar.style.background = teinte(auteur)
    }
    const qui = el('div', 'qui')
    qui.append(el('p', 'nom', auteur))
    if (p.authorSubtitle) qui.append(el('p', 'sous-titre', p.authorSubtitle))
    tete.append(avatar, qui)
    a.append(tete)

    if (p.text) {
      const texte = el('p', 'texte', p.text)
      a.append(texte)
      if (p.text.length > LONG) {
        texte.classList.add('replie')
        const suite = el('button', 'suite', 'Lire la suite')
        suite.type = 'button'
        suite.setAttribute('aria-expanded', 'false')
        suite.addEventListener('click', () => {
          const ouvert = texte.classList.toggle('replie') === false
          suite.textContent = ouvert ? 'Réduire' : 'Lire la suite'
          suite.setAttribute('aria-expanded', String(ouvert))
          planifier()
        })
        a.append(suite)
      }
    }
    if (p.video) {
      // A short loop, muted, as on the networks: its still shows until it plays.
      const v = document.createElement('video')
      v.className = 'photo'
      v.src = '/images/' + p.video
      if (p.image) v.setAttribute('poster', '/images/' + p.image)
      v.muted = true
      v.loop = true
      v.autoplay = true
      v.playsInline = true
      v.preload = 'auto'
      v.setAttribute('aria-hidden', 'true')
      v.addEventListener('loadedmetadata', planifier)
      a.append(v)
    } else if (p.image) a.append(image(p.image, 'photo', ''))

    const pied = el('footer', 'pied')
    if (p.sponsor) {
      const s = el('span', 'sponsor')
      s.append(el('span', 'badge', 'Partenaire'))
      if (p.sponsor.logo) s.append(image(p.sponsor.logo, 'logo', p.sponsor.name))
      else s.append(el('span', null, p.sponsor.name))
      pied.append(s)
    }
    const meta = el('span', 'meta')
    const quand = el('time', null, depuis(p.postedAt))
    quand.dateTime = p.postedAt
    meta.append(quand)
    if (p.network) meta.append(document.createTextNode(' · ' + p.network))
    pied.append(meta)
    if (p.permalink && /^https?:\\/\\//.test(p.permalink)) {
      const lien = el('a', 'lien', 'Voir le post')
      lien.href = p.permalink
      lien.target = '_blank'
      lien.rel = 'noopener noreferrer'
      pied.append(lien)
    }
    a.append(pied)
    return a
  }

  // A feed reads newest first; the hub orders for the rooms' carousel. Featured stay on top.
  function ordre(a, b) {
    return (b.featured - a.featured) || (Date.parse(b.postedAt) - Date.parse(a.postedAt))
  }

  // Each card built once, kept by post: moving it between columns neither
  // rebuilds it nor fetches its images again. Rebuilt only when the post changed.
  const cartes = new Map()
  let enOrdre = []
  // By waves: the first posts, then the next ones as the reader nears the end.
  // A card not drawn yet fetches nothing — neither its photo nor its video.
  const VAGUE = 12
  let visibles = VAGUE
  let total = 0
  function rendre(premier) {
    const suivantes = new Map()
    const tries = state.posts.slice().sort(ordre)
    total = tries.length
    // Known before being drawn: a post reached by scrolling is not a new one.
    const nouveaux = premier ? new Set() : new Set(tries.filter((p) => !vus.has(p.id)).map((p) => p.id))
    for (const p of tries) vus.add(p.id)
    enOrdre = tries.slice(0, visibles).map((p) => {
      const signature = JSON.stringify(p)
      const connue = cartes.get(p.id)
      const element = connue && connue.signature === signature ? connue.element : carte(p)
      if (nouveaux.has(p.id)) element.classList.add('nouveau')
      suivantes.set(p.id, { signature, element })
      if (observateur) observateur.observe(element)
      return element
    })
    // The cards gone, or rebuilt: no longer watched.
    for (const [id, entree] of cartes) {
      if (suivantes.get(id)?.element === entree.element) continue
      if (observateur) observateur.unobserve(entree.element)
      oublier(id)
    }
    cartes.clear()
    for (const [id, entree] of suivantes) cartes.set(id, entree)
    $('vide').hidden = enOrdre.length > 0
    disposer()
    suite.hidden = visibles >= total
  }

  const suite = $('suite')
  const vague = new IntersectionObserver((entrees) => {
    if (!entrees.some((e) => e.isIntersecting) || visibles >= total) return
    visibles += VAGUE
    rendre(false)
    // Still in sight (a tall screen, short posts): observed afresh, the next wave follows.
    vague.unobserve(suite)
    vague.observe(suite)
  }, { rootMargin: '0px 0px 400px 0px' })
  vague.observe(suite)

  // Masonry: as many columns as the width holds, each card into the shortest
  // one so far. No holes under the short posts, and the newest stay on top.
  function disposer() {
    const n = Math.max(1, Math.min(5, Math.floor((mur.clientWidth + ECART) / (LARGEUR_MIN + ECART))))
    const colonnes = []
    const hauteurs = []
    for (let i = 0; i < n; i++) {
      colonnes.push(el('div', 'colonne'))
      hauteurs.push(0)
    }
    mur.replaceChildren(...colonnes)
    for (const element of enOrdre) {
      let plusCourte = 0
      for (let i = 1; i < n; i++) if (hauteurs[i] < hauteurs[plusCourte] - 1) plusCourte = i
      colonnes[plusCourte].append(element)
      hauteurs[plusCourte] += element.offsetHeight + ECART
    }
  }
  let prevu = null
  function planifier() {
    if (prevu != null) return
    prevu = setTimeout(() => {
      prevu = null
      disposer()
    }, 120)
  }
  let largeur = 0
  new ResizeObserver(() => {
    if (mur.clientWidth === largeur) return
    largeur = mur.clientWidth
    planifier()
  }).observe(mur)

  // Live: the wall asked again every 15 s while the page is in view. A crowd
  // slows it down (429), a lost network retries later; the page keeps its posts.
  let delai = 15000
  let minuteur = null
  async function actualiser() {
    clearTimeout(minuteur)
    if (document.hidden) return
    try {
      const r = await fetch('/mur.json', { cache: 'no-cache' })
      if (r.status === 429) {
        delai = 60000
        etat.textContent = 'Beaucoup de monde sur la page : mises à jour ralenties.'
      } else if (r.ok) {
        const suivant = await r.json()
        delai = 15000
        etat.textContent = ''
        if (JSON.stringify(suivant.theme) !== JSON.stringify(state.theme) || suivant.event.name !== state.event.name) {
          location.reload()
          return
        }
        if (suivant.revision !== state.revision) {
          state = suivant
          rendre(false)
        }
      } else throw new Error(String(r.status))
    } catch {
      delai = 30000
      etat.textContent = 'Connexion perdue : nouvel essai dans un instant.'
    }
    minuteur = setTimeout(actualiser, delai)
  }
  document.addEventListener('visibilitychange', () => { if (!document.hidden) actualiser() })
  setInterval(() => { for (const t of mur.querySelectorAll('time')) t.textContent = depuis(t.dateTime) }, 30000)

  // Mastodon has no single address to post on: each visitor names their instance, once.
  const mastodon = $('partage-mastodon')
  if (mastodon) mastodon.addEventListener('click', (event) => {
    event.preventDefault()
    let deja = ''
    try { deja = localStorage.getItem('mur-mastodon') || '' } catch {}
    const saisie = prompt('Votre instance Mastodon (ex. mastodon.social)', deja)
    if (!saisie) return
    const instance = saisie.trim().replace(/^https?:\\/\\//, '').replace(/\\/.*$/, '')
    if (!/^[a-z0-9.-]+\\.[a-z]{2,}$/i.test(instance)) {
      alert('Ce nom d’instance ne ressemble pas à une adresse : par exemple mastodon.social')
      return
    }
    try { localStorage.setItem('mur-mastodon', instance) } catch {}
    window.open('https://' + instance + '/share?text=' + encodeURIComponent(mastodon.dataset.texte), '_blank', 'noopener')
  })
  const copier = $('copier')
  let copie = null
  if (copier) copier.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(copier.dataset.texte)
      copier.classList.add('copie')
      clearTimeout(copie)
      copie = setTimeout(() => copier.classList.remove('copie'), 2000)
    } catch {}
  })

  // The event site's menu: a burger on a phone, its drawer closed by Escape or a click elsewhere.
  const burger = $('burger')
  const tiroir = $('tiroir')
  if (burger && tiroir) {
    const ouvrir = (ouvert) => {
      tiroir.hidden = !ouvert
      burger.setAttribute('aria-expanded', String(ouvert))
      burger.setAttribute('aria-label', ouvert ? 'Fermer le menu de navigation' : 'Ouvrir le menu de navigation')
    }
    burger.addEventListener('click', () => ouvrir(tiroir.hidden))
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && !tiroir.hidden) { ouvrir(false); burger.focus() }
    })
    document.addEventListener('click', (event) => {
      if (!tiroir.hidden && !tiroir.contains(event.target) && !burger.contains(event.target)) ouvrir(false)
    })
  }

  rendre(true)
  minuteur = setTimeout(actualiser, delai)
})()`

export const SCRIPT_HASH = `'sha256-${createHash('sha256').update(SCRIPT).digest('base64')}'`

/**
 * Everything the page may do: its own script, its own images, its own JSON.
 * Nothing else is fetched — the links to the networks are navigations.
 */
export const CONTENT_SECURITY_POLICY = [
  "default-src 'none'",
  `script-src ${SCRIPT_HASH}`,
  "style-src 'unsafe-inline'",
  "img-src 'self'",
  "media-src 'self'",
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ')

/**
 * The networks' marks, inline: nothing is fetched to draw them. Paths from
 * Simple Icons (CC0), 24×24.
 */
const ICONES: Record<Reseau | 'copier', string> = {
  bluesky:
    'M12 10.8c-1.087-2.114-4.046-6.053-6.798-7.995C2.566.944 1.561 1.266.902 1.565.139 1.908 0 3.08 0 3.768c0 .69.378 5.65.624 6.479.815 2.736 3.713 3.66 6.383 3.364.136-.02.275-.039.415-.056-.138.022-.276.04-.415.056-3.912.58-7.387 2.005-2.83 7.078 5.013 5.19 6.87-1.113 7.823-4.308.953 3.195 2.05 9.271 7.733 4.308 4.267-4.308 1.172-6.498-2.74-7.078a8.741 8.741 0 0 1-.415-.056c.14.017.279.036.415.056 2.67.297 5.568-.628 6.383-3.364.246-.828.624-5.79.624-6.478 0-.69-.139-1.861-.902-2.206-.659-.298-1.664-.62-4.3 1.24C16.046 4.748 13.087 8.687 12 10.8Z',
  mastodon:
    'M23.268 5.313c-.35-2.578-2.617-4.61-5.304-5.004C17.51.242 15.792 0 11.813 0h-.03c-3.98 0-4.835.242-5.288.309C3.882.692 1.496 2.518.917 5.127.64 6.412.61 7.837.661 9.143c.074 1.874.088 3.745.26 5.611.118 1.24.325 2.47.62 3.68.55 2.237 2.777 4.098 4.96 4.857 2.336.792 4.849.923 7.256.38.265-.061.527-.132.786-.213.585-.184 1.27-.39 1.774-.753a.057.057 0 0 0 .023-.043v-1.809a.052.052 0 0 0-.02-.041.053.053 0 0 0-.046-.01 20.282 20.282 0 0 1-4.709.545c-2.73 0-3.463-1.284-3.674-1.818a5.593 5.593 0 0 1-.319-1.433.053.053 0 0 1 .066-.054c1.517.363 3.072.546 4.632.546.376 0 .75 0 1.125-.01 1.57-.044 3.224-.124 4.768-.422.038-.008.077-.015.11-.024 2.435-.464 4.753-1.92 4.989-5.604.008-.145.03-1.52.03-1.67.002-.512.167-3.63-.024-5.545zm-3.748 9.195h-2.561V8.29c0-1.309-.55-1.976-1.67-1.976-1.23 0-1.846.79-1.846 2.35v3.403h-2.546V8.663c0-1.56-.617-2.35-1.848-2.35-1.112 0-1.668.668-1.67 1.977v6.218H4.822V8.102c0-1.31.337-2.35 1.011-3.12.696-.77 1.608-1.164 2.74-1.164 1.311 0 2.302.5 2.962 1.498l.638 1.06.638-1.06c.66-.999 1.65-1.498 2.96-1.498 1.13 0 2.043.395 2.74 1.164.675.77 1.012 1.81 1.012 3.12z',
  x: 'M18.901 1.153h3.68l-8.04 9.19L24 22.846h-7.406l-5.8-7.584-6.638 7.584H.474l8.6-9.83L0 1.154h7.594l5.243 6.932ZM17.61 20.644h2.039L6.486 3.24H4.298Z',
  linkedin:
    'M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433c-1.144 0-2.063-.926-2.063-2.065 0-1.138.92-2.063 2.063-2.063 1.14 0 2.064.925 2.064 2.063 0 1.139-.925 2.065-2.064 2.065zm1.782 13.019H3.555V9h3.564v11.452zM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24 22.271V1.729C24 .774 23.2 0 22.222 0h.003z',
  copier:
    'M16 1H4a2 2 0 0 0-2 2v14h2V3h12V1zm3 4H8a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2zm0 16H8V7h11v14z',
}

const icone = (nom: keyof typeof ICONES) =>
  `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="${ICONES[nom]}"/></svg>`

const PARTAGE: Record<Exclude<Reseau, 'mastodon'>, { nom: string; url: (texte: string) => string }> = {
  bluesky: { nom: 'Bluesky', url: (texte) => `https://bsky.app/intent/compose?text=${texte}` },
  x: { nom: 'X', url: (texte) => `https://x.com/intent/post?text=${texte}` },
  linkedin: { nom: 'LinkedIn', url: (texte) => `https://www.linkedin.com/feed/?shareActive=true&text=${texte}` },
}

function boutons(hashtag: string, reseaux: readonly Reseau[]): string {
  const texte = `#${hashtag} `
  const encode = encodeURIComponent(texte)
  const liens = reseaux.map((reseau) => {
    if (reseau === 'mastodon') {
      return `<a class="bouton mastodon" id="partage-mastodon" data-texte="${escapeHtml(texte)}" href="https://mastodon.social/share?text=${encode}" target="_blank" rel="noopener" aria-label="Publier sur Mastodon">${icone('mastodon')}<span class="nom-reseau">Mastodon</span></a>`
    }
    const { nom, url } = PARTAGE[reseau]
    return `<a class="bouton ${reseau}" href="${escapeHtml(url(encode))}" target="_blank" rel="noopener" aria-label="Publier sur ${nom}">${icone(reseau)}<span class="nom-reseau">${nom}</span></a>`
  })
  // Both labels always laid out, one hidden: the button keeps the width of the
  // longer one, and does not shrink under the finger when « Copié ! » shows.
  liens.push(
    `<button class="bouton discret" id="copier" type="button" data-texte="#${escapeHtml(hashtag)}">${icone('copier')}<span class="libelle"><span class="repos">Copier<span class="tag"> #${escapeHtml(hashtag)}</span></span><span class="fait" aria-live="polite">Copié !</span></span></button>`,
  )
  return liens.join('\n      ')
}

/**
 * The event site's menu, as on its own pages: the links in a row on a wide
 * screen, behind a burger on a phone. The logo leads to the site's home. Links
 * are `http(s)` only (the contract's), and escaped like everything drawn here.
 */
function barre(data: MurPublic): string {
  if (data.menu.length === 0) return ''
  let accueil = '/'
  try {
    accueil = `${new URL(data.menu[0]!.url).origin}/`
  } catch {
    // Checked by the contract already: the page's own address is a harmless fallback.
  }
  const liens = data.menu.map((lien) => `<li><a href="${escapeHtml(lien.url)}">${escapeHtml(lien.libelle)}</a></li>`).join('')
  const marque = data.logo == null
    ? ''
    : `<a class="marque" href="${escapeHtml(accueil)}"><img src="/images/${data.logo}" alt="${escapeHtml(data.event.name)}"></a>`
  return `<nav class="barre" aria-label="Le site de l’événement">
    ${marque}
    <ul class="menu-ligne">${liens}</ul>
    <button class="burger" id="burger" type="button" aria-expanded="false" aria-controls="tiroir" aria-label="Ouvrir le menu de navigation"><svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M3 6h18v2H3zm0 5h18v2H3zm0 5h18v2H3z"/></svg></button>
    <div class="tiroir" id="tiroir" hidden><ul>${liens}</ul></div>
  </nav>`
}

/** The theme's tokens as custom properties. Values are the contract's: colours and CSS values already checked. */
export function variables(theme: MurPublic['theme']): string {
  const lignes: string[] = []
  for (const [nom, valeur] of Object.entries(theme.couleurs)) if (/^[a-z0-9-]+$/.test(nom)) lignes.push(`--c-${nom}:${valeur};`)
  for (const [role, valeur] of Object.entries(theme.polices)) if (/^[a-z0-9-]+$/.test(role)) lignes.push(`--f-${role}:${valeur};`)
  if (theme.fond != null) lignes.push(`--fond:${theme.fond};`)
  return lignes.join('')
}

/**
 * The tab's icon. The event's logo framed on its left square — a mark beside
 * its name is cut to the mark, a square logo shows whole; without a logo, the
 * event's initials on the theme's colours. Embedded, never linked: an SVG drawn
 * as an icon fetches nothing.
 */
export function renderFavicon(data: MurPublic, logo: Image | null): string {
  if (logo != null && /^image\/[a-z0-9.+-]+$/.test(logo.type)) {
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><image width="64" height="64" preserveAspectRatio="xMinYMid slice" href="data:${logo.type};base64,${logo.bytes.toString('base64')}"/></svg>`
  }
  const debut = data.theme.couleurs.violet ?? '#3b5bdb'
  const fin = data.theme.couleurs.cyan ?? '#15aabf'
  const lettres = escapeHtml(
    data.event.name.split(/\s+/).filter(Boolean).slice(0, 2).map((mot) => mot[0]!.toUpperCase()).join('') || '#',
  )
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><defs><linearGradient id="f" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${debut}"/><stop offset="1" stop-color="${fin}"/></linearGradient></defs><rect width="64" height="64" rx="14" fill="url(#f)"/><text x="32" y="42" text-anchor="middle" font-family="Arial, sans-serif" font-weight="700" font-size="28" fill="#fff">${lettres}</text></svg>`
}

/**
 * The line under the hashtag: the console's (Boucle → Mur social), `{hashtag}`
 * drawn in bold; empty, the page's own — which needs a hashtag to make sense.
 */
function phraseAccroche(data: MurPublic): string | null {
  const tag = data.hashtag == null ? '' : `<strong>#${escapeHtml(data.hashtag)}</strong>`
  if (data.accroche.trim() !== '') return escapeHtml(data.accroche.trim()).replaceAll('{hashtag}', tag)
  return data.hashtag == null ? null : `Publiez avec ${tag} : votre post apparaît ici, et sur les écrans des salles une fois relu.`
}

/**
 * The favicon's version, in its address: what it is drawn from — the logo's
 * key, or the name and colours of the initials. A new look is a new address, so
 * the current one can be cached for good.
 */
export function faviconVersion(data: MurPublic): string {
  const source = data.logo ?? JSON.stringify([data.event.name, data.theme.couleurs.violet ?? null, data.theme.couleurs.cyan ?? null])
  return createHash('sha256').update(source).digest('hex').slice(0, 12)
}

export function renderPage(data: MurPublic, reseaux: readonly Reseau[]): string {
  const nom = escapeHtml(data.event.name)
  const json = JSON.stringify(data).replace(/</g, '\\u003c')
  const hashtag = data.hashtag
  const accroche = phraseAccroche(data)

  return `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="${escapeHtml(data.theme.couleurs.nuit ?? '#10121a')}">
<meta name="description" content="Ce qui se publie sur ${nom}, en direct.">
<title>${nom} — le mur social</title>
<link rel="icon" type="image/svg+xml" href="/favicon.svg?v=${faviconVersion(data)}">
<style>
  :root {
    --c-nuit:#10121a; --c-creme:#f8f9fa; --c-violet:#3b5bdb; --c-magenta:#7048e8; --c-cyan:#15aabf; --c-orange:#fcc419;
    --c-carte-fond:#fff; --c-carte-texte:#1a1b2e; --c-carte-discret:#64748b; --c-carte-filet:#e2e8f0;
    --c-avatar-0:#3b5bdb; --c-avatar-1:#7048e8; --c-avatar-2:#1098ad; --c-avatar-3:#2f9e44; --c-avatar-4:#e8590c; --c-avatar-5:#c2255c;
    --f-texte:system-ui, sans-serif; --f-titre:var(--f-texte);
    --fond:var(--c-nuit);
    --ecart: 16px;
  }
  :root { ${variables(data.theme)} }
  * { box-sizing: border-box; }
  html { background: var(--c-nuit); }
  body {
    margin: 0; min-height: 100dvh; color: var(--c-creme); font-family: var(--f-texte);
    background: var(--fond); background-attachment: fixed;
    padding: env(safe-area-inset-top) max(16px, env(safe-area-inset-right)) calc(env(safe-area-inset-bottom) + 32px) max(16px, env(safe-area-inset-left));
  }
  .page { max-width: 1640px; margin: 0 auto; }
  .barre { display: flex; align-items: center; gap: 16px; min-height: 64px; }
  .marque { display: flex; align-items: center; margin-right: auto; border-radius: 6px; }
  .marque img { display: block; height: 32px; width: auto; max-width: 160px; }
  .menu-ligne { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 4px; margin: 0 0 0 auto; padding: 0; list-style: none; }
  .menu-ligne a, .tiroir a {
    display: block; padding: 12px; border-bottom: 2px solid transparent;
    font: 700 14px/1.5 var(--f-texte); text-transform: uppercase; text-decoration: none;
  }
  .menu-ligne a { color: var(--c-creme); }
  @media (hover: hover) { .menu-ligne a:hover, .tiroir a:hover { border-bottom-color: currentColor; } }
  .menu-ligne a:focus-visible, .tiroir a:focus-visible, .marque:focus-visible, .burger:focus-visible { outline: 3px solid var(--c-cyan); outline-offset: 2px; }
  .burger {
    display: none; position: relative; z-index: 31; margin-left: auto; width: 44px; height: 44px;
    border: 0; border-radius: 8px; background: transparent; color: var(--c-creme); cursor: pointer;
  }
  .burger svg { width: 24px; height: 24px; fill: currentColor; }
  .burger[aria-expanded="true"] { color: var(--c-nuit); }
  .tiroir {
    position: fixed; z-index: 30; top: 0; right: 0; bottom: 0; width: min(280px, 80vw); overflow-y: auto;
    padding: calc(env(safe-area-inset-top) + 72px) 32px 32px; background: rgb(255 255 255 / .94);
    backdrop-filter: blur(8px); box-shadow: -10px 0 30px rgb(0 0 0 / .25);
  }
  .tiroir ul { margin: 0; padding: 0; list-style: none; }
  .tiroir a { color: var(--c-violet); padding-left: 0; }
  @media (max-width: 1023px) { .menu-ligne { display: none; } .burger { display: inline-grid; place-items: center; } }
  @media (min-width: 1024px) { .tiroir { display: none !important; } }
  header.entete { text-align: center; padding: 40px 0 28px; }
  .surtitre { margin: 0; font-size: 13px; letter-spacing: .16em; text-transform: uppercase; opacity: .8; }
  h1 { margin: 8px 0 0; font-family: var(--f-titre); font-size: clamp(28px, 6vw, 56px); line-height: 1.05; text-wrap: balance; }
  .hashtag { display: inline-block; margin-top: 14px; padding: 6px 16px; border-radius: 999px; background: var(--c-orange); color: var(--c-nuit); font-weight: 800; font-size: clamp(18px, 3vw, 24px); }
  .invite { max-width: 560px; margin: 16px auto 0; font-size: 16px; line-height: 1.5; opacity: .92; text-wrap: pretty; }
  .boutons { display: flex; flex-wrap: wrap; justify-content: center; gap: 10px; margin-top: 18px; }
  .bouton {
    display: inline-flex; align-items: center; justify-content: center; gap: 8px; min-height: 44px; padding: 0 18px;
    border-radius: 999px; border: 0; background: var(--c-creme); color: var(--c-nuit);
    font: 700 15px/1 var(--f-texte); text-decoration: none; cursor: pointer;
    transition: transform .15s ease-out, box-shadow .15s ease-out;
  }
  .bouton svg { flex: none; width: 18px; height: 18px; fill: currentColor; }
  .bouton.bluesky svg { fill: #1185fe; }
  .bouton.mastodon svg { fill: #6364ff; }
  .bouton.x svg { fill: #000; }
  .bouton.linkedin svg { fill: #0a66c2; }
  @media (hover: hover) { .bouton:hover { transform: translateY(-1px); box-shadow: 0 6px 18px rgb(0 0 0 / .25); } }
  .bouton:active { transform: scale(.97); }
  .bouton:focus-visible { outline: 3px solid var(--c-cyan); outline-offset: 2px; }
  .libelle { display: grid; }
  .libelle > span { grid-area: 1 / 1; text-align: center; }
  .libelle .fait, .copie .libelle .repos { visibility: hidden; }
  .copie .libelle .fait { visibility: visible; }
  .bouton.discret { background: transparent; color: var(--c-creme); box-shadow: inset 0 0 0 2px color-mix(in srgb, var(--c-creme) 60%, transparent); }
  .mur { display: flex; gap: var(--ecart); align-items: flex-start; }
  .colonne { flex: 1 1 0; min-width: 0; display: flex; flex-direction: column; gap: var(--ecart); }
  .carte {
    background: var(--c-carte-fond); color: var(--c-carte-texte); border-radius: 16px; padding: 16px;
    box-shadow: 0 10px 30px rgb(0 0 0 / .18); overflow-wrap: anywhere;
  }
  .carte.en-avant { box-shadow: 0 0 0 3px var(--c-orange), 0 10px 30px rgb(0 0 0 / .22); }
  .carte.nouveau { animation: arrivee .4s ease-out; }
  @keyframes arrivee { from { opacity: 0; transform: translateY(8px); } }
  @media (prefers-reduced-motion: reduce) { .carte.nouveau { animation: none; } .bouton { transition: none; } }
  .tete { display: flex; align-items: center; gap: 12px; }
  .avatar {
    flex: none; width: 44px; height: 44px; border-radius: 50%; overflow: hidden; display: grid; place-items: center;
    color: #fff; font-weight: 700; font-size: 16px; background: var(--c-avatar-0);
  }
  .avatar img { width: 100%; height: 100%; object-fit: cover; }
  .qui { min-width: 0; }
  .nom { margin: 0; font-weight: 700; font-size: 15px; }
  .sous-titre { margin: 2px 0 0; font-size: 13px; color: var(--c-carte-discret); }
  .texte { margin: 12px 0 0; font-size: 15px; line-height: 1.5; white-space: pre-line; }
  .texte.replie { display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 7; line-clamp: 7; overflow: hidden; }
  .suite { margin: 6px 0 0; padding: 4px 0; border: 0; background: none; color: var(--c-violet); font: 600 14px/1.2 var(--f-texte); cursor: pointer; }
  .suite:focus-visible { outline: 2px solid var(--c-violet); outline-offset: 2px; border-radius: 4px; }
  .photo { display: block; width: 100%; max-height: 560px; object-fit: cover; margin-top: 12px; border-radius: 10px; background: var(--c-carte-filet); }
  .pied {
    display: flex; flex-wrap: wrap; align-items: center; gap: 8px 12px; margin-top: 12px; padding-top: 10px;
    border-top: 1px solid var(--c-carte-filet); font-size: 13px; color: var(--c-carte-discret);
  }
  .meta { flex: 1; }
  .lien { color: var(--c-violet); font-weight: 600; }
  .sponsor { display: inline-flex; align-items: center; gap: 8px; }
  .badge { padding: 2px 8px; border-radius: 999px; background: var(--c-violet); color: #fff; font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: .06em; }
  .logo { max-height: 24px; max-width: 96px; }
  .vide, .etat { text-align: center; opacity: .85; }
  .etat:empty { display: none; }
  .etat { margin: 0 0 16px; font-size: 14px; }

  /* Phones: a tighter header, the buttons as a two-column grid of full-width targets. */
  /*
   * Phones: the header stays under a third of the screen — the posts are the
   * page. The networks become round icons (their name stays in « aria-label »),
   * « Copier » joins them on one row: the hashtag is already right above.
   */
  @media (max-width: 560px) {
    :root { --ecart: 12px; }
    header.entete { padding: 14px 0 14px; }
    .surtitre { font-size: 11px; letter-spacing: .14em; }
    h1 { margin-top: 4px; font-size: 26px; }
    .hashtag { margin-top: 8px; padding: 4px 12px; font-size: 16px; }
    .invite { margin-top: 8px; font-size: 14px; line-height: 1.4; }
    .boutons { gap: 8px; margin-top: 12px; }
    .bouton:not(.discret) { flex: none; width: 44px; padding: 0; }
    .bouton .nom-reseau, .bouton .tag { display: none; }
    .bouton.discret { padding: 0 14px; }
    .carte { padding: 14px; border-radius: 14px; }
  }
</style>
</head>
<body>
<div class="page">
  ${barre(data)}
  <header class="entete">
    <p class="surtitre">Le mur social</p>
    <h1>${nom}</h1>
    ${hashtag == null ? '' : `<span class="hashtag">#${escapeHtml(hashtag)}</span>`}
    ${accroche == null ? '' : `<p class="invite">${accroche}</p>`}
    ${hashtag == null ? '' : `<div class="boutons">
      ${boutons(hashtag, data.reseaux.filter((reseau) => reseaux.includes(reseau)))}
    </div>`}
  </header>
  <p class="etat" id="etat" role="status" aria-live="polite"></p>
  <main class="mur" id="mur" aria-label="Publications"></main>
  <p class="vide" id="suite" aria-hidden="true" hidden>Chargement des publications suivantes…</p>
  <p class="vide" id="vide" hidden>Rien encore sur le mur : soyez la première ou le premier à publier.</p>
  <noscript><p class="vide">Cette page a besoin de JavaScript pour afficher les publications.</p></noscript>
</div>
<script id="donnees" type="application/json">${json}</script>
<script>${SCRIPT}</script>
</body>
</html>
`
}
