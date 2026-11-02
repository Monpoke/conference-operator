import { describe, expect, it } from 'vitest'
import { openHubDatabase } from '../src/db.js'
import { createSecretBox } from '../src/secrets.js'
import { YoutubeService, youtubeTitle } from '../src/services/youtube.js'

const BYTES = 1024

interface Call {
  url: string
  init: RequestInit | undefined
}

/** Google and the storage, as far as the service sees them. */
function google(overrides: { thumbnail?: () => Response; snippet?: () => Response; open?: () => Response; playlist?: () => Response; item?: (body: string) => Response | null } = {}) {
  const calls: Call[] = []
  const impl = (async (input: URL | RequestInfo, init?: RequestInit) => {
    const url = String(input)
    calls.push({ url, init })
    if (url.includes('oauth2.googleapis.com/token')) {
      return Response.json({ access_token: 'acces', refresh_token: 'durable' })
    }
    if (url.includes('/channels')) return Response.json({ items: [{ snippet: { title: 'Ma chaîne' } }] })
    if (url === 'https://stockage.test/video') {
      return new Response(new Uint8Array(BYTES), { headers: { 'content-length': String(BYTES) } })
    }
    if (url.includes('/videos?part=status')) return Response.json({ id: 'yt-1' })
    if (url.includes('/videos?part=snippet')) return overrides.snippet?.() ?? Response.json({ id: 'yt-1' })
    if (url.includes('/playlists?')) return init?.method === 'POST' ? Response.json({ id: 'pl-1' }) : overrides.playlist?.() ?? Response.json({ id: 'pl-1' })
    if (url.includes('/playlistItems?')) return overrides.item?.(String(init?.body)) ?? Response.json({ id: 'item' })
    if (url.includes('/thumbnails/set')) return overrides.thumbnail?.() ?? Response.json({ items: [] })
    if (url.includes('/playlistImages')) return Response.json({ id: 'image-1' })
    if (url.includes('uploadType=resumable')) {
      return overrides.open?.() ?? new Response(null, { headers: { location: 'https://upload.test/session' } })
    }
    if (url === 'https://upload.test/session') {
      if (init?.body instanceof ReadableStream) await new Response(init.body).arrayBuffer()
      return Response.json({ id: 'yt-1' })
    }
    return new Response(null, { status: 404 })
  }) as typeof fetch
  return { calls, impl }
}

async function connected(fetchImpl: typeof fetch, sendable = true) {
  const db = openHubDatabase(':memory:').orm
  const service = new YoutubeService({
    db,
    box: createSecretBox('secret-de-test'.padEnd(48, 'x')),
    publicUrl: 'https://hub.test/',
    fetchImpl,
    source: () => (sendable ? { url: 'https://stockage.test/video', metadata: { title: 'Mon <talk>', description: 'Alice' } } : null),
  })
  service.setClient('id-client', 'secret-client')
  const consent = new URL(service.consentUrl())
  await service.complete(consent.searchParams.get('state')!, 'code')
  return { service, db, consent }
}

describe('the link to the channel', () => {
  it('asks Google for a lasting right, and never gives the secrets back', async () => {
    const { service, db, consent } = await connected(google().impl)
    expect(consent.searchParams.get('access_type')).toBe('offline')
    expect(consent.searchParams.get('redirect_uri')).toBe('https://hub.test/youtube/retour')
    expect(service.status()).toMatchObject({ connected: true, channel: 'Ma chaîne', hasSecret: true })
    expect(JSON.stringify(service.status())).not.toContain('secret-client')
    const stored = JSON.stringify(db.$client.prepare("select value_json from hub_setting where key = 'youtube'").get())
    expect(stored).not.toContain('secret-client')
    expect(stored).not.toContain('durable')
  })

  it('refuses a way back it did not start, and one used twice', async () => {
    const { service, consent } = await connected(google().impl)
    await expect(service.complete('inconnu', 'code')).rejects.toThrow('expirée')
    await expect(service.complete(consent.searchParams.get('state')!, 'code')).rejects.toThrow('expirée')
  })
})

describe('sending a video', () => {
  it('sends it private, and keeps what YouTube calls it', async () => {
    const { calls, impl } = google()
    const { service } = await connected(impl)
    service.enqueue(['job'])
    await service.tick()
    await expect.poll(() => service.envois()[0]?.state).toBe('termine')
    expect(service.envois()[0]).toMatchObject({ videoId: 'yt-1', octets: BYTES, taille: BYTES })
    const opening = calls.find((call) => call.url.includes('uploadType=resumable'))!
    const body = JSON.parse(String(opening.init?.body))
    expect(body.status.privacyStatus).toBe('private')
    expect(body.snippet.title).toBe('Mon talk')
  })

  it('says why it failed, and goes again when asked', async () => {
    const { impl } = google({ open: () => Response.json({ error: { errors: [{ reason: 'quotaExceeded' }] } }, { status: 403 }) })
    const { service } = await connected(impl)
    service.enqueue(['job'])
    await expect.poll(() => service.envois()[0]?.state).toBe('echoue')
    expect(service.envois()[0]?.erreur).toContain('Quota')
    service.enqueue(['job'])
    expect(service.envois()[0]?.erreur).toBeNull()
  })

  it('does not send what can no longer go', async () => {
    const { service } = await connected(google().impl, false)
    service.enqueue(['job'])
    await expect.poll(() => service.envois()[0]?.state).toBe('echoue')
  })

  it('publishes a sent video, and refuses one that is not there yet', async () => {
    const { calls, impl } = google()
    const { service } = await connected(impl)
    await expect(service.setVisibilite('job', true)).rejects.toThrow('pas encore')
    service.enqueue(['job'])
    await expect.poll(() => service.envois()[0]?.state).toBe('termine')
    expect(service.envois()[0]?.visibilite).toBe('private')
    await service.setVisibilite('job', true)
    expect(service.envois()[0]?.visibilite).toBe('public')
    const update = calls.find((call) => call.url.includes('/videos?part=status'))!
    expect(JSON.parse(String(update.init?.body))).toMatchObject({ id: 'yt-1', status: { privacyStatus: 'public' } })
  })

  it('makes a playlist once, then only adds what it does not hold', async () => {
    const { calls, impl } = google()
    const { service } = await connected(impl)
    await service.syncPlaylist('Édition', false, ['a', 'b'])
    expect(service.status().playlist).toEqual({ id: 'pl-1', title: 'Édition', publique: false, videos: 2 })
    await service.syncPlaylist('Édition 2026', true, ['a', 'b', 'c'])
    expect(service.status().playlist).toEqual({ id: 'pl-1', title: 'Édition 2026', publique: true, videos: 3 })
    expect(calls.filter((call) => call.url.includes('/playlists?') && call.init?.method === 'POST')).toHaveLength(1)
    expect(calls.filter((call) => call.url.includes('/playlistItems?'))).toHaveLength(3)
  })

  it('makes it again when it was deleted on YouTube', async () => {
    const { impl } = google({ playlist: () => new Response(null, { status: 404 }) })
    const { service } = await connected(impl)
    await service.syncPlaylist('Édition', false, ['a'])
    await service.syncPlaylist('Édition', false, ['a'])
    expect(service.status().playlist?.videos).toBe(1)
  })

  it('keeps what was added when an addition fails', async () => {
    const { impl } = google({ item: (body) => (body.includes('"b"') ? new Response(null, { status: 500 }) : null) })
    const { service } = await connected(impl)
    await expect(service.syncPlaylist('Édition', false, ['a', 'b'])).rejects.toThrow('500')
    expect(service.status().playlist?.videos).toBe(1)
  })

  it('gives a sent video its current name, without sending it again', async () => {
    const { calls, impl } = google()
    const { service } = await connected(impl)
    service.enqueue(['job'])
    await expect.poll(() => service.envois()[0]?.state).toBe('termine')
    const uploads = calls.filter((call) => call.url.includes('uploadType=resumable')).length
    await service.syncMetadata('job')
    const update = calls.find((call) => call.url.includes('/videos?part=snippet'))!
    expect(JSON.parse(String(update.init?.body))).toMatchObject({ id: 'yt-1', snippet: { title: 'Mon talk', categoryId: '28' } })
    expect(calls.filter((call) => call.url.includes('uploadType=resumable'))).toHaveLength(uploads)
  })

  it('says to connect again when Google lacks the right', async () => {
    const { impl } = google({ snippet: () => Response.json({ error: { message: 'Request had insufficient authentication scopes.', errors: [{ reason: 'insufficientPermissions' }] } }, { status: 403 }) })
    const { service } = await connected(impl)
    service.enqueue(['job'])
    await expect.poll(() => service.envois()[0]?.state).toBe('termine')
    await expect(service.syncMetadata('job')).rejects.toThrow('reconnectez')
  })

  it('draws a thumbnail once asked, and sends it only when told', async () => {
    const { calls, impl } = google()
    const { service } = await connected(impl)
    service.enqueue(['job'])
    await expect.poll(() => service.envois()[0]?.state).toBe('termine')
    service.genererVignettes(['job'])
    expect(service.claimVignette()).toBe('job')
    expect(service.claimVignette()).toBeNull()
    service.saveVignette('job', Buffer.from('jpeg'))
    expect(service.vignettes()[0]).toMatchObject({ cle: 'job', state: 'prete' })
    expect(calls.some((call) => call.url.includes('/thumbnails/set'))).toBe(false)
    await service.envoyerVignettes()
    expect(service.vignettes()[0]?.state).toBe('envoyee')
    expect(calls.find((call) => call.url.includes('/thumbnails/set'))!.url).toContain('videoId=yt-1')
  })

  it('sends only the thumbnails it was asked to', async () => {
    const { impl } = google()
    const { service } = await connected(impl)
    service.genererVignettes(['a', 'b'])
    service.claimVignette()
    service.claimVignette()
    service.saveVignette('a', Buffer.from('jpeg'))
    service.saveVignette('b', Buffer.from('jpeg'))
    await service.envoyerVignettes(['b'])
    expect(service.vignettes().find((vignette) => vignette.cle === 'a')?.state).toBe('prete')
    expect(service.vignettes().find((vignette) => vignette.cle === 'b')?.erreur).toContain('pas encore')
  })

  it('keeps a thumbnail ready, with the reason, when YouTube refuses it', async () => {
    const { impl } = google({ thumbnail: () => Response.json({ error: { message: 'forbidden' } }, { status: 403 }) })
    const { service } = await connected(impl)
    service.enqueue(['job'])
    await expect.poll(() => service.envois()[0]?.state).toBe('termine')
    service.genererVignettes(['job'])
    service.claimVignette()
    service.saveVignette('job', Buffer.from('jpeg'))
    await service.envoyerVignettes()
    expect(service.vignettes()[0]).toMatchObject({ state: 'prete', erreur: expect.stringContaining('403') })
  })

  it('sends the playlist image once the playlist exists', async () => {
    const { calls, impl } = google()
    const { service } = await connected(impl)
    service.genererVignettes(['playlist'])
    service.claimVignette()
    service.saveVignette('playlist', Buffer.from('jpeg'))
    await service.envoyerVignettes()
    expect(service.vignettes()[0]?.erreur).toContain('playlist')
    await service.syncPlaylist('Édition', false, [])
    await service.envoyerVignettes()
    expect(service.vignettes()[0]?.state).toBe('envoyee')
    expect(calls.find((call) => call.url.includes('/playlistImages'))!.init?.method).toBe('POST')
  })

  it('cleans a title for YouTube', () => {
    expect(youtubeTitle('x'.repeat(200))).toHaveLength(100)
    const title = 'Comment Développer une application dans un dataspace souverain'
    expect(youtubeTitle(`${title} - Alice Martin`)).toBe(`${title} - Alice Martin`)
    expect(youtubeTitle(`${title} - Alice Martin, Bob Durand, Claire Petit, David Roux`)).toBe(`${title} - Alice Martin et al.`)
    expect(youtubeTitle(`${title}, et ensuite le consommer - Alice Martin`)).toBe(`${title}, et ensuite le consommer`)
    const tooLong = youtubeTitle(`${'mot '.repeat(40)}- Alice`)
    expect(tooLong.endsWith('…')).toBe(true)
    expect(tooLong.length).toBeLessThanOrEqual(100)
    expect(youtubeTitle('<>')).toBe('Vidéo')
  })
})
