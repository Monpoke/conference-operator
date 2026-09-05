import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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
const TRACK_1 = 'track-1-teilhard-de-chardin'
/** 10:20 UTC: "HoneySwamp" runs from 10:00 to 10:50. */
const DURING_THE_TALK = Date.parse('2026-10-30T10:20:00.000Z')
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

let hub: Hub
let origin: string
let dir: string
let room: RoomApp
let control: string

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'cloudnord-cycle-'))
  hub = await createHub({
    port: 0,
    host: '127.0.0.1',
    databasePath: ':memory:',
    publicUrl: 'http://127.0.0.1',
    authSecret: 'test-secret-'.padEnd(48, 'x'),
    logLevel: 'fatal',
    devicePollInterval: '1s',
    /**
     * The instant is simulated **on the hub**, not in the room.
     *
     * A clock set in the room would be replaced at the first synchronisation: the
     * hub is authoritative, the room measures its offset against it. This test
     * used to simulate its own time and only held thanks to an offset computed
     * wrongly — the very one that left the control app with no talk to drive under
     * a simulated clock.
     */
    mode: 'dev',
    simulatedTime: new Date(DURING_THE_TALK).toISOString(),
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
    // Room known up front: these tests have no screen to choose it on.
    roomId: TRACK_1,
    displayPort: 0,
    obsTransportFactory: (instance) =>
      createMockObsTransport({ instance, recordingDir: join(dir, 'rec') }),
    readToken: () => token,
    writeToken: (value) => {
      token = value
    },
    onPairingCode: (code) => {
      void (async () => {
        const response = await fetch(`${origin}/api/auth/sign-in/email`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ email: OPERATOR.email, password: OPERATOR.password }),
        })
        const session = (await response.json()) as { token: string }
        const admin: ContractRouterClient<typeof contract> = createORPCClient(
          new RPCLink({ origin, url: '/rpc', headers: () => ({ authorization: `Bearer ${session.token}` }) }),
        )
        await admin.devices.approve({ userCode: code.user_code, clientId: CLIENT_ID, roomId: TRACK_1 })
      })()
    },
  })

  control = await room.startDisplay()
  const paired = await room.ensurePaired()
  await room.connectHub(paired!)
  await room.connectObs()
  room.runtime.refreshSessions()
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
const view = async () => (await (await fetch(`${control}/display/data`)).json()) as DisplayPayload

/**
 * Measures the delay between a decision and its arrival in the control app's
 * **stream**.
 *
 * The stream, and not `/display/data`: the latter reads everything back on every
 * call and therefore answers correctly even when nothing is pushed. That is
 * precisely what masked the defect — the other rooms' view refreshed in memory
 * with nobody being woken up.
 *
 * The subscription opens **before** `action`, and the stopwatch only starts
 * afterwards: measuring from the opening would count the time we allow the room
 * to fall silent, and the delay would no longer mean anything.
 */
async function delayInStream(
  condition: (view: Record<string, unknown>) => boolean,
  action: () => Promise<void>,
  limitMs: number,
): Promise<number | null> {
  const aborter = new AbortController()
  const response = await fetch(`${control}/display/state?vue=regie`, { signal: aborter.signal })
  const reader = response.body!.getReader()

  // Nothing is read during that time: what arrives piles up, and will be read
  // back afterwards without satisfying the condition — the change has not happened yet.
  await action()

  const startedAt = Date.now()
  const timer = setTimeout(() => aborter.abort(), limitMs)
  const decoder = new TextDecoder()
  let current: Record<string, unknown> = {}
  let buffer = ''
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) return null
      buffer += decoder.decode(value, { stream: true })

      let cut: number
      while ((cut = buffer.indexOf('\n\n')) !== -1) {
        const block = buffer.slice(0, cut)
        buffer = buffer.slice(cut + 2)
        const lines = block.split('\n')
        const data = lines.find((line) => line.startsWith('data: '))
        if (data == null) continue
        const raw = JSON.parse(data.slice(6)) as Record<string, unknown>
        current = lines.includes('event: delta') ? { ...current, ...raw } : raw
        if (condition(current)) return Date.now() - startedAt
      }
    }
  } catch {
    // Given up on a timeout: the condition never came.
    return null
  } finally {
    clearTimeout(timer)
    aborter.abort()
  }
}

/** A room's state in the supervision view the control app receives. */
function roomInStream(view: Record<string, unknown>, roomId: string): { conference?: string } | null {
  const diagnostics = view.diagnostics as { rooms?: { roomId: string; conference?: string }[] } | null
  return diagnostics?.rooms?.find((candidate) => candidate.roomId === roomId) ?? null
}

/** Operator client: what the console holds once connected. */
async function operatorClient(): Promise<ContractRouterClient<typeof contract>> {
  const response = await fetch(`${origin}/api/auth/sign-in/email`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: OPERATOR.email, password: OPERATOR.password }),
  })
  const session = (await response.json()) as { token: string }
  return createORPCClient(
    new RPCLink({ origin, url: '/rpc', headers: () => ({ authorization: `Bearer ${session.token}` }) }),
  )
}

describe('lifecycle driven from the control app', () => {
  it('starts and ends the running talk', async () => {
    const session = room.runtime.state().currentSession!
    expect(session.title).toContain('HoneySwamp')

    expect((await act({ action: 'session.start' })).body.ok).toBe(true)
    expect((await view()).state.sessionStates[session.id]).toBe('running')
    // The decision is visible on the hub side: that is where it counts for the console.
    expect(hub.services.sessions.get(session.id)?.status).toBe('running')

    expect((await act({ action: 'session.end' })).body.ok).toBe(true)
    expect((await view()).state.sessionStates[session.id]).toBe('ended')
  }, 40_000)

  it('receives a decision made from the console', async () => {
    const session = room.runtime.state().currentSession!
    hub.services.sessions.start(session.id, TRACK_1, 'organisateur@cloudnord.fr')
    hub.services.commands.publish(
      TRACK_1,
      {
        type: 'session.state',
        sessionId: session.id,
        roomId: TRACK_1,
        sessionTitle: session.title,
        status: 'running',
        decidedBy: 'organisateur@cloudnord.fr',
      },
      null,
    )
    await sleep(500)

    // A talk can overrun with no room operator available.
    expect((await view()).state.sessionStates[session.id]).toBe('running')
  }, 40_000)

  it('receives an automatic close and shows it as such', async () => {
    const session = room.runtime.state().currentSession!
    await act({ action: 'session.start' })
    expect((await view()).state.sessionStates[session.id]).toBe('running')

    // The scheduling *rule* is checked in the hub's tests, with a simulated
    // clock. Here we check the wire: what the rule decides does reach the room,
    // and is told apart there from a human decision.
    const ended = hub.services.sessions.end(session.id, TRACK_1, 'auto')
    hub.services.commands.publish(
      TRACK_1,
      {
        type: 'session.state',
        sessionId: session.id,
        roomId: TRACK_1,
        sessionTitle: session.title,
        status: 'ended',
        decidedBy: 'auto',
      },
      null,
    )
    await sleep(500)

    expect(ended.decidedBy).toBe('auto')
    expect((await view()).state.sessionStates[session.id]).toBe('ended')
  }, 40_000)

  it('aims at the first talk when the day has not started', async () => {
    // Before the event every talk is upcoming: being able to start the first one
    // is useful, not absurd — it is a rehearsal.
    room.runtime.setClockOffset(-400 * 24 * 3600 * 1000)
    room.runtime.refreshSessions()

    expect(room.runtime.state().currentSession).toBeNull()
    expect(room.runtime.state().targetSession?.kind).toBe('talk')
    expect((await act({ action: 'session.start' })).status).toBe(200)
  }, 40_000)

  it('has nothing left to drive once the day is over', async () => {
    // After the last talk there is no target left: there, the refusal is right.
    room.runtime.setClockOffset(Date.parse('2026-10-31T12:00:00Z') - Date.now())
    room.runtime.refreshSessions()

    expect(room.runtime.state().targetSession).toBeNull()
    const result = await act({ action: 'session.start' })
    expect(result.status).toBe(409)
    expect(result.body.message).toContain('Aucune conférence')
  }, 40_000)

  it('exposes the other rooms\' state to the control app', async () => {
    await sleep(300)
    const rooms = (await view()).diagnostics?.rooms ?? []
    // The program's three tracks have become rooms.
    expect(rooms.map((r) => r.roomId).sort()).toEqual(
      ['hands-on', 'track-1-teilhard-de-chardin', 'track-2-mf-1092'],
    )
    expect((await view()).diagnostics?.roomsRefreshedAt).toBeTruthy()
  }, 40_000)
})

describe("simulated time", () => {
  it("lets the hub's take precedence over a local offset", async () => {
    /**
     * The case reported: a room launched with `HEURE_SIMULEE`, connected to a hub
     * also on a simulated clock. The two offsets added up — the control app
     * announced "aucune conférence à piloter" while the other rooms' stream,
     * computed in the page, came out right.
     */
    room.runtime.setClockOffset(Date.parse('2026-11-30T10:20:00.000Z') - Date.now(), true)
    expect(room.runtime.state().currentSession).toBeNull()

    await room.resync()

    expect(room.runtime.state().currentSession?.title).toContain('HoneySwamp')
    // And the pages see the same instant: all they have is their own `Date.now()`.
    const seenByAPage = Date.now() + room.runtime.state().serverTimeOffsetMs
    expect(Math.abs(seenByAPage - room.runtime.correctedNow())).toBeLessThan(100)
  }, 40_000)

  it("cancels, in the control app, decisions made later in the day", async () => {
    /**
     * The case reported: one tries out the day, starts "HoneySwamp" at 10:20, then
     * winds the clock back to 08:38 to pick up in the morning. The control app kept
     * "en cours" and ran two hours of countdown on a talk nobody had started — the
     * state came from a day that had not happened yet.
     */
    const session = room.runtime.state().currentSession!
    await act({ action: 'session.start' })
    expect((await view()).state.sessionStates[session.id]).toBe('running')

    const admin = await operatorClient()
    await admin.clock.set({ at: '2026-10-30T07:38:00.000Z' })
    await sleep(600)

    // The hub no longer applies the decision…
    expect(hub.services.sessions.get(session.id)).toBeNull()
    // …and neither does the room: it reads the lifecycle back when the time moves.
    const payload = await view()
    expect(payload.state.sessionStates[session.id]).toBeUndefined()
    // And the control app goes back to the morning: the next talk, not started yet.
    expect(payload.state.currentSession?.id).not.toBe(session.id)
    expect(payload.state.targetSession?.startsAtMs).toBeGreaterThan(
      Date.parse('2026-10-30T07:38:00.000Z'),
    )
    expect(payload.state.targetIsUpcoming).toBe(true)
  }, 40_000)
})

/**
 * Resynchronisation requested from the console.
 *
 * The only recourse before was to restart the room machine — so to cut its take,
 * at the exact moment one notices it has drifted.
 */
describe('full resynchronisation', () => {
  it("reads everything back on the console's request, without cutting the room", async () => {
    const admin = await operatorClient()
    const before = room.runtime.state().recording

    await admin.rooms.resync({ roomId: TRACK_1 })
    await sleep(800)

    const payload = await view()
    const texts = payload.state.notifications.map((n) => n.text)
    // Reported in the control app: a room that starts downloading its program
    // again with nobody having asked for it on site reads as an incident.
    expect(texts.some((t) => t.includes(OPERATOR.email))).toBe(true)
    expect(texts).toContain('Resynchronisation complète terminée')

    // Nothing was cut: that is the whole point of the gesture.
    expect(payload.state.recording).toBe(before)
    expect(payload.pairing?.status).toBe('paired')
    expect(payload.state.connectivity).toBe('ONLINE')
    // And the room is still on the hub's program.
    expect(room.runtime.state().currentSession?.title).toContain('HoneySwamp')
  }, 40_000)

  it("asks for the whole program again, where an ordinary sync does without", async () => {
    /**
     * That is what tells this gesture from an ordinary `sync`: the sync leans on
     * the fingerprint so as not to re-download 70 KB on every heartbeat, and the
     * cache is exactly what is under suspicion here. The program coming back down
     * is observed by the write to the local database.
     */
    const store = (room as unknown as { store: { saveProgram: (...args: never[]) => void } }).store
    const written = vi.spyOn(store, 'saveProgram')

    // The ordinary sync writes nothing: the fingerprint has not moved.
    await room.resync()
    expect(written).not.toHaveBeenCalled()

    const admin = await operatorClient()
    await admin.rooms.resync({ roomId: null })
    await sleep(800)

    expect(written).toHaveBeenCalled()
    written.mockRestore()
  }, 40_000)
})

/**
 * Slots whose kind is corrected from the console.
 *
 * The upstream export does not tell a lunch from a talk, and the normaliser
 * decides on a single signal: no speaker, therefore a break. The correction must
 * show up *in the room*, otherwise it is of no use where it counts.
 */
describe('a slot\'s kind corrected from the hub', () => {
  it("stops being a talk in the room, without restarting anything", async () => {
    const session = room.runtime.state().currentSession!
    expect(session.title).toContain('HoneySwamp')
    expect(room.runtime.state().targetSession?.id).toBe(session.id)

    const admin = await operatorClient()
    await admin.sessions.override({ sessionId: session.id, action: 'break' })
    // The hub broadcasts `program.invalidate`: the room resynchronises by itself.
    await sleep(1_000)
    room.runtime.refreshSessions()

    const roomState = room.runtime.state()
    // The slot is still running — it occupies the room — but it is no longer a
    // talk: the control app aims at the next one, the one that can be started.
    expect(roomState.currentSession?.id).toBe(session.id)
    expect(roomState.currentSession?.kind).toBe('break')
    expect(roomState.targetSession?.id).not.toBe(session.id)
    expect(roomState.targetSession?.kind).toBe('talk')
    expect(roomState.targetIsUpcoming).toBe(true)

    // And nothing was cut along the way.
    expect(roomState.connectivity).toBe('ONLINE')
    expect((await view()).pairing?.status).toBe('paired')
  }, 40_000)

  it("makes drivable a keynote the export reports as a break", async () => {
    /**
     * The case reported: the opening keynote's speaker is not announced yet, so
     * the export gives it none, so the normaliser makes it a break. The control app
     * had nothing to start, and nothing went on air.
     */
    const admin = await operatorClient()
    const keynote = hub.services.programs
      .active()!
      .program.sessions.find((s) => s.title.includes('Keynote'))!
    expect(keynote.kind).toBe('break')

    await admin.sessions.override({ sessionId: keynote.id, action: 'talk' })
    await sleep(1_000)

    // 08:10 UTC: the keynote runs from 08:00 to 08:45.
    room.runtime.setClockOffset(Date.parse('2026-10-30T08:10:00Z') - Date.now())
    room.runtime.refreshSessions()

    const roomState = room.runtime.state()
    expect(roomState.currentSession?.id).toBe(keynote.id)
    expect(roomState.currentSession?.kind).toBe('talk')
    // It is now the talk the control app drives.
    expect(roomState.targetSession?.id).toBe(keynote.id)
    expect(roomState.targetIsUpcoming).toBe(false)
    expect((await act({ action: 'session.start' })).status).toBe(200)
  }, 40_000)

  it('becomes a talk again when the decision is withdrawn', async () => {
    const session = room.runtime.state().currentSession!
    const admin = await operatorClient()

    await admin.sessions.override({ sessionId: session.id, action: 'break' })
    await sleep(1_000)
    await admin.sessions.override({ sessionId: session.id, action: null })
    await sleep(1_000)
    room.runtime.refreshSessions()

    expect(room.runtime.state().currentSession?.kind).toBe('talk')
    expect(room.runtime.state().targetSession?.id).toBe(session.id)
  }, 40_000)
})

/**
 * What a neighbouring room decides must reach the control app straight away.
 *
 * The decision already arrived pushed on the command stream; only the *view* that
 * displays it was polled, every fifteen seconds — and the polling woke nobody.
 * The control app therefore showed "Track #2 vient de terminer" while Track #2's
 * dot still said "en cours".
 */
describe("the other rooms' state", () => {
  const OTHER = 'track-2-mf-1092'

  /** Track #2's talk running at the simulated instant. */
  const neighbouringTalk = () =>
    hub.services.programs
      .active()!
      .program.sessions.find(
        (s) => s.roomId === OTHER && s.startsAtMs <= DURING_THE_TALK && (s.endsAtMs ?? 0) > DURING_THE_TALK,
      )!

  it('pushes the decision into the stream, without waiting for the poll', async () => {
    const neighbour = neighbouringTalk()
    // Nobody started it: the slot has been running for twenty minutes.
    expect((await view()).diagnostics?.rooms?.find((s) => s.roomId === OTHER)?.conference)
      .toBe('retard')

    const delay = await delayInStream(
      (received) => roomInStream(received, OTHER)?.conference === 'en-cours',
      async () => {
        /**
         * First we let the room fall silent.
         *
         * At start-up its uplink queue is loaded — OBS connection, log — and every
         * drain recomputes the clock offset, which moves the state and carries the
         * rooms' view along with it. That noise would mask what we are measuring.
         * Once the room has settled, only the heartbeat is left, every ten seconds.
         *
         * The duration is not neutral: it places the decision **between** two
         * polls. At 3.5 s the next poll fell 1.4 s later and the test passed owing
         * nothing to the trigger — barely, and by pure coincidence of phase.
         */
        await sleep(5_200)

        hub.services.sessions.start(neighbour.id, OTHER, 'regie-voisine@cloudnord.fr')
        hub.services.commands.publish(
          null,
          {
            type: 'session.state',
            sessionId: neighbour.id,
            roomId: OTHER,
            sessionTitle: neighbour.title,
            status: 'running',
            decidedBy: 'regie-voisine@cloudnord.fr',
          },
          null,
        )
      },
      /**
       * A second and a half, and it is the heart of the test.
       *
       * The broadcast always ends up leaving: the clock offset is recomputed on
       * every drain of the queue and moves the state, which carries the rooms'
       * view along with it. But at the heartbeat's pace — ten seconds — and only
       * after a poll. That delay is what we refuse: under this ceiling, only a push
       * triggered by the command holds. Removing either one makes this test fail.
       */
      1_500,
    )

    expect(delay).not.toBeNull()
  }, 40_000)

  it('re-dates the view on every poll, change or no change', async () => {
    /**
     * The control app only trusts the hub's view if it is fresh — past a minute it
     * falls back on the program, which knows nothing of lateness or overrun. So the
     * timestamp must move forward even when nothing changes, otherwise the view
     * degrades in silence while the hub is answering perfectly well.
     */
    const before = (await view()).diagnostics?.roomsRefreshedAt
    expect(before).toBeTruthy()

    // One poll, and a little margin.
    await sleep(5_500)

    const after = (await view()).diagnostics?.roomsRefreshedAt
    expect(Date.parse(after!)).toBeGreaterThan(Date.parse(before!))
  }, 40_000)
})

describe("credentials refused by the hub", () => {
  it("shows the pairing screen again instead of looping", async () => {
    // The case lived through: the hub's database was recreated, or the machine
    // was revoked. The stored token is worth nothing any more. Retrying forever
    // leads nowhere and teaches the operator nothing.
    expect(room.pairingState().status).toBe('paired')

    hub.services.devices.revoke(CLIENT_ID)
    const result = await room.resync().then(
      () => 'ok',
      (cause: Error) => cause.message,
    )
    expect(result).toContain('injoignable')

    // The control screen now carries the pairing state.
    await sleep(300)
    const payload = await view()
    expect(payload.pairing?.status).not.toBe('paired')
  }, 40_000)

  it("exposes the pairing state to the control app from start-up", async () => {
    const payload = await view()
    // A paired machine must display nothing: the veil only serves the opposite
    // case.
    expect(payload.pairing?.status).toBe('paired')
  }, 40_000)
})

describe('cross-room notifications', () => {
  it("reports the end of a talk in another room without touching its own state", async () => {
    const other = hub.services.programs
      .active()!
      .program.sessions.find((s) => s.roomId === 'track-2-mf-1092' && s.kind === 'talk')!

    hub.services.sessions.start(other.id, 'track-2-mf-1092', 'organisateur')
    hub.services.commands.publish(
      // Broadcast to all: that is what makes the notification possible.
      null,
      {
        type: 'session.state',
        sessionId: other.id,
        roomId: 'track-2-mf-1092',
        sessionTitle: other.title,
        status: 'ended',
        decidedBy: 'auto',
      },
      null,
    )
    await sleep(600)

    const payload = await view()
    const texts = payload.state.notifications.map((n) => n.text)
    expect(texts.some((t) => t.includes(other.title))).toBe(true)

    // Another room's state must not pollute ours.
    expect(payload.state.sessionStates[other.id]).toBeUndefined()
  }, 40_000)

  it("applies a decision concerning its own room as usual", async () => {
    const session = room.runtime.state().currentSession!
    hub.services.sessions.start(session.id, TRACK_1, 'organisateur')
    hub.services.commands.publish(
      null,
      {
        type: 'session.state',
        sessionId: session.id,
        roomId: TRACK_1,
        sessionTitle: session.title,
        status: 'running',
        decidedBy: 'organisateur',
      },
      null,
    )
    await sleep(600)

    const payload = await view()
    expect(payload.state.sessionStates[session.id]).toBe('running')
    // Its own room does not notify itself: the screen already shows it.
    expect(payload.state.notifications).toEqual([])
  }, 40_000)

  it("serves another room's program on request", async () => {
    const response = await fetch(`${control}/display/sessions?salle=track-2-mf-1092`)
    const body = (await response.json()) as {
      sessions: { sharedFrom: string | null }[]
      rooms: unknown[]
    }

    // Nine slots in the export for Track #2, fifteen served: it inherits Track
    // #1's six breaks, which all fall while it is free. That is precisely what the
    // control app comes to read — without it, the neighbouring room looked
    // deserted during lunch.
    expect(body.sessions).toHaveLength(15)
    expect(body.sessions.filter((s) => s.sharedFrom != null)).toHaveLength(6)
    expect(body.rooms).toHaveLength(3)

    // Outside the state stream: carrying the whole program on every SSE send
    // would cost dearly for data consulted when a tab is opened.
    const payload = await view()
    expect(payload.sessions).toHaveLength(15)
  }, 40_000)

  it("refuses a room absent from the program", async () => {
    expect((await fetch(`${control}/display/sessions?salle=inventee`)).status).toBe(404)
  }, 40_000)
})

describe('exchanging messages', () => {
  const rpcAdmin = async (path: string, entry: unknown) => {
    const response = await fetch(`${origin}/api/auth/sign-in/email`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: OPERATOR.email, password: OPERATOR.password }),
    })
    const session = (await response.json()) as { token: string }
    const call = await fetch(`${origin}/rpc/${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${session.token}` },
      body: JSON.stringify({ json: entry }),
    })
    return { status: call.status, body: (await call.json()) as { json?: never } }
  }

  it("addresses a message to the operator without touching the room screen", async () => {
    const before = (await view()).state.mode

    await rpcAdmin('messages/send', {
      roomId: TRACK_1,
      text: 'Ton speaker est arrivé',
      level: 'info',
      target: 'operator',
      ttlSeconds: null,
    })
    await sleep(600)

    const payload = await view()
    // Projecting a note meant for the operator in front of the audience cannot be undone.
    expect(payload.state.mode).toBe(before)
    expect(payload.state.message).toBeNull()
    expect(payload.state.notifications.map((n) => n.text).join(' ')).toContain('speaker est arrivé')
  }, 40_000)

  it("takes over the room screen for an urgent message to the audience", async () => {
    await rpcAdmin('messages/send', {
      roomId: TRACK_1,
      text: 'Évacuation — rejoignez la sortie la plus proche',
      level: 'urgent',
      target: 'audience',
      /**
       * No TTL here: these tests run on a clock simulated in October, while the
       * hub emits at today's date. The staleness filter — correct in itself —
       * would discard the command before it was applied. Display expiry is
       * covered by the runtime's tests.
       */
      ttlSeconds: null,
    })
    await sleep(600)

    const payload = await view()
    expect(payload.state.mode).toBe('message')
    expect(payload.state.message).toMatchObject({ level: 'urgent' })
    // The control app knows what is being projected in its own room.
    expect(payload.state.notifications.map((n) => n.text).join(' ')).toContain('Affiché en salle')
  }, 40_000)

  it('reaches every room when none is named', async () => {
    const result = await rpcAdmin('messages/send', {
      roomId: null,
      text: 'Ouverture des portes dans 5 minutes',
      level: 'info',
      target: 'operator',
      ttlSeconds: null,
    })
    expect(result.status).toBe(200)
    await sleep(600)
    expect((await view()).state.notifications.map((n) => n.text).join(' ')).toContain(
      'Ouverture des portes',
    )
  }, 40_000)

  it('reports a message from the room to the console', async () => {
    await fetch(`${control}/control/action`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'message.send', text: "Besoin d'aide en salle", level: 'urgent' }),
    })
    // Goes through the outbox: time for the batch to leave.
    await sleep(3_000)

    const received = await rpcAdmin('messages/fromRooms', { limit: 10 })
    const messages = received.body.json as unknown as { text: string; roomName: string; level: string }[]
    expect(messages[0]).toMatchObject({
      text: "Besoin d'aide en salle",
      level: 'urgent',
      roomName: 'Track #1 - Teilhard de Chardin',
    })
  }, 40_000)

  it('reserves sending to operators', async () => {
    const anonymous = await fetch(`${origin}/rpc/messages/send`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        json: { roomId: null, text: 'coucou', level: 'info', target: 'audience', ttlSeconds: null },
      }),
    })
    expect(anonymous.status).toBe(401)
  }, 40_000)
})
