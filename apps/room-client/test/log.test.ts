import { describe, expect, it } from 'vitest'
import { OutageTracker, formatDuration } from '../src/core/interruptions.js'
import { formatLogLine } from '../src/core/console-log.js'

/** Driven clock: a one-hour outage must not take an hour. */
function clock(start = 0) {
  let now = start
  return { read: () => now, advance: (ms: number) => (now += ms) }
}

describe('outage tracking', () => {
  it('logs the first failure, not the ones that follow', () => {
    // The command stream retries every 2 s: half an hour offline used to write
    // 900 identical lines and drown out the whole rest of the log.
    const time = clock()
    const tracker = new OutageTracker('flux de commandes', time.read)

    expect(tracker.failure().message).toMatch(/interrompu, nouvelle tentative/)
    for (let i = 0; i < 20; i += 1) {
      time.advance(2_000)
      if (i < 20) expect(tracker.failure().message).toBeNull()
    }
  })

  it('recalls the outage once a minute, with its extent', () => {
    const time = clock()
    const tracker = new OutageTracker('flux de commandes', time.read)
    tracker.failure()

    time.advance(61_000)
    const reminder = tracker.failure()
    expect(reminder.message).toMatch(/toujours interrompu/)
    expect(reminder.message).toMatch(/1 min 01 s/)
    expect(reminder.attempts).toBe(2)
  })

  it('announces the recovery, with the real duration', () => {
    // That is the information that was missing: faced with a pile of "retrying",
    // nothing said whether the room had reattached.
    const time = clock()
    const tracker = new OutageTracker('flux du mur', time.read)
    tracker.failure()
    time.advance(8_000)
    tracker.failure()

    time.advance(2_000)
    const back = tracker.restored()
    expect(back?.message).toBe('flux du mur rétabli après 10 s et 2 tentatives')
  })

  it('does not present the first connection as a recovery', () => {
    const tracker = new OutageTracker('flux de commandes', clock().read)
    expect(tracker.restored()).toBeNull()
  })

  it('starts over after a recovery', () => {
    const time = clock()
    const tracker = new OutageTracker('flux de commandes', time.read)
    tracker.failure()
    time.advance(3_000)
    tracker.restored()

    // A second outage must be logged like the first, not be swallowed by the
    // silence inherited from the previous one.
    expect(tracker.failure().message).toMatch(/interrompu, nouvelle tentative/)
  })

  it('puts the durations into a readable form', () => {
    expect(formatDuration(9_400)).toBe('9 s')
    expect(formatDuration(95_000)).toBe('1 min 35 s')
    expect(formatDuration(3_900_000)).toBe('1 h 05')
  })
})

describe('log line format', () => {
  const at = (h: number, m: number, s: number) => new Date(2026, 9, 30, h, m, s)

  it('carries the local time up front', () => {
    // What was missing: faced with a pile of reconnections, knowing whether they
    // are ten seconds or an hour old changes what one should do.
    expect(formatLogLine('info', 'hub rejoint', undefined, at(9, 5, 3))).toBe(
      '09:05:03 · hub rejoint',
    )
  })

  it('tells the levels apart by an aligned marker', () => {
    expect(formatLogLine('warn', 'flux coupé', undefined, at(14, 30, 0))).toContain(' ! ')
    expect(formatLogLine('error', 'jeton refusé', undefined, at(14, 30, 0))).toContain(' ✕ ')
  })

  it('flattens the common case of a context holding a single piece of information', () => {
    // `{"message":"WebSocket closed (code 1006: )"}` added braces around the only
    // useful thing on the line.
    const line = formatLogLine(
      'warn',
      'flux de commandes interrompu',
      { message: 'WebSocket closed (code 1006: )' },
      at(14, 30, 0),
    )
    expect(line).toBe('14:30:00 ! flux de commandes interrompu — WebSocket closed (code 1006: )')
  })

  it('keeps the keys when the context carries several', () => {
    const line = formatLogLine('info', 'assets préchargés', { downloaded: 34, failed: [] }, at(8, 0, 0))
    expect(line).toBe('08:00:00 · assets préchargés downloaded=34 failed=[]')
  })
})
