import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { VodHabillage } from '@conference-operator/contract'
import { themeOrDefault, themeOverlayFill, themeTokens, type ThemeSource } from '@conference-operator/projector/server'
import type { Chrome } from './chrome.js'
import type { CadrePlan } from './montage.js'

/**
 * The talk's card, drawn again when the speakers were corrected after the take.
 *
 * The room's overlay is burnt into the rush, so a wrong name can only be covered:
 * the whole card is captured here, on the theme's own decor, and laid over the
 * old one. Wiping the text and keeping the rush's background was tried first: the
 * rebuilt background came out lighter than the card, and it showed.
 *
 * Copied from the room's `overlay-page.ts`, not imported: apps share no code, and
 * the worker's image does not carry the room's. Same geometry, same type sizes.
 */

const escapeHtml = (text: string): string =>
  text.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!)

/** The card on the overlay's 1920×1080 canvas (`CARD` in `overlay-page.ts`). */
const CARD = { x: 1510, y: 560, w: 370, h: 415 }
/** A margin around the card: its rounded corners sit on the decor. */
const MARGIN = 4

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
#card { position: absolute; left: ${CARD.x}px; top: ${CARD.y}px; box-sizing: border-box; width: ${CARD.w}px; height: ${CARD.h}px; padding: 28px 30px; display: flex; flex-direction: column; overflow: hidden;
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

/** Where the card falls in a rush of this width: the overlay scales with its source. */
export function cadrePlacement(takeWidth: number, file: string): CadrePlan {
  const scale = takeWidth / 1920
  return { file, x: Math.round((CARD.x - MARGIN) * scale), y: Math.round((CARD.y - MARGIN) * scale) }
}

/** The card and the decor around it, at the rush's own scale. */
export async function renderCadre(options: {
  chrome: Chrome
  habillage: VodHabillage
  salle: string | null
  theme: ThemeSource | null
  takeWidth: number
  workDir: string
}): Promise<CadrePlan> {
  const page = join(options.workDir, 'cadre.html')
  const file = join(options.workDir, 'cadre.png')
  await writeFile(page, cadreHtml(options), 'utf8')
  const { cdp } = options.chrome
  const { targetId, sessionId } = await cdp.tab('about:blank')
  try {
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1920, height: 1080, deviceScaleFactor: options.takeWidth / 1920, mobile: false }, sessionId)
    await cdp.send('Page.enable', {}, sessionId)
    await cdp.send('Page.navigate', { url: pathToFileURL(page).href }, sessionId)
    const deadline = Date.now() + 30_000
    while ((await cdp.evaluate<boolean>(sessionId, `document.readyState === 'complete'`).catch(() => false)) !== true) {
      if (Date.now() > deadline) throw new Error('La page du cadre ne s’est pas chargée en 30 s')
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    await cdp.evaluate(sessionId, 'document.fonts.ready.then(() => true)')
    const { data } = await cdp.send<{ data: string }>('Page.captureScreenshot', {
      format: 'png',
      clip: { x: CARD.x - MARGIN, y: CARD.y - MARGIN, width: CARD.w + 2 * MARGIN, height: CARD.h + 2 * MARGIN, scale: 1 },
    }, sessionId)
    await writeFile(file, Buffer.from(data, 'base64'))
  } finally {
    await cdp.send('Target.closeTarget', { targetId }).catch(() => undefined)
  }
  return cadrePlacement(options.takeWidth, file)
}
