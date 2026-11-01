import { withRetries, type Wait } from './retry.js'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { VodHabillage } from '@conference-operator/contract'
import { parseThemePackage, themeSha, unzipTheme, type ThemeSource } from '@conference-operator/projector/server'

/**
 * The loop's theme, laid out beside the page the worker captures.
 *
 * The intro and outro wear what the rooms projected. The page is opened as a
 * file and captured from its first frame, so the theme's fonts and images are
 * written to the work folder first, like the images are inlined: nothing is
 * fetched during capture. A theme that cannot be had fails the montage after a few
 * tries: the event's frame is part of the video, and its absence must be seen.
 */
export async function themeForCapture(
  ref: VodHabillage['theme'],
  workDir: string,
  onRetry: (error: unknown) => void = () => {},
  fetcher: typeof fetch = fetch,
  wait?: Wait,
): Promise<ThemeSource | null> {
  if (ref == null) return null
  return withRetries(async () => {
    const response = await fetcher(ref.url, { signal: AbortSignal.timeout(30_000) })
    if (!response.ok) throw new Error(`thème illisible : HTTP ${response.status}`)
    const zip = new Uint8Array(await response.arrayBuffer())
    if (themeSha(zip) !== ref.sha) throw new Error('thème illisible : paquet différent de celui annoncé')
    const files = unzipTheme(zip)
    const bundle = parseThemePackage(files)
    const folder = join(workDir, `theme-${ref.sha.slice(0, 16)}`)
    for (const [path, bytes] of files) {
      await mkdir(dirname(join(folder, path)), { recursive: true })
      await writeFile(join(folder, path), bytes)
    }
    return { bundle, base: pathToFileURL(folder).href, sha: ref.sha }
  }, { onRetry, wait })
}
