import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readThemeFolder, themeSha, zipTheme } from '@conference-operator/projector/server'
import { ThemeCache } from '../src/core/themes.js'

/**
 * The room fetches the loop's theme from the hub once, by its sha, and keeps it:
 * a room started offline wears yesterday's theme rather than the default one.
 */
const ZIP = zipTheme(readThemeFolder(join(import.meta.dirname, '..', '..', '..', 'themes', 'cloudnord')))
const SHA = themeSha(ZIP)
const REF = { id: 'cloudnord', nom: 'Cloud Nord', sha: SHA }

const hub = (body: Uint8Array | null) => {
  const fetchImpl = vi.fn(async () => (body == null ? new Response('absent', { status: 404 }) : new Response(body as BodyInit)))
  return fetchImpl as unknown as typeof fetch & typeof fetchImpl
}

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'room-themes-'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('the theme the hub chose', () => {
  it('is fetched once, then worn from the room', async () => {
    const cache = new ThemeCache(dir, 'http://hub:8787/')
    const fetchImpl = hub(ZIP)
    expect(cache.source(REF)).toBeNull()
    expect(await cache.ensure(REF, fetchImpl)).toBe('telecharge')
    expect(fetchImpl).toHaveBeenCalledWith(`http://hub:8787/boucle/theme/${SHA}.zip`, expect.anything())
    expect(await cache.ensure(REF, fetchImpl)).toBe('present')
    expect(fetchImpl).toHaveBeenCalledTimes(1)

    const source = cache.source(REF)!
    expect(source).toMatchObject({ base: `/display/theme/${SHA}`, sha: SHA })
    expect(source.bundle.manifest.id).toBe('cloudnord')
    expect(cache.file(SHA, 'fonts/Pacifico.ttf')?.type).toBe('font/ttf')
  })

  it('stays when the hub is gone', async () => {
    await new ThemeCache(dir, 'http://hub:8787').ensure(REF, hub(ZIP))
    const offline = new ThemeCache(dir, null)
    expect(await offline.ensure(REF)).toBe('present')
    expect(offline.source(REF)?.sha).toBe(SHA)
  })

  it('refuses bytes that are not the package announced', async () => {
    const cache = new ThemeCache(dir, 'http://hub:8787')
    const other = { ...REF, sha: 'b'.repeat(64) }
    expect(await cache.ensure(other, hub(ZIP))).toBe('echec')
    expect(cache.source(other)).toBeNull()
    expect(await cache.ensure(REF, hub(null))).toBe('echec')
  })

  it('is the default one when none is chosen', async () => {
    const cache = new ThemeCache(dir, 'http://hub:8787')
    expect(await cache.ensure(null)).toBe('aucun')
    expect(cache.source(null)).toBeNull()
  })
})
