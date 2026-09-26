import type { VodClip, VodHabillage } from '@conference-operator/contract'
import { PROJECTOR_CSS } from '../generated/projector.js'
import { VOD_CSS, VOD_JS } from '../generated/vod.js'
import { decorMarkup } from '../markup.js'
import { fontFaces, type AvailableFont } from './fonts.js'

export interface VodDocumentOptions {
  clip: VodClip
  habillage: VodHabillage
  /** The typefaces present, and where they are served from (or data URIs). */
  fonts?: { base: string; files: AvailableFont[] }
  /**
   * `true`: nothing plays on its own, the renderer sets each frame's instant
   * through `window.__vod.figer(ms)`. `false`: the console's preview, played
   * and replayed.
   */
  capture?: boolean
}

/**
 * The intro or the outro of a talk, as one standalone document.
 *
 * Served by the hub as a preview in the console, and loaded by the montage
 * worker to be captured frame by frame: what the organiser checks is what goes
 * into the video.
 */
export function renderVodDocument(options: VodDocumentOptions): string {
  const donnees = JSON.stringify({ clip: options.clip, habillage: options.habillage }).replace(/</g, '\\u003c')
  const fonts = options.fonts == null ? '' : fontFaces(options.fonts.files, options.fonts.base)
  const capture = options.capture ? '<script>window.__VOD_CAPTURE__ = true</script>' : ''

  return `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${options.clip === 'intro' ? 'Intro' : 'Outro'} — ${escapeHtml(options.habillage.talk.title)}</title>
<style>
${fonts}
${PROJECTOR_CSS}
${VOD_CSS}
</style>
</head>
<body data-clip="${options.clip}">
<script id="vod-donnees" type="application/json">${donnees}</script>
<div id="stage">
${decorMarkup()}
  <div id="clip"></div>
  <div id="stinger"></div>
  <div id="noir"></div>
</div>
${capture}
<script>${VOD_JS}</script>
</body>
</html>`
}

const escapeHtml = (text: string) =>
  text.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)
