import type { Boucle } from '@conference-operator/contract'
import { zipTheme, type ThemeFiles } from '@conference-operator/projector/server'
import type { AssetFile } from './assets.js'

/**
 * The loop's whole configuration, as a folder to commit in its Git repository.
 *
 * What the console made of it — texts, sponsor pages, images dropped by hand,
 * the theme chosen — exists on this hub alone until it is saved somewhere. This
 * is that somewhere, in the shape the « Dépôt Git » panel imports back:
 *
 * - `boucle.json`: the loop's sections, but neither the theme chosen nor the
 *   public link — they never come from a file;
 * - `images/`: every image dropped in the console, the reference
 *   (`hub-image:…`, meaningful on this hub only) replaced by its path, which the
 *   import turns back into an image on whatever hub reads it;
 * - the theme worn, its files at the root (`theme.json`, decor, fonts).
 *
 * An address (`https://…`) stays an address: it is not this hub's to copy.
 */
export interface ConfigExportSources {
  boucle: Boucle
  /** An uploaded image's bytes, or `null` when the hub lost it. */
  image: (ref: string) => Promise<AssetFile | null>
  /** The worn theme's files, or `null` for the default theme. */
  theme: ThemeFiles | null
}

export interface ConfigExport {
  zip: Uint8Array
  /** References the hub no longer holds: left as they are in `boucle.json`. */
  missing: string[]
}

const HUB_IMAGE = /^hub-image:([0-9a-f]{64})\.([a-z]+)$/

export async function exportConfiguration(sources: ConfigExportSources): Promise<ConfigExport> {
  const files: ThemeFiles = new Map(sources.theme ?? [])
  const missing: string[] = []
  const paths = new Map<string, string | null>()

  const pathOf = async (ref: string): Promise<string | null> => {
    if (paths.has(ref)) return paths.get(ref)!
    const [, sha, extension] = HUB_IMAGE.exec(ref)!
    const image = await sources.image(ref)
    const path = image == null ? null : `images/${sha!.slice(0, 16)}.${extension}`
    if (image == null) missing.push(ref)
    else files.set(path!, new Uint8Array(image.bytes))
    paths.set(ref, path)
    return path
  }

  const rewrite = async (value: unknown): Promise<unknown> => {
    if (typeof value === 'string') return HUB_IMAGE.test(value) ? ((await pathOf(value)) ?? value) : value
    if (Array.isArray(value)) return Promise.all(value.map(rewrite))
    if (value == null || typeof value !== 'object') return value
    const out: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value)) out[key] = await rewrite(item)
    return out
  }

  const { theme: _theme, lienPublic: _lien, ...content } = sources.boucle
  const boucle = await rewrite(content)
  files.set('boucle.json', new TextEncoder().encode(`${JSON.stringify(boucle, null, 2)}\n`))
  return { zip: zipTheme(files), missing }
}
