import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { VignetteClaim } from '@conference-operator/contract'
import { VIGNETTE, VIGNETTE_PLAYLIST, vignetteHtml, vignettePlaylistHtml } from '@conference-operator/projector/server'
import type { Chrome } from './chrome.js'
import { asDataUri } from './images.js'
import { themeForCapture } from './theme.js'

export const VIGNETTE_PLAYLIST_CLE = 'playlist'
/** Under YouTube's limit for a thumbnail, whatever the photos. */
const JPEG_QUALITY = 90

/** An image that cannot be had leaves its place empty: a thumbnail is worth having without a photo. */
const inline = async (ref: string | null): Promise<string | null> => {
  if (ref == null) return null
  return asDataUri(ref).catch(() => null)
}

/** The page of a thumbnail, its images inlined: nothing is fetched during the capture. */
export async function vignettePage(claim: VignetteClaim, workDir: string): Promise<{ html: string; size: { width: number; height: number; scale: number } }> {
  const { habillage, lieu } = claim
  const theme = await themeForCapture(habillage.theme, workDir)
  const logoUrl = await inline(habillage.event.logoUrl)
  if (claim.cle === VIGNETTE_PLAYLIST_CLE) {
    return {
      size: VIGNETTE_PLAYLIST,
      html: vignettePlaylistHtml({ eventName: habillage.event.name, logoUrl, date: habillage.event.date, lieu, theme }),
    }
  }
  const speakers = await Promise.all(habillage.speakers.map(async (person) => ({ name: person.name, photoUrl: await inline(person.photoUrl) })))
  return {
    size: VIGNETTE,
    html: vignetteHtml({ habillage: { ...habillage, event: { ...habillage.event, logoUrl } }, title: habillage.talk.title, speakers, theme }),
  }
}

/** Draws a thumbnail; its JPEG, as base64. */
export async function renderVignette(options: { chrome: Chrome; claim: VignetteClaim; workDir: string }): Promise<string> {
  const { html, size } = await vignettePage(options.claim, options.workDir)
  const page = join(options.workDir, 'vignette.html')
  await writeFile(page, html, 'utf8')
  const { cdp } = options.chrome
  const { targetId, sessionId } = await cdp.tab('about:blank')
  try {
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: size.width, height: size.height, deviceScaleFactor: size.scale, mobile: false }, sessionId)
    await cdp.send('Page.enable', {}, sessionId)
    await cdp.send('Page.navigate', { url: pathToFileURL(page).href }, sessionId)
    const deadline = Date.now() + 30_000
    while ((await cdp.evaluate<boolean>(sessionId, `document.readyState === 'complete'`).catch(() => false)) !== true) {
      if (Date.now() > deadline) throw new Error('La page de la vignette ne s’est pas chargée en 30 s')
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    await cdp.evaluate(sessionId, 'document.fonts.ready.then(() => true)')
    const { data } = await cdp.send<{ data: string }>('Page.captureScreenshot', { format: 'jpeg', quality: JPEG_QUALITY }, sessionId)
    return data
  } finally {
    await cdp.send('Target.closeTarget', { targetId }).catch(() => undefined)
  }
}
