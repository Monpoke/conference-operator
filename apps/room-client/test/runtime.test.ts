import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { commandSchema, type Command, type CommandPayloadInput } from '@cloudnord/contract'
import { normalizeProgram } from '@cloudnord/program'
import { LocalStore } from '../src/core/store.js'
import { RoomRuntime } from '../src/core/runtime.js'

const program = normalizeProgram(
  JSON.parse(
    readFileSync(
      fileURLToPath(new URL('../../../packages/program/test/fixtures/cloudnord-2026.json', import.meta.url)),
      'utf8',
    ),
  ),
)

const TRACK_1 = 'track-1-teilhard-de-chardin'
const ISSUED_AT = '2026-10-30T10:20:00.000+00:00'

let store: LocalStore
let clockMs: number

beforeEach(() => {
  store = new LocalStore(':memory:')
  clockMs = Date.parse(ISSUED_AT)
})

function makeRuntime(effects = {}) {
  const runtime = new RoomRuntime(store, effects, () => clockMs)
  runtime.setRoomId(TRACK_1)
  runtime.setProgram('hash-1', program)
  return runtime
}

let nextSeq = 0
const command = (payload: CommandPayloadInput, ttlSeconds: number | null = null): Command => {
  nextSeq += 1
  return commandSchema.parse({ seq: nextSeq, issuedAt: ISSUED_AT, ttlSeconds, payload })
}

describe('room state', () => {
  it('positions the running session and the next one from the program', () => {
    const runtime = makeRuntime()
    const state = runtime.state()
    // 10:20 UTC: "HoneySwamp" runs from 10:00 to 10:50.
    expect(state.currentSession?.title).toContain('HoneySwamp')
    expect(state.nextSession?.title).toContain('Coupable')
  })

  it('starts on the waiting loop, without depending on the network', () => {
    // This is the screen one wants to find in the room in the morning without
    // anyone having touched anything. It reduces itself to the pages that have
    // contenu : sans programme en cache, elle montre les sponsors.
    expect(new RoomRuntime(store, {}, () => clockMs).state()).toMatchObject({
      mode: 'loop',
      connectivity: 'OFFLINE',
    })
  })

  it('corrects the clock with the server offset', () => {
    const runtime = makeRuntime()
    // The control PC is 40 minutes slow: with no correction the screen would
    // still announce the previous talk (10:20 → HoneySwamp instead of 11:00).
    expect(runtime.state().currentSession?.title).toContain('HoneySwamp')
    runtime.setClockOffset(40 * 60_000)
    runtime.refreshSessions()
    expect(runtime.state().currentSession?.title).toContain('Coupable')
    // The offset is persisted: a restart does not lose it again.
    expect(store.settings().clockOffsetMs).toBe(2_400_000)
  })
})

describe('applying the commands', () => {
  it('switches to the requested OBS scene', async () => {
    const setSceneRole = vi.fn(async () => {})
    const runtime = makeRuntime({ setSceneRole })

    const outcome = await runtime.applyCommand(command({ type: 'scene.force', role: 'LIVE' }))
    expect(outcome).toEqual({ applied: true })
    expect(setSceneRole).toHaveBeenCalledWith('LIVE')
    expect(runtime.state().sceneRole).toBe('LIVE')
  })

  /**
   * What a neighbouring room does already arrives pushed on the command stream;
   * only the *view* that displays it was polled. The control app therefore
   * received the "Track #2 vient de terminer" notification while Track #2's dot
   * still said "en cours".
   */
  it("asks for the other rooms' view again as soon as one of them decides", async () => {
    const refreshRoomStatuses = vi.fn()
    const runtime = makeRuntime({ refreshRoomStatuses })
    runtime.setRoomId('track-1')

    await runtime.applyCommand(
      command({
        type: 'session.state',
        sessionId: 'ses-voisine',
        roomId: 'track-2',
        sessionTitle: 'Blind ops',
        status: 'ended',
        decidedBy: 'regie@cloudnord.fr',
      }),
    )

    expect(refreshRoomStatuses).toHaveBeenCalledTimes(1)
    // Without touching our own lifecycle: the one next door has no business there.
    expect(runtime.state().sessionStates['ses-voisine']).toBeUndefined()
  })

  it("asks for nothing again on a decision concerning itself", async () => {
    // Its own room updates through the command: there is nothing to read back,
    // and one request per local decision would be noise.
    const refreshRoomStatuses = vi.fn()
    const runtime = makeRuntime({ refreshRoomStatuses })
    runtime.setRoomId('track-1')

    await runtime.applyCommand(
      command({
        type: 'session.state',
        sessionId: 'ses-1',
        roomId: 'track-1',
        sessionTitle: 'HoneySwamp',
        status: 'running',
        decidedBy: 'regie@cloudnord.fr',
      }),
    )

    expect(refreshRoomStatuses).not.toHaveBeenCalled()
    expect(runtime.state().sessionStates['ses-1']).toBe('running')
  })

  it('displays in the room a message meant for the audience', async () => {
    const runtime = makeRuntime()
    await runtime.applyCommand(
      command(
        { type: 'message.broadcast', text: 'Évacuation', level: 'urgent', target: 'audience' },
        600,
      ),
    )
    expect(runtime.state()).toMatchObject({
      mode: 'message',
      message: { text: 'Évacuation', level: 'urgent' },
    })
    // The control app is told what is being projected in its own room.
    expect(runtime.state().notifications.at(-1)?.text).toContain('Affiché en salle')
  })

  it('keeps for the operator a message addressed to them', async () => {
    const runtime = makeRuntime()
    await runtime.applyCommand(
      command({
        type: 'message.broadcast',
        text: 'Ton speaker est arrivé',
        level: 'info',
        target: 'operator',
        from: 'organisateur@cloudnord.fr',
      }),
    )

    // Switching the screen would show it large in front of the audience.
    expect(runtime.state().mode).toBe('loop')
    expect(runtime.state().message).toBeNull()
    expect(runtime.state().notifications.at(-1)?.text).toContain('Ton speaker est arrivé')
    expect(runtime.state().notifications.at(-1)?.text).toContain('organisateur@cloudnord.fr')
  })

  it('clears a notice after thirty seconds', async () => {
    const runtime = makeRuntime()
    await runtime.applyCommand(
      command({ type: 'message.broadcast', text: 'Ton speaker est arrivé', level: 'info', target: 'operator' }),
    )
    expect(runtime.state().notifications).toHaveLength(1)

    // Vingt-neuf secondes plus tard : encore lisible.
    clockMs += 29_000
    runtime.expireNotifications()
    expect(runtime.state().notifications).toHaveLength(1)

    clockMs += 2_000
    runtime.expireNotifications()
    expect(runtime.state().notifications).toHaveLength(0)
  })

  it('does not drop a notice that has just arrived', async () => {
    // The batch filter's trap: the oldest expires, not the whole stack.
    const runtime = makeRuntime()
    await runtime.applyCommand(
      command({ type: 'message.broadcast', text: 'Premier', level: 'info', target: 'operator' }),
    )
    clockMs += 31_000
    await runtime.applyCommand(
      command({ type: 'message.broadcast', text: 'Second', level: 'info', target: 'operator' }),
    )

    runtime.expireNotifications()

    const remaining = runtime.state().notifications
    expect(remaining).toHaveLength(1)
    expect(remaining[0]?.text).toContain('Second')
  })

  it('discards a command caught up on after it expired', async () => {
    const runtime = makeRuntime()
    const lunch = command({ type: 'message.broadcast', text: 'Pause déjeuner', level: 'info' }, 600)

    // Reconnection 40 minutes later: the message has no reason to be any more.
    clockMs += 40 * 60_000
    const outcome = await runtime.applyCommand(lunch)

    expect(outcome).toEqual({ applied: false, reason: 'expired' })
    expect(runtime.state().mode).toBe('loop')
    // Marked as applied all the same, otherwise every reconnection would redeliver it.
    expect(store.hasApplied(lunch.seq)).toBe(true)
  })

  it('ignores a replay of an already applied command', async () => {
    const setSceneRole = vi.fn(async () => {})
    const runtime = makeRuntime({ setSceneRole })
    const forced = command({ type: 'scene.force', role: 'HOLD' })

    await runtime.applyCommand(forced)
    const replay = await runtime.applyCommand(forced)

    expect(replay).toEqual({ applied: false, reason: 'already-applied' })
    expect(setSceneRole).toHaveBeenCalledTimes(1)
  })

  it('triggers a resynchronisation when the program is invalidated', async () => {
    const resync = vi.fn()
    const runtime = makeRuntime({ resync })
    await runtime.applyCommand(command({ type: 'program.invalidate', contentHash: 'hash-2' }))
    expect(resync).toHaveBeenCalledWith('hash-2')
  })

  it('does not loop on a command not supported yet', async () => {
    const runtime = makeRuntime()
    const later = command({ type: 'wall.approved', commentId: 'c-1' })

    expect(await runtime.applyCommand(later)).toEqual({ applied: false, reason: 'unsupported' })
    // With no marking, the next reconnection would redeliver it forever.
    expect(store.hasApplied(later.seq)).toBe(true)
    expect(await runtime.applyCommand(later)).toEqual({ applied: false, reason: 'already-applied' })
  })

  it('withdraws the message when its TTL has elapsed', async () => {
    const runtime = makeRuntime()
    await runtime.applyCommand(
      command(
        { type: 'message.broadcast', text: 'Reprise dans 5 min', level: 'info', target: 'audience' },
        300,
      ),
    )
    expect(runtime.state().mode).toBe('message')

    clockMs += 301_000
    runtime.expireMessage()
    // Back to the default waiting screen, not to a frozen page.
    expect(runtime.state()).toMatchObject({ mode: 'loop', message: null })
  })
})

describe('state observed on OBS', () => {
  it('is authoritative over the local state', () => {
    const runtime = makeRuntime()
    const seen: string[] = []
    runtime.on('state', (state) => seen.push(String(state.sceneRole)))

    // The operator switched in OBS directly: the control app must follow.
    runtime.observeSceneRole('LIVE')
    expect(runtime.state().sceneRole).toBe('LIVE')
    expect(seen).toContain('LIVE')
  })
})

describe('drivable talk', () => {
  /** Shifts the runtime's clock to a given instant (UTC). */
  const a = (iso: string) => {
    clockMs = Date.parse(iso)
    return makeRuntime()
  }

  it('aims at the running talk when there is one', () => {
    // 10:20 UTC = 11:20 in Paris, in the middle of "HoneySwamp".
    const runtime = a('2026-10-30T10:20:00Z')
    expect(runtime.state().targetSession?.title).toContain('HoneySwamp')
    expect(runtime.state().targetIsUpcoming).toBe(false)
  })

  it('aims at the next one in a gap between slots', () => {
    /**
     * The case reported: 14:50 in Paris, that is 13:50 UTC. "Platform Engineering"
     * has just finished, "Blind ops" starts at 14:55. Nothing is running — and
     * that is exactly the moment the operator wants to start.
     */
    const runtime = a('2026-10-30T13:50:00Z')
    expect(runtime.state().currentSession).toBeNull()
    expect(runtime.state().targetSession?.title).toContain('Blind ops')
    expect(runtime.state().targetIsUpcoming).toBe(true)
  })

  it('aims at the next talk during a break', () => {
    // 14:20 UTC = 15:20 in Paris, in the middle of "Pause café".
    const runtime = a('2026-10-30T14:20:00Z')
    expect(runtime.state().currentSession?.kind).toBe('break')
    // A break is not "started": what one drives is the talk that follows.
    expect(runtime.state().targetSession?.kind).toBe('talk')
    expect(runtime.state().targetSession?.title).toContain('DevEx')
  })

  it("has no target left after the last talk", () => {
    const runtime = a('2026-10-31T12:00:00Z')
    expect(runtime.state().targetSession).toBeNull()
  })
})

/**
 * The room's clock.
 *
 * `serverTimeOffsetMs` goes out in the display payload: the served pages add it
 * to **their** `Date.now()` — all they have is the browser's clock — and the
 * uplink queue dates its events the same way. So the offset must be counted from
 * the same clock everywhere, otherwise the client's two halves live at different
 * dates with nothing to say so.
 */
describe("the room's clock", () => {
  /** With no clock injected: as in the room, where there is only one. */
  const inTheRoom = () => {
    const runtime = new RoomRuntime(store)
    runtime.setRoomId(TRACK_1)
    runtime.setProgram('hash-1', program)
    return runtime
  }

  it('gives the same time to the application core and to the pages', () => {
    const runtime = inTheRoom()

    runtime.setServerTime('2026-10-30T10:20:00.000Z')

    const vuParUnePage = Date.now() + runtime.state().serverTimeOffsetMs
    expect(Math.abs(vuParUnePage - runtime.correctedNow())).toBeLessThan(50)
    expect(new Date(runtime.correctedNow()).toISOString()).toMatch(/^2026-10-30T10:20/)
  })

  it("lets the hub's time take precedence over a locally simulated one", () => {
    /**
     * The defect reported: a room launched on a simulated clock, then connected
     * to a hub also simulated, added the two offsets together. The control app
     * looked for its talks weeks after the event was over — "aucune conférence à
     * piloter" — while the other rooms' stream, computed
     * dans la page, tombait juste.
     */
    const runtime = inTheRoom()
    runtime.setClockOffset(Date.parse('2026-10-30T16:00:00Z') - Date.now(), true)

    runtime.setServerTime('2026-10-30T10:20:00.000Z')

    expect(new Date(runtime.correctedNow()).toISOString()).toMatch(/^2026-10-30T10:20/)
    // And the running talk follows, without waiting for the next clock tick.
    expect(runtime.state().currentSession?.title).toContain('HoneySwamp')
  })

  it('recomputes the timeline as soon as the time moves', () => {
    // Waiting for the tick would leave the screen naming the wrong talk for 5 s.
    const runtime = inTheRoom()

    runtime.setServerTime('2026-10-30T07:00:00.000Z')
    const matin = runtime.state().currentSession?.title

    runtime.setServerTime('2026-10-30T10:20:00.000Z')

    expect(runtime.state().currentSession?.title).toContain('HoneySwamp')
    expect(runtime.state().currentSession?.title).not.toBe(matin)
  })
})

/**
 * The live scenes' banner.
 *
 * It is composited over the video instead of taking the screen: that is the whole
 * difference with a message broadcast to the audience, and the reason a separate
 * surface exists.
 */
describe('live banner', () => {
  it('displays a banner without interrupting anything', async () => {
    const runtime = makeRuntime()
    await runtime.applyCommand(command({ type: 'display.set', mode: 'programme' }))

    await runtime.applyCommand(
      command({ type: 'overlay.set', message: { text: 'Reprise dans 5 min', level: 'info' } }),
    )

    expect(runtime.state().liveMessage).toMatchObject({ text: 'Reprise dans 5 min', level: 'info' })
    // Neither the room screen nor the scene moves: the talk goes on underneath.
    expect(runtime.state().mode).toBe('programme')
    expect(runtime.state().message).toBeNull()
  })

  it('withdraws on the console\'s order', async () => {
    const runtime = makeRuntime()
    await runtime.applyCommand(
      command({ type: 'overlay.set', message: { text: 'Micro en panne', level: 'warning' } }),
    )

    await runtime.applyCommand(command({ type: 'overlay.set', message: null }))

    expect(runtime.state().liveMessage).toBeNull()
  })

  it('expires on its own when it has a duration', async () => {
    const runtime = makeRuntime()
    await runtime.applyCommand(
      command({ type: 'overlay.set', message: { text: 'Bientôt', level: 'info' } }, 60),
    )
    expect(runtime.state().liveMessage).not.toBeNull()

    clockMs += 61_000
    runtime.expireMessage()

    // It brings nothing back as it withdraws: it had replaced nothing.
    expect(runtime.state().liveMessage).toBeNull()
    expect(runtime.state().mode).toBe('loop')
  })
})

/**
 * Audience question, a channel distinct from the banner.
 *
 * The two shared `liveMessage` for a long time. As a result, an "on reprend dans
 * 5 minutes" sent from the hub showed in place of the question, and no surface
 * could show one without risking the other. Yet they do not go to the same place
 * — the question belongs in the VOD, the operational message does not.
 */
describe('question on air', () => {
  it('lives beside the banner, without touching it', async () => {
    const runtime = makeRuntime()
    runtime.setQuestion('Et les faux positifs ?', 'Camille', runtime.state().targetSession?.id ?? null)

    await runtime.applyCommand(
      command({ type: 'overlay.set', message: { text: 'Reprise dans 5 min', level: 'info' } }),
    )

    // The console's banner does not overwrite the question, nor the other way round.
    expect(runtime.state().question).toMatchObject({ text: 'Et les faux positifs ?', author: 'Camille' })
    expect(runtime.state().liveMessage).toMatchObject({ text: 'Reprise dans 5 min' })
  })

  it('is never set by a banner command', async () => {
    const runtime = makeRuntime()

    await runtime.applyCommand(
      command({ type: 'overlay.set', message: { text: 'Micro en panne', level: 'warning' } }),
    )

    expect(runtime.state().question).toBeNull()
  })

  it('drops when the talk changes', () => {
    // Without this it stays burned into the capture overlay while the next
    // speaker settles in — engraved in their VOD, addressed to somebody else.
    const runtime = makeRuntime()
    const talk = runtime.state().targetSession!
    runtime.setQuestion('Et les faux positifs ?', null, talk.id)

    clockMs = talk.endsAtMs! + 20 * 60_000
    runtime.refreshSessions()

    expect(runtime.state().targetSession?.id).not.toBe(talk.id)
    expect(runtime.state().question).toBeNull()
  })

  it('stays as long as the driven talk does not change', () => {
    const runtime = makeRuntime()
    const talk = runtime.state().targetSession!
    runtime.setQuestion('Et les faux positifs ?', null, talk.id)

    clockMs += 60_000
    runtime.refreshSessions()

    expect(runtime.state().question).not.toBeNull()
  })

  it('is withdrawn from the control app', () => {
    const runtime = makeRuntime()
    runtime.setQuestion('Et les faux positifs ?', null, null)

    runtime.setQuestion(null, null, null)

    expect(runtime.state().question).toBeNull()
  })
})

/**
 * The driven talk skips what will no longer take place.
 *
 * The control app allows "Commencer" — then "Terminer" — on a talk whose slot has
 * not started yet. The target then stayed stuck on it until the scheduled hour: an
 * hour during which the operator could not drive the next talk, and during which
 * the large countdown counted down to the start of a talk already closed.
 */
describe('command target and lifecycle', () => {
  /**
   * 08:10 UTC — 09:10 in Paris: the opening keynote is running, and it is a slot
   * with no speaker, therefore a break. The next talk is at 08:50 UTC.
   */
  const BEFORE = Date.parse('2026-10-30T08:10:00.000Z')

  it('aims at the next talk when nothing is playing', () => {
    clockMs = BEFORE
    const runtime = makeRuntime()

    expect(runtime.state().targetSession?.title).toBe('IA for OPS on Scaleway')
    expect(runtime.state().targetIsUpcoming).toBe(true)
  })

  it('moves to the next as soon as the one not started is ended', () => {
    clockMs = BEFORE
    const runtime = makeRuntime()
    const terminee = runtime.state().targetSession!

    runtime.setSessionStatus(terminee.id, 'ended')

    // Without waiting for the clock tick: the gesture has just been made, and now
    // is when one wants to be able to start the talk after it.
    const target = runtime.state().targetSession
    expect(target?.id).not.toBe(terminee.id)
    expect(target?.kind).toBe('talk')
    expect(target!.startsAtMs).toBeGreaterThan(terminee.startsAtMs)
  })

  it('stays on an ended talk during its own slot', () => {
    // Ending early during the slot leaves the talk driven: the gesture can be
    // repaired from the card, "Remettre à venir" within reach.
    clockMs = Date.parse('2026-10-30T10:20:00.000Z')
    const runtime = makeRuntime()
    const current = runtime.state().targetSession!

    runtime.setSessionStatus(current.id, 'ended')

    expect(runtime.state().targetSession?.id).toBe(current.id)
  })

  /**
   * The case reported from the control room: talk started at 08:59, clock moved on
   * to 09:44 then 09:45. The second the slot closed, the control app switched to
   * the next talk's countdown and "Terminer" disappeared — while the speaker was
   * still talking. The overrun is precisely the moment when that button is the only
   * one that matters.
   */
  it('stays on the running talk when its slot is overrun', () => {
    clockMs = BEFORE
    const runtime = makeRuntime()
    const lancee = runtime.state().targetSession!
    runtime.setSessionStatus(lancee.id, 'running')

    // One second after the slot's scheduled end: the talk is overrunning.
    clockMs = lancee.endsAtMs! + 1_000
    runtime.refreshSessions()

    expect(runtime.state().currentSession?.id).not.toBe(lancee.id)
    expect(runtime.state().targetSession?.id).toBe(lancee.id)
    // Neither "à venir" — it is on air — nor undrivable.
    expect(runtime.state().targetIsUpcoming).toBe(false)
    expect(runtime.currentSessionStatus()).toBe('running')
  })

  it("hands over to the next one once the overrun has ended", () => {
    clockMs = BEFORE
    const runtime = makeRuntime()
    const lancee = runtime.state().targetSession!
    runtime.setSessionStatus(lancee.id, 'running')

    clockMs = lancee.endsAtMs! + 1_000
    runtime.refreshSessions()
    runtime.setSessionStatus(lancee.id, 'ended')

    const target = runtime.state().targetSession
    expect(target?.id).not.toBe(lancee.id)
    expect(target?.kind).toBe('talk')
  })

  /**
   * A talk left open in the morning must not capture the control app for the day.
   * The current slot wins: it is what the room is actually living through.
   */
  it('prefers the current slot to a talk left open', () => {
    clockMs = BEFORE
    const runtime = makeRuntime()
    const oubliee = runtime.state().targetSession!
    runtime.setSessionStatus(oubliee.id, 'running')

    // 11:20 in Paris: "HoneySwamp" has its own slot.
    clockMs = Date.parse('2026-10-30T10:20:00.000Z')
    runtime.refreshSessions()

    expect(runtime.state().targetSession?.title).toContain('HoneySwamp')
    expect(runtime.state().targetIsUpcoming).toBe(false)
  })

  it('takes the talk back up when the decision is cancelled', () => {
    clockMs = BEFORE
    const runtime = makeRuntime()
    const terminee = runtime.state().targetSession!

    runtime.setSessionStatus(terminee.id, 'ended')
    runtime.setSessionStatus(terminee.id, 'scheduled')

    expect(runtime.state().targetSession?.id).toBe(terminee.id)
  })
})

/**
 * The gestures coming from a mobile control app.
 *
 * They take the downstream flow like everything else, so the two filters that
 * govern it: expiry first, replay second. What matters here is that they abide by
 * it — a "record" caught up on half an hour later, or applied twice on
 * reconnection, would cost a take.
 */
describe('mobile control app commands', () => {
  it('starts and stops the take, naming who asked for it', async () => {
    const captations: boolean[] = []
    const runtime = makeRuntime({ setRecording: (on: boolean) => captations.push(on) })

    await runtime.applyCommand(
      command({ type: 'recording.set', on: true, requestedBy: 'regie@cloudnord.fr' }, 90),
    )
    await runtime.applyCommand(
      command({ type: 'recording.set', on: false, requestedBy: 'regie@cloudnord.fr' }, 90),
    )

    expect(captations).toEqual([true, false])
    /*
     * Reported in the control app, and not only in the log.
     *
     * A recording that starts with nobody having touched the room's keyboard reads
     * as an OBS failure. Naming who asked for it stops people looking for the fault
     * where there is none.
     */
    const last = runtime.state().notifications.at(-1)
    expect(last?.text).toContain('regie@cloudnord.fr')
    expect(last?.text).toContain('Enregistrement arrêté')
  })

  it('toggles the stream the same way', async () => {
    const diffusions: boolean[] = []
    const runtime = makeRuntime({ setStreaming: (on: boolean) => diffusions.push(on) })

    await runtime.applyCommand(
      command({ type: 'stream.set', on: true, requestedBy: 'regie@cloudnord.fr' }, 90),
    )
    expect(diffusions).toEqual([true])
  })

  it('discards a take caught up on too late, but marks it all the same', async () => {
    const captations: boolean[] = []
    const runtime = makeRuntime({ setRecording: (on: boolean) => captations.push(on) })

    // Emitted longer ago than its validity: a room cut off for ten minutes must
    // not start recording by itself when it comes back.
    clockMs = Date.parse(ISSUED_AT) + 91_000
    const outcome = await runtime.applyCommand(
      command({ type: 'recording.set', on: true, requestedBy: 'regie@cloudnord.fr' }, 90),
    )

    expect(outcome).toEqual({ applied: false, reason: 'expired' })
    expect(captations).toEqual([])
  })

  it('does not replay an already applied command', async () => {
    const captations: boolean[] = []
    const runtime = makeRuntime({ setRecording: (on: boolean) => captations.push(on) })
    const rejouee = command({ type: 'recording.set', on: true, requestedBy: null }, 90)

    await runtime.applyCommand(rejouee)
    // A reconnection's catch-up can redeliver what is already applied.
    const seconde = await runtime.applyCommand(rejouee)

    expect(seconde).toEqual({ applied: false, reason: 'already-applied' })
    expect(captations).toEqual([true])
  })

  it('shows who is driving the room remotely, without locking anything', async () => {
    const runtime = makeRuntime()

    await runtime.applyCommand(command({ type: 'regie.hold', holder: 'regie@cloudnord.fr' }))
    expect(runtime.state().remoteHolder).toBe('regie@cloudnord.fr')

    // Released: the badge goes out. That is what the hub's sweep publishes when a
    // lock expires, failing which the screen would keep a holder who has left.
    await runtime.applyCommand(command({ type: 'regie.hold', holder: null }))
    expect(runtime.state().remoteHolder).toBeNull()
  })
})
