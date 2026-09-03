import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createAuth, createAuthOptions, migrateAuth, type Auth } from '../src/auth.js'
import { provisionOperator } from '../src/operators.js'
import { createHub, type Hub } from '../src/server.js'

/**
 * Pairing a room machine through the device authorization grant (RFC 8628).
 *
 * The real scenario: the control PC displays a short code, an operator already
 * authenticated in the admin approves it, the machine gets a token of its own,
 * revocable. No password shared across the three machines.
 */

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

const OPERATOR = { email: 'regie@cloudnord.fr', name: 'Régie', password: 'motdepasse-regie-2026' }
const CLIENT_ID = '01JB2ZK5T7QW9V0YHRXM3N4P6C'

interface Harness {
  auth: Auth
  onDeviceRequest: ReturnType<typeof vi.fn>
  knownClients: Set<string>
}

async function makeHarness(): Promise<Harness> {
  const sqlite = new Database(':memory:')
  const onDeviceRequest = vi.fn()
  const knownClients = new Set([CLIENT_ID])
  const options = createAuthOptions({
    sqlite,
    secret: 'test-secret-'.padEnd(48, 'x'),
    publicUrl: 'http://localhost:8787',
    onDeviceRequest,
    isKnownClient: (clientId) => knownClients.has(clientId),
    // A tighter cadence: otherwise every test would wait 5 s between two polls.
    deviceInterval: '1s',
  })
  await migrateAuth(options)
  const auth = createAuth(options)
  await provisionOperator(auth, OPERATOR)
  return { auth, onDeviceRequest, knownClients }
}

/** Opens an operator session and returns the headers to replay. */
async function signInOperator(auth: Auth): Promise<Headers> {
  const response = await auth.api.signInEmail({
    body: { email: OPERATOR.email, password: OPERATOR.password },
    returnHeaders: true,
  })
  const token = response.response.token
  const headers = new Headers()
  headers.set('authorization', `Bearer ${token}`)
  return headers
}

let harness: Harness
beforeEach(async () => {
  harness = await makeHarness()
})

describe('pairing a room machine', () => {
  it('runs the whole flow: code → approval → token', async () => {
    const { auth, onDeviceRequest } = harness

    // 1. The machine asks for a code at startup.
    const request = await auth.api.deviceCode({ body: { client_id: CLIENT_ID } })
    expect(request.device_code).toBeTruthy()
    expect(request.user_code).toBeTruthy()
    expect(request.interval).toBeGreaterThan(0)

    // The hub knows a machine is waiting: without that, the admin would see a
    // code without knowing which machine is asking for it.
    expect(onDeviceRequest).toHaveBeenCalledWith(CLIENT_ID, undefined)

    // 2. As long as nobody has approved, polling stays pending.
    await expect(
      auth.api.deviceToken({
        body: {
          grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
          device_code: request.device_code,
          client_id: CLIENT_ID,
        },
      }),
    ).rejects.toMatchObject({ body: { error: 'authorization_pending' } })

    // 3. The operator types the code into the admin, then approves.
    const headers = await signInOperator(auth)
    await auth.api.deviceVerify({ query: { user_code: request.user_code }, headers })
    await auth.api.deviceApprove({ body: { userCode: request.user_code }, headers })

    // 4. The next poll delivers the token — after honouring the interval.
    await sleep(1_100)
    const granted = await auth.api.deviceToken({
      body: {
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        device_code: request.device_code,
        client_id: CLIENT_ID,
      },
    })
    expect(granted).toMatchObject({ token_type: 'Bearer' })
    expect(granted.access_token).toBeTruthy()

    // 5. That token does open a session usable for the oRPC calls.
    const deviceHeaders = new Headers({ authorization: `Bearer ${granted.access_token}` })
    const session = await auth.api.getSession({ headers: deviceHeaders })
    expect(session?.user.email).toBe(OPERATOR.email)
  })

  it('refuses an unknown `client_id`', async () => {
    await expect(
      harness.auth.api.deviceCode({ body: { client_id: 'machine-non-declaree' } }),
    ).rejects.toBeDefined()
  })

  it('refuses to approve without an operator session', async () => {
    const request = await harness.auth.api.deviceCode({ body: { client_id: CLIENT_ID } })
    await expect(
      harness.auth.api.deviceApprove({ body: { userCode: request.user_code }, headers: new Headers() }),
    ).rejects.toBeDefined()
  })

  it('grants no token after an explicit refusal', async () => {
    const { auth } = harness
    const request = await auth.api.deviceCode({ body: { client_id: CLIENT_ID } })
    const headers = await signInOperator(auth)

    await auth.api.deviceVerify({ query: { user_code: request.user_code }, headers })
    await auth.api.deviceDeny({ body: { userCode: request.user_code }, headers })

    await sleep(1_100)
    await expect(
      auth.api.deviceToken({
        body: {
          grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
          device_code: request.device_code,
          client_id: CLIENT_ID,
        },
      }),
    ).rejects.toMatchObject({ body: { error: 'access_denied' } })
  })

  it('does not deliver a token twice for the same code', async () => {
    const { auth } = harness
    const request = await auth.api.deviceCode({ body: { client_id: CLIENT_ID } })
    const headers = await signInOperator(auth)
    await auth.api.deviceVerify({ query: { user_code: request.user_code }, headers })
    await auth.api.deviceApprove({ body: { userCode: request.user_code }, headers })

    const body = {
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code' as const,
      device_code: request.device_code,
      client_id: CLIENT_ID,
    }
    await sleep(1_100)
    await auth.api.deviceToken({ body })
    // A stolen and replayed code must not open a second session.
    await sleep(1_100)
    await expect(auth.api.deviceToken({ body })).rejects.toBeDefined()
  })

  it('imposes the polling cadence (RFC 8628 §3.5)', async () => {
    const { auth } = harness
    const request = await auth.api.deviceCode({ body: { client_id: CLIENT_ID } })
    const body = {
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code' as const,
      device_code: request.device_code,
      client_id: CLIENT_ID,
    }

    await expect(auth.api.deviceToken({ body })).rejects.toMatchObject({
      body: { error: 'authorization_pending' },
    })
    // Polling again immediately is punished: the room client must honour
    // `interval` and slow down further on `slow_down`, otherwise it blocks itself
    // at startup — just when the operator is waiting in front of the screen.
    await expect(auth.api.deviceToken({ body })).rejects.toMatchObject({
      body: { error: 'slow_down' },
    })
  })
})

/**
 * Looking up a code from the console.
 *
 * The operator arrives through the link the control app displays. What they see
 * next to it — the queue of waiting machines — says nothing about *their* code:
 * it has to be qualified before they go looking for a machine that is not there.
 */
describe('looking up a pairing code', () => {
  const TRACK_1 = 'track-1-teilhard-de-chardin'
  let hub: Hub
  let origin: string
  let operatorToken: string

  async function rpc(path: string, input: unknown) {
    const response = await fetch(`${origin}/rpc/${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${operatorToken}` },
      body: JSON.stringify({ json: input }),
    })
    return (await response.json()) as { json: Record<string, unknown> }
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
    hub.services.rooms.upsert({
      id: TRACK_1,
      name: 'Teilhard de Chardin',
      trackId: TRACK_1,
      obs: {
        A: { url: 'ws://127.0.0.1:4455', password: null },
        B: { url: 'ws://127.0.0.1:4456', password: null },
      },
      sceneRoles: { A: { LIVE: 'Capture' }, B: {} },
      displayPort: 7788,
      recordingRoot: null,
    })

    await provisionOperator(hub.auth, OPERATOR)
    const signIn = await fetch(`${origin}/api/auth/sign-in/email`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: OPERATOR.email, password: OPERATOR.password }),
    })
    operatorToken = ((await signIn.json()) as { token: string }).token
  })

  afterEach(async () => {
    await hub.close()
  })

  it('recognizes a pending code and returns the requested room', async () => {
    const request = await hub.auth.api.deviceCode({
      body: { client_id: CLIENT_ID, scope: `room:${TRACK_1}` },
    })

    const { json } = await rpc('devices/lookup', { userCode: request.user_code })

    expect(json).toMatchObject({
      status: 'pending',
      reason: null,
      clientId: CLIENT_ID,
      requestedRoomId: TRACK_1,
      requestedRoomName: 'Teilhard de Chardin',
    })
  })

  it('tells an unknown code from a failure', async () => {
    // A generic error would send one looking at the hub; it is almost always a
    // typo, or a database recreated since the code was displayed.
    const { json } = await rpc('devices/lookup', { userCode: 'ZZZZ-ZZZZ' })

    // `inconnu` is a contract value: it does not get renamed.
    expect(json).toMatchObject({ status: null, reason: 'inconnu', clientId: null })
  })

  it('explains the refusal when another operator has opened the code', async () => {
    const request = await hub.auth.api.deviceCode({
      body: { client_id: CLIENT_ID, scope: `room:${TRACK_1}` },
    })
    // A first operator follows the machine's link: the lookup attaches the code
    // to their session, on the Better Auth side.
    await rpc('devices/lookup', { userCode: request.user_code })

    await provisionOperator(hub.auth, { ...OPERATOR, email: 'second@cloudnord.fr' })
    const signIn = await fetch(`${origin}/api/auth/sign-in/email`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'second@cloudnord.fr', password: OPERATOR.password }),
    })
    operatorToken = ((await signIn.json()) as { token: string }).token

    const { json } = await rpc('devices/approve', {
      userCode: request.user_code,
      clientId: CLIENT_ID,
      roomId: TRACK_1,
    })

    // The plugin's English message helps nobody at the back of a room.
    expect(String((json as { message?: string }).message)).toContain('autre opérateur')
    expect(hub.services.devices.roomFor(CLIENT_ID)).toBeNull()
  })

  it('takes the machine out of the queue when it is refused', async () => {
    const request = await hub.auth.api.deviceCode({
      body: { client_id: CLIENT_ID, scope: `room:${TRACK_1}` },
    })
    expect(hub.services.devices.pending()).toHaveLength(1)

    await rpc('devices/deny', { userCode: request.user_code })

    // Without this, refusing had no visible effect: the request stayed displayed
    // until someone paired it, and it got refused twice.
    expect(hub.services.devices.pending()).toEqual([])
  })
})
