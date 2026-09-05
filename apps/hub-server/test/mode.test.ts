import { describe, expect, it } from 'vitest'
import { configSchema } from '../src/config.js'

/**
 * The production-mode guard on the hub.
 *
 * Development settings are neutralized rather than refused: a hub that does not
 * restart because one line lingers in a `.env` would be worse than the ill it
 * cures — it is precisely during an event that it gets restarted.
 */
const BASE = { authSecret: 'x'.repeat(48) }

describe('hub mode', () => {
  it('is in production when nothing is asked for', () => {
    const config = configSchema.parse(BASE)

    expect(config.mode).toBe('production')
    expect(config.ignores).toEqual([])
  })

  it('still says what it neutralized after a second parse', () => {
    /*
     * The config goes through this schema twice: `main.ts` parses the
     * environment, `createHub` parses the result again. The second pass sees a
     * config the first one has already cleaned — `simulatedTime` undefined,
     * `clockControl` gone — so it found nothing to report, and the hub started in
     * production with a `SIMULATED_TIME` in its `.env` without a word.
     *
     * Everything that says it out loud reads `config.ignores` after that second
     * parse. This is the property the promise rests on.
     */
    const once = configSchema.parse({
      ...BASE,
      simulatedTime: '2026-10-30T10:20:00.000Z',
      clockControl: 'true',
    })
    const twice = configSchema.parse(once)

    expect(twice.ignores).toEqual(once.ignores)
    expect(twice.ignores.map((ignore) => ignore.variable)).toEqual([
      'CLOCK_CONTROL',
      'SIMULATED_TIME',
    ])
    // And a third one does not duplicate what the second carried over.
    expect(configSchema.parse(twice).ignores).toEqual(once.ignores)
  })

  it('neutralizes the simulated time in production', () => {
    // A mistake that cannot be caught up afterwards: skewed timecodes and
    // automatic closings at the wrong moment.
    const config = configSchema.parse({ ...BASE, simulatedTime: '2026-10-30T10:20:00.000Z' })

    expect(config.simulatedTime).toBeUndefined()
    // And says so, with the reason: otherwise the guard would be worth nothing.
    expect(config.ignores).toEqual([
      { variable: 'SIMULATED_TIME', reason: 'réservé au mode développement (MODE=dev)' },
    ])
  })

  it('applies it in development mode', () => {
    const config = configSchema.parse({
      ...BASE,
      mode: 'dev',
      simulatedTime: '2026-10-30T10:20:00.000Z',
    })

    expect(config.simulatedTime).toBe('2026-10-30T10:20:00.000Z')
    expect(config.ignores).toEqual([])
  })

  it('reports CLOCK_CONTROL as obsolete, in both modes', () => {
    // A second switch for the clock setting left an absurd combination possible:
    // a production hub whose clock could be moved anyway. Finding it in a `.env`
    // means someone believes they have opened something.
    for (const mode of ['production', 'dev'] as const) {
      const config = configSchema.parse({ ...BASE, mode, clockControl: '1' })

      expect(config.ignores).toContainEqual({
        variable: 'CLOCK_CONTROL',
        reason: "remplacé par MODE=dev, qui ouvre le réglage de l'heure",
      })
    }
  })

  it('does not fret over a CLOCK_CONTROL left at zero', () => {
    expect(configSchema.parse({ ...BASE, clockControl: '0' }).ignores).toEqual([])
  })
})
