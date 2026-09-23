import { PROJECTOR_CSS, PROJECTOR_JS } from '../generated/projector.js'
import { projectorBody } from '../markup.js'
import { fontFaces, type AvailableFont } from './fonts.js'

export interface ProjectorDocumentOptions {
  /** The state embedded in the page, rendered before any connection. */
  initialPayload?: unknown
  /** The typefaces present, and where they are served from. */
  fonts?: { base: string; files: AvailableFont[] }
  /** CSS added after the page's own — the room's OBS rules. */
  css?: string
  /** Scripts run before the page's — the room's OBS and stream helpers. */
  scripts?: string[]
  /** Script run after the page has started — the hub's preview freezes a scene. */
  after?: string
  /** `true`: no stream, the embedded state is all there is (previews). */
  preview?: boolean
}

/**
 * The projected page, as one standalone document.
 *
 * Served by the room machine to OBS, and by the hub as a preview in its console:
 * the same markup, stylesheet and script in both — what the organiser checks on
 * the hub is what the room will project.
 */
export function renderProjectorDocument(options: ProjectorDocumentOptions = {}): string {
  const initialState =
    options.initialPayload == null
      ? ''
      : `<script id="etat-initial" type="application/json">${JSON.stringify(options.initialPayload).replace(/</g, '\\u003c')}</script>`
  const fonts = options.fonts == null ? '' : fontFaces(options.fonts.files, options.fonts.base)
  const scripts = (options.scripts ?? []).map((script) => `<script>${script}</script>`).join('\n')
  const preview = options.preview ? '<script>window.__PREVIEW__ = true</script>' : ''
  const after = options.after ? `<script>${options.after}</script>` : ''

  return `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Écran de salle</title>
<style>
${fonts}
${PROJECTOR_CSS}
${options.css ?? ''}
</style>
</head>
<body data-mode="loop" data-connectivity="OFFLINE">
${initialState}
${projectorBody()}
${preview}
${scripts}
<script>${PROJECTOR_JS}</script>
${after}
</body>
</html>`
}
