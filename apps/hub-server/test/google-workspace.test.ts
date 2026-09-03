import { afterEach, describe, expect, it } from 'vitest'
import { createHub, type Hub } from '../src/server.js'
import { configSchema } from '../src/config.js'

/**
 * Operator sign-in through Google Workspace.
 *
 * The domain is the only boundary: every account of the configured domain is an
 * operator, and no other one is. These tests therefore bear on what keeps that
 * boundary — the hint sent to Google, the refusal to start with no domain, and
 * the fact that the provider does not mount itself.
 */

const BASE = {
  port: 0,
  host: '127.0.0.1',
  databasePath: ':memory:',
  publicUrl: 'http://127.0.0.1',
  authSecret: 'test-secret-'.padEnd(48, 'x'),
  logLevel: 'fatal' as const,
}

let hub: Hub | null = null

async function start(config: Record<string, unknown>): Promise<string> {
  hub = await createHub({ ...BASE, ...config })
  await hub.app.listen({ port: 0, host: '127.0.0.1' })
  const address = hub.app.server.address()
  return `http://127.0.0.1:${typeof address === 'object' && address != null ? address.port : 0}`
}

async function askGoogle(origin: string) {
  const response = await fetch(`${origin}/api/auth/sign-in/social`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ provider: 'google', callbackURL: '/admin' }),
  })
  return { status: response.status, body: (await response.json()) as { url?: string } }
}

afterEach(async () => {
  await hub?.close()
  hub = null
})

describe('configuration', () => {
  it('refuses a half-filled Google', () => {
    // Letting it through would raise a hub where the button fails on every click,
    // and one would look for the failure in the Google Cloud console.
    const partial = configSchema.safeParse({ ...BASE, googleClientId: 'abc.apps.googleusercontent.com' })
    expect(partial.success).toBe(false)
    expect(configSchema.safeParse({ ...BASE, googleClientSecret: 'chut' }).success).toBe(false)
  })

  it('refuses a Google with no domain', () => {
    // No default, and that is the point: a hard-written domain belongs to one
    // organizer only, and letting it serve as a fallback would open one event's
    // console to another's staff. The hub refuses to guess.
    const withoutDomain = configSchema.safeParse({
      ...BASE,
      googleClientId: 'client-de-test.apps.googleusercontent.com',
      googleClientSecret: 'secret-de-test',
    })
    expect(withoutDomain.success).toBe(false)
  })

  it('does not demand a domain when Google is not configured', () => {
    // The default case: an event hub must start with no Google account.
    const config = configSchema.parse(BASE)
    expect(config.googleHostedDomain).toBeUndefined()
  })
})

describe('Google sign-in', () => {
  it('does not exist for as long as the hub has no credentials', async () => {
    const origin = await start({})

    const { status } = await askGoogle(origin)
    expect(status).toBeGreaterThanOrEqual(400)
  })

  it('takes you to Google while imposing the domain', async () => {
    const origin = await start({
      googleClientId: 'client-de-test.apps.googleusercontent.com',
      googleClientSecret: 'secret-de-test',
      googleHostedDomain: 'cloudnord.fr',
    })

    const { status, body } = await askGoogle(origin)
    expect(status).toBe(200)
    const url = new URL(body.url!)
    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth')
    // `hd` restricts the account-picker screen. It is only a hint — Better Auth
    // rechecks the claim on the way back — but its absence would put personal
    // accounts first.
    expect(url.searchParams.get('hd')).toBe('cloudnord.fr')
    // The return address must be served by this hub, otherwise the whole round
    // trip ends on a 404 after a successful authentication.
    expect(url.searchParams.get('redirect_uri')).toBe(`${BASE.publicUrl}/api/auth/callback/google`)
  })

  it('honours a domain other than the default one', async () => {
    const origin = await start({
      googleClientId: 'client-de-test.apps.googleusercontent.com',
      googleClientSecret: 'secret-de-test',
      googleHostedDomain: 'exemple.org',
    })

    const { body } = await askGoogle(origin)
    expect(new URL(body.url!).searchParams.get('hd')).toBe('exemple.org')
  })

  it('leaves the password door open', async () => {
    // Google requires the internet at sign-in time; this whole system is built to
    // survive an outage. The local door does not close.
    const origin = await start({
      googleClientId: 'client-de-test.apps.googleusercontent.com',
      googleClientSecret: 'secret-de-test',
      googleHostedDomain: 'cloudnord.fr',
    })

    const response = await fetch(`${origin}/api/auth/sign-in/email`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'inconnu@cloudnord.fr', password: 'x'.repeat(12) }),
    })
    // A credentials refusal, not "no such path": the route stays mounted.
    expect(response.status).toBe(401)
  })
})
