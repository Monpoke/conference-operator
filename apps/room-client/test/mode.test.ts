import { describe, expect, it } from 'vitest'
import { modeOffset, readMode } from '../src/core/mode.js'

/**
 * The room's run mode.
 *
 * The guard that counts: development conveniences apply **only** in `MODE=dev`.
 * An `OBS_MOCK=1` left behind in a shortcut means a whole day filmed by an OBS
 * instance that does not exist, and the failure is discovered at editing time —
 * when there is nothing left to salvage.
 */
describe('room mode', () => {
  it('is in production when nothing is asked for', () => {
    // The default must be the dangerous case, not the comfortable one.
    expect(readMode({})).toEqual({
      mode: 'production',
      obsSimulated: false,
      simulatedTime: null,
      ignores: [],
    })
  })

  it('neutralises the development settings outside dev mode', () => {
    const mode = readMode({ HEURE_SIMULEE: '2026-10-30T10:20:00Z' })

    expect(mode.obsSimulated).toBe(false)
    expect(mode.simulatedTime).toBeNull()
    // And says so, with the reason: somebody believes they have set something.
    expect(mode.ignores).toEqual([
      { variable: 'HEURE_SIMULEE', reason: 'réservé au mode développement (MODE=dev)' },
    ])
  })

  it('reports OBS_MOCK as obsolete, in both modes', () => {
    // It no longer does anything anywhere: in development, OBS is simulated by
    // default. Finding it in a shortcut means somebody is counting on it — and
    // counting on a simulated OBS on the day costs the day.
    for (const env of [{ OBS_MOCK: '1' }, { MODE: 'dev', OBS_MOCK: '1' }]) {
      expect(readMode(env).ignores).toContainEqual({
        variable: 'OBS_MOCK',
        reason: 'remplacé par MODE=dev, qui simule OBS par défaut (OBS_REEL=1 pour de vraies instances)',
      })
    }
  })

  it('is alarmed neither by an OBS_REEL nor by an OBS_MOCK at zero', () => {
    // `OBS_REEL` has no effect in production, but what it asks for is exactly
    // what happens: warning would sow doubt for nothing.
    expect(readMode({ OBS_REEL: '1' }).ignores).toEqual([])
    expect(readMode({ OBS_MOCK: '0' }).ignores).toEqual([])
  })

  it('simulates OBS by default in development', () => {
    // The common case in development; requiring one more variable for the common
    // case is paid for in forgotten shortcuts.
    expect(readMode({ MODE: 'dev' }).obsSimulated).toBe(true)
    expect(readMode({ MODE: 'dev', OBS_REEL: '1' }).obsSimulated).toBe(false)
  })

  it('accepts a simulated local time in development', () => {
    const mode = readMode({ MODE: 'dev', HEURE_SIMULEE: '2026-10-30T10:20:00Z' })

    expect(mode.simulatedTime).toBe('2026-10-30T10:20:00Z')
    expect(mode.ignores).toEqual([])
  })
})

describe("the room's simulated time", () => {
  it('shifts nothing when nothing is simulated', () => {
    expect(modeOffset(readMode({ MODE: 'dev' }))).toBe(0)
  })

  it('returns an offset, and not a replacement clock', () => {
    /**
     * The defect this shape removes: everything else in the client counts from
     * `Date.now()` — the served pages, which only have the browser's clock, and
     * the uplink queue. Replacing the clock of the application core alone made
     * them drift apart silently, and the control app went looking for its talks
     * weeks after the event was over.
     */
    const base = () => Date.parse('2026-08-21T18:00:00Z')
    const offset = modeOffset(
      readMode({ MODE: 'dev', HEURE_SIMULEE: '2026-10-30T10:20:00Z' }),
      base,
    )

    expect(new Date(base() + offset).toISOString()).toBe('2026-10-30T10:20:00.000Z')
    // And the time advances at the real pace: a frozen countdown would be
    // indistinguishable from a crashed screen.
    expect(new Date(base() + 90_000 + offset).toISOString()).toBe('2026-10-30T10:21:30.000Z')
  })

  it('refuses an unreadable time rather than starting off wrong', () => {
    expect(() => modeOffset(readMode({ MODE: 'dev', HEURE_SIMULEE: 'hier soir' }))).toThrow(
      /illisible/,
    )
  })
})
