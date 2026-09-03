import { describe, expect, it } from 'vitest'
// @ts-expect-error — build script in plain JS, with no dedicated typings
import { compileBrowserBundle, escapeForScriptTag } from '../scripts/build-browser.mjs'
import { MACHINE_JS } from '../src/generated/browser.js'
import { ENDING_SOON_MS, LATE_MS, stateOfSlots } from '../src/state.js'

/**
 * The committed module must match the state machine's code.
 *
 * This is the guard rail that gives the package its meaning. Without it, a rule
 * changed in `src/` would leave the pages running on the previous compilation:
 * the hub would apply the new threshold, the control app the old one, and we
 * would have rebuilt at great expense exactly the divergence we had just
 * removed — worse, in fact, since nobody would be looking for it in two places
 * any more.
 *
 * Recompiling costs a few tens of milliseconds, so we compare for real rather
 * than sampling a few symbols.
 */
describe('state machine inlined into the pages', () => {
  it('matches the package code', () => {
    expect(
      escapeForScriptTag(compileBrowserBundle()) === MACHINE_JS,
      'The committed module differs from a recompilation: the state machine changed ' +
        'without being regenerated, and the pages are running on the old version.\n' +
        '    pnpm --filter @cloudnord/room-state build',
    ).toBe(true)
  })

  it('exposes what the pages call', () => {
    // Guard rail for the guard rail: an empty compilation would pass the
    // comparison above while proving nothing.
    for (const symbol of [
      'stateOfSlots',
      'talkToControl',
      'breakOfSlots',
      'effectiveEndAt',
      'appearanceOf',
      'authoritativeState',
      'isTransitionAllowed',
      'transitionRefusal',
      'timelinePosition',
    ]) {
      expect(MACHINE_JS).toContain(symbol)
    }
  })

  it('does not embed the program schemas', () => {
    /**
     * The root of `@cloudnord/program` re-exports zod: importing it from the
     * browser entry point inlined six hundred kilobytes into every page, for
     * three scheduling functions. The threshold leaves room for the state machine
     * while catching the return of the whole library.
     */
    expect(MACHINE_JS.length).toBeLessThan(60_000)
    expect(MACHINE_JS).not.toContain('ZodError')
  })

  it('cannot close the script tag of the page inlining it', () => {
    expect(MACHINE_JS).not.toMatch(/<\/script>/i)
  })

  it('answers like the source module, once executed', () => {
    /**
     * The real guard rail: we run the bundle and ask it the questions again.
     *
     * Comparing texts catches a forgotten regeneration; only execution catches a
     * browser entry point that has stopped exporting what the pages depend on, or
     * a threshold the compilation would have rewritten. It is that equality —
     * same answer in the page and in the hub — that the package promises.
     */
    const machine = new Function(`${MACHINE_JS}; return RoomState`)() as {
      ENDING_SOON_MS: number
      LATE_MS: number
      stateOfSlots: typeof stateOfSlots
      appearanceOf: (state: string) => { word: string }
      isTransitionAllowed: (from: string, action: string) => boolean
    }

    expect(machine.ENDING_SOON_MS).toBe(ENDING_SOON_MS)
    expect(machine.LATE_MS).toBe(LATE_MS)

    // A talk from 10:00 to 10:50 that nobody launched: "retard" past 10:05.
    const slots = [
      { id: 'a', kind: 'talk' as const, startsAtMs: 0, endsAtMs: 50 * 60_000, durationMinutes: 50 },
    ]
    for (const minute of [1, 6, 30, 51]) {
      const instant = minute * 60_000
      expect(machine.stateOfSlots(slots, instant), `at ${minute} min`).toBe(
        stateOfSlots(slots, instant),
      )
    }
    expect(machine.stateOfSlots(slots, 6 * 60_000, { a: 'running' })).toBe('en-cours')

    expect(machine.appearanceOf('depassement').word).toBe('dépassement')
    expect(machine.isTransitionAllowed('running', 'start')).toBe(false)
  })
})
