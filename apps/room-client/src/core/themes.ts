import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ThemeBundle, ThemeRef } from '@conference-operator/contract'
import {
  parseThemePackage,
  themeFileType,
  themeSha,
  unzipTheme,
  type ThemeFiles,
  type ThemeSource,
} from '@conference-operator/projector/server'

const SHA = /^[0-9a-f]{64}$/

/** What became of the theme the hub chose, at a sync. */
export type ThemeFetch = 'aucun' | 'present' | 'telecharge' | 'echec'

/**
 * The theme packages the room holds, fetched from the hub like the loop's images.
 *
 * By sha, once: a package never changes under its sha, so one already here is
 * not asked for again — and stays here when the hub is out of reach, which is
 * what lets a room started offline wear yesterday's theme rather than the
 * default one. A package is checked twice before it is kept: its bytes against
 * the sha the hub announced, its content as the hub checked it on import.
 */
export class ThemeCache {
  readonly #loaded = new Map<string, { bundle: ThemeBundle; files: ThemeFiles }>()

  constructor(
    private readonly directory: string,
    private readonly hubOrigin: string | null,
    private readonly timeoutMs = 30_000,
  ) {
    mkdirSync(directory, { recursive: true })
  }

  #path(sha: string): string {
    return join(this.directory, `${sha}.zip`)
  }

  /** Fetches the chosen theme when the room does not hold it yet. Never throws. */
  async ensure(ref: ThemeRef | null, fetchImpl: typeof fetch = fetch): Promise<ThemeFetch> {
    if (ref == null) return 'aucun'
    if (!SHA.test(ref.sha)) return 'echec'
    if (existsSync(this.#path(ref.sha))) return 'present'
    if (this.hubOrigin == null) return 'echec'
    try {
      const response = await fetchImpl(`${this.hubOrigin.replace(/\/$/, '')}/boucle/theme/${ref.sha}.zip`, {
        signal: AbortSignal.timeout(this.timeoutMs),
      })
      if (!response.ok) return 'echec'
      const zip = new Uint8Array(await response.arrayBuffer())
      if (themeSha(zip) !== ref.sha) return 'echec'
      parseThemePackage(unzipTheme(zip))
      writeFileSync(`${this.#path(ref.sha)}.partial`, zip)
      renameSync(`${this.#path(ref.sha)}.partial`, this.#path(ref.sha))
      return 'telecharge'
    } catch {
      return 'echec'
    }
  }

  #load(sha: string): { bundle: ThemeBundle; files: ThemeFiles } | null {
    const cached = this.#loaded.get(sha)
    if (cached != null) return cached
    if (!SHA.test(sha) || !existsSync(this.#path(sha))) return null
    try {
      const files = unzipTheme(new Uint8Array(readFileSync(this.#path(sha))))
      const loaded = { bundle: parseThemePackage(files), files }
      this.#loaded.set(sha, loaded)
      return loaded
    } catch {
      return null
    }
  }

  /**
   * The theme to wear: the one chosen if the room holds it, served from
   * `/display/theme/<sha>`. `null` — the default theme — until it is here.
   */
  source(ref: ThemeRef | null): ThemeSource | null {
    const loaded = ref == null ? null : this.#load(ref.sha)
    return loaded == null ? null : { bundle: loaded.bundle, base: `/display/theme/${ref!.sha}`, sha: ref!.sha }
  }

  /** One of a theme's fonts or images, for the pages. */
  file(sha: string, path: string): { bytes: Uint8Array; type: string } | null {
    const type = themeFileType(path)
    const bytes = type == null ? undefined : this.#load(sha)?.files.get(path)
    return bytes == null || type == null ? null : { bytes, type }
  }
}
