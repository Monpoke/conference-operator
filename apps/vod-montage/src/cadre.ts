import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { VodHabillage } from '@conference-operator/contract'
import { CADRE_CARD as CARD, CADRE_MARGIN as MARGIN, cadreHtml, type ThemeSource } from '@conference-operator/projector/server'
import type { Chrome } from './chrome.js'
import type { CadrePlan } from './montage.js'

/**
 * The take's card, captured over the old one.
 *
 * The room's overlay is burnt into the rush, so a wrong name can only be covered:
 * the whole card is captured, on the theme's own decor, and laid over the old one.
 * Wiping the text and keeping the rush's background was tried first: the rebuilt
 * background came out lighter than the card, and it showed.
 */

export { cadreHtml }

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
