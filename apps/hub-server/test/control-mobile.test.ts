import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { CONTROL_LOCK_TTL_MS, CONTROL_COMMAND_TTL } from '@cloudnord/contract'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createHub, type Hub } from '../src/server.js'
import { provisionOperator } from '../src/operators.js'
import { controlCommand, controlView } from '../src/services/control.js'

/**
 * The mobile control app, seen from the hub.
 *
 * What is checked here is not "the lock exists" but the four properties its use
 * depends on on an event day: it expires on its own, it can be taken over, it
 * does not chatter, and a gesture leaves with the lifetime that suits it. The
 * rights themselves live in `rights.test.ts`.
 *
 * `services.regie` keeps its name: it mirrors the contract namespace `regie.*`.
 */

const rawProgram = readFileSync(
  fileURLToPath(new URL('../../../packages/program/test/fixtures/cloudnord-2026.json', import.meta.url)),
  'utf8',
)

const OPERATOR = { email: 'regie@cloudnord.fr', name: 'Régie', password: 'control-password-2026' }
const OTHER = { email: 'nuit@cloudnord.fr', name: 'Nuit', password: 'night-password-2026' }
const TRACK_1 = 'track-1-teilhard-de-chardin'

/**
 * Two tabs, and it is the distinction that counts.
 *
 * The lock carries a session, not an account: the phone in the pocket and the
 * tablet on the table belong to the same person and must not drive the same room
 * each believing itself alone.
 */
const PHONE = 'session-phone'
const TABLET = 'session-tablet'

let hub: Hub

/** What the room has received since the beginning, in order. */
function commands(roomId = TRACK_1) {
  return hub.services.commands.backlog(roomId, 0)
}

/**
 * Pushes the hub's clock, the way the Development tab does.
 *
 * It is the only honest way to age a lock: it has no deadline column, its
 * expiration is computed at read time against the hub's clock. Rewriting the row
 * in the database would test a mechanism that does not exist.
 */
function advanceBy(ms: number): void {
  hub.services.clock.setSimulated(new Date(hub.services.clock.now() + ms).toISOString())
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
  await provisionOperator(hub.auth, OPERATOR)
  await provisionOperator(hub.auth, OTHER)
  const snapshot = hub.services.programs.importFromText(rawProgram, 'https://exemple/programme.json')
  hub.services.rooms.ensureFromTracks(snapshot.program.rooms)
})

afterEach(async () => {
  await hub.close()
})

describe('the lock', () => {
  it('goes to whoever takes it, and refuses the next one by name', () => {
    const lock = hub.services.regie.hold(TRACK_1, OPERATOR.email, PHONE, false)
    expect(lock.holder).toBe(OPERATOR.email)

    expect(() => hub.services.regie.hold(TRACK_1, OTHER.email, TABLET, false)).toThrow(OPERATOR.email)
  })

  it('keeps "since when" on renewal, and resets it on takeover', async () => {
    /*
     * It is that number the other operator reads before deciding whether to take
     * over. Rewritten on every beat, it would show "since 1 second" all day long
     * — and would answer nothing any more.
     */
    const first = hub.services.regie.hold(TRACK_1, OPERATOR.email, PHONE, false)
    await new Promise((r) => setTimeout(r, 5))
    const renewed = hub.services.regie.hold(TRACK_1, OPERATOR.email, PHONE, false)
    expect(renewed.heldSince).toBe(first.heldSince)
    expect(Date.parse(renewed.lastSeenAt)).toBeGreaterThanOrEqual(Date.parse(first.lastSeenAt))

    const takenOver = hub.services.regie.hold(TRACK_1, OTHER.email, TABLET, true)
    expect(takenOver.holder).toBe(OTHER.email)
    expect(takenOver.heldSince).not.toBe(first.heldSince)
  })

  it('is no longer returned past its deadline, even before the sweep', async () => {
    /*
     * Expiration is computed at read time, and that is what is authoritative. A
     * sweep that decided would leave a dead lock enforceable for the fifteen
     * seconds that separate it from the next turn.
     */
    hub.services.regie.hold(TRACK_1, OPERATOR.email, PHONE, false)
    advanceBy(CONTROL_LOCK_TTL_MS + 1_000)

    expect(hub.services.regie.lock(TRACK_1)).toBeNull()
    // And the room becomes takeable again without forcing.
    expect(hub.services.regie.hold(TRACK_1, OTHER.email, TABLET, false).holder).toBe(OTHER.email)
  })

  it('excludes a second tab of the same operator', () => {
    /*
     * The case that motivated the session rather than the account.
     *
     * The same person opens the control app on their phone then on a tablet. On
     * the account, both believed themselves the holder and drove the room
     * ignoring each other — two contradictory scene switches, and no screen to
     * say so. On the session, the second is refused like anybody else.
     */
    hub.services.regie.hold(TRACK_1, OPERATOR.email, PHONE, false)
    expect(() => hub.services.regie.hold(TRACK_1, OPERATOR.email, TABLET, false)).toThrow(
      OPERATOR.email,
    )

    // And taking over works between tabs of the same person, as between two
    // people: it is the same gesture, with the same question asked.
    const takenOver = hub.services.regie.hold(TRACK_1, OPERATOR.email, TABLET, true)
    expect(takenOver.holderId).toBe(TABLET)
    expect(takenOver.holder).toBe(OPERATOR.email)
  })

  it('does not let one tab release the room the other holds', () => {
    // Closing the first tab must not dispossess the second, which is driving.
    hub.services.regie.hold(TRACK_1, OPERATOR.email, PHONE, false)
    hub.services.regie.hold(TRACK_1, OPERATOR.email, TABLET, true)
    expect(hub.services.regie.release(TRACK_1, PHONE)).toBe(false)
    expect(hub.services.regie.lock(TRACK_1)?.holderId).toBe(TABLET)
  })

  it('is released by its holder only', () => {
    hub.services.regie.hold(TRACK_1, OPERATOR.email, PHONE, false)
    expect(hub.services.regie.release(TRACK_1, TABLET)).toBe(false)
    expect(hub.services.regie.lock(TRACK_1)?.holder).toBe(OPERATOR.email)
    expect(hub.services.regie.release(TRACK_1, PHONE)).toBe(true)
    expect(hub.services.regie.lock(TRACK_1)).toBeNull()
  })

  it('sweeps what has expired, and names the rooms it released', () => {
    hub.services.regie.hold(TRACK_1, OPERATOR.email, PHONE, false)
    expect(hub.services.regie.sweep()).toEqual([])

    advanceBy(CONTROL_LOCK_TTL_MS + 1_000)
    // The returned list is what decides which rooms see their badge go out:
    // without it, the control screen would keep a holder who has left.
    expect(hub.services.regie.sweep()).toEqual([TRACK_1])
  })
})

describe('what the room receives', () => {
  it('a change of holder, never a heartbeat', () => {
    hub.services.regie.hold(TRACK_1, OPERATOR.email, PHONE, false)
    hub.services.commands.publish(TRACK_1, { type: 'regie.hold', holder: OPERATOR.email }, null)

    // A hundred beats: the router only publishes on a change, and that is what
    // stops the command table from taking one row per second per held room.
    for (let index = 0; index < 100; index += 1) {
      hub.services.regie.hold(TRACK_1, OPERATOR.email, PHONE, false)
    }

    expect(commands().filter((c) => c.payload.type === 'regie.hold')).toHaveLength(1)
  })

  it('a scene switch that expires faster than a recording', () => {
    hub.services.regie.hold(TRACK_1, OPERATOR.email, PHONE, false)
    hub.services.commands.publish(
      TRACK_1,
      { type: 'scene.force', role: 'LIVE', requestedBy: OPERATOR.email },
      CONTROL_COMMAND_TTL['scene.force'],
    )
    hub.services.commands.publish(
      TRACK_1,
      { type: 'recording.set', on: true, requestedBy: OPERATOR.email },
      CONTROL_COMMAND_TTL['recording.set'],
    )

    const scene = commands().find((c) => c.payload.type === 'scene.force')
    const capture = commands().find((c) => c.payload.type === 'recording.set')

    /*
     * The two lifetimes are not equal, and the gap is the rule: a switch caught
     * up ten minutes later puts the room on air on nothing, where a capture can
     * still catch up a one-minute outage.
     */
    expect(scene?.ttlSeconds).toBe(30)
    expect(capture?.ttlSeconds).toBe(90)
    expect(scene!.ttlSeconds!).toBeLessThan(capture!.ttlSeconds!)
  })

  it('a room screen, which expires like a scene switch', () => {
    hub.services.regie.hold(TRACK_1, OPERATOR.email, PHONE, false)
    const outcome = controlCommand(
      hub.services,
      TRACK_1,
      { type: 'display.set', mode: 'sponsors' },
      OPERATOR.email,
    )

    /*
     * `queued`, and not `now`: the hub has queued the command, nothing more.
     * That the screen has switched is read on the next view — the same
     * distinction as for the capture, and it is what stops a phone from believing
     * a gesture done because a call answered 200.
     */
    expect(outcome.applied).toBe('queued')

    const screen = commands().find((c) => c.payload.type === 'display.set')
    expect(screen?.payload).toMatchObject({ mode: 'sponsors', sessionId: null })
    /*
     * The same lifetime as a scene: it is also what the audience sees. A "rate
     * the talk" caught up in the middle of the next one is the wrong screen in
     * front of the wrong people.
     */
    expect(screen?.ttlSeconds).toBe(CONTROL_COMMAND_TTL['display.set'])
    expect(screen?.ttlSeconds).toBe(CONTROL_COMMAND_TTL['scene.force'])
  })

  it('who asked for the gesture, so that the room control app can say it', () => {
    hub.services.commands.publish(
      TRACK_1,
      { type: 'recording.set', on: true, requestedBy: OPERATOR.email },
      CONTROL_COMMAND_TTL['recording.set'],
    )
    const command = commands().find((c) => c.payload.type === 'recording.set')
    // Without that name, a recording that starts on its own reads as an OBS
    // failure — and one goes looking for it where it is not.
    expect(command?.payload).toMatchObject({ requestedBy: OPERATOR.email })
  })
})

describe('the view', () => {
  it('aims at the talk to drive, not at the current slot', () => {
    const at = Date.parse('2026-10-30T10:20:00.000Z')
    const rendered = controlView(hub.services, TRACK_1, at)

    // The same rule the room's control app follows: `talkToControl`.
    expect(rendered.targetSession?.kind).toBe('talk')
    expect(rendered.roomId).toBe(TRACK_1)
    // The hub's time travels with the view: the browser only has its own, and the
    // hub's can be simulated.
    expect(Date.parse(rendered.serverTime)).toBe(at)
  })

  it('offers only the scene roles the room has actually mapped', () => {
    const view = controlView(hub.services, TRACK_1, Date.now())
    // The defaults of an auto-provisioned room: LIVE and HOLD, not RELAY.
    expect(view.sceneRoles).toContain('LIVE')
    expect(view.sceneRoles).toContain('HOLD')
    expect(view.sceneRoles).not.toContain('RELAY')
  })

  it('returns the screen the room reported, and nothing while it stays silent', () => {
    // No room has beaten: the hub does not know what is displayed, and saying so
    // is fairer than lighting up "Loop" on a guess.
    expect(controlView(hub.services, TRACK_1, Date.now()).displayMode).toBeNull()

    hub.services.ingest.push(TRACK_1, [
      {
        id: '01FFFFFFFFFFFFFFFFFFFFFFFF',
        roomId: TRACK_1,
        seq: 1,
        occurredAt: '2026-10-30T09:00:00.000+00:00',
        monotonicMs: 1000,
        delivery: 'best-effort',
        payload: {
          type: 'room.heartbeat',
          connectivity: 'ONLINE',
          sceneRole: 'HOLD',
          recording: true,
          streaming: false,
          outboxDepth: 0,
          programContentHash: null,
          displayMode: 'feedback',
        },
      },
    ])

    const view = controlView(hub.services, TRACK_1, Date.now())
    expect(view.displayMode).toBe('feedback')
    /*
     * The capture with it, and that is the heart of the matter: it only comes
     * back through the heartbeat when it is started from OBS, and the heartbeat
     * read it on the wrong instance. An indicator switched off on a room that is
     * recording is the worse of the two possible lies.
     */
    expect(view.recording).toBe(true)
  })

  it('refuses an unknown room rather than returning an empty view', () => {
    // A `/regie/<id>` address gets bookmarked and shared: an identifier that no
    // longer designates anything must say so, not read as a room switched off.
    expect(() => controlView(hub.services, 'ghost-room', Date.now())).toThrow('Salle inconnue')
  })
})
