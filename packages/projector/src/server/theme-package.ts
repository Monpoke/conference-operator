import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { unzipSync, zipSync } from 'fflate'
import { cheminThemeSchema, themeManifestSchema, type ThemeBundle } from '@conference-operator/contract'

/**
 * A theme package: `theme.json` and the files it names, zipped.
 *
 * Checked whole before anything keeps it. Its CSS and its SVG end up inlined in
 * the pages the rooms project and OBS records, so they may only draw: no script,
 * no handler, nothing fetched from outside the package — the rooms are offline,
 * and the page loads nothing it did not ship.
 */

/** A package, by path inside it. */
export type ThemeFiles = Map<string, Uint8Array>

export const THEME_MAX_BYTES = 8 * 1024 * 1024
const MAX_FILES = 64
const MAX_TEXT_BYTES = 512 * 1024

/** What a package may hold, by extension. */
export const THEME_FILE_TYPES: Record<string, string> = {
  json: 'application/json',
  css: 'text/css',
  svg: 'image/svg+xml',
  woff2: 'font/woff2',
  woff: 'font/woff',
  otf: 'font/otf',
  ttf: 'font/ttf',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  // Licences and notes: kept with the fonts, as their licences require; never served.
  txt: 'text/plain',
  md: 'text/markdown',
}

/** What the page may fetch from the package. */
const SERVED = new Set(['svg', 'woff2', 'woff', 'otf', 'ttf', 'png', 'jpg', 'jpeg', 'webp', 'gif'])

export const extensionOf = (path: string): string => path.slice(path.lastIndexOf('.') + 1).toLowerCase()

/** The content type a package file is served with, or `null` when it is not served. */
export function themeFileType(path: string): string | null {
  const extension = extensionOf(path)
  return SERVED.has(extension) ? THEME_FILE_TYPES[extension] ?? null : null
}

/** A package that cannot be used, and every reason why — the console lists them. */
export class ThemePackageError extends Error {
  constructor(readonly problems: string[]) {
    super(problems.join('\n'))
    this.name = 'ThemePackageError'
  }
}

const decoder = new TextDecoder('utf-8', { fatal: true })
const text = (files: ThemeFiles, path: string, problems: string[]): string | null => {
  const bytes = files.get(path)
  if (bytes == null) {
    problems.push(`${path} : fichier absent du paquet`)
    return null
  }
  if (bytes.byteLength > MAX_TEXT_BYTES) {
    problems.push(`${path} : trop lourd (${Math.round(MAX_TEXT_BYTES / 1024)} ko au plus)`)
    return null
  }
  try {
    return decoder.decode(bytes)
  } catch {
    problems.push(`${path} : texte UTF-8 attendu`)
    return null
  }
}

/** A reference from the CSS or the SVG: to a file of the package, or to an anchor of the same document. */
function checkReference(value: string, where: string, files: ThemeFiles, problems: string[]): void {
  const target = value.trim()
  if (target.startsWith('#')) return
  if (!cheminThemeSchema.safeParse(target).success) {
    problems.push(`${where} : « ${target.slice(0, 80)} » — seuls les fichiers du paquet sont autorisés`)
    return
  }
  if (!files.has(target)) problems.push(`${where} : « ${target} » est absent du paquet`)
  else if (themeFileType(target) == null) problems.push(`${where} : « ${target} » n'est ni une image ni une police`)
}

/** The theme's stylesheet: rules that draw, with the package's own files. */
export function checkThemeCss(css: string, path: string, files: ThemeFiles, problems: string[]): void {
  if (/<\/?\s*style|<\s*script/i.test(css)) problems.push(`${path} : balise HTML interdite`)
  if (/@import/i.test(css)) problems.push(`${path} : @import interdit — tout doit être dans le paquet`)
  if (/expression\s*\(|javascript:|behavior\s*:|-moz-binding/i.test(css)) problems.push(`${path} : construction interdite`)
  for (const match of css.matchAll(/url\(\s*(['"]?)([^'")]*)\1\s*\)/gi)) {
    checkReference(match[2]!, path, files, problems)
  }
}

/** The decor's SVG: shapes, gradients and the package's images — nothing that runs or fetches. */
export function checkThemeSvg(svg: string, path: string, files: ThemeFiles, problems: string[], root: boolean): void {
  if (root && !/^\s*<svg[\s>]/i.test(svg)) problems.push(`${path} : doit commencer par <svg>`)
  if (/<\s*script|<\s*foreignObject|<\s*iframe|<\s*object|<\s*embed|<!DOCTYPE|<!ENTITY|<\?xml-stylesheet|<\/\s*style/i.test(svg)) {
    problems.push(`${path} : élément interdit (script, foreignObject, DOCTYPE…)`)
  }
  if (/\son[a-z]+\s*=/i.test(svg)) problems.push(`${path} : attribut d'événement (on…) interdit`)
  if (/javascript:|@import|<\s*(?:set|animate)[^>]*attributeName\s*=\s*["']?(?:xlink:)?href/i.test(svg)) {
    problems.push(`${path} : construction interdite`)
  }
  for (const match of svg.matchAll(/\b(?:xlink:)?href\s*=\s*(["'])([^"']*)\1/gi)) checkReference(match[2]!, path, files, problems)
  for (const match of svg.matchAll(/url\(\s*(['"]?)([^'")]*)\1\s*\)/gi)) checkReference(match[2]!, path, files, problems)
}

/**
 * The package, checked: the manifest against its schema, every file it names
 * present, its CSS and SVG harmless. Throws {@link ThemePackageError} with every
 * problem found, not only the first.
 */
export function parseThemePackage(files: ThemeFiles): ThemeBundle {
  const problems: string[] = []
  let total = 0
  for (const [path, bytes] of files) {
    total += bytes.byteLength
    if (!cheminThemeSchema.safeParse(path).success) problems.push(`${path} : nom de fichier non autorisé`)
    else if (THEME_FILE_TYPES[extensionOf(path)] == null) problems.push(`${path} : type de fichier non autorisé`)
  }
  if (files.size > MAX_FILES) problems.push(`${files.size} fichiers : ${MAX_FILES} au plus`)
  if (total > THEME_MAX_BYTES) problems.push(`paquet trop lourd : ${THEME_MAX_BYTES / 1024 / 1024} Mo au plus`)

  const json = text(files, 'theme.json', problems)
  if (json == null) throw new ThemePackageError(problems)
  let raw: unknown
  try {
    raw = JSON.parse(json)
  } catch {
    throw new ThemePackageError([...problems, 'theme.json : JSON invalide'])
  }
  const parsed = themeManifestSchema.safeParse(raw)
  if (!parsed.success) {
    throw new ThemePackageError([
      ...problems,
      ...parsed.error.issues.map((issue) => `theme.json › ${issue.path.join('.') || '(racine)'} : ${issue.message}`),
    ])
  }
  const manifest = parsed.data

  const css = manifest.css == null ? '' : (text(files, manifest.css, problems) ?? '')
  if (manifest.css != null) checkThemeCss(css, manifest.css, files, problems)
  const decor = manifest.decor.svg == null ? null : text(files, manifest.decor.svg, problems)
  if (decor != null) checkThemeSvg(decor, manifest.decor.svg!, files, problems, true)
  const overlay = manifest.overlay.svg == null ? null : text(files, manifest.overlay.svg, problems)
  if (overlay != null) checkThemeSvg(overlay, manifest.overlay.svg!, files, problems, false)
  for (const font of manifest.polices.fichiers) {
    if (!files.has(font.fichier)) problems.push(`theme.json › polices : « ${font.fichier} » est absent du paquet`)
  }

  if (problems.length > 0) throw new ThemePackageError(problems)
  return { manifest, css, decor, overlay }
}

/** The files of a zip, by path; folders and the archivers' own litter left out. */
export function unzipTheme(zip: Uint8Array): ThemeFiles {
  let entries: Record<string, Uint8Array>
  try {
    entries = unzipSync(zip, {
      // Checked before inflating: a small archive must not unfold into gigabytes.
      filter: (file) => file.originalSize <= THEME_MAX_BYTES,
    })
  } catch {
    throw new ThemePackageError(['archive zip illisible'])
  }
  const files: ThemeFiles = new Map()
  const names = Object.keys(entries).filter((name) => !name.endsWith('/') && !/(^|\/)(__MACOSX|\.DS_Store)/.test(name))
  // A package zipped with its folder: `cloudnord/theme.json` is read as `theme.json`.
  const prefix = names.includes('theme.json')
    ? ''
    : (names.find((name) => /^[^/]+\/theme\.json$/.test(name))?.replace(/theme\.json$/, '') ?? '')
  for (const name of names) {
    if (!name.startsWith(prefix)) continue
    files.set(name.slice(prefix.length), entries[name]!)
  }
  return files
}

/**
 * The package as a zip, its files in a fixed order and with a fixed date: the
 * same theme always gives the same bytes, and so the same sha.
 */
export function zipTheme(files: ThemeFiles): Uint8Array {
  const entries: Record<string, [Uint8Array, { mtime: Date }]> = {}
  for (const path of [...files.keys()].sort()) entries[path] = [files.get(path)!, { mtime: new Date('2000-01-01T00:00:00Z') }]
  return zipSync(entries, { level: 9 })
}

export const themeSha = (zip: Uint8Array): string => createHash('sha256').update(zip).digest('hex')

/** A theme's folder on disk (`themes/cloudnord`), as a package. */
export function readThemeFolder(folder: string): ThemeFiles {
  const files: ThemeFiles = new Map()
  const walk = (directory: string) => {
    for (const name of readdirSync(directory).sort()) {
      if (name.startsWith('.')) continue
      const path = join(directory, name)
      if (statSync(path).isDirectory()) walk(path)
      else files.set(relative(folder, path).split(sep).join('/'), new Uint8Array(readFileSync(path)))
    }
  }
  walk(folder)
  return files
}
