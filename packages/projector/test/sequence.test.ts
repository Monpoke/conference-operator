import { describe, expect, it } from 'vitest'
import { DUREES_PAR_DEFAUT, MAX_PLANNINGS } from '@conference-operator/contract'
import { BOUCLE, DUREES } from '../src/browser/sequence.js'

describe('the loop sequence', () => {
  it('keeps the reference durations the hub knows', () => {
    // The page carries its own copy — importing it would bring zod into the page.
    expect(DUREES).toEqual(DUREES_PAR_DEFAUT)
  })

  it('gives every step of the loop a duration the hub can set', () => {
    for (const step of BOUCLE) {
      // The other rooms' schedules carry theirs with their content.
      if (step.page?.de === 'plannings') continue
      expect(step.groupe).not.toBeNull()
      expect(step.duree).toBe(DUREES[step.groupe!])
    }
  })

  it('mounts as many schedules as the hub may send', () => {
    expect(BOUCLE.filter((step) => step.page?.de === 'plannings')).toHaveLength(MAX_PLANNINGS)
  })
})
