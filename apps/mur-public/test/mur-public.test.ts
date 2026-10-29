import { createHash } from 'node:crypto'
import type { IncomingMessage } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createHub, type Hub } from '@conference-operator/hub-server/server'
import { loadConfig } from '../src/config.js'
import { ImageCache } from '../src/hub.js'
import { byteRange, clientAddress, startMurPublic, type MurPublicServer } from '../src/server.js'
import { compterMots } from '../src/mots.js'

const PHOTO = 'https://cdn.exemple/photo.jpg'

let hub: Hub
let hubUrl: string
let hubOpen: boolean
const running: MurPublicServer[] = []

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
  hubUrl = `http://127.0.0.1:${typeof address === 'object' && address != null ? address.port : 0}`
  hubOpen = true

  await hub.services.assets.store(PHOTO, Buffer.from('octets-jpeg'), 'image/jpeg')
  hub.services.wall.post({
    source: 'wallsio',
    author: 'Alice <b>',
    text: 'Bravo #CloudNord2026',
    externalId: 'wallsio-1',
    image: PHOTO,
  })
  hub.services.wall.publishScreen()
})

afterEach(async () => {
  for (const service of running.splice(0)) await service.close()
  if (hubOpen) await hub.close()
  rmSync(dataDir, { recursive: true, force: true })
})

/** A service on this test's hub, its first read done: nothing left to wait for. */
async function start(env: Record<string, string> = {}): Promise<MurPublicServer> {
  const service = await startMurPublic(
    loadConfig({ HUB_URL: hubUrl, PORT: '0', HOST: '127.0.0.1', POLL_SECONDS: '300', PROXY_HOPS: '0', ...env }),
    { log: () => undefined },
  )
  running.push(service)
  await service.feed.refresh()
  return service
}

describe('the public social page', () => {
  it('opens on the wall, in the theme’s colours, with the buttons to post', async () => {
    const service = await start()
    const response = await fetch(`${service.url}/`)
    const html = await response.text()

    expect(response.status).toBe(200)
    expect(html).toContain('--c-nuit:#')
    expect(html).toContain('https://bsky.app/intent/compose?text=%23CloudNord2026%20')
    expect(html).toContain('Alice \\u003cb>')
    expect(html).not.toContain('Alice <b>')

    // The only script the policy lets run is the one the page carries.
    const csp = response.headers.get('content-security-policy') ?? ''
    const script = /<script>([\s\S]*?)<\/script>/.exec(html)?.[1] ?? ''
    expect(csp).toContain(`'sha256-${createHash('sha256').update(script).digest('base64')}'`)
    expect(csp).toContain("default-src 'none'")
  })

  it('carries the event site’s menu, escaped, with a burger for phones', async () => {
    const wallsio = hub.services.settings.get().boucle.wallsio
    hub.services.settings.update({
      boucle: {
        wallsio: {
          ...wallsio,
          menu: [
            { libelle: 'Programme', url: 'https://cloudnord.fr/schedule' },
            { libelle: 'Code <de> conduite', url: 'https://cloudnord.fr/coc?a=1&b=2' },
          ],
        },
      },
    })
    const html = await (await fetch(`${(await start()).url}/`)).text()

    expect(html).toContain('<a href="https://cloudnord.fr/schedule">Programme</a>')
    expect(html).toContain('<a href="https://cloudnord.fr/coc?a=1&amp;b=2">Code &lt;de&gt; conduite</a>')
    expect(html).toContain('id="burger"')
    expect(html).toContain('id="tiroir" hidden')
  })

  it('offers only the networks ticked in the console, within the service’s own list', async () => {
    const wallsio = hub.services.settings.get().boucle.wallsio
    hub.services.settings.update({ boucle: { wallsio: { ...wallsio, reseaux: ['bluesky', 'x', 'linkedin'] } } })
    const html = await (await fetch(`${(await start({ RESEAUX: 'bluesky,mastodon,linkedin' })).url}/`)).text()

    expect(html).toContain('bsky.app/intent/compose')
    expect(html).toContain('linkedin.com/feed')
    // Unticked in the console, and left out of the service's list.
    expect(html).not.toContain('id="partage-mastodon"')
    expect(html).not.toContain('x.com/intent/post')
  })

  it('draws no menu when the console sets none', async () => {
    const html = await (await fetch(`${(await start()).url}/`)).text()
    expect(html).not.toContain('id="burger"')
    expect(html).not.toContain('class="barre"')
  })

  it('says the console’s tagline, the hashtag in place of {hashtag}, escaped', async () => {
    const wallsio = hub.services.settings.get().boucle.wallsio
    hub.services.settings.update({ boucle: { wallsio: { ...wallsio, accroche: 'Racontez-nous <tout> avec {hashtag} !' } } })
    const html = await (await fetch(`${(await start()).url}/`)).text()

    expect(html).toContain('<p class="invite">Racontez-nous &lt;tout&gt; avec <strong>#CloudNord2026</strong> !</p>')
    expect(html).not.toContain('votre post apparaît ici')
  })

  it('answers its live poll from memory, and 304 when nothing moved', async () => {
    const service = await start()
    const first = await fetch(`${service.url}/mur.json`)
    const etag = first.headers.get('etag')
    const mur = (await first.json()) as { posts: { image: string | null }[] }

    expect(first.status).toBe(200)
    expect(mur.posts[0]?.image).toBe(hub.services.assets.keyOf(PHOTO))
    expect((await fetch(`${service.url}/mur.json`, { headers: { 'if-none-match': etag! } })).status).toBe(304)
  })

  it('serves the wall’s images, and those alone', async () => {
    const service = await start()
    const image = await fetch(`${service.url}/images/${hub.services.assets.keyOf(PHOTO)}`)
    expect(image.status).toBe(200)
    expect(image.headers.get('content-type')).toBe('image/jpeg')
    expect(Buffer.from(await image.arrayBuffer()).toString()).toBe('octets-jpeg')

    await hub.services.assets.store('https://cdn.exemple/autre.jpg', Buffer.from('x'), 'image/jpeg')
    expect((await fetch(`${service.url}/images/${hub.services.assets.keyOf('https://cdn.exemple/autre.jpg')}`)).status).toBe(404)
  })

  it('keeps an image for good, answers a reload with a 304, and never keeps a miss', async () => {
    const service = await start()
    const key = hub.services.assets.keyOf(PHOTO)
    const image = await fetch(`${service.url}/images/${key}`)
    expect(image.headers.get('cache-control')).toBe('public, max-age=31536000, immutable')
    expect(image.headers.get('etag')).toBe(`"${key}"`)

    const reload = await fetch(`${service.url}/images/${key}`, { headers: { 'if-none-match': `W/"${key}"` } })
    expect(reload.status).toBe(304)
    expect(await reload.text()).toBe('')

    const miss = await fetch(`${service.url}/images/${'0'.repeat(64)}`)
    expect(miss.status).toBe(404)
    expect(miss.headers.get('cache-control')).toBe('no-store')
  })

  it('caches the favicon for good at the address the page links, and checks any other', async () => {
    const service = await start()
    const linked = /href="(\/favicon\.svg\?v=[0-9a-f]+)"/.exec(await (await fetch(`${service.url}/`)).text())?.[1]
    const current = await fetch(`${service.url}${linked}`)
    expect(current.headers.get('cache-control')).toBe('public, max-age=31536000, immutable')

    const bare = await fetch(`${service.url}/favicon.svg`)
    expect(bare.headers.get('cache-control')).toBe('no-cache')
    expect((await fetch(`${service.url}/favicon.svg`, { headers: { 'if-none-match': bare.headers.get('etag')! } })).status).toBe(304)
  })

  it('wears the loop’s logo as its favicon, and the initials without one', async () => {
    const initials = await start()
    const sans = await (await fetch(`${initials.url}/favicon.svg`)).text()
    expect(sans).toContain('<text')
    expect(sans).not.toContain('data:image')

    await hub.services.assets.store('https://cdn.exemple/logo.png', Buffer.from('octets-png'), 'image/png')
    hub.services.settings.update({ boucle: { logo: 'https://cdn.exemple/logo.png' } })
    const service = await start()
    const response = await fetch(`${service.url}/favicon.svg`)
    expect(response.headers.get('content-type')).toBe('image/svg+xml')
    expect(await response.text()).toContain(`data:image/png;base64,${Buffer.from('octets-png').toString('base64')}`)
    expect(await (await fetch(`${service.url}/`)).text()).toContain('rel="icon" type="image/svg+xml" href="/favicon.svg?v=')
  })

  it('turns a flood from one address away, and keeps answering the probes', async () => {
    const service = await start({ LIMITE_PAGES: '3/0' })
    const statuses: number[] = []
    for (let i = 0; i < 4; i++) statuses.push((await fetch(`${service.url}/mur.json`)).status)

    expect(statuses).toEqual([200, 200, 200, 429])
    expect((await fetch(`${service.url}/sante`)).status).toBe(200)
  })

  it('counts what its visitors saw and reports it to the hub with its token', async () => {
    const service = await start({ HUB_TOKEN: hub.services.murPublicAccess.create() })
    const id = service.feed.state!.data.posts[0]!.id
    const vues = (body: string) => fetch(`${service.url}/vues`, { method: 'POST', headers: { 'content-type': 'application/json' }, body })

    expect((await vues(JSON.stringify({ ids: [id, 'pas-sur-le-mur'] }))).status).toBe(204)
    expect((await vues(JSON.stringify({ ids: [id, id] }))).status).toBe(204)
    // A visitor's report counts each post once; another visitor adds to it.
    expect(service.views?.pending).toBe(2)
    await service.views!.flush()

    expect(service.views?.pending).toBe(0)
    expect(hub.services.wall.onlineViews([id]).get(id)?.count).toBe(2)
    expect(hub.services.wall.list({ view: 'approved' }).items[0]).toMatchObject({ id, onlineViews: 2, impressions: 0 })
  })

  it('takes the views by POST alone, well-formed, and counts none without a token', async () => {
    const service = await start()
    const id = service.feed.state!.data.posts[0]!.id

    expect(service.views).toBeNull()
    expect((await fetch(`${service.url}/vues`)).status).toBe(405)
    expect((await fetch(`${service.url}/vues`, { method: 'POST', body: 'pas du json' })).status).toBe(400)
    expect((await fetch(`${service.url}/vues`, { method: 'POST', body: JSON.stringify({ ids: 'x' }) })).status).toBe(400)
    expect((await fetch(`${service.url}/vues`, { method: 'POST', body: JSON.stringify({ ids: [id] }) })).status).toBe(204)
    expect((await fetch(`${service.url}/`, { method: 'POST' })).status).toBe(405)
    expect(hub.services.wall.onlineViews([id]).size).toBe(0)
  })

  it('keeps the views for the next report while the hub is gone, and drops them when it refuses the token', async () => {
    const service = await start({ HUB_TOKEN: hub.services.murPublicAccess.create() })
    const id = service.feed.state!.data.posts[0]!.id
    service.views!.add([id])

    hub.services.murPublicAccess.create()
    await service.views!.flush()
    expect(service.views?.pending).toBe(0)

    service.views!.add([id])
    await hub.close()
    hubOpen = false
    await service.views!.flush()
    expect(service.views?.pending).toBe(1)
  })

  it('keeps showing the last wall when the hub is gone', async () => {
    const service = await start()
    await hub.close()
    hubOpen = false
    await service.feed.refresh()

    const mur = await fetch(`${service.url}/mur.json`)
    expect(mur.status).toBe(200)
    expect(((await mur.json()) as { posts: unknown[] }).posts).toHaveLength(1)
    const sante = (await (await fetch(`${service.url}/sante`)).json()) as { erreur: string | null }
    expect(sante.erreur).not.toBeNull()
  })
})

describe('the wall’s videos', () => {
  it('are served by ranges, as browsers read a video', async () => {
    const VIDEO = 'https://dms.licdn.com/playlist/vid/v2/abc/mp4-720p/0/1?e=1'
    await hub.services.assets.store(VIDEO, Buffer.from('0123456789'), 'video/mp4')
    hub.services.wall.post({ source: 'wallsio', author: 'Cloud Nord', text: 'Vidéo', externalId: 'wallsio-video', video: VIDEO, image: PHOTO })
    hub.services.wall.publishScreen()
    const service = await start()
    const key = hub.services.assets.keyOf(VIDEO)
    expect(service.feed.state!.data.posts.find((post) => post.video === key)).toBeDefined()

    const part = await fetch(`${service.url}/images/${key}`, { headers: { range: 'bytes=2-5' } })
    expect(part.status).toBe(206)
    expect(part.headers.get('content-type')).toBe('video/mp4')
    expect(part.headers.get('content-range')).toBe('bytes 2-5/10')
    expect(await part.text()).toBe('2345')

    const whole = await fetch(`${service.url}/images/${key}`)
    expect(whole.status).toBe(200)
    expect(whole.headers.get('accept-ranges')).toBe('bytes')
    expect((await fetch(`${service.url}/images/${key}`, { headers: { range: 'bytes=50-' } })).status).toBe(416)
  })

  it('may play on the page: its policy lets media come from its own origin', async () => {
    const response = await fetch(`${(await start()).url}/`)
    expect(response.headers.get('content-security-policy')).toContain("media-src 'self'")
  })
})

describe('the words of the wall', () => {
  it('counts what is said, not the little words, links or bare numbers', () => {
    const mots = compterMots([
      { text: "Rejoignez-nous à #CloudNord2026 : une journée sur l'IA et Kubernetes https://cloudnord.fr/programme" },
      { text: 'Kubernetes, encore Kubernetes, et vos questions sur l’IA en 2026 ! 42 places' },
    ])
    expect(mots[0]).toEqual({ mot: 'kubernetes', n: 3 })
    expect(mots.map((m) => m.mot)).toEqual(expect.arrayContaining(['#cloudnord2026', 'journée', '2026', 'questions', 'places']))
    for (const vide of ['une', 'et', 'vos', 'sur', 'https', 'cloudnord.fr', '42', 'ia']) expect(mots.map((m) => m.mot)).not.toContain(vide)
  })

  it('has a page of its own, with its own policy, and its JSON', async () => {
    hub.services.wall.post({ source: 'wallsio', author: 'Cloud Nord', text: 'Kubernetes Kubernetes souveraineté', externalId: 'mots-1' })
    hub.services.wall.publishScreen()
    const service = await start()
    const page = await fetch(`${service.url}/mots`)
    expect(page.status).toBe(200)
    expect(page.headers.get('content-security-policy')).toMatch(/script-src 'sha256-/)
    expect(await page.text()).toContain('Les mots du mur')
    const json = (await (await fetch(`${service.url}/mots.json`)).json()) as { mot: string; n: number }[]
    expect(json[0]).toEqual({ mot: 'kubernetes', n: 2 })
  })
})

describe('a byte range', () => {
  it('reads the forms browsers send', () => {
    expect(byteRange(undefined, 10)).toBeNull()
    expect(byteRange('bytes=0-', 10)).toEqual({ start: 0, end: 9 })
    expect(byteRange('bytes=-4', 10)).toEqual({ start: 6, end: 9 })
    expect(byteRange('bytes=3-100', 10)).toEqual({ start: 3, end: 9 })
    expect(byteRange('bytes=12-', 10)).toBe('invalide')
    expect(byteRange('bytes=0-1,4-5', 10)).toBeNull()
  })
})

describe('the image cache', () => {
  it('asks the hub for a missing image once per half minute, not once per visit', async () => {
    let now = 0
    let asked = 0
    const images = new ImageCache({
      hubUrl: 'http://hub.invalid',
      maxBytes: 1024,
      now: () => now,
      fetchImpl: (async () => {
        asked += 1
        return new Response('absente', { status: 404 })
      }) as unknown as typeof fetch,
    })

    expect(await images.get('a'.repeat(64))).toBeNull()
    expect(await images.get('a'.repeat(64))).toBeNull()
    expect(asked).toBe(1)

    now = 30_001
    await images.get('a'.repeat(64))
    expect(asked).toBe(2)
  })
})

describe('the visitor’s address', () => {
  const request = (forwarded: string | undefined) =>
    ({ headers: { 'x-forwarded-for': forwarded }, socket: { remoteAddress: '10.0.0.9' } }) as unknown as IncomingMessage

  it('is the one the ingress appended, not what the client forged on the left', () => {
    expect(clientAddress(request('6.6.6.6, 203.0.113.7'), 1)).toBe('203.0.113.7')
    expect(clientAddress(request('203.0.113.7'), 1)).toBe('203.0.113.7')
    expect(clientAddress(request(undefined), 1)).toBe('10.0.0.9')
    expect(clientAddress(request('6.6.6.6'), 0)).toBe('10.0.0.9')
  })
})
