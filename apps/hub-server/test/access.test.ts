import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AccessRole } from '@conference-operator/contract'
import { createHub, type Hub } from '../src/server.js'
import { provisionOperator } from '../src/operators.js'
import { createAuth, createAuthOptions, migrateAuth } from '../src/auth.js'
import { openHubDatabase } from '../src/db.js'

const PASSWORD = 'access-password-2026'

let hub: Hub
let origin: string

async function rpc(path: string, input: unknown, token?: string) {
  const response = await fetch(`${origin}/rpc/${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token != null ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ json: input }),
  })
  return { status: response.status, body: (await response.json()) as { json?: unknown } }
}

async function authPost(path: string, body: unknown, token: string) {
  const response = await fetch(`${origin}/api/auth/${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  })
  return response.status
}

/** An account holding exactly these groups, signed in. */
async function signedIn(roles: AccessRole[]): Promise<string> {
  const email = `${roles.join('-') || 'none'}@cloudnord.fr`
  await provisionOperator(hub.auth, { email, name: email, password: PASSWORD, roles })
  const response = await fetch(`${origin}/api/auth/sign-in/email`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: PASSWORD }),
  })
  return ((await response.json()) as { token: string }).token
}

beforeEach(async () => {
  hub = await createHub({
    port: 0,
    host: '127.0.0.1',
    databasePath: ':memory:',
    publicUrl: 'http://127.0.0.1',
    authSecret: 'test-secret-'.padEnd(48, 'x'),
    logLevel: 'fatal',
  })
  await hub.app.listen({ port: 0, host: '127.0.0.1' })
  const address = hub.app.server.address()
  origin = `http://127.0.0.1:${typeof address === 'object' && address != null ? address.port : 0}`
})

afterEach(async () => {
  await hub.close()
})

describe('operator groups', () => {
  it('tell each operator what they may do', async () => {
    const token = await signedIn(['moderation'])
    const me = await rpc('access/me', {}, token)

    expect(me.status).toBe(200)
    const body = me.body.json as { roles: string[]; permissions: string[] }
    expect(body.roles).toEqual(['moderation'])
    expect(body.permissions).toContain('wall:moderate')
    expect(body.permissions).not.toContain('settings:read')
  })

  it.each<[AccessRole[], string, number]>([
    [['readonly'], 'rooms/list', 200],
    [['readonly'], 'regie/locks', 200],
    [['readonly'], 'settings/get', 403],
    [['readonly'], 'devices/list', 403],
    [['moderation'], 'devices/list', 403],
    [['regieMobile'], 'regie/locks', 200],
    [['regieMobile'], 'settings/get', 403],
    [['synthese'], 'rooms/list', 200],
    [['synthese'], 'regie/locks', 403],
    [['programmeTech'], 'settings/get', 200],
    [['programmeTech'], 'devices/list', 200],
    [['admin'], 'settings/get', 200],
    [['moderation', 'programmeTech'], 'settings/get', 200],
  ])('%j calling %s answers %i', async (roles, path, status) => {
    const token = await signedIn(roles)
    expect((await rpc(path, {}, token)).status).toBe(status)
  })

  it('names the missing permission', async () => {
    const token = await signedIn(['readonly'])
    const refused = await rpc('settings/get', {}, token)
    expect(JSON.stringify(refused.body)).toContain('settings:read')
  })

  it('keep account management to admins', async () => {
    const tech = await signedIn(['programmeTech'])
    const admin = await signedIn(['admin'])

    const listAs = async (token: string) =>
      (await fetch(`${origin}/api/auth/admin/list-users`, { headers: { authorization: `Bearer ${token}` } })).status

    expect(await listAs(tech)).toBe(403)
    expect(await listAs(admin)).toBe(200)
  })

  it('shut a banned account out', async () => {
    const admin = await signedIn(['admin'])
    const target = await signedIn(['regieMobile'])
    const me = (await rpc('access/me', {}, target)).body.json as { email: string }
    const ctx = await hub.auth.$context
    const user = await ctx.internalAdapter.findUserByEmail(me.email)

    expect(await authPost('admin/ban-user', { userId: user!.user.id }, admin)).toBe(200)
    expect((await rpc('regie/locks', {}, target)).status).toBeGreaterThanOrEqual(401)
  })
})

describe('accounts and their groups', () => {
  it('only lets a new account read', async () => {
    const ctx = await hub.auth.$context
    const user = await ctx.internalAdapter.createUser(
      { email: 'nouveau@cloudnord.fr', name: 'Nouveau', emailVerified: true },
      { method: 'email' },
    )
    expect((user as { role?: string }).role).toBe('readonly')
  })

  it('makes a provisioned account admin, and keeps its groups on a password reset', async () => {
    const ctx = await hub.auth.$context
    const email = 'bootstrap@cloudnord.fr'
    await provisionOperator(hub.auth, { email, name: 'Premier', password: PASSWORD })
    expect(((await ctx.internalAdapter.findUserByEmail(email))!.user as { role?: string }).role).toBe('admin')

    await provisionOperator(hub.auth, { email, name: 'Premier', password: PASSWORD, roles: ['synthese'] })
    await provisionOperator(hub.auth, { email, name: 'Premier', password: `${PASSWORD}-bis` })
    expect(((await ctx.internalAdapter.findUserByEmail(email))!.user as { role?: string }).role).toBe('synthese')
  })

  it('makes accounts from before the groups admin', async () => {
    const { sqlite } = openHubDatabase(':memory:')
    const options = createAuthOptions({
      sqlite,
      secret: 'test-secret-'.padEnd(48, 'x'),
      publicUrl: 'http://127.0.0.1',
      onDeviceRequest: () => {},
      isKnownClient: () => true,
    })
    await migrateAuth(options)
    const ctx = await createAuth(options).$context
    const old = await ctx.internalAdapter.createUser(
      { email: 'ancien@cloudnord.fr', name: 'Ancien', emailVerified: true },
      { method: 'email' },
    )
    sqlite.prepare(`UPDATE "user" SET role = NULL WHERE id = ?`).run(old.id)

    await migrateAuth(options)

    const row = sqlite.prepare(`SELECT role FROM "user" WHERE id = ?`).get(old.id) as { role: string }
    expect(row.role).toBe('admin')
    sqlite.close()
  })
})
