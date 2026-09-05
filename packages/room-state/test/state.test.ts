import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { applySharedBreaks, currentSession, normalizeProgram, sessionsForRoom } from '@conference-operator/program'

import {
  roomBreak,
  roomConferenceState,
  stateOfSlots,
  talkToControl,
} from '../src/index.js'

const rawFixture: unknown = JSON.parse(
  readFileSync(
    fileURLToPath(new URL('../../program/test/fixtures/cloudnord-2026.json', import.meta.url)),
    'utf8',
  ),
)

const TRACK_1 = 'track-1-teilhard-de-chardin'
const TRACK_2 = 'track-2-mf-1092'
const HANDS_ON = 'hands-on'

const at = (iso: string): number => Date.parse(iso)


/**
 * What the consoles' status dot paints.
 *
 * An accurate colour beats a reassuring one: it is what you decide on when
 * choosing to let five minutes slide or to launch the next talk.
 */
describe('room state', () => {
  const program = normalizeProgram(rawFixture)
  const sessionsT1 = sessionsForRoom(program, TRACK_1)
  const honeySwamp = sessionsT1.find((s) => s.title.startsWith('HoneySwamp'))!

  it('tells a break from being outside any slot', () => {
    // Lunch: the room is booked, but nothing is playing in it.
    expect(roomConferenceState(program, TRACK_1, at('2026-10-30T11:30:00Z'))).toBe('pause')
    // Five-minute gap between two slots.
    expect(roomConferenceState(program, TRACK_1, at('2026-10-30T08:47:00Z'))).toBe('aucune')
    expect(roomConferenceState(program, TRACK_1, at('2026-10-30T21:00:00Z'))).toBe('aucune')
  })

  it('does not call a talk nobody launched "running"', () => {
    /**
     * The slot has started, the control app has not pressed Start. Reading that
     * as a running talk was the blind spot: the status dot went green on a room
     * where nothing was happening.
     */
    const start = at('2026-10-30T10:02:00Z')
    expect(roomConferenceState(program, TRACK_1, start)).toBe('pas-commencee')

    // The first few minutes say nothing; after that, it is a question.
    expect(roomConferenceState(program, TRACK_1, at('2026-10-30T10:07:00Z'))).toBe('retard')

    // Marked as started: the slot finally reads as a talk.
    const launched = { [honeySwamp.id]: 'running' as const }
    expect(roomConferenceState(program, TRACK_1, start, launched)).toBe('en-cours')
  })

  it('announces an approaching end five minutes ahead, on a launched talk', () => {
    // HoneySwamp ends at 10:50: the moment you do not launch a talk in the room
    // next door, on pain of crossing its whole audience.
    const launched = { [honeySwamp.id]: 'running' as const }
    expect(roomConferenceState(program, TRACK_1, at('2026-10-30T10:44:00Z'), launched)).toBe('en-cours')
    expect(roomConferenceState(program, TRACK_1, at('2026-10-30T10:46:00Z'), launched)).toBe('fin-proche')
  })

  it('flags a room freed ahead of time', () => {
    // Ended within its slot: the room is available, and the one next door can
    // take that into account. This is not an empty slot.
    const ended = { [honeySwamp.id]: 'ended' as const }
    expect(roomConferenceState(program, TRACK_1, at('2026-10-30T10:30:00Z'), ended)).toBe('terminee')
  })

  it('only sees an overrun through the lifecycle', () => {
    const afterTheEnd = at('2026-10-30T11:00:00Z')

    // The program alone has moved on to the next slot: it will never say a room
    // is overrunning. Only a talk still marked "running" says so.
    expect(roomConferenceState(program, TRACK_1, afterTheEnd)).toBe('pas-commencee')
    expect(roomConferenceState(program, TRACK_1, afterTheEnd, { [honeySwamp.id]: 'running' })).toBe('depassement')
    expect(roomConferenceState(program, TRACK_1, afterTheEnd, { [honeySwamp.id]: 'ended' })).toBe('pas-commencee')
  })

  it('ignores a state about a talk missing from the program', () => {
    // Import replaced mid-day: with no slot there is nothing to overrun, and we
    // fall back on what the program says.
    expect(roomConferenceState(program, TRACK_1, at('2026-10-30T11:30:00Z'), { 'ses-ghost': 'running' })).toBe('pause')
  })
})

/**
 * The core runs on a list of slots, not on a `Program`.
 *
 * That is what lets the control app call it: it only has its own room's slots in
 * cache, never the whole program. So the two entry points must answer exactly
 * the same thing — otherwise we would have two more state machines, instead of
 * the two we have just merged.
 */
describe('core over a slot list', () => {
  const program = normalizeProgram(rawFixture)
  const slots = sessionsForRoom(program, TRACK_1)
  const honeySwamp = slots.find((s) => s.title.startsWith('HoneySwamp'))!

  it('answers like the wrapper that starts from the program', () => {
    const instants = [
      '2026-10-30T08:47:00Z',
      '2026-10-30T10:02:00Z',
      '2026-10-30T10:07:00Z',
      '2026-10-30T10:46:00Z',
      '2026-10-30T11:00:00Z',
      '2026-10-30T11:30:00Z',
      '2026-10-30T21:00:00Z',
    ]
    for (const statuses of [{}, { [honeySwamp.id]: 'running' as const }, { [honeySwamp.id]: 'ended' as const }]) {
      for (const iso of instants) {
        expect(stateOfSlots(slots, at(iso), statuses), `${iso} / ${JSON.stringify(statuses)}`).toBe(
          roomConferenceState(program, TRACK_1, at(iso), statuses),
        )
      }
    }
  })

  it('holds on slots reduced to their schedule', () => {
    // The control app deserializes its cache: it passes objects that have
    // neither speakers nor category. Requiring a whole `Session` would force it
    // to fabricate one just to ask a scheduling question.
    const bare = slots.map((s) => ({
      id: s.id,
      kind: s.kind,
      startsAtMs: s.startsAtMs,
      endsAtMs: s.endsAtMs,
      durationMinutes: s.durationMinutes,
    }))
    expect(stateOfSlots(bare, at('2026-10-30T10:07:00Z'))).toBe('retard')
  })
})

/**
 * The BREAK badge, as the three surfaces read it.
 *
 * A separate piece of data from `roomConferenceState`: the two coexist, and that
 * is deliberate — a talk can run while lunch approaches.
 */
describe('roomBreak', () => {
  const program = applySharedBreaks(normalizeProgram(rawFixture))

  it('announces the running break, with its resumption', () => {
    const noon = at('2026-10-30T11:40:00Z')
    const roomPause = roomBreak(program, TRACK_2, noon)!

    expect(roomPause.state).toBe('en-cours')
    expect(roomPause.session.title).toBe('Déjeuner')
    // The resumption: that is what you come looking for during a break.
    expect(roomPause.endsAtMs).toBe(at('2026-10-30T12:05:00Z'))
  })

  it('announces it a quarter of an hour ahead, while the talk is still running', () => {
    // 11:05 UTC: Track #2 runs a talk until 11:15, lunch follows.
    // This is the case that matters — the one where you decide not to run straight on.
    const before = at('2026-10-30T11:05:00Z')

    expect(currentSession(program, TRACK_2, before)?.kind).toBe('talk')
    expect(roomBreak(program, TRACK_2, before)).toMatchObject({
      state: 'a-venir',
      session: { title: 'Déjeuner' },
    })
  })

  it('stays quiet beyond the quarter of an hour', () => {
    // 11:00 UTC: lunch is fifteen minutes and one second away — too early for
    // the information to be useful, and it would clutter the whole day.
    expect(roomBreak(program, TRACK_2, at('2026-10-30T10:59:00Z'))).toBeNull()
    expect(roomBreak(program, TRACK_2, at('2026-10-30T11:00:00Z'))).toMatchObject({
      state: 'a-venir',
    })
  })

  it('stays quiet when a talk follows a talk', () => {
    // 10:30 UTC on Hands on: one workshop runs, another follows. Nothing to announce.
    expect(roomBreak(program, HANDS_ON, at('2026-10-30T10:30:00Z'))).toBeNull()
  })
})

/**
 * A break inherited from another room reads as a break.
 *
 * The assertion used to live in the shared-breaks test, on the `program` side;
 * it called the state machine there, which this package has taken over. It
 * counts: lunch that the export only attaches to Track #1 nonetheless concerns
 * everyone, and the three rooms must say it the same way.
 */
describe('inherited breaks', () => {
  const served = applySharedBreaks(normalizeProgram(rawFixture))

  it('reads as "pause" in all three rooms', () => {
    const noon = at('2026-10-30T11:40:00Z')
    for (const room of [TRACK_1, TRACK_2, HANDS_ON]) {
      expect(roomConferenceState(served, room, noon)).toBe('pause')
    }
  })
})


/**
 * What "Start" and "End" reach.
 *
 * The target is decided from two sources that can contradict each other: the
 * program says which slot is open, the lifecycle says what is on air. The second
 * wins beyond the slot — that is the overrun, and that is where "End" is the
 * only useful gesture.
 */
describe('talk to control', () => {
  const program = normalizeProgram(rawFixture)
  const slots = sessionsForRoom(program, TRACK_1)
  /** No speaker, so a break in the program — and yet we launch it. */
  const keynote = slots.find((s) => s.title.startsWith('Keynote'))!
  const iaForOps = slots.find((s) => s.title.startsWith('IA for OPS'))!
  const honeySwamp = slots.find((s) => s.title.startsWith('HoneySwamp'))!

  it('aims at the current slot when it is a talk', () => {
    expect(talkToControl(slots, at('2026-10-30T10:20:00Z'))?.id).toBe(honeySwamp.id)
  })

  it('aims at the next one during a gap', () => {
    // 08:47: the 08:00 slot is closed, "IA for OPS" starts at 08:50.
    expect(talkToControl(slots, at('2026-10-30T08:47:00Z'))?.id).toBe(iaForOps.id)
  })

  it('stays on the running talk through its overrun', () => {
    const statuses = { [iaForOps.id]: 'running' as const }
    // "IA for OPS" ends at 09:40 and the croissant break opens: the speaker is
    // still talking, and "End" must stay within reach.
    expect(talkToControl(slots, at('2026-10-30T09:42:00Z'), statuses)?.id).toBe(iaForOps.id)
  })

  it('keeps it even when the overrun eats into lunch', () => {
    const statuses = { [honeySwamp.id]: 'running' as const }
    expect(talkToControl(slots, at('2026-10-30T11:30:00Z'), statuses)?.id).toBe(
      honeySwamp.id,
    )
  })

  /**
   * A break is not driven, even when launched.
   *
   * The opening keynote has no speaker: the export makes it a break, and there
   * is nothing to start or end in a hollow slot. What makes it drivable is the
   * "treat as a talk" decision taken from the console — it then arrives here with
   * `kind` set to `talk`, and the overrun rule applies to it like any other.
   */
  it('does not pick up a break, even one raised to "running"', () => {
    const statuses = { [keynote.id]: 'running' as const }
    expect(talkToControl(slots, at('2026-10-30T08:47:00Z'), statuses)?.id).toBe(iaForOps.id)
  })

  it('releases it as soon as it is closed', () => {
    const statuses = { [iaForOps.id]: 'ended' as const }
    expect(talkToControl(slots, at('2026-10-30T09:42:00Z'), statuses)?.id).toBe(
      honeySwamp.id,
    )
  })

  it('prefers the current slot over a talk left open', () => {
    const statuses = { [iaForOps.id]: 'running' as const }
    expect(talkToControl(slots, at('2026-10-30T10:20:00Z'), statuses)?.id).toBe(
      honeySwamp.id,
    )
  })
})
