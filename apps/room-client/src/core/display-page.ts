import { renderProjectorDocument, type AvailableFont } from '@conference-operator/projector/server'

import { OBS_ON_AIR_CSS, OBS_ON_AIR_JS } from './obs-browser.js'
import { STREAM_PATCH_JS } from './stream-patch.js'

/**
 * The page projected in the room.
 *
 * The constraints that explain its shape: it is rendered by OBS-A's Browser
 * Source (or an Electron fallback window), must hold with no build step, no
 * network, and stay readable from ten metres away. Hence standalone HTML, an
 * `EventSource` that reconnects by itself, and no external dependency — not
 * even the typefaces, which the room serves itself.
 *
 * The design is the reference welcome loop (`@conference-operator/projector`):
 * a fixed 1920×1080 stage scaled to the window, which is what keeps the type
 * the same size on a 1024×768 projector and on a 4K one. Every screen the room
 * shows — the loop and what the operator puts up — lives on that stage. The hub
 * renders the same document as a preview in its console.
 *
 * **One exception to "no network"**, and only one: the walls.io wall, an iframe,
 * shown only while the room's server says walls.io answers.
 */
export interface ProjectorPageOptions {
  /**
   * The state embedded in the page, rendered before any connection.
   *
   * Avoids the blank screen between the load and the first SSE message — visible
   * in the room on every reload of the Browser Source. Also serves to produce an
   * offline preview strictly identical to the real page.
   */
  initialPayload?: unknown
  /** The typefaces present on the machine, and where they are served from. */
  fonts?: { base: string; files: AvailableFont[] }
}

export function renderProjectorPage(options: ProjectorPageOptions = {}): string {
  return renderProjectorDocument({
    ...options,
    css: OBS_ON_AIR_CSS,
    scripts: [
      // The OBS scene's state, before everything else: the page must know whether
      // it is on air from its very first frame, not after the first scene change.
      OBS_ON_AIR_JS,
      // How the stream's partial messages merge into the state held by the page.
      `window.applyStreamPatch = (() => { ${STREAM_PATCH_JS}; return applyStreamPatch })()`,
    ],
  })
}
