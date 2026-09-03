import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createHub, type Hub } from '../src/server.js'
import { provisionOperator } from '../src/operators.js'

const rawProgram = readFileSync(
  fileURLToPath(new URL('../../../packages/program/test/fixtures/cloudnord-2026.json', import.meta.url)),
  'utf8',
)

const OPERATOR = { email: 'regie@cloudnord.fr', name: 'Régie', password: 'motdepasse-regie-2026' }
const CLIENT_ID = '01JB2ZK5T7QW9V0YHRXM3N4P6C'
const TRACK_1 = 'track-1-teilhard-de-chardin'
const TRACK_2 = 'track-2-mf-1092'

let hub: Hub
let origin: string
let operatorToken: string
let roomToken: string

async function rpc(
  path: string,
  input: unknown,
  token?: string,
  clientId?: string,
  /**
   * The mobile control app's tab, when there is one.
   *
   * The lock carries a session, not an account: the procedures that manipulate it
   * demand this header rather than falling back on the address.
   */
  session?: string,
) {
  const response = await fetch(`${origin}/rpc/${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token != null ? { authorization: `Bearer ${token}` } : {}),
      ...(clientId != null ? { 'x-room-client-id': clientId } : {}),
      ...(session != null ? { 'x-regie-session': session } : {}),
    },
    body: JSON.stringify({ json: input }),
  })
  return { status: response.status, body: (await response.json()) as { json?: never } }
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

  await provisionOperator(hub.auth, OPERATOR)
  const snapshot = hub.services.programs.importFromText(rawProgram, 'https://exemple/programme.json')
  hub.services.rooms.ensureFromTracks(snapshot.program.rooms)

  const signIn = await fetch(`${origin}/api/auth/sign-in/email`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: OPERATOR.email, password: OPERATOR.password }),
  })
  operatorToken = ((await signIn.json()) as { token: string }).token

  // Simulated pairing: the machine is bound, as after an approval.
  hub.services.devices.bind({ clientId: CLIENT_ID, roomId: TRACK_1, approvedByUserId: 'op' })
  const claim = await rpc('devices/claim', {}, operatorToken, CLIENT_ID)
  roomToken = (claim.body.json as unknown as { token: string }).token
})

afterEach(async () => {
  await hub.close()
})

describe('exchanging the room token', () => {
  it('delivers a token distinct from the approving session', () => {
    expect(roomToken).toMatch(/^rt_/)
    expect(roomToken).not.toBe(operatorToken)
  })

  it('demands an operator session and the machine\'s identifier', async () => {
    expect((await rpc('devices/claim', {}, undefined, CLIENT_ID)).status).toBe(401)
    expect((await rpc('devices/claim', {}, operatorToken)).status).toBe(400)
  })

  it('refuses a machine that is not paired', async () => {
    const result = await rpc('devices/claim', {}, operatorToken, '01ZZZZZZZZZZZZZZZZZZZZZZZZ')
    expect(result.status).toBe(403)
  })
})

describe('what a room can do', () => {
  const asRoom = (path: string, input: unknown) => rpc(path, input, roomToken)

  it('synchronizes its program', async () => {
    const result = await asRoom('rooms/sync', { since: null })
    expect(result.status).toBe(200)
    expect((result.body.json as unknown as { room: { id: string } }).room.id).toBe(TRACK_1)
  })

  it('learns the hub\'s mode at the same time', async () => {
    // The room compares it to its own: a development machine plugged into the
    // event's hub must see itself in the control room, not find out at setup time.
    const result = await asRoom('rooms/sync', { since: null })

    expect((result.body.json as unknown as { mode: string }).mode).toBe('production')
  })

  it('reports its events', async () => {
    const result = await asRoom('ingest/push', {
      batch: [
        {
          id: '01AAAAAAAAAAAAAAAAAAAAAAAA',
          roomId: TRACK_1,
          seq: 1,
          occurredAt: '2026-10-30T09:00:00.000+00:00',
          monotonicMs: 1,
          delivery: 'required',
          payload: { type: 'incident', level: 'warn', message: 'test' },
        },
      ],
    })
    expect(result.status).toBe(200)
  })

  it('reads the state of the other rooms', async () => {
    // The control app displays that panel: read only, and legitimate.
    const result = await asRoom('rooms/statuses', {})
    expect(result.status).toBe(200)
    expect((result.body.json as unknown as unknown[]).length).toBe(3)
  })

  it('sets its own OBS configuration', async () => {
    // What is observed in front of the machines is entered in front of the
    // machines: both instances' addresses and the real scene names.
    const result = await asRoom('rooms/configure', {
      obs: {
        A: { url: 'ws://192.168.1.20:4455', password: 'secret-a' },
        B: { url: 'ws://192.168.1.21:4455', password: null },
      },
      sceneRoles: { A: { LIVE: 'Direct', HOLD: 'Habillage' }, B: { TALK: 'Talk' } },
      displayPort: 7799,
    })

    expect(result.status).toBe(200)
    const room = hub.services.rooms.get(TRACK_1)!
    expect(room.obs.A).toEqual({ url: 'ws://192.168.1.20:4455', password: 'secret-a' })
    expect(room.sceneRoles.A.LIVE).toBe('Direct')
    expect(room.displayPort).toBe(7799)
  })

  it('keeps the password it did not send back', async () => {
    // The control app never receives the password in clear, so it cannot send it
    // back to keep it: without this rule, fixing a port would erase the password
    // along the way.
    await asRoom('rooms/configure', {
      obs: { A: { url: 'ws://a:4455', password: 'secret-a' }, B: { url: 'ws://b:4455', password: null } },
    })
    await asRoom('rooms/configure', {
      obs: { A: { url: 'ws://a:9999' }, B: { url: 'ws://b:4455' } },
    })

    const room = hub.services.rooms.get(TRACK_1)!
    expect(room.obs.A).toEqual({ url: 'ws://a:9999', password: 'secret-a' })
  })

  it('erases a password when it asks for it', async () => {
    await asRoom('rooms/configure', {
      obs: { A: { url: 'ws://a:4455', password: 'secret-a' }, B: { url: 'ws://b:4455', password: null } },
    })
    await asRoom('rooms/configure', {
      obs: { A: { url: 'ws://a:4455', password: null }, B: { url: 'ws://b:4455' } },
    })

    expect(hub.services.rooms.get(TRACK_1)!.obs.A.password).toBeNull()
  })

  it('drives the lifecycle of its own talks', async () => {
    const session = hub.services.programs
      .active()!
      .program.sessions.find((s) => s.roomId === TRACK_1)!

    const started = await asRoom('sessions/start', { sessionId: session.id })
    expect(started.status).toBe(200)
    // The decision is traced in the room's name, not an operator's.
    expect(hub.services.sessions.get(session.id)?.decidedBy).toBe(`salle:${TRACK_1}`)
  })
})

describe('what a room cannot do', () => {
  const asRoom = (path: string, input: unknown) => rpc(path, input, roomToken)

  it('does not import a program', async () => {
    const result = await asRoom('program/import', { sourceUrl: 'https://exemple/x.json' })
    expect(result.status).toBe(403)
  })

  it('does not moderate the wall', async () => {
    expect((await asRoom('wall/pending', {})).status).toBe(403)
    expect((await asRoom('wall/moderate', { id: 'x', decision: 'approve' })).status).toBe(403)
  })

  it('neither pairs nor revokes a machine', async () => {
    expect((await asRoom('devices/pending', {})).status).toBe(403)
    expect((await asRoom('devices/revoke', { clientId: CLIENT_ID })).status).toBe(403)
  })

  it('does not put a banner on air', async () => {
    // What leaves there goes into the live stream and the VOD of every targeted
    // room: it is an organization decision, not a room's.
    expect((await asRoom('overlay/show', {
      roomId: null,
      message: { text: 'coucou', level: 'info' },
    })).status).toBe(403)
    expect((await asRoom('overlay/history', {})).status).toBe(403)
  })

  it('does not change the hub settings', async () => {
    expect((await asRoom('settings/update', { autoEndGraceMinutes: 60 })).status).toBe(403)
  })

  it('does not rename itself nor give itself a stream key', async () => {
    // Those keys are not in the accepted patch: zod discards them, the call
    // succeeds, and nothing that is not offered moves. The identity comes from
    // the program, the stream key comes down from the hub.
    const before = hub.services.rooms.get(TRACK_1)!
    const result = await asRoom('rooms/configure', {
      name: 'Salle pirate',
      trackId: 'autre-track',
      stream: { rtmpUrl: 'rtmp://ailleurs/live', streamKey: 'volée' },
      displayPort: 7999,
    })

    expect(result.status).toBe(200)
    const after = hub.services.rooms.get(TRACK_1)!
    expect(after.name).toBe(before.name)
    expect(after.trackId).toBe(before.trackId)
    expect(after.stream).toBeNull()
    // What is offered, on the other hand, does apply.
    expect(after.displayPort).toBe(7999)
  })

  it('does not configure another room', async () => {
    // There exists no form of this call that targets elsewhere: the target is the
    // token, not the input.
    await asRoom('rooms/configure', { displayPort: 7999 })

    expect(hub.services.rooms.get(TRACK_2)!.displayPort).toBe(7788)
  })

  it('does not declare itself an inconsistent relay', async () => {
    const itself = await asRoom('rooms/configure', { relaySourceRoomId: TRACK_1 })
    expect(itself.status).toBe(400)

    const unknown = await asRoom('rooms/configure', { relaySourceRoomId: 'track-9-inexistante' })
    expect(unknown.status).toBe(400)
  })

  it('does not decide for another room', async () => {
    const session = hub.services.programs
      .active()!
      .program.sessions.find((s) => s.roomId === TRACK_2)!

    const result = await asRoom('sessions/start', { sessionId: session.id })
    expect(result.status).toBe(403)
  })

  it('only sees its own talk states', async () => {
    const own = hub.services.programs.active()!.program.sessions.find((s) => s.roomId === TRACK_1)!
    const other = hub.services.programs.active()!.program.sessions.find((s) => s.roomId === TRACK_2)!
    hub.services.sessions.start(own.id, TRACK_1, 'op')
    hub.services.sessions.start(other.id, TRACK_2, 'op')

    // Even when explicitly asking for the other room.
    const result = await asRoom('sessions/states', { roomId: TRACK_2 })
    const states = result.body.json as unknown as { sessionId: string }[]
    expect(states.map((e) => e.sessionId)).toEqual([own.id])
  })
})

describe('revocation', () => {
  it('cuts the machine\'s token immediately', async () => {
    expect((await rpc('rooms/sync', { since: null }, roomToken)).status).toBe(200)

    hub.services.devices.revoke(CLIENT_ID)

    const after = await rpc('rooms/sync', { since: null }, roomToken)
    expect(after.status).toBe(401)
  })

  it('does not accept a made-up token', async () => {
    expect((await rpc('rooms/sync', { since: null }, 'rt_inventé')).status).toBe(401)
  })

  it('does not store the token in clear', () => {
    // A leak of the database must not make the rooms impersonatable.
    const machines = hub.services.devices.list()
    expect(machines[0]?.tokenHash).not.toBe(roomToken)
    expect(machines[0]?.tokenHash).toMatch(/^[0-9a-f]{64}$/)
  })
})

/**
 * Shipping the rushes back: who is allowed to do what.
 *
 * The stake fits in one sentence: the hub holds the storage's keys, and nothing
 * it sends down to a room must allow doing anything with them other than
 * depositing *its* files. A room machine lives in a corridor, on an event
 * network, switched on all day in front of two hundred people.
 */
describe('uploading the rushes', () => {
  const asRoom = (path: string, input: unknown) => rpc(path, input, roomToken)
  const asConsole = (path: string, input: unknown) => rpc(path, input, operatorToken)

  it('answers "not configured" rather than failing, on a hub with no storage', async () => {
    // The normal case: an event hub does not necessarily have a bucket. The
    // console must be able to display that rather than open a dead panel.
    const status = await asConsole('vod/status', {})
    expect(status.status).toBe(200)
    expect((status.body.json as unknown as { configure: boolean }).configure).toBe(false)

    // And everything else refuses flatly, saying what to fill in.
    const attempt = await asRoom('vod/begin', {
      file: 'rush.mkv',
      sizeBytes: 10,
      kind: 'rush',
      sessionId: null,
    })
    expect(attempt.status).toBe(501)
  })

  it('closes the connection check to a room', async () => {
    // It writes at the storage, even a few bytes it erases afterwards: it is an
    // operations gesture, not something a room machine has to trigger.
    expect((await asRoom('vod/check', {})).status).toBe(403)
  })

  it('closes reading the storage to a room', async () => {
    // `status` carries the storage's address and its settings: it is a property of
    // the event, not something a room has to know.
    expect((await asRoom('vod/status', {})).status).toBe(403)
    // Same for asking *another* room to upload.
    expect((await asRoom('vod/request', { roomId: TRACK_2, file: null })).status).toBe(403)
  })

  it('does not let a room see another one\'s uploads', async () => {
    // The input `roomId` is ignored for a room: it comes from the token. Without
    // that, a room token would give a view of the whole event.
    const result = await asRoom('vod/uploads', { roomId: TRACK_2 })
    expect(result.status).toBe(501)
  })

  it('refuses a console request for a room that does not exist', async () => {
    const result = await asConsole('vod/request', { roomId: 'salle-fantome', file: null })
    // 501 for as long as no storage is mounted: the feature comes before the
    // target, and saying "unknown room" on a hub with no S3 would send one looking
    // in the wrong place.
    expect(result.status).toBe(501)
  })

  it('opens the storage setting to the console only', async () => {
    expect((await asRoom('settings/update', { vodBucket: 'pirate' })).status).toBe(403)
    expect((await asConsole('settings/update', { vodBucket: 'rushes' })).status).toBe(200)
  })
})

/**
 * The mobile control app, and what its lock guards.
 *
 * The question is not "who can drive" but **where the lock stops**. It holds
 * `regie.command` and nothing else: the console keeps its gestures, and a room
 * machine does not come through here at all. A lock spilling over onto
 * `sessions.start` would hamstring the console; a lock that did not hold
 * `regie.command` would be of no use.
 */
describe('mobile control app: what the lock guards', () => {
  /** The first operator's tab, and that of a second device. */
  const PHONE = 'session-telephone'
  const TABLET = 'session-tablette'

  const asRoom = (path: string, input: unknown) =>
    rpc(path, input, roomToken, undefined, PHONE)
  const asConsole = (path: string, input: unknown) =>
    rpc(path, input, operatorToken, undefined, PHONE)

  it('opens no mobile control procedure to a room machine', async () => {
    // A room acts in its own name, not in an operator's: `regie.*` describes what
    // a human decides from a phone.
    expect((await asRoom('regie/locks', {})).status).toBe(403)
    expect((await asRoom('regie/hold', { roomId: TRACK_1 })).status).toBe(403)
    expect((await asRoom('regie/view', { roomId: TRACK_1 })).status).toBe(403)
    expect(
      (await asRoom('regie/command', { roomId: TRACK_1, action: { type: 'scene.set', role: 'LIVE' } }))
        .status,
    ).toBe(403)
  })

  it('refuses a gesture while nobody holds the room', async () => {
    const result = await asConsole('regie/command', {
      roomId: TRACK_1,
      action: { type: 'scene.set', role: 'LIVE' },
    })
    expect(result.status).toBe(403)
    // The message tells "nobody holds it" from "somebody else holds it": the
    // first is repaired with one click, the second calls for a decision.
    expect(JSON.stringify(result.body)).toContain('Prenez la salle')
  })

  it('accepts the holder\'s gesture, and theirs only', async () => {
    expect((await asConsole('regie/hold', { roomId: TRACK_1 })).status).toBe(200)
    expect(
      (await asConsole('regie/command', {
        roomId: TRACK_1,
        action: { type: 'scene.set', role: 'LIVE' },
      })).status,
    ).toBe(200)

    // A second operator, on the same room: read only.
    await provisionOperator(hub.auth, {
      email: 'second@cloudnord.fr',
      name: 'Second',
      password: 'motdepasse-second-2026',
    })
    const signIn = await fetch(`${origin}/api/auth/sign-in/email`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'second@cloudnord.fr', password: 'motdepasse-second-2026' }),
    })
    const secondToken = ((await signIn.json()) as { token: string }).token

    const refusal = await rpc(
      'regie/command',
      { roomId: TRACK_1, action: { type: 'scene.set', role: 'HOLD' } },
      secondToken,
      undefined,
      TABLET,
    )
    expect(refusal.status).toBe(403)
    // The holder is named: "refused" without saying by whom sends one looking for
    // a defect where there is only a colleague at the other end of the building.
    expect(JSON.stringify(refusal.body)).toContain(OPERATOR.email)

    // Reading, on the other hand, stays open: one looks at a room without taking
    // it.
    expect(
      (await rpc('regie/view', { roomId: TRACK_1 }, secondToken, undefined, TABLET)).status,
    ).toBe(200)

    // And taking over does go through — under confirmation on the page side.
    expect(
      (await rpc('regie/hold', { roomId: TRACK_1, force: true }, secondToken, undefined, TABLET))
        .status,
    ).toBe(200)
    expect(
      (await rpc(
        'regie/command',
        { roomId: TRACK_1, action: { type: 'scene.set', role: 'HOLD' } },
        secondToken,
        undefined,
        TABLET,
      )).status,
    ).toBe(200)
  })

  it('refuses to take a room without saying which tab is speaking', async () => {
    /*
     * Demanded rather than derived from the account.
     *
     * Falling back on the address in the absence of a header would degrade the
     * exclusivity silently: two tabs of the same person would each believe
     * themselves the holder, and one would only find out the day they switch the
     * same room in opposite directions.
     */
    const withoutHeader = await rpc('regie/hold', { roomId: TRACK_1 }, operatorToken)
    expect(withoutHeader.status).toBe(400)
    expect(JSON.stringify(withoutHeader.body)).toContain('x-regie-session')
  })

  it('excludes a second tab of the same operator', async () => {
    expect((await asConsole('regie/hold', { roomId: TRACK_1 })).status).toBe(200)

    // Same account, another device: refused like anybody else, and the message
    // names the holder — who happens to be oneself.
    const tablet = await rpc(
      'regie/hold',
      { roomId: TRACK_1, force: false },
      operatorToken,
      undefined,
      TABLET,
    )
    expect(tablet.status).toBe(409)

    const gesture = await rpc(
      'regie/command',
      { roomId: TRACK_1, action: { type: 'scene.set', role: 'LIVE' } },
      operatorToken,
      undefined,
      TABLET,
    )
    expect(gesture.status).toBe(403)
  })

  it('does not hamstring the console: the lifecycle stays open outside the lock', async () => {
    /*
     * The lock must not spill outside its surface.
     *
     * `sessions.start` is the gesture of the console and of the room's control
     * app; closing it because a phone holds the room would make the organizer
     * depend on a tab open somewhere.
     */
    await asConsole('regie/hold', { roomId: TRACK_1 })
    const slot = hub.services.programs
      .active()!
      .program.sessions.find((session) => session.roomId === TRACK_2 && session.kind === 'talk')!
    expect((await asConsole('sessions/start', { sessionId: slot.id })).status).toBe(200)
  })

  it('does not hamstring the room: it decides on its talks even under a lock', async () => {
    // The operator who is physically there must never depend on a phone that has
    // gone off down a corridor.
    await asConsole('regie/hold', { roomId: TRACK_1 })
    const slot = hub.services.programs
      .active()!
      .program.sessions.find((session) => session.roomId === TRACK_1 && session.kind === 'talk')!
    expect((await asRoom('sessions/start', { sessionId: slot.id })).status).toBe(200)
  })
})
