import { existsSync, readdirSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * The loop's typefaces, served by the machine itself.
 *
 * The reference design is set in Peace Sans (titles), Gagalin (the welcome),
 * Bukhari Script ("Merci beaucoup !") and Open Sans. None of them is on a room
 * machine, and the projector must not fetch anything from the Internet: the files
 * are dropped in `apps/room-client/assets/fonts/`, packaged with the client, and
 * read from the same folder by the hub's preview.
 *
 * Only the files that are there are declared: an `@font-face` pointing at a
 * missing file, with `font-display: block`, would hide the text for three
 * seconds on every load. A missing typeface falls back on the reference loop's
 * fallbacks, and says nothing.
 */
export interface FontFamily {
  family: string
  weight: number
  /** File names without extension, in order of preference. */
  names: string[]
}

export const LOOP_FONTS: FontFamily[] = [
  { family: 'Peace Sans', weight: 400, names: ['PeaceSans'] },
  { family: 'Gagalin', weight: 400, names: ['Gagalin', 'Gagalin-Regular'] },
  { family: 'Bukhari Script', weight: 400, names: ['BukhariScript', 'BukhariScript-Regular'] },
  { family: 'Open Sans', weight: 700, names: ['OpenSans-Bold'] },
  { family: 'Open Sans', weight: 800, names: ['OpenSans-ExtraBold'] },
]

const FORMATS: Record<string, { format: string; type: string }> = {
  '.woff2': { format: 'woff2', type: 'font/woff2' },
  '.woff': { format: 'woff', type: 'font/woff' },
  '.otf': { format: 'opentype', type: 'font/otf' },
  '.ttf': { format: 'truetype', type: 'font/ttf' },
}

/** One declared face: the family and the file that serves it. */
export interface AvailableFont {
  family: string
  weight: number
  file: string
  format: string
}

/**
 * The fonts folder, searched like the migrations: packaged under `resources/`
 * (the Electron room), `FONTS_DIR` (the hub's image), or found by walking up in
 * the monorepo — this file runs from its sources under `tsx` and flattened into
 * `dist/main.cjs` for Electron.
 */
export function resolveFontsFolder(): string | null {
  // Set by Electron only: the hub and the tests run on plain Node.
  const packaged = (process as { resourcesPath?: string }).resourcesPath
  if (packaged != null) {
    const candidate = join(packaged, 'fonts')
    if (existsSync(candidate)) return candidate
  }
  const configured = process.env.FONTS_DIR
  if (configured && existsSync(configured)) return configured
  let directory = dirname(fileURLToPath(import.meta.url))
  for (;;) {
    for (const candidate of [join(directory, 'assets', 'fonts'), join(directory, 'apps', 'room-client', 'assets', 'fonts')]) {
      if (existsSync(candidate)) return candidate
    }
    const parent = dirname(directory)
    if (parent === directory) return null
    directory = parent
  }
}

/** The faces whose file is present, the best format first. */
export function availableFonts(folder: string | null): AvailableFont[] {
  if (folder == null) return []
  let files: string[]
  try {
    files = readdirSync(folder)
  } catch {
    return []
  }
  const found: AvailableFont[] = []
  for (const font of LOOP_FONTS) {
    const match = font.names
      .flatMap((name) => Object.keys(FORMATS).map((extension) => name + extension))
      .find((file) => files.includes(file))
    if (match == null) continue
    const extension = match.slice(match.lastIndexOf('.'))
    found.push({ family: font.family, weight: font.weight, file: match, format: FORMATS[extension]!.format })
  }
  return found
}

/**
 * The `@font-face` rules for the present files, served under `base`.
 *
 * `local()` first: a machine that has the typeface installed does not even ask.
 */
export function fontFaces(fonts: AvailableFont[], base: string): string {
  return fonts
    .map((font) =>
      `@font-face { font-family: "${font.family}"; font-weight: ${font.weight}; font-display: block; ` +
      `src: local("${font.family}"), url("${base}/${encodeURIComponent(font.file)}") format("${font.format}"); }`,
    )
    .join('\n')
}

/** Reads one font file, allow-listed: only the names above, only the formats above. */
export async function readFont(folder: string | null, file: string): Promise<{ bytes: Buffer; type: string } | null> {
  if (folder == null) return null
  const font = availableFonts(folder).find((candidate) => candidate.file === file)
  if (font == null) return null
  const extension = file.slice(file.lastIndexOf('.'))
  return { bytes: await readFile(join(folder, file)), type: FORMATS[extension]!.type }
}
