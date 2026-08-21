import { mkdtempSync, rmSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { normalizeProgram } from '@cloudnord/program'
import { AssetCache } from '../src/core/assets.js'
import { LocalStore } from '../src/core/store.js'

const LOGO = 'https://cdn.exemple/logo-cloudnord.png'
const PHOTO = 'https://cdn.exemple/speakers/alice.jpg'

const program = normalizeProgram({
  event: {
    id: 'evt',
    name: 'Cloud Nord',
    logoUrl: LOGO,
    tracks: [{ id: 'salle-a', name: 'Salle A' }],
  },
  speakers: [{ id: 'spk-1', name: 'Alice', photoUrl: PHOTO }],
  sessions: [
    {
      id: 'ses-1',
      title: 'Talk',
      dateStart: '2026-10-30T09:00:00.000+00:00',
      speakerIds: ['spk-1'],
      trackId: 'salle-a',
    },
  ],
  sponsors: [
    { id: 't1', name: 'Gold', order: 0, sponsors: [{ id: 's1', name: 'ACME', logoUrl: LOGO }] },
  ],
})

/** Réseau simulé : compte les appels pour prouver que le cache évite les allers-retours. */
function fakeNetwork(available: Record<string, string> = { [LOGO]: 'PNG-OCTETS', [PHOTO]: 'JPG-OCTETS' }) {
  const calls: string[] = []
  const fetchImpl = vi.fn(async (input: Parameters<typeof fetch>[0]) => {
    const url = String(input)
    calls.push(url)
    const body = available[url]
    if (body == null) return new Response('introuvable', { status: 404 })
    return new Response(body, { status: 200, headers: { 'content-type': 'image/png' } })
  })
  return { fetchImpl: fetchImpl as unknown as typeof fetch, calls }
}

let dir: string
let store: LocalStore
let cache: AssetCache

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cloudnord-assets-'))
  store = new LocalStore(':memory:')
  cache = new AssetCache(store, join(dir, 'assets'))
})

afterEach(() => {
  store.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('cache d\'assets', () => {
  it('télécharge chaque asset une seule fois', async () => {
    const network = fakeNetwork()

    const first = await cache.prefetch(program, network.fetchImpl)
    expect(first.downloaded).toBe(2)
    expect(first.failed).toEqual([])

    // Deuxième démarrage : plus rien à télécharger.
    const second = await cache.prefetch(program, network.fetchImpl)
    expect(second).toMatchObject({ downloaded: 0, reused: 2 })
    expect(network.calls).toHaveLength(2)
  })

  it('sert le contenu depuis le disque', async () => {
    const network = fakeNetwork()
    const ref = await cache.fetchOne(LOGO, network.fetchImpl)

    const read = await cache.read(ref.sha256)
    expect(read?.bytes.toString()).toBe('PNG-OCTETS')
    expect(read?.contentType).toBe('image/png')
    // L'extension d'origine est conservée : OBS et les navigateurs s'y fient.
    expect(await readFile(join(dir, 'assets', `${ref.sha256}.png`), 'utf8')).toBe('PNG-OCTETS')
  })

  it('réécrit les URLs du programme vers le cache local', async () => {
    const network = fakeNetwork()
    await cache.prefetch(program, network.fetchImpl)

    const localized = cache.localize(program)
    // Aucune URL distante ne doit subsister : c'est la garantie qu'une coupure
    // ne fait pas apparaître de logo cassé sur le vidéoprojecteur.
    expect(localized.event.logoUrl).toMatch(/^\/assets\/[0-9a-f]{64}$/)
    expect(localized.sponsorTiers[0]!.sponsors[0]!.logoUrl).toMatch(/^\/assets\//)
    expect(localized.speakers[0]!.photoUrl).toMatch(/^\/assets\//)
    // Y compris sur les speakers imbriqués dans les sessions.
    expect(localized.sessions[0]!.speakers[0]!.photoUrl).toMatch(/^\/assets\//)
  })

  it('n\'empêche pas le démarrage quand un asset est introuvable', async () => {
    const network = fakeNetwork({ [PHOTO]: 'JPG-OCTETS' })

    const report = await cache.prefetch(program, network.fetchImpl)
    expect(report.downloaded).toBe(1)
    expect(report.failed).toHaveLength(1)
    expect(report.failed[0]?.url).toBe(LOGO)

    // L'URL d'origine est conservée : si le lien est encore joignable au moment
    // de l'affichage, autant tenter plutôt que de montrer une image morte.
    expect(cache.localize(program).event.logoUrl).toBe(LOGO)
  })

  it('ne publie pas un téléchargement interrompu', async () => {
    const failing = vi.fn(async () => {
      throw new Error('connexion coupée')
    }) as unknown as typeof fetch

    await expect(cache.fetchOne(LOGO, failing)).rejects.toThrow('connexion coupée')
    // Rien n'est enregistré : le cache ne doit pas croire détenir un fichier tronqué.
    expect(cache.lookup(LOGO)).toBeNull()
  })
})
