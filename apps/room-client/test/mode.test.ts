import { describe, expect, it } from 'vitest'
import { modeOffset, readMode } from '../src/core/mode.js'

/**
 * What the machine's environment still decides.
 *
 * The room's execution mode is its hub's (see `RoomApp.mode()`): nothing here
 * can make a room « dev ». What stays local is the development bench — OBS
 * simulated, and on such a bench only, a local simulated time. The guard that
 * counts: real OBS and real time unless asked, an `OBS_MOCK=1` left behind in a
 * shortcut means a whole day filmed by an OBS instance that does not exist.
 */
describe('the machine environment', () => {
  it('drives real OBS, on real time, when nothing is asked for', () => {
    // The default must be the dangerous case, not the comfortable one.
    expect(readMode({})).toEqual({ obsSimulated: false, simulatedTime: null, ignores: [] })
  })

  it('no longer decides the mode: MODE is the hub\'s now, and said ignored', () => {
    for (const value of ['dev', 'production']) {
      expect(readMode({ MODE: value }).ignores).toContainEqual({
        variable: 'MODE',
        reason: 'le mode de la salle est hérité du hub (production tant qu\u2019il ne répond pas)',
      })
    }
    // And it simulates nothing on its own any more.
    expect(readMode({ MODE: 'dev' }).obsSimulated).toBe(false)
  })

  it('simulates OBS when the bench says so', () => {
    expect(readMode({ OBS_SIMULE: '1' }).obsSimulated).toBe(true)
    expect(readMode({ OBS_SIMULE: '0' }).obsSimulated).toBe(false)
    expect(readMode({ OBS_MOCK: '1' }).ignores).toContainEqual({ variable: 'OBS_MOCK', reason: 'remplacé par OBS_SIMULE=1' })
  })

  it('simulates OBS by default in the development script, unless OBS_REEL', () => {
    expect(readMode({}, true).obsSimulated).toBe(true)
    expect(readMode({ OBS_REEL: '1' }, true).obsSimulated).toBe(false)
  })

  it('keeps a simulated local time for a bench, and refuses it on a real room', () => {
    expect(readMode({ OBS_SIMULE: '1', HEURE_SIMULEE: '2026-10-30T10:20:00Z' })).toEqual({
      obsSimulated: true,
      simulatedTime: '2026-10-30T10:20:00Z',
      ignores: [],
    })
    const real = readMode({ HEURE_SIMULEE: '2026-10-30T10:20:00Z' })
    expect(real.simulatedTime).toBeNull()
    expect(real.ignores).toEqual([
      { variable: 'HEURE_SIMULEE', reason: 'réservé à un banc de développement (OBS_SIMULE=1)' },
    ])
  })
})

describe("the room's simulated time", () => {
  it('shifts nothing when nothing is simulated', () => {
    expect(modeOffset(readMode({ OBS_SIMULE: '1' }))).toBe(0)
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
      readMode({ OBS_SIMULE: '1', HEURE_SIMULEE: '2026-10-30T10:20:00Z' }),
      base,
    )

    expect(new Date(base() + offset).toISOString()).toBe('2026-10-30T10:20:00.000Z')
    // And the time advances at the real pace: a frozen countdown would be
    // indistinguishable from a crashed screen.
    expect(new Date(base() + 90_000 + offset).toISOString()).toBe('2026-10-30T10:21:30.000Z')
  })

  it('refuses an unreadable time rather than starting off wrong', () => {
    expect(() => modeOffset(readMode({ OBS_SIMULE: '1', HEURE_SIMULEE: 'hier soir' }))).toThrow(
      /illisible/,
    )
  })
})
