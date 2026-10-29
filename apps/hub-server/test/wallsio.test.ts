import { beforeEach, describe, expect, it, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import { comment, hubSetting } from '@conference-operator/db/hub'
import { openHubDatabase, type HubDatabase } from '../src/db.js'
import { WallService } from '../src/services/wall.js'
import { SocialIngestor } from '../src/services/social.js'
import { SettingsService } from '../src/services/sessions.js'
import { WallsIoConfig, backoffDelay, wallsioSource } from '../src/services/wallsio.js'
import { migrateLegacyMur } from '../src/services/legacy-mur.js'
import { testSecrets } from './helpers/secrets.js'

const TOKEN = 'wallsio-jeton-secret-abcd'
const NOW = Date.parse('2026-10-30T10:00:00Z')

let db: HubDatabase
let wall: WallService
let config: WallsIoConfig

beforeEach(() => {
  db = openHubDatabase(':memory:').orm
  wall = new WallService(db)
  config = new WallsIoConfig(db, testSecrets)
})

function post(id: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    comment: `Post ${id} &amp; #CloudNord`,
    type: 'instagram',
    external_name: 'anne',
    external_fullname: 'Anne Dupont',
    external_image_cdn: `https://cdn.walls.io/avatar-${id}`,
    post_image_cdn: `https://cdn.walls.io/image-${id}`,
    is_pinned: false,
    status: true,
    permalink: `https://instagram.com/p/${id}`,
    created_timestamp: 1_792_000_000,
    ...extra,
  }
}

/** A walls.io that answers what it is given, in turn, and remembers what it was asked. */
function fakeApi(...answers: unknown[]) {
  const calls: URL[] = []
  const fetchImpl = vi.fn(async (input: URL | string) => {
    calls.push(new URL(String(input)))
    const answer = answers.shift()
    if (answer instanceof Response) return answer
    return new Response(JSON.stringify(answer), { status: 200 })
  }) as unknown as typeof fetch
  return { fetchImpl, calls }
}

describe('walls.io token', () => {
  it('is stored sealed, and only its last characters come back', () => {
    config.setToken(TOKEN)

    const row = db.select().from(hubSetting).where(eq(hubSetting.key, 'wallsio')).get()
    expect(row?.valueJson).not.toContain(TOKEN)
    expect(config.token()).toBe(TOKEN)
    expect(config.status(0)).toMatchObject({ hasToken: true, tokenHint: 'abcd' })
    expect(JSON.stringify(config.status(0))).not.toContain(TOKEN)
  })

  it('reads as absent when the hub secret changed', async () => {
    config.setToken(TOKEN)
    const { createSecretBox } = await import('../src/secrets.js')
    const other = new WallsIoConfig(db, createSecretBox('un-autre-secret-tout-aussi-long'))

    expect(other.token()).toBeNull()
    expect(other.status(0).hasToken).toBe(false)
  })
})

describe('walls.io source', () => {
  it('makes no call without a token', async () => {
    const { fetchImpl } = fakeApi()
    expect(await wallsioSource({ config, fetchImpl }).poll()).toEqual([])
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('starts from the latest posts, then asks what changed since', async () => {
    config.setToken(TOKEN)
    const { fetchImpl, calls } = fakeApi(
      { status: 'success', data: [post('2'), post('1')] },
      { status: 'success', current_time: 1_792_000_500, count: 0, data: [] },
    )
    const source = wallsioSource({ config, fetchImpl, now: () => NOW })

    const first = await source.poll()
    expect(calls[0]?.pathname).toBe('/v1/posts')
    expect(calls[0]?.searchParams.get('access_token')).toBe(TOKEN)
    expect(first.map((entry) => entry.externalId)).toEqual(['2', '1'])
    expect(first[0]).toMatchObject({
      source: 'wallsio',
      author: 'Anne Dupont',
      authorHandle: 'anne',
      text: 'Post 2 & #CloudNord',
      avatar: 'https://cdn.walls.io/avatar-2',
      image: 'https://cdn.walls.io/image-2',
      network: 'Instagram',
      active: true,
      pinned: false,
    })

    await source.poll()
    expect(calls[1]?.pathname).toBe('/v1/posts/changed')
    expect(calls[1]?.searchParams.get('since')).toBe(String(Math.floor(NOW / 1000) - 120))
    expect(calls[1]?.searchParams.get('include_inactive')).toBe('1')
    // The server's own time is the next `since`.
    expect(config.cursor()).toBe(1_792_000_500)
  })

  it('names a refused token in words the console can show', async () => {
    config.setToken(TOKEN)
    const { fetchImpl } = fakeApi(new Response('nope', { status: 401 }))

    await expect(wallsioSource({ config, fetchImpl }).poll()).rejects.toThrow(/jeton walls\.io refusé/)
    expect(config.status(0).lastError).toMatch(/jeton walls\.io refusé/)
  })

  it('starts over when the token changes', () => {
    config.setToken(TOKEN)
    config.record({ cursor: 42, error: null, at: new Date(NOW).toISOString() })
    config.setToken('un-autre-jeton-1234')
    expect(config.cursor()).toBeNull()
  })

  it('makes no call while paused from the console, and reads again once resumed', async () => {
    config.setToken(TOKEN)
    config.setPaused(true)
    const { fetchImpl } = fakeApi({ status: 'success', data: [post('1')] })
    const source = wallsioSource({ config, fetchImpl, now: () => NOW })

    expect(await source.poll()).toEqual([])
    expect(fetchImpl).not.toHaveBeenCalled()
    expect(config.status(0).paused).toBe(true)

    config.setPaused(false)
    expect((await source.poll()).map((entry) => entry.externalId)).toEqual(['1'])
  })

  it('backs off after failures, longer each time, and starts again on a success', async () => {
    config.setToken(TOKEN)
    let now = NOW
    const { fetchImpl } = fakeApi(
      new Response('panne', { status: 500 }),
      new Response('panne', { status: 500 }),
      { status: 'success', data: [post('1')] },
    )
    const source = wallsioSource({ config, fetchImpl, now: () => now })

    await expect(source.poll()).rejects.toThrow(/500/)
    expect(config.status(0)).toMatchObject({ failures: 1, retryAt: new Date(NOW + 60_000).toISOString() })
    // Thirty seconds on, the ingestor's next tick: no call yet.
    now = NOW + 30_000
    expect(await source.poll()).toEqual([])
    expect(fetchImpl).toHaveBeenCalledTimes(1)

    now = NOW + 60_000
    await expect(source.poll()).rejects.toThrow(/500/)
    expect(config.status(0)).toMatchObject({ failures: 2, retryAt: new Date(now + 120_000).toISOString() })

    now += 120_000
    expect(await source.poll()).toHaveLength(1)
    expect(config.status(0)).toMatchObject({ failures: 0, retryAt: null, lastError: null })
  })

  it('waits as long as walls.io asks when it limits the reads', async () => {
    config.setToken(TOKEN)
    const { fetchImpl } = fakeApi(new Response('trop', { status: 429, headers: { 'retry-after': '600' } }))

    await expect(wallsioSource({ config, fetchImpl, now: () => NOW }).poll()).rejects.toThrow(/limite les lectures/)
    expect(config.status(0).retryAt).toBe(new Date(NOW + 600_000).toISOString())
  })

  it('never waits more than a quarter of an hour on its own, and not at all once resumed or given a new token', () => {
    expect([1, 2, 3, 4, 5, 6, 10].map((failures) => backoffDelay(failures) / 60_000)).toEqual([1, 2, 4, 8, 15, 15, 15])

    config.setToken(TOKEN)
    config.record({ error: 'panne', at: new Date(NOW).toISOString() })
    config.setPaused(true)
    config.setPaused(false)
    expect(config.status(0)).toMatchObject({ failures: 0, retryAt: null })

    config.record({ error: 'panne', at: new Date(NOW).toISOString() })
    config.setToken('un-autre-jeton-1234')
    expect(config.status(0)).toMatchObject({ failures: 0, retryAt: null })
  })
})

describe('the social wall', () => {
  const fromWallsio = (id: string, extra: Partial<Parameters<WallService['post']>[0]> = {}) =>
    wall.post({ source: 'wallsio', externalId: id, author: 'Anne', text: `post ${id}`, ...extra })

  it('takes walls.io posts approved, and keeps them off the audience wall', () => {
    const posted = fromWallsio('1')
    expect(posted.status).toBe('approved')
    expect(wall.pending()).toEqual([])
    // The operator's full-screen wall stays the room talking to the room.
    expect(wall.approved()).toEqual([])

    wall.publishScreen()
    expect(wall.screen().posts.map((entry) => entry.text)).toEqual(['post 1'])
  })

  it('follows walls.io deactivating and reactivating a post', () => {
    fromWallsio('1')
    const before = wall.publishScreen().revision

    fromWallsio('1', { active: false })
    expect(wall.publishScreen().posts).toEqual([])
    expect(wall.screen().revision).not.toBe(before)

    fromWallsio('1', { active: true })
    expect(wall.publishScreen().posts).toHaveLength(1)
  })

  it('keeps a post hidden on the hub hidden, whatever walls.io says after', () => {
    const posted = fromWallsio('1')
    wall.moderate(posted.id, 'reject', 'regie@cloudnord.fr')
    expect(wall.screen().posts).toEqual([])

    fromWallsio('1', { active: true, text: 'post 1 modifié' })
    expect(wall.publishScreen().posts).toEqual([])
  })

  it('puts forward what walls.io pins, what the console features, and the partners', () => {
    fromWallsio('1')
    fromWallsio('2', { pinned: true })
    const featured = fromWallsio('3')
    wall.setFeatured(featured.id, true)
    wall.saveHubPost({ author: 'NOVA Atelier', text: 'Le café est servi', sponsor: { name: 'NOVA Atelier' }, featured: false }, 'regie')

    const posts = wall.publishScreen().posts
    expect(posts.filter((entry) => entry.featured).map((entry) => entry.text).sort()).toEqual(
      ['Le café est servi', 'post 2', 'post 3'].sort(),
    )
    // Featured first: a page always has one to put in front.
    expect(posts.at(-1)?.text).toBe('post 1')
    expect(posts.find((entry) => entry.source === 'hub')?.sponsor).toEqual({ key: null, name: 'NOVA Atelier', logo: null })
    // Partners are not the audience's: the phones' "already on screen" leaves them out.
    expect(wall.approved()).toEqual([])
  })

  it('tells its listeners only when the screen moves', () => {
    const listener = vi.fn()
    wall.onScreenChanged(listener)
    fromWallsio('1')
    wall.publishScreen()
    wall.publishScreen()
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('downloads the images before the rooms are told', async () => {
    config.setToken(TOKEN)
    const order: string[] = []
    const { fetchImpl } = fakeApi({ status: 'success', data: [post('1')] })
    wall.onScreenChanged(() => order.push('published'))
    const ingestor = new SocialIngestor([wallsioSource({ config, fetchImpl })], wall, {
      prefetch: async (refs) => {
        order.push(`prefetch ${refs.length}`)
        return { downloaded: refs.length, reused: 0, failed: [] }
      },
    })

    await ingestor.kick()
    expect(order).toEqual(['prefetch 2', 'published'])
  })
})

describe('what the hub says it did', () => {
  it('logs what a poll brought, and stays quiet when nothing moved', async () => {
    config.setToken(TOKEN)
    const logs: { level: string; message: string; context?: object }[] = []
    const onLog = (level: 'debug' | 'info' | 'warn', message: string, context?: object) =>
      logs.push({ level, message, context })
    const { fetchImpl } = fakeApi(
      { status: 'success', data: [post('2'), post('1')] },
      { status: 'success', current_time: 1_792_000_500, data: [post('1', { status: false })] },
      { status: 'success', current_time: 1_792_000_600, data: [] },
    )
    const ingestor = new SocialIngestor([wallsioSource({ config, fetchImpl, onLog })], wall, {
      onLog,
      prefetch: async (refs) => ({ downloaded: refs.length, reused: 0, failed: [] }),
    })

    await ingestor.kick()
    expect(logs.map((entry) => entry.message)).toContain('source wallsio : 2 nouveaux')
    expect(logs.find((entry) => entry.message === 'images du mur social')?.context).toMatchObject({ telechargees: 4 })

    logs.length = 0
    await ingestor.kick()
    expect(logs.map((entry) => entry.message)).toContain('source wallsio : 1 désactivé')

    logs.length = 0
    await ingestor.kick()
    const quiet = logs.find((entry) => entry.message.startsWith('source wallsio'))
    expect(quiet).toMatchObject({ level: 'debug', message: 'source wallsio : rien de nouveau (0 reçu)' })

    // Whatever was said, the token never was.
    expect(JSON.stringify(logs)).not.toContain(TOKEN)
  })
})

describe('a walls.io video', () => {
  const LIEN = (signature: string) => `https://dms.licdn.com/playlist/vid/v2/abc/mp4-720p/def/0/1?e=${signature}`

  it('comes in with its post, its still kept as the image', async () => {
    config.setToken(TOKEN)
    const { fetchImpl, calls } = fakeApi({
      status: 'success',
      data: [post('v1', { post_video: LIEN('1'), post_image_cdn: 'https://img-li-cdn.walls.io/v1' }), post('v2', { comment: '', post_image_cdn: null, post_video: LIEN('2') })],
    })
    const posts = await wallsioSource({ config, fetchImpl, now: () => NOW }).poll()

    expect(calls[0]?.searchParams.get('fields')).toContain('post_video')
    expect(posts[0]).toMatchObject({ video: LIEN('1'), image: 'https://img-li-cdn.walls.io/v1' })
    // A video alone is something to draw.
    expect(posts[1]).toMatchObject({ externalId: 'v2', video: LIEN('2'), image: null })
    const stored = wall.post(posts[0]!)
    expect(stored.video).toBe(LIEN('1'))
  })

  it('keeps the link it holds when walls.io signs it again', () => {
    const first = wall.post({ source: 'wallsio', author: 'Cloud Nord', text: 'Vidéo', externalId: 'v1', video: LIEN('1') })
    // Another signature, the same video: nothing to download again, nothing to move.
    expect(wall.ingest({ source: 'wallsio', author: 'Cloud Nord', text: 'Vidéo', externalId: 'v1', video: LIEN('2') }).outcome).toBe('known')
    wall.publishScreen()
    expect(wall.screen().posts.find((entry) => entry.id === first.id)?.video).toBe(LIEN('1'))
  })

  it('reaches the posts already held: the cursor is set aside once, for the new field', () => {
    config.setToken(TOKEN)
    config.record({ cursor: 42, error: null, at: new Date(NOW).toISOString() })
    expect(config.cursor()).toBe(42)
    // A hub that read walls.io before the videos.
    const row = db.select().from(hubSetting).where(eq(hubSetting.key, 'wallsio')).get()!
    db.update(hubSetting).set({ valueJson: JSON.stringify({ ...JSON.parse(row.valueJson), fieldsVersion: 1 }) }).where(eq(hubSetting.key, 'wallsio')).run()

    expect(config.cursor()).toBeNull()
    config.record({ cursor: 43, error: null, at: new Date(NOW).toISOString() })
    expect(config.cursor()).toBe(43)
  })
})

describe('an author walls.io sends without a picture', () => {
  const linkedin = (id: string, avatar: string | null, author = 'Cloud Nord') =>
    wall.post({ source: 'wallsio', author, text: `Post ${id}`, externalId: id, avatar, network: 'LinkedIn' })

  it('wears the picture the hub already holds for that author on that network', () => {
    linkedin('1', 'https://img-li-cdn.walls.io/cloud-nord+linkedin+default')
    const later = linkedin('2', null)
    expect(later.avatar).toBe('https://img-li-cdn.walls.io/cloud-nord+linkedin+default')
    // Another author, or the same name elsewhere, lends nothing.
    expect(linkedin('3', null, 'Quelqu’un').avatar).toBeNull()
    expect(wall.post({ source: 'wallsio', author: 'Cloud Nord', text: 'Insta', externalId: '4', avatar: null, network: 'Instagram' }).avatar).toBeNull()
  })

  it('keeps its picture when walls.io later sends the post without one', () => {
    const post = linkedin('1', 'https://img-li-cdn.walls.io/cloud-nord+linkedin+default')
    wall.post({ source: 'wallsio', author: 'Cloud Nord', text: 'Post 1 corrigé', externalId: '1', avatar: null, network: 'LinkedIn' })
    wall.publishScreen()
    expect(wall.screen().posts.find((entry) => entry.id === post.id)).toMatchObject({
      text: 'Post 1 corrigé',
      avatar: 'https://img-li-cdn.walls.io/cloud-nord+linkedin+default',
    })
  })

  it('gets it back for the posts stored before, once the hub restarts', () => {
    linkedin('1', null)
    linkedin('2', 'https://img-li-cdn.walls.io/cloud-nord+linkedin+default')
    // A post stored by an older hub, without the picture it could have borrowed.
    db.update(comment).set({ avatar: null }).where(eq(comment.externalId, '1')).run()

    const restarted = new WallService(db)
    expect(restarted.screen().posts.map((entry) => entry.avatar)).toEqual([
      'https://img-li-cdn.walls.io/cloud-nord+linkedin+default',
      'https://img-li-cdn.walls.io/cloud-nord+linkedin+default',
    ])
  })
})

describe('the hand-fed posts of the loop', () => {
  function storeLegacy(extra: Record<string, unknown> = {}) {
    db.insert(hubSetting)
      .values({
        key: 'hub',
        valueJson: JSON.stringify({
          eventName: 'Cloud Nord',
          boucle: {
            mur: {
              titre: 'Ils en parlent',
              posts: [
                { auteur: 'Anne', titre: 'CTO', texte: 'Superbe journée', image: 'https://exemple.fr/a.jpg', reseau: 'LinkedIn' },
              ],
            },
          },
          ...extra,
        }),
      })
      .run()
  }

  it('become featured posts of the social wall, once', () => {
    storeLegacy()
    const settings = new SettingsService(db)

    expect(migrateLegacyMur(db, settings, wall)).toEqual({ imported: 1, skipped: 0 })
    const [imported] = wall.screen().posts
    expect(imported).toMatchObject({
      source: 'hub',
      author: 'Anne',
      authorSubtitle: 'CTO',
      text: 'Superbe journée',
      image: 'https://exemple.fr/a.jpg',
      network: 'LinkedIn',
      featured: true,
    })
    // The rest of the settings kept, the section gone: nothing left to take.
    expect(settings.get().eventName).toBe('Cloud Nord')
    expect(migrateLegacyMur(db, settings, wall)).toBeNull()
    expect(wall.screen().posts).toHaveLength(1)
  })

  it('stay out when the organisers had withdrawn their page', () => {
    storeLegacy({ screensDisabled: ['posts'] })
    expect(migrateLegacyMur(db, new SettingsService(db), wall)).toEqual({ imported: 0, skipped: 1 })
    expect(wall.screen().posts).toEqual([])
  })
})
