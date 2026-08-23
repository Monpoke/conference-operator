import { afterEach, describe, expect, it } from 'vitest'
import { createHub, type Hub } from '../src/server.js'
import { configSchema } from '../src/config.js'

/**
 * Connexion des opérateurs par Google Workspace.
 *
 * Le domaine est la seule frontière : tout compte du domaine configuré est un
 * opérateur, et aucun autre ne l'est. Ces tests portent donc sur ce qui garde
 * cette frontière — l'indice envoyé à Google, le refus de démarrer sans
 * domaine, et le fait que le fournisseur ne se monte pas tout seul.
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

async function demarrer(config: Record<string, unknown>): Promise<string> {
  hub = await createHub({ ...BASE, ...config })
  await hub.app.listen({ port: 0, host: '127.0.0.1' })
  const address = hub.app.server.address()
  return `http://127.0.0.1:${typeof address === 'object' && address != null ? address.port : 0}`
}

async function demanderGoogle(origin: string) {
  const reponse = await fetch(`${origin}/api/auth/sign-in/social`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ provider: 'google', callbackURL: '/admin' }),
  })
  return { status: reponse.status, body: (await reponse.json()) as { url?: string } }
}

afterEach(async () => {
  await hub?.close()
  hub = null
})

describe('configuration', () => {
  it('refuse un Google à moitié renseigné', () => {
    // Le laisser passer monterait un hub où le bouton échoue à chaque clic, et
    // on chercherait la panne dans la console Google Cloud.
    const partiel = configSchema.safeParse({ ...BASE, googleClientId: 'abc.apps.googleusercontent.com' })
    expect(partiel.success).toBe(false)
    expect(configSchema.safeParse({ ...BASE, googleClientSecret: 'chut' }).success).toBe(false)
  })

  it('refuse un Google sans domaine', () => {
    // Pas de défaut, et c'est le point : un domaine écrit en dur n'appartient
    // qu'à un organisateur, et le laisser servir de repli ouvrirait la console
    // d'un autre événement au personnel du premier. Le hub refuse de deviner.
    const sansDomaine = configSchema.safeParse({
      ...BASE,
      googleClientId: 'client-de-test.apps.googleusercontent.com',
      googleClientSecret: 'secret-de-test',
    })
    expect(sansDomaine.success).toBe(false)
  })

  it('ne réclame pas de domaine quand Google n\'est pas configuré', () => {
    // Le cas par défaut : un hub d'événement doit démarrer sans compte Google.
    const config = configSchema.parse(BASE)
    expect(config.googleHostedDomain).toBeUndefined()
  })
})

describe('connexion Google', () => {
  it("n'existe pas tant que le hub n'a pas d'identifiants", async () => {
    const origin = await demarrer({})

    const { status } = await demanderGoogle(origin)
    expect(status).toBeGreaterThanOrEqual(400)
  })

  it('emmène vers Google en imposant le domaine', async () => {
    const origin = await demarrer({
      googleClientId: 'client-de-test.apps.googleusercontent.com',
      googleClientSecret: 'secret-de-test',
      googleHostedDomain: 'cloudnord.fr',
    })

    const { status, body } = await demanderGoogle(origin)
    expect(status).toBe(200)
    const url = new URL(body.url!)
    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth')
    // `hd` restreint l'écran de choix de compte. Ce n'est qu'un indice — Better
    // Auth revérifie la revendication au retour —, mais son absence ferait
    // proposer les comptes personnels en premier.
    expect(url.searchParams.get('hd')).toBe('cloudnord.fr')
    // L'adresse de retour doit être servie par ce hub, sinon le tour complet
    // finit sur un 404 après une authentification réussie.
    expect(url.searchParams.get('redirect_uri')).toBe(`${BASE.publicUrl}/api/auth/callback/google`)
  })

  it('respecte un autre domaine que celui par défaut', async () => {
    const origin = await demarrer({
      googleClientId: 'client-de-test.apps.googleusercontent.com',
      googleClientSecret: 'secret-de-test',
      googleHostedDomain: 'exemple.org',
    })

    const { body } = await demanderGoogle(origin)
    expect(new URL(body.url!).searchParams.get('hd')).toBe('exemple.org')
  })

  it('laisse le mot de passe ouvert', async () => {
    // Google exige internet au moment de la connexion ; tout ce système est
    // bâti pour survivre à une coupure. La porte locale ne se referme pas.
    const origin = await demarrer({
      googleClientId: 'client-de-test.apps.googleusercontent.com',
      googleClientSecret: 'secret-de-test',
      googleHostedDomain: 'cloudnord.fr',
    })

    const reponse = await fetch(`${origin}/api/auth/sign-in/email`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'inconnu@cloudnord.fr', password: 'x'.repeat(12) }),
    })
    // Refus d'identifiants, pas « chemin inexistant » : la voie reste montée.
    expect(reponse.status).toBe(401)
  })
})
