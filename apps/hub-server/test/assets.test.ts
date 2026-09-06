import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { normalizeProgram } from '@conference-operator/program'
import { openHubDatabase, type HubDatabase } from '../src/db.js'
import { AssetStore } from '../src/services/assets.js'

/**
 * The hub holds the programme's images so the rooms stop fetching them from the
 * internet. What these tests fix is what a room depends on: the hash it can
 * compute itself, and a failure that is a row rather than a log line.
 */
const LOGO = 'https://cdn.exemple/logo.png'
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
      id: 's1',
      title: 'Talk',
      dateStart: '2026-10-30T09:00:00.000+00:00',
      speakerIds: ['spk-1'],
      trackId: 'room-a',
    },
  ],
  sponsors: [],
})

function fakeNetwork(available: Record<string, string> = { [LOGO]: 'PNG', [PHOTO]: 'JPG' }) {
  const calls: string[] = []
  const fetchImpl = vi.fn(async (input: Parameters<typeof fetch>[0]) => {
    const url = String(input)
    calls.push(url)
    const body = available[url]
    if (body == null) return new Response('nope', { status: 403 })
    return new Response(body, { status: 200, headers: { 'content-type': 'image/png' } })
  })
  return { fetchImpl: fetchImpl as unknown as typeof fetch, calls }
}

const hashOf = (url: string) => createHash('sha256').update(url).digest('hex')

let db: HubDatabase
let dir: string
let assets: AssetStore

beforeEach(() => {
  db = openHubDatabase(':memory:').orm
  dir = mkdtempSync(join(tmpdir(), 'hub-assets-'))
  assets = new AssetStore(db, join(dir, 'assets'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('the hub as an image store', () => {
  it('downloads what the programme names, once', async () => {
    const network = fakeNetwork()

    const first = await assets.prefetch(program, network.fetchImpl)
    expect(first.downloaded).toBe(2)
    expect(first.failed).toEqual([])

    // A restart, or a second import of the same programme: nothing leaves again.
    const again = await assets.prefetch(program, network.fetchImpl)
    expect(again.reused).toBe(2)
    expect(again.downloaded).toBe(0)
    expect(network.calls).toHaveLength(2)
  })

  it('serves them under the hash of the source URL', async () => {
    // The key a room computes on its side, with nothing having travelled to tell
    // it what to ask for.
    await assets.prefetch(program, fakeNetwork().fetchImpl)

    const file = await assets.read(hashOf(LOGO))
    expect(file?.bytes.toString()).toBe('PNG')
    expect(file?.contentType).toBe('image/png')
  })

  it('answers nothing for a hash it does not hold', async () => {
    expect(await assets.read(hashOf('https://cdn.exemple/jamais-vue.png'))).toBeNull()
  })

  it('records a refusal instead of losing it in a log', async () => {
    /*
     * The export of the day carried an image answering 403. Each room retried it
     * at every sync, failed, and nobody on the hub side knew. It is a row now,
     * and the console can name it — the one place from which an export gets
     * corrected.
     */
    const network = fakeNetwork({ [PHOTO]: 'JPG' })

    const report = await assets.prefetch(program, network.fetchImpl)

    expect(report.downloaded).toBe(1)
    expect(report.failed).toEqual([{ url: LOGO, reason: 'HTTP 403' }])
    expect(assets.failures().map((failure) => failure.url)).toEqual([LOGO])
    expect(await assets.read(hashOf(LOGO))).toBeNull()
  })

  it('retries a failure at the next import, having stored nothing', async () => {
    await assets.prefetch(program, fakeNetwork({ [PHOTO]: 'JPG' }).fetchImpl)

    // The image comes back upstream: a recorded failure must not become a
    // permanent one.
    const repaired = fakeNetwork()
    const report = await assets.prefetch(program, repaired.fetchImpl)

    expect(report.downloaded).toBe(1)
    expect(assets.failures()).toEqual([])
    expect((await assets.read(hashOf(LOGO)))?.bytes.toString()).toBe('PNG')
  })

  it('gives up on an image server that never answers', async () => {
    // `fetch` sets no ceiling of its own: one silent host would otherwise hold
    // the import open with no way out.
    const hanging = vi.fn(
      async (_input: Parameters<typeof fetch>[0], init?: RequestInit) =>
        await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('TimeoutError')))
        }),
    ) as unknown as typeof fetch
    const impatient = new AssetStore(db, join(dir, 'impatient'), 20)

    const report = await impatient.prefetch(program, hanging)

    expect(report.downloaded).toBe(0)
    expect(report.failed).toHaveLength(2)
  })
})
