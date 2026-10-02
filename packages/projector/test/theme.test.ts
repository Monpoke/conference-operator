import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { strToU8 } from 'fflate'
import { THEME_COULEURS } from '@conference-operator/contract'
import {
  DEFAULT_THEME,
  parseThemePackage,
  readThemeFolder,
  renderProjectorDocument,
  renderVodDocument,
  themeDecor,
  themeSha,
  ThemePackageError,
  themeStyle,
  themeTokens,
  unzipTheme,
  zipTheme,
  type ThemeFiles,
} from '../src/server/index.js'
import { PROJECTOR_CSS } from '../src/generated/projector.js'
import { VOD_CSS } from '../src/generated/vod.js'

const CLOUDNORD = join(import.meta.dirname, '..', '..', '..', 'themes', 'cloudnord')

const files = (entries: Record<string, string>): ThemeFiles =>
  new Map(Object.entries(entries).map(([path, text]) => [path, strToU8(text)]))
const manifest = (extra: object = {}) => JSON.stringify({ apiVersion: 1, id: 'essai', nom: 'Essai', ...extra })
const problems = (package_: ThemeFiles): string[] => {
  try {
    parseThemePackage(package_)
  } catch (error) {
    if (error instanceof ThemePackageError) return error.problems
    throw error
  }
  return []
}

describe('the tokens the stylesheets read', () => {
  const used = new Set([...`${PROJECTOR_CSS}\n${VOD_CSS}`.matchAll(/var\(--([\w-]+)/g)].map((m) => m[1]!))
  const declared = new Set([...themeTokens(DEFAULT_THEME).matchAll(/--([\w-]+):/g)].map((m) => m[1]!))
  const own = new Set([...`${PROJECTOR_CSS}\n${VOD_CSS}`.matchAll(/^\s*--([\w-]+):/gm)].map((m) => m[1]!))

  it('are all declared by the theme or by the sheets themselves', () => {
    // Set inline by the scenes (--i, --k, --c…), or by the reference itself and never declared (--ciel).
    const local = /^(i|k|t|e|n|c|d|delai|x|y|fs|scale|avance|from|end|photo|contour-couleur|contour-epaisseur|ciel)$/
    const missing = [...used].filter((name) => !declared.has(name) && !own.has(name) && !local.test(name))
    expect(missing).toEqual([])
  })

  it('give every colour and its triplet, from the default theme when a package says nothing', () => {
    const tokens = themeTokens({ ...DEFAULT_THEME, manifest: { ...DEFAULT_THEME.manifest, couleurs: { violet: '#123456' } } })
    expect(tokens).toContain('--violet: #123456;')
    expect(tokens).toContain('--violet-rgb: 18, 52, 86;')
    expect(tokens).toContain(`--orange: ${DEFAULT_THEME.manifest.couleurs.orange};`)
    for (const name of THEME_COULEURS) expect(tokens).toContain(`--${name}-rgb: `)
  })
})

describe('the Cloud Nord theme, as the repository keeps it', () => {
  const bundle = parseThemePackage(readThemeFolder(CLOUDNORD))
  const theme = { bundle, base: '/display/theme/abc' }

  it('is a valid package, with every colour of its own', () => {
    expect(bundle.manifest.id).toBe('cloudnord')
    expect(Object.keys(bundle.manifest.couleurs).sort()).toEqual([...THEME_COULEURS].sort())
  })

  it('brings its typefaces, served from the theme', () => {
    expect(themeStyle(theme)).toContain('url("/display/theme/abc/fonts/PeaceSans.otf") format("opentype")')
    expect(themeStyle(theme)).toContain('--f-titre: "Peace Sans"')
  })

  it('draws its decor and its nine bubbles', () => {
    const decor = themeDecor(theme)
    expect(decor).toContain('<linearGradient id="g-bulle"')
    expect(decor.match(/class="bulle"/g)).toHaveLength(9)
    expect(decor).toContain('style="left:455px; top:397px; width:40px; height:40px; --d:7s; --delai:-3s"')
  })

  it('is worn by the loop and by the VOD', () => {
    expect(renderProjectorDocument({ theme })).toContain('<linearGradient id="g-bulle"')
    const vod = renderVodDocument({ clip: 'intro', habillage: { talk: { title: 'Titre' } } as never, theme })
    expect(vod).toContain('--violet: #5e17eb;')
  })

  it('zips to the same bytes every time, and unzips to the same files', () => {
    const zip = zipTheme(readThemeFolder(CLOUDNORD))
    expect(themeSha(zipTheme(readThemeFolder(CLOUDNORD)))).toBe(themeSha(zip))
    expect(parseThemePackage(unzipTheme(zip))).toEqual(bundle)
  })
})

describe('a package from the console', () => {
  it('is read from inside its folder too', () => {
    const zip = zipTheme(files({ 'mon-theme/theme.json': manifest() }))
    expect(parseThemePackage(unzipTheme(zip)).manifest.id).toBe('essai')
  })

  it('needs a manifest of this version', () => {
    expect(problems(files({}))).toEqual(['theme.json : fichier absent du paquet'])
    expect(problems(files({ 'theme.json': manifest({ apiVersion: 2 }) }))[0]).toMatch(/apiVersion/)
    expect(problems(files({ 'theme.json': manifest({ couleurs: { violet: 'red' } }) }))[0]).toMatch(/couleurs\.violet/)
  })

  it('takes nothing from outside itself', () => {
    expect(problems(files({ 'theme.json': manifest({ css: 'theme.css' }), 'theme.css': '@import "x.css";' }))).toEqual([
      'theme.css : @import interdit — tout doit être dans le paquet',
    ])
    expect(problems(files({ 'theme.json': manifest({ css: 'theme.css' }), 'theme.css': 'a { background: url(https://x.fr/a.png) }' }))[0])
      .toMatch(/seuls les fichiers du paquet/)
    expect(problems(files({ 'theme.json': manifest({ fond: 'url(http://x.fr/a.png)' }) }))[0]).toMatch(/fond/)
  })

  it('may only draw: no script, no handler', () => {
    const svg = (body: string) => files({ 'theme.json': manifest({ decor: { svg: 'decor.svg' } }), 'decor.svg': body })
    expect(problems(svg('<svg><script>alert(1)</script></svg>'))[0]).toMatch(/élément interdit/)
    expect(problems(svg('<svg><circle onload="alert(1)"/></svg>'))[0]).toMatch(/attribut d'événement/)
    expect(problems(svg('<svg><image href="https://x.fr/a.png"/></svg>'))[0]).toMatch(/seuls les fichiers du paquet/)
    expect(problems(svg('<svg><image href="images/absente.png"/></svg>'))[0]).toMatch(/absent du paquet/)
    expect(problems(svg('<svg><circle r="4"/></svg>'))).toEqual([])
  })

  it('points its own files at where the theme is served', () => {
    const bundle = parseThemePackage(new Map([
      ['theme.json', strToU8(manifest({ css: 'theme.css', decor: { svg: 'decor.svg' } }))],
      ['theme.css', strToU8('.accueil { background: url(images/fond.png) }')],
      ['decor.svg', strToU8('<svg><image href="images/fond.png"/></svg>')],
      ['images/fond.png', new Uint8Array([137, 80, 78, 71])],
    ]))
    const theme = { bundle, base: '/display/theme/abc' }
    expect(themeStyle(theme)).toContain('url("/display/theme/abc/images/fond.png")')
    expect(themeDecor(theme)).toContain('href="/display/theme/abc/images/fond.png"')
  })
})
