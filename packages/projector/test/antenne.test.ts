import { describe, expect, it } from 'vitest'
import { auRetour, RETOUR_AU_DEBUT_MS } from '../src/browser/antenne.js'

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
