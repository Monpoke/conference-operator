import Database from 'better-sqlite3'
import { beforeEach, describe, expect, it } from 'vitest'
import { createAuth, createAuthOptions, migrateAuth, type Auth } from '../src/auth.js'
import { loadConfig } from '../src/config.js'
import { ensureInitialAdmin, provisionOperator } from '../src/operators.js'

const ACCOUNT = { email: 'regie@cloudnord.fr', name: 'Régie' }

let auth: Auth
let sqlite: Database.Database
let firstAccounts: string[]

beforeEach(async () => {
  sqlite = new Database(':memory:')
  firstAccounts = []
  const options = createAuthOptions({
    sqlite,
    secret: 'test-secret-'.padEnd(48, 'x'),
    publicUrl: 'http://localhost:8787',
    onDeviceRequest: () => {},
    isKnownClient: () => true,
    onFirstAccount: (email) => firstAccounts.push(email),
  })
  await migrateAuth(options)
  auth = createAuth(options)
})

const roleOf = (email: string) =>
  (sqlite.prepare('SELECT role FROM "user" WHERE email = ?').get(email) as { role: string } | undefined)?.role

/**
 * An account arriving by the path Google takes: Better Auth's own user creation,
 * with no role given — the one `provisionOperator` would set afterwards.
 */
async function arrivesThroughSso(email: string) {
  const ctx = await auth.$context
  await ctx.internalAdapter.createUser(
    { email, name: email.split('@')[0]!, emailVerified: true },
    { method: 'oauth', oauth: { providerId: 'google' } },
  )
}

describe('the hub’s first account', () => {
  it('is admin when it arrives through SSO on an empty hub', async () => {
    await arrivesThroughSso('premiere@cloudnord.fr')
    expect(roleOf('premiere@cloudnord.fr')).toBe('admin')
    expect(firstAccounts).toEqual(['premiere@cloudnord.fr'])
  })

  it('leaves the next ones reading only, until an admin raises them', async () => {
    await arrivesThroughSso('premiere@cloudnord.fr')
    await arrivesThroughSso('deuxieme@cloudnord.fr')
    expect(roleOf('deuxieme@cloudnord.fr')).toBe('readonly')
    expect(firstAccounts).toEqual(['premiere@cloudnord.fr'])
  })

  it('is the configured admin when there is one: the SSO arrival that follows only reads', async () => {
    await ensureInitialAdmin(auth, sqlite, { ...ACCOUNT, password: 'mot-de-passe-initial' })
    await arrivesThroughSso('premiere@cloudnord.fr')
    expect(roleOf(ACCOUNT.email)).toBe('admin')
    expect(roleOf('premiere@cloudnord.fr')).toBe('readonly')
  })
})

describe('the initial admin', () => {
  it('is created on an empty hub, and can sign in', async () => {
    expect(await ensureInitialAdmin(auth, sqlite, { ...ACCOUNT, password: 'mot-de-passe-initial' })).toBe('created')
    expect(roleOf(ACCOUNT.email)).toBe('admin')
    await expect(signIn('mot-de-passe-initial')).resolves.toBeDefined()
  })

  it('does not reset a password changed since: it only seeds', async () => {
    await ensureInitialAdmin(auth, sqlite, { ...ACCOUNT, password: 'mot-de-passe-initial' })
    await provisionOperator(auth, { ...ACCOUNT, password: 'change-depuis' })

    expect(await ensureInitialAdmin(auth, sqlite, { ...ACCOUNT, password: 'mot-de-passe-initial' })).toBe('ignored')
    await expect(signIn('change-depuis')).resolves.toBeDefined()
  })

  it('is ignored on a hub that already has anyone, whatever their address', async () => {
    await arrivesThroughSso('premiere@cloudnord.fr')
    expect(await ensureInitialAdmin(auth, sqlite, { ...ACCOUNT, password: 'mot-de-passe-initial' })).toBe('ignored')
    expect(roleOf(ACCOUNT.email)).toBeUndefined()
  })

  it('needs both halves, and a password worth an admin', () => {
    const env = { BETTER_AUTH_SECRET: 'x'.repeat(40) }
    expect(() => loadConfig({ ...env, INITIAL_ADMIN_EMAIL: ACCOUNT.email })).toThrow(/par paire/)
    expect(() => loadConfig({ ...env, INITIAL_ADMIN_EMAIL: ACCOUNT.email, INITIAL_ADMIN_PASSWORD: 'court' })).toThrow(/12 caractères/)
    // Empty keys, as a chart renders them, mean unset.
    expect(loadConfig({ ...env, INITIAL_ADMIN_EMAIL: '', INITIAL_ADMIN_PASSWORD: '' }).initialAdminEmail).toBeUndefined()
  })
})

const signIn = (password: string) =>
  auth.api.signInEmail({ body: { email: ACCOUNT.email, password } })

describe('provisioning an operator', () => {
  it('creates a usable account', async () => {
    const result = await provisionOperator(auth, { ...ACCOUNT, password: 'initial-password' })

    expect(result.created).toBe(true)
    await expect(signIn('initial-password')).resolves.toBeDefined()
  })

  it('replaces the password of an existing account', async () => {
    const first = await provisionOperator(auth, { ...ACCOUNT, password: 'initial-password' })
    const second = await provisionOperator(auth, { ...ACCOUNT, password: 'new-password' })

    // Same account, password replaced — and the command says so.
    expect(second.id).toBe(first.id)
    expect(second.created).toBe(false)

    await expect(signIn('new-password')).resolves.toBeDefined()
    await expect(signIn('initial-password')).rejects.toBeDefined()
  })

  it('never leaves an account announced as ready without its password', async () => {
    // The original trap: returning without doing anything when the account
    // exists. The command announced "ready" and signing in failed with no
    // explanation.
    await provisionOperator(auth, { ...ACCOUNT, password: 'old-forgotten' })
    await provisionOperator(auth, { ...ACCOUNT, password: 'the-one-just-typed' })

    await expect(signIn('the-one-just-typed')).resolves.toBeDefined()
  })

  it('stays idempotent on the same password', async () => {
    await provisionOperator(auth, { ...ACCOUNT, password: 'stable' })
    await provisionOperator(auth, { ...ACCOUNT, password: 'stable' })
    await expect(signIn('stable')).resolves.toBeDefined()
  })
})
