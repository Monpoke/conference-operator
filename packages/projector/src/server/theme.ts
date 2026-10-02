import { THEME_COULEURS, THEME_POLICES, type BulleTheme, type ThemeBundle } from '@conference-operator/contract'
import { DEFAULT_THEME } from './default-theme.js'

/**
 * A theme, rendered into the pages that wear it: the loop, the VOD's intro and
 * outro, the capture overlay.
 *
 * The stylesheets only ever say `var(--violet)`, `var(--f-titre)`; the values
 * are declared here, on `:root`, before them. A theme package sets some tokens
 * and the default theme the rest — so a package written for this version keeps
 * working when a later one adds a token.
 */

/** A theme and the address its files (fonts, images) are served from. */
export interface ThemeSource {
  bundle: ThemeBundle
  /** The package's sha, when it is one: the page says which theme it wears, and reloads when told another. */
  sha?: string
  /** No trailing slash: `/display/theme/<sha>`, `file:///…/themes/cloudnord`. */
  base: string
}

/** The theme to wear: the one given, or the default. */
export const themeOrDefault = (theme: ThemeSource | null | undefined): ThemeSource =>
  theme ?? { bundle: DEFAULT_THEME, base: '' }

const rgb = (hex: string): string =>
  [1, 3, 5].map((start) => Number.parseInt(hex.slice(start, start + 2), 16)).join(', ')

/** A path of the package, as the page fetches it. */
const fileUrl = (base: string, path: string): string =>
  `${base}/${path.split('/').map(encodeURIComponent).join('/')}`

/** A relative address of the package's CSS or SVG, made absolute; anything else is left alone. */
const isPackagePath = (value: string): boolean => !/^(?:[a-z][a-z0-9+.-]*:|\/|#)/i.test(value)

/** `url(images/x.png)` in the theme's own stylesheet, pointed at where the package is served. */
export function rebaseCss(css: string, base: string): string {
  return css.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/g, (whole, _quote: string, path: string) =>
    isPackagePath(path.trim()) ? `url("${fileUrl(base, path.trim())}")` : whole,
  )
}

/** `href="images/x.png"` in the theme's SVG, pointed at where the package is served. */
export function rebaseSvg(svg: string, base: string): string {
  return svg.replace(/\b((?:xlink:)?href)\s*=\s*(["'])([^"']*)\2/g, (whole, attribute: string, quote: string, path: string) =>
    isPackagePath(path.trim()) ? `${attribute}=${quote}${fileUrl(base, path.trim())}${quote}` : whole,
  )
}

/**
 * The theme's `:root`: every colour token (and its `-rgb` triplet), the stage's
 * background and the font stacks — the theme's, else the default's.
 */
export function themeTokens(bundle: ThemeBundle): string {
  const defaults = DEFAULT_THEME.manifest
  const { manifest } = bundle
  const lines: string[] = []
  for (const name of THEME_COULEURS) {
    const value = (manifest.couleurs[name] ?? defaults.couleurs[name]!).toLowerCase()
    lines.push(`  --${name}: ${value};`, `  --${name}-rgb: ${rgb(value)};`)
  }
  lines.push(`  --degrade: ${manifest.fond ?? defaults.fond!};`)
  for (const role of THEME_POLICES) {
    lines.push(`  --f-${role}: ${manifest.polices.roles[role] ?? defaults.polices.roles[role]!};`)
  }
  return `:root {\n${lines.join('\n')}\n}`
}

/** The `@font-face` rules of the package's own typefaces. */
export function themeFontFaces(theme: ThemeSource): string {
  return theme.bundle.manifest.polices.fichiers
    .map((font) => {
      const extension = font.fichier.slice(font.fichier.lastIndexOf('.') + 1).toLowerCase()
      const format = { woff2: 'woff2', woff: 'woff', otf: 'opentype', ttf: 'truetype' }[extension]
      return `@font-face { font-family: "${font.famille}"; font-weight: ${font.graisse}; font-style: ${font.style}; ` +
        `font-display: block; src: local("${font.famille}"), url("${fileUrl(theme.base, font.fichier)}") format("${format}"); }`
    })
    .join('\n')
}

/** Everything the theme adds to a page's stylesheet: tokens, typefaces, its own CSS. */
export function themeStyle(theme: ThemeSource | null | undefined): string {
  const source = themeOrDefault(theme)
  return [themeTokens(source.bundle), themeFontFaces(source), rebaseCss(source.bundle.css, source.base)]
    .filter(Boolean)
    .join('\n')
}

const bulle = (b: BulleTheme): string =>
  `    <i class="bulle" style="left:${b.x}px; top:${b.y}px; width:${b.taille}px; height:${b.taille}px; --d:${b.duree}s` +
  `${b.delai ? `; --delai:${b.delai}s` : ''}"></i>`

/**
 * The stage's decor — the theme's SVG and its floating bubbles. The VOD's intro
 * and outro sit on the same backdrop the room projected.
 */
export function themeDecor(theme: ThemeSource | null | undefined): string {
  const source = themeOrDefault(theme)
  const { bundle } = source
  const svg = bundle.decor == null ? '' : `    ${rebaseSvg(bundle.decor.trim(), source.base)}\n`
  const bulles = bundle.manifest.decor.bulles.map(bulle).join('\n')
  return `  <div id="decor" aria-hidden="true">\n${svg}${bulles}${bulles ? '\n' : ''}  </div>`
}

/**
 * What fills the capture overlay around its two holes: the theme's own, else
 * the default frame — glows, stripes, rings and dots — in the theme's colours.
 */
export function themeOverlayFill(theme: ThemeSource | null | undefined): string {
  const source = themeOrDefault(theme)
  return source.bundle.overlay == null ? DEFAULT_OVERLAY_FILL : rebaseSvg(source.bundle.overlay.trim(), source.base)
}

const DEFAULT_OVERLAY_FILL = `<defs>
      <linearGradient id="gBg" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" style="stop-color: var(--overlay-fond-1)"/>
        <stop offset=".45" style="stop-color: var(--overlay-fond-2)"/>
        <stop offset="1" style="stop-color: var(--overlay-fond-3)"/>
      </linearGradient>
      <linearGradient id="gAccentV" x1="0" y1="1" x2="1" y2="0">
        <stop offset="0" style="stop-color: var(--overlay-1)"/>
        <stop offset="1" style="stop-color: var(--overlay-accent)"/>
      </linearGradient>
      <radialGradient id="gGlow" cx=".5" cy=".5" r=".5">
        <stop offset="0" style="stop-color: var(--overlay-2)" stop-opacity=".45"/>
        <stop offset="1" style="stop-color: var(--overlay-2)" stop-opacity="0"/>
      </radialGradient>
      <pattern id="stripes" width="28" height="28" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
        <rect width="10" height="28" style="fill: var(--overlay-rayures)"/>
      </pattern>
      <clipPath id="cTL"><circle cx="70" cy="40" r="150"/></clipPath>
      <clipPath id="cBR"><circle cx="1890" cy="1070" r="115"/></clipPath>
    </defs>
    <rect width="1920" height="1080" fill="url(#gBg)"/>
    <circle cx="300" cy="120" r="420" fill="url(#gGlow)"/>
    <circle cx="1700" cy="980" r="480" fill="url(#gGlow)"/>
    <rect x="-100" y="-120" width="340" height="320" fill="url(#stripes)" clip-path="url(#cTL)" opacity=".9"/>
    <rect x="1680" y="880" width="340" height="320" fill="url(#stripes)" clip-path="url(#cBR)" opacity=".9"/>
    <circle cx="1850" cy="20" r="110" fill="url(#gAccentV)"/>
    <ellipse cx="1830" cy="40" rx="190" ry="95" fill="none" style="stroke: var(--overlay-accent)" stroke-width="3" opacity=".7" transform="rotate(20 1830 40)"/>
    <circle cx="10" cy="1075" r="70" fill="url(#gAccentV)"/>
    <circle cx="40" cy="1080" r="120" fill="none" style="stroke: var(--overlay-1)" stroke-width="2" opacity=".5"/>
    <circle cx="330" cy="1040" r="16" fill="url(#gAccentV)"/>
    <circle cx="235" cy="1050" r="10" fill="url(#gAccentV)"/>
    <circle cx="1620" cy="1040" r="12" fill="url(#gAccentV)"/>
    <circle cx="1690" cy="95" r="14" fill="url(#gAccentV)"/>
    <circle cx="260" cy="95" r="9" fill="url(#gAccentV)"/>`
