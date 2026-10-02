/**
 * What the servers of the page share — the room machine that projects it, the
 * hub that previews it: the loop's content resolved for the screen, the other
 * rooms, the typefaces, and the document itself.
 */
export { boucleQrUrls, buildBoucleView, buildWallCards, type BoucleSources } from './boucle-view.js'
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
export { DEFAULT_THEME } from './default-theme.js'
export {
  rebaseCss,
  rebaseSvg,
  themeDecor,
  themeFontFaces,
  themeOrDefault,
  themeOverlayFill,
  themeStyle,
  themeTokens,
  type ThemeSource,
} from './theme.js'
export {
  checkThemeCss,
  checkThemeSvg,
  parseThemePackage,
  readThemeFolder,
  resolveThemesFolder,
  shippedThemeFolders,
  THEME_FILE_TYPES,
  THEME_MAX_BYTES,
  themeFileType,
  ThemePackageError,
  themeSha,
  unzipTheme,
  zipTheme,
  type ThemeFiles,
} from './theme-package.js'
export { renderProjectorDocument, type ProjectorDocumentOptions } from './page.js'
export { renderVodDocument, type VodDocumentOptions } from './vod-page.js'
export { buildVodHabillage, type VodHabillageSources } from './vod-habillage.js'
