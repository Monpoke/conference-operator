/**
 * The room's projected page: the reference welcome loop, fed by the hub.
 *
 * The browser code and the stylesheet are compiled into constants
 * (`src/generated/projector.ts`, `pnpm --filter @conference-operator/projector build`),
 * inlined into a page that must hold with no build step and no network.
 */
export { PROJECTOR_CSS, PROJECTOR_JS } from './generated/projector.js'
export { projectorBody } from './markup.js'
export { SCENE_IDS, BOUCLE } from './browser/sequence.js'
export { INTRO_MS, OUTRO_MS } from './vod/timeline.js'
