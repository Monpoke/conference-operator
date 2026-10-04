import { createHash } from 'node:crypto'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { boucleSchema } from '@conference-operator/contract'
import { readThemeFolder, unzipTheme } from '@conference-operator/projector/server'
import { openHubDatabase, type HubDatabase } from '../src/db.js'
import { exportConfiguration } from '../src/services/config-export.js'
import { createSecretBox } from '../src/secrets.js'
import { GitImportError, GitSourceService, type Cloner } from '../src/services/git-source.js'
import { ThemeStore } from '../src/services/themes.js'

/**
 * The console imports a theme and the loop's content from a folder of a Git
 * branch. The fetch itself is `isomorphic-git`'s; here a fake one lays out a
 * repository, and what is fixed is what the hub does with it.
 */
const CLOUDNORD = join(import.meta.dirname, '..', '..', '..', 'themes', 'cloudnord')
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])

let dir: string
let repo: string
let db: HubDatabase
let themes: ThemeStore
const box = createSecretBox('secret-de-test-secret-de-test-secret-de-test')

/** A repository laid out on disk: the fake fetch copies it, and says which commit. */
const fakeClone = (calls: Parameters<Cloner>[0][] = []): Cloner => async (options) => {
  calls.push(options)
  cpSync(repo, options.dir, { recursive: true })
  return 'abc1234def'
}
const targets = () => ({
  importTheme: (files: Map<string, Uint8Array>) => themes.importFiles(files),
  storeImage: vi.fn(async () => {}),
})
const source = { url: 'https://forge.exemple/evenement/habillage.git', branche: 'main', dossier: 'edition-2026' }

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'hub-git-test-'))
  repo = join(dir, 'repo')
  mkdirSync(join(repo, 'edition-2026', 'images'), { recursive: true })
  cpSync(CLOUDNORD, join(repo, 'edition-2026'), { recursive: true })
  writeFileSync(join(repo, 'edition-2026', 'images', 'sponsor.png'), PNG)
  writeFileSync(
    join(repo, 'edition-2026', 'boucle.json'),
    JSON.stringify({
      merciSponsors: 'Merci à nos\nPartenaires',
      logo: 'images/sponsor.png',
      lienPublic: 'jamais-depuis-un-fichier-0000000',
    }),
  )
  db = openHubDatabase(':memory:').orm
  themes = new ThemeStore(null)
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('the source', () => {
  it('keeps the token sealed and never says it back', () => {
    const service = new GitSourceService(db, box, fakeClone())
    expect(service.status()).toBeNull()
    const status = service.set(source, 'glpat-secret-1234')!
    expect(status).toMatchObject({ ...source, jetonDefini: true, jetonIndice: '1234', derniere: null })
    expect(JSON.stringify(status)).not.toContain('secret')
    // Changing the branch keeps the token; `null` removes it.
    expect(service.set({ ...source, branche: 'preprod' }, undefined)?.jetonDefini).toBe(true)
    expect(service.set(source, null)?.jetonDefini).toBe(false)
    expect(service.set(null, undefined)).toBeNull()
  })

  it('reads the branch with the token', async () => {
    const calls: Parameters<Cloner>[0][] = []
    const service = new GitSourceService(db, box, fakeClone(calls))
    service.set(source, 'glpat-secret-1234')
    await service.import({ theme: true, contenu: false }, targets())
    expect(calls[0]).toMatchObject({ url: source.url, branche: 'main', jeton: 'glpat-secret-1234' })
  })
})

describe('an import', () => {
  it('keeps the folder\'s theme like an uploaded package', async () => {
    const service = new GitSourceService(db, box, fakeClone(), () => new Date('2026-10-03T09:00:00Z'))
    service.set(source, undefined)
    const { result, theme, patch } = await service.import({ theme: true, contenu: false }, targets())
    expect(theme?.id).toBe('cloudnord')
    expect(patch).toBeNull()
    expect(result).toEqual({ le: '2026-10-03T09:00:00.000Z', commit: 'abc1234def', theme: theme!.sha, sections: null, erreur: null })
    expect(service.status()?.derniere).toEqual(result)
  })

  it('brings the loop\'s content, its images stored on the hub', async () => {
    const service = new GitSourceService(db, box, fakeClone())
    service.set(source, undefined)
    const into = targets()
    const { result, patch } = await service.import({ theme: false, contenu: true }, into)
    const ref = patch!.boucle!.logo as string
    expect(ref).toMatch(/^hub-image:[0-9a-f]{64}\.png$/)
    expect(into.storeImage).toHaveBeenCalledWith(ref, PNG, 'image/png')
    expect(patch!.boucle!.merciSponsors).toBe('Merci à nos\nPartenaires')
    // The public link is the console's alone.
    expect(patch!.boucle).not.toHaveProperty('lienPublic')
    expect(result.sections?.sort()).toEqual(['logo', 'merciSponsors'])
  })

  it('refuses a file it cannot read whole, and says why', async () => {
    writeFileSync(join(repo, 'edition-2026', 'boucle.json'), JSON.stringify({ merci: 'x', logo: 'images/absente.png' }))
    const service = new GitSourceService(db, box, fakeClone())
    service.set(source, undefined)
    await expect(service.import({ theme: false, contenu: true }, targets())).rejects.toThrow('sections inconnues — merci')
    writeFileSync(join(repo, 'edition-2026', 'boucle.json'), JSON.stringify({ logo: 'images/absente.png' }))
    await expect(service.import({ theme: false, contenu: true }, targets())).rejects.toThrow('absente du dépôt')
    expect(service.status()?.derniere).toMatchObject({ commit: 'abc1234def', erreur: expect.stringContaining('absente') })
  })

  it('says when the folder holds no theme, or the repository cannot be read', async () => {
    const service = new GitSourceService(db, box, fakeClone())
    service.set({ ...source, dossier: 'ailleurs' }, undefined)
    await expect(service.import({ theme: true, contenu: false }, targets())).rejects.toThrow('Pas de theme.json dans « ailleurs » sur main')
    const unreachable = new GitSourceService(db, box, async () => {
      throw new Error('HTTP Error: 401 Unauthorized')
    })
    await expect(unreachable.import({ theme: true, contenu: false }, targets())).rejects.toThrow(GitImportError)
    expect(unreachable.status()?.derniere?.erreur).toBe('Dépôt illisible (main) : HTTP Error: 401 Unauthorized')
  })
})

describe('the configuration saved to the repository', () => {
  it('comes back as it left: the theme, the content, the images dropped in the console', async () => {
    const theme = themes.importFiles(readThemeFolder(CLOUDNORD))
    const logo = `hub-image:${createHash('sha256').update(PNG).digest('hex')}.png`
    const boucle = boucleSchema.parse({
      logo,
      merciSponsors: 'Merci à nos\nPartenaires',
      theme: { id: theme.id, nom: theme.nom, sha: theme.sha },
      lienPublic: 'jamais-dans-le-depot-000000000',
    })
    const { zip, missing } = await exportConfiguration({
      boucle,
      image: async (ref) => (ref === logo ? { bytes: PNG, contentType: 'image/png' } : null),
      theme: themes.load(theme.sha)!.files,
    })
    expect(missing).toEqual([])

    // Unzipped into the repository's folder, committed, imported back.
    rmSync(join(repo, 'edition-2026'), { recursive: true })
    for (const [path, bytes] of unzipTheme(zip)) {
      mkdirSync(dirname(join(repo, 'edition-2026', path)), { recursive: true })
      writeFileSync(join(repo, 'edition-2026', path), bytes)
    }
    const saved = JSON.parse(readFileSync(join(repo, 'edition-2026', 'boucle.json'), 'utf8')) as Record<string, unknown>
    expect(saved.logo).toMatch(/^images\/[0-9a-f]{16}\.png$/)
    expect(saved).not.toHaveProperty('lienPublic')
    expect(saved).not.toHaveProperty('theme')

    const service = new GitSourceService(db, box, fakeClone())
    service.set(source, undefined)
    const into = targets()
    const imported = await service.import({ theme: true, contenu: true }, into)
    expect(imported.theme?.sha).toBe(theme.sha)
    expect(imported.patch!.boucle!.logo).toBe(logo)
    expect(imported.patch!.boucle!.merciSponsors).toBe('Merci à nos\nPartenaires')
  })
})
