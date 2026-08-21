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
  const reponse = {
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

  it('convertit les posts et retient leur URI', async () => {
    const source = blueskySource({ hashtag: 'CloudNord2026', fetchImpl: json(reponse) })
    const posts = await source.poll()

    expect(posts).toHaveLength(1)
    expect(posts[0]).toMatchObject({
      source: 'bluesky',
      author: 'David',
      authorHandle: 'dadideo.bsky.social',
      externalId: 'at://did:plc:abc/app.bsky.feed.post/1',
    })
  })

  it('retombe sur le handle quand le nom affiché manque', async () => {
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

  it('signale une réponse en erreur', async () => {
    const source = blueskySource({
      hashtag: 'x',
      fetchImpl: vi.fn(async () => new Response('nope', { status: 503 })) as unknown as typeof fetch,
    })
    await expect(source.poll()).rejects.toThrow(/503/)
  })
})

describe('Mastodon', () => {
  it('réduit le HTML en texte affichable', () => {
    // Injecter du HTML tiers sur un vidéoprojecteur est une mauvaise idée par principe.
    expect(htmlToText('<p>Bonjour <a href="#">#CloudNord</a></p><p>à tous</p>')).toBe(
      'Bonjour #CloudNord à tous',
    )
    expect(htmlToText('<p>a &amp; b<br>c</p>')).toBe('a & b c')
    expect(htmlToText('<script>alert(1)</script>')).toBe('alert(1)')
  })

  it('convertit les statuts', async () => {
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
  it('refuse explicitement sans clé plutôt que de simuler une panne', async () => {
    const source = xSource({ hashtag: 'CloudNord2026', bearerToken: null })
    await expect(source.poll()).rejects.toThrow(/plan payant/)
  })

  it('fonctionne dès qu\'une clé est fournie', async () => {
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

  it('dépose dans la file de modération, jamais directement à l\'écran', async () => {
    const ingestor = new SocialIngestor(
      [source('bluesky', [{ source: 'bluesky', author: 'A', text: 'coucou', externalId: '1' }])],
      wall,
    )
    await ingestor.runOnce()

    // Ce qui vient de Bluesky n'a pas plus de droits qu'un dépôt au formulaire.
    expect(wall.pending()).toHaveLength(1)
    expect(wall.approved()).toEqual([])
  })

  it('tolère de relire la même fenêtre', async () => {
    const posts = [{ source: 'bluesky', author: 'A', text: 'coucou', externalId: '1' }]
    const ingestor = new SocialIngestor([source('bluesky', posts)], wall)

    await ingestor.runOnce()
    await ingestor.runOnce()
    // Le recouvrement est délibéré : sans idempotence il produirait des doublons.
    expect(wall.pending()).toHaveLength(1)
  })

  it('continue quand une source tombe', async () => {
    const cassee: SocialSource = {
      id: 'x',
      poll: vi.fn(async () => {
        throw new Error('plan payant requis')
      }),
    }
    const ingestor = new SocialIngestor(
      [cassee, source('mastodon', [{ source: 'mastodon', author: 'B', text: 'salut', externalId: '9' }])],
      wall,
    )

    const report = await ingestor.runOnce()
    // Une source indisponible ne doit pas priver le mur des autres.
    expect(report.bySource.x?.error).toContain('plan payant')
    expect(report.bySource.mastodon?.collected).toBe(1)
    expect(wall.pending()).toHaveLength(1)
  })
})
