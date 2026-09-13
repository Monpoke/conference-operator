import { createHmac } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openHubDatabase, type HubDatabase } from '../src/db.js'
import { IntegrationService, maskUrl } from '../src/services/integrations.js'
import { consoleUrl, formatDelivery } from '../src/services/integrations-format.js'
import type { PushPayload } from '../src/services/push.js'

/**
 * Integrations: the supervision notices, sent to Slack, Mattermost or a webhook.
 *
 * Same notices and same levels as Web Push; what is specific here is the format
 * each end expects, the signature, and what to do when the other end does not
 * answer.
 */

const NOTICE = (patch: Partial<PushPayload> = {}): PushPayload => ({
  title: 'OBS-A coupé dans Track #1',
  body: 'La régie ne pilote plus la machine A.',
  tag: 'obs-track-1-A',
  view: 'exploitation',
  family: 'technique',
  level: 'essentiel',
  ...patch,
})

const CONTEXT = {
  publicUrl: 'https://hub.example.org',
  eventName: 'DevFest Lille',
  deliveryId: '01DELIVERY',
  sentAt: '2026-09-13T10:00:00.000Z',
  secret: null,
}

/** A fetch that answers from a script: a status, or an error thrown. */
function scriptedFetch(script: (number | Error)[]) {
  const calls: { url: string; init: RequestInit }[] = []
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} })
    const next = script.shift() ?? 200
    if (next instanceof Error) throw next
    return new Response(next === 200 ? 'ok' : 'boom', { status: next })
  }) as typeof fetch
  return { impl, calls }
}

describe('integration formats', () => {
  it('links a notice to the console view the service worker would open', () => {
    expect(consoleUrl('https://hub.example.org', 'exploitation')).toBe('https://hub.example.org/admin')
    expect(consoleUrl('https://hub.example.org', 'appairage')).toBe(
      'https://hub.example.org/admin/appairage',
    )
    expect(consoleUrl(null, 'exploitation')).toBeNull()
  })

  it('speaks Slack mrkdwn to Slack', () => {
    const { body } = formatDelivery('slack', NOTICE(), CONTEXT)
    expect(JSON.parse(body)).toEqual({
      text: '🔴 *OBS-A coupé dans Track #1*\nLa régie ne pilote plus la machine A.\n<https://hub.example.org/admin|Ouvrir dans la console>',
    })
  })

  it('speaks Markdown to Mattermost, under the event name', () => {
    const { body } = formatDelivery('mattermost', NOTICE({ level: 'tout' }), {
      ...CONTEXT,
      publicUrl: null,
    })
    expect(JSON.parse(body)).toEqual({
      text: 'ℹ️ **OBS-A coupé dans Track #1**\nLa régie ne pilote plus la machine A.',
      username: 'DevFest Lille',
    })
  })

  it('signs the generic webhook over the exact bytes sent', () => {
    const { body, headers } = formatDelivery('webhook', NOTICE(), { ...CONTEXT, secret: 's3cr3t' })

    const expected = `sha256=${createHmac('sha256', 's3cr3t').update(body).digest('hex')}`
    expect(headers['x-hub-signature-256']).toBe(expected)
    expect(headers['x-hub-event']).toBe('supervision.notice')
    expect(headers['x-hub-delivery']).toBe('01DELIVERY')
    expect(JSON.parse(body)).toMatchObject({
      type: 'supervision.notice',
      id: '01DELIVERY',
      event: { name: 'DevFest Lille' },
      notice: { family: 'technique', level: 'essentiel', url: 'https://hub.example.org/admin' },
    })
  })

  it('sends no signature header without a secret', () => {
    const { headers } = formatDelivery('webhook', NOTICE(), CONTEXT)
    expect(headers).not.toHaveProperty('x-hub-signature-256')
  })
})

describe('integration service', () => {
  let db: HubDatabase
  let close: () => void

  beforeEach(() => {
    const opened = openHubDatabase(':memory:')
    db = opened.orm
    close = () => opened.sqlite.close()
  })

  afterEach(() => close())

  const service = (fetchImpl: typeof fetch, retryDelaysMs = [1, 2, 3]) => {
    const waited: number[] = []
    const integrations = new IntegrationService(db, {
      publicUrl: 'https://hub.example.org',
      eventName: () => 'DevFest Lille',
      fetchImpl,
      retryDelaysMs,
      sleep: async (ms) => {
        waited.push(ms)
      },
    })
    return { integrations, waited }
  }

  const create = (
    integrations: IntegrationService,
    patch: Partial<Parameters<IntegrationService['create']>[0]> = {},
  ) =>
    integrations.create({
      kind: 'slack',
      name: '#regie',
      url: 'https://hooks.slack.com/services/T000/B000/abcdefghWXYZ',
      secret: null,
      levels: { technique: 'tout', exploitation: 'rien' },
      enabled: true,
      ...patch,
    })

  it('sends a notice only where the family level reaches it', async () => {
    const fetch = scriptedFetch([])
    const { integrations } = service(fetch.impl)
    create(integrations, { name: 'tout', url: 'https://a.example/tout' })
    create(integrations, {
      name: 'essentiel',
      url: 'https://a.example/essentiel',
      levels: { technique: 'essentiel', exploitation: 'rien' },
    })
    create(integrations, {
      name: 'exploitation',
      url: 'https://a.example/exploitation',
      levels: { technique: 'rien', exploitation: 'tout' },
    })
    create(integrations, { name: 'off', url: 'https://a.example/off', enabled: false })

    expect(await integrations.send(NOTICE({ level: 'tout' }))).toBe(1)
    expect(fetch.calls.map((call) => call.url)).toEqual(['https://a.example/tout'])

    fetch.calls.length = 0
    expect(await integrations.send(NOTICE({ level: 'essentiel' }))).toBe(2)
    expect(fetch.calls.map((call) => call.url).sort()).toEqual([
      'https://a.example/essentiel',
      'https://a.example/tout',
    ])
    expect(integrations.activeCount()).toBe(3)
  })

  it('retries a server error, then records the success', async () => {
    const fetch = scriptedFetch([500, 503, 200])
    const { integrations, waited } = service(fetch.impl)
    const created = create(integrations)

    expect(await integrations.send(NOTICE())).toBe(1)
    expect(fetch.calls).toHaveLength(3)
    expect(waited).toEqual([1, 2])
    // One delivery, three attempts: the receiver must be able to recognise them.
    const ids = fetch.calls.map((call) => (call.init.headers as Record<string, string>)['content-type'])
    expect(new Set(fetch.calls.map((call) => call.init.body)).size).toBe(1)
    expect(ids).toHaveLength(3)

    const [view] = integrations.list()
    expect(view!.id).toBe(created.id)
    expect(view!.lastSentAt).not.toBeNull()
    expect(view!.lastError).toBeNull()
  })

  it('does not retry what will answer the same thing', async () => {
    const fetch = scriptedFetch([404])
    const { integrations, waited } = service(fetch.impl)
    create(integrations)

    expect(await integrations.send(NOTICE())).toBe(0)
    expect(fetch.calls).toHaveLength(1)
    expect(waited).toEqual([])
    expect(integrations.list()[0]!.lastError).toBe('Réponse 404 : boom')
  })

  it('gives up after the last retry when the network stays down', async () => {
    const fetch = scriptedFetch([new Error('ECONNREFUSED'), new Error('ECONNREFUSED'), new Error('ECONNREFUSED'), new Error('ECONNREFUSED')])
    const { integrations, waited } = service(fetch.impl)
    create(integrations)

    expect(await integrations.send(NOTICE())).toBe(0)
    expect(fetch.calls).toHaveLength(4)
    expect(waited).toEqual([1, 2, 3])
    const [view] = integrations.list()
    expect(view!.lastError).toBe('Injoignable : ECONNREFUSED')
    expect(view!.lastErrorAt).not.toBeNull()
  })

  it('tests once, whatever the levels, and says what the other end answered', async () => {
    const fetch = scriptedFetch([500])
    const { integrations, waited } = service(fetch.impl)
    const created = create(integrations, { levels: { technique: 'rien', exploitation: 'rien' }, enabled: false })

    expect(await integrations.test(created.id)).toEqual({ ok: false, status: 500, error: 'Réponse 500 : boom' })
    expect(fetch.calls).toHaveLength(1)
    expect(waited).toEqual([])
    expect(await integrations.test('unknown')).toBeNull()
  })

  it('never gives the address or the secret back', () => {
    const { integrations } = service(scriptedFetch([]).impl)
    create(integrations, { kind: 'webhook', url: 'https://example.org/hook/secret-path-1234', secret: 'k' })

    const [view] = integrations.list()
    expect(view!.url).toBe('https://example.org/…1234')
    expect(view!.hasSecret).toBe(true)
    expect(JSON.stringify(view)).not.toContain('secret-path')
    expect(maskUrl('not a url')).toBe('…')
  })

  it('keeps what a partial update leaves out', async () => {
    const fetch = scriptedFetch([])
    const { integrations } = service(fetch.impl)
    const created = create(integrations, { kind: 'webhook', url: 'https://example.org/hook', secret: 'k' })

    const updated = integrations.update({ id: created.id, levels: { technique: 'rien', exploitation: 'tout' } })
    expect(updated).toMatchObject({ hasSecret: true, levels: { technique: 'rien', exploitation: 'tout' } })

    await integrations.send(NOTICE({ family: 'exploitation' }))
    expect(fetch.calls[0]!.url).toBe('https://example.org/hook')
    expect(fetch.calls[0]!.init.headers).toHaveProperty('x-hub-signature-256')

    expect(integrations.update({ id: created.id, secret: null })!.hasSecret).toBe(false)
    expect(integrations.update({ id: 'unknown', name: 'x' })).toBeNull()
  })

  it('keeps no secret on Slack or Mattermost', () => {
    const { integrations } = service(scriptedFetch([]).impl)
    expect(create(integrations, { secret: 'ignored' }).hasSecret).toBe(false)
  })

  it('removes an integration', () => {
    const { integrations } = service(scriptedFetch([]).impl)
    const created = create(integrations)
    expect(integrations.remove(created.id)).toBe(true)
    expect(integrations.remove(created.id)).toBe(false)
    expect(integrations.list()).toEqual([])
  })
})
