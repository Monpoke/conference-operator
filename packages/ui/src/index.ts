/**
 * Styling shared by the standalone pages of the hub and of the rooms.
 *
 * The pages have no build step: they inline this sheet into a `<style>`, which
 * lets them use Tailwind while staying openable with no network, no CDN and no
 * bundler.
 */
export { TAILWIND_CSS } from './generated/styles.js'

export { flattenLayers, flattenLayersInHtml } from './layers.js'
