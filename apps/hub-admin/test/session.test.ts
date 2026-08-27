import { flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useSessionStore } from '../src/stores/session.js'

/**
 * Les deux façons d'entrer dans la console, et la seule qui laisse un jeton.
 *
 * Rien ne couvrait ce chemin, et il s'est cassé en trois endroits d'un coup à
 * la migration : le bouton Google partait en GET là où Better Auth attend un
 * POST, le retour du round-trip n'était pas reconnu faute de jeton, et la
 * déconnexion ne touchait pas au cookie. Les trois se ressemblent : le mot de
 * passe range un jeton, Google range un cookie, et tout ce qui ne regarde que
 * le jeton ne voit qu'une moitié du système.
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

function stubFetch(reponses: Record<string, { status?: number; body: unknown }>): Appel[] {
  const appels: Appel[] = []
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    appels.push({
      url,
      method: init?.method,
      body: init?.body == null ? undefined : JSON.parse(String(init.body)),
    })
    const reponse = reponses[url] ?? { status: 404, body: null }
    return new Response(JSON.stringify(reponse.body), {
      status: reponse.status ?? 200,
      headers: { 'content-type': 'application/json' },
    })
  })
  return appels
}

let destination: string | null = null

beforeEach(() => {
  setActivePinia(createPinia())
  destination = null
  const stockage = new Map<string, string>()
  vi.stubGlobal('localStorage', {
    getItem: (cle: string) => stockage.get(cle) ?? null,
    setItem: (cle: string, valeur: string) => stockage.set(cle, valeur),
    removeItem: (cle: string) => stockage.delete(cle),
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

  it('refuse sans laisser croire à une panne du hub', async () => {
    stubFetch({ '/api/auth/sign-in/email': { status: 401, body: {} } })
    const session = useSessionStore()

    await session.signIn('regie@cloudnord.fr', 'faux')

    expect(session.signedIn).toBe(false)
    expect(session.error).toContain('refusés')
  })
})

describe('connexion Google', () => {
  it('passe par un POST, et suit l’adresse rendue', async () => {
    const appels = stubFetch({
      '/api/auth/sign-in/social': { body: { url: 'https://accounts.google.com/o/oauth2/v2/auth?x=1' } },
    })
    const session = useSessionStore()

    await session.signInWithGoogle()

    /*
     * Le défaut d'origine tenait en un GET : Better Auth ne redirige pas depuis
     * cette adresse, il répond `null`. Un `location.assign` dessus donne une
     * page blanche qui ne dit rien de ce qui a manqué.
     */
    expect(appels[0]?.method).toBe('POST')
    expect(appels[0]?.body).toEqual({ provider: 'google', callbackURL: '/admin' })
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
  it('reconnaît une session posée en cookie, sans jeton', async () => {
    stubFetch({ '/api/auth/get-session': { body: { user: { email: 'regie@cloudnord.fr' } } } })
    const session = useSessionStore()

    session.start(BOOT)
    await flushPromises()

    // Le round-trip ne laisse aucun jeton : ne regarder que le stockage local
    // renvoyait l'opérateur sur l'écran de connexion qu'il venait de quitter.
    expect(session.signedIn).toBe(true)
    expect(session.identity).toBe('regie@cloudnord.fr')
  })

  it('reste sur l’écran de connexion quand il n’y a aucune session', async () => {
    stubFetch({ '/api/auth/get-session': { body: {} } })
    const session = useSessionStore()

    session.start(BOOT)
    await flushPromises()

    expect(session.signedIn).toBe(false)
  })

  it('n’interroge pas le hub quand un jeton suffit', async () => {
    const appels = stubFetch({})
    localStorage.setItem('hub-admin', 'jeton-range')
    const session = useSessionStore()

    session.start(BOOT)
    await flushPromises()

    // Un aller-retour de plus devant chaque chargement, pour une information
    // que le premier appel protégé donnera de toute façon.
    expect(session.signedIn).toBe(true)
    expect(appels).toEqual([])
  })
})

describe('déconnexion', () => {
  it('prévient le hub, parce qu’un cookie ne s’efface que côté serveur', async () => {
    const appels = stubFetch({ '/api/auth/sign-out': { body: {} } })
    const session = useSessionStore()
    session.client.token.write('jeton-operateur')

    await session.signOut()

    expect(appels[0]?.url).toBe('/api/auth/sign-out')
    expect(appels[0]?.method).toBe('POST')
    expect(session.signedIn).toBe(false)
    expect(session.client.token.read()).toBe(null)
  })

  it('ferme quand même ici si le hub ne répond pas', async () => {
    vi.stubGlobal('fetch', async () => {
      throw new Error('injoignable')
    })
    const session = useSessionStore()
    session.client.token.write('jeton-operateur')

    await session.signOut()

    // Rester connecté parce que le hub n'a pas répondu est le contraire de ce
    // qu'on demande en cliquant.
    expect(session.signedIn).toBe(false)
    expect(session.client.token.read()).toBe(null)
  })
})
