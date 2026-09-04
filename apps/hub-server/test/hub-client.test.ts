import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHubClient } from '@cloudnord/hub-client'
import { createHub, type Hub } from '../src/server.js'
import { provisionOperator } from '../src/operators.js'

/**
 * The typed client, against a real hub.
 *
 * The package's own tests check its wiring on a simulated `fetch`. This one
 * checks the other half, the one no stub proves: that the contract really travels
 * over the wire, that the operator token opens the protected procedures, and that
 * a refused token does produce the 401 the console realigns itself on.
 *
 * It is also the guard for the move to Vue: the day the console calls `program`
 * or `rooms` without a template literal, this is the path it will take.
 *
 * A node environment, not happy-dom: the hub resolves its migrations through
 * `import.meta.url`, which happy-dom cannot render as a file path. Token storage
 * is therefore tested in the package, on a DOM; here the `TokenStore`'s in-memory
 * fallback is enough.
 */

const rawProgram = readFileSync(
  fileURLToPath(new URL('../../../packages/program/test/fixtures/cloudnord-2026.json', import.meta.url)),
  'utf8',
)

const OPERATOR = { email: 'regie@cloudnord.fr', name: 'Régie', password: 'control-password-2026' }

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

describe('typed hub client', () => {
  it('reaches a public procedure with no token', async () => {
    const client = createHubClient({ origin, tokenKey: null })

    const rooms = await client.rpc.rooms.public()

    // Typed, and not a string: `rooms.public` is checked against the contract at
    // compile time, which the forty hand-written paths in the console are not.
    expect(Array.isArray(rooms)).toBe(true)
  })

  it('opens the operator procedures once the token is set', async () => {
    const client = createHubClient({ origin, tokenKey: 'hub-admin' })
    client.token.write(await operatorToken())

    const snapshots = await client.rpc.program.snapshots()

    expect(snapshots.length).toBeGreaterThan(0)
  })

  it('refuses the same procedure with no token', async () => {
    const onExpired = vi.fn()
    const client = createHubClient({ origin, tokenKey: 'hub-admin', onExpired })

    await expect(client.rpc.program.snapshots()).rejects.toThrow()

    expect(onExpired).toHaveBeenCalledOnce()
  })

  it('erases a token the hub no longer recognizes, and says so once', async () => {
    const onExpired = vi.fn()
    const onError = vi.fn()
    const client = createHubClient({ origin, tokenKey: 'hub-admin', onExpired, onError })
    client.token.write('worthless-token')

    await expect(client.rpc.program.snapshots()).rejects.toThrow()

    expect(onExpired).toHaveBeenCalledOnce()
    expect(client.token.read()).toBe(null)
    // The expired session has its own screen: it is not an error to display on
    // top, otherwise the operator sees a message go by before the form.
    expect(onError).not.toHaveBeenCalled()
  })
})
