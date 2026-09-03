import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { WebSocket } from 'ws'
import { createORPCClient } from '@orpc/client'
import { RPCLink as FetchLink } from '@orpc/client/fetch'
import { RPCLink as WsLink } from '@orpc/client/websocket'
import type { ContractRouterClient } from '@orpc/contract'
import { contract, type Command } from '@cloudnord/contract'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createHub, type Hub } from '../src/server.js'
import { provisionOperator } from '../src/operators.js'

type Client = ContractRouterClient<typeof contract>

const rawProgram = readFileSync(
  fileURLToPath(new URL('../../../packages/program/test/fixtures/cloudnord-2026.json', import.meta.url)),
  'utf8',
)

const OPERATOR = { email: 'regie@cloudnord.fr', name: 'Régie', password: 'motdepasse-regie-2026' }
const CLIENT_ID = '01JB2ZK5T7QW9V0YHRXM3N4P6C'
const TRACK_1 = 'track-1-teilhard-de-chardin'
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
    devicePollInterval: '1s',
  })
  await hub.app.listen({ port: 0, host: '127.0.0.1' })
  const address = hub.app.server.address()
  const port = typeof address === 'object' && address != null ? address.port : 0
  origin = `http://127.0.0.1:${port}`

  await provisionOperator(hub.auth, OPERATOR)
  hub.services.programs.importFromText(rawProgram, 'https://exemple/programme.json')
  hub.services.rooms.upsert({
    id: TRACK_1,
    name: 'Track #1 - Teilhard de Chardin',
    trackId: TRACK_1,
    obs: {
      A: { url: 'ws://127.0.0.1:4455', password: null },
      B: { url: 'ws://127.0.0.1:4456', password: null },
    },
    sceneRoles: { A: { LIVE: 'Capture HDMI', HOLD: 'Habillage' }, B: { TALK: 'Talk' } },
    displayPort: 7788,
    recordingRoot: null,
  })
})

afterEach(async () => {
  for (const socket of sockets) socket.terminate()
  sockets = []
  await hub.close()
})

/** The oRPC client over HTTP, as hub-admin uses it. */
function httpClient(headers: Record<string, string> = {}): Client {
  return createORPCClient(
    new FetchLink({
      origin,
      url: '/rpc',
      headers: () => headers,
    }),
  )
}

/** The oRPC client over WebSocket, as a room machine uses it. */
function wsClient(headers: Record<string, string>): Client {
  return createORPCClient(
    new WsLink({
      connect: () => {
        const socket = new WebSocket(`${origin.replace('http', 'ws')}/ws`, { headers })
        sockets.push(socket)
        socket.on('error', () => {})
        return socket as unknown as globalThis.WebSocket
      },
      reconnect: { enabled: true, delay: () => 50, maxAttempt: 5 },
    }),
  )
}

async function signInOperator(): Promise<string> {
  const response = await fetch(`${origin}/api/auth/sign-in/email`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: OPERATOR.email, password: OPERATOR.password }),
  })
  expect(response.ok).toBe(true)
  const body = (await response.json()) as { token: string }
  return body.token
}

/** Runs the whole pairing and returns the machine's headers. */
async function pairRoomDevice(): Promise<Record<string, string>> {
  const codeResponse = await fetch(`${origin}/api/auth/device/code`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ client_id: CLIENT_ID }),
  })
  const request = (await codeResponse.json()) as { device_code: string; user_code: string }

  const operatorToken = await signInOperator()
  const admin = httpClient({ authorization: `Bearer ${operatorToken}` })
  await admin.devices.approve({
    userCode: request.user_code,
    clientId: CLIENT_ID,
    roomId: TRACK_1,
    label: 'PC régie salle 1',
  })

  // Honours the polling interval imposed by the hub (RFC 8628 §3.5).
  await sleep(1_100)
  const tokenResponse = await fetch(`${origin}/api/auth/device/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      device_code: request.device_code,
      client_id: CLIENT_ID,
    }),
  })
  const granted = (await tokenResponse.json()) as { access_token: string }
  expect(granted.access_token).toBeTruthy()

  /**
   * Exchange for a room token.
   *
   * The approving session carries the operator's rights; a control machine has no
   * reason to keep them. It only serves to claim its own token, with reduced
   * rights.
   */
  const machine = httpClient({
    authorization: `Bearer ${granted.access_token}`,
    'x-room-client-id': CLIENT_ID,
  })
  const { token } = await machine.devices.claim()
  expect(token.startsWith('rt_')).toBe(true)

  return { authorization: `Bearer ${token}` }
}

describe('hub end to end', () => {
  it('answers the health check', async () => {
    const response = await fetch(`${origin}/health`)
    expect(response.ok).toBe(true)
    expect((await response.json()) as { ok: boolean }).toMatchObject({ ok: true })
  })

  it('refuses every room procedure with no pairing', async () => {
    const anonymous = httpClient()
    await expect(anonymous.rooms.sync({ since: null })).rejects.toBeDefined()
  })

  it('pairs a machine then serves it its room\'s program', async () => {
    const deviceHeaders = await pairRoomDevice()
    const room = wsClient(deviceHeaders)

    const sync = await room.rooms.sync({ since: null })
    expect(sync.room.id).toBe(TRACK_1)
    // 27 slots in the export, 38 served: the shared breaks are projected into the
    // rooms that are free at the same moment, and the room receives them as its
    // own — that is what saves it a gap during lunch.
    expect(sync.program?.sessions).toHaveLength(38)
    expect(sync.program?.sessions.filter((s) => s.sharedFrom != null)).toHaveLength(11)
    expect(sync.serverTime).toBeTruthy()

    // A second sync with the same hash: the snapshot is not sent again.
    const again = await room.rooms.sync({ since: sync.contentHash })
    expect(again.program).toBeNull()
    expect(again.contentHash).toBe(sync.contentHash)
  }, 20_000)

  it('sends the event name and the OpenFeedback project down to the room', async () => {
    // The room titles its windows and draws its QR codes with what the hub
    // decided, never with a constant compiled into the binary installed on the
    // machine — it is the same machine that will serve the next edition.
    hub.services.settings.update({ openFeedbackProjectId: 'cloud-nord-2026' })
    const room = wsClient(await pairRoomDevice())

    const sync = await room.rooms.sync({ since: null })

    expect(sync.event).toEqual({ name: 'Cloud Nord 2026', shortName: 'Cloud Nord' })
    // Resolved by the hub: the room does not have to know the priority rule
    // between the event's setting and its own override.
    expect(sync.room.openFeedbackProjectId).toBe('cloud-nord-2026')
  }, 20_000)

  it('no longer lets a room contradict the event\'s OpenFeedback project', async () => {
    // The project is a property of the event, and a single place writes it. For as
    // long as the control app could too, it took one operator filling it in on one
    // machine for that room to have links and not the others — with nothing to say
    // why.
    hub.services.settings.update({ openFeedbackProjectId: 'cloud-nord-2026' })
    const room0 = hub.services.rooms.get(TRACK_1)!
    hub.services.rooms.upsert({ ...room0, openFeedbackProjectId: 'atelier-2026' })
    const room = wsClient(await pairRoomDevice())

    const sync = await room.rooms.sync({ since: null })

    // Overwritten, not merged: what the room carries in its database weighs
    // nothing.
    expect(sync.room.openFeedbackProjectId).toBe('cloud-nord-2026')
  }, 20_000)

  it('refuses to let a room write the OpenFeedback project', async () => {
    // The configuration procedure still exists — the OBS addresses and the scene
    // names are observed in front of the machines — but that field has left it:
    // zod discards unknown keys, the room can no longer put anything on it.
    hub.services.settings.update({ openFeedbackProjectId: 'cloud-nord-2026' })
    const room = wsClient(await pairRoomDevice())

    const config = await room.rooms.configure({
      openFeedbackProjectId: 'atelier-2026',
      displayPort: 7799,
    } as never)

    // The rest of the patch goes through: it is an ignored field, not a refused
    // call.
    expect(config.displayPort).toBe(7799)
    expect(hub.services.rooms.get(TRACK_1)?.openFeedbackProjectId).toBeNull()
  }, 20_000)

  it('routes the downward commands and sends the events back up', async () => {
    const deviceHeaders = await pairRoomDevice()
    const room = wsClient(deviceHeaders)

    const received: Command[] = []
    const iterator = await room.rooms.commands()
    const consumer = (async () => {
      for await (const command of iterator) {
        received.push(command)
        if (received.length === 2) break
      }
    })()

    await sleep(50)
    hub.services.commands.publish(TRACK_1, { type: 'scene.force', role: 'HOLD' }, null)
    hub.services.commands.publish(
      null,
      { type: 'message.broadcast', text: 'Ouverture des portes', level: 'info' },
      600,
    )
    await consumer

    expect(received.map((c) => c.payload.type)).toEqual(['scene.force', 'message.broadcast'])
    expect(received[1]!.seq).toBeGreaterThan(received[0]!.seq)

    // The outbox goes up, then the same batch is replayed.
    const batch = [
      {
        id: '01AAAAAAAAAAAAAAAAAAAAAAAA',
        roomId: TRACK_1,
        seq: 1,
        occurredAt: '2026-10-30T09:00:00.000+00:00',
        monotonicMs: 1000,
        delivery: 'required' as const,
        payload: { type: 'recording.started' as const, obs: 'B' as const, sessionId: 'ses-1' },
      },
    ]
    const first = await room.ingest.push({ batch })
    expect(first.acked).toEqual(['01AAAAAAAAAAAAAAAAAAAAAAAA'])
    const replay = await room.ingest.push({ batch })
    expect(replay.acked).toEqual([])
    expect(replay.duplicates).toEqual(['01AAAAAAAAAAAAAAAAAAAAAAAA'])
  }, 20_000)

  it('revokes a machine: its token no longer gives access to the room', async () => {
    const deviceHeaders = await pairRoomDevice()
    const room = httpClient(deviceHeaders)
    await expect(room.rooms.sync({ since: null })).resolves.toBeDefined()

    hub.services.devices.revoke(CLIENT_ID)
    await expect(room.rooms.sync({ since: null })).rejects.toBeDefined()
  }, 20_000)
})


/**
 * Supervision: what is going on in each room, and for how much longer.
 *
 * The remaining time is computed by the hub and not by the console: the latter
 * only has the machine's clock, which is not the authoritative one — and which
 * can be weeks away from it when the hub runs on a simulated time.
 */
describe('rooms\' remaining time', () => {
  it('counts it on the hub\'s clock, not on the client\'s', async () => {
    hub.services.clock.setSimulated('2026-10-30T10:20:00.000Z')
    const admin = httpClient({ authorization: `Bearer ${await signInOperator()}` })

    const rooms = await admin.rooms.statuses()
    const room = rooms.find((s) => s.roomId === TRACK_1)
    const slot = room?.currentSession
    expect(slot?.title).toEqual(expect.any(String))
    expect(slot?.endsAt).toEqual(expect.any(String))

    // Referenced against the simulated time: the machine running this test is at a
    // completely different date, and a computation done there would be absurd.
    const expected = Date.parse(slot!.endsAt!) - Date.parse('2026-10-30T10:20:00.000Z')
    expect(Math.abs(slot!.remainingMs! - expected)).toBeLessThan(2_000)
  })

  it('does not invent it when nothing is going on', async () => {
    // Real time: the event is in October, there is no running slot.
    const admin = httpClient({ authorization: `Bearer ${await signInOperator()}` })
    const rooms = await admin.rooms.statuses()

    expect(rooms.find((s) => s.roomId === TRACK_1)?.currentSession).toBeNull()
  })
})

/**
 * Resynchronization asked for from the console.
 *
 * It exists because there was no other recourse: putting a room straight again
 * required restarting it, and therefore cutting its capture.
 */
describe('resynchronizing the rooms', () => {
  it('sends the request down to the targeted room', async () => {
    const headers = await pairRoomDevice()
    const room = wsClient(headers)
    const received: Command[] = []
    const stream = (async () => {
      for await (const command of await room.rooms.commands()) {
        received.push(command)
        if (received.length >= 1) break
      }
    })()

    const admin = httpClient({ authorization: `Bearer ${await signInOperator()}` })
    await sleep(200)
    const result = await admin.rooms.resync({ roomId: TRACK_1 })
    expect(result).toEqual({ ok: true, rooms: 1 })

    await Promise.race([stream, sleep(3_000)])
    expect(received[0]?.payload).toMatchObject({
      type: 'room.resync',
      // Who asked for it: the room traces it, so we will know where the gesture
      // came from.
      requestedBy: OPERATOR.email,
    })
  })

  it('counts the targeted rooms when the request is a general one', async () => {
    const admin = httpClient({ authorization: `Bearer ${await signInOperator()}` })

    // A single room on this hub: it is the count the console announces, and it is
    // what lets it say "no room" rather than "off we go" on a hub where nothing is
    // paired.
    expect(await admin.rooms.resync({ roomId: null })).toEqual({ ok: true, rooms: 1 })
  })

  it('refuses an unknown room rather than emitting into the void', async () => {
    const admin = httpClient({ authorization: `Bearer ${await signInOperator()}` })

    await expect(admin.rooms.resync({ roomId: 'salle-fantome' })).rejects.toThrow(/inconnue/)
  })

  it('stays closed to the rooms: it is a console gesture', async () => {
    const headers = await pairRoomDevice()
    const room = wsClient(headers)

    await expect(room.rooms.resync({ roomId: TRACK_1 })).rejects.toThrow()
  })
})

/**
 * Slots whose kind gets corrected from the console.
 *
 * The upstream export does not tell a lunch from a talk: both are slots with a
 * title and a room. The normalizer decides on a single signal — no speaker, so a
 * break — and gets it wrong in both directions: the room titled "Déjeuner" on air,
 * and left the opening keynote with no titling and no "Start" button.
 */
describe('correcting a slot\'s kind', () => {
  /** "IA for OPS on Scaleway", a real talk of Track #1. */
  const TALK = 'cmotqj1r1008401pxxsm6y2fu'

  it('serves it as a break everywhere, fingerprint included', async () => {
    const admin = httpClient({ authorization: `Bearer ${await signInOperator()}` })
    const before = hub.services.programs.active()!

    const result = await admin.sessions.override({ sessionId: TALK, action: 'break' })

    expect(result.ok).toBe(true)
    // The fingerprint moves: without that, the rooms would stay on their cache and
    // keep titling on air what has just been corrected.
    expect(result.contentHash).not.toBe(before.contentHash)

    const after = hub.services.programs.active()!
    expect(after.contentHash).toBe(result.contentHash)
    expect(after.program.sessions.find((s) => s.id === TALK)?.kind).toBe('break')
    // The rest of the program is intact.
    expect(after.program.sessions).toHaveLength(before.program.sessions.length)
  })

  it('removes it from the schedule as a talk, and from its feedback QR codes', async () => {
    const admin = httpClient({ authorization: `Bearer ${await signInOperator()}` })
    await admin.settings.update({ openFeedbackProjectId: 'cloud-nord-2026' })

    const before = (await admin.program.planning()).sessions.find((s) => s.id === TALK)!
    expect(before.kind).toBe('talk')
    expect(before.feedbackUrl).toEqual(expect.any(String))
    expect(before.overriddenAs).toBeNull()

    await admin.sessions.override({ sessionId: TALK, action: 'break' })

    const after = (await admin.program.planning()).sessions.find((s) => s.id === TALK)!
    expect(after.kind).toBe('break')
    // The console alone tells a break from the export apart from a decided break:
    // it is the console that put it there, and there that it gets removed.
    expect(after.overriddenAs).toBe('break')
    // Nothing left to rate: a dead QR code scanned by the audience costs more than
    // an empty cell.
    expect(after.feedbackUrl).toBeNull()
  })

  it('changes what the room\'s badge says', async () => {
    hub.services.clock.setSimulated('2026-10-30T09:00:00.000Z')
    const admin = httpClient({ authorization: `Bearer ${await signInOperator()}` })

    // 09:00 UTC: "IA for OPS" runs from 08:50 to 09:40, nobody has launched it.
    // `retard` and `pause` are contract values.
    const before = await admin.rooms.statuses()
    expect(before.find((s) => s.roomId === TRACK_1)?.conference).toBe('retard')

    await admin.sessions.override({ sessionId: TALK, action: 'break' })

    // A slot that is not a talk does not get started: there is no late start left
    // to report.
    const after = await admin.rooms.statuses()
    expect(after.find((s) => s.roomId === TRACK_1)?.conference).toBe('pause')
  })

  it('removes itself, and gives the program back its original fingerprint', async () => {
    const admin = httpClient({ authorization: `Bearer ${await signInOperator()}` })
    const original = hub.services.programs.active()!.contentHash

    await admin.sessions.override({ sessionId: TALK, action: 'break' })
    const removed = await admin.sessions.override({ sessionId: TALK, action: null })

    // Once removed, the override must be indistinguishable from an override never
    // placed: otherwise the rooms would re-download for nothing on every round
    // trip.
    expect(removed.contentHash).toBe(original)
    expect(hub.services.programs.active()!.program.sessions.find((s) => s.id === TALK)?.kind)
      .toBe('talk')
  })

  it('tells the rooms, corrected program to back it up', async () => {
    const headers = await pairRoomDevice()
    const room = wsClient(headers)
    const received: Command[] = []
    const stream = (async () => {
      for await (const command of await room.rooms.commands()) {
        received.push(command)
        break
      }
    })()

    const admin = httpClient({ authorization: `Bearer ${await signInOperator()}` })
    await sleep(200)
    const { contentHash } = await admin.sessions.override({ sessionId: TALK, action: 'break' })

    await Promise.race([stream, sleep(3_000)])
    expect(received[0]?.payload).toMatchObject({ type: 'program.invalidate', contentHash })

    // And the room that resynchronizes on its old fingerprint does receive the
    // corrected program, not a `null` "nothing has changed".
    const result = await room.rooms.sync({ since: null })
    expect(result.contentHash).toBe(contentHash)
    expect(result.program?.sessions.find((s) => s.id === TALK)?.kind).toBe('break')
  })

  /** "Keynote d'ouverture": with no speaker announced, the export gives it as a break. */
  const KEYNOTE = 'SCGAR8iJEoCyZxxLyfbb'

  it('makes a talk of a slot the export gives as a break', async () => {
    const admin = httpClient({ authorization: `Bearer ${await signInOperator()}` })
    await admin.settings.update({ openFeedbackProjectId: 'cloud-nord-2026' })

    // The normalizer has only one signal to decide on — no speaker, so a break —
    // and the opening keynote is precisely the case where it misses.
    const before = (await admin.program.planning()).sessions.find((s) => s.id === KEYNOTE)!
    expect(before.kind).toBe('break')
    expect(before.speakers).toEqual([])

    await admin.sessions.override({ sessionId: KEYNOTE, action: 'talk' })

    const after = (await admin.program.planning()).sessions.find((s) => s.id === KEYNOTE)!
    expect(after.kind).toBe('talk')
    expect(after.overriddenAs).toBe('talk')
    // A talk again, it gets rated: the QR code reappears.
    expect(after.feedbackUrl).toEqual(expect.any(String))
    expect(hub.services.programs.active()!.program.sessions.find((s) => s.id === KEYNOTE)?.kind)
      .toBe('talk')
  })

  it('makes it drivable from the control app', async () => {
    hub.services.clock.setSimulated('2026-10-30T08:10:00.000Z')
    const admin = httpClient({ authorization: `Bearer ${await signInOperator()}` })

    // 08:10 UTC: the keynote runs from 08:00 to 08:45. Given as a break, it does
    // not get started — the room is simply "on a break".
    const before = await admin.rooms.statuses()
    expect(before.find((s) => s.roomId === TRACK_1)?.conference).toBe('pause')

    await admin.sessions.override({ sessionId: KEYNOTE, action: 'talk' })

    // Declared a talk, it waits to be launched — and says so.
    const after = await admin.rooms.statuses()
    expect(after.find((s) => s.roomId === TRACK_1)?.conference).toBe('retard')
  })

  it('ignores a decision that says what the export already says', async () => {
    const admin = httpClient({ authorization: `Bearer ${await signInOperator()}` })
    const original = hub.services.programs.active()!.contentHash

    // Declaring as a break what the export already gives as a break changes
    // nothing — and must therefore not make the rooms re-download the program.
    const result = await admin.sessions.override({ sessionId: KEYNOTE, action: 'break' })

    expect(result.contentHash).toBe(original)
    expect(hub.services.programs.active()!.overrides).toEqual({})
  })

  it('becomes moot the day the export announces the speaker', async () => {
    const admin = httpClient({ authorization: `Bearer ${await signInOperator()}` })
    const original = hub.services.programs.active()!.contentHash
    await admin.sessions.override({ sessionId: KEYNOTE, action: 'talk' })
    expect(hub.services.programs.active()!.contentHash).not.toBe(original)

    // A reimport where the keynote finally carries a speaker: the normalizer makes
    // a talk of it on its own, and the decision stops applying.
    const corrected = rawProgram.replace(
      '"id":"SCGAR8iJEoCyZxxLyfbb","title":"Keynote d\'ouverture","abstract":null',
      '"id":"SCGAR8iJEoCyZxxLyfbb","title":"Keynote d\'ouverture, avec son intervenant","abstract":null',
    ).replace(
      '"durationMinutes":45,"speakerIds":[],"trackId":"track-1-teilhard-de-chardin"',
      '"durationMinutes":45,"speakerIds":["McrpEiDzIV1NERXgVIG5"],"trackId":"track-1-teilhard-de-chardin"',
    )
    expect(corrected).not.toBe(rawProgram)
    hub.services.programs.importFromText(corrected, 'https://exemple/programme.json')

    const after = hub.services.programs.active()!
    expect(after.program.sessions.find((s) => s.id === KEYNOTE)?.kind).toBe('talk')
    // With no override applied: the fingerprint is the snapshot's, bare.
    expect(after.overrides).toEqual({})
    expect(after.contentHash).not.toContain('~')
  })

  it('makes the shared breaks follow the decision', async () => {
    const admin = httpClient({ authorization: `Bearer ${await signInOperator()}` })
    const shared = () =>
      hub.services.programs.active()!.program.sessions.filter((s) => s.sharedFrom === TALK)

    // "IA for OPS" is a talk: nothing to share.
    expect(shared()).toEqual([])

    await admin.sessions.override({ sessionId: TALK, action: 'break' })

    // Declared a break, it projects into the rooms free at the same moment — the
    // projection is recomputed on the served program, decisions included.
    // 08:50 → 09:40: Track #2 holds its own talk, Hands on its workshop. Nobody is
    // free, so nothing projects: the rule does not overlap.
    expect(shared()).toEqual([])

    // The keynote, on the other hand, falls while the other two rooms are empty.
    await admin.sessions.override({ sessionId: KEYNOTE, action: 'talk' })
    const withoutBreak = hub.services.programs
      .active()!
      .program.sessions.filter((s) => s.sharedFrom === KEYNOTE)
    // A talk again, it stops being shared.
    expect(withoutBreak).toEqual([])

    await admin.sessions.override({ sessionId: KEYNOTE, action: null })
    expect(
      hub.services.programs.active()!.program.sessions.filter((s) => s.sharedFrom === KEYNOTE),
    ).toHaveLength(2)
  })

  it('refuses a decision on an inherited break, without losing it on the way', async () => {
    const admin = httpClient({ authorization: `Bearer ${await signInOperator()}` })
    const inherited = hub.services.programs
      .active()!
      .program.sessions.find((s) => s.sharedFrom != null)!

    // It does not exist in the export: a decision placed on its derived identifier
    // would have no effect, and nobody would know how to remove it.
    await expect(
      admin.sessions.override({ sessionId: inherited.id, action: 'talk' }),
    ).rejects.toThrow(/hérit/)
  })

  it('refuses a slot absent from the active program', async () => {
    const admin = httpClient({ authorization: `Bearer ${await signInOperator()}` })

    await expect(
      admin.sessions.override({ sessionId: 'creneau-fantome', action: 'break' }),
    ).rejects.toThrow(/inconnu/)
  })

  it('stays closed to the rooms: it is the event\'s program', async () => {
    const headers = await pairRoomDevice()
    const room = wsClient(headers)

    await expect(room.sessions.override({ sessionId: TALK, action: 'break' })).rejects.toThrow()
  })
})

/**
 * The shared slot, seen from the event and not from a room.
 *
 * A different question from the cards': they say where each room is at, this one
 * says what the event is doing.
 */
describe('the current shared slot', () => {
  it('counts the rooms concerned during lunch', async () => {
    // 11:40 UTC: lunch runs from 11:15 to 12:05 on Track #1, and the other two
    // rooms inherit it — they have nothing scheduled at that moment.
    hub.services.clock.setSimulated('2026-10-30T11:40:00.000Z')
    const admin = httpClient({ authorization: `Bearer ${await signInOperator()}` })

    const shared = await admin.program.globalBreak()

    // `en-cours` is a contract value.
    expect(shared).toMatchObject({ state: 'en-cours', title: 'Déjeuner', rooms: 3 })
    expect(shared?.endsAt).toBe('2026-10-30T12:05:00.000Z')
    // The hub's time travels with it: the browser only has its own, and it can be
    // weeks away when the clock is simulated.
    expect(Date.parse(shared!.serverTime)).toBeCloseTo(Date.parse('2026-10-30T11:40:00.000Z'), -4)
  })

  it('announces it a quarter of an hour before', async () => {
    hub.services.clock.setSimulated('2026-10-30T11:05:00.000Z')
    const admin = httpClient({ authorization: `Bearer ${await signInOperator()}` })

    expect(await admin.program.globalBreak()).toMatchObject({
      state: 'a-venir',
      title: 'Déjeuner',
    })
  })

  it('stays silent when nothing shared is going on', async () => {
    // 09:00 UTC: the three rooms each hold their own talk.
    hub.services.clock.setSimulated('2026-10-30T09:00:00.000Z')
    const admin = httpClient({ authorization: `Bearer ${await signInOperator()}` })

    expect(await admin.program.globalBreak()).toBeNull()
  })

  it('follows a decision taken from the console', async () => {
    // 09:00 UTC: "IA for OPS" runs on Track #1. Declared a break, it becomes a
    // shared slot — but for itself alone, the other two rooms having their own
    // talk at that hour.
    hub.services.clock.setSimulated('2026-10-30T09:00:00.000Z')
    const admin = httpClient({ authorization: `Bearer ${await signInOperator()}` })
    const talk = hub.services.programs
      .active()!
      .program.sessions.find((s) => s.title.includes('IA for OPS'))!

    await admin.sessions.override({ sessionId: talk.id, action: 'break' })

    expect(await admin.program.globalBreak()).toMatchObject({
      state: 'en-cours',
      title: 'IA for OPS on Scaleway',
      rooms: 1,
    })
  })

  it('marks the room as on a break in the supervision view', async () => {
    hub.services.clock.setSimulated('2026-10-30T11:40:00.000Z')
    const admin = httpClient({ authorization: `Bearer ${await signInOperator()}` })

    const rooms = await admin.rooms.statuses()
    const room = rooms.find((s) => s.roomId === TRACK_1)!

    expect(room.breakBadge).toMatchObject({ state: 'en-cours', title: 'Déjeuner' })
    // And the badge says there is nobody, not that a talk is waiting.
    expect(room.conference).toBe('pause')
  })
})

/**
 * The schedule read back from the console.
 *
 * The talks table only shows what has been started: it answers "where are we",
 * never "and what is next". The OpenFeedback link goes with each slot — it is the
 * address one gives back to the speaker who comes asking where their feedback is.
 */
describe('the active program\'s schedule', () => {
  it('returns the whole program, rooms and times resolved', async () => {
    const admin = httpClient({ authorization: `Bearer ${await signInOperator()}` })

    const planning = await admin.program.planning()

    expect(planning.contentHash).toEqual(expect.any(String))
    expect(planning.timezone).toBe('Europe/Paris')
    expect(planning.rooms.map((room) => room.id)).toContain(TRACK_1)
    // 27 slots in the export: the console shows them all, not just the two or
    // three that have been launched — plus the eleven shared breaks projected,
    // which say what each room will really display.
    expect(planning.sessions).toHaveLength(38)
    expect(planning.sessions.filter((s) => s.sharedFrom != null)).toHaveLength(11)
    // The hub's name wins over the program's: a room gets renamed from the
    // console, and it is that name that is written on the door.
    expect(planning.sessions.find((s) => s.roomId === TRACK_1)?.roomName).toBe(
      'Track #1 - Teilhard de Chardin',
    )
  })

  /**
   * The day as it was lived, joined to the program by the hub.
   *
   * Centralized here because the lifecycle is written here and holds for every
   * room at once: a console that cross-referenced two lists itself would end up
   * displaying a version that is nobody's.
   */
  it('joins the real start and end of every talk', async () => {
    const admin = httpClient({ authorization: `Bearer ${await signInOperator()}` })
    const talk = (await admin.program.planning()).sessions.find(
      (session) => session.kind === 'talk' && session.roomId === TRACK_1,
    )!

    // Nothing while nobody has driven: taking the program's schedule would claim a
    // talk took place when nothing attests to it.
    expect(talk.startedAt).toBeNull()
    expect(talk.endedAt).toBeNull()

    const launched = await admin.sessions.start({ sessionId: talk.id })
    const afterStart = (await admin.program.planning()).sessions.find((s) => s.id === talk.id)!
    expect(afterStart.startedAt).toBe(launched.startedAt)
    // Still open: we do not close the slot in the operator's stead.
    expect(afterStart.endedAt).toBeNull()
    // The planned stays the planned: the two are read side by side, and it is the
    // gap that is of interest.
    expect(afterStart.startsAt).toBe(talk.startsAt)

    const closed = await admin.sessions.end({ sessionId: talk.id })
    const afterEnd = (await admin.program.planning()).sessions.find((s) => s.id === talk.id)!
    expect(afterEnd.startedAt).toBe(launched.startedAt)
    expect(afterEnd.endedAt).toBe(closed.endedAt)
    // Who decided: the only thing that answers "I did not do that".
    expect(afterEnd.decidedBy).toBe(OPERATOR.email)

    // Reset to upcoming: the lived day disappears with the decision that carried
    // it.
    await admin.sessions.reset({ sessionId: talk.id })
    const afterCancel = (await admin.program.planning()).sessions.find((s) => s.id === talk.id)!
    expect(afterCancel.startedAt).toBeNull()
    expect(afterCancel.endedAt).toBeNull()
  })

  it('offers nothing to rate while the OpenFeedback project is not set', async () => {
    const admin = httpClient({ authorization: `Bearer ${await signInOperator()}` })

    const planning = await admin.program.planning()

    // No hard-written project: the repository does not know the event it serves,
    // and a link to another organizer's project would be worse than nothing —
    // scanned in a room, it leads to a page that does not talk about that talk.
    expect(planning.sessions.every((session) => session.feedbackUrl == null)).toBe(true)
  })

  it('gives the OpenFeedback link of every talk', async () => {
    const admin = httpClient({ authorization: `Bearer ${await signInOperator()}` })
    // A hub setting: the project is a property of the event, not of a room.
    // Setting it once holds for all of them, slots with no room included.
    await admin.settings.update({ openFeedbackProjectId: 'cloud-nord-2026' })

    const planning = await admin.program.planning()
    const talk = planning.sessions.find((session) => session.kind === 'talk')!

    // OpenFeedback's public route, built from the program: no network call, no API
    // key, and therefore nothing to repair on the day.
    expect(talk.feedbackUrl).toBe(
      `https://openfeedback.io/cloud-nord-2026/2026-10-30/${talk.id}`,
    )
  })

  it('gives the link to every room as soon as the hub has its project', async () => {
    // The bug observed came from a second owner of the setting: room 1 carried it,
    // the others did not, and twenty-six slots out of twenty-seven stayed with no
    // link. A single owner, and the question no longer arises — the project holds
    // for every room at once.
    const admin = httpClient({ authorization: `Bearer ${await signInOperator()}` })
    await admin.settings.update({ openFeedbackProjectId: 'cloud-nord-2026' })

    const planning = await admin.program.planning()

    const talks = planning.sessions.filter((session) => session.kind === 'talk')
    const rooms = new Set(talks.map((session) => session.roomId))
    expect(rooms.size).toBeGreaterThan(1)
    expect(talks.every((session) => session.feedbackUrl != null)).toBe(true)
    expect(planning.openFeedbackProjectId).toBe('cloud-nord-2026')
  })

  it('ignores a project left on a room', async () => {
    // A database from before the change still carries one. It must decide nothing
    // any more: with no setting on the hub, nobody has a link — the takeover at
    // startup is the only place that still looks at that field.
    const room = hub.services.rooms.get(TRACK_1)!
    hub.services.rooms.upsert({ ...room, openFeedbackProjectId: 'cloud-nord-2026' })

    const admin = httpClient({ authorization: `Bearer ${await signInOperator()}` })
    const planning = await admin.program.planning()

    expect(planning.openFeedbackProjectId).toBeNull()
    expect(planning.sessions.every((session) => session.feedbackUrl == null)).toBe(true)
  })

  it('does not take an empty string for an OpenFeedback project', async () => {
    // A text field left empty arrives as `''`, not as `null`, and `??` lets it
    // through: the fallback was overwritten, and the built address pointed at
    // `openfeedback.io///…`. Better no link than a dead one.
    hub.services.settings.update({ openFeedbackProjectId: '   ' })

    const admin = httpClient({ authorization: `Bearer ${await signInOperator()}` })
    const planning = await admin.program.planning()

    expect(planning.openFeedbackProjectId).toBeNull()
    expect(planning.sessions.every((session) => session.feedbackUrl == null)).toBe(true)
  })

  it('corrects a slot\'s OpenFeedback identifier', async () => {
    // The bet "OpenFeedback reuses the export's identifiers" is lost silently: the
    // link stays clickable, the QR code stays scannable, and both lead to a page
    // that talks about no talk. Without this correction, a dead QR code cannot be
    // repaired — the export would bring it back on every import.
    const admin = httpClient({ authorization: `Bearer ${await signInOperator()}` })
    await admin.settings.update({ openFeedbackProjectId: 'cloud-nord-2026' })
    const talk = (await admin.program.planning()).sessions.find((s) => s.kind === 'talk')!

    const placed = await admin.sessions.feedbackId({ sessionId: talk.id, feedbackId: 'of-42' })

    expect(placed.feedbackId).toBe('of-42')
    expect(placed.feedbackUrl).toBe('https://openfeedback.io/cloud-nord-2026/2026-10-30/of-42')

    const after = (await admin.program.planning()).sessions.find((s) => s.id === talk.id)!
    expect(after.feedbackId).toBe('of-42')
    expect(after.feedbackIdOverride).toBe('of-42')
    // The slot's identifier, for its part, does not move: it is the lifecycle's
    // key.
    expect(after.id).toBe(talk.id)
  })

  it('carries the correction through to the program served to the rooms', async () => {
    // The room draws its QR codes offline from that program. If the correction
    // were not in it, the console would display the right address while the screen
    // projected another — and the one in front of the audience would be the wrong
    // one.
    const admin = httpClient({ authorization: `Bearer ${await signInOperator()}` })
    await admin.settings.update({ openFeedbackProjectId: 'cloud-nord-2026' })
    const talk = (await admin.program.planning()).sessions.find(
      (s) => s.kind === 'talk' && s.roomId === TRACK_1,
    )!
    const room = wsClient(await pairRoomDevice())
    const before = await room.rooms.sync({ since: null })

    await admin.sessions.feedbackId({ sessionId: talk.id, feedbackId: 'of-42' })

    const after = await room.rooms.sync({ since: before.contentHash })
    // The fingerprint moves: without that a room would stay on its cache,
    // projecting the address that has just been declared wrong.
    expect(after.contentHash).not.toBe(before.contentHash)
    expect(after.program).not.toBeNull()
    const served = after.program!.sessions.find((s) => s.id === talk.id)!
    expect(served.feedbackId).toBe('of-42')
  }, 20_000)

  it('gives a slot back the export\'s identifier', async () => {
    const admin = httpClient({ authorization: `Bearer ${await signInOperator()}` })
    await admin.settings.update({ openFeedbackProjectId: 'cloud-nord-2026' })
    const talk = (await admin.program.planning()).sessions.find((s) => s.kind === 'talk')!
    await admin.sessions.feedbackId({ sessionId: talk.id, feedbackId: 'of-42' })

    const removed = await admin.sessions.feedbackId({ sessionId: talk.id, feedbackId: null })

    expect(removed.feedbackId).toBe(talk.id)
    const after = (await admin.program.planning()).sessions.find((s) => s.id === talk.id)!
    expect(after.feedbackIdOverride).toBeNull()
    expect(after.feedbackUrl).toBe(
      `https://openfeedback.io/cloud-nord-2026/2026-10-30/${talk.id}`,
    )
  })

  it('does not count a correction that repeats the export', async () => {
    // The same rule as for kind decisions: a correction with no object must not
    // change the fingerprint, otherwise the rooms re-download for nothing.
    const admin = httpClient({ authorization: `Bearer ${await signInOperator()}` })
    const talk = (await admin.program.planning()).sessions.find((s) => s.kind === 'talk')!
    const before = (await admin.program.planning()).contentHash

    await admin.sessions.feedbackId({ sessionId: talk.id, feedbackId: talk.id })

    const after = await admin.program.planning()
    expect(after.contentHash).toBe(before)
    expect(after.sessions.find((s) => s.id === talk.id)?.feedbackIdOverride).toBeNull()
  })

  it('refuses to correct a break\'s identifier', async () => {
    // A break has no feedback page: the row placed would be read back by nobody.
    const admin = httpClient({ authorization: `Bearer ${await signInOperator()}` })
    const aBreak = (await admin.program.planning()).sessions.find((s) => s.kind === 'break')!

    await expect(
      admin.sessions.feedbackId({ sessionId: aBreak.id, feedbackId: 'of-42' }),
    ).rejects.toThrow()
  })

  it('offers nothing to rate on a break', async () => {
    const admin = httpClient({ authorization: `Bearer ${await signInOperator()}` })

    const planning = await admin.program.planning()
    const aBreak = planning.sessions.find((session) => session.kind === 'break')

    // Nobody rates a lunch, and a dead QR code costs more than an empty cell.
    expect(aBreak).toBeTruthy()
    expect(aBreak?.feedbackUrl).toBeNull()
  })

  it('dates the schedule on the hub\'s clock, not on the console\'s', async () => {
    // It is that time which designates the slot highlighted as "right now".
    // Computed in the browser, it would point at a slot from a completely
    // different week as soon as the hub runs on a simulated time.
    hub.services.clock.setSimulated('2026-10-30T10:20:00.000Z')
    const admin = httpClient({ authorization: `Bearer ${await signInOperator()}` })

    const planning = await admin.program.planning()

    expect(
      Math.abs(Date.parse(planning.serverTime) - Date.parse('2026-10-30T10:20:00.000Z')),
    ).toBeLessThan(2_000)
  })

  it('stays closed to room machines', async () => {
    // The schedule is already pushed to the rooms by the sync: opening an operator
    // procedure to them on top would only add surface.
    const machine = httpClient(await pairRoomDevice())

    await expect(machine.program.planning()).rejects.toThrow()
  })
})

describe('a talk\'s VOD folder', () => {
  /** Room 1's talk, the one the test control app records. */
  const talkOfRoom1 = async (admin: Client) => {
    const planning = await admin.program.planning()
    const talk = planning.sessions.find(
      (session) => session.kind === 'talk' && session.roomId === TRACK_1,
    )
    expect(talk).toBeTruthy()
    return talk!
  }

  it('answers with no storage configured, takes included', async () => {
    // **The point of the procedure.** The two halves do not come from the same
    // place: the takes are recomposed from the ingestion log, which every hub
    // keeps, and only the uploads need S3. Refusing for want of storage would
    // deprive a hub with no S3 of the only answer that counts on the evening of
    // the teardown — "is the rush on the machine?".
    // `stockageConfigure`, `captations`, `enCours`, `rattachement`,
    // `televersements` and `session`/`horaire` are contract names and values.
    const admin = httpClient({ authorization: `Bearer ${await signInOperator()}` })
    const talk = await talkOfRoom1(admin)

    hub.services.ingest.push(TRACK_1, [
      {
        id: '01H1AAAAAAAAAAAAAAAAAAAAAA',
        roomId: TRACK_1,
        seq: 1,
        occurredAt: '2026-10-30T10:00:00.000+00:00',
        monotonicMs: 1000,
        delivery: 'required',
        payload: { type: 'recording.started', obs: 'B', sessionId: talk.id },
      },
      {
        id: '01H2AAAAAAAAAAAAAAAAAAAAAA',
        roomId: TRACK_1,
        seq: 2,
        occurredAt: '2026-10-30T10:50:00.000+00:00',
        monotonicMs: 2000,
        delivery: 'required',
        payload: {
          type: 'recording.stopped',
          obs: 'B',
          sessionId: talk.id,
          outputPath: '/rushes/le-talk.mkv',
          durationMs: 3_000_000,
          sidecarWritten: true,
        },
      },
    ])

    const folder = await admin.vod.conference({ sessionId: talk.id })

    expect(folder.stockageConfigure).toBe(false)
    expect(folder.roomId).toBe(TRACK_1)
    expect(folder.captations).toHaveLength(1)
    expect(folder.captations[0]).toMatchObject({
      file: '/rushes/le-talk.mkv',
      sidecarWritten: true,
      enCours: false,
      // Stamped by the control app: it is not a deduction.
      rattachement: 'session',
    })
    expect(folder.televersements).toEqual([])
  })

  it('attaches by time a take launched outside the lifecycle', async () => {
    // A recording started by hand carries no slot. The rush exists all the same,
    // and it is even the only one: leaving it invisible would amount to making one
    // look for it file by file.
    const admin = httpClient({ authorization: `Bearer ${await signInOperator()}` })
    const talk = await talkOfRoom1(admin)
    hub.services.clock.setSimulated('2026-10-30T10:05:00.000Z')
    await admin.sessions.start({ sessionId: talk.id })

    hub.services.ingest.push(TRACK_1, [
      {
        id: '01J1AAAAAAAAAAAAAAAAAAAAAA',
        roomId: TRACK_1,
        seq: 1,
        occurredAt: '2026-10-30T10:06:00.000+00:00',
        monotonicMs: 1000,
        delivery: 'required',
        payload: { type: 'recording.started', obs: 'B', sessionId: null },
      },
    ])

    const folder = await admin.vod.conference({ sessionId: talk.id })

    expect(folder.captations).toHaveLength(1)
    // A lead, not a fact: the console displays it as such.
    expect(folder.captations[0]).toMatchObject({ rattachement: 'horaire', enCours: true })
  })

  it('does not attribute to a talk the take stamped for another', async () => {
    const admin = httpClient({ authorization: `Bearer ${await signInOperator()}` })
    const talk = await talkOfRoom1(admin)
    hub.services.clock.setSimulated('2026-10-30T10:05:00.000Z')
    await admin.sessions.start({ sessionId: talk.id })

    hub.services.ingest.push(TRACK_1, [
      {
        id: '01K1AAAAAAAAAAAAAAAAAAAAAA',
        roomId: TRACK_1,
        seq: 1,
        occurredAt: '2026-10-30T10:06:00.000+00:00',
        monotonicMs: 1000,
        delivery: 'required',
        payload: { type: 'recording.started', obs: 'B', sessionId: 'un-autre-creneau' },
      },
    ])

    const folder = await admin.vod.conference({ sessionId: talk.id })

    // It does cover the time, but it already belongs to someone: the time-based
    // fallback only serves the takes nobody claims.
    expect(folder.captations).toEqual([])
  })

  it('refuses a talk unknown to the program', async () => {
    const admin = httpClient({ authorization: `Bearer ${await signInOperator()}` })

    await expect(admin.vod.conference({ sessionId: 'ses-inexistante' })).rejects.toThrow()
  })

  it('stays closed to room machines', async () => {
    // The folder crosses every room: it is a console view.
    const admin = httpClient({ authorization: `Bearer ${await signInOperator()}` })
    const talk = await talkOfRoom1(admin)
    const machine = httpClient(await pairRoomDevice())

    await expect(machine.vod.conference({ sessionId: talk.id })).rejects.toThrow()
  })
})
