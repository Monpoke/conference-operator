import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createHub, type Hub } from '@conference-operator/hub-server/server'
import { provisionOperator } from '@conference-operator/hub-server/operators'
import { createORPCClient } from '@orpc/client'
import { RPCLink } from '@orpc/client/fetch'
import type { ContractRouterClient } from '@orpc/contract'
import { contract } from '@conference-operator/contract'
import { RoomApp } from '../src/core/room-app.js'
import { createMockObsTransport } from '../src/core/obs-mock.js'
import type { DisplayPayload } from '../src/core/display-server.js'

const rawProgram = readFileSync(
  fileURLToPath(new URL('../../../packages/program/test/fixtures/cloudnord-2026.json', import.meta.url)),
  'utf8',
)

const OPERATOR = { email: 'regie@cloudnord.fr', name: 'Régie', password: 'control-password-2026' }
const CLIENT_ID = '01JB2ZK5T7QW9V0YHRXM3N4P6C'
const TRACK_2 = 'track-2-mf-1092'
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

let hub: Hub
let origin: string
let dir: string
let room: RoomApp
let control: string

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'cloudnord-choice-'))
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
  origin = `http://127.0.0.1:${typeof address === 'object' && address != null ? address.port : 0}`

  await provisionOperator(hub.auth, OPERATOR)
  const snapshot = hub.services.programs.importFromText(rawProgram, 'https://exemple/programme.json')
  hub.services.rooms.ensureFromTracks(snapshot.program.rooms)

  let token: string | null = null
  room = new RoomApp({
    dataDir: dir,
    hubOrigin: origin,
    clientId: CLIENT_ID,
    displayPort: 0,
    obsTransportFactory: (instance) =>
      createMockObsTransport({ instance, recordingDir: join(dir, 'rec') }),
    readToken: () => token,
    writeToken: (value) => {
      token = value
    },
  })
  control = await room.startDisplay()
})

afterEach(async () => {
  await room.close()
  await hub.close().catch(() => {})
  rmSync(dir, { recursive: true, force: true })
})

const act = async (payload: unknown) => {
  const response = await fetch(`${control}/control/action`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  })
  return { status: response.status, body: (await response.json()) as { ok: boolean; message?: string } }
}
const readState = async () => (await (await fetch(`${control}/display/data`)).json()) as DisplayPayload

/** Approves the pending request, keeping the room the console proposes. */
async function approveKeepingTheProposal(): Promise<string> {
  const response = await fetch(`${origin}/api/auth/sign-in/email`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: OPERATOR.email, password: OPERATOR.password }),
  })
  const session = (await response.json()) as { token: string }
  const admin: ContractRouterClient<typeof contract> = createORPCClient(
    new RPCLink({ origin, url: '/rpc', headers: () => ({ authorization: `Bearer ${session.token}` }) }),
  )

  const pending = await admin.devices.pending()
  expect(pending).toHaveLength(1)

  // The console reads the requested room from the scope, as its page does.
  const scope = pending[0]!.scope ?? ''
  const requested = scope.startsWith('room:') ? scope.slice('room:'.length) : ''
  expect(requested).toBe(TRACK_2)

  const code = room.pairingState().userCode!
  await admin.devices.approve({ userCode: code, clientId: CLIENT_ID, roomId: requested })
  return requested
}

describe('choosing the room at power-on', () => {
  it('offers the rooms before asking for a code', async () => {
    const token = await room.ensurePaired()

    // No code while no room is chosen: the console would have no way to guess
    // which one, and the code would be displayed for nothing.
    expect(token).toBeNull()
    const payload = await readState()
    expect(payload.pairing?.userCode).toBeUndefined()
    expect(payload.pairing?.rooms?.map((r) => r.id).sort()).toEqual([
      'hands-on',
      'track-1-teilhard-de-chardin',
      'track-2-mf-1092',
    ])
  }, 40_000)

  it('carries the choice all the way to the console, which finds it preselected', async () => {
    void act({ action: 'pairing.chooseRoom', roomId: TRACK_2 })

    for (let i = 0; i < 40 && room.pairingState().userCode == null; i += 1) await sleep(200)
    expect(room.pairingState().userCode).toBeTruthy()
    expect(room.pairingState().requestedRoomId).toBe(TRACK_2)

    const kept = await approveKeepingTheProposal()
    expect(kept).toBe(TRACK_2)

    for (let i = 0; i < 60 && room.store.settings().roomId == null; i += 1) await sleep(250)
    expect(room.store.settings().roomId).toBe(TRACK_2)
  }, 60_000)

  it('refuses a room that does not exist', async () => {
    await room.ensurePaired()
    const result = await act({ action: 'pairing.chooseRoom', roomId: 'made-up-room' })

    expect(result.status).toBe(409)
    expect(result.body.message).toContain('Salle inconnue')
  }, 40_000)

  it('exposes the public list without any token at all', async () => {
    // An unpaired machine has nothing to present: with no public procedure it
    // could not offer a choice.
    const response = await fetch(`${origin}/rpc/rooms/public`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ json: {} }),
    })
    expect(response.status).toBe(200)
    const rooms = ((await response.json()) as { json: { id: string; name: string }[] }).json
    expect(rooms).toHaveLength(3)
    // Identifier and name only: no OBS configuration, no RTMP key.
    expect(Object.keys(rooms[0]!).sort()).toEqual(['id', 'name'])
  }, 40_000)
})
