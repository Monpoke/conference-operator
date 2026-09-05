import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { beforeEach, describe, expect, it } from 'vitest'
import { normalizeProgram, sessionsForRoom, type Program } from '@conference-operator/program'
import { DEFAULT_VOD_POLICY } from '@conference-operator/contract'
import { openHubDatabase, type HubDatabase } from '../src/db.js'
import { SessionStateService, SettingsService } from '../src/services/sessions.js'
import { RoomService } from '../src/services/rooms.js'

const program: Program = normalizeProgram(
  JSON.parse(
    readFileSync(
      fileURLToPath(new URL('../../../packages/program/test/fixtures/cloudnord-2026.json', import.meta.url)),
      'utf8',
    ),
  ),
)

const TRACK_1 = 'track-1-teilhard-de-chardin'
/** "HoneySwamp": 10:00 → 10:50 UTC. */
const TALK = sessionsForRoom(program, TRACK_1).find((s) => s.id === 'cmqav0qto03qe01nsitbr18cn')!
const END = TALK.endsAtMs!

let db: HubDatabase
let settings: SettingsService
let sessions: SessionStateService
let clock: number

beforeEach(() => {
  db = openHubDatabase(':memory:').orm
  const rooms = new RoomService(db)
  // Both rooms exist: a session's state references its room, and a foreign key
  // forbids writing an orphan state.
  for (const id of [TRACK_1, 'track-2-mf-1092']) {
    rooms.upsert({
      id,
      name: id,
      trackId: id,
      obs: {
        A: { url: 'ws://127.0.0.1:4455', password: null },
        B: { url: 'ws://127.0.0.1:4456', password: null },
      },
      sceneRoles: { A: {}, B: {} },
    })
  }
  settings = new SettingsService(db)
  clock = END - 30 * 60_000
  sessions = new SessionStateService(db, settings, () => clock)
})

describe('a talk\'s lifecycle', () => {
  it('starts from "upcoming" storing nothing', () => {
    // We only record what has happened.
    expect(sessions.get(TALK.id)).toBeNull()
    expect(sessions.states(TRACK_1)).toEqual([])
  })

  it('starts then ends', () => {
    const started = sessions.start(TALK.id, TRACK_1, 'regie@cloudnord.fr')
    expect(started.status).toBe('running')
    expect(started.startedAt).toBeTruthy()

    clock += 45 * 60_000
    const ended = sessions.end(TALK.id, TRACK_1, 'regie@cloudnord.fr')
    expect(ended.status).toBe('ended')
    // The real start time is kept: rewriting it would lose the talk's effective
    // duration.
    expect(ended.startedAt).toBe(started.startedAt)
    expect(ended.endedAt).toBeTruthy()
  })

  it('comes back to "upcoming" after a slip', () => {
    sessions.start(TALK.id, TRACK_1, 'regie@cloudnord.fr')
    sessions.reset(TALK.id)
    expect(sessions.get(TALK.id)).toBeNull()
  })

  it('filters the states by room', () => {
    sessions.start(TALK.id, TRACK_1, 'op')
    sessions.start('other-session', 'track-2-mf-1092', 'op')

    expect(sessions.states(TRACK_1).map((e) => e.sessionId)).toEqual([TALK.id])
    expect(sessions.states(null)).toHaveLength(2)
  })
})

/**
 * Moving the hub's clock back — what the Development menu does.
 *
 * The observed defect: the 09:50 talk started during a rehearsal at 11 am stayed
 * "running" when one went back to 08:38, and the control app showed two hours of
 * countdown on a talk nobody had started.
 */
describe('clock moved back', () => {
  it('discards a decision dated after the current instant', () => {
    sessions.start(TALK.id, TRACK_1, 'op')
    expect(sessions.get(TALK.id)?.status).toBe('running')

    clock -= 2 * 60 * 60_000
    expect(sessions.get(TALK.id)).toBeNull()
    expect(sessions.states(TRACK_1)).toEqual([])
  })

  it('discards an upcoming closing too, without bringing the start back', () => {
    sessions.start(TALK.id, TRACK_1, 'op')
    clock += 45 * 60_000
    sessions.end(TALK.id, TRACK_1, 'op')

    // Between the start and the closing: the talk is still running.
    clock -= 20 * 60_000
    expect(sessions.get(TALK.id)).toBeNull()
  })

  it('finds the day where it was left when moving forward again', () => {
    const started = sessions.start(TALK.id, TRACK_1, 'op')
    const departure = clock

    clock -= 2 * 60 * 60_000
    expect(sessions.get(TALK.id)).toBeNull()

    // We filter at read time, we do not erase: the row is still there.
    clock = departure
    expect(sessions.get(TALK.id)).toEqual(started)
  })

  it('does not automatically close what has not started yet', () => {
    sessions.start(TALK.id, TRACK_1, 'op')

    // One hour *before* the recorded start, but well after the end of the
    // previous day's slot: the schedule rule must conclude nothing.
    clock = END - 3 * 60 * 60_000
    expect(sessions.sweep(program).ended).toEqual([])
  })
})

describe('automatic closing', () => {
  it('closes nothing before the grace period', () => {
    sessions.start(TALK.id, TRACK_1, 'op')

    clock = END + 4 * 60_000
    expect(sessions.sweep(program).ended).toEqual([])
    expect(sessions.get(TALK.id)?.status).toBe('running')
  })

  it('closes once the period is past', () => {
    sessions.start(TALK.id, TRACK_1, 'op')

    clock = END + 6 * 60_000
    const { ended } = sessions.sweep(program)

    expect(ended.map((e) => e.sessionId)).toEqual([TALK.id])
    // `auto` rather than the operator: in the control room, knowing who closed
    // changes how the history is read.
    expect(sessions.get(TALK.id)).toMatchObject({ status: 'ended', decidedBy: 'auto' })
  })

  it('honours the configured period', () => {
    settings.update({ autoEndGraceMinutes: 20 })
    sessions.start(TALK.id, TRACK_1, 'op')

    clock = END + 10 * 60_000
    expect(sessions.sweep(program).ended).toEqual([])

    clock = END + 21 * 60_000
    expect(sessions.sweep(program).ended).toHaveLength(1)
  })

  it('does nothing if the rule is switched off', () => {
    settings.update({ autoEndEnabled: false })
    sessions.start(TALK.id, TRACK_1, 'op')

    clock = END + 60 * 60_000
    expect(sessions.sweep(program).ended).toEqual([])
    expect(sessions.get(TALK.id)?.status).toBe('running')
  })

  it('never declares ended a talk that was never started', () => {
    clock = END + 60 * 60_000
    expect(sessions.sweep(program).ended).toEqual([])

    // Claiming a talk took place when nobody launched it would be a lie in the
    // history, and would skew the VOD.
    expect(sessions.get(TALK.id)).toBeNull()
  })

  it('ignores a session absent from the current program', () => {
    sessions.start('session-deleted-on-reimport', TRACK_1, 'op')

    clock = END + 60 * 60_000
    expect(sessions.sweep(program).ended).toEqual([])
    expect(sessions.get('session-deleted-on-reimport')?.status).toBe('running')
  })

  it('does not re-close what already is', () => {
    sessions.start(TALK.id, TRACK_1, 'op')
    clock = END + 6 * 60_000
    sessions.sweep(program)

    expect(sessions.sweep(program).ended).toEqual([])
  })
})

describe('hub settings', () => {
  it('supplies usable defaults', () => {
    expect(settings.get()).toEqual({
      autoEndEnabled: true,
      autoEndGraceMinutes: 5,
      // No program source for as long as nobody has filled one in: the hub then
      // imports nothing on its own, and that is a legitimate state.
      programSourceUrl: null,
      // No account declared: the rooms' waiting loop skips its social page rather
      // than displaying an empty frame.
      socialLinks: [],
      // Nothing about the event is set at the start: the hub derives its name from
      // the imported program, and that is what makes the product agnostic. These
      // fields only serve to contradict the upstream export.
      eventName: null,
      eventShortName: null,
      openFeedbackProjectId: null,
      // No storage, and above all nothing that leaves on its own: the default must
      // be the one where no byte leaves a room without being asked for.
      vodBucket: null,
      vodPrefix: null,
      // `vodPolitique` is a contract field: it does not get renamed.
      vodPolitique: DEFAULT_VOD_POLICY,
    })
  })

  it('applies a partial change', () => {
    expect(settings.update({ autoEndGraceMinutes: 15 })).toEqual({
      autoEndEnabled: true,
      autoEndGraceMinutes: 15,
      programSourceUrl: null,
      socialLinks: [],
      eventName: null,
      eventShortName: null,
      openFeedbackProjectId: null,
      vodBucket: null,
      vodPrefix: null,
      vodPolitique: DEFAULT_VOD_POLICY,
    })
    expect(settings.get().autoEndGraceMinutes).toBe(15)
  })

  it('refuses an out-of-bounds value', () => {
    expect(() => settings.update({ autoEndGraceMinutes: -1 })).toThrow()
    expect(() => settings.update({ autoEndGraceMinutes: 999 })).toThrow()
  })

  it('keeps the rest of the VOD policy when only one setting changes', () => {
    settings.update({ vodPolitique: { actif: true, debitMaxOctetsS: 2_000_000 } })
    // The console's form only sends what it carries. Without this carry-over,
    // fixing the bandwidth cap during an event would also reset the part size and
    // the CPU threshold to their factory values — silently.
    const after = settings.update({ vodPolitique: { debitMaxOctetsS: 500_000 } })
    expect(after.vodPolitique.debitMaxOctetsS).toBe(500_000)
    expect(after.vodPolitique.actif).toBe(true)
  })
})

/**
 * Enriched views: what the console receives.
 *
 * The remaining time is there because it cannot be computed anywhere else: the
 * authoritative time is the hub's, and it can be simulated. Done in the browser,
 * the computation showed "+6010 min" on a talk running on time as soon as the
 * clock was moved from the Development menu.
 */
describe('enriched program views', () => {
  it('counts the remaining time on the hub\'s clock', () => {
    sessions.start(TALK.id, TRACK_1, 'op')

    const view = sessions.views(TRACK_1, program).find((e) => e.sessionId === TALK.id)!
    expect(view.title).toBe(TALK.title)
    // The test clock is 30 minutes from the end of the slot — and months away
    // from the real time of the machine running this test.
    expect(view.remainingMs).toBe(30 * 60_000)
  })

  it('goes negative on an overrun', () => {
    // It is the information that triggers a decision: it must exist before the
    // automatic closing gets involved.
    sessions.start(TALK.id, TRACK_1, 'op')
    clock = END + 7 * 60_000

    expect(sessions.views(TRACK_1, program)[0]?.remainingMs).toBe(-7 * 60_000)
  })

  it('does not invent it with no reference slot', () => {
    // A session absent from the current program: with no known end, "0 min" would
    // be a lie.
    sessions.start('session-off-program', TRACK_1, 'op')

    const view = sessions.views(TRACK_1, program).find((e) => e.sessionId === 'session-off-program')!
    expect(view.scheduledEndsAt).toBeNull()
    expect(view.remainingMs).toBeNull()
  })
})

/**
 * The hub applies the lifecycle table, like the control app.
 *
 * The UI already greyed out "End" on a talk that had not been launched; the
 * procedure itself accepted it. Nothing broke — we simply wrote `ended` on a talk
 * that had not taken place. The table now lives in `@conference-operator/room-state`, and
 * both sides read it.
 */
describe('gestures refused by the lifecycle', () => {
  it('does not end a talk nobody launched', () => {
    expect(() => sessions.end(TALK.id, TRACK_1, 'op')).toThrow(/pas été lancée/)
    // And nothing is written: the refusal leaves no half-laid trace.
    expect(sessions.get(TALK.id)).toBeNull()
  })

  it('does not launch the same talk twice', () => {
    const first = sessions.start(TALK.id, TRACK_1, 'op')
    expect(() => sessions.start(TALK.id, TRACK_1, 'op')).toThrow(/déjà lancée/)
    // The real start time stays the one of the first departure.
    expect(sessions.get(TALK.id)?.startedAt).toBe(first.startedAt)
  })

  it('does not end twice', () => {
    sessions.start(TALK.id, TRACK_1, 'op')
    sessions.end(TALK.id, TRACK_1, 'op')
    expect(() => sessions.end(TALK.id, TRACK_1, 'op')).toThrow(/déjà terminée/)
  })

  it('relaunches a talk closed by mistake, with no detour', () => {
    // The schedule rule closes a talk that was overrunning but not finished:
    // catching that up must take one gesture, not a "Back to upcoming" followed
    // by a "Start".
    sessions.start(TALK.id, TRACK_1, 'op')
    sessions.end(TALK.id, TRACK_1, 'auto')
    expect(sessions.start(TALK.id, TRACK_1, 'op').status).toBe('running')
  })

  it('leaves "Back to upcoming" open, including on a running talk', () => {
    // The escape hatch is not conditioned: it serves precisely when one has
    // picked the wrong talk.
    sessions.start(TALK.id, TRACK_1, 'op')
    sessions.reset(TALK.id)
    expect(sessions.get(TALK.id)).toBeNull()
  })

  it('lets the automatic closing do its job', () => {
    // The sweep only targets what is running: the table forbids it nothing of
    // what it already does.
    sessions.start(TALK.id, TRACK_1, 'op')
    clock = END + 10 * 60_000
    expect(sessions.sweep(program).ended.map((e) => e.sessionId)).toEqual([TALK.id])
  })
})

/**
 * The schedule rule reads the same end as the overrun does.
 *
 * It demanded `endsAt` where the room's state makes do with a derived end: a slot
 * whose export only gives the start time went into overrun without the sweep ever
 * seeing it. The room stayed red for the rest of the day — the overrun is
 * evaluated first and masks every following slot — and nothing could get it out
 * of that but an operator pressing "End".
 */
describe('automatic closing on a derived end', () => {
  /** The program, but with a slot carrying only its start time. */
  function programWithoutEnd(): Program {
    return {
      ...program,
      sessions: program.sessions.map((session) =>
        session.id === TALK.id
          ? { ...session, endsAt: null, endsAtMs: null }
          : session,
      ),
    }
  }

  it('closes a slot whose duration alone is known', () => {
    const served = programWithoutEnd()
    sessions.start(TALK.id, TRACK_1, 'op')

    // The duration serves as the end: 10:00 + 50 min, plus five minutes of grace.
    clock = END + 4 * 60_000
    expect(sessions.sweep(served).ended).toEqual([])

    clock = END + 6 * 60_000
    expect(sessions.sweep(served).ended.map((e) => e.sessionId)).toEqual([TALK.id])
  })

  it('closes a slot that only the next one closes', () => {
    const served = programWithoutEnd()
    served.sessions = served.sessions.map((session) =>
      session.id === TALK.id ? { ...session, durationMinutes: null } : session,
    )
    sessions.start(TALK.id, TRACK_1, 'op')

    // What is left is the next slot's start. It comes after this one's planned
    // end, so the closing arrives later — but it arrives.
    clock = END + 60 * 60_000
    expect(sessions.sweep(served).ended.map((e) => e.sessionId)).toEqual([TALK.id])
  })

  it('does not close what none of the three rules closes', () => {
    // A slot with no end time, no duration, and no successor: nobody knows when
    // it finishes, and closing it would amount to inventing a time.
    const last = sessionsForRoom(program, TRACK_1).at(-1)!
    const served: Program = {
      ...program,
      sessions: program.sessions
        .filter((session) => session.roomId !== TRACK_1 || session.id === last.id)
        .map((session) =>
          session.id === last.id
            ? { ...session, endsAt: null, endsAtMs: null, durationMinutes: null }
            : session,
        ),
    }
    sessions.start(last.id, TRACK_1, 'op')

    clock = last.startsAtMs + 12 * 60 * 60_000
    expect(sessions.sweep(served).ended).toEqual([])
  })

  it('decides nothing on a talk absent from the program', () => {
    // Reimport, cancellation: with no reference slot, we touch nothing.
    sessions.start('session-off-program', TRACK_1, 'op')
    clock = END + 60 * 60_000

    expect(sessions.sweep(program).ended.map((e) => e.sessionId)).not.toContain(
      'session-off-program',
    )
  })
})
