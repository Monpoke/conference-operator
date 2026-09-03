import { describe, expect, it } from 'vitest'
import {
  SESSION_ACTIONS,
  SESSION_STATUSES,
  isDecisionApplicable,
  isTransitionAllowed,
  statusAfter,
  transitionRefusal,
} from '../src/lifecycle.js'

/**
 * The table is the rule, and there is only one copy of it.
 *
 * It used to exist twice without saying so: the control app greyed out "End" on
 * a talk that had not been launched, the hub's procedure accepted it. Nothing
 * broke — we simply wrote `ended` on a talk that had not happened, and the
 * history lied.
 */
describe('lifecycle transitions', () => {
  it('starts an upcoming talk, never twice', () => {
    expect(statusAfter('scheduled', 'start')).toBe('running')
    expect(isTransitionAllowed('running', 'start')).toBe(false)
  })

  it('recovers from an early close without going through "Remettre à venir"', () => {
    // The scheduling rule closes a talk that was overrunning but not finished:
    // relaunching it must take one gesture, not two.
    expect(statusAfter('ended', 'start')).toBe('running')
  })

  it('only ends what has been started', () => {
    expect(statusAfter('running', 'end')).toBe('ended')
    expect(isTransitionAllowed('scheduled', 'end')).toBe(false)
    expect(isTransitionAllowed('ended', 'end')).toBe(false)
  })

  it('leaves "Remettre à venir" open from everywhere', () => {
    // It is the escape hatch: a conditional escape hatch is not one.
    for (const status of SESSION_STATUSES) expect(statusAfter(status, 'reset')).toBe('scheduled')
  })

  it('states the situation rather than the rule broken', () => {
    expect(transitionRefusal('running', 'start')).toContain('déjà lancée')
    expect(transitionRefusal('scheduled', 'end')).toContain("n'a pas été lancée")
    expect(transitionRefusal('ended', 'end')).toContain('déjà terminée')
    expect(transitionRefusal('scheduled', 'start')).toBeNull()
  })

  it('has a verdict on every pair, and a message for every refusal', () => {
    // An action added without a row in the table would pass for allowed if we
    // just sampled a few cases.
    for (const status of SESSION_STATUSES) {
      for (const action of SESSION_ACTIONS) {
        const target = statusAfter(status, action)
        expect(isTransitionAllowed(status, action)).toBe(target != null)
        expect(transitionRefusal(status, action) == null).toBe(target != null)
      }
    }
  })
})

/**
 * The rule that makes the simulated clock usable.
 *
 * The hub applied it alone, and the test bench did without: the same day replayed
 * there gave two different answers depending on whether it had been played
 * forward or wound back.
 */
describe('decisions dated in the future', () => {
  const NOON = Date.parse('2026-10-30T11:00:00Z')

  it('discards what has not happened yet', () => {
    expect(isDecisionApplicable(NOON, NOON - 60_000)).toBe(false)
  })

  it('keeps what has just happened, to the millisecond', () => {
    expect(isDecisionApplicable(NOON, NOON)).toBe(true)
    expect(isDecisionApplicable(NOON - 1, NOON)).toBe(true)
  })

  it('keeps a decision we cannot place in time', () => {
    // A state we cannot date is a data problem, not a reason to make it
    // disappear from the history.
    expect(isDecisionApplicable(null, NOON)).toBe(true)
    expect(isDecisionApplicable(undefined, NOON)).toBe(true)
    expect(isDecisionApplicable(Number.NaN, NOON)).toBe(true)
  })
})
