import { createHash } from 'node:crypto'
import type { MurPublic } from '@conference-operator/contract'
import { escapeHtml } from '@conference-operator/format'
import { variables } from './page.js'

/**
 * The words of the wall, as a cloud: `/mots`, a page of its own, linked from
 * nowhere. Counted here from the posts the hub already sends — nothing more to
 * ask of it — and drawn by the page itself, with no library: the page fetches
 * nothing but its own JSON.
 */

export interface Mot {
  mot: string
  n: number
}

/** How many words the cloud holds at most: past that, they are too small to read. */
export const MAX_MOTS = 200

/**
 * Words that say nothing on their own, French and English: without them, « une »,
 * « est » and « vos » would be the biggest words of any wall.
 */
const VIDES = new Set(
  `alors au aucun aussi autre aux avec avoir avant bon car ce cela ces cet cette ceux chaque chez ci comme comment dans de des donc dont du elle elles en encore entre est et étaient était été être eu eux fait faire faut il ils je la le les leur leurs lui là ma mais me même mes moi mon ne ni nos notre nous on ont ou où par pas peu peut plus pour pourquoi qu que quel quelle quelles quels qui sa sans se ses si sinon son sont sous sur ta te tes toi ton tous tout toute toutes très tu un une vos votre vous vu ça ici déjà après dès cest jai cest-à-dire via chez lors celui celle celles ceux sera seront serait avez avons étais sommes suis êtes vers voici voilà afin ainsi tant tel telle quand quoi rien tres
  the and for are but not you all any can had her was one our out has have this that with they from will your what when who which their there been were would about into than then them these some more also just only over such its it's i'm we're you're how why our out new get got use using via`
    .split(/\s+/)
    .filter(Boolean),
)

/**
 * The most frequent words of these posts, the most frequent first. Links go,
 * apostrophes cut (« l'IA » gives « ia »), hashtags keep their `#`; a word of
 * fewer than three letters, an empty word or a bare number other than a year
 * is left out.
 */
export function compterMots(posts: readonly { text: string }[], limite = MAX_MOTS): Mot[] {
  const comptes = new Map<string, number>()
  for (const post of posts) {
    const texte = post.text
      .toLowerCase()
      .replace(/https?:\/\/\S+/g, ' ')
      .replace(/[’'`]/g, ' ')
    for (const brut of texte.match(/#?[\p{L}\p{N}][\p{L}\p{N}_-]*/gu) ?? []) {
      const mot = brut.replace(/[-_]+$/, '')
      const nu = mot.startsWith('#') ? mot.slice(1) : mot
      if (nu.length < 3 || VIDES.has(mot)) continue
      if (/^\d+$/.test(nu) && !/^(19|20)\d\d$/.test(nu)) continue
      comptes.set(mot, (comptes.get(mot) ?? 0) + 1)
    }
  }
  return [...comptes]
    .map(([mot, n]) => ({ mot, n }))
    .sort((a, b) => b.n - a.n || a.mot.localeCompare(b.mot, 'fr'))
    .slice(0, limite)
}

/**
 * Lays the cloud out: the most frequent word in the middle, the others along a
 * spiral, each against the real shape of those already placed, some upright or
 * tilted. A word with no room left is tried again smaller, rather than dropped:
 * the event's hashtag must not go missing for being long. Laid again when the
 * window changes size, and when `/mots.json` says the words changed (asked every
 * minute).
 */
const SCRIPT = `(() => {
  const zone = document.getElementById('nuage')
  let mots = JSON.parse(document.getElementById('mots').textContent || '[]')
  let signature = JSON.stringify(mots)
  const hash = (s) => { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return Math.abs(h) }
  const CELLULE = 3
  const ANGLES = [0, 0, 0, 0, 0, 0, 90, -90, 90, -45, 45]
  const toile = document.createElement('canvas')
  const ctx = toile.getContext('2d', { willReadFrequently: true })
  // The word's real shape, in cells around its centre: a tilted word only takes
  // what its letters cover, and others can sit in the corners of its box.
  function forme(mot, px, angle, police) {
    const fonte = '600 ' + px + 'px ' + police
    ctx.font = fonte
    const cote = Math.ceil(Math.max(ctx.measureText(mot).width, px * 1.3)) + 8
    toile.width = toile.height = cote
    ctx.font = fonte
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.translate(cote / 2, cote / 2)
    ctx.rotate(angle * Math.PI / 180)
    ctx.fillText(mot, 0, 0)
    const pixels = ctx.getImageData(0, 0, cote, cote).data
    const cellules = new Set()
    for (let y = 0; y < cote; y++) {
      for (let x = 0; x < cote; x++) {
        if (pixels[(y * cote + x) * 4 + 3] < 64) continue
        const cx = Math.floor((x - cote / 2) / CELLULE), cy = Math.floor((y - cote / 2) / CELLULE)
        for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) cellules.add((cx + dx) + ',' + (cy + dy))
      }
    }
    return [...cellules].map((c) => c.split(',').map(Number))
  }
  function poser() {
    zone.replaceChildren()
    const W = zone.clientWidth, H = zone.clientHeight
    if (mots.length === 0 || W === 0 || H === 0) return
    const cols = Math.ceil(W / CELLULE), rows = Math.ceil(H / CELLULE)
    const grille = new Uint8Array(cols * rows)
    const police = getComputedStyle(zone).fontFamily
    const max = mots[0].n, min = mots[mots.length - 1].n
    const grand = Math.max(28, Math.min(W, H) / 5)
    const rapport = W / H
    const limite = Math.max(cols, rows)
    function trouver(cellules) {
      const libre = (x, y) => cellules.every(([dx, dy]) => {
        const cx = x + dx, cy = y + dy
        return cx >= 2 && cy >= 2 && cx < cols - 2 && cy < rows - 2 && !grille[cy * cols + cx]
      })
      for (let a = 0, r = 0; r < limite; a += 1.5 / Math.max(r, 1), r = 0.4 * a) {
        const x = Math.round(cols / 2 + r * Math.cos(a) * Math.max(1, rapport))
        const y = Math.round(rows / 2 + r * Math.sin(a) * Math.max(1, 1 / rapport))
        if (libre(x, y)) return [x, y]
      }
      return null
    }
    mots.forEach((m, i) => {
      const taille = 12 + (grand - 12) * Math.pow((m.n - min) / ((max - min) || 1), 0.85)
      // The longest big words stay flat: tilted, a hashtag would cross the whole cloud.
      const angle = i === 0 || (m.mot.length > 9 && taille > grand / 2) ? 0 : ANGLES[hash(m.mot) % ANGLES.length]
      for (const echelle of [1, 0.85, 0.7, 0.55, 0.42, 0.3]) {
        const px = Math.round(taille * echelle)
        if (px < 11) break
        const cellules = forme(m.mot, px, angle, police)
        const place = trouver(cellules)
        if (place == null) continue
        for (const [dx, dy] of cellules) grille[(place[1] + dy) * cols + place[0] + dx] = 1
        const span = document.createElement('span')
        span.className = 'mot'
        span.textContent = m.mot
        span.title = m.mot + ' : ' + m.n
        span.style.color = 'var(--mot-' + (hash(m.mot) % 10) + ')'
        span.style.fontSize = px + 'px'
        span.style.transform = 'translate(' + (place[0] * CELLULE) + 'px,' + (place[1] * CELLULE) + 'px) translate(-50%,-50%) rotate(' + angle + 'deg)'
        zone.append(span)
        return
      }
    })
  }
  let attente = null
  addEventListener('resize', () => { clearTimeout(attente); attente = setTimeout(poser, 200) })
  setInterval(async () => {
    try {
      const r = await fetch('/mots.json', { cache: 'no-cache' })
      if (!r.ok) return
      const suivants = await r.json()
      const s = JSON.stringify(suivants)
      if (s === signature) return
      mots = suivants
      signature = s
      poser()
    } catch {}
  }, 60000)
  ;(document.fonts ? document.fonts.ready : Promise.resolve()).then(poser)
})()`

export const MOTS_SCRIPT_HASH = `'sha256-${createHash('sha256').update(SCRIPT).digest('base64')}'`

/** As the wall's page: its own script, its own JSON, nothing else. */
export const MOTS_CONTENT_SECURITY_POLICY = [
  "default-src 'none'",
  `script-src ${MOTS_SCRIPT_HASH}`,
  "style-src 'unsafe-inline'",
  "img-src 'self'",
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ')

export function renderMots(data: MurPublic, mots: readonly Mot[]): string {
  const titre = `Les mots du mur — ${data.event.name}`
  // In a JSON script, `<` is the only character that could end it early.
  const json = JSON.stringify(mots).replace(/</g, '\\u003c')
  return `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${escapeHtml(titre)}</title>
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<style>
  :root {
    --c-nuit:#10121a; --c-creme:#f8f9fa; --c-violet:#3b5bdb; --c-magenta:#7048e8; --c-cyan:#15aabf; --c-orange:#fcc419;
    --f-texte:system-ui, sans-serif;
    ${variables(data.theme)}
    --mot-0:#5b6ce8; --mot-1:#3fc1b8; --mot-2:#f5a623; --mot-3:#9aa1a6; --mot-4:#1890ff;
    --mot-5:#37c978; --mot-6:#e0604f; --mot-7:#a78fd8; --mot-8:#c94f9f; --mot-9:#12a88f;
  }
  html, body { margin: 0; height: 100%; background: #fff; color: var(--c-nuit); font-family: var(--f-texte); }
  body { display: flex; flex-direction: column; }
  header { display: flex; align-items: baseline; justify-content: space-between; gap: 16px; flex-wrap: wrap; padding: 18px 24px 6px; }
  h1 { margin: 0; font-size: clamp(20px, 3vw, 32px); }
  header a { color: var(--c-nuit); font-weight: 700; }
  .hashtag { color: var(--c-violet); font-weight: 800; }
  #nuage { position: relative; flex: 1; margin: 8px 16px 16px; overflow: hidden; }
  .mot { position: absolute; left: 0; top: 0; white-space: nowrap; font-weight: 600; line-height: 1; cursor: default; }
  .sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); }
</style>
</head>
<body>
<header>
  <h1>Les mots du mur ${data.hashtag ? `<span class="hashtag">${escapeHtml(data.hashtag)}</span>` : ''}</h1>
  <a href="/">Retour au mur</a>
</header>
<main id="nuage" aria-label="Les mots les plus présents sur le mur, les plus fréquents en plus grand"></main>
<ol class="sr">${mots.slice(0, 30).map((m) => `<li>${escapeHtml(m.mot)} (${m.n})</li>`).join('')}</ol>
<script type="application/json" id="mots">${json}</script>
<script>${SCRIPT}</script>
</body>
</html>`
}
