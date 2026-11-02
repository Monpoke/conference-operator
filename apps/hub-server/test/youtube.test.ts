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
function google(overrides: { open?: () => Response } = {}) {
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

  it('cleans a title for YouTube', () => {
    expect(youtubeTitle(`<b>${'x'.repeat(200)}`)).toHaveLength(100)
    expect(youtubeTitle('<>')).toBe('Vidéo')
  })
})
