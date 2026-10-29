import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { wallStatsSchema } from '@conference-operator/contract'
import { commentImpression } from '@conference-operator/db/hub'
import { openHubDatabase, type HubDatabase } from '../src/db.js'
import { createHub, type Hub } from '../src/server.js'
import { provisionOperator } from '../src/operators.js'
import { WallService } from '../src/services/wall.js'
import { WallsIoConfig } from '../src/services/wallsio.js'
import { WALLSIO_STATS_TTL_MS, WallStatsService } from '../src/services/wall-stats.js'
import { testSecrets } from './helpers/secrets.js'

const TOKEN = 'wallsio-jeton-secret-abcd'

function fakeWallsIo(answers: Record<string, unknown>) {
  const calls: URL[] = []
  const fetchImpl = vi.fn(async (input: URL | string) => {
    const url = new URL(String(input))
    calls.push(url)
    const answer = answers[url.pathname]
    if (answer instanceof Response) return answer
    if (answer instanceof Error) throw answer
    return new Response(JSON.stringify(answer ?? {}), { status: answer == null ? 404 : 200 })
  }) as unknown as typeof fetch
  return { fetchImpl, calls }
}

const WALLSIO_ANSWERS = {
  '/v1/analytics/posts': { status: 'success', data: { instagram: 12, linkedin: 5, total: 17 } },
  '/v1/analytics/users': { status: 'success', data: { instagram: 7, linkedin: 3, total: 10 } },
  '/v1/posts': {
    status: 'success',
    data: [
      { id: 1, sentiment: 'positive', language: 'fr' },
      { id: 2, sentiment: 'positive', language: 'fr' },
      { id: 3, sentiment: 'negative', language: 'en' },
      { id: 4, sentiment: 'neutral', language: null },
      { id: 5, sentiment: null, language: 'FR' },
    ],
  },
}

let db: HubDatabase
let wall: WallService
let config: WallsIoConfig

beforeEach(() => {
  db = openHubDatabase(':memory:').orm
  wall = new WallService(db)
  config = new WallsIoConfig(db, testSecrets)
})

function seedWall() {
  // walls.io's posts arrive approved; 23:30 UTC on the 29th is the 30th in Paris.
  const video = wall.post({
    source: 'wallsio',
    externalId: 'w1',
    author: 'Anne',
    text: 'Une vidéo du stand',
    network: 'LinkedIn',
    image: 'https://cdn.exemple/still.jpg',
    video: 'https://cdn.exemple/clip.mp4',
    postedAt: '2026-10-29T23:30:00.000Z',
  })
  const photo = wall.post({
    source: 'wallsio',
    externalId: 'w2',
    author: 'Bruno',
    text: 'La salle est pleine',
    network: 'Instagram',
    image: 'https://cdn.exemple/photo.jpg',
    postedAt: '2026-10-30T09:00:00.000Z',
  })
  const text = wall.post({
    source: 'wallsio',
    externalId: 'w3',
    author: 'Chloé',
    text: 'Merci #CloudNord2026',
    network: 'Instagram',
    postedAt: '2026-10-29T10:00:00.000Z',
  })
  // The form's: no network, so its source; one published, one still waiting.
  const form = wall.post({ source: 'form', author: 'Dani', text: 'Bravo !' })
  wall.moderate(form.id, 'approve', 'regie@cloudnord.fr')
  wall.post({ source: 'form', author: 'Eve', text: 'Pas encore relu' })

  db.insert(commentImpression)
    .values([
      { commentId: photo.id, roomId: 'track-1', day: '2026-10-30', count: 30, lastShownAt: '2026-10-30T10:00:00.000Z' },
      { commentId: photo.id, roomId: 'track-2', day: '2026-10-30', count: 12, lastShownAt: '2026-10-30T10:00:00.000Z' },
      { commentId: video.id, roomId: 'track-1', day: '2026-10-30', count: 5, lastShownAt: '2026-10-30T10:00:00.000Z' },
    ])
    .run()
  wall.addOnlineViews({ [text.id]: 9, [video.id]: 4 }, '2026-10-30T10:00:00.000Z')
  return { video, photo, text, form }
}

describe('the wall in figures, from the hub', () => {
  it('counts the published posts per network, day and medium, and their displays', async () => {
    const { video, photo, text } = seedWall()
    const stats = await new WallStatsService({ db, config }).stats()

    expect(wallStatsSchema.parse(stats)).toEqual(stats)
    expect(stats.posts.total).toBe(4)
    expect(stats.posts.byNetwork).toEqual([
      { label: 'Instagram', count: 2 },
      { label: 'form', count: 1 },
      { label: 'LinkedIn', count: 1 },
    ])
    expect(stats.posts.byMedia).toEqual({ video: 1, photo: 1, text: 2 })
    const days = stats.posts.byDay.map((entry) => entry.day)
    expect(days).toEqual([...days].sort())
    expect(stats.posts.byDay.find((entry) => entry.day === '2026-10-29')?.count).toBe(1)
    expect(stats.posts.byDay.find((entry) => entry.day === '2026-10-30')!.count).toBeGreaterThanOrEqual(2)

    expect(stats.impressions.total).toBe(47)
    expect(stats.impressions.top.map((post) => [post.id, post.count])).toEqual([
      [photo.id, 42],
      [video.id, 5],
    ])
    expect(stats.impressions.top[0]).toMatchObject({ author: 'Bruno', network: 'Instagram', text: 'La salle est pleine' })
    expect(stats.onlineViews.total).toBe(13)
    expect(stats.onlineViews.top.map((post) => [post.id, post.count])).toEqual([
      [text.id, 9],
      [video.id, 4],
    ])
  })
})

describe('the wall in figures, from walls.io', () => {
  it('maps its analytics and its latest posts, and keeps them five minutes', async () => {
    config.setToken(TOKEN)
    let now = Date.parse('2026-10-30T10:00:00Z')
    const { fetchImpl, calls } = fakeWallsIo(WALLSIO_ANSWERS)
    const service = new WallStatsService({ db, config, fetchImpl, now: () => now })

    const stats = await service.stats()
    expect(stats.wallsioError).toBeNull()
    expect(stats.wallsio).toEqual({
      fetchedAt: '2026-10-30T10:00:00.000Z',
      posts: { total: 17, byNetwork: [{ label: 'Instagram', count: 12 }, { label: 'LinkedIn', count: 5 }] },
      authors: { total: 10, byNetwork: [{ label: 'Instagram', count: 7 }, { label: 'LinkedIn', count: 3 }] },
      sentiment: { positive: 2, neutral: 1, negative: 1, unknown: 1 },
      languages: [
        { label: 'fr', count: 3 },
        { label: 'en', count: 1 },
        { label: 'non détectée', count: 1 },
      ],
      sampled: 5,
    })
    expect(calls.map((url) => url.pathname).sort()).toEqual(['/v1/analytics/posts', '/v1/analytics/users', '/v1/posts'])
    expect(calls.every((url) => url.searchParams.get('access_token') === TOKEN)).toBe(true)
    const sample = calls.find((url) => url.pathname === '/v1/posts')!
    expect(sample.searchParams.get('limit')).toBe('1000')
    expect(sample.searchParams.get('fields')).toBe('id,sentiment,language')

    now += WALLSIO_STATS_TTL_MS - 1
    await service.stats()
    expect(calls).toHaveLength(3)
    now += 2
    await service.stats()
    expect(calls).toHaveLength(6)
  })

  it('answers without walls.io when it fails, has no token or is paused', async () => {
    seedWall()
    const noToken = await new WallStatsService({ db, config, fetchImpl: fakeWallsIo({}).fetchImpl }).stats()
    expect(noToken).toMatchObject({ wallsio: null, wallsioError: expect.stringContaining('Aucun jeton') })
    expect(noToken.posts.total).toBe(4)

    config.setToken(TOKEN)
    const failing = fakeWallsIo({ ...WALLSIO_ANSWERS, '/v1/analytics/users': new Response('{}', { status: 500 }) })
    const failed = await new WallStatsService({ db, config, fetchImpl: failing.fetchImpl }).stats()
    expect(failed).toMatchObject({ wallsio: null, wallsioError: 'walls.io : a répondu 500' })
    expect(failed.impressions.total).toBe(47)

    const timeout = Object.assign(new Error('The operation timed out.'), { name: 'TimeoutError' })
    const slow = fakeWallsIo({ ...WALLSIO_ANSWERS, '/v1/posts': timeout })
    expect(await new WallStatsService({ db, config, fetchImpl: slow.fetchImpl }).stats()).toMatchObject({
      wallsio: null,
      wallsioError: "walls.io n'a pas répondu à temps",
    })

    config.setPaused(true)
    const paused = fakeWallsIo(WALLSIO_ANSWERS)
    expect(await new WallStatsService({ db, config, fetchImpl: paused.fetchImpl }).stats()).toMatchObject({
      wallsio: null,
      wallsioError: expect.stringContaining('pause'),
    })
    expect(paused.calls).toHaveLength(0)
  })
})

describe('wall.stats, over HTTP', () => {
  const OPERATOR = { email: 'regie@cloudnord.fr', name: 'Régie', password: 'control-password-2026' }
  const MOBILE = { email: 'mobile@cloudnord.fr', name: 'Mobile', password: 'mobile-password-2026' }
  let hub: Hub
  let origin: string

  beforeEach(async () => {
    hub = await createHub({
      port: 0,
      host: '127.0.0.1',
      databasePath: ':memory:',
      publicUrl: 'http://127.0.0.1',
      authSecret: 'test-secret-'.padEnd(48, 'x'),
      logLevel: 'fatal',
    })
    await hub.app.listen({ port: 0, host: '127.0.0.1' })
    const address = hub.app.server.address()
    origin = `http://127.0.0.1:${typeof address === 'object' && address != null ? address.port : 0}`
    await provisionOperator(hub.auth, OPERATOR)
    await provisionOperator(hub.auth, { ...MOBILE, roles: ['regieMobile'] })
  })

  afterEach(async () => {
    await hub.close()
  })

  async function signIn(account: { email: string; password: string }): Promise<string> {
    const response = await fetch(`${origin}/api/auth/sign-in/email`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: account.email, password: account.password }),
    })
    return ((await response.json()) as { token: string }).token
  }

  async function readStats(token: string) {
    const response = await fetch(`${origin}/rpc/wall/stats`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ json: null }),
    })
    return { status: response.status, body: (await response.json()) as { json: unknown } }
  }

  it('answers a moderator, with walls.io failing, and refuses who cannot moderate', async () => {
    hub.services.wall.post({ source: 'wallsio', externalId: 'w1', author: 'Anne', text: 'Bonjour', network: 'Instagram' })
    // With a token, the hub goes out to walls.io: the test setup cuts outgoing network, as an outage would.
    hub.services.wallsIo.config.setToken(TOKEN)

    const answered = await readStats(await signIn(OPERATOR))
    expect(answered.status).toBe(200)
    const stats = wallStatsSchema.parse(answered.body.json)
    expect(stats.posts).toMatchObject({ total: 1, byNetwork: [{ label: 'Instagram', count: 1 }] })
    expect(stats.wallsio).toBeNull()
    expect(stats.wallsioError).toMatch(/^walls\.io injoignable/)
    expect(hub.services.audit.list().filter((entry) => entry.action === 'wall.stats')).toEqual([])

    expect((await readStats(await signIn(MOBILE))).status).toBe(403)
  })
})
