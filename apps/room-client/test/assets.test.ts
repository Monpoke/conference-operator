import { createHash } from 'node:crypto'
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

/**
 * Where the bytes come from.
 *
 * The programme reaches a room from the hub; its images used to come from the
 * upstream export, which made a room depend on reaching the internet — the one
 * thing the rest of it promises it does not. The hub now holds them.
 */
describe('the hub as the source', () => {
  const HUB = 'https://hub.exemple.fr'
  const hashOf = (url: string) => createHash('sha256').update(url).digest('hex')

  it('asks the hub, and never the source, when the hub answers', async () => {
    const network = fakeNetwork({
      [`${HUB}/assets/${hashOf(LOGO)}`]: 'PNG-BYTES',
      [`${HUB}/assets/${hashOf(PHOTO)}`]: 'JPG-BYTES',
    })
    const viaHub = new AssetCache(store, join(dir, 'assets'), HUB)

    const report = await viaHub.prefetch(program, network.fetchImpl)

    expect(report.downloaded).toBe(2)
    expect(report.fromHub).toBe(2)
    expect(report.fromUpstream).toBe(0)
    // The point of the whole change: the room went nowhere near the export.
    expect(network.calls.some((url) => url === LOGO || url === PHOTO)).toBe(false)
  })

  it('falls back to the source, and counts it', async () => {
    // A hub that has not imported this programme yet answers 404 — not an
    // incident, but a room that still needs the internet, and that has to show.
    const network = fakeNetwork({ [LOGO]: 'PNG-BYTES', [PHOTO]: 'JPG-BYTES' })
    const viaHub = new AssetCache(store, join(dir, 'assets'), HUB)

    const report = await viaHub.prefetch(program, network.fetchImpl)

    expect(report.downloaded).toBe(2)
    expect(report.fromHub).toBe(0)
    expect(report.fromUpstream).toBe(2)
    expect(network.calls).toContain(LOGO)
  })

  it('takes back the files when the database went without them', async () => {
    // `pnpm reset:dev` empties `salle.db` and keeps the images: the point is that
    // a room then downloads nothing, neither from the hub nor from the export.
    const network = fakeNetwork()
    await new AssetCache(store, join(dir, 'assets')).prefetch(program, network.fetchImpl)
    expect(network.calls).toHaveLength(2)

    const emptied = new AssetCache(new LocalStore(':memory:'), join(dir, 'assets'), HUB)
    const after = fakeNetwork()
    const report = await emptied.prefetch(program, after.fetchImpl)

    expect(report.reused).toBe(2)
    expect(after.calls).toEqual([])
    expect(emptied.lookup(LOGO)?.contentType).toBe('image/png')
  })

  it('keys an image the same way whichever side supplied it', async () => {
    /*
     * The regression that would cost the most: keying on the address the bytes
     * came from would give two entries for one image, and would make every cache
     * already filled from upstream useless the day the hub starts serving them.
     */
    const upstream = new AssetCache(store, join(dir, 'assets'))
    await upstream.fetchOne(LOGO, fakeNetwork().fetchImpl)
    const first = upstream.lookup(LOGO)

    const viaHub = new AssetCache(store, join(dir, 'assets'), HUB)
    const hubNetwork = fakeNetwork({ [`${HUB}/assets/${hashOf(LOGO)}`]: 'PNG-BYTES' })
    const report = await viaHub.prefetch(program, hubNetwork.fetchImpl)

    expect(first?.sha256).toBe(hashOf(LOGO))
    // Already held: the hub is not even asked for it.
    expect(hubNetwork.calls).not.toContain(`${HUB}/assets/${hashOf(LOGO)}`)
    expect(report.reused).toBeGreaterThanOrEqual(1)
    expect(viaHub.lookup(LOGO)?.sha256).toBe(first?.sha256)
  })
})
