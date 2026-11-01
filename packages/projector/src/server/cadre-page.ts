import type { VodHabillage } from '@conference-operator/contract'
import { themeOrDefault, themeOverlayFill, themeTokens, type ThemeSource } from './theme.js'

/**
 * The talk's card, drawn again when a take's dressing was set in the console.
 *
 * Here so that the console's preview is the page the worker captures. Copied from
 * the room's `overlay-page.ts`, not imported: the worker's image does not carry
 * the room's. Same geometry, same type sizes.
 */

const escapeHtml = (text: string): string =>
  text.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!)

/** The card on the overlay's 1920×1080 canvas (`CARD` in `overlay-page.ts`). */
export const CADRE_CARD = { x: 1510, y: 560, w: 370, h: 415 }
/** A margin around the card: its rounded corners sit on the decor. */
export const CADRE_MARGIN = 4

export function cadreHtml(options: { habillage: VodHabillage; salle: string | null; theme: ThemeSource | null }): string {
  const { habillage, salle } = options
  const several = habillage.speakers.length > 1
  const people = habillage.speakers
    .map((person) => `<div><div class="name">${escapeHtml(person.name)}</div>${person.company ? `<div class="company">${escapeHtml(person.company)}</div>` : ''}</div>`)
    .join('')
  return `<!doctype html><html lang="fr"><head><meta charset="utf-8"><style>
${themeTokens(themeOrDefault(options.theme).bundle)}
:root { --c1: var(--overlay-1); --c2: var(--overlay-2); --muted: var(--overlay-discret); }
html, body { margin: 0; width: 1920px; height: 1080px; overflow: hidden; background: transparent; }
#bg { position: absolute; left: 0; top: 0; }
body { font-family: "Liberation Sans", Arial, sans-serif; color: #fff; }
#card { position: absolute; left: ${CADRE_CARD.x}px; top: ${CADRE_CARD.y}px; box-sizing: border-box; width: ${CADRE_CARD.w}px; height: ${CADRE_CARD.h}px; padding: 28px 30px; display: flex; flex-direction: column; overflow: hidden;
  border-radius: 22px; background: rgba(var(--overlay-carte-rgb), .72); border: 2px solid rgba(var(--overlay-2-rgb), .55); box-shadow: 0 0 30px rgba(var(--overlay-2-rgb), .25) inset; }
#head { display: flex; align-items: center; justify-content: space-between; gap: 10px; min-height: 26px; margin-right: -22px; }
#label { font-size: 18px; font-weight: 700; letter-spacing: 3px; text-transform: uppercase;
  background: linear-gradient(90deg, var(--c1), var(--c2)); -webkit-background-clip: text; background-clip: text; color: transparent; }
#people { display: flex; flex-direction: column; gap: 12px; margin-top: 10px; }
.name { font-size: calc(${several ? 28 : 36}px * var(--fit, 1)); font-weight: 900; line-height: 1.1; }
.company { font-size: calc(${several ? 19 : 22}px * var(--fit, 1)); color: var(--muted); margin-top: ${several ? 2 : 6}px; line-height: 1.3; }
#sep { height: 3px; width: 80px; flex: none; border-radius: 2px; margin: 18px 0; background: linear-gradient(90deg, var(--c1), var(--c2)); }
#title { font-size: calc(28px * var(--fit, 1)); font-weight: 700; line-height: 1.25; flex: none; }
#category { flex: none; padding: 3px 7px; border-radius: 6px; font-size: 12px; letter-spacing: 1px; text-transform: uppercase; background: ${habillage.talk.color ?? 'var(--c2)'}; white-space: nowrap; }
#room { margin-top: auto; padding-top: 14px; font-size: 20px; font-weight: 500; color: var(--muted); }
</style></head><body><svg id="bg" width="1920" height="1080" viewBox="0 0 1920 1080" xmlns="http://www.w3.org/2000/svg">${themeOverlayFill(options.theme)}</svg><div id="card"><div id="head"><div id="label">${several ? 'Speakers' : 'Speaker'}</div>${habillage.talk.category ? `<span id="category">${escapeHtml(habillage.talk.category)}</span>` : ''}</div>
<div id="people">${people}</div><div id="sep"></div><div id="title">${escapeHtml(habillage.talk.title)}</div>${salle ? `<div id="room">${escapeHtml(salle)}</div>` : ''}</div>
<script>
const card = document.getElementById('card'); let fit = 1
while (fit > 0.6 && card.scrollHeight > card.clientHeight + 1) { fit = Math.round((fit - 0.05) * 100) / 100; card.style.setProperty('--fit', String(fit)) }
</script></body></html>`
}
