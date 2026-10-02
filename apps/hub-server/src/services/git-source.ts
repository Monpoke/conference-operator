import { createHash } from 'node:crypto'
import * as fs from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { eq } from 'drizzle-orm'
import git from 'isomorphic-git'
import http from 'isomorphic-git/http/node'
import { z } from 'zod'
import {
  boucleSchema,
  cheminThemeSchema,
  gitImportSchema,
  gitSourceSchema,
  hubSettingsPatchSchema,
  type GitImport,
  type GitSource,
  type GitSourceStatus,
  type HubSettingsPatch,
  type ThemeInfo,
} from '@conference-operator/contract'
import { hubSetting } from '@conference-operator/db/hub'
import { readThemeFolder, ThemePackageError } from '@conference-operator/projector/server'
import type { HubDatabase } from '../db.js'
import type { SecretBox } from '../secrets.js'
import { looksLike, MAX_UPLOAD_BYTES, UPLOAD_EXTENSIONS } from './image-upload.js'

const SETTING_KEY = 'gitSource'

const storedSchema = z.object({
  source: gitSourceSchema.nullable().default(null),
  jetonScelle: z.string().nullable().default(null),
  jetonIndice: z.string().nullable().default(null),
  derniere: gitImportSchema.nullable().default(null),
})
type Stored = z.infer<typeof storedSchema>

/**
 * Fetches one branch of a repository into a folder and returns its commit.
 * The hub's is `cloneBranch`; the tests give their own.
 */
export type Cloner = (options: { url: string; branche: string; dir: string; jeton: string | null }) => Promise<string>

/** How long a fetch may take: a small repository comes in seconds. */
const CLONE_TIMEOUT_MS = 60_000

/**
 * The branch, alone and without its history — `isomorphic-git`, Git in
 * JavaScript: the hub's image has no `git` binary, nor a shell to run one.
 * A token is sent as the password of a basic authentication, which GitHub,
 * GitLab and Gitea all accept for an access token.
 */
export const cloneBranch: Cloner = async ({ url, branche, dir, jeton }) => {
  const clone = git.clone({
    fs,
    http,
    dir,
    url,
    ref: branche,
    singleBranch: true,
    depth: 1,
    noTags: true,
    onAuth: jeton == null ? undefined : () => ({ username: 'x-access-token', password: jeton }),
  })
  let timer: NodeJS.Timeout | undefined
  try {
    await Promise.race([
      clone,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('dépôt trop long à récupérer (60 s)')), CLONE_TIMEOUT_MS)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
  return git.resolveRef({ fs, dir, ref: 'HEAD' })
}

/** An import that could not be done — the console says why. */
export class GitImportError extends Error {}

/** What the import does with what it read, given by the hub. */
export interface GitImportTargets {
  importTheme: (files: Map<string, Uint8Array>) => ThemeInfo
  storeImage: (ref: string, bytes: Buffer, contentType: string) => Promise<void>
}

/** The loop's sections that never come from a file: chosen in the console, or a secret. */
const SECTIONS_KEPT = new Set(['theme', 'lienPublic'])

/**
 * The Git repository the console imports from: where it is, the token to read
 * it (sealed like walls.io's, never sent back), and how the last import went.
 *
 * An import, not a synchronisation: nothing is read until someone asks, and
 * what comes in is the hub's from then on — the loop's content stays editable
 * in the console, and the next import overwrites only what its file names.
 */
export class GitSourceService {
  constructor(
    private readonly db: HubDatabase,
    private readonly box: SecretBox,
    private readonly clone: Cloner = cloneBranch,
    private readonly now: () => Date = () => new Date(),
  ) {}

  status(): GitSourceStatus | null {
    const stored = this.read()
    if (stored.source == null) return null
    const readable = stored.jetonScelle != null && this.token() != null
    return {
      ...stored.source,
      jetonDefini: readable,
      jetonIndice: readable ? stored.jetonIndice : null,
      derniere: stored.derniere,
    }
  }

  /** Sets the source. `jeton`: a new one, `null` to remove it, `undefined` to keep it. */
  set(source: GitSource | null, jeton: string | null | undefined): GitSourceStatus | null {
    if (source == null) {
      this.write({ source: null, jetonScelle: null, jetonIndice: null, derniere: null })
      return null
    }
    this.write({
      source,
      ...(jeton === undefined
        ? {}
        : { jetonScelle: jeton == null ? null : this.box.seal(jeton), jetonIndice: jeton == null ? null : jeton.slice(-4) }),
    })
    return this.status()
  }

  /**
   * Reads the folder on its branch and imports what is asked. The theme is kept
   * like an uploaded package; the content comes back as a settings patch, its
   * images (paths in the repository) already stored on the hub. Records how it
   * went, failure included, and throws `GitImportError` on failure.
   */
  async import(
    asked: { theme: boolean; contenu: boolean },
    targets: GitImportTargets,
  ): Promise<{ result: GitImport; theme: ThemeInfo | null; patch: HubSettingsPatch | null }> {
    const source = this.read().source
    if (source == null) throw new GitImportError('Aucun dépôt Git réglé')
    if (!asked.theme && !asked.contenu) throw new GitImportError('Rien à importer')
    const dir = await mkdtemp(join(tmpdir(), 'hub-git-'))
    let commit: string | null = null
    try {
      try {
        commit = await this.clone({ url: source.url, branche: source.branche, dir, jeton: this.token() })
      } catch (cause) {
        throw new GitImportError(`Dépôt illisible (${source.branche}) : ${cause instanceof Error ? cause.message : String(cause)}`)
      }
      const folder = source.dossier === '' ? dir : join(dir, source.dossier)
      let theme: ThemeInfo | null = null
      if (asked.theme) {
        if (!fs.existsSync(join(folder, 'theme.json'))) {
          throw new GitImportError(`Pas de theme.json dans « ${source.dossier || '/'} » sur ${source.branche}`)
        }
        try {
          theme = targets.importTheme(readThemeFolder(folder))
        } catch (cause) {
          if (cause instanceof ThemePackageError) throw new GitImportError(`Thème refusé :\n${cause.problems.join('\n')}`)
          throw cause
        }
      }
      const patch = asked.contenu ? await this.readContent(folder, source, targets) : null
      const result: GitImport = {
        le: this.now().toISOString(),
        commit,
        theme: theme?.sha ?? null,
        sections: patch == null ? null : Object.keys(patch.boucle ?? {}),
        erreur: null,
      }
      this.write({ derniere: result })
      return { result, theme, patch }
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause)
      this.write({ derniere: { le: this.now().toISOString(), commit, theme: null, sections: null, erreur: message } })
      throw cause instanceof GitImportError ? cause : new GitImportError(message)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }

  /** `boucle.json`: the sections it names, checked like the console's, its images stored. */
  private async readContent(folder: string, source: GitSource, targets: GitImportTargets): Promise<HubSettingsPatch> {
    const path = join(folder, 'boucle.json')
    if (!fs.existsSync(path)) {
      throw new GitImportError(`Pas de boucle.json dans « ${source.dossier || '/'} » sur ${source.branche}`)
    }
    let raw: unknown
    try {
      raw = JSON.parse(await readFile(path, 'utf8'))
    } catch {
      throw new GitImportError('boucle.json : JSON invalide')
    }
    if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) throw new GitImportError('boucle.json : objet attendu')
    const known = new Set(Object.keys(boucleSchema.shape))
    const unknown = Object.keys(raw).filter((key) => !known.has(key))
    if (unknown.length > 0) throw new GitImportError(`boucle.json : sections inconnues — ${unknown.join(', ')}`)
    const content = Object.fromEntries(Object.entries(raw).filter(([key]) => !SECTIONS_KEPT.has(key)))

    const problems: string[] = []
    const withImages = await this.storeImages(content, folder, targets, problems)
    if (problems.length > 0) throw new GitImportError(`boucle.json :\n${problems.join('\n')}`)
    const parsed = hubSettingsPatchSchema.safeParse({ boucle: withImages })
    if (!parsed.success) {
      throw new GitImportError(
        `boucle.json :\n${parsed.error.issues.map((issue) => `${issue.path.slice(1).join('.') || '(racine)'} : ${issue.message}`).join('\n')}`,
      )
    }
    return parsed.data
  }

  /**
   * Every `logo` given as a path of the repository (`images/sponsor.png`) is
   * stored on the hub like an image uploaded from the console, and replaced by
   * its reference. Addresses and references already given stay as they are.
   */
  private async storeImages(value: unknown, folder: string, targets: GitImportTargets, problems: string[]): Promise<unknown> {
    if (Array.isArray(value)) return Promise.all(value.map((item) => this.storeImages(item, folder, targets, problems)))
    if (value == null || typeof value !== 'object') return value
    const out: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value)) {
      out[key] =
        key === 'logo' && typeof item === 'string' && !/^(https?:\/\/|hub-image:)/.test(item)
          ? await this.storeImage(item, folder, targets, problems)
          : await this.storeImages(item, folder, targets, problems)
    }
    return out
  }

  private async storeImage(path: string, folder: string, targets: GitImportTargets, problems: string[]): Promise<string | null> {
    if (!cheminThemeSchema.safeParse(path).success) {
      problems.push(`« ${path} » : chemin relatif au dossier attendu`)
      return null
    }
    const extension = path.slice(path.lastIndexOf('.') + 1).toLowerCase()
    const contentType = (Object.keys(UPLOAD_EXTENSIONS) as (keyof typeof UPLOAD_EXTENSIONS)[]).find(
      (type) => UPLOAD_EXTENSIONS[type] === extension || (type === 'image/jpeg' && extension === 'jpeg'),
    )
    if (contentType == null) {
      problems.push(`« ${path} » : image PNG, JPEG, WebP, GIF ou SVG attendue`)
      return null
    }
    let bytes: Buffer
    try {
      bytes = await readFile(join(folder, path))
    } catch {
      problems.push(`« ${path} » : absente du dépôt`)
      return null
    }
    if (bytes.byteLength === 0 || bytes.byteLength > MAX_UPLOAD_BYTES || !looksLike(contentType, bytes)) {
      problems.push(`« ${path} » : n'est pas une image ${UPLOAD_EXTENSIONS[contentType].toUpperCase()} de 2,5 Mo au plus`)
      return null
    }
    const ref = `hub-image:${createHash('sha256').update(bytes).digest('hex')}.${UPLOAD_EXTENSIONS[contentType]}`
    await targets.storeImage(ref, bytes, contentType)
    return ref
  }

  private token(): string | null {
    const sealed = this.read().jetonScelle
    return sealed == null ? null : this.box.open(sealed)
  }

  private read(): Stored {
    const row = this.db.select().from(hubSetting).where(eq(hubSetting.key, SETTING_KEY)).get()
    if (row == null) return storedSchema.parse({})
    const parsed = storedSchema.safeParse(JSON.parse(row.valueJson))
    return parsed.success ? parsed.data : storedSchema.parse({})
  }

  private write(patch: Partial<Stored>): void {
    const valueJson = JSON.stringify({ ...this.read(), ...patch })
    const updatedAt = new Date().toISOString()
    this.db
      .insert(hubSetting)
      .values({ key: SETTING_KEY, valueJson, updatedAt })
      .onConflictDoUpdate({ target: hubSetting.key, set: { valueJson, updatedAt } })
      .run()
  }
}
