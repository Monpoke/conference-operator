import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHubClient } from '@cloudnord/hub-client'
import { createHub, type Hub } from '../src/server.js'
import { provisionOperator } from '../src/operators.js'

/**
 * Le client typé, contre un vrai hub.
 *
 * Les tests du paquet lui-même vérifient son câblage sur un `fetch` simulé.
 * Celui-ci vérifie l'autre moitié, celle qu'aucun bouchon ne prouve : que le
 * contrat passe réellement sur le fil, que le jeton d'opérateur ouvre les
 * procédures protégées, et qu'un jeton refusé produit bien le 401 sur lequel
 * la console se recale.
 *
 * C'est aussi le garde-fou du passage à Vue : le jour où la console appellera
 * `programme` ou `salles` sans template literal, c'est ce chemin-là qu'elle
 * empruntera.
 *
 * Environnement node, et pas happy-dom : le hub résout ses migrations par
 * `import.meta.url`, que happy-dom ne sait pas rendre en chemin de fichier. Le
 * stockage du jeton se teste donc dans le paquet, sur un DOM ; ici, la réserve
 * en mémoire du `TokenStore` suffit.
 */

const rawProgram = readFileSync(
  fileURLToPath(new URL('../../../packages/program/test/fixtures/cloudnord-2026.json', import.meta.url)),
  'utf8',
)

const OPERATOR = { email: 'regie@cloudnord.fr', name: 'Régie', password: 'motdepasse-regie-2026' }

let hub: Hub
let origin: string

beforeEach(async () => {
  hub = await createHub({
    port: 0,
    host: '127.0.0.1',
    databasePath: ':memory:',
    publicUrl: 'http://127.0.0.1',
    authSecret: 'test-secret-'.padEnd(48, 'x'),
    logLevel: 'fatal',
    devicePollInterval: '1s',
  })
  await hub.app.listen({ port: 0, host: '127.0.0.1' })
  const address = hub.app.server.address()
  const port = typeof address === 'object' && address != null ? address.port : 0
  origin = `http://127.0.0.1:${port}`

  await provisionOperator(hub.auth, OPERATOR)
  hub.services.programs.importFromText(rawProgram, 'https://exemple/programme.json')
})

afterEach(async () => {
  await hub.close()
})

async function operatorToken(): Promise<string> {
  const response = await fetch(`${origin}/api/auth/sign-in/email`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: OPERATOR.email, password: OPERATOR.password }),
  })
  expect(response.ok).toBe(true)
  return ((await response.json()) as { token: string }).token
}

describe('client typé du hub', () => {
  it('atteint une procédure publique sans jeton', async () => {
    const client = createHubClient({ origin, tokenKey: null })

    const salles = await client.rpc.rooms.public()

    // Typé, et pas une chaîne de caractères : `rooms.public` est vérifié
    // contre le contrat à la compilation, ce que les quarante chemins écrits
    // à la main dans la console ne sont pas.
    expect(Array.isArray(salles)).toBe(true)
  })

  it('ouvre les procédures d’opérateur une fois le jeton posé', async () => {
    const client = createHubClient({ origin, tokenKey: 'hub-admin' })
    client.token.write(await operatorToken())

    const instantanes = await client.rpc.program.snapshots()

    expect(instantanes.length).toBeGreaterThan(0)
  })

  it('refuse la même procédure sans jeton', async () => {
    const onExpired = vi.fn()
    const client = createHubClient({ origin, tokenKey: 'hub-admin', onExpired })

    await expect(client.rpc.program.snapshots()).rejects.toThrow()

    expect(onExpired).toHaveBeenCalledOnce()
  })

  it('efface un jeton que le hub ne reconnaît plus, et le dit une fois', async () => {
    const onExpired = vi.fn()
    const onError = vi.fn()
    const client = createHubClient({ origin, tokenKey: 'hub-admin', onExpired, onError })
    client.token.write('jeton-qui-ne-vaut-rien')

    await expect(client.rpc.program.snapshots()).rejects.toThrow()

    expect(onExpired).toHaveBeenCalledOnce()
    expect(client.token.read()).toBe(null)
    // La session expirée a son écran : ce n'est pas une erreur à afficher en
    // plus, sinon l'opérateur voit passer un message avant le formulaire.
    expect(onError).not.toHaveBeenCalled()
  })
})
