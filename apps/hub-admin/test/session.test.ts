import { flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useSessionStore } from '../src/stores/session.js'

/**
 * The two ways into the console, and the only one that leaves a token.
 *
 * Nothing covered this path, and it broke in three places at once during the
 * migration: the Google button went out as a GET where Better Auth expects a POST,
 * the round trip's return was not recognised for want of a token, and signing out
 * did not touch the cookie. All three are alike: the password stores a token,
 * Google stores a cookie, and anything that only looks at the token sees half the
 * system.
 */

const BOOT = {
  mode: 'production' as const,
  event: { name: 'Cloud Nord 2026', shortName: 'Cloud Nord' },
  google: { domain: 'cloudnord.fr' },
}

interface Appel {
  url: string
  method?: string
  body?: unknown
}

function stubFetch(responses: Record<string, { status?: number; body: unknown }>): Appel[] {
  const calls: Appel[] = []
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    calls.push({
      url,
      method: init?.method,
      body: init?.body == null ? undefined : JSON.parse(String(init.body)),
    })
    const response = responses[url] ?? { status: 404, body: null }
    return new Response(JSON.stringify(response.body), {
      status: response.status ?? 200,
      headers: { 'content-type': 'application/json' },
    })
  })
  return calls
}

let destination: string | null = null

beforeEach(() => {
  setActivePinia(createPinia())
  destination = null
  const storage = new Map<string, string>()
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key),
  })
  vi.stubGlobal('location', {
    assign: (url: string) => {
      destination = url
    },
  })
})

describe('connexion par mot de passe', () => {
  it('range le jeton que le hub renvoie', async () => {
    stubFetch({ '/api/auth/sign-in/email': { body: { token: 'jeton-operateur' } } })
    const session = useSessionStore()

    await session.signIn('regie@cloudnord.fr', 'motdepasse')

    expect(session.signedIn).toBe(true)
    expect(session.client.token.read()).toBe('jeton-operateur')
  })

  it('refuses without suggesting the hub has failed', async () => {
    stubFetch({ '/api/auth/sign-in/email': { status: 401, body: {} } })
    const session = useSessionStore()

    await session.signIn('regie@cloudnord.fr', 'faux')

    expect(session.signedIn).toBe(false)
    expect(session.error).toContain('refusés')
  })
})

describe('connexion Google', () => {
  it('passe par un POST, et suit l’adresse rendue', async () => {
    const calls = stubFetch({
      '/api/auth/sign-in/social': { body: { url: 'https://accounts.google.com/o/oauth2/v2/auth?x=1' } },
    })
    const session = useSessionStore()

    await session.signInWithGoogle()

    /*
     * The original defect came down to a GET: Better Auth does not redirect from
     * this address, it answers `null`. A `location.assign` on it gives a blank page
     * that says nothing about what was missing.
     */
    expect(calls[0]?.method).toBe('POST')
    expect(calls[0]?.body).toEqual({ provider: 'google', callbackURL: '/admin' })
    expect(destination).toBe('https://accounts.google.com/o/oauth2/v2/auth?x=1')
  })

  it('ne navigue nulle part quand le hub ne rend pas d’adresse', async () => {
    stubFetch({ '/api/auth/sign-in/social': { status: 500, body: { message: 'Google non configuré' } } })
    const session = useSessionStore()

    await session.signInWithGoogle()

    expect(destination).toBe(null)
    expect(session.error).toBe('Google non configuré')
  })
})

describe('retour de Google', () => {
  it('recognises a session set in a cookie, with no token', async () => {
    stubFetch({ '/api/auth/get-session': { body: { user: { email: 'regie@cloudnord.fr' } } } })
    const session = useSessionStore()

    session.start(BOOT)
    await flushPromises()

    // Le round-trip ne laisse aucun jeton : ne regarder que le stockage local
    // sent the operator back to the sign-in screen they had just left.
    expect(session.signedIn).toBe(true)
    expect(session.identity).toBe('regie@cloudnord.fr')
  })

  it('stays on the sign-in screen when there is no session', async () => {
    stubFetch({ '/api/auth/get-session': { body: {} } })
    const session = useSessionStore()

    session.start(BOOT)
    await flushPromises()

    expect(session.signedIn).toBe(false)
  })

  it('n’interroge pas le hub quand un jeton suffit', async () => {
    const calls = stubFetch({})
    localStorage.setItem('hub-admin', 'jeton-range')
    const session = useSessionStore()

    session.start(BOOT)
    await flushPromises()

    // Un aller-retour de plus devant chaque chargement, pour une information
    // that the first protected call will give anyway.
    expect(session.signedIn).toBe(true)
    expect(calls).toEqual([])
  })
})

describe('signing out', () => {
  it('tells the hub, because a cookie is only cleared server-side', async () => {
    const calls = stubFetch({ '/api/auth/sign-out': { body: {} } })
    const session = useSessionStore()
    session.client.token.write('jeton-operateur')

    await session.signOut()

    expect(calls[0]?.url).toBe('/api/auth/sign-out')
    expect(calls[0]?.method).toBe('POST')
    expect(session.signedIn).toBe(false)
    expect(session.client.token.read()).toBe(null)
  })

  it('closes here all the same if the hub does not answer', async () => {
    vi.stubGlobal('fetch', async () => {
      throw new Error('injoignable')
    })
    const session = useSessionStore()
    session.client.token.write('jeton-operateur')

    await session.signOut()

    // Staying signed in because the hub did not answer is the opposite of what
    // qu'on demande en cliquant.
    expect(session.signedIn).toBe(false)
    expect(session.client.token.read()).toBe(null)
  })
})
