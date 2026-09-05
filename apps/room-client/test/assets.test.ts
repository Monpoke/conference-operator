import { mkdtempSync, rmSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { normalizeProgram } from '@conference-operator/program'
import { AssetCache } from '../src/core/assets.js'
import { LocalStore } from '../src/core/store.js'

const LOGO = 'https://cdn.exemple/logo-cloudnord.png'
const PHOTO = 'https://cdn.exemple/speakers/alice.jpg'

const program = normalizeProgram({
  event: {
    id: 'evt',
    name: 'Cloud Nord',
    logoUrl: LOGO,
    tracks: [{ id: 'room-a', name: 'Salle A' }],
  },
  speakers: [{ id: 'spk-1', name: 'Alice', photoUrl: PHOTO }],
  sessions: [
    {
      id: 'ses-1',
      title: 'Talk',
      dateStart: '2026-10-30T09:00:00.000+00:00',
      speakerIds: ['spk-1'],
      trackId: 'room-a',
    },
  ],
  sponsors: [
    { id: 't1', name: 'Gold', order: 0, sponsors: [{ id: 's1', name: 'ACME', logoUrl: LOGO }] },
  ],
})

/** Simulated network: counts the calls to prove the cache avoids the round trips. */
function fakeNetwork(available: Record<string, string> = { [LOGO]: 'PNG-BYTES', [PHOTO]: 'JPG-BYTES' }) {
  const calls: string[] = []
  const fetchImpl = vi.fn(async (input: Parameters<typeof fetch>[0]) => {
    const url = String(input)
    calls.push(url)
    const body = available[url]
    if (body == null) return new Response('not found', { status: 404 })
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

describe('asset cache', () => {
  it('downloads each asset only once', async () => {
    const network = fakeNetwork()

    const first = await cache.prefetch(program, network.fetchImpl)
    expect(first.downloaded).toBe(2)
    expect(first.failed).toEqual([])

    // Second start-up: nothing left to download.
    const second = await cache.prefetch(program, network.fetchImpl)
    expect(second).toMatchObject({ downloaded: 0, reused: 2 })
    expect(network.calls).toHaveLength(2)
  })

  it('serves the content from disk', async () => {
    const network = fakeNetwork()
    const ref = await cache.fetchOne(LOGO, network.fetchImpl)

    const read = await cache.read(ref.sha256)
    expect(read?.bytes.toString()).toBe('PNG-BYTES')
    expect(read?.contentType).toBe('image/png')
    // The original extension is kept: OBS and browsers rely on it.
    expect(await readFile(join(dir, 'assets', `${ref.sha256}.png`), 'utf8')).toBe('PNG-BYTES')
  })

  it('rewrites the program URLs towards the local cache', async () => {
    const network = fakeNetwork()
    await cache.prefetch(program, network.fetchImpl)

    const localized = cache.localize(program)
    // No remote URL may survive: that is what guarantees a network cut does not
    // put a broken logo on the projector.
    expect(localized.event.logoUrl).toMatch(/^\/assets\/[0-9a-f]{64}$/)
    expect(localized.sponsorTiers[0]!.sponsors[0]!.logoUrl).toMatch(/^\/assets\//)
    expect(localized.speakers[0]!.photoUrl).toMatch(/^\/assets\//)
    // Including on the speakers nested inside the sessions.
    expect(localized.sessions[0]!.speakers[0]!.photoUrl).toMatch(/^\/assets\//)
  })

  it('does not prevent start-up when an asset cannot be found', async () => {
    const network = fakeNetwork({ [PHOTO]: 'JPG-BYTES' })

    const report = await cache.prefetch(program, network.fetchImpl)
    expect(report.downloaded).toBe(1)
    expect(report.failed).toHaveLength(1)
    expect(report.failed[0]?.url).toBe(LOGO)

    // The original URL is kept: if the link is still reachable at display time,
    // better to try than to show a dead image.
    expect(cache.localize(program).event.logoUrl).toBe(LOGO)
  })

  it('does not publish an interrupted download', async () => {
    const failing = vi.fn(async () => {
      throw new Error('connection lost')
    }) as unknown as typeof fetch

    await expect(cache.fetchOne(LOGO, failing)).rejects.toThrow('connection lost')
    // Nothing is recorded: the cache must not believe it holds a truncated file.
    expect(cache.lookup(LOGO)).toBeNull()
  })
})
