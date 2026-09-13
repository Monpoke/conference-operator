import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { WebSocket } from 'ws'
import { createORPCClient } from '@orpc/client'
import { RPCLink as FetchLink } from '@orpc/client/fetch'
import { RPCLink as WsLink } from '@orpc/client/websocket'
import type { ContractRouterClient } from '@orpc/contract'
import { CONTROL_SESSION_HEADER, contract, type ControlView } from '@conference-operator/contract'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createHub, type Hub } from '../src/server.js'
import { provisionOperator } from '../src/operators.js'

/**
 * The mobile control app's stream, over a real socket.
 *
 * What is checked is what the phone depends on: the ticket opens one socket and
 * only one, the view arrives without being asked for, a room's report reaches the
 * phone well before the floor, and the stream is its holder's heartbeat — and no
 * one else's.
 */

type Client = ContractRouterClient<typeof contract>

const rawProgram = readFileSync(
  fileURLToPath(new URL('../../../packages/program/test/fixtures/cloudnord-2026.json', import.meta.url)),
  'utf8',
)

const OPERATOR = { email: 'regie@cloudnord.fr', name: 'Régie', password: 'control-password-2026' }
const TRACK_1 = 'track-1-teilhard-de-chardin'
const PHONE = 'session-phone'
const TABLET = 'session-tablet'
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

let hub: Hub
let origin: string
let sockets: WebSocket[] = []

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
  const port = typeof address === 'object' && address != null ? address.port : 0
  origin = `http://127.0.0.1:${port}`

  await provisionOperator(hub.auth, OPERATOR)
  const snapshot = hub.services.programs.importFromText(rawProgram, 'https://exemple/programme.json')
  hub.services.rooms.ensureFromTracks(snapshot.program.rooms)
})

afterEach(async () => {
  for (const socket of sockets) socket.terminate()
  sockets = []
  await hub.close()
})

async function signInOperator(): Promise<string> {
  const response = await fetch(`${origin}/api/auth/sign-in/email`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: OPERATOR.email, password: OPERATOR.password }),
  })
  expect(response.ok).toBe(true)
  return ((await response.json()) as { token: string }).token
}

/** The phone's HTTP client: its token, and the tab it announces. */
async function httpClient(session: string | null): Promise<Client> {
  const token = await signInOperator()
  return createORPCClient(
    new FetchLink({
      origin,
      url: '/rpc',
      headers: () => ({
        authorization: `Bearer ${token}`,
        ...(session == null ? {} : { [CONTROL_SESSION_HEADER]: session }),
      }),
    }),
  )
}

/** A socket opened with a ticket — or with nothing, like a stranger. */
function socketClient(ticket: string | null): Client {
  const query = ticket == null ? '' : `?ticket=${encodeURIComponent(ticket)}`
  return createORPCClient(
    new WsLink({
      connect: () => {
        const socket = new WebSocket(`${origin.replace('http', 'ws')}/ws${query}`)
        sockets.push(socket)
        socket.on('error', () => {})
        return socket as unknown as globalThis.WebSocket
      },
      reconnect: { enabled: false },
    }),
  )
}

type ViewStream = Awaited<ReturnType<Client['regie']['watch']>>

/**
 * The next pushed view — a stream that ends instead is a failure, not an `undefined`.
 *
 * Signs of life (`{ unchanged: true }`) are skipped: they carry no view.
 */
async function nextView(stream: ViewStream): Promise<ControlView> {
  for (;;) {
    const result = await stream.next()
    if (result.done === true) throw new Error('le flux de régie s’est terminé')
    if (!('unchanged' in result.value)) return result.value
  }
}

/** The handshake's outcome alone: 101 when the socket opens, the refusal's status otherwise. */
function handshake(ticket: string): Promise<number> {
  return new Promise((resolve) => {
    const socket = new WebSocket(`${origin.replace('http', 'ws')}/ws?ticket=${encodeURIComponent(ticket)}`)
    sockets.push(socket)
    socket.on('open', () => resolve(101))
    socket.on('unexpected-response', (_request, response) => resolve(response.statusCode ?? 0))
    socket.on('error', () => resolve(0))
  })
}

describe('the socket ticket', () => {
  it('is refused to a tab that does not announce itself', async () => {
    // The lock keys on the tab: a stream opened without one could never hold a room.
    const phone = await httpClient(null)
    await expect(phone.regie.ticket()).rejects.toThrow()
  })

  it('opens one socket, and not a second', async () => {
    const phone = await httpClient(PHONE)
    const { ticket } = await phone.regie.ticket()

    expect(await handshake(ticket)).toBe(101)
    expect(await handshake(ticket)).toBe(401)
    expect(await handshake('not-a-ticket')).toBe(401)
  })

  it('is what makes the socket an operator — without it, nobody', async () => {
    const stranger = socketClient(null)
    await expect(stranger.regie.watch({ roomId: TRACK_1 })).rejects.toThrow()
  })
})

describe('regie.watch', () => {
  it('pushes the view at opening, then as soon as the room reports', async () => {
    const phone = await httpClient(PHONE)
    const { ticket } = await phone.regie.ticket()
    const stream = await socketClient(ticket).regie.watch({ roomId: TRACK_1 })

    const opening = await nextView(stream)
    expect(opening.roomId).toBe(TRACK_1)
    expect(opening.sceneRole).toBeNull()

    // The room reports its scene switch, as its pump does after OBS's echo.
    const reportedAt = Date.now()
    hub.services.ingest.push(TRACK_1, [
      {
        id: '01CCCCCCCCCCCCCCCCCCCCCCCC',
        roomId: TRACK_1,
        seq: 1,
        occurredAt: new Date().toISOString(),
        monotonicMs: 1_000,
        delivery: 'required',
        payload: { type: 'scene.changed', obs: 'A', role: 'LIVE', sceneName: 'Capture' },
      },
    ])

    const pushed = await nextView(stream)
    expect(pushed.sceneRole).toBe('LIVE')
    // Pushed, not waited for: the floor is ten seconds away.
    expect(Date.now() - reportedAt).toBeLessThan(1_000)

    await stream.return?.()
  })

  it("renews its holder's lock, and nobody else's", async () => {
    const phone = await httpClient(PHONE)
    await phone.regie.hold({ roomId: TRACK_1 })
    const taken = hub.services.regie.lock(TRACK_1)!

    // Another tab of the same operator watches: it reads, it does not keep the lock alive.
    await sleep(20)
    const tablet = await httpClient(TABLET)
    const tabletStream = await socketClient((await tablet.regie.ticket()).ticket).regie.watch({
      roomId: TRACK_1,
    })
    await nextView(tabletStream)
    expect(hub.services.regie.lock(TRACK_1)!.lastSeenAt).toBe(taken.lastSeenAt)
    await tabletStream.return?.()

    // The holder's stream is its heartbeat.
    await sleep(20)
    const phoneStream = await socketClient((await phone.regie.ticket()).ticket).regie.watch({
      roomId: TRACK_1,
    })
    await nextView(phoneStream)
    const renewed = hub.services.regie.lock(TRACK_1)!
    expect(renewed.holderId).toBe(PHONE)
    expect(Date.parse(renewed.lastSeenAt)).toBeGreaterThan(Date.parse(taken.lastSeenAt))
    // Renewal keeps since when the tab has held the room.
    expect(renewed.heldSince).toBe(taken.heldSince)
    await phoneStream.return?.()
  })

  it('does not resend a view that has not moved, and still pushes the next change', async () => {
    const phone = await httpClient(PHONE)
    const { ticket } = await phone.regie.ticket()
    const stream = await socketClient(ticket).regie.watch({ roomId: TRACK_1 })
    await nextView(stream)

    hub.services.ingest.push(TRACK_1, [scene(1, 'LIVE')])
    expect((await nextView(stream) as ControlView).sceneRole).toBe('LIVE')

    // The same scene, reported again: nothing a phone could see has moved.
    hub.services.ingest.push(TRACK_1, [scene(2, 'LIVE')])
    await sleep(150)
    // Then a real change. Had the repeat been sent, it would come out first.
    hub.services.ingest.push(TRACK_1, [scene(3, 'HOLD')])

    expect((await nextView(stream) as ControlView).sceneRole).toBe('HOLD')
    await stream.return?.()
  })
})

describe('reports that change nothing', () => {
  it('wake nobody up', async () => {
    hub.services.ingest.push(TRACK_1, [scene(1, 'LIVE')])

    const stop = new AbortController()
    const changes = hub.services.changes.watch(TRACK_1, stop.signal)
    const woken = changes.next().then(() => 'woken' as const)

    hub.services.ingest.push(TRACK_1, [scene(2, 'LIVE')])
    expect(await Promise.race([woken, sleep(200).then(() => 'quiet' as const)])).toBe('quiet')

    hub.services.ingest.push(TRACK_1, [scene(3, 'HOLD')])
    expect(await Promise.race([woken, sleep(200).then(() => 'quiet' as const)])).toBe('woken')
    stop.abort()
  })
})

/** A scene switch as the room's pump reports it. */
function scene(seq: number, role: 'LIVE' | 'HOLD') {
  return {
    id: `01CCCCCCCCCCCCCCCCCCCCCCC${seq}`,
    roomId: TRACK_1,
    seq,
    occurredAt: new Date().toISOString(),
    monotonicMs: seq * 1_000,
    delivery: 'required',
    payload: { type: 'scene.changed', obs: 'A', role, sceneName: 'Capture' },
  }
}
