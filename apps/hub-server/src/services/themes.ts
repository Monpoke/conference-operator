import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { themeInfoSchema, type ThemeBundle, type ThemeInfo } from '@conference-operator/contract'
import {
  parseThemePackage,
  pickThemeFiles,
  readThemeFolder,
  shippedThemeFolders,
  themeFileType,
  themeSha,
  unzipTheme,
  zipTheme,
  type ThemeFiles,
} from '@conference-operator/projector/server'

const SHA = /^[0-9a-f]{64}$/

/**
 * The theme packages the hub keeps, beside its database like the images.
 *
 * One zip per theme, named by its sha, and its card (`<sha>.json`) for the
 * console's list. What is kept is the package as this code re-zips it — files
 * sorted, dates fixed — so the same content always has the same sha, whatever
 * tool zipped it: importing it again changes nothing, and the rooms, which fetch
 * a theme by its sha, fetch it once.
 *
 * With no directory — a hub on an in-memory database, the tests' — the packages
 * are kept in memory too: an ephemeral hub leaves nothing behind it.
 */
export class ThemeStore {
  readonly #loaded = new Map<string, { bundle: ThemeBundle; files: ThemeFiles }>()
  readonly #memory = new Map<string, { zip: Buffer; info: ThemeInfo }>()

  constructor(
    private readonly directory: string | null,
    private readonly now: () => Date = () => new Date(),
  ) {
    if (directory != null) mkdirSync(directory, { recursive: true })
  }

  /** The themes kept, by name. */
  list(): ThemeInfo[] {
    const kept = this.directory == null
      ? [...this.#memory.values()].map((entry) => entry.info)
      : readdirSync(this.directory)
          .filter((name) => name.endsWith('.json'))
          .flatMap((name) => {
            try {
              return [themeInfoSchema.parse(JSON.parse(readFileSync(join(this.directory!, name), 'utf8')))]
            } catch {
              return []
            }
          })
    return kept.sort((a, b) => a.nom.localeCompare(b.nom, 'fr') || b.importeLe.localeCompare(a.importeLe))
  }

  info(sha: string): ThemeInfo | null {
    return this.list().find((theme) => theme.sha === sha) ?? null
  }

  /**
   * Keeps a package, checked whole first (`ThemePackageError` lists what is
   * wrong). The same content already kept: its card, unchanged.
   */
  import(zip: Uint8Array): ThemeInfo {
    return this.#keep(unzipTheme(zip))
  }

  /** A package already unzipped — a folder of a Git repository. */
  importFiles(files: ThemeFiles): ThemeInfo {
    return this.#keep(files)
  }

  /** The themes shipped with the code (`themes/`), kept if they are not already. */
  seed(folder: string | null, log: (message: string) => void = () => {}): ThemeInfo[] {
    const seeded: ThemeInfo[] = []
    for (const path of shippedThemeFolders(folder)) {
      try {
        seeded.push(this.#keep(readThemeFolder(path)))
      } catch (error) {
        log(`thème livré ignoré (${path}) : ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    return seeded
  }

  #keep(folder: ThemeFiles): ThemeInfo {
    // Only the theme's own files: a repository's folder or a full export carries the content beside it.
    const files = pickThemeFiles(folder)
    const { manifest } = parseThemePackage(files)
    const zip = zipTheme(files)
    const sha = themeSha(zip)
    const known = this.info(sha)
    if (known != null) return known
    const info: ThemeInfo = {
      id: manifest.id,
      nom: manifest.nom,
      sha,
      version: manifest.version,
      auteur: manifest.auteur ?? null,
      importeLe: this.now().toISOString(),
      taille: zip.byteLength,
    }
    if (this.directory == null) {
      this.#memory.set(sha, { zip: Buffer.from(zip), info })
      return info
    }
    // The zip before its card: a card is only ever listed with its package there.
    writeFileSync(join(this.directory, `${sha}.zip.partial`), zip)
    renameSync(join(this.directory, `${sha}.zip.partial`), join(this.directory, `${sha}.zip`))
    writeFileSync(join(this.directory, `${sha}.json`), JSON.stringify(info, null, 2))
    return info
  }

  /** The package itself, for the rooms and for the console's export. */
  zip(sha: string): Buffer | null {
    if (!SHA.test(sha)) return null
    if (this.directory == null) return this.#memory.get(sha)?.zip ?? null
    try {
      return readFileSync(join(this.directory, `${sha}.zip`))
    } catch {
      return null
    }
  }

  /** A theme, read and checked once, then kept in memory: it never changes under its sha. */
  load(sha: string): { bundle: ThemeBundle; files: ThemeFiles } | null {
    const cached = this.#loaded.get(sha)
    if (cached != null) return cached
    const zip = this.zip(sha)
    if (zip == null) return null
    try {
      const files = unzipTheme(zip)
      const loaded = { bundle: parseThemePackage(files), files }
      this.#loaded.set(sha, loaded)
      return loaded
    } catch {
      return null
    }
  }

  /** One of a theme's files the pages fetch — fonts and images only. */
  file(sha: string, path: string): { bytes: Uint8Array; type: string } | null {
    const type = themeFileType(path)
    const bytes = type == null ? undefined : this.load(sha)?.files.get(path)
    return bytes == null || type == null ? null : { bytes, type }
  }

  remove(sha: string): void {
    if (!SHA.test(sha)) return
    this.#loaded.delete(sha)
    if (this.directory == null) {
      this.#memory.delete(sha)
      return
    }
    rmSync(join(this.directory, `${sha}.json`), { force: true })
    rmSync(join(this.directory, `${sha}.zip`), { force: true })
    this.#loaded.delete(sha)
  }
}
