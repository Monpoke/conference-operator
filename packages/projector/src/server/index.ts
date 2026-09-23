/**
 * What the servers of the page share — the room machine that projects it, the
 * hub that previews it: the loop's content resolved for the screen, the other
 * rooms, the typefaces, and the document itself.
 */
export { boucleQrUrls, buildBoucleView, wallsIoSrc, type BoucleSources } from './boucle-view.js'
export { otherRoomsFor } from './other-rooms.js'
export { planningsFor } from './plannings.js'
export {
  availableFonts,
  fontFaces,
  LOOP_FONTS,
  readFont,
  resolveFontsFolder,
  type AvailableFont,
  type FontFamily,
} from './fonts.js'
export { renderProjectorDocument, type ProjectorDocumentOptions } from './page.js'
