// @vitest-environment happy-dom
/// <reference lib="dom" />
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createHubClient } from '../src/index.js'
import { browserTokenStore } from '../src/token.js'

/**
 * What is worth testing here is the wiring, not oRPC.
 *
 * Three behaviours used to live inside the console's own `appeler()`, where
 * each was one call site away from being forgotten: sending the bearer, wiping
 * a session the hub has stopped honouring, and having one place that learns
 * about a failure. A stub `fetch` is enough to pin all three; that the contract
 * is honoured over the wire is the integration suite's job.
 */

/** Answers like the hub does: oRPC over HTTP is a `{ json: … }` envelope. */
function respondWith(status: number, body: unknown): typeof fetch {
  return (async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    })) as unknown as typeof fetch
}

/** Captures what the link decided to send. */
function capture(): { calls: RequestInit[]; fetch: typeof fetch } {
  const calls: RequestInit[] = []
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    calls.push(init)
    return new Response(JSON.stringify({ json: { ok: true } }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }) as unknown as typeof fetch
  return { calls, fetch: fetchImpl }
}

function headersOf(init: RequestInit | undefined): Record<string, string> {
  return Object.fromEntries(new Headers(init?.headers).entries())
}

beforeEach(() => {
  localStorage.clear()
})

describe('token store', () => {
  it('survives a browser that refuses site data', () => {
    const throwing = {
      getItem() {
        throw new Error('site data blocked')
      },
      setItem() {
        throw new Error('site data blocked')
      },
      removeItem() {
        throw new Error('site data blocked')
      },
    }
    vi.stubGlobal('localStorage', throwing)

    const store = browserTokenStore('hub-admin')
    expect(() => store.write('jeton')).not.toThrow()
    // Kept for this page's lifetime rather than lost: the operator signed in,
    // and the storage failure is not their problem to solve mid-event.
    expect(store.read()).toBe('jeton')
    expect(() => store.clear()).not.toThrow()
    expect(store.read()).toBe(null)

    vi.unstubAllGlobals()
  })
})

describe('createHubClient', () => {
  it('sends the bearer once a token is stored', async () => {
    const spy = capture()
    const client = createHubClient({ origin: 'http://hub.test', tokenKey: 'hub-admin', fetch: spy.fetch })
    client.token.write('jeton-de-test')

    await client.rpc.meta.hello({ protocolVersion: 1 })

    expect(headersOf(spy.calls[0])['authorization']).toBe('Bearer jeton-de-test')
  })

  it('sends no bearer at all when it has no token', async () => {
    const spy = capture()
    const client = createHubClient({ origin: 'http://hub.test', tokenKey: null, fetch: spy.fetch })

    await client.rpc.meta.hello({ protocolVersion: 1 })

    // Absent, not empty: `Bearer ` with nothing after it is a header the hub
    // has to decide about, and there is nothing to decide.
    expect(headersOf(spy.calls[0])).not.toHaveProperty('authorization')
  })

  it('merges the callers own headers', async () => {
    const spy = capture()
    const client = createHubClient({
      origin: 'http://hub.test',
      tokenKey: null,
      headers: () => ({ 'x-room-client-id': 'salle-1' }),
      fetch: spy.fetch,
    })

    await client.rpc.meta.hello({ protocolVersion: 1 })

    expect(headersOf(spy.calls[0])['x-room-client-id']).toBe('salle-1')
  })

  it('drops the session and says so when the hub answers 401', async () => {
    const onExpired = vi.fn()
    const onError = vi.fn()
    const client = createHubClient({
      origin: 'http://hub.test',
      tokenKey: 'hub-admin',
      onExpired,
      onError,
      fetch: respondWith(401, { json: { code: 'UNAUTHORIZED', message: 'Session expirée' } }),
    })
    client.token.write('jeton-perime')

    await expect(client.rpc.meta.hello({ protocolVersion: 1 })).rejects.toThrow()

    expect(onExpired).toHaveBeenCalledOnce()
    // Cleared before the caller is told: a token the hub has stopped honouring
    // would only produce a second 401.
    expect(client.token.read()).toBe(null)
    expect(localStorage.getItem('hub-admin')).toBe(null)
    // An expired session is not an error to raise a toast about — it has its
    // own screen.
    expect(onError).not.toHaveBeenCalled()
  })

  it('reports any other failure once, and still throws', async () => {
    const onExpired = vi.fn()
    const onError = vi.fn()
    const client = createHubClient({
      origin: 'http://hub.test',
      tokenKey: 'hub-admin',
      onExpired,
      onError,
      fetch: respondWith(500, { json: { code: 'INTERNAL_SERVER_ERROR', message: 'boum' } }),
    })
    client.token.write('jeton-valide')

    await expect(client.rpc.meta.hello({ protocolVersion: 1 })).rejects.toThrow()

    expect(onError).toHaveBeenCalledOnce()
    expect(onExpired).not.toHaveBeenCalled()
    // The hook does not swallow: the caller still decides what to do.
    expect(client.token.read()).toBe('jeton-valide')
  })
})
