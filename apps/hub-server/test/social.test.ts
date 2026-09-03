import { beforeEach, describe, expect, it, vi } from 'vitest'
import { openHubDatabase, type HubDatabase } from '../src/db.js'
import { WallService } from '../src/services/wall.js'
import {
  SocialIngestor,
  blueskySource,
  htmlToText,
  mastodonSource,
  xSource,
  type SocialSource,
} from '../src/services/social.js'

let db: HubDatabase
let wall: WallService

beforeEach(() => {
  db = openHubDatabase(':memory:').orm
  wall = new WallService(db)
})

const json = (body: unknown) =>
  vi.fn(async () => new Response(JSON.stringify(body), { status: 200 })) as unknown as typeof fetch

describe('Bluesky', () => {
  const response = {
    posts: [
      {
        uri: 'at://did:plc:abc/app.bsky.feed.post/1',
        author: { handle: 'dadideo.bsky.social', displayName: 'David' },
        record: { text: 'Ça commence #CloudNord2026' },
      },
      {
        uri: 'at://did:plc:abc/app.bsky.feed.post/2',
        author: { handle: 'anon.bsky.social', displayName: null },
        record: { text: '' },
      },
    ],
  }

  it('converts the posts and keeps their URI', async () => {
    const source = blueskySource({ hashtag: 'CloudNord2026', fetchImpl: json(response) })
    const posts = await source.poll()

    expect(posts).toHaveLength(1)
    expect(posts[0]).toMatchObject({
      source: 'bluesky',
      author: 'David',
      authorHandle: 'dadideo.bsky.social',
      externalId: 'at://did:plc:abc/app.bsky.feed.post/1',
    })
  })

  it('falls back to the handle when the display name is missing', async () => {
    const source = blueskySource({
      hashtag: 'x',
      fetchImpl: json({
        posts: [
          {
            uri: 'at://1',
            author: { handle: 'anon.bsky.social', displayName: null },
            record: { text: 'coucou' },
          },
        ],
      }),
    })
    expect((await source.poll())[0]?.author).toBe('anon.bsky.social')
  })

  it('reports a response in error', async () => {
    const source = blueskySource({
      hashtag: 'x',
      fetchImpl: vi.fn(async () => new Response('nope', { status: 503 })) as unknown as typeof fetch,
    })
    await expect(source.poll()).rejects.toThrow(/503/)
  })
})

describe('Mastodon', () => {
  it('reduces the HTML to displayable text', () => {
    // Injecting third-party HTML onto a video projector is a bad idea on
    // principle.
    expect(htmlToText('<p>Bonjour <a href="#">#CloudNord</a></p><p>à tous</p>')).toBe(
      'Bonjour #CloudNord à tous',
    )
    expect(htmlToText('<p>a &amp; b<br>c</p>')).toBe('a & b c')
    expect(htmlToText('<script>alert(1)</script>')).toBe('alert(1)')
  })

  it('converts the statuses', async () => {
    const source = mastodonSource({
      instance: 'https://framapiaf.org',
      hashtag: 'CloudNord2026',
      fetchImpl: json([
        {
          id: '109',
          content: '<p>Belle keynote <b>!</b></p>',
          account: { acct: 'dadideo@framapiaf.org', display_name: 'David' },
        },
        { id: '110', content: '<p></p>', account: { acct: 'vide', display_name: null } },
      ]),
    })

    const posts = await source.poll()
    expect(posts).toHaveLength(1)
    expect(posts[0]).toMatchObject({ source: 'mastodon', text: 'Belle keynote !', externalId: '109' })
  })
})

describe('X', () => {
  it('refuses explicitly with no key rather than faking a failure', async () => {
    const source = xSource({ hashtag: 'CloudNord2026', bearerToken: null })
    await expect(source.poll()).rejects.toThrow(/plan payant/)
  })

  it('works as soon as a key is supplied', async () => {
    const source = xSource({
      hashtag: 'CloudNord2026',
      bearerToken: 'jeton',
      fetchImpl: json({
        data: [{ id: '1', text: 'hello #CloudNord2026', author_id: 'u1' }],
        includes: { users: [{ id: 'u1', username: 'alice', name: 'Alice' }] },
      }),
    })
    expect((await source.poll())[0]).toMatchObject({ source: 'x', author: 'Alice', externalId: '1' })
  })
})

describe('ingestion', () => {
  const source = (id: 'bluesky' | 'mastodon', posts: unknown[]): SocialSource => ({
    id,
    poll: vi.fn(async () => posts as never),
  })

  it('drops into the moderation queue, never straight onto the screen', async () => {
    const ingestor = new SocialIngestor(
      [source('bluesky', [{ source: 'bluesky', author: 'A', text: 'coucou', externalId: '1' }])],
      wall,
    )
    await ingestor.runOnce()

    // What comes from Bluesky has no more rights than a drop through the form.
    expect(wall.pending()).toHaveLength(1)
    expect(wall.approved()).toEqual([])
  })

  it('tolerates reading the same window again', async () => {
    const posts = [{ source: 'bluesky', author: 'A', text: 'coucou', externalId: '1' }]
    const ingestor = new SocialIngestor([source('bluesky', posts)], wall)

    await ingestor.runOnce()
    await ingestor.runOnce()
    // The overlap is deliberate: without idempotence it would produce duplicates.
    expect(wall.pending()).toHaveLength(1)
  })

  it('carries on when one source goes down', async () => {
    const broken: SocialSource = {
      id: 'x',
      poll: vi.fn(async () => {
        throw new Error('plan payant requis')
      }),
    }
    const ingestor = new SocialIngestor(
      [broken, source('mastodon', [{ source: 'mastodon', author: 'B', text: 'salut', externalId: '9' }])],
      wall,
    )

    const report = await ingestor.runOnce()
    // An unavailable source must not deprive the wall of the others.
    expect(report.bySource.x?.error).toContain('plan payant')
    expect(report.bySource.mastodon?.collected).toBe(1)
    expect(wall.pending()).toHaveLength(1)
  })
})
