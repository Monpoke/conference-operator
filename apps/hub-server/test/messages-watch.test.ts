import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createORPCClient } from '@orpc/client'
import { RPCLink } from '@orpc/client/fetch'
import type { ContractRouterClient } from '@orpc/contract'
import { contract } from '@conference-operator/contract'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createHub, type Hub } from '../src/server.js'
import { provisionOperator } from '../src/operators.js'

/**
 * The console's live list of the rooms' messages.
 *
 * What the console depends on: the list at opening, a room's message pushed well
 * before the ten-second poll — and no push for a heartbeat, which every room
 * sends every two seconds.
 */

type Client = ContractRouterClient<typeof contract>

const rawProgram = readFileSync(
  fileURLToPath(new URL('../../../packages/program/test/fixtures/cloudnord-2026.json', import.meta.url)),
  'utf8',
)

const OPERATOR = { email: 'console@cloudnord.fr', name: 'Console', password: 'console-password-2026' }
const TRACK_1 = 'track-1-teilhard-de-chardin'

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
  await hub.close()
})

async function operatorClient(): Promise<Client> {
  const response = await fetch(`${origin}/api/auth/sign-in/email`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: OPERATOR.email, password: OPERATOR.password }),
  })
  const { token } = (await response.json()) as { token: string }
  return createORPCClient(
    new RPCLink({ origin, url: '/rpc', headers: () => ({ authorization: `Bearer ${token}` }) }),
  )
}

function envelope(seq: number, payload: Record<string, unknown>) {
  return {
    id: `01MMMMMMMMMMMMMMMMMMMMMMM${seq}`,
    roomId: TRACK_1,
    seq,
    occurredAt: new Date().toISOString(),
    monotonicMs: seq * 1_000,
    delivery: 'required',
    payload,
  }
}

describe('messages.watch', () => {
  it('pushes the list at opening, then as soon as a room writes', async () => {
    const console = await operatorClient()
    const abort = new AbortController()
    const stream = await console.messages.watch({ limit: 10 }, { signal: abort.signal })

    const opening = await stream.next()
    expect(opening.value).toEqual([])

    const reportedAt = Date.now()
    hub.services.ingest.push(TRACK_1, [
      envelope(1, { type: 'room.message', text: 'Micro HS', level: 'urgent' }),
    ])

    const pushed = await stream.next()
    expect(pushed.value).toMatchObject([
      { roomId: TRACK_1, roomName: expect.any(String), text: 'Micro HS', level: 'urgent' },
    ])
    // Pushed, not polled: the console's poll is ten seconds away.
    expect(Date.now() - reportedAt).toBeLessThan(1_000)

    abort.abort()
  })

  it('stays quiet for a replayed message', async () => {
    const console = await operatorClient()
    const message = envelope(1, { type: 'room.message', text: 'Micro HS', level: 'urgent' })
    hub.services.ingest.push(TRACK_1, [message])

    const abort = new AbortController()
    const stream = await console.messages.watch({ limit: 10 }, { signal: abort.signal })
    await stream.next()

    // The pump re-sends an unacknowledged batch: it is not a second message.
    hub.services.ingest.push(TRACK_1, [message])
    const next = stream.next()
    const verdict = await Promise.race([
      next.then(() => 'pushed'),
      new Promise((resolve) => setTimeout(() => resolve('quiet'), 300)),
    ])
    expect(verdict).toBe('quiet')

    abort.abort()
  })
})
