import { describe, expect, it } from 'vitest'
import {
  duration,
  escapeHtml,
  fileSize,
  remaining,
  shortDuration,
  stopwatch,
  time,
  timeAgo,
  timeFormatter,
} from '../src/index.js'

/**
 * These functions existed twice, and the two copies had drifted.
 *
 * The boundary table below is the point of this file: it pins the exact spot
 * where each reading changes shape, so that a future rewrite has to say out
 * loud that it is changing what an operator sees.
 */
describe('duration', () => {
  it.each([
    [0, '0 min'],
    [1, '1 min'],
    [59, '59 min'],
    [60, '1 h 00'],
    [61, '1 h 01'],
    [90, '1 h 30'],
    [1_439, '23 h 59'],
    // Past the day, minutes stop being readable — this is the branch the
    // console's copy did not have.
    [1_440, '1 j 0 h'],
    [2_880, '2 j 0 h'],
    [3_000, '2 j 2 h'],
  ])('reads %i minutes as %s', (minutes, expected) => {
    expect(duration(minutes)).toBe(expected)
  })

  it('agrees with the console copy everywhere the console could reach', () => {
    // The console rendered `floor(m/60) h pad(m%60)` with no day branch. Below
    // 24 h the two are the same function, which is what makes adopting the
    // room-control version a no-op for the console.
    for (let minutes = 60; minutes < 1_440; minutes += 7) {
      const consoleReading = `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, '0')}`
      expect(duration(minutes)).toBe(consoleReading)
    }
  })
})

describe('stopwatch', () => {
  it.each([
    [0, '0:00'],
    [1_000, '0:01'],
    [59_000, '0:59'],
    [60_000, '1:00'],
    [3_599_000, '59:59'],
    [3_600_000, '1:00:00'],
    [3_661_000, '1:01:01'],
  ])('reads %i ms as %s', (ms, expected) => {
    expect(stopwatch(ms)).toBe(expected)
  })

  it('marks an overrun with a minus sign that lines up with the digits', () => {
    expect(stopwatch(-5_000)).toBe('−0:05')
    // U+2212, not a hyphen: a hyphen sits too high and too short next to
    // tabular figures.
    expect(stopwatch(-5_000).startsWith('−')).toBe(true)
  })
})

describe('shortDuration', () => {
  it('pads minutes so rows line up under one another', () => {
    expect(shortDuration(5_000)).toBe('00:05')
    expect(shortDuration(65_000)).toBe('01:05')
    expect(shortDuration(3_665_000)).toBe('1:01:05')
  })
})

describe('remaining', () => {
  it('keeps seconds below the minute, where rounding would erase the answer', () => {
    expect(remaining(8_000)).toBe('8 s')
    expect(remaining(59_000)).toBe('59 s')
  })

  it('switches to minutes above', () => {
    expect(remaining(60_000)).toBe('1 min')
    expect(remaining(5_400_000)).toBe('1 h 30')
  })
})

describe('fileSize', () => {
  it.each([
    [0, '1 ko'],
    [400, '1 ko'],
    [1_500, '2 ko'],
    [999_000, '999 ko'],
    [1_500_000, '2 Mo'],
    [2_400_000_000, '2,4 Go'],
  ])('reads %i bytes as %s', (bytes, expected) => {
    expect(fileSize(bytes)).toBe(expected)
  })

  it('never reads a real file as empty', () => {
    // A sidecar of a few hundred bytes shown as "0 ko" reads as a missing
    // file, which is precisely what the operator is checking for.
    expect(fileSize(1)).toBe('1 ko')
  })
})

describe('time', () => {
  it('reads an instant in the event timezone, not the machine one', () => {
    expect(time('2026-10-30T09:20:00Z', 'Europe/Paris')).toBe('10:20')
    expect(time('2026-10-30T09:20:00Z', 'UTC')).toBe('09:20')
  })

  it('reuses one formatter per timezone', () => {
    expect(timeFormatter('Europe/Paris')).toBe(timeFormatter('Europe/Paris'))
    expect(timeFormatter('UTC')).not.toBe(timeFormatter('Europe/Paris'))
  })
})

describe('timeAgo', () => {
  const now = Date.parse('2026-10-30T10:00:00Z')

  it.each([
    ['2026-10-30T09:59:59Z', '1 s'],
    ['2026-10-30T09:59:00Z', '1 min'],
    ['2026-10-30T09:00:00Z', '1 h'],
  ])('reads %s as %s', (iso, expected) => {
    expect(timeAgo(iso, now)).toBe(expected)
  })

  it('says so when there is nothing to read', () => {
    expect(timeAgo(null, now)).toBe('jamais')
    expect(timeAgo('', now)).toBe('jamais')
  })

  it('does not turn a clock skew into a negative age', () => {
    // The hub's clock and the browser's are not the same one; "vu −6010436 s"
    // means nothing to anybody.
    expect(timeAgo('2026-10-30T10:05:00Z', now)).toBe("à l'instant")
  })
})

describe('escapeHtml', () => {
  it('closes every hole a concatenated page could leave', () => {
    expect(escapeHtml('<script>alert("x")</script>')).toBe(
      '&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;',
    )
    expect(escapeHtml("l'apostrophe & le reste")).toBe('l&#39;apostrophe &amp; le reste')
  })

  it('renders nothing for nothing, rather than the word undefined', () => {
    expect(escapeHtml(null)).toBe('')
    expect(escapeHtml(undefined)).toBe('')
    expect(escapeHtml(0)).toBe('0')
  })
})
