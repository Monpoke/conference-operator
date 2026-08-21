import Database from 'better-sqlite3'
import { beforeEach, describe, expect, it } from 'vitest'
import { createAuth, createAuthOptions, migrateAuth, type Auth } from '../src/auth.js'
import { provisionOperator } from '../src/operators.js'

const COMPTE = { email: 'regie@cloudnord.fr', name: 'Régie' }

let auth: Auth

beforeEach(async () => {
  const sqlite = new Database(':memory:')
  const options = createAuthOptions({
    sqlite,
    secret: 'test-secret-'.padEnd(48, 'x'),
    publicUrl: 'http://localhost:8787',
    onDeviceRequest: () => {},
    isKnownClient: () => true,
  })
  await migrateAuth(options)
  auth = createAuth(options)
})

const seConnecter = (password: string) =>
  auth.api.signInEmail({ body: { email: COMPTE.email, password } })

describe('provisionnement d\'un opérateur', () => {
  it('crée un compte utilisable', async () => {
    const resultat = await provisionOperator(auth, { ...COMPTE, password: 'motdepasse-initial' })

    expect(resultat.created).toBe(true)
    await expect(seConnecter('motdepasse-initial')).resolves.toBeDefined()
  })

  it('remplace le mot de passe d\'un compte existant', async () => {
    const premier = await provisionOperator(auth, { ...COMPTE, password: 'motdepasse-initial' })
    const second = await provisionOperator(auth, { ...COMPTE, password: 'nouveau-motdepasse' })

    // Même compte, mot de passe remplacé — et la commande le dit.
    expect(second.id).toBe(premier.id)
    expect(second.created).toBe(false)

    await expect(seConnecter('nouveau-motdepasse')).resolves.toBeDefined()
    await expect(seConnecter('motdepasse-initial')).rejects.toBeDefined()
  })

  it('ne laisse jamais un compte annoncé prêt sans son mot de passe', async () => {
    // Le piège d'origine : sortir sans rien faire quand le compte existe.
    // La commande annonçait « prêt » et la connexion échouait sans explication.
    await provisionOperator(auth, { ...COMPTE, password: 'ancien-oublie' })
    await provisionOperator(auth, { ...COMPTE, password: 'celui-que-je-viens-de-taper' })

    await expect(seConnecter('celui-que-je-viens-de-taper')).resolves.toBeDefined()
  })

  it('reste idempotent sur le même mot de passe', async () => {
    await provisionOperator(auth, { ...COMPTE, password: 'stable' })
    await provisionOperator(auth, { ...COMPTE, password: 'stable' })
    await expect(seConnecter('stable')).resolves.toBeDefined()
  })
})
