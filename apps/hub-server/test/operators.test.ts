import Database from 'better-sqlite3'
import { beforeEach, describe, expect, it } from 'vitest'
import { createAuth, createAuthOptions, migrateAuth, type Auth } from '../src/auth.js'
import { provisionOperator } from '../src/operators.js'

const ACCOUNT = { email: 'regie@cloudnord.fr', name: 'Régie' }

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

const signIn = (password: string) =>
  auth.api.signInEmail({ body: { email: ACCOUNT.email, password } })

describe('provisioning an operator', () => {
  it('creates a usable account', async () => {
    const result = await provisionOperator(auth, { ...ACCOUNT, password: 'motdepasse-initial' })

    expect(result.created).toBe(true)
    await expect(signIn('motdepasse-initial')).resolves.toBeDefined()
  })

  it('replaces the password of an existing account', async () => {
    const first = await provisionOperator(auth, { ...ACCOUNT, password: 'motdepasse-initial' })
    const second = await provisionOperator(auth, { ...ACCOUNT, password: 'nouveau-motdepasse' })

    // Same account, password replaced — and the command says so.
    expect(second.id).toBe(first.id)
    expect(second.created).toBe(false)

    await expect(signIn('nouveau-motdepasse')).resolves.toBeDefined()
    await expect(signIn('motdepasse-initial')).rejects.toBeDefined()
  })

  it('never leaves an account announced as ready without its password', async () => {
    // The original trap: returning without doing anything when the account
    // exists. The command announced "ready" and signing in failed with no
    // explanation.
    await provisionOperator(auth, { ...ACCOUNT, password: 'ancien-oublie' })
    await provisionOperator(auth, { ...ACCOUNT, password: 'celui-que-je-viens-de-taper' })

    await expect(signIn('celui-que-je-viens-de-taper')).resolves.toBeDefined()
  })

  it('stays idempotent on the same password', async () => {
    await provisionOperator(auth, { ...ACCOUNT, password: 'stable' })
    await provisionOperator(auth, { ...ACCOUNT, password: 'stable' })
    await expect(signIn('stable')).resolves.toBeDefined()
  })
})
