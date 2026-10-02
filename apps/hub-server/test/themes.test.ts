import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { strToU8, zipSync } from 'fflate'
import { readThemeFolder, ThemePackageError, zipTheme } from '@conference-operator/projector/server'
import { openHubDatabase, type OpenHubDbResult } from '../src/db.js'
import { SettingsService } from '../src/services/sessions.js'
import { ThemeStore } from '../src/services/themes.js'

/**
 * The hub keeps the loop's theme packages for the console to choose and the
 * rooms to fetch. What these tests fix: a package is kept once whatever zipped
 * it, a bad one is refused with its reasons, and a hub that predates themes
 * keeps the look it projected.
 */
const SHIPPED = join(import.meta.dirname, '..', '..', '..', 'themes')

let dir: string
let themes: ThemeStore
let db: OpenHubDbResult

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'hub-themes-'))
  themes = new ThemeStore(join(dir, 'themes'), () => new Date('2026-10-01T08:00:00Z'))
  db = openHubDatabase(':memory:')
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('the packages kept', () => {
  it('seeds the shipped themes once', () => {
    const [cloudnord] = themes.seed(SHIPPED)
    expect(cloudnord).toMatchObject({ id: 'cloudnord', nom: 'Cloud Nord', importeLe: '2026-10-01T08:00:00.000Z' })
    expect(themes.seed(SHIPPED)).toEqual([cloudnord])
    expect(themes.list()).toEqual([cloudnord])
  })

  it('keeps the same content once, whatever tool zipped it', () => {
    const files = readThemeFolder(join(SHIPPED, 'cloudnord'))
    const canonical = themes.import(zipTheme(files))
    // Another archiver: its own order, its own dates, a folder around it.
    const other = zipSync(Object.fromEntries([...files].reverse().map(([path, bytes]) => [`cloudnord/${path}`, bytes])))
    expect(themes.import(other)).toEqual(canonical)
    expect(themes.list()).toHaveLength(1)
  })

  it('serves its fonts and images, and nothing else', () => {
    const { sha } = themes.seed(SHIPPED)[0]!
    expect(themes.file(sha, 'fonts/PeaceSans.otf')?.type).toBe('font/otf')
    expect(themes.file(sha, 'theme.json')).toBeNull()
    expect(themes.file(sha, 'fonts/OFL-PeaceSans.txt')).toBeNull()
    expect(themes.load(sha)?.bundle.manifest.id).toBe('cloudnord')
  })

  it('refuses a bad package with every reason', () => {
    const bad = zipSync({ 'theme.json': strToU8(JSON.stringify({ apiVersion: 1, id: 'x', nom: 'X', css: 'a.css' })), 'a.css': strToU8('@import "b.css";') })
    expect(() => themes.import(bad)).toThrow(ThemePackageError)
    expect(themes.list()).toEqual([])
  })

  it('stays in memory for a hub that does', () => {
    const ephemeral = new ThemeStore(null)
    const { sha } = ephemeral.seed(SHIPPED)[0]!
    expect(ephemeral.list().map((theme) => theme.id)).toEqual(['cloudnord'])
    expect(ephemeral.load(sha)?.bundle.manifest.id).toBe('cloudnord')
    ephemeral.remove(sha)
    expect(ephemeral.list()).toEqual([])
  })

  it('forgets a package', () => {
    const { sha } = themes.seed(SHIPPED)[0]!
    themes.remove(sha)
    expect(themes.list()).toEqual([])
    expect(themes.zip(sha)).toBeNull()
  })
})

describe('a hub from before themes', () => {
  const ref = { id: 'cloudnord', nom: 'Cloud Nord', sha: 'a'.repeat(64) }

  it('keeps Cloud Nord, which it projected', () => {
    const settings = new SettingsService(db.orm)
    settings.update({ eventName: 'CN' })
    // Saved before the key existed: written without it.
    db.sqlite.prepare("UPDATE hub_setting SET value_json = json_remove(value_json, '$.boucle.theme')").run()
    expect(settings.adoptLegacyTheme(ref)).toEqual(ref)
    expect(settings.get().boucle.theme).toEqual(ref)
    // Once: the key is written now.
    expect(settings.adoptLegacyTheme(ref)).toBeNull()
  })

  it('leaves a fresh hub, and a choice made, alone', () => {
    const settings = new SettingsService(db.orm)
    expect(settings.adoptLegacyTheme(ref)).toBeNull()
    expect(settings.get().boucle.theme).toBeNull()
    settings.update({ boucle: { theme: null } })
    expect(settings.adoptLegacyTheme(ref)).toBeNull()
    expect(settings.get().boucle.theme).toBeNull()
  })
})
