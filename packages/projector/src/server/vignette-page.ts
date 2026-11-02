import type { VodHabillage } from '@conference-operator/contract'
import { themeDecor, themeStyle, type ThemeSource } from './theme.js'

/**
 * A video's thumbnail, or its playlist's: the theme's decor and very few words,
 * large enough to be read at the size YouTube lists them.
 *
 * Here so that the console's preview is the page the worker captures.
 */
const escapeHtml = (text: string): string =>
  text.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!)

/** Drawn at this size, captured smaller: 1280×720 is what YouTube asks. */
export const VIGNETTE = { width: 1920, height: 1080, scale: 2 / 3 }
export const VIGNETTE_PLAYLIST = VIGNETTE

/** The longer the title, the smaller: it never overflows, and it stays large. */
export function vignetteTitleSize(title: string): number {
  const length = title.length
  if (length <= 28) return 148
  if (length <= 50) return 122
  if (length <= 80) return 100
  return 80
}

const BASE = `
  html, body { margin: 0; overflow: hidden; color: #fff; }
  #stage { position: relative; overflow: hidden; box-sizing: border-box; display: flex; flex-direction: column; background: var(--degrade); }
  #decor { position: absolute; inset: 0; z-index: 0; overflow: hidden; }
  #stage > :not(#decor) { position: relative; z-index: 1; }
  .evenement { display: flex; align-items: center; gap: 28px; font: 800 44px/1.1 var(--f-texte, system-ui, sans-serif); }
  .evenement img { height: 92px; max-width: 460px; object-fit: contain; }
  .date { font: 700 44px/1.1 var(--f-texte, system-ui, sans-serif); white-space: nowrap; }
  .evenement .date { padding-left: 28px; border-left: 4px solid rgba(255,255,255,.55); }
`

export function vignetteHtml(options: { habillage: VodHabillage; title: string; speakers: readonly { name: string; photoUrl: string | null }[]; theme: ThemeSource | null }): string {
  const { habillage, title, speakers } = options
  const shown = speakers.slice(0, 3)
  const faces = shown
    .map((person) => `<div class="personne">${person.photoUrl == null ? `<div class="photo vide">${escapeHtml(person.name.slice(0, 1))}</div>` : `<img class="photo" src="${escapeHtml(person.photoUrl)}" alt="">`}<span>${escapeHtml(person.name)}</span></div>`)
    .join('')
  return `<!doctype html><html lang="fr"><head><meta charset="utf-8"><style>
${themeStyle(options.theme)}
${BASE}
#stage { width: ${VIGNETTE.width}px; height: ${VIGNETTE.height}px; padding: 72px 96px; }
h1 { margin: auto 0; font: 900 ${vignetteTitleSize(title)}px/1.08 var(--f-titre, var(--f-texte, system-ui, sans-serif)); text-wrap: balance; text-shadow: 0 6px 30px rgba(0,0,0,.35); }
.gens { display: flex; flex-wrap: wrap; gap: 28px 56px; }
.personne { display: flex; align-items: center; gap: 24px; font: 800 ${shown.length > 2 ? 40 : 54}px/1.1 var(--f-texte, system-ui, sans-serif); }
.photo { width: ${shown.length > 2 ? 104 : 148}px; height: ${shown.length > 2 ? 104 : 148}px; flex: none; border-radius: 50%; object-fit: cover; border: 6px solid #fff; box-sizing: border-box; }
.photo.vide { display: grid; place-items: center; background: rgba(255,255,255,.18); }
</style></head><body><div id="stage">${themeDecor(options.theme)}
<div class="evenement">${habillage.event.logoUrl == null ? escapeHtml(habillage.event.name) : `<img src="${escapeHtml(habillage.event.logoUrl)}" alt="${escapeHtml(habillage.event.name)}">`}${habillage.event.date == null ? '' : `<span class="date">${escapeHtml(habillage.event.date)}</span>`}</div>
<h1>${escapeHtml(title)}</h1>
<div class="gens">${faces}</div>
</div></body></html>`
}

/** The logo says the event: the image adds when and where, and no name twice. */
export function vignettePlaylistHtml(options: { eventName: string; logoUrl: string | null; date: string | null; lieu: string | null; theme: ThemeSource | null }): string {
  const { date, lieu } = options
  return `<!doctype html><html lang="fr"><head><meta charset="utf-8"><style>
${themeStyle(options.theme)}
${BASE}
#stage { width: ${VIGNETTE_PLAYLIST.width}px; height: ${VIGNETTE_PLAYLIST.height}px; padding: 90px; align-items: center; justify-content: center; text-align: center; gap: 44px; }
#stage img { max-width: 1000px; max-height: 340px; object-fit: contain; }
h1 { margin: 0; font: 900 ${(date ?? '').length <= 16 ? 112 : 92}px/1.08 var(--f-titre, var(--f-texte, system-ui, sans-serif)); text-wrap: balance; text-shadow: 0 6px 30px rgba(0,0,0,.35); }
.lieu { margin: 0; font: 700 60px/1.15 var(--f-texte, system-ui, sans-serif); text-wrap: balance; }
</style></head><body><div id="stage">${themeDecor(options.theme)}
${options.logoUrl == null ? `<h1>${escapeHtml(options.eventName)}</h1>` : `<img src="${escapeHtml(options.logoUrl)}" alt="${escapeHtml(options.eventName)}">`}
${date == null ? '' : `<h1>${escapeHtml(date)}</h1>`}
${lieu == null ? '' : `<p class="lieu">${escapeHtml(lieu)}</p>`}
</div></body></html>`
}
