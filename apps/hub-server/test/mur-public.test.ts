import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { murPublicSchema } from '@conference-operator/contract'
import { hubSetting } from '@conference-operator/db/hub'
import { openHubDatabase } from '../src/db.js'
import { createHub, type Hub } from '../src/server.js'
import { MurPublicAccessService } from '../src/services/mur-public.js'

let hub: Hub
let origin: string

let dataDir: string

beforeEach(async () => {
  // On disk: the hub keeps the images beside its database.
  dataDir = mkdtempSync(join(tmpdir(), 'mur-public-'))
  hub = await createHub({
    port: 0,
    host: '127.0.0.1',
    databasePath: join(dataDir, 'hub.db'),
    publicUrl: 'http://127.0.0.1',
    authSecret: 'test-secret-'.padEnd(48, 'x'),
    logLevel: 'fatal',
  })
  await hub.app.listen({ port: 0, host: '127.0.0.1' })
  const address = hub.app.server.address()
  origin = `http://127.0.0.1:${typeof address === 'object' && address != null ? address.port : 0}`
})

afterEach(async () => {
  await hub.close()
  rmSync(dataDir, { recursive: true, force: true })
})

async function readPublic() {
  const response = await fetch(`${origin}/rpc/wall/public`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ json: null }),
  })
  return { status: response.status, body: (await response.json()) as { json: unknown } }
}

describe('the public social page’s feed', () => {
  it('serves the projected wall without an account: images by their key, never a remote address', async () => {
    await hub.services.assets.store('https://cdn.exemple/photo.jpg', Buffer.from('jpeg'), 'image/jpeg')
    // walls.io moderates upstream: its posts arrive approved, photo included.
    hub.services.wall.post({
      source: 'wallsio',
      author: 'Alice',
      text: 'Bravo #CloudNord2026',
      externalId: 'wallsio-1',
      image: 'https://cdn.exemple/photo.jpg',
      avatar: 'https://cdn.exemple/pas-telechargee.jpg',
      permalink: 'https://www.instagram.com/p/1',
      network: 'Instagram',
    })
    hub.services.wall.publishScreen()
    hub.services.wall.post({ source: 'bluesky', author: 'Troll', text: 'en attente', externalId: 'at://troll/1' })

    const { status, body } = await readPublic()
    expect(status).toBe(200)
    const mur = murPublicSchema.parse(body.json)
    expect(mur.hashtag).toBe('CloudNord2026')
    expect(mur.posts.map((post) => post.author)).toEqual(['Alice'])
    expect(mur.posts[0]).toMatchObject({
      image: hub.services.assets.keyOf('https://cdn.exemple/photo.jpg'),
      avatar: null,
      network: 'Instagram',
      permalink: 'https://www.instagram.com/p/1',
    })
    // The default theme fills every token the page draws with.
    expect(mur.theme.couleurs.nuit).toMatch(/^#[0-9a-f]{6}$/i)
    expect(JSON.stringify(mur)).not.toContain('cdn.exemple')
  })

  it('takes its hashtag from the social wall’s settings, as the console sets it', async () => {
    const wallsio = hub.services.settings.get().boucle.wallsio
    hub.services.settings.update({ boucle: { wallsio: { ...wallsio, hashtag: '#DevFestNord en direct' } } })
    expect(murPublicSchema.parse((await readPublic()).body.json).hashtag).toBe('DevFestNord')

    hub.services.settings.update({ boucle: { wallsio: { ...wallsio, hashtag: '' } } })
    expect(murPublicSchema.parse((await readPublic()).body.json).hashtag).toBeNull()
  })

  it('keeps its revision while nothing moves, and changes it with the wall', async () => {
    const before = murPublicSchema.parse((await readPublic()).body.json).revision
    expect(murPublicSchema.parse((await readPublic()).body.json).revision).toBe(before)

    const posted = hub.services.wall.post({ source: 'form', author: 'Bob', text: 'Salut' })
    hub.services.wall.moderate(posted.id, 'approve', 'regie@cloudnord.fr')
    expect(murPublicSchema.parse((await readPublic()).body.json).revision).not.toBe(before)
  })

  it('is rate-limited per address, apart from the posting form', async () => {
    const statuses: number[] = []
    for (let i = 0; i < 40; i++) statuses.push((await readPublic()).status)
    expect(statuses.slice(0, 30).every((status) => status === 200)).toBe(true)
    expect(statuses).toContain(429)
    // The form's bucket is untouched.
    expect(hub.services.limiter.take('inconnu|no-device')).toBe(true)
  })
})

describe('the public page’s images', () => {
  it('come in once downloaded, even when the wall itself did not move', async () => {
    const photo = 'https://cdn.exemple/arrivee-tardive.jpg'
    hub.services.wall.post({ source: 'wallsio', author: 'Cloud Nord', text: 'J-1', externalId: 'w-tard', image: photo })
    hub.services.wall.publishScreen()
    const before = murPublicSchema.parse((await readPublic()).body.json)
    expect(before.posts[0]?.image).toBeNull()

    // The ingestor downloads it after the post was published: same posts, same screen revision.
    const screen = hub.services.wall.screen().revision
    await hub.services.assets.store(photo, Buffer.from('jpeg'), 'image/jpeg')
    hub.services.wall.publishScreen()
    expect(hub.services.wall.screen().revision).toBe(screen)

    const after = murPublicSchema.parse((await readPublic()).body.json)
    expect(after.posts[0]?.image).toBe(hub.services.assets.keyOf(photo))
    expect(after.revision).not.toBe(before.revision)
  })
})

async function reportViews(counts: Record<string, number>, token?: string) {
  const response = await fetch(`${origin}/rpc/wall/onlineViews`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token == null ? {} : { authorization: `Bearer ${token}` }) },
    body: JSON.stringify({ json: { counts } }),
  })
  return response.status
}

describe('the public page’s views', () => {
  it('are taken from the service holding the current token, and from it alone', async () => {
    const post = hub.services.wall.saveHubPost({ author: 'Partenaire', text: 'Merci !' }, 'regie')!

    expect(await reportViews({ [post.id]: 3 })).toBe(401)
    const old = hub.services.murPublicAccess.create()
    const token = hub.services.murPublicAccess.create()
    // Replaced: the old token stops at once.
    expect(await reportViews({ [post.id]: 3 }, old)).toBe(401)
    expect(await reportViews({ [post.id]: 3 }, 'mp_pas-le-bon')).toBe(401)
    expect(hub.services.wall.onlineViews([post.id]).size).toBe(0)

    expect(await reportViews({ [post.id]: 3, inconnu: 5 }, token)).toBe(200)
    expect(await reportViews({ [post.id]: 2 }, token)).toBe(200)

    const listed = hub.services.wall.list({ view: 'approved' }).items.find((item) => item.id === post.id)
    // Apart from the rooms' counts: nothing was projected.
    expect(listed).toMatchObject({ onlineViews: 5, impressions: 0 })
    expect(listed?.lastSeenOnlineAt).not.toBeNull()
    // A post the hub does not hold leaves no counter behind.
    expect(hub.services.wall.onlineViews(['inconnu']).size).toBe(0)
    expect(hub.services.murPublicAccess.status()).toMatchObject({ hasToken: true, tokenHint: token.slice(-4) })
    expect(hub.services.murPublicAccess.status().lastReportAt).not.toBeNull()
  })

  it('stop being taken once the token is removed', async () => {
    const post = hub.services.wall.saveHubPost({ author: 'Partenaire', text: 'Merci !' }, 'regie')!
    const token = hub.services.murPublicAccess.create()

    hub.services.murPublicAccess.remove()
    expect(await reportViews({ [post.id]: 1 }, token)).toBe(401)
    expect(hub.services.murPublicAccess.status()).toMatchObject({ hasToken: false, tokenHint: null })
  })

  it('are checked against a hash: the token is never stored in clear', () => {
    const orm = openHubDatabase(':memory:').orm
    const access = new MurPublicAccessService(orm)
    const token = access.create()

    expect(token).toMatch(/^mp_[A-Za-z0-9_-]{43}$/)
    expect(JSON.stringify(orm.select().from(hubSetting).all())).not.toContain(token)
    expect(access.verify(token)).toBe(true)
    expect(access.verify(token.slice(0, -1))).toBe(false)
    expect(access.verify(null)).toBe(false)
  })
})
