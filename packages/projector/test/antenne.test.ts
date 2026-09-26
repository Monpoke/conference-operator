import { describe, expect, it } from 'vitest'
import { auRetour, RETOUR_AU_DEBUT_MS, TRANSITION_BLOQUEE_MS, transitionBloquee } from '../src/browser/antenne.js'

/**
 * The loop's OBS source back in the program scene: where it picks up.
 */
describe('back on air', () => {
  it('resumes where it stopped after a short absence', () => {
    // A cut to the speaker and back: the audience finds the agenda it was reading.
    expect(auRetour(8_000, true)).toBe('reprendre')
    expect(auRetour(RETOUR_AU_DEBUT_MS - 1, true)).toBe('reprendre')
  })

  it('starts again from the welcome after a long one', () => {
    // A whole talk later, "where it stopped" means nothing to anyone in the room.
    expect(auRetour(RETOUR_AU_DEBUT_MS, true)).toBe('recommencer')
    expect(auRetour(45 * 60_000, true)).toBe('recommencer')
  })

  it('keeps a held screen as it is, however long it was away', () => {
    expect(auRetour(45 * 60_000, false)).toBe('reprendre')
  })
})

describe('a transition that never ends', () => {
  it('is left alone while it may still be running', () => {
    expect(transitionBloquee(900, 900)).toBe(false)
    // Its own safety timer comes first: the clock is the last resort.
    expect(transitionBloquee(900 + 800, 900)).toBe(false)
    expect(transitionBloquee(900 + TRANSITION_BLOQUEE_MS, 900)).toBe(false)
  })

  it('is ended by the clock once well past its length', () => {
    // A stinger waiting for frames an OBS source off the program never gets.
    expect(transitionBloquee(900 + TRANSITION_BLOQUEE_MS + 1, 900)).toBe(true)
    expect(transitionBloquee(60_000, 900)).toBe(true)
  })
})
